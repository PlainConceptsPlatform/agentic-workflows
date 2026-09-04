import { execFile } from "node:child_process";
import { access, copyFile, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

import { catalogTemplates, mandatoryFiles, routeNames, templateNames, workflowRoutes, type CatalogTemplate, type RouteName, type TemplateName } from "./workflow-catalog.js";
import { processRoutes, excludedWorkerFiles } from "./route-processing.js";
import { generateOpencodeCi, generateOpencodeConfig, generateStackDefaults, injectStackEnv, type StackDefaults } from "./stack-defaults.js";
import type { RepositoryInspection } from "./repository-inspection.js";

const execFileAsync = promisify(execFile);

export interface CatalogInstallResult {
  readonly installed: readonly string[];
  readonly conflicts: readonly string[];
}

export interface CatalogInstallOptions {
  readonly force?: boolean;
  readonly sourcePath?: string;
  readonly selectedRoutes?: readonly RouteName[];
  readonly inspection?: RepositoryInspection;
  readonly compile?: (repositoryPath: string) => Promise<void>;
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

export async function installCatalog(
  repositoryPath: string,
  options: CatalogInstallOptions = {},
): Promise<CatalogInstallResult> {
  const sourcePath = options.sourcePath ?? catalogSourcePath();
  const selectedRoutes = options.selectedRoutes ?? routeNames;
  const allFiles = [...await catalogFiles(sourcePath), ...mandatoryFileSpecs(sourcePath)];
  const deduplicated = allFiles.filter((file, index) =>
    allFiles.findIndex((f) => f.target === file.target) === index,
  ).sort((left, right) => left.target.localeCompare(right.target));

  const excluded = excludedWorkerFiles(selectedRoutes);
  const filtered = deduplicated.filter((file) => {
    const fileName = file.target.split("/").pop() ?? "";
    return !excluded.has(fileName);
  });

  const fileContents = new Map<string, string>();
  for (const file of filtered) {
    fileContents.set(file.target, await readFile(file.source, "utf8"));
  }

  let processedContents = processRoutes(fileContents, selectedRoutes);

  if (options.inspection !== undefined) {
    const defaults = generateStackDefaults(options.inspection);
    processedContents = injectStackIntoWorkers(processedContents, defaults);
    processedContents = transformOpencodeFiles(processedContents, options.inspection);
  }

  processedContents = await preserveConsumerWorkerEnv(repositoryPath, processedContents);

  const updates = [...processedContents.entries()]
    .filter(([target]) => filtered.find((file) => file.target === target)?.managed ?? true)
    .map(([target, content]) => ({ target, content }));
  const conflicts = await conflictingTargets(repositoryPath, updates);
  if (conflicts.length > 0 && !options.force) return { installed: [], conflicts };

  const stagedLocks = await validateStagedCatalog(repositoryPath, updates, options.compile);
  await applyTransaction(repositoryPath, [...updates, ...stagedLocks, await preCommitHookUpdate(repositoryPath)]);

  return { installed: [...processedContents.keys()].sort(), conflicts };
}

function injectStackIntoWorkers(files: Map<string, string>, defaults: StackDefaults): Map<string, string> {
  const result = new Map(files);
  for (const [key, content] of result) {
    if (key.startsWith(".github/workflows/agent-") && key.endsWith(".md")) {
      result.set(key, injectStackEnv(content, defaults));
    }
  }
  return result;
}

async function preserveConsumerWorkerEnv(repositoryPath: string, files: Map<string, string>): Promise<Map<string, string>> {
  const result = new Map(files);
  for (const [target, content] of result) {
    if (!target.startsWith(".github/workflows/agent-") || !target.endsWith(".md")) continue;
    const existingPath = join(repositoryPath, target);
    if (!await exists(existingPath)) continue;
    result.set(target, mergeWorkerEnv(content, await readFile(existingPath, "utf8")));
  }
  return result;
}

function mergeWorkerEnv(packageContent: string, consumerContent: string): string {
  const consumerEnv = workerEnvValues(consumerContent);
  let result = packageContent.replace(/^  ([A-Z][A-Z0-9_]*): .+$/gm, (line, key: string) =>
    consumerEnv.has(key) ? `  ${key}: ${consumerEnv.get(key)}` : line);
  const endpoint = engineEndpoint(consumerContent);
  if (endpoint !== undefined) {
    result = result.replace(/^    OPENAI_BASE_URL: .+$/m, `    OPENAI_BASE_URL: ${endpoint}`);
  }
  return result;
}

function workerEnvValues(content: string): Map<string, string> {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(content)?.[1];
  const envBlock = frontmatter === undefined ? undefined : /^env:\r?\n((?:  .*\r?\n?)*)/m.exec(frontmatter)?.[1];
  const values = new Map<string, string>();
  if (envBlock === undefined) return values;

  for (const line of envBlock.split(/\r?\n/)) {
    const match = /^  ([A-Z][A-Z0-9_]*): (.+)$/.exec(line);
    if (match !== null) values.set(match[1]!, match[2]!);
  }
  return values;
}

function engineEndpoint(content: string): string | undefined {
  return /^    OPENAI_BASE_URL: (.+)$/m.exec(content)?.[1];
}

function transformOpencodeFiles(files: Map<string, string>, inspection: RepositoryInspection): Map<string, string> {
  const result = new Map(files);
  for (const [key, content] of result) {
    if (key.endsWith("opencode-ci.md")) {
      result.set(key, generateOpencodeCi(content, inspection));
    } else if (key === "opencode.ci.json") {
      result.set(key, generateOpencodeConfig(content, inspection));
    }
  }
  return result;
}

export async function installTemplate(
  repositoryPath: string,
  template: TemplateName,
  options: CatalogInstallOptions = {},
): Promise<CatalogInstallResult> {
  const sourcePath = options.sourcePath ?? catalogSourcePath();
  const meta = catalogTemplateMeta(template);
  const source = join(sourcePath, "templates", meta.directory, meta.file);
  const target = meta.target;
  const destination = join(repositoryPath, target);
  const conflicts = await exists(destination) && !(await filesMatch(source, destination)) ? [target] : [];

  if (conflicts.length > 0 && !options.force) return { installed: [], conflicts };

  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);

  if (options.inspection !== undefined && template === "opencode.ci.json") {
    const baseContent = await readFile(source, "utf8");
    const transformed = generateOpencodeConfig(baseContent, options.inspection);
    await writeFile(destination, transformed, "utf8");
  }

  try {
    await runCompileIfAvailable(repositoryPath);
  } catch {
    // compile failure is non-fatal
  }

  return { installed: [target], conflicts };
}

export async function installMandatoryFiles(
  repositoryPath: string,
  options: CatalogInstallOptions = {},
): Promise<CatalogInstallResult> {
  const sourcePath = options.sourcePath ?? catalogSourcePath();
  const files = mandatoryFileSpecs(sourcePath).sort((left, right) => left.target.localeCompare(right.target));
  const conflicts = (await Promise.all(files.map(async (file) => {
    const destination = join(repositoryPath, file.target);
    return await exists(destination) && !(await filesMatch(file.source, destination)) ? file.target : undefined;
  }))).filter((file): file is string => file !== undefined);

  if (conflicts.length > 0 && !options.force) return { installed: [], conflicts };

  const updates = await Promise.all(files.map(async (file) => ({ target: file.target, content: await readFile(file.source, "utf8") })));
  await applyTransaction(repositoryPath, [...updates, await preCommitHookUpdate(repositoryPath)]);

  return { installed: files.map((file) => file.target), conflicts };
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
  const actionLockLine = "[ ! -f .github/actions/actions-lock.json ] || git add -- .github/actions/actions-lock.json";
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

async function conflictingTargets(repositoryPath: string, updates: readonly ContentUpdate[]): Promise<string[]> {
  const conflicts = (await Promise.all(updates.map(async ({ target, content }) => {
    const destination = join(repositoryPath, target);
    if (!await exists(destination)) return undefined;
    return (await readFile(destination, "utf8")) === content ? undefined : target;
  }))).filter((target): target is string => target !== undefined);
  return [...new Set(conflicts)].sort();
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

async function copyCompilationInputs(repositoryPath: string, stagingPath: string): Promise<void> {
  const githubPath = join(repositoryPath, ".github");
  if (await exists(githubPath)) await cp(githubPath, join(stagingPath, ".github"), { recursive: true });
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

  const actionsLock = join(repositoryPath, ".github", "actions", "actions-lock.json");
  if (await exists(actionsLock)) {
    updates.push({ target: ".github/actions/actions-lock.json", content: await readFile(actionsLock, "utf8") });
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
  const directory = template.startsWith("opencode") ? "opencode" : template.startsWith("app-ci-") ? "ci" : template === "github-release" ? "release" : template === "visual-evidence" ? "visual-evidence" : template === "bug-report" || template === "feature-request" ? "issues" : "agentics";
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
