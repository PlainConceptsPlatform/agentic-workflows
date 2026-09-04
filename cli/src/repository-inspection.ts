import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export type RepositoryVisibility = "public" | "private";
export type VisibilitySource = "argument" | "environment" | "github" | "fallback";

export interface StackHints {
  readonly packageJson: boolean;
  readonly pnpmLockfile: boolean;
  readonly solutionFiles: readonly string[];
  readonly openSpec: boolean;
}

export interface RepositoryInspection {
  readonly repositoryPath: string;
  readonly existingAgentWorkflows: readonly string[];
  readonly stackHints: StackHints;
}

export interface VisibilityResolution {
  readonly value: RepositoryVisibility;
  readonly source: VisibilitySource;
}

export interface CommandRunner {
  readonly run: (command: string, arguments_: readonly string[], cwd: string) => Promise<string>;
}

const defaultCommandRunner: CommandRunner = {
  async run(command, arguments_, cwd) {
    const { stdout } = await execFileAsync(command, arguments_, { cwd, windowsHide: true });
    return stdout;
  },
};

export async function inspectRepository(repositoryPath: string): Promise<RepositoryInspection> {
  const workflowsPath = join(repositoryPath, ".github", "workflows");
  const workflowEntries = await readDirectoryNames(workflowsPath);
  const solutionFiles = await findSolutionFiles(repositoryPath);

  return {
    repositoryPath,
    existingAgentWorkflows: workflowEntries.filter((entry) => /^agent-.*\.md$/i.test(entry)).sort(),
    stackHints: {
      packageJson: await pathExists(join(repositoryPath, "package.json")),
      pnpmLockfile: await pathExists(join(repositoryPath, "pnpm-lock.yaml")),
      solutionFiles,
      openSpec: await isDirectory(join(repositoryPath, "openspec")),
    },
  };
}

export async function resolveVisibility(
  repositoryPath: string,
  override: RepositoryVisibility | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  commandRunner: CommandRunner = defaultCommandRunner,
): Promise<VisibilityResolution> {
  if (override !== undefined) return { value: override, source: "argument" };

  const environmentOverride = parseVisibility(environment.PLATFORM_WORKFLOWS_VISIBILITY);
  if (environmentOverride !== undefined) return { value: environmentOverride, source: "environment" };

  try {
    const output = await commandRunner.run("gh", ["repo", "view", "--json", "visibility"], repositoryPath);
    const visibility = parseVisibilityFromGitHub(output);
    if (visibility !== undefined) return { value: visibility, source: "github" };
  } catch {
    // GitHub CLI is optional. Initializing a local repository must still work offline.
  }

  return { value: "private", source: "fallback" };
}

export function parseVisibility(value: string | undefined): RepositoryVisibility | undefined {
  return value === "public" || value === "private" ? value : undefined;
}

async function findSolutionFiles(repositoryPath: string): Promise<string[]> {
  const results: string[] = [];
  await scanForSlnx(repositoryPath, "", results, 0);
  return results.sort();
}

const MAX_DEPTH = 5;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "out", "build", ".turbo", ".cache"]);

async function scanForSlnx(root: string, relativePath: string, results: string[], depth: number): Promise<void> {
  if (depth >= MAX_DEPTH) return;
  const currentPath = join(root, relativePath);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await scanForSlnx(root, join(relativePath, entry.name), results, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".slnx")) {
      results.push(relativePath === "" ? entry.name : join(relativePath, entry.name));
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readDirectoryNames(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

function parseVisibilityFromGitHub(output: string): RepositoryVisibility | undefined {
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed !== "object" || parsed === null || !("visibility" in parsed)) return undefined;
    const { visibility } = parsed;
    return typeof visibility === "string" ? parseVisibility(visibility.toLowerCase()) : undefined;
  } catch {
    return undefined;
  }
}
