import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { catalogSourcePath, installTemplate } from "./catalog-installation.js";
import { run } from "./index.js";
import {
  DEFAULT_LAYOUT,
  normalizeRoot,
  persistLayout,
  renderLayout,
  renderWorkerLayout,
  resolveLayout,
} from "./project-layout.js";
import { installBundle } from "./template-bundles.js";
import { askLayout } from "./tui.js";

const temporaryDirectories: string[] = [];
const sourcePath = catalogSourcePath();

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
  vi.restoreAllMocks();
});

const CI_ENV = (api: string, web: string): string => [
  "# Managed by @plainconceptsplatform/workflows. Source: loops/templates/ci/app-ci-dotnet-next.yml.",
  "name: App CI",
  "on: push",
  "env:",
  "  # Where the .NET solution lives.",
  `  API_WORKING_DIRECTORY: ${api}`,
  `  WEB_DIRECTORY: ${web}  # the web app`,
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    env:",
  "      WEB_DIRECTORY: nested/ignored",
  "    steps:",
  "      - run: echo",
  "",
].join("\n");

describe("normalizeRoot", () => {
  it("accepts relative paths and the repository root", () => {
    expect(normalizeRoot("api")).toBe("api");
    expect(normalizeRoot("./apps/web/")).toBe("apps/web");
    expect(normalizeRoot("apps\\api")).toBe("apps/api");
    expect(normalizeRoot('"app"')).toBe("app");
    expect(normalizeRoot(".")).toBe(".");
    expect(normalizeRoot("./")).toBe(".");
  });

  it("rejects absolute paths, parent segments and globs", () => {
    for (const value of ["/api", "C:/repo/api", "../api", "apps/../api", "apps/*", "", "my app"]) {
      expect(normalizeRoot(value), value).toBeUndefined();
    }
  });
});

describe("renderLayout", () => {
  it("returns the text unchanged for the default layout", () => {
    const text = '{ "path": ["apps/api/src", "apps/web/src"] }\n';
    expect(renderLayout(text, DEFAULT_LAYOUT)).toBe(text);
  });

  it("renders tool config for another layout and leaves other apps alone", () => {
    const layout = { api: "api", web: "app" };
    expect(renderLayout('"path": ["apps/api/src", "apps/web/src"]', layout)).toBe('"path": ["api/src", "app/src"]');
    expect(renderLayout('"apps/web": {', layout)).toBe('"app": {');
    expect(renderLayout("apps/web/out/_next/static/chunks/**/*.js", layout)).toBe("app/out/_next/static/chunks/**/*.js");
    expect(renderLayout("apps/webhooks apps/desktop apps/apiary", layout)).toBe("apps/webhooks apps/desktop apps/apiary");
    expect(renderLayout("run in apps/web.", layout)).toBe("run in app.");
  });

  it("scopes the Semgrep rules to each root", () => {
    const rule = "    paths:\n      include:\n        - \"/apps/\"\n      exclude:\n";
    expect(renderLayout(rule, { api: "api", web: "app" })).toBe("    paths:\n      include:\n        - \"/api/\"\n        - \"/app/\"\n      exclude:\n");
    expect(renderLayout(rule, { api: "src", web: "src" })).toBe("    paths:\n      include:\n        - \"/src/\"\n      exclude:\n");
    expect(renderLayout(rule, { api: ".", web: "apps/web" })).toBe("    paths:\n      include:\n        - \"*\"\n      exclude:\n");
  });

  it("drops the prefix for a root at the repository root", () => {
    const layout = { api: ".", web: "apps/web" };
    expect(renderLayout('["apps/api/src", "apps/web/src"]', layout)).toBe('["src", "apps/web/src"]');
    expect(renderLayout('"apps/api": {}', layout)).toBe('".": {}');
  });

  it("renders only a worker's MOCKUP_PATHS", () => {
    const worker = '---\nenv:\n  MOCKUP_PATHS: "apps/web/**"\n  OTHER: "apps/web/x"\n---\nBody apps/web\n';
    expect(renderWorkerLayout(worker, { api: "api", web: "app" })).toBe('---\nenv:\n  MOCKUP_PATHS: "app/**"\n  OTHER: "apps/web/x"\n---\nBody apps/web\n');
    expect(renderWorkerLayout(worker, DEFAULT_LAYOUT)).toBe(worker);
  });
});

describe("resolveLayout", () => {
  it("defaults to apps/api and apps/web when they exist", async () => {
    const repositoryPath = await createDirectory({ "apps/api/Api.csproj": "", "apps/web/package.json": "{}" });
    const resolved = await resolveLayout(repositoryPath);
    expect(resolved.layout).toEqual(DEFAULT_LAYOUT);
    expect(resolved.sources).toEqual({ api: "default", web: "default" });
    expect(resolved.warnings).toEqual([]);
    expect(resolved.errors).toEqual([]);
  });

  it("detects one candidate folder per root", async () => {
    const repositoryPath = await createDirectory({ "api/Api.sln": "", "app/package.json": "{}" });
    const resolved = await resolveLayout(repositoryPath);
    expect(resolved.layout).toEqual({ api: "api", web: "app" });
    expect(resolved.sources).toEqual({ api: "detected", web: "detected" });
  });

  it("does not take a folder without a package.json for the web project", async () => {
    const repositoryPath = await createDirectory({ "app/page.tsx": "", "package.json": "{}" });
    const resolved = await resolveLayout(repositoryPath);
    expect(resolved.layout.web).toBe("apps/web");
    expect(resolved.warnings.some((warning) => warning.includes("apps/web does not exist"))).toBe(true);
  });

  it("reports two candidate folders as ambiguous", async () => {
    const repositoryPath = await createDirectory({ "web/package.json": "{}", "frontend/package.json": "{}", "api/x": "" });
    const resolved = await resolveLayout(repositoryPath);
    expect(resolved.errors).toEqual([expect.stringContaining("web, frontend")]);
    expect(resolved.errors[0]).toContain("--web-dir");
  });

  it("reads the installed workflows' env: and ignores nested env, empty values and expressions", async () => {
    const repositoryPath = await createDirectory({
      ".github/workflows/app-ci.yml": CI_ENV("api", "app"),
      ".github/workflows/quality-mutation.yml": 'env:\n  API_WORKING_DIRECTORY: api\n  WEB_DIRECTORY: ""\njobs: {}\n',
      ".github/workflows/other.yml": "env:\n  WEB_DIRECTORY: ${{ vars.WEB }}\njobs: {}\n",
    });
    const resolved = await resolveLayout(repositoryPath);
    expect(resolved.layout).toEqual({ api: "api", web: "app" });
    expect(resolved.sources).toEqual({ api: "workflows", web: "workflows" });
    expect(resolved.errors).toEqual([]);
  });

  it("reports workflows that disagree, and lets an option settle it", async () => {
    const repositoryPath = await createDirectory({
      ".github/workflows/app-ci.yml": CI_ENV("api", "app"),
      ".github/workflows/quality-mutation.yml": "env:\n  API_WORKING_DIRECTORY: backend\njobs: {}\n",
    });
    const resolved = await resolveLayout(repositoryPath);
    expect(resolved.errors).toEqual([expect.stringContaining(".github/workflows/app-ci.yml (api), .github/workflows/quality-mutation.yml (backend)")]);

    const settled = await resolveLayout(repositoryPath, { api: "api" });
    expect(settled.errors).toEqual([]);
    expect(settled.layout.api).toBe("api");
    expect(settled.sources.api).toBe("option");
  });
});

describe("persistLayout", () => {
  it("rewrites only the top-level env values that differ, keeping comments", async () => {
    const repositoryPath = await createDirectory({
      ".github/workflows/app-ci.yml": CI_ENV("apps/api", "apps/web"),
      ".github/workflows/quality-mutation.yml": 'env:\n  API_WORKING_DIRECTORY: api\n  WEB_DIRECTORY: ""\njobs: {}\n',
    });

    const changed = await persistLayout(repositoryPath, { api: "api", web: "app" }, ["api", "web"]);

    expect(changed).toEqual([".github/workflows/app-ci.yml"]);
    const ci = await read(repositoryPath, ".github/workflows/app-ci.yml");
    expect(ci).toContain("  API_WORKING_DIRECTORY: api\n");
    expect(ci).toContain("  WEB_DIRECTORY: app  # the web app\n");
    expect(ci).toContain("      WEB_DIRECTORY: nested/ignored\n");
    // An empty WEB_DIRECTORY means "no web scope" in the mutation workflow: it stays empty.
    expect(await read(repositoryPath, ".github/workflows/quality-mutation.yml")).toContain('  WEB_DIRECTORY: ""\n');
  });

  it("writes nothing on a dry run, and quotes the repository root", async () => {
    const repositoryPath = await createDirectory({ ".github/workflows/app-ci.yml": CI_ENV("apps/api", "apps/web") });
    expect(await persistLayout(repositoryPath, { api: ".", web: "apps/web" }, ["api"], true)).toEqual([".github/workflows/app-ci.yml"]);
    expect(await read(repositoryPath, ".github/workflows/app-ci.yml")).toContain("  API_WORKING_DIRECTORY: apps/api\n");
    await persistLayout(repositoryPath, { api: ".", web: "apps/web" }, ["api"]);
    expect(await read(repositoryPath, ".github/workflows/app-ci.yml")).toContain('  API_WORKING_DIRECTORY: "."\n');
  });
});

describe("installing with a project layout", () => {
  it("renders the quality gates for a repository with api/ and app/", async () => {
    const repositoryPath = await createDirectory({ "api/Api.sln": "", "app/package.json": "{}" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(run(["add", "--template", "quality-gates"], repositoryPath)).resolves.toBe(0);

    expect(JSON.parse(await read(repositoryPath, ".jscpd.json")).path).toEqual(["api/src", "app/src"]);
    expect(Object.keys(JSON.parse(await read(repositoryPath, "knip.json")).workspaces)).toEqual(["app"]);
    expect(JSON.parse(await read(repositoryPath, ".size-limit.json"))[0].path).toBe("app/out/_next/static/chunks/**/*.js");
    const semgrep = await read(repositoryPath, ".semgrep/platform-hygiene.yml");
    expect(semgrep).not.toContain('"/apps/"');
    expect(semgrep).toContain('- "/api/"\n');
    expect(semgrep).toContain('- "/app/"\n');
    expect(await read(repositoryPath, "scripts/check-dead-code.mjs")).toContain("--report app/knip-report.json");
    // The script's own fallback stays the platform default.
    expect(await read(repositoryPath, "scripts/lib/engineering-excellence.mjs")).toContain("apps/api");
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { layout: { api: string; web: string; sources: unknown } };
    expect(output.layout).toMatchObject({ api: "api", web: "app", sources: { api: "detected", web: "detected" } });
    expect(error).not.toHaveBeenCalled();
  });

  it("writes byte-identical files for the default layout", async () => {
    const defaults = await createDirectory({ "apps/api/x": "", "apps/web/package.json": "{}" });
    const plain = await createDirectory({});
    await installBundle(defaults, "quality-gates", sourcePath, { packageVersion: "1.0.0", layout: DEFAULT_LAYOUT });
    await installBundle(plain, "quality-gates", sourcePath, { packageVersion: "1.0.0" });
    for (const target of [".jscpd.json", "knip.json", ".size-limit.json", ".semgrep/platform-hygiene.yml"]) {
      expect(await read(defaults, target), target).toBe(await read(plain, target));
    }
  });

  it("keeps the layout across update by reading it back from the workflows' env:", async () => {
    // No api/ or app/ folder: only the workflow says where the projects live.
    const repositoryPath = await createDirectory({ ".github/workflows/app-ci.yml": CI_ENV("api", "app") });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(run(["add", "--template", "quality-gates"], repositoryPath)).resolves.toBe(0);
    const first = await read(repositoryPath, ".jscpd.json");
    expect(JSON.parse(first).path).toEqual(["api/src", "app/src"]);

    await expect(run(["update"], repositoryPath)).resolves.toBe(0);

    expect(await read(repositoryPath, ".jscpd.json")).toBe(first);
    const output = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { templates: { changes: unknown[] }[]; layout: { sources: unknown } };
    expect(output.templates[0]!.changes).toEqual([]);
    expect(output.layout.sources).toEqual({ api: "workflows", web: "workflows" });
  });

  it("fails without writing when the layout is ambiguous, and installs once an option settles it", async () => {
    const repositoryPath = await createDirectory({
      ".github/workflows/app-ci.yml": CI_ENV("api", "app"),
      ".github/workflows/quality-mutation.yml": "env:\n  API_WORKING_DIRECTORY: backend\n  WEB_DIRECTORY: app\njobs: {}\n",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["add", "--template", "quality-gates"], repositoryPath)).resolves.toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("API_WORKING_DIRECTORY differs between installed workflows");
    await expect(read(repositoryPath, ".jscpd.json")).rejects.toThrow();

    await expect(run(["add", "--template", "quality-gates", "--api-dir", "api"], repositoryPath)).resolves.toBe(0);
    expect(JSON.parse(await read(repositoryPath, ".jscpd.json")).path).toEqual(["api/src", "app/src"]);
    expect(await read(repositoryPath, ".github/workflows/quality-mutation.yml")).toContain("  API_WORKING_DIRECTORY: api\n");
  });

  it("does not need a layout for an update with no layout-bound files", async () => {
    const repositoryPath = await createDirectory({ "web/package.json": "{}", "frontend/package.json": "{}" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(run(["add", "--template", "platform-template"], repositoryPath)).resolves.toBe(0);
  });

  it("leaves a consumer-owned layout-bound file as it is", async () => {
    const own = '{ "path": ["src"], "minLines": 5 }\n';
    const repositoryPath = await createDirectory({ "api/x": "", "app/package.json": "{}", ".jscpd.json": own });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(run(["add", "--template", "quality-gates"], repositoryPath)).resolves.toBe(0);

    expect(await read(repositoryPath, ".jscpd.json")).toBe(own);
    expect(Object.keys(JSON.parse(await read(repositoryPath, "knip.json")).workspaces)).toEqual(["app"]);
  });

  it("rejects a root outside the repository", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(run(["add", "--template", "quality-gates", "--web-dir", "../web"], await createDirectory({}))).resolves.toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("--web-dir must be a relative path");
  });

  it("installs a CI template with the layout in its env:, and reinstalls it without a conflict", async () => {
    const repositoryPath = await createDirectory({});
    const layout = { api: "api", web: "app" };

    expect((await installTemplate(repositoryPath, "app-ci-dotnet-next", { layout })).conflicts).toEqual([]);
    const ci = await read(repositoryPath, ".github/workflows/app-ci.yml");
    expect(ci).toContain("  API_WORKING_DIRECTORY: api\n");
    expect(ci).toContain("  WEB_DIRECTORY: app\n");
    expect(ci).not.toMatch(/apps\/(api|web)(?![\w-])/);

    expect((await installTemplate(repositoryPath, "app-ci-dotnet-next", { layout })).conflicts).toEqual([]);
    expect((await resolveLayout(repositoryPath)).layout).toEqual(layout);
  });
});

describe("askLayout", () => {
  it("accepts the proposal on an empty answer and asks again after an invalid one", async () => {
    const answers = ["", "../nope", "client"];
    const questions: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const layout = await askLayout(
      { layout: { api: "api", web: "app" }, sources: { api: "detected", web: "detected" }, warnings: [], errors: [] },
      async (question) => {
        questions.push(question);
        return answers.shift() ?? "";
      },
    );
    expect(layout).toEqual({ api: "api", web: "client" });
    expect(questions).toEqual([
      "Where does the api project live? [api] ",
      "Where does the web project live? [app] ",
      "Where does the web project live? [app] ",
    ]);
  });
});

async function createDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "workflows-layout-"));
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
