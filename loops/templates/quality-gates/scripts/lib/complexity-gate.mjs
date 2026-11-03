// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/complexity-gate.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
export const CC_MAX = 15;
export const CRAP_MAX = 30;
// CRAP moves with coverage; a fraction of a point on an untouched method is
// measurement noise between runs, not a regression worth a red build.
export const CRAP_TOLERANCE = 1;
const JUSTIFY_WINDOW = 5;

export const methodKey = (m) => `${m.file}::${m.method}`;
export const violates = (m) => m.cc > CC_MAX || m.crap > CRAP_MAX;

// Overloads share a key; the baseline keeps the worst of them.
function worstByKey(methods) {
  const out = new Map();
  for (const m of methods) {
    const k = methodKey(m);
    const prev = out.get(k);
    if (!prev || m.cc > prev.cc || (m.cc === prev.cc && m.crap > prev.crap)) out.set(k, m);
  }
  return out;
}

export function buildBaseline(methods) {
  const entries = [...worstByKey(methods.filter(violates))]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, m]) => [k, { cc: m.cc, crap: Math.round(m.crap * 100) / 100 }]);
  return Object.fromEntries(entries);
}

// An escape hatch a reviewer can see: `complexity-justified: <reason> (#<issue>)`
// in a comment within the few lines above the method's first line.
const JUSTIFIED = /complexity-justified:\s*(\S.*?)\s*\(#(\d+)\)/;
export function justification(sourceLines, line) {
  if (!sourceLines || !line) return null;
  for (let n = line - 1; n >= Math.max(1, line - JUSTIFY_WINDOW); n--) {
    const m = sourceLines[n - 1]?.match(JUSTIFIED);
    if (m) return { reason: m[1], issue: Number(m[2]) };
  }
  return null;
}

// `readSource(file)` returns the file's lines (or null); injected so this stays pure.
export function evaluate(methods, baseline, readSource = () => null) {
  const violations = [];
  const justified = [];
  let baselined = 0;
  const current = worstByKey(methods);
  for (const [k, m] of current) {
    if (!violates(m)) continue;
    const base = baseline[k];
    if (base && m.cc <= base.cc && m.crap <= base.crap + CRAP_TOLERANCE) {
      baselined++;
      continue;
    }
    const j = justification(readSource(m.file), m.line);
    if (j) {
      justified.push({ ...m, ...j });
      continue;
    }
    const why = !base ? 'new' : m.cc > base.cc ? 'cc-increased' : 'crap-increased';
    violations.push({ ...m, why, baseline: base ?? null });
  }
  // Entries that no longer violate (refactored, tested, deleted) can leave the
  // baseline; --prune does that and only ever shrinks it.
  const fixed = Object.keys(baseline).filter((k) => !current.has(k) || !violates(current.get(k))).sort();
  return { violations, justified, baselined, fixed };
}

// Rewrite the baseline only downwards: drop fixed entries and lower values that
// improved. Never adds a key and never raises a value.
export function pruneBaseline(baseline, methods) {
  const current = worstByKey(methods);
  const out = {};
  for (const [k, base] of Object.entries(baseline)) {
    const m = current.get(k);
    if (!m || !violates(m)) continue;
    out[k] = { cc: Math.min(base.cc, m.cc), crap: Math.min(base.crap, Math.round(m.crap * 100) / 100) };
  }
  return out;
}
