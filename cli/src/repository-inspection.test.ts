import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectRepository, resolveVisibility, type CommandRunner } from "./repository-inspection.js";
import { run } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("repository inspection", () => {
  it("finds agent workflows and supported stack markers", async () => {
    const repositoryPath = await createRepository({
      ".github/workflows/agent-refine.md": "# Refine",
      ".github/workflows/agent-custom.md": "# Custom",
      ".github/workflows/other.md": "# Other",
      "package.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'",
      "apps/api/Contoso.slnx": "<Solution />",
      "openspec/changes/.gitkeep": "",
    });

    await expect(inspectRepository(repositoryPath)).resolves.toMatchObject({
      existingAgentWorkflows: ["agent-custom.md", "agent-refine.md"],
      stackHints: {
        packageJson: true,
        pnpmLockfile: true,
        solutionFiles: [join("apps", "api", "Contoso.slnx")],
        openSpec: true,
      },
    });
  });

  it("uses an explicit visibility before environment or GitHub", async () => {
    const runner: CommandRunner = { run: async () => '{"visibility":"public"}' };
    await expect(resolveVisibility("repo", "private", { PLATFORM_WORKFLOWS_VISIBILITY: "public" }, runner)).resolves.toEqual({
      value: "private",
      source: "argument",
    });
  });

  it("falls back to private when GitHub CLI is unavailable", async () => {
    const runner: CommandRunner = { run: async () => Promise.reject(new Error("missing gh")) };
    await expect(resolveVisibility("repo", undefined, {}, runner)).resolves.toEqual({ value: "private", source: "fallback" });
  });
});

describe("CLI commands", () => {
  it("keeps init available without writing configuration", async () => {
    const repositoryPath = await createRepository({ "package.json": "{}" });
    const output = captureConsole("log");

    await expect(run(["init", "--visibility", "public"], repositoryPath)).resolves.toBe(0);
    expect(output.calls).toHaveLength(1);
    await expect(import("node:fs/promises").then(({ access }) => access(join(repositoryPath, ".github/workflows/shared/repo-config.md")))).rejects.toThrow();
    output.restore();
  });

  it("accepts update as an add alias", async () => {
    const repositoryPath = await createRepository({});
    const error = captureConsole("error");

    await expect(run(["update", "--invalid"], repositoryPath)).resolves.toBe(1);
    expect(error.calls).toEqual(["Unknown option: --invalid"]);
    error.restore();
  });
});

function captureConsole(method: "error" | "log"): { readonly calls: string[]; readonly restore: () => void } {
  const original = console[method];
  const calls: string[] = [];
  console[method] = (message: string) => calls.push(message);
  return { calls, restore: () => { console[method] = original; } };
}

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
