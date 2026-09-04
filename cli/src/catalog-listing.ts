import { access, constants } from "node:fs/promises";
import { join } from "node:path";

import { catalogTemplates, templateNames, workflowRoutes, type RouteName, type TemplateName } from "./workflow-catalog.js";

export interface CatalogEntry {
  readonly kind: "route" | "template";
  readonly name: string;
  readonly description: string;
  readonly file: string;
  readonly installed: boolean;
}

export interface ListOptions {
  readonly installedPath?: string;
}

export async function listCatalog(options: ListOptions = {}): Promise<readonly CatalogEntry[]> {
  const basePath = options.installedPath ?? process.cwd();

  const routes = await Promise.all(workflowRoutes.map(async (route) => ({
    kind: "route" as const,
    name: route.name,
    description: route.description,
    file: route.worker,
    installed: await isFileInstalled(basePath, route.worker),
  })));

  const templates = await Promise.all(catalogTemplates.map(async (template) => ({
    kind: "template" as const,
    name: template.name,
    description: template.description,
    file: template.file,
    installed: await isFileInstalled(basePath, template.file, template.target),
  })));

  return [...routes, ...templates];
}

export function searchCatalog(
  entries: readonly CatalogEntry[],
  query: string,
): readonly CatalogEntry[] {
  const normalized = query.toLowerCase().trim();
  if (normalized === "") return [];
  return entries.filter((entry) =>
    entry.name.toLowerCase().includes(normalized) ||
    entry.description.toLowerCase().includes(normalized),
  );
}

export function formatCatalog(entries: readonly CatalogEntry[]): string {
  if (entries.length === 0) return "No workflows matched the search query.";

  const routes = entries.filter((entry) => entry.kind === "route");
  const templates = entries.filter((entry) => entry.kind === "template");

  const lines: string[] = [];

  if (routes.length > 0) {
    lines.push("Workflows:");
    for (const entry of routes) {
      lines.push(formatEntry(entry));
    }
  }

  if (templates.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Templates:");
    for (const entry of templates) {
      lines.push(formatEntry(entry));
    }
  }

  return lines.join("\n");
}

function formatEntry(entry: CatalogEntry): string {
  const mark = entry.installed ? "[x]" : "[ ]";
  return `  ${mark} ${entry.name} — ${entry.description}`;
}

async function isFileInstalled(basePath: string, workerOrTemplateFile: string, explicitTarget?: string): Promise<boolean> {
  const installedPath = templateInstallPath(basePath, workerOrTemplateFile, explicitTarget);
  try {
    await access(installedPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function templateInstallPath(basePath: string, file: string, explicitTarget?: string): string {
  if (explicitTarget !== undefined) return join(basePath, ...explicitTarget.split("/"));
  const isRootTemplate = file.endsWith(".json");
  return isRootTemplate ? join(basePath, file) : join(basePath, ".github", "workflows", file);
}
