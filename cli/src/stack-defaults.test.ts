import { describe, expect, it } from "vitest";

import {
  generateOpencodeCi,
  generateOpencodeConfig,
  generateStackDefaults,
  injectStackEnv,
} from "./stack-defaults.js";
import type { RepositoryInspection } from "./repository-inspection.js";

function makeInspection(
  overrides: Partial<RepositoryInspection["stackHints"]> = {},
): RepositoryInspection {
  return {
    repositoryPath: "/repo",
    existingAgentWorkflows: [],
    stackHints: {
      packageJson: false,
      pnpmLockfile: false,
      solutionFiles: [],
      openSpec: false,
      ...overrides,
    },
  };
}

describe("generateStackDefaults", () => {
  it("returns .NET verify commands when .slnx is found", () => {
    const defaults = generateStackDefaults(makeInspection({
      solutionFiles: ["app.slnx"],
    }));

    expect(defaults.verifyCommands).toBe("dotnet restore && dotnet build -c Release --no-restore && dotnet test");
    expect(defaults.hasDotnet).toBe(true);
    expect(defaults.hasNodeOnly).toBe(false);
  });

  it("returns pnpm verify when pnpm-lock.yaml is found without .slnx", () => {
    const defaults = generateStackDefaults(makeInspection({
      pnpmLockfile: true,
    }));

    expect(defaults.verifyCommands).toBe("pnpm verify");
    expect(defaults.hasDotnet).toBe(false);
    expect(defaults.hasNodeOnly).toBe(true);
  });

  it("returns both .NET and Web verify commands for a full-stack repo", () => {
    const defaults = generateStackDefaults(makeInspection({
      solutionFiles: ["app.slnx"],
      pnpmLockfile: true,
    }));

    expect(defaults.verifyCommands).toContain(".NET");
    expect(defaults.verifyCommands).toContain("dotnet restore");
    expect(defaults.verifyCommands).toContain("dotnet build -c Release");
    expect(defaults.verifyCommands).toContain("dotnet test");
    expect(defaults.verifyCommands).toContain("Web");
    expect(defaults.verifyCommands).toContain("pnpm lint");
    expect(defaults.verifyCommands).toContain("pnpm test");
    expect(defaults.verifyCommands).toContain("pnpm build");
    expect(defaults.hasDotnet).toBe(true);
    expect(defaults.hasNodeOnly).toBe(false);
  });

  it("returns pnpm verify when neither .slnx nor pnpm-lock.yaml is present", () => {
    const defaults = generateStackDefaults(makeInspection());

    expect(defaults.verifyCommands).toBe("pnpm verify");
    expect(defaults.hasDotnet).toBe(false);
    expect(defaults.hasNodeOnly).toBe(false);
  });

  it("includes a repo rules base string with architecture context", () => {
    const dotnetDefaults = generateStackDefaults(makeInspection({
      solutionFiles: ["app.slnx"],
    }));

    expect(dotnetDefaults.repoRulesBase).toContain("Clean Architecture");

    const nodeDefaults = generateStackDefaults(makeInspection({
      pnpmLockfile: true,
    }));

    expect(nodeDefaults.repoRulesBase).toContain("Node.js");
  });
});

describe("injectStackEnv", () => {
  it("injects VERIFY_COMMANDS into a worker that has an env block", () => {
    const content = `---
env:
  REPO_RULES: "some rules"
description: test
---`;
    const defaults = generateStackDefaults(makeInspection({
      solutionFiles: ["app.slnx"],
    }));

    const result = injectStackEnv(content, defaults);

    expect(result).toContain('VERIFY_COMMANDS: "dotnet restore && dotnet build -c Release --no-restore && dotnet test"');
  });

  it("injects pnpm verification when no .slnx is present", () => {
    const content = `---
env:
  REPO_RULES: "some rules"
---`;
    const defaults = generateStackDefaults(makeInspection({
      pnpmLockfile: true,
    }));

    const result = injectStackEnv(content, defaults);

    expect(result).toContain('VERIFY_COMMANDS: "pnpm verify"');
  });
});

const OPENCODE_CI_MD = `---
env:
  AGENTMEMORY_VERSION: "0.9.28"
  CODEGRAPH_VERSION: "1.5.0"
description: Shared CI setup.

pre-agent-steps:
  - name: Install RTK
    run: |
      rtk --version
      rtk init -g --opencode --auto-patch
  - name: Install opencode plugin dependencies
    run: |
      set -euo pipefail
      if [ ! -f .opencode/package.json ]; then
        echo "No .opencode/package.json, nothing to install"
        exit 0
      fi
  - name: Install workspace dependencies
    run: pnpm install --frozen-lockfile
  - name: Merge the CI-only OpenCode provider into opencode.jsonc
    run: |
      jq -e . "$FRAGMENT" > /dev/null
---`;

describe("generateOpencodeCi", () => {
  it("adds NuGet cache and restores detected solution when .slnx is found", () => {
    const result = generateOpencodeCi(OPENCODE_CI_MD, makeInspection({
      solutionFiles: ["apps/api/Contoso.slnx"],
    }));

    expect(result).toContain("Cache NuGet packages");
    expect(result).toContain("Restore .NET dependencies");
    expect(result).toContain("dotnet restore apps/api/Contoso.slnx");
    expect(result).toContain("\n  - name: Restore .NET dependencies\n");
    expect(result).not.toContain("\n    - name: Restore .NET dependencies\n");
  });

  it("uses POSIX separators for .NET restore commands", () => {
    const result = generateOpencodeCi(OPENCODE_CI_MD, makeInspection({
      solutionFiles: ["apps\\api\\Contoso.slnx"],
    }));

    expect(result).toContain("dotnet restore apps/api/Contoso.slnx");
    expect(result).not.toContain("dotnet restore apps\\api\\Contoso.slnx");
  });

  it("adds the pinned OpenSpec CLI install step when openspec/ directory exists", () => {
    const result = generateOpencodeCi(OPENCODE_CI_MD, makeInspection({
      openSpec: true,
    }));

    expect(result).toContain("Install OpenSpec CLI");
    expect(result).toContain("@fission-ai/openspec@1.8.0");
  });

  it("adds both NuGet and OpenSpec steps when both are detected", () => {
    const result = generateOpencodeCi(OPENCODE_CI_MD, makeInspection({
      solutionFiles: ["app.slnx"],
      openSpec: true,
    }));

    expect(result).toContain("Cache NuGet packages");
    expect(result).toContain("Install OpenSpec CLI");
  });

  it("does not add NuGet steps when no .slnx is present", () => {
    const result = generateOpencodeCi(OPENCODE_CI_MD, makeInspection({
      pnpmLockfile: true,
    }));

    expect(result).not.toContain("Cache NuGet packages");
    expect(result).not.toContain("Restore .NET dependencies");
  });

  it("preserves the original merge step", () => {
    const result = generateOpencodeCi(OPENCODE_CI_MD, makeInspection({
      solutionFiles: ["app.slnx"],
      openSpec: true,
    }));

    expect(result).toContain("Merge the CI-only OpenCode provider");
  });
});

const OPENCODE_CI_JSON = `{
  "$schema": "https://opencode.ai/config.json",
  "model": "plainconcepts/glm-5-3",
  "plugin": [],
  "default_agent": "ci-workflow-agent",
  "agent": {
    "ci-workflow-agent": {
      "description": "Executes GitHub Agentic Workflow tasks in CI.",
      "mode": "primary",
      "prompt": "You execute the GitHub Agentic Workflow task in the user prompt."
    }
  },
  "permission": {
    "read": "allow"
  },
  "lsp": {
    "csharp": {
      "disabled": true
    },
    "fsharp": {
      "disabled": true
    },
    "razor": {
      "disabled": true
    }
  },
  "provider": {
    "plainconcepts": {
      "api": "http://172.30.0.30:10000",
      "options": {
        "apiKey": "awf-openai-proxy"
      },
      "models": {
        "glm-5-3": {
          "name": "GLM 5.3"
        },
        "glm-5-2": {
          "name": "GLM 5.2"
        }
      }
    }
  }
}
`;

describe("generateOpencodeConfig", () => {
  it("keeps LSP section when .slnx is present", () => {
    const result = generateOpencodeConfig(OPENCODE_CI_JSON, makeInspection({
      solutionFiles: ["app.slnx"],
    }));

    const parsed = JSON.parse(result);
    expect(parsed.lsp).toBeDefined();
    expect(parsed.lsp.csharp.disabled).toBe(true);
    expect(parsed.lsp.fsharp.disabled).toBe(true);
    expect(parsed.lsp.razor.disabled).toBe(true);
  });

  it("removes LSP section when no .slnx is present", () => {
    const result = generateOpencodeConfig(OPENCODE_CI_JSON, makeInspection({
      pnpmLockfile: true,
    }));

    const parsed = JSON.parse(result);
    expect(parsed.lsp).toBeUndefined();
  });

  it("adds .NET guardrails to agent prompt when .slnx is present and prompt lacks them", () => {
    const result = generateOpencodeConfig(OPENCODE_CI_JSON, makeInspection({
      solutionFiles: ["app.slnx"],
    }));

    const parsed = JSON.parse(result);
    expect(parsed.agent["ci-workflow-agent"].prompt).toContain(".NET guardrails");
    expect(parsed.agent["ci-workflow-agent"].prompt).toContain("Clean Architecture");
  });

  it("adds Node/React rules to agent prompt when no .slnx", () => {
    const result = generateOpencodeConfig(OPENCODE_CI_JSON, makeInspection({
      pnpmLockfile: true,
    }));

    const parsed = JSON.parse(result);
    expect(parsed.agent["ci-workflow-agent"].prompt).toContain("Node/React rules");
    expect(parsed.agent["ci-workflow-agent"].prompt).toContain("Feature-Sliced Design");
  });

  it("preserves both models in the provider", () => {
    const result = generateOpencodeConfig(OPENCODE_CI_JSON, makeInspection({
      solutionFiles: ["app.slnx"],
    }));

    const parsed = JSON.parse(result);
    expect(parsed.provider.plainconcepts.models["glm-5-3"]).toBeDefined();
    expect(parsed.provider.plainconcepts.models["glm-5-2"]).toBeDefined();
  });

  it("preserves the plainconcepts provider and its API URL", () => {
    const result = generateOpencodeConfig(OPENCODE_CI_JSON, makeInspection({
      solutionFiles: ["app.slnx"],
    }));

    const parsed = JSON.parse(result);
    expect(parsed.provider.plainconcepts.api).toBe("http://172.30.0.30:10000");
    expect(parsed.provider.plainconcepts.options.apiKey).toBe("awf-openai-proxy");
  });

  it("does not add .NET guardrails twice when already present", () => {
    const withGuardrails = OPENCODE_CI_JSON.replace(
      '"You execute the GitHub Agentic Workflow task in the user prompt."',
      '"You execute the GitHub Agentic Workflow task in the user prompt.\\n\\n# .NET guardrails\\nFollow Clean Architecture."',
    );
    const result = generateOpencodeConfig(withGuardrails, makeInspection({
      solutionFiles: ["app.slnx"],
    }));

    const parsed = JSON.parse(result);
    const guardrailsCount = (parsed.agent["ci-workflow-agent"].prompt.match(/\.NET guardrails/g) ?? []).length;
    expect(guardrailsCount).toBe(1);
  });
});
