// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/source-files.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Vendored from PlainConceptsPlatform/Atlas scripts/lib/source-files.mjs (Atlas#1942).
// The source files in .jscpd.json's scope (roots, formats, ignores), read from disk, so
// the hygiene facet and the duplication gate measure one file set.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scannedBy } from './engineering-excellence.mjs';

// `root` is the repository root; returns [{ file, text }] with repo-relative paths, sorted.
export function scopedSources(cfg, root) {
  const scanned = scannedBy(cfg);
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const file = relative(root, full);
        if (scanned(file)) out.push({ file, text: readFileSync(full, 'utf8') });
      }
    }
  };
  for (const p of cfg.path) if (existsSync(join(root, p))) walk(join(root, p));
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
