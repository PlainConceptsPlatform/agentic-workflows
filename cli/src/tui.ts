import * as readline from "node:readline";

import { formatCatalog, listCatalog, type CatalogEntry } from "./catalog-listing.js";
import { installCatalog, installMandatoryFiles, installTemplate, isTemplateName, removeRouteFiles } from "./catalog-installation.js";
import { inspectRepository } from "./repository-inspection.js";
import { routeNames, type RouteName } from "./workflow-catalog.js";

export type SelectionStatus = "selecting" | "submitting" | "cancelled";

export interface SelectionState {
  readonly allItems: readonly CatalogEntry[];
  readonly visibleItems: readonly CatalogEntry[];
  readonly selected: ReadonlySet<string>;
  readonly cursor: number;
  readonly filter: string;
  readonly status: SelectionStatus;
}

export interface InteractiveOptions {
  readonly force?: boolean;
}

interface KeyPress {
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly sequence?: string;
}

const ANSI = {
  clear: "\x1b[2J",
  home: "\x1b[H",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  grey: "\x1b[90m",
  white: "\x1b[37m",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
} as const;

export function createSelectionState(entries: readonly CatalogEntry[]): SelectionState {
  const selected = new Set(entries.filter((entry) => entry.installed).map((entry) => entry.name));
  return {
    allItems: entries,
    visibleItems: entries,
    selected,
    cursor: 0,
    filter: "",
    status: "selecting",
  };
}

export function fuzzyMatch(text: string, query: string): boolean {
  if (query === "") return true;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  let needleIndex = 0;
  for (let i = 0; i < haystack.length && needleIndex < needle.length; i++) {
    if (haystack[i] === needle[needleIndex]) needleIndex++;
  }
  return needleIndex === needle.length;
}

export function filterItems(items: readonly CatalogEntry[], filter: string): readonly CatalogEntry[] {
  if (filter === "") return items;
  return items.filter((entry) => fuzzyMatch(`${entry.name} ${entry.description}`, filter));
}

export function applyFilter(state: SelectionState, filter: string): SelectionState {
  const visibleItems = filterItems(state.allItems, filter);
  const cursor = visibleItems.length === 0 ? 0 : Math.min(state.cursor, visibleItems.length - 1);
  return { ...state, visibleItems, filter, cursor };
}

export function clearFilter(state: SelectionState): SelectionState {
  return applyFilter(state, "");
}

export function moveCursorUp(state: SelectionState): SelectionState {
  if (state.visibleItems.length === 0) return state;
  const cursor = state.cursor === 0 ? state.visibleItems.length - 1 : state.cursor - 1;
  return { ...state, cursor };
}

export function moveCursorDown(state: SelectionState): SelectionState {
  if (state.visibleItems.length === 0) return state;
  const cursor = state.cursor === state.visibleItems.length - 1 ? 0 : state.cursor + 1;
  return { ...state, cursor };
}

export function toggleSelection(state: SelectionState): SelectionState {
  if (state.visibleItems.length === 0) return state;
  const entry = state.visibleItems[state.cursor];
  if (entry === undefined) return state;

  const selected = new Set(state.selected);
  if (selected.has(entry.name)) {
    selected.delete(entry.name);
  } else {
    selected.add(entry.name);
  }
  return { ...state, selected };
}

export function submitSelection(state: SelectionState): SelectionState {
  return { ...state, status: "submitting" };
}

export function cancelSelection(state: SelectionState): SelectionState {
  return { ...state, status: "cancelled" };
}

export function getItemsToInstall(state: SelectionState, force = false): readonly CatalogEntry[] {
  return state.allItems.filter(
    (entry) => state.selected.has(entry.name) && (force || !entry.installed),
  );
}

function renderEntry(entry: CatalogEntry, highlighted: boolean, checked: boolean): string {
  const indicator = highlighted ? `${ANSI.bold}${ANSI.white}>${ANSI.reset}` : " ";
  if (checked) {
    const checkbox = `${ANSI.green}[x]${ANSI.reset}`;
    const name = highlighted ? `${ANSI.white}${ANSI.bold}${entry.name}${ANSI.reset}` : entry.name;
    const desc = `${ANSI.dim} — ${entry.description}${ANSI.reset}`;
    return `${indicator} ${checkbox} ${name}${desc}`;
  }
  const checkbox = `${ANSI.grey}[ ]${ANSI.reset}`;
  const name = highlighted ? `${ANSI.white}${ANSI.bold}${entry.name}${ANSI.reset}` : entry.name;
  const desc = `${ANSI.dim} — ${entry.description}${ANSI.reset}`;
  return `${indicator} ${checkbox} ${name}${desc}`;
}

function render(state: SelectionState): void {
  const lines: string[] = [];

  lines.push(`${ANSI.cyan}${ANSI.bold}Plain Concepts Platform — Agentic Workflows${ANSI.reset}`);
  lines.push(`${ANSI.dim}Select items to install. Already-installed items are pre-checked.${ANSI.reset}`);
  lines.push("");

  if (state.filter) {
    lines.push(`${ANSI.cyan}Filter:${ANSI.reset} ${state.filter}${ANSI.grey}█${ANSI.reset}`);
  } else {
    lines.push(`${ANSI.dim}Type to filter, arrows to navigate, space to toggle, Enter to install${ANSI.reset}`);
  }
  lines.push("");

  const routes = state.visibleItems.filter((entry) => entry.kind === "route");
  const templates = state.visibleItems.filter((entry) => entry.kind === "template");

  let index = 0;

  if (routes.length > 0) {
    lines.push(`${ANSI.cyan}Workflows${ANSI.reset}`);
    for (const entry of routes) {
      lines.push(renderEntry(entry, index === state.cursor, state.selected.has(entry.name)));
      index++;
    }
    if (templates.length > 0) lines.push("");
  }

  if (templates.length > 0) {
    lines.push(`${ANSI.cyan}Templates${ANSI.reset}`);
    for (const entry of templates) {
      lines.push(renderEntry(entry, index === state.cursor, state.selected.has(entry.name)));
      index++;
    }
  }

  if (state.visibleItems.length === 0) {
    lines.push(`${ANSI.grey}  No items match the filter.${ANSI.reset}`);
  }

  lines.push("");
  lines.push(`${ANSI.grey}↑↓ navigate  space toggle  type to filter  Enter install  Esc clear filter  q quit${ANSI.reset}`);

  process.stdout.write(`${ANSI.clear}${ANSI.home}${lines.join("\n")}\n`);
}

export async function runInteractive(
  repositoryPath: string,
  options: InteractiveOptions = {},
): Promise<number> {
  const force = options.force ?? false;

  if (process.stdin.isTTY !== true) {
    const entries = await listCatalog({ installedPath: repositoryPath });
    console.log(formatCatalog(entries));
    console.log("");
    console.log("Run with a TTY for an interactive selection screen, or use: workflows add [--template <name>] [--force]");
    return 0;
  }

  const entries = await listCatalog({ installedPath: repositoryPath });
  let state = createSelectionState(entries);

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write(ANSI.hideCursor);

  render(state);

  return new Promise<number>((resolve) => {
    const onKeypress = (str: string | undefined, key: KeyPress): void => {
      if (key?.ctrl && key?.name === "c") {
        cleanup();
        resolve(0);
        return;
      }

      if (str === "q" && state.filter === "" && !key?.ctrl && !key?.meta && !key?.shift) {
        cleanup();
        resolve(0);
        return;
      }

      if (key?.name === "escape") {
        state = clearFilter(state);
        render(state);
        return;
      }

      if (key?.name === "up") {
        state = moveCursorUp(state);
        render(state);
        return;
      }

      if (key?.name === "down") {
        state = moveCursorDown(state);
        render(state);
        return;
      }

      if (key?.name === "space" || str === " ") {
        state = toggleSelection(state);
        render(state);
        return;
      }

      if (key?.name === "return" || key?.name === "enter") {
        cleanup();
        void installSelected(state, repositoryPath, force).then((exitCode) => resolve(exitCode));
        return;
      }

      if (key?.name === "backspace") {
        state = applyFilter(state, state.filter.slice(0, -1));
        render(state);
        return;
      }

      if (
        str !== undefined &&
        str.length === 1 &&
        str >= " " &&
        str <= "~" &&
        !key?.ctrl &&
        !key?.meta
      ) {
        state = applyFilter(state, state.filter + str);
        render(state);
      }
    };

    function cleanup(): void {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(`${ANSI.showCursor}${ANSI.reset}`);
      process.stdin.removeListener("keypress", onKeypress);
    }

    process.stdin.on("keypress", onKeypress);
  });
}

async function installSelected(
  state: SelectionState,
  repositoryPath: string,
  force: boolean,
): Promise<number> {
  const items = getItemsToInstall(state, force);
  const newRoutes = items.filter((entry) => entry.kind === "route");
  const templates = items.filter((entry) => entry.kind === "template");

  const routeEntries = state.allItems.filter((entry) => entry.kind === "route");
  const checkedRoutes = routeEntries
    .filter((entry) => state.selected.has(entry.name))
    .map((entry) => entry.name)
    .filter((name): name is RouteName => routeNames.includes(name as RouteName));
  const installedRouteNames = routeEntries
    .filter((entry) => entry.installed)
    .map((entry) => entry.name)
    .filter((name): name is RouteName => routeNames.includes(name as RouteName));
  const removedRoutes = installedRouteNames.filter((name) => !checkedRoutes.includes(name));

  const allConflicts: string[] = [];
  const allInstalled: string[] = [];
  const allRemoved: string[] = [];

  const inspection = await inspectRepository(repositoryPath);

  if (checkedRoutes.length > 0 && (newRoutes.length > 0 || removedRoutes.length > 0 || force)) {
    const result = await installCatalog(repositoryPath, { force, selectedRoutes: checkedRoutes, inspection });
    allConflicts.push(...result.conflicts);
    allInstalled.push(...result.installed);
    if (result.conflicts.length === 0 || force) {
      allRemoved.push(...await removeRouteFiles(repositoryPath, removedRoutes));
    }
  } else if (checkedRoutes.length === 0 && removedRoutes.length > 0) {
    const result = await installCatalog(repositoryPath, { force, selectedRoutes: [], inspection });
    allConflicts.push(...result.conflicts);
    allInstalled.push(...result.installed);
    if (result.conflicts.length === 0 || force) {
      allRemoved.push(...await removeRouteFiles(repositoryPath, removedRoutes));
    }
  } else {
    const result = await installMandatoryFiles(repositoryPath, { force });
    allConflicts.push(...result.conflicts);
    allInstalled.push(...result.installed);
  }

  for (const template of templates) {
    if (!isTemplateName(template.name)) continue;
    const result = await installTemplate(repositoryPath, template.name, { force, inspection });
    allConflicts.push(...result.conflicts);
    allInstalled.push(...result.installed);
  }

  if (allConflicts.length > 0 && !force) {
    console.error(`Conflicts found. Re-run with --force to overwrite:\n${allConflicts.join("\n")}`);
    return 1;
  }

  if (allInstalled.length > 0 || allRemoved.length > 0) {
    if (allInstalled.length > 0) {
      console.log(`Installed ${allInstalled.length} item(s):`);
      for (const file of allInstalled) {
        console.log(`  ${file}`);
      }
    }
    if (allRemoved.length > 0) {
      console.log(`Removed ${allRemoved.length} item(s):`);
      for (const file of allRemoved) {
        console.log(`  ${file}`);
      }
    }
  } else {
    console.log("All selected items are already installed.");
  }

  return 0;
}
