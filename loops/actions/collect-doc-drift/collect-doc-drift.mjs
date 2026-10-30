// Managed by @plainconceptsplatform/workflows. Source: loops/actions/collect-doc-drift/collect-doc-drift.mjs. Update with workflows update --force; consumer edits may be overwritten.
//
// Everything here is something a model would otherwise spend turns establishing, and could get
// wrong. Existence only: whether a link's anchor resolves, or whether a sentence is still true,
// is left to the agent.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

// A report nobody can finish reading is a report nobody acts on, and it costs input tokens.
const MAX_LISTED = 200;

const FENCE = /^\s*(```|~~~)/;
const INLINE_LINK = /(?<!!)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const IMAGE_LINK = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const CODE_SPAN = /`([^`\n]+)`/g;
const CITED_PATH = /^\.?\/?[\w.-]+(\/[\w.-]+)*\/?$/;
const EXTERNAL = /^[a-z][a-z0-9+.-]*:|^\/\//i;

const splitList = (value) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

export const isExcluded = (path, prefixes) => prefixes.some((prefix) => path.startsWith(prefix));

/** The file a link points at, or null when it does not point at a file in this repository. */
export function linkTarget(fromFile, href) {
  if (href.startsWith("#") || EXTERNAL.test(href)) return null;
  const path = href.split(/[#?]/)[0];
  if (path === "") return null;
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A literal % that is not an escape: the undecoded path is the one to check.
  }
  return normalize(decoded.startsWith("/") ? decoded.slice(1) : join(dirname(fromFile), decoded));
}

// A code span in prose often is a path, but `owner/repo` and `application/json` have the same
// shape. Requiring an existing first segment keeps paths into this repository and drops those.
export function citedPath(span, topLevelEntries) {
  if (!span.includes("/") || !CITED_PATH.test(span)) return null;
  const path = span.replace(/^\.?\//, "");
  return topLevelEntries.has(path.split("/")[0]) ? path : null;
}

/** Walk a Markdown document line by line, skipping fenced code, where a link is an example. */
export function* proseLines(markdown) {
  let fenced = false;
  let number = 0;
  for (const line of markdown.split(/\r?\n/)) {
    number += 1;
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) yield { number, line };
  }
}

export function scan({ files, entryDocs, read, exists, topLevelEntries }) {
  const brokenLinks = [];
  const missingPaths = [];
  const seenCitations = new Set();

  for (const file of files) {
    const isEntry = entryDocs.includes(file);
    for (const { number, line } of proseLines(read(file))) {
      const withoutCode = line.replace(CODE_SPAN, "");
      for (const pattern of [INLINE_LINK, IMAGE_LINK]) {
        for (const [, href] of withoutCode.matchAll(pattern)) {
          const target = linkTarget(file, href);
          if (target !== null && !exists(target)) brokenLinks.push({ file, line: number, target: href });
        }
      }
      if (!isEntry) continue;
      for (const [, span] of line.matchAll(CODE_SPAN)) {
        const path = citedPath(span, topLevelEntries);
        const key = `${file}:${path}`;
        if (path === null || seenCitations.has(key) || exists(path)) continue;
        seenCitations.add(key);
        missingPaths.push({ file, line: number, path });
      }
    }
  }

  return { brokenLinks, missingPaths };
}

function main() {
  const entryDocs = splitList(process.env.ENTRY_DOCS);
  const exclude = splitList(process.env.EXCLUDE);
  const outputPath = process.env.OUTPUT_PATH ?? "/tmp/gh-aw/agent/doc-drift.json";

  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\0").filter(Boolean);
  const files = tracked.filter((path) => path.endsWith(".md") && !isExcluded(path, exclude));
  const trackedSet = new Set(tracked);
  const exists = (path) => {
    if (trackedSet.has(path)) return true;
    // A directory is tracked only through its files, and a generated file not at all.
    return existsSync(path) && (statSync(path).isDirectory() || statSync(path).isFile());
  };

  const { brokenLinks, missingPaths } = scan({
    files,
    entryDocs,
    read: (path) => readFileSync(path, "utf8"),
    exists,
    topLevelEntries: new Set(tracked.map((path) => path.split("/")[0])),
  });

  const report = {
    scannedDocuments: files.length,
    entryDocuments: entryDocs.filter((path) => trackedSet.has(path)),
    missingEntryDocuments: entryDocs.filter((path) => !trackedSet.has(path)),
    brokenLinkCount: brokenLinks.length,
    missingPathCount: missingPaths.length,
    brokenLinks: brokenLinks.slice(0, MAX_LISTED),
    missingPaths: missingPaths.slice(0, MAX_LISTED),
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Scanned ${files.length} documents: ${brokenLinks.length} broken links, ${missingPaths.length} missing cited paths.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
