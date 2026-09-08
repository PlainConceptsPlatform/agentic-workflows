import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "./index.js";
import * as catalogInstallation from "./catalog-installation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
  vi.restoreAllMocks();
});

const emptyCatalogResult: catalogInstallation.CatalogInstallResult = {
  installed: [],
  conflicts: [],
  changes: [],
  packageVersion: "0.0.0-test",
  installedVersions: [],
  baselines: [],
  upToDate: true,
  dryRun: false,
};

function mockInstallers() {
  const installCatalog = vi.spyOn(catalogInstallation, "installCatalog").mockResolvedValue(emptyCatalogResult);
  const installTemplate = vi.spyOn(catalogInstallation, "installTemplate").mockResolvedValue({ installed: [], conflicts: [] });
  return { installCatalog, installTemplate };
}

describe("workflows CLI", () => {
  it("prints template names in help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["--help"])).resolves.toBe(0);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("agentics-checks"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("app-ci-dotnet-next"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("opencode.ci.json"));
    log.mockRestore();
  });

  it("prints route names as positional arguments in help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["--help"])).resolves.toBe(0);

    const output = log.mock.calls[0]![0] as string;
    expect(output).toContain("refine, implement, triage, apply-review, merge-gate, audit, release");
    expect(output).toContain("add [routes]");
    expect(output).toContain("--dry-run");
    log.mockRestore();
  });

  it("rejects an unsupported template name", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(run(["add", "--template", "unknown"])).resolves.toBe(1);

    expect(error).toHaveBeenCalledWith("--template must be one of: agentics-checks|agentics-maintenance|app-ci-dotnet-next|app-ci-node-monorepo|bug-report|feature-request|github-release|opencode.ci.json.");
    error.mockRestore();
  });

  it("rejects an unknown route passed to add", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(run(["add", "frobnicate"])).resolves.toBe(1);

    expect(error).toHaveBeenCalledWith("Unknown route: frobnicate. Valid routes: refine, implement, triage, apply-review, merge-gate, audit, release.");
    error.mockRestore();
  });

  it("rejects a duplicate route", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(run(["add", "refine", "refine"])).resolves.toBe(1);

    expect(error).toHaveBeenCalledWith("Duplicate route: refine.");
    error.mockRestore();
  });

  it("lists all workflows and templates with install status [ ] when none installed", async () => {
    const repositoryPath = await createRepository({});
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["list"], repositoryPath)).resolves.toBe(0);

    expect(log).toHaveBeenCalledTimes(1);
    const output = log.mock.calls[0]![0] as string;
    expect(output).toContain("Workflows:");
    expect(output).toContain("Templates:");
    expect(output).toContain("refine");
    expect(output).toContain("implement");
    expect(output).toContain("agentics-checks");
    expect(output).toContain("app-ci-dotnet-next");
    expect(output).toContain("github-release");
    // None installed: all [ ]
    const installedCount = (output.match(/\[x\]/g) ?? []).length;
    expect(installedCount).toBe(0);
    // 6 routes + 9 templates = 15 entries
    const uninstalledCount = (output.match(/\[ \]/g) ?? []).length;
    expect(uninstalledCount).toBe(15);
    log.mockRestore();
  });

  it("marks installed workflows with [x]", async () => {
    const repositoryPath = await createRepository({
      ".github/workflows/agent-refine.md": "# Refine",
      ".github/workflows/agentics-checks.yml": "name: Agentics checks",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["list"], repositoryPath)).resolves.toBe(0);

    const output = log.mock.calls[0]![0] as string;
    const installed = output.match(/(\[x\])/g) ?? [];
    expect(installed.length).toBe(2);
    // refine and agentics-checks should be [x]
    const refineLines = output.split("\n").filter((line) => line.includes("refine") || line.includes("agentics-checks"));
    expect(refineLines.filter((line) => line.includes("[x]"))).toHaveLength(2);
    log.mockRestore();
  });

  it("search filters by name", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["search", "audit"])).resolves.toBe(0);

    const output = log.mock.calls[0]![0] as string;
    expect(output).toContain("audit");
    expect(output).not.toContain("Templates:");
    // Only the audit route should be returned — no other route name should appear.
    const visibleRoutes = ["refine", "implement", "triage", "apply-review", "merge-gate"];
    for (const route of visibleRoutes) {
      expect(output).not.toContain(`${route} —`);
    }
    log.mockRestore();
  });

  it("search filters by description keyword", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["search", "CI"])).resolves.toBe(0);

    const output = log.mock.calls[0]![0] as string;
    expect(output).toContain("dotnet-next");
    expect(output).toContain("node-monorepo");
    expect(output).not.toContain("refine —");
    log.mockRestore();
  });

  it("search with no matches prints a no-match message", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["search", "nonexistent"])).resolves.toBe(0);

    const output = log.mock.calls[0]![0] as string;
    expect(output).toBe("No workflows matched the search query.");
    log.mockRestore();
  });

  it("search with no query fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(run(["search"])).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("search requires exactly one query argument.");
    error.mockRestore();
  });

  it("search with too many arguments fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(run(["search", "a", "b"])).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("search requires exactly one query argument.");
    error.mockRestore();
  });

  it("add with no routes and no template calls installCatalog with empty selectedRoutes", async () => {
    const { installCatalog, installTemplate } = mockInstallers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["add"])).resolves.toBe(0);

    expect(installCatalog).toHaveBeenCalledOnce();
    expect(installCatalog).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ selectedRoutes: [] }));
    expect(installTemplate).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("add with explicit routes passes those routes to installCatalog", async () => {
    const { installCatalog, installTemplate } = mockInstallers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["add", "implement", "refine", "audit"])).resolves.toBe(0);

    expect(installCatalog).toHaveBeenCalledOnce();
    expect(installCatalog).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ selectedRoutes: ["implement", "refine", "audit"] }),
    );
    expect(installTemplate).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("add --force passes force flag to installCatalog", async () => {
    const { installCatalog } = mockInstallers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["add", "--force"])).resolves.toBe(0);

    expect(installCatalog).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ force: true, selectedRoutes: [] }));
    log.mockRestore();
  });

  it("add with routes and --force passes both", async () => {
    const { installCatalog } = mockInstallers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["add", "refine", "implement", "--force"])).resolves.toBe(0);

    expect(installCatalog).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ force: true, selectedRoutes: ["refine", "implement"] }),
    );
    log.mockRestore();
  });

  it("add with routes and template calls both installCatalog and installTemplate", async () => {
    const { installCatalog, installTemplate } = mockInstallers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["add", "refine", "--template", "agentics-checks"])).resolves.toBe(0);

    expect(installCatalog).toHaveBeenCalledOnce();
    expect(installCatalog).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ selectedRoutes: ["refine"] }),
    );
    expect(installTemplate).toHaveBeenCalledOnce();
    expect(installTemplate).toHaveBeenCalledWith(expect.any(String), "agentics-checks", expect.any(Object));
    log.mockRestore();
  });

  it("add with template only calls installTemplate but not installCatalog", async () => {
    const { installCatalog, installTemplate } = mockInstallers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["add", "--template", "agentics-checks"])).resolves.toBe(0);

    expect(installCatalog).not.toHaveBeenCalled();
    expect(installTemplate).toHaveBeenCalledOnce();
    expect(installTemplate).toHaveBeenCalledWith(expect.any(String), "agentics-checks", expect.any(Object));
    log.mockRestore();
  });

  it("add with routes and template and force passes all options", async () => {
    const { installCatalog, installTemplate } = mockInstallers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["add", "refine", "implement", "--template", "agentics-checks", "--force"])).resolves.toBe(0);

    expect(installCatalog).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ force: true, selectedRoutes: ["refine", "implement"] }),
    );
    expect(installTemplate).toHaveBeenCalledWith(
      expect.any(String),
      "agentics-checks",
      expect.objectContaining({ force: true }),
    );
    log.mockRestore();
  });

  // Package-owned files never conflict any more; only a consumer-owned template does.
  it("add with a template conflict and no force exits 1", async () => {
    const { installTemplate } = mockInstallers();
    installTemplate.mockResolvedValue({ installed: [], conflicts: [".github/workflows/agentics-checks.yml"] });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(run(["add", "--template", "agentics-checks"])).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Template conflicts found"));
    error.mockRestore();
  });

  it("add with a template conflict and --force still succeeds", async () => {
    const { installTemplate } = mockInstallers();
    installTemplate.mockResolvedValue({ installed: [".github/workflows/agentics-checks.yml"], conflicts: [".github/workflows/agentics-checks.yml"] });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["add", "--template", "agentics-checks", "--force"])).resolves.toBe(0);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("add with --template but missing name produces an error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(run(["add", "--template"])).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("--template requires a name.");
    error.mockRestore();
  });

  it("add with multiple --template flags produces an error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(run(["add", "--template", "agentics-checks", "--template", "agentics-maintenance"])).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("--template can only be specified once.");
    error.mockRestore();
  });

  it("add with unknown flag produces an error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(run(["add", "--unknown"])).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("Unknown option: --unknown");
    error.mockRestore();
  });

  it("add unions requested routes with already-installed routes", async () => {
    const { installCatalog } = mockInstallers();
    const repositoryPath = await createRepository({
      ".github/workflows/agent-refine.md": "# Refine",
      ".github/workflows/agent-implement.md": "# Implement",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["add", "audit"], repositoryPath)).resolves.toBe(0);

    expect(installCatalog).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ selectedRoutes: ["audit", "refine", "implement"] }),
    );
    log.mockRestore();
  });

  // The complaint this fixes: `workflows update` used to install with an empty route set, which
  // stripped every call-* job from the router and never touched the workers.
  it("update refreshes exactly the installed route set", async () => {
    const { installCatalog } = mockInstallers();
    const repositoryPath = await createRepository({
      ".github/workflows/agent-refine.md": "# Refine",
      ".github/workflows/agent-implement.md": "# Implement",
      ".github/workflows/agent-release.md": "# Release",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["update"], repositoryPath)).resolves.toBe(0);

    expect(installCatalog).toHaveBeenCalledOnce();
    expect(installCatalog).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ selectedRoutes: ["refine", "implement", "release"], dryRun: false }),
    );
    log.mockRestore();
  });

  it("update --dry-run plans without writing and prints the plan", async () => {
    const installCatalog = vi.spyOn(catalogInstallation, "installCatalog").mockResolvedValue({
      ...emptyCatalogResult,
      dryRun: true,
      upToDate: false,
      installedVersions: ["0.6.1"],
      changes: [
        { target: ".github/workflows/agent-refine.md", status: "updated", installedVersion: "0.6.1", keptEnv: ["REPO_RULES"] },
        { target: ".github/workflows/work-router.yml", status: "unchanged" },
      ],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["update", "--dry-run"])).resolves.toBe(0);

    expect(installCatalog).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ dryRun: true }));
    const printed = JSON.parse(log.mock.calls[0]![0] as string) as { dryRun: boolean; upToDate: boolean; unchanged: number; changes: { target: string }[] };
    expect(printed.dryRun).toBe(true);
    expect(printed.upToDate).toBe(false);
    expect(printed.unchanged).toBe(1);
    expect(printed.changes.map((change) => change.target)).toEqual([".github/workflows/agent-refine.md"]);
    log.mockRestore();
  });

  it("add --dry-run with a template does not install the template", async () => {
    const { installCatalog, installTemplate } = mockInstallers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["add", "--template", "agentics-checks", "--dry-run"])).resolves.toBe(0);

    expect(installCatalog).not.toHaveBeenCalled();
    expect(installTemplate).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("\"templatesPlanned\""));
    log.mockRestore();
  });

  // Rolling out an unpublished version leaves the merge two-way, which keeps the package
  // defaults a consumer never chose. A local baseline restores the three-way merge.
  it("update --baseline passes a fixed baseline resolver instead of the npm fetcher", async () => {
    const { installCatalog } = mockInstallers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["update", "--baseline", "some/loops"])).resolves.toBe(0);

    const options = installCatalog.mock.calls[0]![1]!;
    expect(options.baseline).toBeTypeOf("function");
    await expect(options.baseline!("0.10.1")).resolves.toBe(resolve("some/loops"));
    // Any recorded version resolves to the same directory: the caller chose it deliberately.
    await expect(options.baseline!("0.6.1")).resolves.toBe(resolve("some/loops"));
    log.mockRestore();
  });

  it("update without --baseline leaves the npm fetcher in place", async () => {
    const { installCatalog } = mockInstallers();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["update"])).resolves.toBe(0);

    expect(installCatalog.mock.calls[0]![1]!.baseline).toBeUndefined();
    log.mockRestore();
  });

  it("--baseline requires a path", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(run(["update", "--baseline"])).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("--baseline requires a path.");
    error.mockRestore();
  });

  it("--version prints the package version", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["--version"])).resolves.toBe(0);

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\d+\.\d+\.\d+/));
    log.mockRestore();
  });

  it("remove requires at least one route", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(run(["remove"])).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("remove requires at least one route.");
    error.mockRestore();
  });

  it("remove rejects the --template flag", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(run(["remove", "--template", "agentics-checks"])).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith("remove does not accept --template.");
    error.mockRestore();
  });

  it("remove regenerates the router for the remaining routes and deletes the worker", async () => {
    const { installCatalog } = mockInstallers();
    const repositoryPath = await createRepository({
      ".github/workflows/agent-refine.md": "# Refine",
      ".github/workflows/agent-refine.lock.yml": "generated",
      ".github/workflows/agent-implement.md": "# Implement",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["remove", "refine", "--force"], repositoryPath)).resolves.toBe(0);

    expect(installCatalog).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ force: true, selectedRoutes: ["implement"] }),
    );

    const { access } = await import("node:fs/promises");
    const { constants } = await import("node:fs");
    await expect(access(join(repositoryPath, ".github/workflows/agent-refine.md"), constants.F_OK)).rejects.toThrow();
    await expect(access(join(repositoryPath, ".github/workflows/agent-refine.lock.yml"), constants.F_OK)).rejects.toThrow();
    await expect(access(join(repositoryPath, ".github/workflows/agent-implement.md"), constants.F_OK)).resolves.toBeUndefined();
    log.mockRestore();
  });
});

async function createRepository(files: Record<string, string>): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "workflows-"));
  temporaryDirectories.push(repositoryPath);
  await Promise.all(Object.entries(files).map(async ([relativePath, content]) => {
    const path = join(repositoryPath, relativePath);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
  }));
  return repositoryPath;
}
