import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { catalogSourcePath, ensurePreCommitHook, installCatalog, installedRoutes, installMandatoryFiles, installTemplate, removeRouteFiles } from "./catalog-installation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("catalog installation", () => {
  it("resolves loops beside built package files", async () => {
    const packageDirectory = await createDirectory({
      "dist/catalog-installation.js": "export {};\n",
      "loops/workflows/agent-check.md": "# Check\n",
    });

    expect(catalogSourcePath(join(packageDirectory, "dist", "catalog-installation.js"))).toBe(join(packageDirectory, "loops"));
  });

  it("installCatalog with empty selectedRoutes installs mandatory and infrastructure files but no worker .md files", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "name: Check\n",
      "workflows/agent-refine.md": "# Refine\n",
      "workflows/agent-implement.md": "# Implement\n",
      "workflows/agent-direct.md": "# Direct\n",
      "workflows/agent-audit.md": "# Audit\n",
      "workflows/agent-propose.md": "# Propose\n",
      "workflows/agent-apply-review.md": "# Apply Review\n",
      "workflows/agent-merge-gate.md": "# Merge Gate\n",
      "workflows/shared/defaults.md": "defaults\n",
      "workflows/work-router.yml": "name: Router\n",
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-2\" }\n",
    });
    const repositoryPath = await createDirectory({});

    const result = await installCatalog(repositoryPath, { sourcePath, selectedRoutes: [] });

    expect(result.installed).toContain("opencode.ci.json");
    expect(result.installed).toContain("scripts/compile-agent-workflows.mjs");
    expect(result.installed).toContain(".github/actions/check/action.yml");
    expect(result.installed.some((f) => f.endsWith("shared/defaults.md"))).toBe(true);
    expect(result.installed.some((f) => f.endsWith("work-router.yml"))).toBe(true);
    // No worker .md files
    expect(result.installed).not.toContain(".github/workflows/agent-refine.md");
    expect(result.installed).not.toContain(".github/workflows/agent-implement.md");
    expect(result.installed).not.toContain(".github/workflows/agent-audit.md");
  });

  it("installs package-owned loops files including mandatory opencode.ci.json and compile script", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "name: Check\n",
      "workflows/agent-check.md": "# Check\n",
      "workflows/shared/defaults.md": "defaults\n",
      "scripts/compile-agent-workflows.mjs": "console.log('compile');\n",
      "scripts/compile.mjs": "console.log('old compile');\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-2\" }\n",
      "workflows/agent-check.lock.yml": "generated\n",
      "actions/actions-lock.json": "generated\n",
    });
    const repositoryPath = await createDirectory({});

    await expect(installCatalog(repositoryPath, { sourcePath })).resolves.toEqual({
      installed: [
        ".github/actions/check/action.yml",
        ".github/workflows/agent-check.md",
        ".github/workflows/shared/defaults.md",
        "opencode.ci.json",
        "scripts/compile-agent-workflows.mjs",
        "scripts/compile.mjs",
      ],
      conflicts: [],
    });
  });

  it("copies ownership headers for base workflows and selected templates", async () => {
    const header = "# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/agent-check.md. Update with `workflows update --force`; consumer edits may be overwritten.\n";
    const templateHeader = "# Managed by @plainconceptsplatform/workflows. Source: loops/templates/agentics/agentics-checks.yml. Update with `workflows update --force`; consumer edits may be overwritten.\n";
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "# Managed by @plainconceptsplatform/workflows. Source: loops/actions/check/action.yml. Update with `workflows update --force`; consumer edits may be overwritten.\nname: Check\n",
      "workflows/agent-check.md": `---\n${header}# Check\n`,
      "scripts/compile-agent-workflows.mjs": "// Managed by @plainconceptsplatform/workflows. Source: loops/scripts/compile-agent-workflows.mjs. Update with `workflows update --force`; consumer edits may be overwritten.\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-2\" }\n",
      "templates/agentics/agentics-checks.yml": `${templateHeader}name: Agentics checks\n`,
    });
    const repositoryPath = await createDirectory({});

    await installCatalog(repositoryPath, { sourcePath });
    await installTemplate(repositoryPath, "agentics-checks", { sourcePath });

    await expect(readFile(join(repositoryPath, ".github/workflows/agent-check.md"), "utf8")).resolves.toMatch(new RegExp(`^---\\n${escapeRegularExpression(header)}`));
    await expect(readFile(join(repositoryPath, ".github/workflows/agentics-checks.yml"), "utf8")).resolves.toMatch(new RegExp(`^${escapeRegularExpression(templateHeader)}`));
  });

  it("does not report identical managed files as conflicts", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "name: Check\n",
      "workflows/agent-check.md": "# Check\n",
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-2\" }\n",
    });
    const repositoryPath = await createDirectory({ ".github/workflows/agent-check.md": "# Check\n" });

    await expect(installCatalog(repositoryPath, { sourcePath })).resolves.toMatchObject({ conflicts: [] });
  });

  it("does not manage legacy repository configuration files", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "name: Check\n",
      "workflows/agent-check.md": "# Check\n",
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-2\" }\n",
    });
    const repositoryPath = await createDirectory({
      ".github/workflows/shared/repo-config.md": "legacy consumer config\n",
    });

    await expect(installCatalog(repositoryPath, { sourcePath })).resolves.toMatchObject({
      installed: [
        ".github/actions/check/action.yml",
        ".github/workflows/agent-check.md",
        "opencode.ci.json",
        "scripts/compile-agent-workflows.mjs",
      ],
      conflicts: [],
    });
    await expect(readFile(join(repositoryPath, ".github/workflows/shared/repo-config.md"), "utf8")).resolves.toBe("legacy consumer config\n");
  });

  it("requires force for different managed files", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "package action\n",
      "workflows/agent-check.md": "package workflow\n",
      "scripts/compile-agent-workflows.mjs": "package script\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-2\" }\n",
    });
    const repositoryPath = await createDirectory({
      ".github/actions/check/action.yml": "consumer action\n",
      ".github/workflows/agent-check.md": "consumer workflow\n",
      "scripts/compile-agent-workflows.mjs": "consumer script\n",
      "opencode.ci.json": "{ \"model\": \"consumer-model\" }\n",
    });

    await expect(installCatalog(repositoryPath, { sourcePath })).resolves.toEqual({
      installed: [],
      conflicts: [
        ".github/actions/check/action.yml",
        ".github/workflows/agent-check.md",
        "opencode.ci.json",
        "scripts/compile-agent-workflows.mjs",
      ],
    });

    await expect(installCatalog(repositoryPath, { force: true, sourcePath })).resolves.toMatchObject({
      conflicts: [
        ".github/actions/check/action.yml",
        ".github/workflows/agent-check.md",
        "opencode.ci.json",
        "scripts/compile-agent-workflows.mjs",
      ],
    });
    await expect(readFile(join(repositoryPath, ".github/actions/check/action.yml"), "utf8")).resolves.toBe("package action\n");
  });

  it("installs templates only when explicitly selected", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "name: Check\n",
      "workflows/agent-check.md": "# Check\n",
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-2\" }\n",
      "templates/agentics/agentics-checks.yml": "name: Agentics checks\n",
      "templates/ci/app-ci-node-monorepo.yml": "name: Node CI\n",
      "templates/release/github-release.yml": "name: Publish GitHub release\n",
    });
    const repositoryPath = await createDirectory({});

    await installCatalog(repositoryPath, { sourcePath });
    await expect(readFile(join(repositoryPath, ".github/workflows/agentics-checks.yml"), "utf8")).rejects.toThrow();
    await expect(installTemplate(repositoryPath, "agentics-checks", { sourcePath })).resolves.toEqual({
      installed: [".github/workflows/agentics-checks.yml"],
      conflicts: [],
    });
    await expect(installTemplate(repositoryPath, "app-ci-node-monorepo", { sourcePath })).resolves.toEqual({
      installed: [".github/workflows/app-ci-node-monorepo.yml"],
      conflicts: [],
    });
    await expect(installTemplate(repositoryPath, "github-release", { sourcePath })).resolves.toEqual({
      installed: [".github/workflows/github-release.yml"],
      conflicts: [],
    });
  });

  it("installCatalog installs mandatory opencode.ci.json and compile script alongside catalog files", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "name: Check\n",
      "workflows/agent-check.md": "# Check\n",
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-2\" }\n",
    });
    const repositoryPath = await createDirectory({});

    const result = await installCatalog(repositoryPath, { sourcePath });
    expect(result.installed).toContain("opencode.ci.json");
    expect(result.installed).toContain("scripts/compile-agent-workflows.mjs");
    await expect(readFile(join(repositoryPath, "opencode.ci.json"), "utf8")).resolves.toBe("{ \"model\": \"plainconcepts/glm-5-2\" }\n");
    await expect(readFile(join(repositoryPath, "scripts/compile-agent-workflows.mjs"), "utf8")).resolves.toBe("compile\n");
  });

  it("installMandatoryFiles installs opencode.ci.json and compile script without catalog files", async () => {
    const sourcePath = await createDirectory({
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-2\" }\n",
    });
    const repositoryPath = await createDirectory({});

    const result = await installMandatoryFiles(repositoryPath, { sourcePath });
    expect(result.installed).toEqual(["opencode.ci.json", "scripts/compile-agent-workflows.mjs"]);
    await expect(readFile(join(repositoryPath, "opencode.ci.json"), "utf8")).resolves.toBe("{ \"model\": \"plainconcepts/glm-5-2\" }\n");
    await expect(readFile(join(repositoryPath, "scripts/compile-agent-workflows.mjs"), "utf8")).resolves.toBe("compile\n");
  });

  it("installMandatoryFiles reports conflicts on differing files", async () => {
    const sourcePath = await createDirectory({
      "scripts/compile-agent-workflows.mjs": "package script\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-2\" }\n",
    });
    const repositoryPath = await createDirectory({
      "opencode.ci.json": "{ \"model\": \"consumer\" }\n",
      "scripts/compile-agent-workflows.mjs": "consumer script\n",
    });

    await expect(installMandatoryFiles(repositoryPath, { sourcePath })).resolves.toEqual({
      installed: [],
      conflicts: ["opencode.ci.json", "scripts/compile-agent-workflows.mjs"],
    });
  });

  it("installMandatoryFiles overwrites with force", async () => {
    const sourcePath = await createDirectory({
      "scripts/compile-agent-workflows.mjs": "package script\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-2\" }\n",
    });
    const repositoryPath = await createDirectory({
      "opencode.ci.json": "{ \"model\": \"consumer\" }\n",
      "scripts/compile-agent-workflows.mjs": "consumer script\n",
    });

    await expect(installMandatoryFiles(repositoryPath, { force: true, sourcePath })).resolves.toMatchObject({
      installed: ["opencode.ci.json", "scripts/compile-agent-workflows.mjs"],
    });
    await expect(readFile(join(repositoryPath, "opencode.ci.json"), "utf8")).resolves.toBe("{ \"model\": \"plainconcepts/glm-5-2\" }\n");
  });

  it("installMandatoryFiles does not install catalog workflow files", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "name: Check\n",
      "workflows/agent-check.md": "# Check\n",
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-2\" }\n",
    });
    const repositoryPath = await createDirectory({});

    await installMandatoryFiles(repositoryPath, { sourcePath });
    await expect(readFile(join(repositoryPath, ".github/workflows/agent-check.md"), "utf8")).rejects.toThrow();
  });

  it("installCatalog deduplicates compile script in both scripts/ and mandatory files", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "name: Check\n",
      "workflows/agent-check.md": "# Check\n",
      "scripts/compile-agent-workflows.mjs": "same compile script\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-2\" }\n",
    });
    const repositoryPath = await createDirectory({});

    const result = await installCatalog(repositoryPath, { sourcePath });
    const compileEntries = result.installed.filter((path) => path === "scripts/compile-agent-workflows.mjs");
    expect(compileEntries).toHaveLength(1);
  });

  it("creates a Husky pre-commit hook when the consumer has none", async () => {
    const repositoryPath = await createDirectory({});

    await ensurePreCommitHook(repositoryPath);

    await expect(readFile(join(repositoryPath, ".husky", "pre-commit"), "utf8"))
      .resolves.toBe("if git diff --cached --name-only -- .github | grep -q .; then\n  node scripts/compile-agent-workflows.mjs\n  git add -- .github/workflows/*.lock.yml\n  [ ! -f .github/actions/actions-lock.json ] || git add -- .github/actions/actions-lock.json\nfi\n");
  });

  it("keeps existing pre-commit commands and appends the compiler once", async () => {
    const repositoryPath = await createDirectory({ ".husky/pre-commit": "pnpm lint\n" });

    await ensurePreCommitHook(repositoryPath);
    await ensurePreCommitHook(repositoryPath);

    await expect(readFile(join(repositoryPath, ".husky", "pre-commit"), "utf8"))
      .resolves.toBe("pnpm lint\nif git diff --cached --name-only -- .github | grep -q .; then\n  node scripts/compile-agent-workflows.mjs\n  git add -- .github/workflows/*.lock.yml\n  [ ! -f .github/actions/actions-lock.json ] || git add -- .github/actions/actions-lock.json\nfi\n");
  });

  it("upgrades an existing compiler hook to stage generated locks", async () => {
    const repositoryPath = await createDirectory({ ".husky/pre-commit": "node scripts/compile-agent-workflows.mjs\n" });

    await ensurePreCommitHook(repositoryPath);

    await expect(readFile(join(repositoryPath, ".husky", "pre-commit"), "utf8"))
       .resolves.toContain("if git diff --cached --name-only -- .github | grep -q .; then");
  });

  it("repairs a malformed compiler hook prefixed with pnpm exec", async () => {
    const repositoryPath = await createDirectory({
      ".husky/pre-commit": "pnpm exec if git diff --cached --name-only -- .github | grep -q .; then\n  node scripts/compile-agent-workflows.mjs\n  git add -- .github/workflows/*.lock.yml\n  [ ! -f .github/actions/actions-lock.json ] || git add -- .github/actions/actions-lock.json\nfi\n",
    });

    await ensurePreCommitHook(repositoryPath);

    await expect(readFile(join(repositoryPath, ".husky", "pre-commit"), "utf8"))
      .resolves.not.toContain("pnpm exec if");
  });

  it("leaves consumer files untouched when staged workflow compilation fails", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "package action\n",
      "workflows/agent-check.md": "package workflow\n",
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"package\" }\n",
    });
    const repositoryPath = await createDirectory({
      ".github/actions/check/action.yml": "consumer action\n",
      ".github/workflows/agent-check.md": "consumer workflow\n",
      "opencode.ci.json": "{ \"model\": \"consumer\" }\n",
      "scripts/compile-agent-workflows.mjs": "consumer compiler\n",
    });

    await expect(installCatalog(repositoryPath, {
      force: true,
      sourcePath,
      compile: async () => { throw new Error("compile failed"); },
    })).rejects.toThrow("compile failed");

    await expect(readFile(join(repositoryPath, ".github/workflows/agent-check.md"), "utf8"))
      .resolves.toBe("consumer workflow\n");
    await expect(readFile(join(repositoryPath, "scripts/compile-agent-workflows.mjs"), "utf8"))
      .resolves.toBe("consumer compiler\n");
    await expect(readFile(join(repositoryPath, ".husky", "pre-commit"), "utf8")).rejects.toThrow();
  });

  it("preserves consumer-specific worker environment values during a forced update", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "name: Check\n",
      "workflows/agent-check.md": "---\nenv:\n  VERIFY_COMMANDS: \"package verify\"\n  REPO_RULES: \"package rules\"\n---\nengine:\n  env:\n    OPENAI_BASE_URL: https://forge.plainconcepts.com/v1\n",
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{}\n",
    });
    const repositoryPath = await createDirectory({
      ".github/workflows/agent-check.md": "---\nenv:\n  VERIFY_COMMANDS: \"consumer verify\"\n  REPO_RULES: \"consumer rules\"\n---\nengine:\n  env:\n    OPENAI_BASE_URL: https://consumer.example/v1\n",
    });

    await installCatalog(repositoryPath, { force: true, sourcePath });

    await expect(readFile(join(repositoryPath, ".github/workflows/agent-check.md"), "utf8")).resolves.toContain(
      "  REPO_RULES: \"consumer rules\"\n---\nengine:\n  env:\n    OPENAI_BASE_URL: https://consumer.example/v1\n",
    );
  });

  it("applies staged generated locks with managed sources", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "package action\n",
      "workflows/agent-check.md": "package workflow\n",
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"package\" }\n",
    });
    const repositoryPath = await createDirectory({});

    await installCatalog(repositoryPath, {
      sourcePath,
      compile: async (stagingPath) => {
        await expect(access(join(stagingPath, ".git"), constants.F_OK)).resolves.toBeUndefined();
        await writeFile(join(stagingPath, ".github", "workflows", "agent-check.lock.yml"), "opencode run --log-level ERROR\n", "utf8");
      },
    });

    await expect(readFile(join(repositoryPath, ".github", "workflows", "agent-check.lock.yml"), "utf8"))
      .resolves.toBe("opencode run --log-level ERROR\n");
  });

  it("installs the opencode.ci.json template to the repository root", async () => {
    const sourcePath = await createDirectory({
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-2\" }\n",
    });
    const repositoryPath = await createDirectory({});

    await expect(installTemplate(repositoryPath, "opencode.ci.json", { sourcePath })).resolves.toEqual({
      installed: ["opencode.ci.json"],
      conflicts: [],
    });
    await expect(readFile(join(repositoryPath, "opencode.ci.json"), "utf8")).resolves.toBe("{ \"model\": \"plainconcepts/glm-5-2\" }\n");
  });

  it("installs the .NET and Next.js CI template as app-ci.yml", async () => {
    const sourcePath = await createDirectory({
      "templates/ci/app-ci-dotnet-next.yml": "name: App: CI\n",
    });
    const repositoryPath = await createDirectory({});

    await expect(installTemplate(repositoryPath, "app-ci-dotnet-next", { sourcePath })).resolves.toEqual({
      installed: [".github/workflows/app-ci.yml"],
      conflicts: [],
    });
    await expect(readFile(join(repositoryPath, ".github/workflows/app-ci.yml"), "utf8")).resolves.toBe("name: App: CI\n");
  });

  it("requires force to replace the opencode.ci.json template", async () => {
    const sourcePath = await createDirectory({
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-2\" }\n",
    });
    const repositoryPath = await createDirectory({
      "opencode.ci.json": "{ \"model\": \"consumer-model\" }\n",
    });

    await expect(installTemplate(repositoryPath, "opencode.ci.json", { sourcePath })).resolves.toEqual({
      installed: [],
      conflicts: ["opencode.ci.json"],
    });
    await expect(installTemplate(repositoryPath, "opencode.ci.json", { force: true, sourcePath })).resolves.toMatchObject({
      installed: ["opencode.ci.json"],
    });
    await expect(readFile(join(repositoryPath, "opencode.ci.json"), "utf8")).resolves.toBe("{ \"model\": \"plainconcepts/glm-5-2\" }\n");
  });

  it("requires force to replace a selected template", async () => {
    const sourcePath = await createDirectory({
      "templates/agentics/agentics-checks.yml": "package template\n",
    });
    const repositoryPath = await createDirectory({
      ".github/workflows/agentics-checks.yml": "consumer template\n",
    });

    await expect(installTemplate(repositoryPath, "agentics-checks", { sourcePath })).resolves.toEqual({
      installed: [],
      conflicts: [".github/workflows/agentics-checks.yml"],
    });
    await expect(installTemplate(repositoryPath, "agentics-checks", { force: true, sourcePath })).resolves.toMatchObject({
      installed: [".github/workflows/agentics-checks.yml"],
    });
  });

  it("installs issue templates to .github/ISSUE_TEMPLATE/", async () => {
    const sourcePath = await createDirectory({
      "templates/issues/bug_report.yml": "name: Bug report\n",
      "templates/issues/feature_request.yml": "name: Feature request\n",
    });
    const repositoryPath = await createDirectory({});

    await expect(installTemplate(repositoryPath, "bug-report", { sourcePath })).resolves.toEqual({
      installed: [".github/ISSUE_TEMPLATE/bug_report.yml"],
      conflicts: [],
    });
    await expect(installTemplate(repositoryPath, "feature-request", { sourcePath })).resolves.toEqual({
      installed: [".github/ISSUE_TEMPLATE/feature_request.yml"],
      conflicts: [],
    });
    await expect(readFile(join(repositoryPath, ".github/ISSUE_TEMPLATE/bug_report.yml"), "utf8")).resolves.toBe("name: Bug report\n");
    await expect(readFile(join(repositoryPath, ".github/ISSUE_TEMPLATE/feature_request.yml"), "utf8")).resolves.toBe("name: Feature request\n");
  });
});

describe("route lifecycle", () => {
  it("detects installed route workers in workflowRoutes order", async () => {
    const repositoryPath = await createDirectory({
      ".github/workflows/agent-implement.md": "# Implement\n",
      ".github/workflows/agent-refine.md": "# Refine\n",
    });

    await expect(installedRoutes(repositoryPath)).resolves.toEqual(["refine", "implement"]);
  });

  it("returns an empty list when no route workers are installed", async () => {
    const repositoryPath = await createDirectory({});

    await expect(installedRoutes(repositoryPath)).resolves.toEqual([]);
  });

  it("removes a route worker and its generated lock, leaving other workers", async () => {
    const repositoryPath = await createDirectory({
      ".github/workflows/agent-refine.md": "# Refine\n",
      ".github/workflows/agent-refine.lock.yml": "generated\n",
      ".github/workflows/agent-implement.md": "# Implement\n",
    });

    await expect(removeRouteFiles(repositoryPath, ["refine"])).resolves.toEqual([
      ".github/workflows/agent-refine.lock.yml",
      ".github/workflows/agent-refine.md",
    ]);
    await expect(readFile(join(repositoryPath, ".github/workflows/agent-refine.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(repositoryPath, ".github/workflows/agent-implement.md"), "utf8")).resolves.toBe("# Implement\n");
  });

  it("ignores routes that are not installed", async () => {
    const repositoryPath = await createDirectory({});

    await expect(removeRouteFiles(repositoryPath, ["audit"])).resolves.toEqual([]);
  });
});

async function createDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "workflows-"));
  temporaryDirectories.push(directory);
  await Promise.all(Object.entries(files).map(async ([relativePath, content]) => {
    const path = join(directory, relativePath);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }));
  return directory;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
