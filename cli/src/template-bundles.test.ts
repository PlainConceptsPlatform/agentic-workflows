import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as catalogInstallation from "./catalog-installation.js";
import { run } from "./index.js";
import { packageVersion } from "./package-baseline.js";
import { installBundle, installedBundles } from "./template-bundles.js";

const temporaryDirectories: string[] = [];
const sourcePath = catalogSourcePathForTests();

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
  vi.restoreAllMocks();
});

const QUALITY_GATES = [
  ".jscpd.json",
  ".jscpd.json.md",
  ".semgrep/platform-hygiene.yml",
  ".zap/rules.tsv",
  "scripts/check-complexity.mjs",
  "scripts/check-coverage.mjs",
  "scripts/check-duplication.mjs",
  "scripts/check-mutation.mjs",
  "scripts/dast-wait-stable.sh",
  "scripts/engineering-excellence.mjs",
  "scripts/engineering-excellence.schema.json",
  "scripts/engineering-excellence.schema.json.md",
  "scripts/lib/complexity-gate.mjs",
  "scripts/lib/complexity-gate.test.mjs",
  "scripts/lib/duplication-gate.mjs",
  "scripts/lib/duplication-gate.test.mjs",
  "scripts/lib/engineering-excellence.mjs",
  "scripts/lib/engineering-excellence.test.mjs",
  "scripts/lib/hygiene-facet.test.mjs",
  "scripts/lib/quality-config.mjs",
  "scripts/lib/quality-config.test.mjs",
  "scripts/lib/source-files.mjs",
];

const PLATFORM_TEMPLATE = [
  ".github/workflows/platform-template-sync.yml",
  "scripts/check-platform-conformance.mjs",
];

const DEPENDABOT_MERGE = [
  ".github/actions/merge-dependabot/action.yml",
  ".github/actions/merge-dependabot/merge-dependabot.mjs",
  ".github/workflows/dependabot-merge.yml",
];

const HEADERLESS_COVERAGE = "// Atlas's own floors, no ownership header.\nexport const FLOORS = { 'Atlas.Domain': 0.9 };\n";
const OWN_JSCPD = "{ \"path\": [\"src\"], \"minLines\": 5 }\n";

describe("bundle templates", () => {
  it("installs quality-gates into an empty repository and nothing else", async () => {
    const repositoryPath = await createDirectory({});
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["add", "--template", "quality-gates"], repositoryPath)).resolves.toBe(0);

    const version = await packageVersion();
    expect(await filesIn(repositoryPath)).toEqual(QUALITY_GATES);
    for (const target of QUALITY_GATES.filter((file) => !file.endsWith(".json"))) {
      expect(await read(repositoryPath, target), target).toContain(`Managed by @plainconceptsplatform/workflows@${version}.`);
    }
    // The floors and the baselines are the app's: the template never writes them.
    expect(await present(repositoryPath, "quality.config.json")).toBe(false);
    expect(await present(repositoryPath, "scripts/complexity-baseline.json")).toBe(false);
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { templates: { template: string; changes: { status: string }[] }[] };
    expect(output.templates.map((entry) => entry.template)).toEqual(["quality-gates"]);
    expect(output.templates[0]!.changes.every((change) => change.status === "added")).toBe(true);
  });

  it("refreshes on update only the bundles a repository installed", async () => {
    const repositoryPath = await createDirectory({});
    await installBundle(repositoryPath, "quality-gates", sourcePath, { packageVersion: "1.0.0" });
    await writeFile(join(repositoryPath, "scripts/check-mutation.mjs"), (await read(repositoryPath, "scripts/check-mutation.mjs")).replace("covered-code", "edited"), "utf8");
    mockCatalog();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["update"], repositoryPath)).resolves.toBe(0);

    const version = await packageVersion();
    const mutation = await read(repositoryPath, "scripts/check-mutation.mjs");
    expect(mutation).toContain(`Managed by @plainconceptsplatform/workflows@${version}.`);
    expect(mutation).not.toContain("edited");
    for (const target of PLATFORM_TEMPLATE) expect(await present(repositoryPath, target), target).toBe(false);
    expect(await installedBundles(repositoryPath, sourcePath)).toEqual(["quality-gates"]);
  });

  it("adds nothing on update to a repository that never asked for a bundle", async () => {
    const repositoryPath = await createDirectory({ "README.md": "# App\n" });
    mockCatalog();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["update"], repositoryPath)).resolves.toBe(0);

    expect(await filesIn(repositoryPath)).toEqual(["README.md"]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).not.toHaveProperty("templates");
  });

  // Atlas and Pliny-Bot carry their own scripts/check-*.mjs at these paths, without our header.
  it("leaves a repository's own headerless gate files alone unless forced", async () => {
    const repositoryPath = await createDirectory({ "scripts/check-coverage.mjs": HEADERLESS_COVERAGE, ".jscpd.json": OWN_JSCPD });
    mockCatalog();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["update", "--force"], repositoryPath)).resolves.toBe(0);
    expect(await filesIn(repositoryPath)).toEqual([".jscpd.json", "scripts/check-coverage.mjs"]);

    const added = await installBundle(repositoryPath, "quality-gates", sourcePath);
    expect(await read(repositoryPath, "scripts/check-coverage.mjs")).toBe(HEADERLESS_COVERAGE);
    expect(await read(repositoryPath, ".jscpd.json")).toBe(OWN_JSCPD);
    expect(await present(repositoryPath, ".jscpd.json.md")).toBe(false);
    expect(added.changes.filter((change) => change.status === "skipped").map((change) => change.target))
      .toEqual([".jscpd.json", ".jscpd.json.md", "scripts/check-coverage.mjs"]);
    // The other files now carry the header, so the bundle counts as installed; a refresh still skips the consumer's.
    await installBundle(repositoryPath, "quality-gates", sourcePath);
    expect(await read(repositoryPath, "scripts/check-coverage.mjs")).toBe(HEADERLESS_COVERAGE);

    await installBundle(repositoryPath, "quality-gates", sourcePath, { force: true });
    expect(await read(repositoryPath, "scripts/check-coverage.mjs")).toContain("Managed by @plainconceptsplatform/workflows@");
    expect(await read(repositoryPath, ".jscpd.json")).not.toBe(OWN_JSCPD);
    expect(await present(repositoryPath, ".jscpd.json.md")).toBe(true);
  });

  it("hands a JSON file to the consumer once its companion note loses the header", async () => {
    const repositoryPath = await createDirectory({});
    await installBundle(repositoryPath, "quality-gates", sourcePath);
    await writeFile(join(repositoryPath, ".jscpd.json"), OWN_JSCPD, "utf8");
    await writeFile(join(repositoryPath, ".jscpd.json.md"), "# Our duplication scope\n", "utf8");

    const result = await installBundle(repositoryPath, "quality-gates", sourcePath);

    expect(await read(repositoryPath, ".jscpd.json")).toBe(OWN_JSCPD);
    expect(result.changes.find((change) => change.target === ".jscpd.json")?.status).toBe("skipped");
  });

  it("lists a bundle as installed by its headers, not by its paths", async () => {
    const atlas = await createDirectory({ "scripts/check-coverage.mjs": HEADERLESS_COVERAGE });
    const family = await createDirectory({});
    await installBundle(family, "platform-template", sourcePath);

    expect(await installedBundles(atlas, sourcePath)).toEqual([]);
    expect(await installedBundles(family, sourcePath)).toEqual(["platform-template"]);
    expect(await filesIn(family)).toEqual(PLATFORM_TEMPLATE);
  });
});

describe("dependabot-merge", () => {
  it("installs its workflow and the action it calls, stamped, into a repository without the router", async () => {
    const repositoryPath = await createDirectory({});
    const catalog = mockCatalog();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["add", "--template", "dependabot-merge"], repositoryPath)).resolves.toBe(0);

    expect(catalog).not.toHaveBeenCalled();
    expect(await filesIn(repositoryPath)).toEqual(DEPENDABOT_MERGE);
    const version = await packageVersion();
    for (const target of DEPENDABOT_MERGE) {
      expect(await read(repositoryPath, target), target).toContain(`Managed by @plainconceptsplatform/workflows@${version}.`);
    }
    const workflow = await read(repositoryPath, ".github/workflows/dependabot-merge.yml");
    expect(workflow).toContain("uses: ./.github/actions/merge-dependabot");
    expect(workflow).toContain("github.token");
  });

  it("refreshes on update without installing the router where only bundles are installed", async () => {
    const repositoryPath = await createDirectory({ "README.md": "# Pillar\n" });
    await installBundle(repositoryPath, "dependabot-merge", sourcePath, { packageVersion: "1.0.0" });
    const stale = ".github/actions/merge-dependabot/merge-dependabot.mjs";
    await writeFile(join(repositoryPath, stale), `${await read(repositoryPath, stale)}// edited\n`, "utf8");
    const catalog = mockCatalog();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["update"], repositoryPath)).resolves.toBe(0);

    expect(catalog).not.toHaveBeenCalled();
    expect(await filesIn(repositoryPath)).toEqual([...DEPENDABOT_MERGE, "README.md"].sort());
    const version = await packageVersion();
    expect(await read(repositoryPath, stale)).toContain(`Managed by @plainconceptsplatform/workflows@${version}.`);
    expect(await read(repositoryPath, stale)).not.toContain("// edited");
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { templates: { template: string; changes: { target: string; status: string }[] }[] };
    expect(output.templates.map((entry) => entry.template)).toEqual(["dependabot-merge"]);
    expect(output.templates[0]!.changes.map((change) => change.status)).toEqual(["updated", "updated", "updated"]);
  });

  it("is not installed in a router consumer merely because the catalog put its action there", async () => {
    const router = await createDirectory({});
    const action = await readFile(join(sourcePath, "actions/merge-dependabot/action.yml"), "utf8");
    await mkdir(join(router, ".github/actions/merge-dependabot"), { recursive: true });
    await writeFile(join(router, ".github/actions/merge-dependabot/action.yml"), action, "utf8");

    expect(await installedBundles(router, sourcePath)).toEqual([]);
  });

  it("warns that the router already does the same work", async () => {
    const repositoryPath = await createDirectory({ ".github/workflows/work-router.yml": "name: router\n" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(run(["add", "--template", "dependabot-merge"], repositoryPath)).resolves.toBe(0);

    expect(error).toHaveBeenCalledWith(expect.stringContaining("already merges Dependabot pull requests"));
  });
});

function mockCatalog() {
  return vi.spyOn(catalogInstallation, "installCatalog").mockResolvedValue({
    installed: [],
    conflicts: [],
    changes: [],
    packageVersion: "0.0.0-test",
    installedVersions: [],
    baselines: [],
    upToDate: true,
    dryRun: false,
    warnings: [],
  });
}

function catalogSourcePathForTests(): string {
  return catalogInstallation.catalogSourcePath();
}

async function createDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "workflows-bundle-"));
  temporaryDirectories.push(directory);
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(directory, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  return directory;
}

async function read(repositoryPath: string, target: string): Promise<string> {
  return readFile(join(repositoryPath, target), "utf8");
}

async function present(repositoryPath: string, target: string): Promise<boolean> {
  try {
    await access(join(repositoryPath, target), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function filesIn(directory: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1).replaceAll("\\", "/"))
    .sort();
}
