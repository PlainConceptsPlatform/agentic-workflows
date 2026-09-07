// Managed by @plainconceptsplatform/workflows. Source: loops/scripts/merge-changelog.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
//
// A git merge driver for a newest-first changelog array.
//
// Every merge into the default branch invalidates every other open pull request that added a
// changelog entry, because they all insert at the top of the same list. The conflict is real
// but it is never interesting: both entries belong, newest first. Left to the default driver
// it costs a full model run per sibling pull request, or a person, and it recurs on every
// merge for as long as there is more than one pull request in flight.
//
// Registered from .gitattributes as `merge=changelog`, so git calls this instead of producing
// conflict markers. Falls back to exit 1 (a normal conflict) whenever it cannot be sure, so a
// genuine edit to the same entry is still escalated rather than silently mangled.
//
// Usage (git's merge driver contract): merge-changelog.mjs %O %A %B
//   %O ancestor, %A ours (written back with the result), %B theirs.
import { readFileSync, writeFileSync } from "node:fs";

const [ancestorPath, oursPath, theirsPath] = process.argv.slice(2);

/** Parse, or return undefined so the caller can bail out to a normal conflict. */
function read(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value?.changes) ? value : undefined;
  } catch {
    return undefined;
  }
}

const ours = read(oursPath);
const theirs = read(theirsPath);
const ancestor = read(ancestorPath) ?? { changes: [] };

if (!ours || !theirs) {
  process.stderr.write("merge-changelog: not a changelog document on both sides; leaving the conflict\n");
  process.exit(1);
}

// An entry is identified by its commit when it has one, and by the whole record otherwise.
const identify = (entry) => entry?.commit ?? JSON.stringify(entry);

// Anything either side changed relative to the ancestor, plus everything the ancestor had.
// Union by identity: an append on both sides is the case this exists for.
const merged = new Map();
for (const entry of [...ancestor.changes, ...theirs.changes, ...ours.changes]) {
  merged.set(identify(entry), entry);
}

// An entry the ancestor had and both sides removed should stay removed.
const kept = [...merged.values()].filter((entry) => {
  const id = identify(entry);
  const inAncestor = ancestor.changes.some((candidate) => identify(candidate) === id);
  if (!inAncestor) return true;
  return ours.changes.some((candidate) => identify(candidate) === id) ||
    theirs.changes.some((candidate) => identify(candidate) === id);
});

// If the same identity carries different content on the two sides, somebody edited an entry
// rather than adding one. That is a real conflict and a person should look at it.
for (const entry of kept) {
  const id = identify(entry);
  const mine = ours.changes.find((candidate) => identify(candidate) === id);
  const yours = theirs.changes.find((candidate) => identify(candidate) === id);
  if (mine && yours && JSON.stringify(mine) !== JSON.stringify(yours)) {
    process.stderr.write(`merge-changelog: entry ${id} differs on both sides; leaving the conflict\n`);
    process.exit(1);
  }
}

// Newest first, which is the order the file is read in and the order the page renders.
kept.sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")));

const result = { ...theirs, ...ours, changes: kept };
writeFileSync(oursPath, `${JSON.stringify(result, null, 2)}\n`);
process.stderr.write(`merge-changelog: combined ${ours.changes.length} + ${theirs.changes.length} entries into ${kept.length}\n`);
