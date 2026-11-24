// Where a repository keeps its api and web projects. The platform family assumes `apps/api` and
// `apps/web`; a repository wrapping an existing product often has another layout (`api/` and `app/`,
// or a .NET solution at the root). The CI templates already name the roots in their `env:` as
// `API_WORKING_DIRECTORY` and `WEB_DIRECTORY`, and the gate scripts read those at run time. What
// cannot read an environment variable (jscpd, Knip, size-limit and Semgrep config, a worker's glob)
// is rendered from the layout here, when the installer writes it.
//
// The layout is resolved per root, first match wins:
//   1. the `--api-dir` / `--web-dir` option (or the interactive answer);
//   2. the value the installed workflows declare in their top-level `env:`, so `update` renders the
//      same files again without being told;
//   3. a project folder found in the repository;
//   4. the platform default, with a warning when that folder does not exist either.
// Two workflows that disagree, or two candidate folders, make the root ambiguous: the installer
// stops rather than guess, when it has a layout-bound file to write.
import { constants } from "node:fs";
import { access, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProjectLayout {
  readonly api: string;
  readonly web: string;
}

export type LayoutRoot = keyof ProjectLayout;
export type LayoutSource = "option" | "workflows" | "detected" | "default";

export const DEFAULT_LAYOUT: ProjectLayout = { api: "apps/api", web: "apps/web" };

/** The workflow `env:` key that holds each root, shared with the CI templates and the gate scripts. */
export const LAYOUT_ENV: Readonly<Record<LayoutRoot, string>> = {
  api: "API_WORKING_DIRECTORY",
  web: "WEB_DIRECTORY",
};

const OPTION: Readonly<Record<LayoutRoot, string>> = { api: "--api-dir", web: "--web-dir" };
const ROOTS: readonly LayoutRoot[] = ["api", "web"];

// Folders tried, in order, when neither an option nor a workflow names a root. An api root counts
// when the folder exists; a web root only when it holds a package.json, so a Next.js `app/` router
// directory at the repository root is not mistaken for a web project.
const CANDIDATES: Readonly<Record<LayoutRoot, readonly string[]>> = {
  api: ["apps/api", "api", "backend", "server", "src/api"],
  web: ["apps/web", "web", "app", "frontend", "client"],
};

export interface ResolvedLayout {
  readonly layout: ProjectLayout;
  readonly sources: Readonly<Record<LayoutRoot, LayoutSource>>;
  /** Problems worth a person's attention that do not stop the install. */
  readonly warnings: readonly string[];
  /** Why a root could not be decided. Fatal only when a layout-bound file is about to be written. */
  readonly errors: readonly string[];
}

/**
 * Normalises a root as a person or a workflow writes it: forward slashes, no leading `./`, no
 * trailing slash. `.` is the repository root. Returns undefined for a value that is not a relative
 * path inside the repository.
 */
export function normalizeRoot(value: string): string | undefined {
  let root = value.trim().replace(/^(["'])(.*)\1$/, "$2").trim().replaceAll("\\", "/");
  if (root === "" || root.startsWith("/") || /^[A-Za-z]:/.test(root)) return undefined;
  while (root.startsWith("./")) root = root.slice(2);
  root = root.replace(/\/+$/, "");
  if (root === "" || root === ".") return ".";
  if (root.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) return undefined;
  if (/[\s"'`$*?[\]{}]/.test(root)) return undefined;
  return root;
}

export function isDefaultLayout(layout: ProjectLayout): boolean {
  return layout.api === DEFAULT_LAYOUT.api && layout.web === DEFAULT_LAYOUT.web;
}

export function layoutOption(root: LayoutRoot): string {
  return OPTION[root];
}

interface DeclaredRoot {
  readonly value: string;
  readonly file: string;
}

/**
 * The roots the installed workflows declare in their top-level `env:`. An empty value (the mutation
 * workflow's "no web scope") and an expression are not a layout, so they are ignored.
 */
export async function readWorkflowLayout(repositoryPath: string): Promise<Record<LayoutRoot, DeclaredRoot[]>> {
  const declared: Record<LayoutRoot, DeclaredRoot[]> = { api: [], web: [] };
  for (const file of await workflowFiles(repositoryPath)) {
    const text = await readFile(join(repositoryPath, file), "utf8");
    for (const root of ROOTS) {
      const raw = topLevelEnv(text).get(LAYOUT_ENV[root]);
      if (raw === undefined || raw.includes("${{")) continue;
      const value = normalizeRoot(raw);
      if (value !== undefined) declared[root].push({ value, file });
    }
  }
  return declared;
}

export async function resolveLayout(
  repositoryPath: string,
  requested: Partial<ProjectLayout> = {},
): Promise<ResolvedLayout> {
  const declared = await readWorkflowLayout(repositoryPath);
  const layout: Record<LayoutRoot, string> = { ...DEFAULT_LAYOUT };
  const sources: Record<LayoutRoot, LayoutSource> = { api: "default", web: "default" };
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const root of ROOTS) {
    const asked = requested[root];
    const values = [...new Set(declared[root].map((entry) => entry.value))];
    if (asked !== undefined) {
      layout[root] = asked;
      sources[root] = "option";
    } else if (values.length > 1) {
      const where = declared[root].map((entry) => `${entry.file} (${entry.value})`).join(", ");
      errors.push(`${LAYOUT_ENV[root]} differs between installed workflows: ${where}. Make them agree, or pass ${OPTION[root]} <path>.`);
    } else if (values.length === 1) {
      layout[root] = values[0]!;
      sources[root] = "workflows";
    } else {
      const found = await detectRoot(repositoryPath, root);
      if (found.includes(DEFAULT_LAYOUT[root])) {
        sources[root] = "default";
      } else if (found.length === 1) {
        layout[root] = found[0]!;
        sources[root] = "detected";
      } else if (found.length > 1) {
        errors.push(`Cannot tell where the ${root} project lives: ${found.join(", ")} all look like one. Pass ${OPTION[root]} <path>.`);
      }
    }
    if (!await rootExists(repositoryPath, layout[root])) {
      warnings.push(`The ${root} project root ${layout[root]} does not exist; tools configured for it will scan nothing. Pass ${OPTION[root]} <path> if it lives elsewhere.`);
    }
  }

  return { layout, sources, warnings, errors };
}

/** The candidate folders for a root that are present in the repository, in priority order. */
export async function detectRoot(repositoryPath: string, root: LayoutRoot): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of CANDIDATES[root]) {
    const probe = root === "web" ? join(repositoryPath, candidate, "package.json") : join(repositoryPath, candidate);
    if (await present(probe)) found.push(candidate);
  }
  return found;
}

/**
 * Rewrites the default roots in a layout-bound file. With the default layout the text is returned
 * as it is, so a repository on `apps/api` and `apps/web` gets byte-identical files.
 */
export function renderLayout(text: string, layout: ProjectLayout): string {
  if (isDefaultLayout(layout)) return text;
  // Semgrep's `paths.include: "/apps/"` scopes a rule to product code: one anchored entry per root.
  // A root at the repository root has no folder to anchor on, so the rule then covers every path
  // its excludes leave.
  const roots = [...new Set([layout.api, layout.web])];
  const includes = roots.includes(".") ? ["*"] : roots.map((root) => `/${root}/`);
  const scoped = text.replace(/^([ \t]*)- "\/apps\/"[ \t]*$/gm, (_line, indent: string) =>
    includes.map((include) => `${indent}- "${include}"`).join("\n"));
  return scoped.replace(/apps\/(api|web)(?![\w-])(\/?)/g, (_match, root: LayoutRoot, slash: string) => {
    const value = layout[root];
    if (value === ".") return slash === "" ? "." : "";
    return `${value}${slash}`;
  });
}

/** Renders the roots inside one `env:` value of a worker (MOCKUP_PATHS), leaving the rest of the file alone. */
export function renderWorkerLayout(text: string, layout: ProjectLayout): string {
  if (isDefaultLayout(layout)) return text;
  return text.replace(/^( {2}MOCKUP_PATHS: *)(.*)$/m, (_line, key: string, value: string) => `${key}${renderLayout(value, layout)}`);
}

/**
 * Writes the layout into the top-level `env:` of every installed workflow that declares a root
 * with another value, so the next `update` reads the same layout back. Returns the files changed.
 */
export async function persistLayout(
  repositoryPath: string,
  layout: ProjectLayout,
  roots: readonly LayoutRoot[],
  dryRun = false,
): Promise<string[]> {
  if (roots.length === 0) return [];
  const changed: string[] = [];
  for (const file of await workflowFiles(repositoryPath)) {
    const path = join(repositoryPath, file);
    const original = await readFile(path, "utf8");
    let text = original;
    for (const root of roots) text = setTopLevelEnv(text, LAYOUT_ENV[root], layout[root]);
    if (text !== original) {
      changed.push(file);
      if (!dryRun) await writeFile(path, text, "utf8");
    }
  }
  return changed;
}

// The `KEY: value` pairs of a workflow's top-level `env:` block (two-space indent, comments dropped).
function topLevelEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  const range = topLevelEnvRange(text.split(/\r?\n/));
  if (range === undefined) return values;
  const lines = text.split(/\r?\n/).slice(range.start, range.end);
  for (const line of lines) {
    const match = /^ {2}([A-Z][A-Z0-9_]*): *(.*?)$/.exec(line);
    if (match === null) continue;
    values.set(match[1]!, stripComment(match[2]!));
  }
  return values;
}

function setTopLevelEnv(text: string, key: string, value: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const range = topLevelEnvRange(lines);
  if (range === undefined) return text;
  for (let index = range.start; index < range.end; index++) {
    const match = new RegExp(`^( {2}${key}: *)(.*?)$`).exec(lines[index]!);
    if (match === null) continue;
    const current = stripComment(match[2]!);
    if (current.includes("${{") || current.replace(/^(["'])(.*)\1$/, "$2") === "") return text;
    if (normalizeRoot(current) === value) return text;
    const comment = /\s+#.*$/.exec(match[2]!)?.[0] ?? "";
    lines[index] = `${match[1]}${value === "." ? '"."' : value}${comment}`;
    return lines.join(eol);
  }
  return text;
}

function topLevelEnvRange(lines: readonly string[]): { start: number; end: number } | undefined {
  const header = lines.findIndex((line) => /^env:\s*(#.*)?$/.test(line));
  if (header === -1) return undefined;
  let end = header + 1;
  while (end < lines.length && (lines[end] === "" || /^\s/.test(lines[end]!))) end++;
  return { start: header + 1, end };
}

function stripComment(value: string): string {
  const quoted = /^(["'])(.*?)\1/.exec(value);
  if (quoted !== null) return quoted[0];
  return value.replace(/\s+#.*$/, "").trim();
}

async function workflowFiles(repositoryPath: string): Promise<string[]> {
  const directory = join(repositoryPath, ".github", "workflows");
  try {
    return (await readdir(directory))
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
      .map((name) => `.github/workflows/${name}`);
  } catch {
    return [];
  }
}

async function rootExists(repositoryPath: string, root: string): Promise<boolean> {
  if (root === ".") return true;
  try {
    return (await stat(join(repositoryPath, root))).isDirectory();
  } catch {
    return false;
  }
}

async function present(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
