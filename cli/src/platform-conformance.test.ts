import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

describe("check-platform-conformance", () => {
  it("passes silently in a repository that never adopted the template", async () => {
    const repository = await repositoryWith({ [PLATFORM_FILE]: "namespace Platform.Audit;\n" });
    await change(repository, { [PLATFORM_FILE]: "namespace Platform.Audit; // edited\n" });

    const result = await check(repository);

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
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
    expect(result.stderr).toContain(`${PLATFORM_FILE}: platform file changed outside a template sync`);
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
    expect(result.stderr).toContain(`${PLATFORM_FILE}: platform file changed outside a template sync`);
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
