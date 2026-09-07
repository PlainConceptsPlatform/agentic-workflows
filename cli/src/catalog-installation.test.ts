import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { catalogSourcePath, ensurePreCommitHook, installCatalog, installedRoutes, installTemplate, removeRouteFiles } from "./catalog-installation.js";
import { inspectRepository } from "./repository-inspection.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const header = (source: string, version?: string): string =>
  `# Managed by @plainconceptsplatform/workflows${version === undefined ? "" : `@${version}`}. Source: ${source}. Update with \`workflows update --force\`; consumer edits may be overwritten.\n`;
const worker = (env: string, version?: string, body = "1. Do the work.\n"): string =>
  `---\n${header("loops/workflows/agent-check.md", version)}env:\n${env}description: check\n---\n\n${body}`;
// No baseline release is fetched in these tests unless a test says so.
const offline = async (): Promise<undefined> => undefined;

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
      "workflows/agent-audit.md": "# Audit\n",
      "workflows/agent-apply-review.md": "# Apply Review\n",
      "workflows/agent-merge-gate.md": "# Merge Gate\n",
      "workflows/agent-release.md": "# Release\n",
      "workflows/shared/defaults.md": "defaults\n",
      "workflows/work-router.yml": "name: Router\n",
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-3\" }\n",
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
    expect(result.installed).not.toContain(".github/workflows/agent-release.md");
    expect(result.changes.every((change) => change.status === "added")).toBe(true);
  });

  it("installs package-owned loops files including mandatory opencode.ci.json and compile script", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "name: Check\n",
      "workflows/agent-check.md": "# Check\n",
      "workflows/shared/defaults.md": "defaults\n",
      "scripts/compile-agent-workflows.mjs": "console.log('compile');\n",
      "scripts/compile.mjs": "console.log('old compile');\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-3\" }\n",
      "workflows/agent-check.lock.yml": "generated\n",
      "actions/actions-lock.json": "generated\n",
    });
    const repositoryPath = await createDirectory({});

    await expect(installCatalog(repositoryPath, { sourcePath })).resolves.toMatchObject({
      installed: [
        ".github/actions/check/action.yml",
        ".github/workflows/agent-check.md",
        ".github/workflows/shared/defaults.md",
        "opencode.ci.json",
        "scripts/compile-agent-workflows.mjs",
        "scripts/compile.mjs",
      ],
      conflicts: [],
      upToDate: false,
      dryRun: false,
    });
  });

  it("stamps the package version into every ownership header it installs", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": header("loops/actions/check/action.yml") + "name: Check\n",
      "workflows/agent-check.md": worker("  REPO_RULES: \"rules\"\n"),
      "scripts/compile-agent-workflows.mjs": "// " + header("loops/scripts/compile-agent-workflows.mjs").slice(2),
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-3\" }\n",
    });
    const repositoryPath = await createDirectory({});

    const result = await installCatalog(repositoryPath, { sourcePath, packageVersion: "1.2.3" });

    expect(result.packageVersion).toBe("1.2.3");
    expect(result.installedVersions).toEqual([]);
    await expect(readFile(join(repositoryPath, ".github/workflows/agent-check.md"), "utf8"))
      .resolves.toMatch(/^---\n# Managed by @plainconceptsplatform\/workflows@1\.2\.3\. Source: loops\/workflows\/agent-check\.md\./);
    await expect(readFile(join(repositoryPath, ".github/actions/check/action.yml"), "utf8"))
      .resolves.toMatch(/^# Managed by @plainconceptsplatform\/workflows@1\.2\.3\. Source: loops\/actions\/check\/action\.yml\./);
    await expect(readFile(join(repositoryPath, "scripts/compile-agent-workflows.mjs"), "utf8"))
      .resolves.toMatch(/^\/\/ Managed by @plainconceptsplatform\/workflows@1\.2\.3\./);
  });

  it("copies template ownership headers verbatim", async () => {
    const templateHeader = header("loops/templates/agentics/agentics-checks.yml");
    const sourcePath = await createDirectory({
      "templates/agentics/agentics-checks.yml": `${templateHeader}name: Agentics checks\n`,
    });
    const repositoryPath = await createDirectory({});

    await installTemplate(repositoryPath, "agentics-checks", { sourcePath });

    await expect(readFile(join(repositoryPath, ".github/workflows/agentics-checks.yml"), "utf8")).resolves.toMatch(new RegExp(`^${escapeRegularExpression(templateHeader)}`));
  });

  it("reports a file already at this version as unchanged and writes nothing to it", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": header("loops/actions/check/action.yml") + "name: Check\n",
      "workflows/agent-check.md": worker("  REPO_RULES: \"rules\"\n"),
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{}\n",
    });
    const repositoryPath = await createDirectory({
      ".github/actions/check/action.yml": header("loops/actions/check/action.yml", "1.2.3") + "name: Check\n",
      ".github/workflows/agent-check.md": worker("  REPO_RULES: \"rules\"\n", "1.2.3"),
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "opencode.ci.json": "{}\n",
    });

    const result = await installCatalog(repositoryPath, { sourcePath, packageVersion: "1.2.3", baseline: offline });

    expect(result.upToDate).toBe(true);
    expect(result.installedVersions).toEqual(["1.2.3"]);
    expect(result.changes.map((change) => [change.target, change.status])).toEqual([
      [".github/actions/check/action.yml", "unchanged"],
      [".github/workflows/agent-check.md", "unchanged"],
      ["opencode.ci.json", "unchanged"],
      ["scripts/compile-agent-workflows.mjs", "unchanged"],
    ]);
  });

  it("does not manage legacy repository configuration files", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "name: Check\n",
      "workflows/agent-check.md": "# Check\n",
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-3\" }\n",
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

  // The update policy: a package-owned file is the package's. Whatever a consumer changed in it
  // beyond a worker's env block is replaced, without --force, and reported.
  it("overwrites changed package-owned files and reports them as updated", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": header("loops/actions/check/action.yml") + "name: Check\nruns:\n  using: composite\n  steps:\n    - run: echo package\n      shell: bash\n",
      "workflows/agent-check.md": worker("  REPO_RULES: \"package rules\"\n", undefined, "1. Package body.\n"),
      "scripts/compile-agent-workflows.mjs": "// " + header("loops/scripts/compile-agent-workflows.mjs").slice(2) + "package script\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"package\" }\n",
    });
    const repositoryPath = await createDirectory({
      ".github/actions/check/action.yml": header("loops/actions/check/action.yml", "0.6.1") + "name: Check\nruns:\n  using: composite\n  steps:\n    - run: echo consumer\n      shell: bash\n",
      ".github/workflows/agent-check.md": worker("  REPO_RULES: \"my rules\"\n", "0.6.1", "1. Consumer body.\n"),
      "scripts/compile-agent-workflows.mjs": "// " + header("loops/scripts/compile-agent-workflows.mjs", "0.6.1").slice(2) + "consumer script\n",
      "opencode.ci.json": "{ \"model\": \"consumer\" }\n",
    });

    const result = await installCatalog(repositoryPath, { sourcePath, packageVersion: "0.7.0", baseline: offline });

    expect(result.conflicts).toEqual([]);
    expect(result.installedVersions).toEqual(["0.6.1"]);
    expect(result.changes).toEqual([
      { target: ".github/actions/check/action.yml", status: "updated", installedVersion: "0.6.1" },
      { target: ".github/workflows/agent-check.md", status: "updated", installedVersion: "0.6.1", keptEnv: ["REPO_RULES"] },
      { target: "opencode.ci.json", status: "updated" },
      { target: "scripts/compile-agent-workflows.mjs", status: "updated", installedVersion: "0.6.1" },
    ]);
    await expect(readFile(join(repositoryPath, ".github/actions/check/action.yml"), "utf8")).resolves.toContain("echo package");
    const written = await readFile(join(repositoryPath, ".github/workflows/agent-check.md"), "utf8");
    expect(written).toContain("workflows@0.7.0.");
    expect(written).toContain("  REPO_RULES: \"my rules\"\n");
    expect(written).toContain("1. Package body.\n");
    expect(written).not.toContain("Consumer body");
    await expect(readFile(join(repositoryPath, "opencode.ci.json"), "utf8")).resolves.toBe("{ \"model\": \"package\" }\n");
  });

  // Removing the ownership header is how a consumer takes a file over; the docs have said so
  // since the first release. --force reclaims it.
  it("leaves a file whose ownership header was removed alone unless forced", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": header("loops/actions/check/action.yml") + "name: Check\n",
      "workflows/agent-check.md": worker("  REPO_RULES: \"package rules\"\n"),
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{}\n",
    });
    const repositoryPath = await createDirectory({
      ".github/actions/check/action.yml": "name: Mine\n",
      ".github/workflows/agent-check.md": "---\nenv:\n  REPO_RULES: \"my rules\"\ndescription: forked\n---\n\n1. My own body.\n",
    });

    const first = await installCatalog(repositoryPath, { sourcePath, packageVersion: "0.7.0" });
    expect(first.changes.filter((change) => change.status === "skipped").map((change) => change.target))
      .toEqual([".github/actions/check/action.yml", ".github/workflows/agent-check.md"]);
    expect(first.changes.find((change) => change.status === "skipped")?.reason).toContain("consumer-owned");
    await expect(readFile(join(repositoryPath, ".github/actions/check/action.yml"), "utf8")).resolves.toBe("name: Mine\n");
    await expect(readFile(join(repositoryPath, ".github/workflows/agent-check.md"), "utf8")).resolves.toContain("My own body");

    const forced = await installCatalog(repositoryPath, { sourcePath, packageVersion: "0.7.0", force: true });
    expect(forced.changes.find((change) => change.target === ".github/workflows/agent-check.md")).toMatchObject({ status: "updated", keptEnv: ["REPO_RULES"] });
    const written = await readFile(join(repositoryPath, ".github/workflows/agent-check.md"), "utf8");
    expect(written).toContain("workflows@0.7.0.");
    expect(written).toContain("  REPO_RULES: \"my rules\"\n");
    expect(written).toContain("1. Do the work.\n");
  });

  it("adds new package env keys with their defaults and keeps keys only the consumer defines", async () => {
    const sourcePath = await createDirectory({
      "workflows/agent-check.md": worker("  REPO_RULES: \"package rules\"\n  # arrived in this version\n  NEW_KEY: \"default\"\n"),
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{}\n",
    });
    const repositoryPath = await createDirectory({
      ".github/workflows/agent-check.md": worker("  REPO_RULES: \"my rules\"\n  MY_KEY: \"x\"\n", "0.6.1"),
    });

    const result = await installCatalog(repositoryPath, { sourcePath, packageVersion: "0.7.0", baseline: offline });

    expect(result.changes.find((change) => change.target === ".github/workflows/agent-check.md")).toMatchObject({
      status: "updated",
      keptEnv: ["REPO_RULES"],
      consumerOnlyEnv: ["MY_KEY"],
    });
    await expect(readFile(join(repositoryPath, ".github/workflows/agent-check.md"), "utf8")).resolves.toContain(
      "env:\n  REPO_RULES: \"my rules\"\n  # arrived in this version\n  NEW_KEY: \"default\"\n  MY_KEY: \"x\"\ndescription: check\n",
    );
  });

  it("uses the installed release as the merge baseline so untouched defaults follow the package", async () => {
    const baselinePath = await createDirectory({
      "workflows/agent-check.md": worker("  REPO_RULES: \"package rules\"\n  INCOMPLETE_COMMENT: \"old wording\"\n"),
    });
    const sourcePath = await createDirectory({
      "workflows/agent-check.md": worker("  REPO_RULES: \"package rules\"\n  INCOMPLETE_COMMENT: \"new wording\"\n"),
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{}\n",
    });
    const repositoryPath = await createDirectory({
      ".github/workflows/agent-check.md": worker("  REPO_RULES: \"my rules\"\n  INCOMPLETE_COMMENT: \"old wording\"\n", "0.6.1"),
    });
    const requested: string[] = [];

    const result = await installCatalog(repositoryPath, {
      sourcePath,
      packageVersion: "0.7.0",
      baseline: async (version) => { requested.push(version); return version === "0.6.1" ? baselinePath : undefined; },
    });

    expect(requested).toEqual(["0.6.1"]);
    expect(result.baselines).toEqual([{ version: "0.6.1", status: "used" }]);
    expect(result.changes.find((change) => change.target === ".github/workflows/agent-check.md")).toMatchObject({
      status: "updated",
      installedVersion: "0.6.1",
      keptEnv: ["REPO_RULES"],
      updatedDefaults: ["INCOMPLETE_COMMENT"],
    });
    const written = await readFile(join(repositoryPath, ".github/workflows/agent-check.md"), "utf8");
    expect(written).toContain("  REPO_RULES: \"my rules\"\n");
    expect(written).toContain("  INCOMPLETE_COMMENT: \"new wording\"\n");
  });

  it("falls back to keeping every consumer value when the baseline release cannot be fetched", async () => {
    const sourcePath = await createDirectory({
      "workflows/agent-check.md": worker("  INCOMPLETE_COMMENT: \"new wording\"\n"),
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{}\n",
    });
    const repositoryPath = await createDirectory({
      ".github/workflows/agent-check.md": worker("  INCOMPLETE_COMMENT: \"old wording\"\n", "0.6.1"),
    });

    const result = await installCatalog(repositoryPath, { sourcePath, packageVersion: "0.7.0", baseline: offline });

    expect(result.baselines).toEqual([{ version: "0.6.1", status: "unavailable" }]);
    await expect(readFile(join(repositoryPath, ".github/workflows/agent-check.md"), "utf8")).resolves.toContain("  INCOMPLETE_COMMENT: \"old wording\"\n");
  });

  // The router is package-owned like everything else, but its own env: block carries the two
  // values GitHub will not let a job read where they are also needed.
  it("keeps the router's env values and mirrors them into the trigger and the audit cron", async () => {
    const routerFile = (ci: string, cron: string, job: string) =>
      `# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/work-router.yml. Update with \`workflows update --force\`; consumer edits may be overwritten.\nname: "All Work Router"\n\nenv:\n  CI_WORKFLOW_NAME: "${ci}"\n  AUDIT_CRON: "${cron}"\n\non:\n  workflow_run:\n    workflows: ["${ci}"]\n    types: [completed]\n\n  schedule:\n    - cron: "${cron}" # audit slot, mirrored from env.AUDIT_CRON by the installer\n\njobs:\n  classify:\n    runs-on: ${job}\n`;
    const sourcePath = await createDirectory({
      "workflows/work-router.yml": routerFile("App: CI", "17 1 * * 1", "ubuntu-latest"),
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{}\n",
    });
    const repositoryPath = await createDirectory({
      ".github/workflows/work-router.yml": routerFile("Build", "17 1 * * 5", "hand-edited"),
    });

    const result = await installCatalog(repositoryPath, { sourcePath, packageVersion: "0.7.0", baseline: offline });

    expect(result.changes.find((change) => change.target === ".github/workflows/work-router.yml"))
      .toMatchObject({ status: "updated", keptEnv: ["CI_WORKFLOW_NAME", "AUDIT_CRON"] });
    const written = await readFile(join(repositoryPath, ".github/workflows/work-router.yml"), "utf8");
    expect(written).toContain('  CI_WORKFLOW_NAME: "Build"\n');
    expect(written).toContain('    workflows: ["Build"]\n');
    expect(written).toContain('    - cron: "17 1 * * 5" # audit slot');
    // Everything outside env: comes back from the package.
    expect(written).toContain("    runs-on: ubuntu-latest\n");
    expect(written).not.toContain("hand-edited");
  });

  it("dry-run computes the plan and writes nothing", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": header("loops/actions/check/action.yml") + "name: Check\n",
      "workflows/agent-check.md": worker("  REPO_RULES: \"package rules\"\n"),
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{}\n",
    });
    const repositoryPath = await createDirectory({
      ".github/workflows/agent-check.md": worker("  REPO_RULES: \"my rules\"\n", "0.6.1"),
    });

    const result = await installCatalog(repositoryPath, {
      sourcePath,
      dryRun: true,
      packageVersion: "0.7.0",
      baseline: offline,
      compile: async () => { throw new Error("must not compile in a dry run"); },
    });

    expect(result.dryRun).toBe(true);
    expect(result.upToDate).toBe(false);
    expect(result.changes.map((change) => [change.target, change.status])).toEqual([
      [".github/actions/check/action.yml", "added"],
      [".github/workflows/agent-check.md", "updated"],
      ["opencode.ci.json", "added"],
      ["scripts/compile-agent-workflows.mjs", "added"],
    ]);
    await expect(access(join(repositoryPath, ".github/actions/check/action.yml"), constants.F_OK)).rejects.toThrow();
    await expect(readFile(join(repositoryPath, ".github/workflows/agent-check.md"), "utf8")).resolves.toContain("workflows@0.6.1.");
    await expect(access(join(repositoryPath, ".husky", "pre-commit"), constants.F_OK)).rejects.toThrow();
  });

  it("keeps a CRLF checkout's line endings when it rewrites a file", async () => {
    const sourcePath = await createDirectory({
      "workflows/agent-check.md": worker("  REPO_RULES: \"package rules\"\n"),
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{}\n",
    });
    const repositoryPath = await createDirectory({
      ".github/workflows/agent-check.md": worker("  REPO_RULES: \"my rules\"\n", "0.6.1").replaceAll("\n", "\r\n"),
    });

    await installCatalog(repositoryPath, { sourcePath, packageVersion: "0.7.0", baseline: offline });

    const written = await readFile(join(repositoryPath, ".github/workflows/agent-check.md"), "utf8");
    expect(written).toContain("workflows@0.7.0. Source:");
    expect(written).toContain("  REPO_RULES: \"my rules\"\r\n");
    expect(written).not.toMatch(/[^\r]\n/);
  });

  // The stack default is a first-install convenience. Afterwards the value is the consumer's.
  it("applies the stack VERIFY_COMMANDS default only when a worker is first installed", async () => {
    const sourcePath = await createDirectory({
      "workflows/agent-check.md": worker("  VERIFY_COMMANDS: \"package verify\"\n"),
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{}\n",
    });
    const repositoryPath = await createDirectory({ "pnpm-lock.yaml": "lockfileVersion: 9\n" });
    const inspection = await inspectRepository(repositoryPath);

    await installCatalog(repositoryPath, { sourcePath, inspection, packageVersion: "0.7.0" });
    const workerPath = join(repositoryPath, ".github/workflows/agent-check.md");
    await expect(readFile(workerPath, "utf8")).resolves.toContain("  VERIFY_COMMANDS: \"pnpm verify\"\n");

    await writeFile(workerPath, (await readFile(workerPath, "utf8")).replace("\"pnpm verify\"", "\"pnpm test --filter web\""), "utf8");
    const second = await installCatalog(repositoryPath, { sourcePath, inspection, packageVersion: "0.7.1", baseline: offline });

    expect(second.changes.find((change) => change.target === ".github/workflows/agent-check.md")).toMatchObject({ status: "updated", keptEnv: ["VERIFY_COMMANDS"] });
    await expect(readFile(workerPath, "utf8")).resolves.toContain("  VERIFY_COMMANDS: \"pnpm test --filter web\"\n");
  });

  it("installs templates only when explicitly selected", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "name: Check\n",
      "workflows/agent-check.md": "# Check\n",
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-3\" }\n",
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
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-3\" }\n",
    });
    const repositoryPath = await createDirectory({});

    const result = await installCatalog(repositoryPath, { sourcePath });
    expect(result.installed).toContain("opencode.ci.json");
    expect(result.installed).toContain("scripts/compile-agent-workflows.mjs");
    await expect(readFile(join(repositoryPath, "opencode.ci.json"), "utf8")).resolves.toBe("{ \"model\": \"plainconcepts/glm-5-3\" }\n");
    await expect(readFile(join(repositoryPath, "scripts/compile-agent-workflows.mjs"), "utf8")).resolves.toBe("compile\n");
  });

  it("installCatalog deduplicates compile script in both scripts/ and mandatory files", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "name: Check\n",
      "workflows/agent-check.md": "# Check\n",
      "scripts/compile-agent-workflows.mjs": "same compile script\n",
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-3\" }\n",
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

  // gh-aw cannot share runs-on through an import, so each worker names its own pool and a
  // forced update must leave it alone. Rewriting it moves a repository's agents onto another
  // pool, and one of ours has two machines in it.
  it("keeps the consumer's runner pool through a forced update", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "name: Check\n",
      "workflows/agent-check.md": "---\nenv:\n  VERIFY_COMMANDS: \"package verify\"\n---\njobs:\n  agent:\n    runs-on: agents-arc\n  deterministic:\n    runs-on: ubuntu-latest\nruns-on: agents-arc\nruns-on-slim: agents-arc\n",
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{}\n",
    });
    const repositoryPath = await createDirectory({
      ".github/workflows/agent-check.md": "---\nenv:\n  VERIFY_COMMANDS: \"consumer verify\"\n---\njobs:\n  agent:\n    runs-on: OwnPool\n  deterministic:\n    runs-on: ubuntu-latest\nruns-on: OwnPool\nruns-on-slim: OwnPool\n",
    });

    await installCatalog(repositoryPath, { force: true, sourcePath });
    const written = await readFile(join(repositoryPath, ".github/workflows/agent-check.md"), "utf8");

    expect(written).toContain("runs-on: OwnPool");
    expect(written).not.toContain("agents-arc");
    // GitHub's own runner is not a per-repository choice and stays as the package has it.
    expect(written).toContain("runs-on: ubuntu-latest");
    // And the env value is still preserved, which this shares a code path with.
    expect(written).toContain('VERIFY_COMMANDS: "consumer verify"');
  });

  // A consumer naming two pools has drifted rather than decided. Guessing which it meant
  // would be worse than leaving the package's, so it is left.
  it("leaves the package pool when the consumer names more than one", async () => {
    const sourcePath = await createDirectory({
      "actions/check/action.yml": "name: Check\n",
      "workflows/agent-check.md": "---\nenv:\n  VERIFY_COMMANDS: \"package verify\"\n---\njobs:\n  agent:\n    runs-on: agents-arc\n  deterministic:\n    runs-on: ubuntu-latest\nruns-on: agents-arc\nruns-on-slim: agents-arc\n",
      "scripts/compile-agent-workflows.mjs": "compile\n",
      "templates/opencode/opencode.ci.json": "{}\n",
    });
    const repositoryPath = await createDirectory({
      ".github/workflows/agent-check.md": "---\nenv:\n  VERIFY_COMMANDS: \"consumer verify\"\n---\njobs:\n  agent:\n    runs-on: OwnPool\n  other:\n    runs-on: SomethingElse\n",
    });

    await installCatalog(repositoryPath, { force: true, sourcePath });
    const written = await readFile(join(repositoryPath, ".github/workflows/agent-check.md"), "utf8");

    expect(written).toContain("runs-on: agents-arc");
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

  // Only changed files are staged, so the compile has to see the consumer's current copies of
  // everything else, the compile script included, or a no-op update would compile nothing.
  it("stages the consumer's compile script and workflows for the compile even when they did not change", async () => {
    const sourcePath = await createDirectory({
      "workflows/agent-check.md": worker("  REPO_RULES: \"package rules\"\n"),
      "scripts/compile-agent-workflows.mjs": "gh aw compile\n",
      "templates/opencode/opencode.ci.json": "{}\n",
    });
    const repositoryPath = await createDirectory({
      ".github/workflows/agent-check.md": worker("  REPO_RULES: \"my rules\"\n", "0.6.1"),
      ".github/workflows/agent-other.md": "consumer only\n",
      "scripts/compile-agent-workflows.mjs": "gh aw compile\n",
      "opencode.ci.json": "{}\n",
    });
    let seen: string[] = [];

    await installCatalog(repositoryPath, {
      sourcePath,
      packageVersion: "0.7.0",
      baseline: offline,
      compile: async (stagingPath) => {
        seen = await Promise.all([
          readFile(join(stagingPath, "scripts", "compile-agent-workflows.mjs"), "utf8"),
          readFile(join(stagingPath, ".github", "workflows", "agent-other.md"), "utf8"),
          readFile(join(stagingPath, ".github", "workflows", "agent-check.md"), "utf8"),
        ]);
      },
    });

    expect(seen[0]).toBe("gh aw compile\n");
    expect(seen[1]).toBe("consumer only\n");
    expect(seen[2]).toContain("workflows@0.7.0.");
  });

  it("installs the opencode.ci.json template to the repository root", async () => {
    const sourcePath = await createDirectory({
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-3\" }\n",
    });
    const repositoryPath = await createDirectory({});

    await expect(installTemplate(repositoryPath, "opencode.ci.json", { sourcePath })).resolves.toEqual({
      installed: ["opencode.ci.json"],
      conflicts: [],
    });
    await expect(readFile(join(repositoryPath, "opencode.ci.json"), "utf8")).resolves.toBe("{ \"model\": \"plainconcepts/glm-5-3\" }\n");
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
      "templates/opencode/opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-3\" }\n",
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
    await expect(readFile(join(repositoryPath, "opencode.ci.json"), "utf8")).resolves.toBe("{ \"model\": \"plainconcepts/glm-5-3\" }\n");
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
      ".github/workflows/agent-release.md": "# Release\n",
      ".github/workflows/agent-refine.md": "# Refine\n",
    });

    await expect(installedRoutes(repositoryPath)).resolves.toEqual(["refine", "implement", "release"]);
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
