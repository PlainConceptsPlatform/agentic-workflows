// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/duplication-gate.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Rules for the blocking duplication gate (practice 11, vendored from PlainConceptsPlatform/Atlas, Atlas#1942). Pure functions; the CLI is
// scripts/check-duplication.mjs, and the per-file numbers come from
// duplicatedLinesByFile in engineering-excellence.mjs, so the gate and the hygiene facet count the
// same lines.
//
// Same model as the complexity gate (complexity-gate.mjs): a baseline, not a diff.
// scripts/duplication-baseline.json records, per file, how many of its lines sit
// inside a jscpd clone today. A file may keep that many but never more, and a file
// outside the baseline may have none. Any clone at or above jscpd's minimum (.jscpd.json)
// that a PR adds therefore fails, in every file it touches, while the existing
// backlog stays green. The ratchet is the file only ever shrinking.

export function buildBaseline(duplicated) {
  return Object.fromEntries(
    Object.entries(duplicated)
      .filter(([, lines]) => lines > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function evaluate(duplicated, baseline) {
  const violations = [];
  let baselined = 0;
  for (const [file, lines] of Object.entries(duplicated).sort(([a], [b]) => a.localeCompare(b))) {
    if (lines === 0) continue;
    const base = baseline[file];
    if (base !== undefined && lines <= base) {
      baselined++;
      continue;
    }
    violations.push({ file, lines, baseline: base ?? null, why: base === undefined ? 'new' : 'increased' });
  }
  // Entries whose file improved or lost its clones; --prune lowers or drops them.
  const fixed = Object.keys(baseline)
    .filter((file) => (duplicated[file] ?? 0) < baseline[file])
    .sort();
  return { violations, baselined, fixed };
}

// Only ever downwards: lowers improved entries, drops files with no clone left (or
// gone), never adds a file and never raises a count.
export function pruneBaseline(baseline, duplicated) {
  const out = {};
  for (const [file, base] of Object.entries(baseline)) {
    const lines = Math.min(base, duplicated[file] ?? 0);
    if (lines > 0) out[file] = lines;
  }
  return out;
}
