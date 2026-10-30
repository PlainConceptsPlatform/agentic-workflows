import assert from "node:assert/strict";
import { test } from "node:test";
import { citedPath, isExcluded, linkTarget, proseLines, scan } from "../../loops/actions/collect-doc-drift/collect-doc-drift.mjs";

const top = new Set(["docs", "scripts", ".github"]);

const scanOne = (markdown, { entry = true, exists = () => false } = {}) =>
  scan({
    files: ["docs/guide.md"],
    entryDocs: entry ? ["docs/guide.md"] : [],
    read: () => markdown,
    exists,
    topLevelEntries: top,
  });

test("linkTarget resolves relative to the document and ignores what is not a file here", () => {
  assert.equal(linkTarget("docs/a/b.md", "../c.md#anchor"), "docs/c.md");
  assert.equal(linkTarget("docs/a/b.md", "/README.md"), "README.md");
  assert.equal(linkTarget("docs/a.md", "my%20file.md"), "docs/my file.md");
  assert.equal(linkTarget("docs/a.md", "#anchor"), null);
  assert.equal(linkTarget("docs/a.md", "https://example.com/x.md"), null);
  assert.equal(linkTarget("docs/a.md", "mailto:someone@example.com"), null);
});

test("citedPath keeps repository paths and drops path-shaped things that are not", () => {
  assert.equal(citedPath("docs/ops/runbook.md", top), "docs/ops/runbook.md");
  assert.equal(citedPath("./scripts/build.sh", top), "scripts/build.sh");
  assert.equal(citedPath("application/json", top), null);
  assert.equal(citedPath("owner/repo", top), null);
  assert.equal(citedPath("README.md", top), null);
  assert.equal(citedPath("docs/*.md", top), null);
});

test("proseLines skips fenced code and keeps line numbers true", () => {
  const lines = [...proseLines("one\n```\n[x](gone.md)\n```\nfive")];
  assert.deepEqual(lines.map((l) => [l.number, l.line]), [[1, "one"], [5, "five"]]);
});

test("scan reports a broken link with its file and line", () => {
  const { brokenLinks } = scanOne("intro\n\nSee [the guide](missing.md).\n");
  assert.deepEqual(brokenLinks, [{ file: "docs/guide.md", line: 3, target: "missing.md" }]);
});

test("scan reports a broken image the same way", () => {
  assert.equal(scanOne("![diagram](img/gone.png)\n").brokenLinks.length, 1);
});

test("scan does not report a link that resolves, or one inside a code span", () => {
  assert.deepEqual(scanOne("[ok](here.md)\n", { exists: () => true }).brokenLinks, []);
  assert.deepEqual(scanOne("write `[x](gone.md)` like this\n").brokenLinks, []);
});

test("scan checks cited paths in entry documents only, once per document", () => {
  const text = "Run `scripts/gone.sh`, then `scripts/gone.sh` again.\n";
  assert.deepEqual(scanOne(text).missingPaths, [{ file: "docs/guide.md", line: 1, path: "scripts/gone.sh" }]);
  assert.deepEqual(scanOne(text, { entry: false }).missingPaths, []);
});

test("isExcluded matches by prefix", () => {
  assert.equal(isExcluded("openspec/changes/archive/x.md", ["openspec/changes/archive/"]), true);
  assert.equal(isExcluded("openspec/specs/x.md", ["openspec/changes/archive/"]), false);
});
