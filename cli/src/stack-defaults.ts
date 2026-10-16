import type { RepositoryInspection } from "./repository-inspection.js";

export interface StackDefaults {
  readonly verifyCommands: string;
  readonly repoRulesBase: string;
  readonly hasDotnet: boolean;
  readonly hasNodeOnly: boolean;
}

export function generateStackDefaults(inspection: RepositoryInspection): StackDefaults {
  const hasDotnet = inspection.stackHints.solutionFiles.length > 0;
  const hasNode = inspection.stackHints.pnpmLockfile;
  const hasNodeOnly = hasNode && !hasDotnet;

  let verifyCommands: string;
  let repoRulesBase: string;

  // A full-stack repository verifies with its own `pnpm verify`, which runs what its CI blocks on.
  // The command this replaced was prose the agent had to interpret, and the implement worker never
  // got it at all: it kept the package's dotnet-only line, so bot pull requests shipped with the
  // web build broken (Pliny-Bot #639).
  if (hasDotnet && hasNode) {
    verifyCommands = "pnpm verify";
    repoRulesBase = "Full-stack .NET + React/Next.js repository. Follow Clean Architecture layering: API → Application → Domain. Infrastructure implements Application ports. Do not reference EF Core or ASP.NET from Application. Frontend communicates exclusively via HTTP endpoints. Run both .NET and frontend verification.";
  } else if (hasDotnet) {
    verifyCommands = "dotnet restore && dotnet build -c Release --no-restore && dotnet test";
    repoRulesBase = ".NET repository using Clean Architecture. Follow layering: API → Application → Domain. Infrastructure implements Application ports. Do not reference EF Core or ASP.NET from Application.";
  } else {
    verifyCommands = "pnpm verify";
    repoRulesBase = "Node.js repository. Follow existing project conventions and import boundaries.";
  }

  return { verifyCommands, repoRulesBase, hasDotnet, hasNodeOnly };
}

// Every VERIFY_COMMANDS value the package itself has ever written. A consumer holding one of these
// never chose it, so an update may replace it with the current default for the stack.
export const shippedVerifyDefaults: ReadonlySet<string> = new Set([
  ".NET: dotnet restore && dotnet build -c Release && dotnet test | Web: pnpm lint && pnpm test && pnpm build",
  "dotnet restore && dotnet build -c Release --no-restore && dotnet test",
  "dotnet restore && dotnet build -c Release --no-restore && dotnet test -c Release --no-build",
  "pnpm verify",
]);

// Only a worker that prints a verification block declares VERIFY_COMMANDS. Adding the key to
// the others made byte-identical workers read as changed on every update, so a worker without
// the key is left without it.
export function injectStackEnv(content: string, defaults: StackDefaults): string {
  return content.replace(
    /^  VERIFY_COMMANDS: .*$/m,
    `  VERIFY_COMMANDS: "${defaults.verifyCommands}"`,
  );
}

export function generateOpencodeCi(
  baseContent: string,
  inspection: RepositoryInspection,
): string {
  let result = baseContent;

  // Idempotent on purpose: this runs on every install and update, and the shared file already
  // carries some of these steps. A step is added only when no step of that name exists.
  if (inspection.stackHints.solutionFiles.length > 0) {
    const solutionPath = inspection.stackHints.solutionFiles[0]!.replaceAll("\\", "/");
    if (!result.includes("name: Cache NuGet packages")) {
      const nugetCache = `  - name: Cache NuGet packages
    uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
    with:
      path: ~/.nuget/packages
      key: nuget-\${{ runner.os }}-\${{ hashFiles('**/*.slnx', '**/Directory.Packages.props') }}
      restore-keys: nuget-\${{ runner.os }}-

`;
      result = insertBeforeMarker(result, nugetCache, "  - name: Install workspace dependencies");
    }
    if (!result.includes("name: Restore .NET dependencies")) {
      const restore = `  - name: Restore .NET dependencies
    run: dotnet restore ${solutionPath}

`;
      result = insertBeforeMarker(result, restore, "  - name: Install workspace dependencies");
    }
  }

  if (inspection.stackHints.openSpec && !result.includes("name: Install OpenSpec CLI")) {
    const openspecStep = `  - name: Install OpenSpec CLI
    run: |
      set -euo pipefail
      npm install -g "@fission-ai/openspec@1.8.0"
      openspec --version

`;

    result = insertBeforeMarker(result, openspecStep, "  - name: Install workspace dependencies");
  }

  if (inspection.stackHints.packageJson && !result.includes("--legacy-peer-deps")) {
    result = result.replace(
      `      if ! npm install --prefix .opencode; then\n        echo "No plugin deps, skipping."\n        exit 0\n      fi`,
      `      if ! npm install --prefix .opencode; then\n        echo "::warning::Strict npm install failed on a peer conflict. Retrying with --legacy-peer-deps; check .opencode/package.json."\n        npm install --prefix .opencode --legacy-peer-deps\n      fi`,
    );
  }

  return result;
}

function insertBeforeMarker(content: string, steps: string, marker: string): string {
  if (content.includes(marker)) {
    return content.replace(marker, steps + marker);
  }
  return content + "\n" + steps;
}

export function generateOpencodeConfig(
  baseContent: string,
  inspection: RepositoryInspection,
): string {
  try {
    const config = JSON.parse(baseContent) as Record<string, unknown>;
    const hasDotnet = inspection.stackHints.solutionFiles.length > 0;

    // OpenCode 2 names the agent map `agents` and the prompt `system`. V2 does
    // not run language servers, so there is no lsp block to add or remove.
    const agents = config.agents as Record<string, unknown> | undefined;
    if (agents !== undefined) {
      const agentEntry = agents["ci-workflow-agent"] as Record<string, unknown> | undefined;
      if (agentEntry !== undefined) {
        let system = (agentEntry.system as string) ?? "";

        if (hasDotnet) {
          if (!system.includes(".NET guardrails")) {
            system += "\n\n# .NET guardrails\nFollow Clean Architecture layering: API → Application → Domain. Infrastructure implements Application ports. Application must not reference EF Core or ASP.NET. Use Central Package Management (Directory.Packages.props). Build in Release mode for CI.";
          }
        } else {
          if (!system.includes("Node/React rules")) {
            system += "\n\n# Node/React rules\nFollow Feature-Sliced Design import boundaries. Use pnpm, never npm or yarn. All user-facing text must be i18n messages. TypeScript strict mode.";
          }
        }

        agentEntry.system = system;
      }
    }

    return JSON.stringify(config, null, 2) + "\n";
  } catch {
    return baseContent;
  }
}
