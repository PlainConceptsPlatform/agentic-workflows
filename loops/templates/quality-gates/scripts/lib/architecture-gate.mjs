// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/architecture-gate.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Rules for the architecture check. Pure functions; the CLI is scripts/check-architecture.mjs and the
// architecture facet reads the same counts, so the gate and the facet agree.
//
// Two sources, each run in the app's own CI:
// - Web: Steiger's Feature-Sliced Design rules (`steiger ./src --reporter json`, Steiger 0.10+). An
//   error already fails the web job's boundary step, so errors are recorded here and never baselined.
//   Warnings get the report-then-ratchet treatment: quality.config.json `architecture.baseline` records
//   how many warnings each rule has today; in `ratchet` mode a rule may keep that many but never more,
//   and a rule outside the baseline may have none. In `report` mode nothing fails.
// - .NET: the architecture test project's VSTest TRX. The tests already fail the API job; the facet
//   records how many rules passed and which failed. Read from the TRX, not from the test library, so
//   NetArchTest and ArchUnitNET (or plain reflection tests) read the same.

import { gateState, lowerBaseline } from './dead-code-gate.mjs';
import { parseTrx } from './test-timings.mjs';

export { lowerBaseline };

const SEVERITIES = { error: 'errors', warn: 'warnings' };

// Steiger's JSON reporter prints an array of diagnostics: { message, location, ruleName, severity, fixes? }.
export function steigerCounts(report) {
  if (!Array.isArray(report)) throw new Error('not a Steiger JSON report: expected an array of diagnostics (steiger --reporter json)');
  const byRule = {};
  for (const [i, d] of report.entries()) {
    const key = SEVERITIES[d?.severity];
    if (typeof d?.ruleName !== 'string' || !key) throw new Error(`Steiger diagnostic ${i} has no ruleName or a severity other than error or warn`);
    byRule[d.ruleName] ??= { errors: 0, warnings: 0 };
    byRule[d.ruleName][key] += 1;
  }
  const sorted = Object.fromEntries(Object.entries(byRule).sort(([a], [b]) => a.localeCompare(b)));
  const total = (key) => Object.values(sorted).reduce((n, r) => n + r[key], 0);
  return { errors: total('errors'), warnings: total('warnings'), byRule: sorted };
}

const warningsByRule = (byRule) =>
  Object.fromEntries(Object.entries(byRule).map(([rule, r]) => [rule, r.warnings]));

// `config` is quality.config.json's architecture section: { mode, since, baseline }.
export function evaluate(byRule, config) {
  const baseline = config.baseline ?? {};
  const violations = [];
  for (const [rule, count] of Object.entries(warningsByRule(byRule))) {
    const allowed = baseline[rule] ?? 0;
    if (count > allowed) violations.push({ rule, count, allowed, why: baseline[rule] === undefined ? 'new' : 'increased' });
  }
  const improved = Object.entries(baseline)
    .filter(([rule, allowed]) => (byRule[rule]?.warnings ?? 0) < allowed)
    .map(([rule]) => rule)
    .sort();
  const excess = violations.reduce((n, v) => n + v.count - v.allowed, 0);
  const failed = config.mode === 'ratchet' && violations.length > 0;
  return { violations, improved, excess, failed };
}

// Warnings per rule, only the rules that have any. Errors are never baselined.
export function buildBaseline(byRule) {
  return Object.fromEntries(Object.entries(warningsByRule(byRule)).filter(([, count]) => count > 0));
}

// The architecture facet's web block: Steiger's counts, the baseline and the gate as evaluated here.
export function architectureWebData(report, version, config) {
  const { errors, warnings, byRule } = steigerCounts(report);
  const { excess, failed } = evaluate(byRule, config);
  return {
    tool: 'steiger',
    version: version || null,
    errors,
    warnings,
    byRule,
    baseline: config.baseline ?? null,
    gate: gateState(config, excess, failed),
  };
}

// The library behind the architecture tests, from the test project's PackageReference, only to name
// it on the dashboard. Mid-migration both may be referenced; the newer one is named.
export function architectureLibrary(csproj) {
  if (!csproj) return null;
  if (/Include="TngTech\.ArchUnitNET/i.test(csproj)) return 'archunitnet';
  if (/Include="NetArchTest/i.test(csproj)) return 'netarchtest';
  return null;
}

const PASSED = new Set(['Passed']);
const FAILED = new Set(['Failed', 'Error', 'Timeout', 'Aborted']);
export const FAILING_LIMIT = 50;

const decode = (text) =>
  text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// The architecture facet's .NET block from the architecture test project's TRX: one rule per test
// case (a theory's rows count one each), the failing ones by name.
export function architectureDotnetData(trx, tool = null) {
  const run = parseTrx(trx);
  if (!/<TestRun\b/.test(trx)) throw new Error('not a VSTest TRX report: no <TestRun>');
  const failing = run.results
    .filter((r) => FAILED.has(r.outcome))
    .map((r) => decode(r.className === 'unknown' ? r.name : `${r.className}.${r.name}`))
    .sort();
  const passed = run.results.filter((r) => PASSED.has(r.outcome)).length;
  return {
    tool,
    project: run.name || null,
    rules: run.results.length,
    passed,
    failed: failing.length,
    skipped: run.results.length - passed - failing.length,
    failing: failing.slice(0, FAILING_LIMIT),
  };
}

export const architectureFacetData = ({ web = null, dotnet = null }) => ({ web, dotnet });
