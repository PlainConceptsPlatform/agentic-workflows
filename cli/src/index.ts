#!/usr/bin/env node

import { inspectRepository, parseVisibility, resolveVisibility } from "./repository-inspection.js";
import { installCatalog, installedRoutes, installTemplate, isTemplateName, removeRouteFiles, type CatalogInstallResult } from "./catalog-installation.js";
import { formatCatalog, listCatalog, searchCatalog } from "./catalog-listing.js";
import { packageVersion } from "./package-baseline.js";
import { routeNames, templateNames, type RouteName, type TemplateName } from "./workflow-catalog.js";
import { runInteractive } from "./tui.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HELP_TEXT = `Workflows CLI — install and update Plain Concepts Platform agentic workflows.

Run with no arguments to launch the interactive TUI, the primary way to select and install
workflows and templates:

  npx @plainconceptsplatform/workflows

Advanced (non-interactive) commands:

Usage: workflows <command> [options]

Commands:
  (default)                                   Launch the interactive TUI for selecting and installing items.
  init                                        Inspect the repository and report its stack and visibility.
  add [routes] [--template <name>]            Install route workers and refresh every installed package file.
  update                                      Alias for add: refresh what is installed to this package version.
  remove <routes>                             Uninstall route workers and regenerate the router without them.
  status                                      Print repository inspection as JSON.
  list                                        List all available workflows and templates with install status.
  search <query>                              Filter workflows and templates by name or description.

Route names (positional arguments to add and remove):
  ${routeNames.join(", ")}

  add                                         Refresh installed files. In an empty repository: actions, router,
                                              classifier, matrix, shared imports, opencode.ci.json and the compile
                                              script, with no workers.
  add implement refine                        Install those workers on top of the ones already installed.
  add --template agentics-checks              Install the named template only.
  add refine --template agentics-checks       Routes plus mandatory files plus the named template.
  remove audit                                Uninstall the audit worker and drop it from the router.

What an update does to a package-managed file:
  The file is replaced with this version's, and its ownership header records the version.
  In a worker (agent-*.md) the env: block at the top is yours: your values are kept, keys the
  package added arrive with their defaults, keys only you defined stay. When the header records
  the version you installed from, that release is fetched from npm and a value you never changed
  follows the package when its default changes. The agent runner pool and the engine gateway URL
  are kept as well. Everything else in the file is the package's.
  A file whose ownership header was removed is yours and is left alone unless --force is passed.
  Templates are yours after installation and are replaced only with --force.

Options:
  --dry-run                                   Print what add or update would change, write nothing.
  --force                                     Also overwrite consumer-owned files and changed templates.
  --baseline <path>                           Use this loops/ directory as the merge baseline instead of
                                              fetching the installed version from npm. For rolling out a
                                              version that is not published yet: without a baseline the
                                              merge is two-way and keeps every consumer value, including
                                              the package defaults the consumer never chose.
  --template <name>                           Install a standalone template alongside or instead of routes.
                                              Templates: ${templateNames.join(", ")}.
  --visibility public|private                 Override repository visibility (init only).
  --version                                   Print the package version.
  -h, --help                                  Show this help text.

Installed workflows are marked [x] when the corresponding .github/workflows/agent-*.md
file exists relative to the current directory.`;

export async function run(arguments_: readonly string[], repositoryPath = process.cwd()): Promise<number> {
  const [command, ...options] = arguments_;

  if (command === "--help" || command === "-h") {
    console.log(HELP_TEXT);
    return 0;
  }

  if (command === "--version" || command === "-v") {
    console.log(await packageVersion());
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
    const { routes, template, force, dryRun } = parsed;
    const baseline = localBaseline(parsed.baseline);

    const allConflicts: string[] = [];
    const allInstalled: string[] = [];
    let catalog: CatalogInstallResult | undefined;
    const templatesPlanned: string[] = [];

    // The installed set is always part of the target set: adding a route never drops another,
    // and a plain update refreshes exactly what is there.
    if (routes.length > 0 || template === undefined) {
      const selectedRoutes = unionRoutes(routes, await installedRoutes(repositoryPath));
      catalog = await installCatalog(repositoryPath, { force, dryRun, selectedRoutes, inspection, baseline });
      allConflicts.push(...catalog.conflicts);
      allInstalled.push(...catalog.installed);
    }

    if (template !== undefined) {
      if (dryRun) {
        templatesPlanned.push(template);
      } else {
        const result = await installTemplate(repositoryPath, template, { force, inspection });
        allConflicts.push(...result.conflicts);
        allInstalled.push(...result.installed);
      }
    }

    if (allConflicts.length > 0 && !force) {
      console.error(`Template conflicts found. Re-run with --force to overwrite consumer-owned copies:\n${allConflicts.join("\n")}`);
      return 1;
    }
    console.log(JSON.stringify({
      command,
      dryRun,
      ...(catalog === undefined ? {} : summarize(catalog)),
      ...(templatesPlanned.length > 0 ? { templatesPlanned } : {}),
      installed: allInstalled.sort(),
      conflicts: allConflicts,
    }, null, 2));
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

    const result = await installCatalog(repositoryPath, { force: parsed.force, dryRun: parsed.dryRun, selectedRoutes: desiredRoutes, inspection, baseline: localBaseline(parsed.baseline) });
    const removed = parsed.dryRun
      ? parsed.routes.filter((route) => installed.includes(route)).map((route) => `.github/workflows/agent-${route}.md`)
      : await removeRouteFiles(repositoryPath, parsed.routes);
    console.log(JSON.stringify({ command, dryRun: parsed.dryRun, ...summarize(result), installed: [...result.installed].sort(), removed, conflicts: result.conflicts }, null, 2));
    return 0;
  }

  return fail(`Unknown command: ${command}`);
}

function summarize(result: CatalogInstallResult) {
  return {
    packageVersion: result.packageVersion,
    installedVersions: result.installedVersions,
    upToDate: result.upToDate,
    baselines: result.baselines,
    changes: result.changes.filter((change) => change.status !== "unchanged"),
    unchanged: result.changes.filter((change) => change.status === "unchanged").length,
  };
}

// A fixed baseline for every recorded version, instead of asking npm. Rolling out a version that
// is not published yet leaves the merge two-way, which keeps every consumer value, including the
// package defaults a consumer never chose and would rather have replaced.
function localBaseline(path: string | undefined): ((version: string) => Promise<string | undefined>) | undefined {
  if (path === undefined) return undefined;
  const resolved = resolve(path);
  return async () => resolved;
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
  | { kind: "ok"; routes: readonly RouteName[]; template: TemplateName | undefined; force: boolean; dryRun: boolean; baseline: string | undefined }
  | { kind: "invalid"; message: string };

const TEMPLATE_NAMES = templateNames.join("|");

function parseAddOptions(options: readonly string[]): ParsedAddOptions {
  const routes: RouteName[] = [];
  let template: TemplateName | undefined;
  let templateSeen = false;
  let force = false;
  let dryRun = false;
  let baseline: string | undefined;
  let i = 0;

  while (i < options.length) {
    const token = options[i]!;

    if (token === "--force") {
      force = true;
      i++;
      continue;
    }

    if (token === "--dry-run") {
      dryRun = true;
      i++;
      continue;
    }

    if (token === "--baseline") {
      if (i + 1 >= options.length) return invalid("--baseline requires a path.");
      baseline = options[i + 1]!;
      i += 2;
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

  return { kind: "ok", routes, template, force, dryRun, baseline };
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
