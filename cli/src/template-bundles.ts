// A bundle template stays package-managed after installation, under the catalog's header rules. It
// counts as installed only where one of its files carries our header, so `update` never reaches a
// repository that keeps its own headerless copies of the same paths.
import { access, chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { FileChange } from "./catalog-installation.js";
import { hasOwnershipHeader, installedVersion, packageVersion, stampVersion } from "./package-baseline.js";
import { bundleTemplateNames, catalogTemplates, type TemplateName } from "./workflow-catalog.js";

export interface BundleInstallOptions {
  /** Also overwrite files whose ownership header was removed. */
  readonly force?: boolean;
  /** Compute the plan and write nothing. */
  readonly dryRun?: boolean;
  readonly sourcePath?: string;
  /** The version stamped into headers. Defaults to this package's. */
  readonly packageVersion?: string;
}

export interface BundleInstallResult {
  readonly template: TemplateName;
  /** Every target of the bundle, whether it changed or not. */
  readonly installed: readonly string[];
  readonly changes: readonly FileChange[];
}

const CONSUMER_OWNED = "consumer-owned: the ownership header was removed; pass --force to reclaim it";
const carriesHeader = (target: string): boolean => /\.(ya?ml|md|sh|mjs|cjs|tsv)$/.test(target);
const normalizeEol = (text: string): string => text.replaceAll("\r\n", "\n");

export function isBundleTemplate(template: TemplateName): boolean {
  return bundleTemplateNames.includes(template);
}

/** The bundles whose files carry our ownership header in this repository. */
export async function installedBundles(repositoryPath: string, sourcePath: string): Promise<TemplateName[]> {
  const installed: TemplateName[] = [];
  for (const template of bundleTemplateNames) {
    for (const target of await bundleTargets(sourcePath, template)) {
      if (!carriesHeader(target)) continue;
      const current = await readOptional(join(repositoryPath, target));
      if (current !== undefined && hasOwnershipHeader(current)) {
        installed.push(template);
        break;
      }
    }
  }
  return installed;
}

export async function installBundle(
  repositoryPath: string,
  template: TemplateName,
  sourcePath: string,
  options: BundleInstallOptions = {},
): Promise<BundleInstallResult> {
  const version = options.packageVersion ?? await packageVersion();
  const files = await bundleFiles(sourcePath, template);
  const targets = files.map((file) => file.target);
  const changes: FileChange[] = [];
  const writes: { target: string; content: string }[] = [];

  for (const { source, target } of files) {
    const current = await readOptional(join(repositoryPath, target));
    const text = stampVersion(normalizeEol(await readFile(source, "utf8")), version);
    const recorded = current === undefined ? undefined : installedVersion(current);
    const base = recorded === undefined ? { target } : { target, installedVersion: recorded };

    if (current === text) {
      changes.push({ ...base, status: "unchanged" });
    } else if (current !== undefined && !options.force && await consumerOwned(repositoryPath, target, current, targets)) {
      changes.push({ target, status: "skipped", reason: CONSUMER_OWNED });
    } else if (current === undefined && documentsSkippedJson(target, changes)) {
      // The JSON this note documents stays the consumer's, so the note would claim a file we do not own.
      changes.push({ target, status: "skipped", reason: `documents the consumer-owned ${target.slice(0, -".md".length)}` });
    } else {
      changes.push({ ...base, status: current === undefined ? "added" : "updated" });
      writes.push({ target, content: text });
    }
  }

  if (!options.dryRun) {
    for (const { target, content } of writes) {
      const destination = join(repositoryPath, target);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, "utf8");
      // A script a workflow runs by its path needs the executable bit, which a plain write never sets.
      if (content.startsWith("#!")) await chmod(destination, 0o755);
    }
  }

  return { template, installed: targets, changes };
}

// A JSON file's header lives in its companion `<file>.md`; without that note the JSON is the consumer's.
async function consumerOwned(repositoryPath: string, target: string, current: string, targets: readonly string[]): Promise<boolean> {
  if (carriesHeader(target)) return !hasOwnershipHeader(current);
  const companion = `${target}.md`;
  if (!targets.includes(companion)) return false;
  const note = await readOptional(join(repositoryPath, companion));
  return note === undefined || !hasOwnershipHeader(note);
}

// Targets are sorted, so a JSON file is always decided before the `<file>.md` that documents it.
function documentsSkippedJson(target: string, changes: readonly FileChange[]): boolean {
  if (!target.endsWith(".json.md")) return false;
  const json = target.slice(0, -".md".length);
  return changes.some((change) => change.target === json && change.status === "skipped");
}

function bundleRoot(sourcePath: string, template: TemplateName): string {
  const entry = catalogTemplates.find((item) => item.name === template);
  if (entry?.bundle !== true || entry.directory === undefined) throw new Error(`${template} is not a bundle template`);
  return join(sourcePath, "templates", entry.directory);
}

// The bundle's own files, then the actions it borrows from the catalog. Only the former decide whether
// it is installed: a router consumer carries the same actions without having asked for the bundle.
async function bundleFiles(sourcePath: string, template: TemplateName): Promise<{ source: string; target: string }[]> {
  const root = bundleRoot(sourcePath, template);
  const own = (await bundleTargets(sourcePath, template)).map((target) => ({ source: join(root, target), target }));
  const borrowed: { source: string; target: string }[] = [];
  for (const action of catalogTemplates.find((item) => item.name === template)?.actions ?? []) {
    const directory = join(sourcePath, "actions", action);
    for (const file of (await readdir(directory)).sort()) {
      borrowed.push({ source: join(directory, file), target: `.github/actions/${action}/${file}` });
    }
  }
  return [...own, ...borrowed].sort((left, right) => (left.target < right.target ? -1 : left.target > right.target ? 1 : 0));
}

async function bundleTargets(sourcePath: string, template: TemplateName): Promise<string[]> {
  const root = bundleRoot(sourcePath, template);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    await access(path, constants.F_OK);
  } catch {
    return undefined;
  }
  return normalizeEol(await readFile(path, "utf8"));
}
