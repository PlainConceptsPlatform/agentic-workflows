import { describe, expect, it } from "vitest";

import type { CatalogEntry } from "./catalog-listing.js";
import {
  applyFilter,
  cancelSelection,
  clearFilter,
  createSelectionState,
  filterItems,
  fuzzyMatch,
  getItemsToInstall,
  moveCursorDown,
  moveCursorUp,
  submitSelection,
  toggleSelection,
} from "./tui.js";

function makeEntry(name: string, kind: "route" | "template", installed = false): CatalogEntry {
  return {
    kind,
    name,
    description: `${name} description`,
    file: `${name}.md`,
    installed,
  };
}

function makeEntries(installed: string[] = []): CatalogEntry[] {
  const routes = ["refine", "implement", "triage", "apply-review", "merge-gate", "audit"];
  const templates = ["agentics-checks", "agentics-maintenance", "app-ci-dotnet-next", "app-ci-node-monorepo", "opencode.ci.json"];
  return [
    ...routes.map((name) => makeEntry(name, "route", installed.includes(name))),
    ...templates.map((name) => makeEntry(name, "template", installed.includes(name))),
  ];
}

// Counts derive from the fixture, so adding or removing a route above cannot silently
// desynchronise five assertions again.
const FIXTURE_COUNT = makeEntries().length;

describe("createSelectionState", () => {
  it("returns all items as visible initially", () => {
    const entries = makeEntries();
    const state = createSelectionState(entries);

    expect(state.allItems).toHaveLength(FIXTURE_COUNT);
    expect(state.visibleItems).toHaveLength(FIXTURE_COUNT);
  });

  it("pre-selects installed items", () => {
    const entries = makeEntries(["refine", "agentics-checks"]);
    const state = createSelectionState(entries);

    expect(state.selected.has("refine")).toBe(true);
    expect(state.selected.has("agentics-checks")).toBe(true);
    expect(state.selected.has("implement")).toBe(false);
  });

  it("starts with no filter and cursor at 0", () => {
    const state = createSelectionState(makeEntries());

    expect(state.filter).toBe("");
    expect(state.cursor).toBe(0);
    expect(state.status).toBe("selecting");
  });

  it("pre-selects nothing when nothing is installed", () => {
    const state = createSelectionState(makeEntries());

    expect(state.selected.size).toBe(0);
  });
});

describe("fuzzyMatch", () => {
  it("returns true for empty query", () => {
    expect(fuzzyMatch("anything", "")).toBe(true);
  });

  it("matches exact string", () => {
    expect(fuzzyMatch("refine", "refine")).toBe(true);
  });

  it("matches subsequence characters", () => {
    expect(fuzzyMatch("refine", "rfe")).toBe(true);
  });

  it("matches non-contiguous characters", () => {
    expect(fuzzyMatch("app-ci-dotnet-next", "acdn")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("Refine", "REFINE")).toBe(true);
    expect(fuzzyMatch("REFINE", "refine")).toBe(true);
  });

  it("returns false when characters are not in order", () => {
    expect(fuzzyMatch("refine", "efinr")).toBe(false);
  });

  it("returns false when query has characters not in text", () => {
    expect(fuzzyMatch("refine", "xyz")).toBe(false);
  });

  it("matches against full name + description with combined filter", () => {
    const text = "agentics-checks Agentics checks: verifies generated agent lockfiles";
    expect(fuzzyMatch(text, "acch")).toBe(true);
  });
});

describe("filterItems", () => {
  const entries = makeEntries();

  it("returns all items when filter is empty", () => {
    expect(filterItems(entries, "")).toHaveLength(FIXTURE_COUNT);
  });

  it("filters by name", () => {
    const result = filterItems(entries, "refine");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("refine");
  });

  it("filters by description", () => {
    const result = filterItems(entries, "description");
    expect(result).toHaveLength(FIXTURE_COUNT);
  });

  it("filters by fuzzy subsequence over name and description", () => {
    const result = filterItems(entries, "acdn");
    const names = result.map((e) => e.name);
    expect(names).toContain("app-ci-dotnet-next");
  });

  it("returns empty when nothing matches", () => {
    expect(filterItems(entries, "zzzzz")).toHaveLength(0);
  });
});

describe("applyFilter", () => {
  it("updates the filter and visibleItems", () => {
    const state = createSelectionState(makeEntries());
    const next = applyFilter(state, "refine");

    expect(next.filter).toBe("refine");
    expect(next.visibleItems.length).toBe(1);
    expect(next.visibleItems[0]!.name).toBe("refine");
  });

  it("clamps cursor when result shrinks", () => {
    const entries = makeEntries();
    let state = createSelectionState(entries);
    state = { ...state, cursor: 10 };
    state = applyFilter(state, "ci");

    expect(state.cursor).toBeLessThanOrEqual(Math.max(0, state.visibleItems.length - 1));
    expect(state.cursor).toBeLessThan(state.visibleItems.length);
  });

  it("sets cursor to 0 when no results match", () => {
    const state = applyFilter(createSelectionState(makeEntries()), "zzz");

    expect(state.visibleItems).toHaveLength(0);
    expect(state.cursor).toBe(0);
  });

  it("preserves selected set when filtering", () => {
    const entries = makeEntries(["refine"]);
    const state = applyFilter(createSelectionState(entries), "ref");

    expect(state.selected.has("refine")).toBe(true);
  });
});

describe("clearFilter", () => {
  it("resets filter to empty and restores all items", () => {
    let state = applyFilter(createSelectionState(makeEntries()), "ref");
    state = clearFilter(state);

    expect(state.filter).toBe("");
    expect(state.visibleItems).toHaveLength(FIXTURE_COUNT);
  });
});

describe("moveCursorUp / moveCursorDown", () => {
  it("moves cursor down by one", () => {
    const state = createSelectionState(makeEntries());
    const next = moveCursorDown(state);

    expect(next.cursor).toBe(1);
  });

  it("wraps cursor to top from bottom", () => {
    const entries = makeEntries();
    let state = createSelectionState(entries);
    state = { ...state, cursor: entries.length - 1 };
    state = moveCursorDown(state);

    expect(state.cursor).toBe(0);
  });

  it("moves cursor up by one", () => {
    const entries = makeEntries();
    let state = createSelectionState(entries);
    state = { ...state, cursor: 3 };
    state = moveCursorUp(state);

    expect(state.cursor).toBe(2);
  });

  it("wraps cursor to bottom from top", () => {
    const state = moveCursorUp(createSelectionState(makeEntries()));

    expect(state.cursor).toBe(FIXTURE_COUNT - 1);
  });

  it("does not move when list is empty", () => {
    const entries: CatalogEntry[] = [];
    const state = createSelectionState(entries);

    expect(moveCursorUp(state).cursor).toBe(0);
    expect(moveCursorDown(state).cursor).toBe(0);
  });

  it("navigates within filtered results", () => {
    let state = createSelectionState(makeEntries());
    state = applyFilter(state, "ci");
    state = moveCursorDown(state);

    expect(state.cursor).toBe(1);
    expect(state.cursor).toBeLessThan(state.visibleItems.length);
  });
});

describe("toggleSelection", () => {
  it("selects an unselected item at cursor", () => {
    const state = createSelectionState(makeEntries());

    expect(state.selected.has("refine")).toBe(false);

    const next = toggleSelection(state);
    expect(next.selected.has("refine")).toBe(true);
  });

  it("deselects a selected item at cursor", () => {
    const entries = makeEntries(["refine"]);
    const state = createSelectionState(entries);

    expect(state.selected.has("refine")).toBe(true);

    const next = toggleSelection(state);
    expect(next.selected.has("refine")).toBe(false);
  });

  it("toggles the item at cursor position within filtered list", () => {
    let state = createSelectionState(makeEntries());
    state = applyFilter(state, "ci");
    state = moveCursorDown(state);
    const entryAtCursor = state.visibleItems[state.cursor];

    const next = toggleSelection(state);
    expect(next.selected.has(entryAtCursor!.name)).toBe(true);
  });

  it("does nothing when list is empty", () => {
    const state = createSelectionState([]);
    const next = toggleSelection(state);

    expect(next.selected.size).toBe(0);
  });

  it("does not change other selections", () => {
    const entries = makeEntries(["refine", "audit"]);
    const state = createSelectionState(entries);

    const next = toggleSelection(state);

    expect(next.selected.has("refine")).toBe(false);
    expect(next.selected.has("audit")).toBe(true);
  });
});

describe("submitSelection / cancelSelection", () => {
  it("sets status to submitting", () => {
    const state = submitSelection(createSelectionState(makeEntries()));

    expect(state.status).toBe("submitting");
  });

  it("sets status to cancelled", () => {
    const state = cancelSelection(createSelectionState(makeEntries()));

    expect(state.status).toBe("cancelled");
  });
});

describe("getItemsToInstall", () => {
  it("returns empty when nothing is selected", () => {
    const state = createSelectionState(makeEntries());

    expect(getItemsToInstall(state)).toHaveLength(0);
  });

  it("returns only selected items that are not already installed", () => {
    const entries = makeEntries(["refine"]);
    let state = createSelectionState(entries);
    state = { ...state, cursor: 1 };
    state = toggleSelection(state);

    const items = getItemsToInstall(state);
    const names = items.map((e) => e.name);

    expect(names).toContain("implement");
    expect(names).not.toContain("refine");
  });

  it("returns already-installed items when force is true", () => {
    const entries = makeEntries(["refine"]);
    let state = createSelectionState(entries);

    const items = getItemsToInstall(state, true);
    const names = items.map((e) => e.name);

    expect(names).toContain("refine");
  });

  it("includes both routes and templates", () => {
    let state = createSelectionState(makeEntries());
    state = toggleSelection(state);
    state = { ...state, cursor: 8 };
    state = toggleSelection(state);

    const items = getItemsToInstall(state);
    const kinds = items.map((e) => e.kind);

    expect(kinds).toContain("route");
    expect(kinds).toContain("template");
  });
});
