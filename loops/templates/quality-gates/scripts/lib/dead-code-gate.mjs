// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/dead-code-gate.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Rules for the web dead-code check (Knip). Pure functions; the CLI is scripts/check-dead-code.mjs and
// the hygiene facet's deadCode.web block reads the same counts, so the gate and the facet agree.
//
// Same model as the complexity and duplication gates, counted per Knip issue type: quality.config.json
// `deadCode.baseline` records how many findings of each type the app has today. In `ratchet` mode a
// type may keep that many but never more, and a type outside the baseline may have none. Unused and
// unlisted dependencies are the exception: they are cheap to fix and a supply-chain cost, so once the
// gate is a ratchet any one of them fails, baseline or not. In `report` mode nothing fails.

// One entry per finding in Knip's JSON reporter (`knip --reporter json`): { issues: [{ file, <type>: [...] }] }.
export const UNUSED_DEPENDENCY_TYPES = ['dependencies', 'devDependencies', 'optionalPeerDependencies'];
export const UNLISTED_DEPENDENCY_TYPES = ['unlisted', 'binaries'];
export const ZERO_TOLERANCE_TYPES = [...UNUSED_DEPENDENCY_TYPES, ...UNLISTED_DEPENDENCY_TYPES];
export const EXPORT_TYPES = ['exports', 'nsExports', 'types', 'nsTypes'];
// Always present in byType, so a zero is a measured zero rather than a missing key.
const CORE_TYPES = ['files', ...EXPORT_TYPES, ...ZERO_TOLERANCE_TYPES, 'unresolved'];
const ROW_KEYS = new Set(['file', 'owners']);

export function knipCounts(report) {
  if (!report || !Array.isArray(report.issues)) throw new Error('not a Knip JSON report: expected { "issues": [...] }');
  const byType = Object.fromEntries(CORE_TYPES.map((type) => [type, 0]));
  for (const row of report.issues) {
    for (const [type, findings] of Object.entries(row ?? {})) {
      if (ROW_KEYS.has(type) || !Array.isArray(findings)) continue;
      byType[type] = (byType[type] ?? 0) + findings.length;
    }
  }
  return Object.fromEntries(Object.entries(byType).sort(([a], [b]) => a.localeCompare(b)));
}

const sum = (byType, types) => types.reduce((n, type) => n + (byType[type] ?? 0), 0);

export function deadCodeSummary(byType) {
  return {
    unusedFiles: byType.files ?? 0,
    unusedExports: sum(byType, EXPORT_TYPES),
    unusedDependencies: sum(byType, UNUSED_DEPENDENCY_TYPES),
    unlistedDependencies: sum(byType, UNLISTED_DEPENDENCY_TYPES),
  };
}

// `config` is quality.config.json's deadCode section: { mode, since, baseline }.
export function evaluate(byType, config) {
  const baseline = config.baseline ?? {};
  const violations = [];
  for (const [type, count] of Object.entries(byType)) {
    const zeroTolerance = ZERO_TOLERANCE_TYPES.includes(type);
    const allowed = zeroTolerance ? 0 : (baseline[type] ?? 0);
    if (count > allowed) {
      violations.push({ type, count, allowed, why: zeroTolerance ? 'dependency' : baseline[type] === undefined ? 'new' : 'increased' });
    }
  }
  const improved = Object.entries(baseline)
    .filter(([type, allowed]) => !ZERO_TOLERANCE_TYPES.includes(type) && (byType[type] ?? 0) < allowed)
    .map(([type]) => type)
    .sort();
  const excess = violations.reduce((n, v) => n + v.count - v.allowed, 0);
  const failed = config.mode === 'ratchet' && violations.length > 0;
  return { violations, improved, excess, failed };
}

// The gate state the facet carries; one shape for every report-then-ratchet check.
export const gateState = (config, excess, failed) => ({ mode: config.mode, since: config.since ?? null, violations: excess, failed });

// Dependency findings stay out: the ratchet holds them at zero whatever the baseline says.
export function buildBaseline(byType) {
  return Object.fromEntries(
    Object.entries(byType)
      .filter(([type, count]) => count > 0 && !ZERO_TOLERANCE_TYPES.includes(type))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

// Only ever downwards: lowers the types that improved and drops the ones at zero. Never adds a type
// and never raises a count, so it cannot hide a regression.
export function lowerBaseline(baseline, byType) {
  const out = {};
  for (const [type, allowed] of Object.entries(baseline)) {
    const count = Math.min(allowed, byType[type] ?? 0);
    if (count > 0) out[type] = count;
  }
  return out;
}

// The hygiene facet's deadCode.web block: Knip's counts, the baseline and the gate as evaluated here.
export function deadCodeWebData(report, config) {
  const byType = knipCounts(report);
  const { excess, failed } = evaluate(byType, config);
  return {
    tool: 'knip',
    ...deadCodeSummary(byType),
    byType,
    baseline: config.baseline ?? null,
    gate: gateState(config, excess, failed),
  };
}
