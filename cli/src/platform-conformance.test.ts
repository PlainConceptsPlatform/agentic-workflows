import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { catalogSourcePath } from "./catalog-installation.js";

const execFileAsync = promisify(execFile);
const SCRIPT = join(catalogSourcePath(), "templates", "platform-template", "scripts", "check-platform-conformance.mjs");
const GIT_IDENTITY = { GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const answers = (tag: string): string =>
  `_commit: ${tag}\n_src_path: https://github.com/PlainConceptsPlatform/Kitchen-Sink.git\napp_name: Numa\n`;
const MANIFEST = "# Platform-owned paths\napps/api/src/Platform/**\nDirectory.Packages.Platform.props\n.platform/manifest\n";
const PLATFORM_FILE = "apps/api/src/Platform/Audit/AuditChain.cs";
const ADOPTED = {
  ".copier-answers.yml": answers("v1.0.0"),
  ".platform/manifest": MANIFEST,
  [PLATFORM_FILE]: "namespace Platform.Audit;\n",
  "apps/api/src/Numa.Domain/Quote.cs": "namespace Numa.Domain;\n",
};
const exception = (path: string, expires: string): string =>
  `exceptions:\n  - path: "${path}"\n    reason: Numa keeps its own audit hashing until the chain lands\n    issue: https://github.com/PlainConceptsPlatform/Numa/issues/1\n    expires: ${expires}\n`;

const ACME_FILE = "src/platform/theme.ts";
const TEMPLATE_FILES = {
  [ACME_FILE]: "export const theme = 'acme';\n",
  "src/platform/ui/button.ts": "export const button = 'acme';\n",
};
type ContractFields = Partial<Record<"version" | "source" | "owned" | "sync", string>>;
const contract = (fields: ContractFields = {}, url = "https://github.com/acme/app-template"): string =>
  [
    `version: ${fields.version ?? "1"}`,
    `source:${fields.source ?? `\n  name: Acme app template   # used in messages\n  url: ${url}\n  changes: https://github.com/acme/app-template/issues/new`}`,
    `owned:${fields.owned ?? "\n  - .platform/contract.yml\n  - src/platform/**"}`,
    'reuse:\n  docs: [docs/platform/]\n  packages: ["@acme/ui"]',
    `sync:${fields.sync ?? "\n  marker: .template-sync\n  version:\n    file: .template-version.yml\n    key: ref\n  update: ./scripts/pull-template.sh"}`,
    "",
  ].join("\n");
const ACME = {
  ".platform/contract.yml": contract(),
  ".template-version.yml": "ref: v1.0.0\n",
  [ACME_FILE]: "export const theme = 'acme';\n",
  "src/app/main.ts": "export const app = 1;\n",
};

describe("check-platform-conformance without a contract", () => {
  it("passes silently in a repository that declares no contract", async () => {
    const repository = await repositoryWith({ [PLATFORM_FILE]: "namespace Platform.Audit;\n" });
    await change(repository, { [PLATFORM_FILE]: "namespace Platform.Audit; // edited\n" });

    expect(await check(repository)).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await check(repository, ["--compare"])).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await check(repository, ["--contract"])).toEqual({ code: 0, stdout: "contract=absent\n", stderr: "" });
  });

  it("passes silently where a Copier template left only its answers file", async () => {
    const repository = await repositoryWith({ ".copier-answers.yml": answers("v1.0.0"), [PLATFORM_FILE]: "namespace Platform.Audit;\n" });
    await change(repository, { [PLATFORM_FILE]: "namespace Platform.Audit; // edited\n" });

    expect(await check(repository)).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});

describe("check-platform-conformance with the legacy implicit contract", () => {
  it("reads .copier-answers.yml and .platform/manifest as the contract", async () => {
    const repository = await repositoryWith(ADOPTED);

    const result = await check(repository, ["--contract"]);

    expect(result).toEqual({
      code: 0,
      stdout:
        "contract=present\nself=false\nsource_name=Kitchen-Sink\nsource_url=https://github.com/PlainConceptsPlatform/Kitchen-Sink.git\n" +
        "source_web=https://github.com/PlainConceptsPlatform/Kitchen-Sink\nversion=v1.0.0\nupdate=copier update --trust --defaults --conflict inline\n",
      stderr: "",
    });
  });

  it("allows platform files to change in a template sync", async () => {
    const repository = await repositoryWith(ADOPTED);
    await change(repository, { ".copier-answers.yml": answers("v1.1.0"), [PLATFORM_FILE]: "namespace Platform.Audit; // v1.1.0\n" });

    const result = await check(repository);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("template sync v1.0.0 -> v1.1.0");
  });

  it("blocks a platform file edited outside a sync, and nothing else", async () => {
    const repository = await repositoryWith(ADOPTED);
    await change(repository, {
      [PLATFORM_FILE]: "namespace Platform.Audit; // local fix\n",
      "apps/api/src/Numa.Domain/Quote.cs": "namespace Numa.Domain; // app code\n",
    });

    const result = await check(repository);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${PLATFORM_FILE}: owned by Kitchen-Sink and changed outside a template sync`);
    expect(result.stderr).not.toContain("Quote.cs");
  });

  it("allows an edit an unexpired exception covers", async () => {
    const repository = await repositoryWith(ADOPTED);
    await change(repository, {
      [PLATFORM_FILE]: "namespace Platform.Audit; // local fix\n",
      ".platform/exceptions.yml": exception("apps/api/src/Platform/Audit/**", "2999-12-31"),
    });

    const result = await check(repository);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`${PLATFORM_FILE}: allowed by the exception until 2999-12-31`);
  });

  it("fails on an expired exception, whether or not it is used", async () => {
    const repository = await repositoryWith({ ...ADOPTED, ".platform/exceptions.yml": exception("apps/api/src/Platform/Audit/**", "2000-01-01") });
    await change(repository, { [PLATFORM_FILE]: "namespace Platform.Audit; // local fix\n" });

    const result = await check(repository);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("the exception for apps/api/src/Platform/Audit/** expired on 2000-01-01");
    expect(result.stderr).toContain(`${PLATFORM_FILE}: owned by Kitchen-Sink and changed outside a template sync`);
    expect((await check(repository, [])).code).toBe(1);
  });

  it("fails a sync that left conflict markers in a platform file", async () => {
    const repository = await repositoryWith(ADOPTED);
    await change(repository, {
      ".copier-answers.yml": answers("v1.1.0"),
      [PLATFORM_FILE]: "<<<<<<< before updating\nnamespace Platform.Audit; // local\n=======\nnamespace Platform.Audit;\n>>>>>>> after updating\n",
    });

    const result = await check(repository);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${PLATFORM_FILE}: unresolved template-sync conflict markers`);
  });
});

describe("check-platform-conformance with .platform/contract.yml", { timeout: 20_000 }, () => {
  it.each([
    [contract({ version: "2" }), ".platform/contract.yml: version 2 is not supported; this guard reads version 1"],
    [contract({ source: "\n  name: Acme app template" }), ".platform/contract.yml: source.url is required"],
    [contract({ owned: " []" }), ".platform/contract.yml: owned is required"],
    [contract({ sync: "\n  version:\n    file: .template-version.yml" }), ".platform/contract.yml: sync.version.key is required"],
    ["version: 1\nsource:\n\turl: x\n", ".platform/contract.yml:3: indent with spaces, not tabs"],
  ])("fails an invalid contract with one error naming the file and field: %#", async (text, error) => {
    const repository = await repositoryWith({ ...ACME, ".platform/contract.yml": text });

    const [result, outputs] = [await check(repository), await check(repository, ["--contract"])];

    expect(result.code).toBe(1);
    expect(result.stderr.trim().split("\n")).toEqual([expect.stringContaining(`✗ ${error}`)]);
    expect(outputs).toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining(error) });
  });

  it("wins over the legacy markers", async () => {
    const repository = await repositoryWith({ ...ADOPTED, ...ACME });
    await change(repository, { [PLATFORM_FILE]: "namespace Platform.Audit; // app edit\n", [ACME_FILE]: "export const theme = 'local';\n" });

    const result = await check(repository);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `${ACME_FILE}: owned by Acme app template and changed outside a template sync; change it in Acme app template (https://github.com/acme/app-template/issues/new)`,
    );
    expect(result.stderr).not.toContain(PLATFORM_FILE);
  });

  it("allows owned files to change when sync.version moves or sync.marker changes", async () => {
    const moved = await repositoryWith(ACME);
    await change(moved, { ".template-version.yml": "ref: v1.1.0\n", [ACME_FILE]: "export const theme = 'v1.1.0';\n" });
    const marked = await repositoryWith(ACME);
    await change(marked, { ".template-sync": "pulled\n", [ACME_FILE]: "export const theme = 'pulled';\n" });

    const [movedResult, markedResult] = [await check(moved), await check(marked)];

    expect(movedResult.code).toBe(0);
    expect(movedResult.stdout).toContain("template sync v1.0.0 -> v1.1.0: 1 owned file(s) may change");
    expect(markedResult.code).toBe(0);
    expect(markedResult.stdout).toContain("template sync (.template-sync changed)");
  });

  it("prints the contract for the sync workflow, with no Copier in it", async () => {
    const repository = await repositoryWith(ACME);

    const result = await check(repository, ["--contract"]);

    expect(result.stdout).toBe(
      "contract=present\nself=false\nsource_name=Acme app template\nsource_url=https://github.com/acme/app-template\n" +
        "source_web=https://github.com/acme/app-template\nversion=v1.0.0\nupdate=./scripts/pull-template.sh\n",
    );
  });

  it("treats the template repository itself as the owner of its paths", async () => {
    const repository = await repositoryWith(ACME);
    await git(repository, ["remote", "add", "origin", "git@github.com:acme/app-template.git"]);
    await change(repository, { [ACME_FILE]: "export const theme = 'next';\n" });

    const result = await check(repository);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("this repository is Acme app template, the source of its own owned paths");
    expect((await check(repository, ["--contract"])).stdout).toContain("self=true\n");
  });
});

describe("check-platform-conformance --compare", { timeout: 20_000 }, () => {
  it("passes when every owned file equals source.url at the recorded version", async () => {
    const { repository } = await adoptedFromTemplate({});

    const result = await check(repository, ["--compare"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("✓ owned files match the template");
  });

  it("fails an owned file that differs from the template or is missing, and no app file", async () => {
    const { repository } = await adoptedFromTemplate({ [ACME_FILE]: "export const theme = 'drifted';\n" });
    await git(repository, ["rm", "--quiet", "src/platform/ui/button.ts"]);
    await git(repository, ["commit", "--quiet", "--message", "drop"]);

    const result = await check(repository, ["--compare"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${ACME_FILE}: differs from Acme app template at v1.0.0; change it in Acme app template`);
    expect(result.stderr).toContain("src/platform/ui/button.ts: is missing; Acme app template at v1.0.0 has it");
    expect(result.stderr).not.toContain("main.ts");
  });

  it("allows a difference an unexpired exception covers, and fails it once the exception expired", async () => {
    const drifted = { [ACME_FILE]: "export const theme = 'ours';\n" };
    const live = await adoptedFromTemplate({ ...drifted, ".platform/exceptions.yml": exception(ACME_FILE, "2999-12-31") });
    const expired = await adoptedFromTemplate({ ...drifted, ".platform/exceptions.yml": exception(ACME_FILE, "2000-01-01") });

    const [liveResult, expiredResult] = [await check(live.repository, ["--compare"]), await check(expired.repository, ["--compare"])];

    expect(liveResult.code).toBe(0);
    expect(liveResult.stdout).toContain(`${ACME_FILE}: differs from Acme app template at v1.0.0, allowed by the exception until 2999-12-31`);
    expect(expiredResult.code).toBe(1);
    expect(expiredResult.stderr).toContain(`the exception for ${ACME_FILE} expired on 2000-01-01`);
    expect(expiredResult.stderr).toContain(`${ACME_FILE}: differs from Acme app template at v1.0.0; change it`);
  });

  it("says so, and still runs the other checks, when the template cannot be read", async () => {
    const { repository, template } = await adoptedFromTemplate({ ".platform/exceptions.yml": exception(ACME_FILE, "2000-01-01") });
    await rm(template, { force: true, recursive: true });

    const result = await check(repository, ["--compare"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/cannot read .+ at v1\.0\.0 \(.+\); owned files were not compared with the source/);
    expect(result.stderr).toContain(`the exception for ${ACME_FILE} expired on 2000-01-01`);
  });

  it("never claims the files match when the template was not read, and fails on it with --require-source", async () => {
    const { repository, template } = await adoptedFromTemplate({});
    await rm(template, { force: true, recursive: true });

    const lenient = await check(repository, ["--compare"]);
    expect(lenient.code).toBe(0);
    expect(lenient.stdout).toContain("not compared with the template");
    expect(lenient.stdout).not.toContain("owned files match the template");

    const strict = await check(repository, ["--compare", "--require-source"]);
    expect(strict.code).toBe(1);
    expect(strict.stderr).toMatch(/cannot read .+ at v1\.0\.0 \(.+\); owned files were not compared with the source/);
  });
});

async function adoptedFromTemplate(files: Record<string, string>): Promise<{ repository: string; template: string }> {
  const template = await mkdtemp(join(tmpdir(), "workflows-template-"));
  temporaryDirectories.push(template);
  const url = pathToFileURL(template).href;
  await writeFiles(template, { ...TEMPLATE_FILES, ".platform/contract.yml": contract({}, url), "README.md": "# Acme app template\n" });
  await git(template, ["init", "--quiet", "--initial-branch=main"]);
  await git(template, ["add", "--all"]);
  await git(template, ["commit", "--quiet", "--message", "template"]);
  await git(template, ["tag", "--annotate", "--message", "v1.0.0", "v1.0.0"]);
  const repository = await repositoryWith({ ...ACME, ...TEMPLATE_FILES, ".platform/contract.yml": contract({}, url), ...files });
  return { repository, template };
}

async function repositoryWith(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "workflows-conformance-"));
  temporaryDirectories.push(directory);
  await writeFiles(directory, files);
  await mkdir(join(directory, "scripts"), { recursive: true });
  await copyFile(SCRIPT, join(directory, "scripts", "check-platform-conformance.mjs"));
  await git(directory, ["init", "--quiet", "--initial-branch=main"]);
  await git(directory, ["add", "--all"]);
  await git(directory, ["commit", "--quiet", "--message", "base"]);
  await git(directory, ["switch", "--quiet", "--create", "feature"]);
  return directory;
}

async function change(directory: string, files: Record<string, string>): Promise<void> {
  await writeFiles(directory, files);
  await git(directory, ["add", "--all"]);
  await git(directory, ["commit", "--quiet", "--message", "change"]);
}

async function writeFiles(directory: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(directory, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

async function git(directory: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", ["-c", "core.autocrlf=false", ...args], { cwd: directory, env: { ...process.env, ...GIT_IDENTITY }, windowsHide: true });
}

async function check(directory: string, args: readonly string[] = ["--base", "main"]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", ["scripts/check-platform-conformance.mjs", ...args], { cwd: directory, windowsHide: true });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}
