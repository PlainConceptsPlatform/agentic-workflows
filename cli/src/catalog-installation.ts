import { execFile } from "node:child_process";
import { access, copyFile, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

import { catalogTemplates, mandatoryFiles, routeNames, templateNames, workflowRoutes, type RouteName, type TemplateName } from "./workflow-catalog.js";
import { processRoutes, excludedWorkerFiles } from "./route-processing.js";
import { generateOpencodeCi, generateOpencodeConfig, generateStackDefaults, injectStackEnv } from "./stack-defaults.js";
import { mergeRouter, mergeWorker, mirrorRouterLiterals } from "./worker-env.js";
import { fetchBaseline, hasOwnershipHeader, installedVersion, packageVersion, stampVersion, type BaselineFetcher } from "./package-baseline.js";
import type { RepositoryInspection } from "./repository-inspection.js";

const execFileAsync = promisify(execFile);

export type ChangeStatus = "added" | "updated" | "unchanged" | "skipped" | "removed";

export interface FileChange {
  readonly target: string;
  readonly status: ChangeStatus;
  /** Why a file was skipped. */
  readonly reason?: string;
  /** Version the consumer's copy was installed from, when its header records one. */
  readonly installedVersion?: string;
  readonly keptEnv?: readonly string[];
  readonly updatedDefaults?: readonly string[];
  readonly consumerOnlyEnv?: readonly string[];
  readonly droppedEnv?: readonly string[];
}

export interface BaselineStatus {
  readonly version: string;
  readonly status: "used" | "unavailable";
}

export interface CatalogInstallResult {
  /** Every package-managed target in the installed set, whether it changed or not. */
  readonly installed: readonly string[];
  /** Consumer-owned files that differ and were not overwritten. Only templates report these. */
  readonly conflicts: readonly string[];
  readonly changes: readonly FileChange[];
  readonly packageVersion: string;
  /** Versions found in the consumer's ownership headers before this run. */
  readonly installedVersions: readonly string[];
  readonly baselines: readonly BaselineStatus[];
  readonly upToDate: boolean;
  readonly dryRun: boolean;
}

export interface CatalogInstallOptions {
  /** Also overwrite files whose ownership header was removed, and changed templates. */
  readonly force?: boolean;
  readonly sourcePath?: string;
  readonly selectedRoutes?: readonly RouteName[];
  readonly inspection?: RepositoryInspection;
  readonly compile?: (repositoryPath: string) => Promise<void>;
  /** Compute the plan and write nothing. */
  readonly dryRun?: boolean;
  /** Where the baseline release comes from. Defaults to npm. */
  readonly baseline?: BaselineFetcher;
  /** The version stamped into headers. Defaults to this package's. */
  readonly packageVersion?: string;
}

interface CatalogFile {
  readonly source: string;
  readonly target: string;
  readonly managed: boolean;
}

const sourceMappings = [
  ["actions", ".github/actions"],
  ["workflows", ".github/workflows"],
  ["scripts", "scripts"],
] as const;

export function mandatoryFileSpecs(sourcePath: string): CatalogFile[] {
  return mandatoryFiles.map((spec) => ({
    source: join(sourcePath, spec.source),
    target: spec.target,
    managed: true,
  }));
}

export function catalogSourcePath(modulePath = fileURLToPath(import.meta.url)): string {
  return resolve(dirname(modulePath), "..", "loops");
}

/**
 * Where `gh aw` writes the pinned-action lock, and the only place it should be named.
 * `generatedConsumerTargets` in the catalog declares the same path; two literals is how the
 * pre-commit hook ended up guarding one that exists nowhere.
 */
const ACTIONS_LOCK = ".github/aw/actions-lock.json";

const isWorker = (target: string): boolean => target.startsWith(".github/workflows/agent-") && target.endsWith(".md");
const isRouter = (target: string): boolean => target === ".github/workflows/work-router.yml";
const carriesHeader = (target: string): boolean => /\.(ya?ml|md|sh|mjs|cjs)$/.test(target);
const normalizeEol = (text: string): string => text.replaceAll("\r\n", "\n");

export async function installCatalog(
  repositoryPath: string,
  options: CatalogInstallOptions = {},
): Promise<CatalogInstallResult> {
  const version = options.packageVersion ?? await packageVersion();
  const sourcePath = options.sourcePath ?? catalogSourcePath();
  const selectedRoutes = options.selectedRoutes ?? routeNames;
  const allFiles = [...await catalogFiles(sourcePath), ...mandatoryFileSpecs(sourcePath)];
  const deduplicated = allFiles.filter((file, index) =>
    allFiles.findIndex((f) => f.target === file.target) === index,
  ).sort((left, right) => left.target.localeCompare(right.target));

  const excluded = excludedWorkerFiles(selectedRoutes);
  const filtered = deduplicated.filter((file) => !excluded.has(file.target.split("/").pop() ?? ""));

  const packageContents = new Map<string, string>();
  for (const file of filtered) {
    packageContents.set(file.target, normalizeEol(await readFile(file.source, "utf8")));
  }
  let processed = processRoutes(packageContents, selectedRoutes);

  // Read and write LF, always. Every one of these files ends up on a Linux runner, the package
  // and every consumer declare `* text=auto eol=lf`, and a shell script with CRLF fails on its
  // shebang. Preserving whatever a file happened to have instead only carried legacy CRLF
  // forward, which git then reported as needing normalisation on every later commit.
  const existing = new Map<string, string>();
  for (const target of processed.keys()) {
    const path = join(repositoryPath, target);
    if (!await exists(path)) continue;
    existing.set(target, normalizeEol(await readFile(path, "utf8")));
  }

  if (options.inspection !== undefined) {
    processed = applyStackDefaults(processed, options.inspection, existing);
  }

  const fetcher = options.baseline ?? fetchBaseline;
  const baselineDirectories = new Map<string, Promise<string | undefined>>();
  const baselineFor = (installed: string): Promise<string | undefined> => {
    let pending = baselineDirectories.get(installed);
    if (pending === undefined) {
      pending = fetcher(installed);
      baselineDirectories.set(installed, pending);
    }
    return pending;
  };

  const changes: FileChange[] = [];
  const updates: ContentUpdate[] = [];
  const installedVersions = new Set<string>();

  for (const [target, packageText] of processed) {
    const current = existing.get(target);
    let text = packageText;
    let change: FileChange = { target, status: "added" };

    if (current !== undefined) {
      const recorded = carriesHeader(target) ? installedVersion(current) : undefined;
      if (recorded !== undefined) installedVersions.add(recorded);

      if (isWorker(target) || isRouter(target)) {
        const baselineText = recorded === undefined ? undefined : await baselineSource(await baselineFor(recorded), target);
        const merge = isRouter(target) ? mergeRouter : mergeWorker;
        const merged = merge(packageText, current, baselineText);
        text = merged.content;
        change = {
          target,
          status: "updated",
          ...(recorded === undefined ? {} : { installedVersion: recorded }),
          ...(merged.report.keptEnv.length > 0 ? { keptEnv: merged.report.keptEnv } : {}),
          ...(merged.report.updatedDefaults.length > 0 ? { updatedDefaults: merged.report.updatedDefaults } : {}),
          ...(merged.report.consumerOnlyEnv.length > 0 ? { consumerOnlyEnv: merged.report.consumerOnlyEnv } : {}),
          ...(merged.report.droppedEnv.length > 0 ? { droppedEnv: merged.report.droppedEnv } : {}),
        };
      } else {
        change = { target, status: "updated", ...(recorded === undefined ? {} : { installedVersion: recorded }) };
      }
    }

    text = stampVersion(text, version);

    if (current !== undefined && text === current) {
      change = { ...change, status: "unchanged" };
    } else if (current !== undefined && carriesHeader(target) && !hasOwnershipHeader(current) && !options.force) {
      // Removing the ownership header is how a consumer takes a file over.
      change = { target, status: "skipped", reason: "consumer-owned: the ownership header was removed; pass --force to reclaim it" };
    } else {
      updates.push({ target, content: text });
    }
    changes.push(change);
  }

  const removals = await orphanedManagedFiles(repositoryPath, new Set(processed.keys()));
  for (const target of removals) changes.push({ target, status: "removed" });

  const baselines: BaselineStatus[] = [];
  for (const [requested, pending] of baselineDirectories) {
    baselines.push({ version: requested, status: (await pending) === undefined ? "unavailable" : "used" });
  }

  const result: CatalogInstallResult = {
    installed: [...processed.keys()].sort(),
    conflicts: [],
    changes,
    packageVersion: version,
    installedVersions: [...installedVersions].sort(),
    baselines,
    upToDate: updates.length === 0 && removals.length === 0,
    dryRun: options.dryRun ?? false,
  };

  if (options.dryRun) return result;

  // Deletions go first: a pruned action must be gone before the compile reads the tree, or a
  // worker still referencing it would compile against a file that is about to disappear.
  await removeFiles(repositoryPath, removals);

  if (updates.length > 0) {
    const stagedLocks = await validateStagedCatalog(repositoryPath, updates, options.compile);
    await applyTransaction(repositoryPath, [...updates, ...stagedLocks, await preCommitHookUpdate(repositoryPath)]);
  } else {
    await applyTransaction(repositoryPath, [await preCommitHookUpdate(repositoryPath)]);
  }

  return result;
}

// Stack defaults are derived from the repository, not chosen by a person, so the derived files
// (the shared CI setup and the OpenCode config) get them on every run and stay stable. A worker
// gets its VERIFY_COMMANDS default once, when it is first installed: after that the value is the
// consumer's, and the env merge keeps it.
function applyStackDefaults(
  files: Map<string, string>,
  inspection: RepositoryInspection,
  existing: ReadonlyMap<string, unknown>,
): Map<string, string> {
  const defaults = generateStackDefaults(inspection);
  const result = new Map(files);
  for (const [target, content] of result) {
    if (isWorker(target) && !existing.has(target)) {
      result.set(target, injectStackEnv(content, defaults));
    } else if (target.endsWith("opencode-ci.md")) {
      result.set(target, generateOpencodeCi(content, inspection));
    } else if (target === "opencode.ci.json") {
      result.set(target, generateOpencodeConfig(content, inspection));
    }
  }
  return result;
}

// Directories that belong wholly to the package. A file here that carries our ownership header
// and is no longer in the package was deleted upstream, and without this it would sit in every
// consumer forever: that is how `stale-recovery` and `update-changelog` outlived the code that
// called them. Deliberately not `.github/workflows/`, where a worker's absence means the route
// is not installed rather than gone, and never anything without a header, which is a fork.
const pruneRoots = [".github/actions", ".github/workflows/shared"] as const;

async function orphanedManagedFiles(repositoryPath: string, keep: ReadonlySet<string>): Promise<string[]> {
  const orphans: string[] = [];

  for (const root of pruneRoots) {
    const directory = join(repositoryPath, root);
    if (!await exists(directory)) continue;

    for (const file of await filesIn(directory)) {
      const target = `${root}/${file.replaceAll("\\", "/")}`;
      if (keep.has(target)) continue;
      if (!carriesHeader(target) && !target.endsWith(".cjs") && !target.endsWith(".js")) continue;
      const content = await readFile(join(directory, file), "utf8");
      if (hasOwnershipHeader(content)) orphans.push(target);
    }
  }

  return orphans.sort();
}

async function removeFiles(repositoryPath: string, targets: readonly string[]): Promise<void> {
  for (const target of targets) {
    await rm(join(repositoryPath, target), { force: true });
    // An action is a directory with one manifest in it; leaving the empty shell behind is litter.
    const directory = dirname(join(repositoryPath, target));
    try {
      if ((await readdir(directory)).length === 0) await rm(directory, { recursive: true, force: true });
    } catch {
      // the directory is gone or not empty, either of which is fine
    }
  }
}

async function baselineSource(loops: string | undefined, target: string): Promise<string | undefined> {
  if (loops === undefined) return undefined;
  const path = join(loops, "workflows", target.slice(".github/workflows/".length));
  if (!await exists(path)) return undefined;
  return normalizeEol(await readFile(path, "utf8"));
}

// Templates that need a companion config beside the workflow file. actionlint only
// knows GitHub-hosted runner labels, so every workflow naming a self-hosted label is an
// error without this file; it belongs wherever the lint workflow that reads it lives.
const templateCompanions: Partial<Record<TemplateName, readonly { source: string; target: string }[]>> = {
  "agentics-checks": [{ source: "templates/agentics/actionlint.yaml", target: ".github/actionlint.yaml" }],
};

export interface TemplateInstallResult {
  readonly installed: readonly string[];
  readonly conflicts: readonly string[];
}

export async function installTemplate(
  repositoryPath: string,
  template: TemplateName,
  options: Pick<CatalogInstallOptions, "force" | "sourcePath" | "inspection"> = {},
): Promise<TemplateInstallResult> {
  const sourcePath = options.sourcePath ?? catalogSourcePath();
  const meta = catalogTemplateMeta(template);
  const source = join(sourcePath, "templates", meta.directory, meta.file);
  const target = meta.target;
  const companions = templateCompanions[template] ?? [];
  const destinations = [
    { source, target, companion: false as const },
    ...companions.map((companion) => ({
      source: join(sourcePath, companion.source),
      target: companion.target,
      companion: true as const,
    })),
  ];
  const conflicts = (
    await Promise.all(destinations.map(async (entry) =>
      await exists(join(repositoryPath, entry.target)) && await exists(entry.source) && !(await filesMatch(entry.source, join(repositoryPath, entry.target)))
        ? entry.target
        : undefined,
    ))
  ).filter((file): file is string => file !== undefined);

  if (conflicts.length > 0 && !options.force) return { installed: [], conflicts };

  for (const entry of destinations) {
    if (!(await exists(entry.source))) continue; // companion files may not exist for every template version
    const destination = join(repositoryPath, entry.target);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(entry.source, destination);
  }

  if (options.inspection !== undefined && template === "opencode.ci.json") {
    const baseContent = await readFile(source, "utf8");
    const transformed = generateOpencodeConfig(baseContent, options.inspection);
    await writeFile(join(repositoryPath, target), transformed, "utf8");
  }

  try {
    await runCompileIfAvailable(repositoryPath);
  } catch {
    // compile failure is non-fatal
  }

  return { installed: (await Promise.all(destinations.map(async (entry) => await exists(entry.source) ? entry.target : undefined))).filter((file): file is string => file !== undefined), conflicts };
}

export async function installedRoutes(repositoryPath: string): Promise<RouteName[]> {
  const found = await Promise.all(
    workflowRoutes.map(async (route): Promise<RouteName | undefined> =>
      (await exists(join(repositoryPath, ".github", "workflows", route.worker))) ? route.name : undefined,
    ),
  );
  return found.filter((name): name is RouteName => name !== undefined);
}

export async function removeRouteFiles(
  repositoryPath: string,
  routes: readonly RouteName[],
): Promise<string[]> {
  const workerByRoute = new Map(workflowRoutes.map((route) => [route.name, route.worker]));
  const removed: string[] = [];
  for (const route of routes) {
    const worker = workerByRoute.get(route);
    if (worker === undefined) continue;
    const lock = worker.replace(/\.md$/, ".lock.yml");
    for (const file of [worker, lock]) {
      const destination = join(repositoryPath, ".github", "workflows", file);
      if (await exists(destination)) {
        await rm(destination, { force: true });
        removed.push(`.github/workflows/${file}`);
      }
    }
  }
  return removed.sort();
}

export function isTemplateName(value: string): value is TemplateName {
  return templateNames.includes(value as TemplateName);
}

export async function ensurePreCommitHook(repositoryPath: string): Promise<void> {
  const update = await preCommitHookUpdate(repositoryPath);
  await applyTransaction(repositoryPath, [update]);
}

async function preCommitHookUpdate(repositoryPath: string): Promise<{ target: string; content: string }> {
  const target = ".husky/pre-commit";
  const hookPath = join(repositoryPath, target);
  const compileLine = "node scripts/compile-agent-workflows.mjs";
  const stageLine = "git add -- .github/workflows/*.lock.yml";
  // gh aw writes this at .github/aw/, which is what every consumer tracks and what
  // `generatedConsumerTargets` in the catalog declares. The line used to name
  // `.github/actions/actions-lock.json`, a path that exists nowhere, so `[ ! -f ... ]` was
  // always true, the `||` short-circuited, and the real lock was never staged: a compile that
  // bumped an action pin left the lock out of the commit and the tree dirty behind it. Nothing
  // failed, which is why it survived. Found by the first audit run in the dogfood repository.
  const actionLockLine = `[ ! -f ${ACTIONS_LOCK} ] || git add -- ${ACTIONS_LOCK}`;
  const managedLines = `if git diff --cached --name-only -- .github | grep -q .; then\n  ${compileLine}\n  ${stageLine}\n  ${actionLockLine}\nfi\n`;
  if (!await exists(hookPath)) {
    return { target, content: managedLines };
  }

  const content = (await readFile(hookPath, "utf8"))
    .replace("pnpm exec if git diff --cached --name-only -- .github | grep -q .; then", "if git diff --cached --name-only -- .github | grep -q .; then");
  if (content.includes("compile-agent-workflows")) {
    const legacyLines = `${compileLine}\n${stageLine}\n${actionLockLine}\n`;
    if (content.includes(managedLines)) return { target, content };
    if (content.includes(legacyLines)) return { target, content: content.replace(legacyLines, managedLines) };
    const suffix = content.endsWith("\n") || content === "" ? "" : "\n";
    return { target, content: `${content}${suffix}${managedLines}` };
  }

  return { target, content: content.endsWith("\n") || content === ""
    ? `${content}${managedLines}`
    : `${content}\n${managedLines}` };
}

export async function runCompileIfAvailable(repositoryPath: string): Promise<void> {
  const script = join(repositoryPath, "scripts", "compile-agent-workflows.mjs");
  if (await exists(script)) {
    await execFileAsync("node", [script, "--force"], { cwd: repositoryPath });
  }
}

interface ContentUpdate {
  readonly target: string;
  readonly content: string;
}

async function validateStagedCatalog(
  repositoryPath: string,
  updates: readonly ContentUpdate[],
  compileOverride: CatalogInstallOptions["compile"],
): Promise<ContentUpdate[]> {
  const temporaryRoot = join(repositoryPath, ".opencode", ".tmp");
  await mkdir(temporaryRoot, { recursive: true });
  const stagingPath = await mkdtemp(join(temporaryRoot, "workflows-"));

  try {
    await copyCompilationInputs(repositoryPath, stagingPath);
    await writeUpdates(stagingPath, updates);
    await initializeStagingRepository(stagingPath);

    const compiler = compileOverride ?? await packageCompiler(stagingPath);
    if (compiler === undefined) return [];
    await compiler(stagingPath);
    return await generatedFiles(stagingPath);
  } finally {
    await rm(stagingPath, { force: true, recursive: true });
  }
}

// The compile needs the workflows and the compile script. An update that changes neither still
// recompiles against the consumer's current copies, so both come along.
async function copyCompilationInputs(repositoryPath: string, stagingPath: string): Promise<void> {
  const githubPath = join(repositoryPath, ".github");
  if (await exists(githubPath)) await cp(githubPath, join(stagingPath, ".github"), { recursive: true });
  const script = join(repositoryPath, "scripts", "compile-agent-workflows.mjs");
  if (await exists(script)) {
    await mkdir(join(stagingPath, "scripts"), { recursive: true });
    await copyFile(script, join(stagingPath, "scripts", "compile-agent-workflows.mjs"));
  }
}

async function initializeStagingRepository(stagingPath: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet"], { cwd: stagingPath, windowsHide: true });
}

async function packageCompiler(repositoryPath: string): Promise<((path: string) => Promise<void>) | undefined> {
  const scriptPath = join(repositoryPath, "scripts", "compile-agent-workflows.mjs");
  if (!await exists(scriptPath)) return undefined;
  const content = await readFile(scriptPath, "utf8");
  return content.includes("gh aw compile") ? runCompileIfAvailable : undefined;
}

async function generatedFiles(repositoryPath: string): Promise<ContentUpdate[]> {
  const workflowPath = join(repositoryPath, ".github", "workflows");
  const updates: ContentUpdate[] = [];

  if (await exists(workflowPath)) {
    for (const file of await filesIn(workflowPath)) {
      if (!file.endsWith(".lock.yml")) continue;
      updates.push({ target: `.github/workflows/${file.replaceAll("\\", "/")}`, content: await readFile(join(workflowPath, file), "utf8") });
    }
  }

  const actionsLock = join(repositoryPath, ...ACTIONS_LOCK.split("/"));
  if (await exists(actionsLock)) {
    updates.push({ target: ACTIONS_LOCK, content: await readFile(actionsLock, "utf8") });
  }

  return updates.sort((left, right) => left.target.localeCompare(right.target));
}

interface CompositeStep {
  name?: string;
  id?: string;
  shell?: unknown;
  run?: unknown;
  env?: unknown;
  uses?: unknown;
  with?: unknown;
}

interface ActionManifest {
  runs?: { using?: string; steps?: CompositeStep[] };
}

function validateActionManifests(updates: readonly ContentUpdate[]): void {
  for (const { target, content } of updates) {
    if (!target.endsWith("action.yml")) continue;
    let manifest: ActionManifest;
    try {
      manifest = parseYaml(content) as ActionManifest;
    } catch {
      throw new Error(`${target}: invalid YAML — failed to parse action manifest`);
    }
    if (manifest?.runs?.using !== "composite") continue;
    const steps = manifest.runs?.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error(`${target}: composite action has no steps — file may be truncated`);
    }
    for (const [index, step] of steps.entries()) {
      const label = step.name ?? step.id ?? `step ${index}`;
      if (step.shell !== undefined && (typeof step.run !== "string" || step.run.trim() === "")) {
        throw new Error(`${target}: step "${label}" has shell: but no run: — manifest is invalid or truncated`);
      }
    }
  }
}

async function applyTransaction(repositoryPath: string, updates: readonly ContentUpdate[]): Promise<void> {
  const uniqueUpdates = [...new Map(updates.map((update) => [update.target, update])).values()];
  const rollback = await Promise.all(uniqueUpdates.map(async ({ target }) => {
    const path = join(repositoryPath, target);
    return { target, existed: await exists(path), content: await exists(path) ? await readFile(path, "utf8") : undefined };
  }));

  try {
    await writeUpdates(repositoryPath, uniqueUpdates);
    validateActionManifests(uniqueUpdates);
  } catch (error) {
    await Promise.all(rollback.map(async ({ target, existed, content }) => {
      if (existed && content !== undefined) {
        await writeUpdates(repositoryPath, [{ target, content }]);
      } else {
        await rm(join(repositoryPath, target), { force: true });
      }
    }));
    throw error;
  }
}

async function writeUpdates(repositoryPath: string, updates: readonly ContentUpdate[]): Promise<void> {
  await Promise.all(updates.map(async ({ target, content }) => {
    const destination = join(repositoryPath, target);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }));
}

function catalogTemplateMeta(template: TemplateName): { directory: string; file: string; target: string } {
  const entry = catalogTemplates.find((item) => item.name === template);
  if (entry === undefined) throw new Error(`Unknown template: ${template}`);
  // The directory is a field on the entry now. It used to be inferred from the name by a chain
  // of ternaries ending in "agentics", so a new template in any other directory installed the
  // wrong file or none at all, and the default hid it.
  const directory = entry.directory ?? (template.startsWith("opencode") ? "opencode" : template.startsWith("app-ci-") ? "ci" : template === "github-release" ? "release" : template === "bug-report" || template === "feature-request" ? "issues" : "agentics");
  const isWorkflow = entry.file.endsWith(".yml");
  const inferredTarget = template === "app-ci-dotnet-next"
    ? ".github/workflows/app-ci.yml"
    : isWorkflow ? `.github/workflows/${entry.file}` : entry.file;
  const target = entry.target ?? inferredTarget;
  return { directory, file: entry.file, target };
}

async function catalogFiles(sourcePath: string): Promise<CatalogFile[]> {
  const files: CatalogFile[] = [];

  for (const [sourceDirectory, targetDirectory] of sourceMappings) {
    if (!await exists(join(sourcePath, sourceDirectory))) continue;
    for (const file of await filesIn(join(sourcePath, sourceDirectory))) {
      if (isGeneratedFile(file)) continue;
      files.push({
        source: join(sourcePath, sourceDirectory, file),
        target: `${targetDirectory}/${file.replaceAll("\\", "/")}`,
        managed: true,
      });
    }
  }

  return files.sort((left, right) => left.target.localeCompare(right.target));
}

function isGeneratedFile(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  return normalized.endsWith(".lock.yml") || normalized.endsWith("actions-lock.json");
}

async function filesIn(path: string): Promise<string[]> {
  const entries = await readdir(path, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.parentPath === undefined ? entry.name : relative(path, join(entry.parentPath, entry.name)));
}

async function filesMatch(source: string, destination: string): Promise<boolean> {
  try {
    const [sourceContent, destinationContent] = await Promise.all([readFile(source), readFile(destination)]);
    return sourceContent.equals(destinationContent);
  } catch {
    return false;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
