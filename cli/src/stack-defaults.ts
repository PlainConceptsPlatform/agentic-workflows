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

  if (hasDotnet && hasNode) {
    verifyCommands = ".NET: dotnet restore && dotnet build -c Release && dotnet test | Web: pnpm lint && pnpm test && pnpm build";
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

export function injectStackEnv(content: string, defaults: StackDefaults): string {
  let result = content;

  if (result.includes("VERIFY_COMMANDS:")) {
    result = result.replace(
      /  VERIFY_COMMANDS: ".*"/,
      `  VERIFY_COMMANDS: "${defaults.verifyCommands}"`,
    );
  } else if (/^env:\n/m.test(result)) {
    result = result.replace(
      /^env:\n/m,
      `env:\n  VERIFY_COMMANDS: "${defaults.verifyCommands}"\n`,
    );
  }

  return result;
}

export function generateOpencodeCi(
  baseContent: string,
  inspection: RepositoryInspection,
): string {
  let result = baseContent;

  if (inspection.stackHints.solutionFiles.length > 0) {
    const solutionPath = inspection.stackHints.solutionFiles[0]!.replaceAll("\\", "/");
    const nugetSteps = `  - name: Cache NuGet packages
    uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
    with:
      path: ~/.nuget/packages
      key: nuget-\${{ runner.os }}-\${{ hashFiles('**/*.slnx', '**/Directory.Packages.props') }}
      restore-keys: nuget-\${{ runner.os }}-

  - name: Restore .NET dependencies
    run: dotnet restore ${solutionPath}
`;

    result = insertBeforeMarker(result, nugetSteps, "  - name: Install workspace dependencies");
  }

  if (inspection.stackHints.openSpec) {
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

    if (!hasDotnet && config.lsp !== undefined) {
      delete config.lsp;
    } else if (hasDotnet && config.lsp === undefined) {
      (config as Record<string, unknown>).lsp = {
        csharp: { disabled: true },
        fsharp: { disabled: true },
        razor: { disabled: true },
      };
    }

    const agent = config.agent as Record<string, unknown> | undefined;
    if (agent !== undefined) {
      const agentEntry = agent["ci-workflow-agent"] as Record<string, unknown> | undefined;
      if (agentEntry !== undefined) {
        let prompt = (agentEntry.prompt as string) ?? "";

        if (hasDotnet) {
          if (!prompt.includes(".NET guardrails")) {
            prompt += "\n\n# .NET guardrails\nFollow Clean Architecture layering: API → Application → Domain. Infrastructure implements Application ports. Application must not reference EF Core or ASP.NET. Use Central Package Management (Directory.Packages.props). Build in Release mode for CI.";
          }
        } else {
          if (!prompt.includes("Node/React rules")) {
            prompt += "\n\n# Node/React rules\nFollow Feature-Sliced Design import boundaries. Use pnpm, never npm or yarn. All user-facing text must be i18n messages. TypeScript strict mode.";
          }
        }

        (agentEntry as Record<string, unknown>).prompt = prompt;
      }
    }

    return JSON.stringify(config, null, 2) + "\n";
  } catch {
    return baseContent;
  }
}
