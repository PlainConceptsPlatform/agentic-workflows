#!/usr/bin/env node

import { inspectRepository, parseVisibility, resolveVisibility } from "./repository-inspection.js";
import { installCatalog, installedRoutes, installTemplate, isTemplateName, removeRouteFiles } from "./catalog-installation.js";
import { formatCatalog, listCatalog, searchCatalog } from "./catalog-listing.js";
import { routeNames, templateNames, type RouteName, type TemplateName } from "./workflow-catalog.js";
import { runInteractive } from "./tui.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HELP_TEXT = `Workflows CLI — install and manage Plain Concepts Platform agentic workflows.

Run with no arguments to launch the interactive TUI, the primary way to select and install
workflows and templates:

  npx @plainconceptsplatform/workflows

Advanced (non-interactive) commands:

Usage: workflows <command> [options]

Commands:
  (default)                                   Launch the interactive TUI for selecting and installing items.
  init                                        Inspect the repository and report its stack and visibility.
  add [routes] [--template <name>] [--force]  Install route workers, a template, or mandatory files.
  remove <routes> [--force]                   Uninstall route workers and regenerate the router without them.
  update                                      Alias for add.
  status                                      Print repository inspection as JSON.
  list                                        List all available workflows and templates with install status.
  search <query>                              Filter workflows and templates by name or description.

Route names (positional arguments to add):
  refine, implement, triage, apply-review, merge-gate, audit, mutation

  add                                         Mandatory files only (opencode.ci.json, compile script,
                                              shared imports, actions, router, classifier, route matrix).
  add implement refine direct                Installs those route workers plus mandatory files.
  add --template agentics-checks             Installs the named template only (no mandatory files).
  add refine --template agentics-checks      Installs routes + mandatory + the named template.
  add refine implement --force               Forces re-install of routes plus mandatory, overwriting.
  remove propose                             Uninstalls the propose worker and drops it from the router.

add and remove keep the router consistent with what is installed: add unions the requested
routes with the routes already present, and remove drops the requested routes from that set.
Both regenerate the router, classifier, and route matrix from the resulting set. Changing the
route set rewrites the package-owned router, so pass --force to overwrite it.

Options:
  --visibility public|private                 Override repository visibility (init only).
  --template <name>                           Install a standalone template alongside or instead of routes.
                                              Templates: agentics-checks, agentics-maintenance,
                                              app-ci-dotnet-next, app-ci-node-monorepo,
                                              bug-report, feature-request, github-release,
                                              opencode.ci.json.
  --force                                     Overwrite managed files that differ from the package source.
  -h, --help                                  Show this help text.

Installed workflows are marked [x] when the corresponding .github/workflows/agent-*.md
file exists relative to the current directory.`;

export async function run(arguments_: readonly string[], repositoryPath = process.cwd()): Promise<number> {
  const [command, ...options] = arguments_;

  if (command === "--help" || command === "-h") {
    console.log(HELP_TEXT);
    return 0;
  }

  if (command === undefined) {
    const force = options.includes("--force");
    return runInteractive(repositoryPath, { force });
  }

  if (command === "list") {
    const entries = await listCatalog({ installedPath: repositoryPath });
    console.log(formatCatalog(entries));
    return 0;
  }

  if (command === "search") {
    if (options.length === 0 || options.length > 1) return fail("search requires exactly one query argument.");
    const allEntries = await listCatalog({ installedPath: repositoryPath });
    const results = searchCatalog(allEntries, options[0]);
    console.log(formatCatalog(results));
    return 0;
  }

  if (command === "init") {
    const visibility = readVisibilityOption(options);
    if (visibility === "invalid") return fail("--visibility must be public or private.");
    const inspection = await inspectRepository(repositoryPath);
    const resolvedVisibility = await resolveVisibility(repositoryPath, visibility);
    console.log(JSON.stringify({ command, inspection, visibility: resolvedVisibility }, null, 2));
    return 0;
  }

  if (command === "status") {
    const inspection = await inspectRepository(repositoryPath);
    console.log(JSON.stringify({ command, inspection }, null, 2));
    return 0;
  }

  if (command === "add" || command === "update") {
    const parsed = parseAddOptions(options);
    if (parsed.kind === "invalid") return fail(parsed.message);
    const inspection = await inspectRepository(repositoryPath);
    const routes = parsed.routes;
    const template = parsed.template;
    const force = parsed.force;

    const allConflicts: string[] = [];
    const allInstalled: string[] = [];

    if (routes.length > 0) {
      const selectedRoutes = unionRoutes(routes, await installedRoutes(repositoryPath));
      const result = await installCatalog(repositoryPath, { force, selectedRoutes, inspection });
      allConflicts.push(...result.conflicts);
      allInstalled.push(...result.installed);
    } else if (template === undefined) {
      const result = await installCatalog(repositoryPath, { force, selectedRoutes: [], inspection });
      allConflicts.push(...result.conflicts);
      allInstalled.push(...result.installed);
    }

    if (template !== undefined) {
      const result = await installTemplate(repositoryPath, template, { force, inspection });
      allConflicts.push(...result.conflicts);
      allInstalled.push(...result.installed);
    }

    if (allConflicts.length > 0 && !force) {
      console.error(`Catalog conflicts found. Re-run with --force to overwrite package-managed files:\n${allConflicts.join("\n")}`);
      return 1;
    }
    console.log(JSON.stringify({ command, installed: allInstalled.sort(), conflicts: allConflicts }, null, 2));
    return 0;
  }

  if (command === "remove") {
    const parsed = parseAddOptions(options);
    if (parsed.kind === "invalid") return fail(parsed.message);
    if (parsed.template !== undefined) return fail("remove does not accept --template.");
    if (parsed.routes.length === 0) return fail("remove requires at least one route.");

    const inspection = await inspectRepository(repositoryPath);
    const installed = await installedRoutes(repositoryPath);
    const desiredRoutes = installed.filter((route) => !parsed.routes.includes(route));

    const result = await installCatalog(repositoryPath, { force: parsed.force, selectedRoutes: desiredRoutes, inspection });
    if (result.conflicts.length > 0 && !parsed.force) {
      console.error(`Catalog conflicts found. Re-run with --force to overwrite package-managed files:\n${result.conflicts.join("\n")}`);
      return 1;
    }

    const removed = await removeRouteFiles(repositoryPath, parsed.routes);
    console.log(JSON.stringify({ command, installed: [...result.installed].sort(), removed, conflicts: result.conflicts }, null, 2));
    return 0;
  }

  return fail(`Unknown command: ${command}`);
}

function unionRoutes(requested: readonly RouteName[], installed: readonly RouteName[]): RouteName[] {
  const result = [...requested];
  for (const route of installed) {
    if (!result.includes(route)) result.push(route);
  }
  return result;
}

function readVisibilityOption(options: readonly string[]): "invalid" | "public" | "private" | undefined {
  if (options.length === 0) return undefined;
  if (options.length !== 2 || options[0] !== "--visibility") return "invalid";
  return parseVisibility(options[1]) ?? "invalid";
}

type ParsedAddOptions =
  | { kind: "ok"; routes: readonly RouteName[]; template: TemplateName | undefined; force: boolean }
  | { kind: "invalid"; message: string };

const TEMPLATE_NAMES = templateNames.join("|");

function parseAddOptions(options: readonly string[]): ParsedAddOptions {
  const routes: RouteName[] = [];
  let template: TemplateName | undefined;
  let templateSeen = false;
  let force = false;
  let i = 0;

  while (i < options.length) {
    const token = options[i]!;

    if (token === "--force") {
      force = true;
      i++;
      continue;
    }

    if (token === "--template") {
      if (templateSeen) return invalid("--template can only be specified once.");
      templateSeen = true;
      if (i + 1 >= options.length) return invalid("--template requires a name.");
      const name = options[i + 1]!;
      if (!isTemplateName(name)) return invalid(`--template must be one of: ${TEMPLATE_NAMES}.`);
      template = name;
      i += 2;
      continue;
    }

    if (token.startsWith("--")) {
      return invalid(`Unknown option: ${token}`);
    }

    if (routeNames.includes(token as RouteName)) {
      const route = token as RouteName;
      if (routes.includes(route)) return invalid(`Duplicate route: ${route}.`);
      routes.push(route);
      i++;
      continue;
    }

    return invalid(`Unknown route: ${token}. Valid routes: ${routeNames.join(", ")}.`);
  }

  return { kind: "ok", routes, template, force };
}

function invalid(message: string): ParsedAddOptions {
  return { kind: "invalid", message };
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void run(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
