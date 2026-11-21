// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/audit-select.test.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Run: node --test scripts/lib/audit-select.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  distanceOf,
  facetChecks,
  markerFor,
  markersIn,
  reasonsFor,
  riskMap,
  scoreOf,
  selectAudit,
  selectionSummary,
  severityOf,
  storiesByUnit,
  unitsOfCheck,
} from './audit-select.mjs';
import { parseQualityConfig } from './quality-config.mjs';
import { CHECKS, itemId } from './worklist.mjs';

// ── Fixtures, all synthetic ──────────────────────────────────────────────────────────────────────
const NOW = new Date('2026-11-23T01:17:00Z');
const ENV = { GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '900' };
const config = (audit = {}, rest = {}) => parseQualityConfig(JSON.stringify({ audit, ...rest }));

// A worklist item as lib/worklist.mjs writes it.
function item(check, kind, fields = {}) {
  const { rule = null, path = null, line = null, symbol = null, value = null, threshold = null, baseline = null, mode = 'ratchet', message = null, detail } = fields;
  return { id: itemId({ check, rule, path, symbol }), check, kind, rule, path, line, symbol, value, threshold, baseline, mode, message, ...(detail ? { detail } : {}) };
}
const check = (items, extra = {}) => ({ mode: 'ratchet', total: items.length, truncated: false, sources: ['test'], ...extra, items });
const worklistOf = (checks, extra = {}) => ({
  schemaVersion: 1,
  facet: 'worklist',
  runId: 41,
  commitSha: 'a'.repeat(40),
  generatedAt: '2026-11-21T08:00:00.000Z',
  data: { limit: 20, checks: { ...Object.fromEntries(CHECKS.map((c) => [c, null])), ...checks }, unreadable: [], ...extra },
});
const select = (input) => selectAudit({ config: config(), now: NOW, env: ENV, ...input });

const hotspot = (path, symbol, crap, coverage = 0.2, line = 10) =>
  item('complexity', 'method', { rule: 'crap', path, line, symbol, value: crap, threshold: 30, detail: { scope: 'api', module: 'Orders', cc: 18, coverage } });
const SEMGREP_MESSAGE = 'Empty catch: catch (Exception) { /* planted source line */ }';

// Every check with something in it: what the audit of a repository on the app-ci template reads.
function fullWorklist() {
  return worklistOf({
    complexity: check([hotspot('apps/api/Orders/Pricing.cs', 'Pricing.Quote', 186), hotspot('apps/api/Orders/Pricing.cs', 'Pricing.Round', 44, 0.5, 80), hotspot('apps/api/Billing/Invoice.cs', 'Invoice.Total', 62)]),
    coverage: check([
      item('coverage', 'scope', { symbol: 'App.Domain', value: 0.61, threshold: 0.7, detail: { scope: 'App.Domain', linesValid: 1000, uncoveredLines: 390 } }),
      item('coverage', 'module', { path: 'apps/api/Domain/Orders', symbol: 'App.Domain/Orders', value: 0.54, threshold: 0.7, detail: { scope: 'App.Domain', module: 'Orders', linesValid: 400, uncoveredLines: 184 } }),
      item('coverage', 'file', { path: 'apps/api/Domain/Orders/Order.cs', value: 0.4, threshold: 0.7, detail: { scope: 'App.Domain', module: 'Orders', linesValid: 100, uncoveredLines: 60 } }),
      item('coverage', 'file', { path: 'apps/api/Tools/Seed.cs', value: 0.1, mode: 'report', detail: { scope: 'App.Tools', module: 'Tools', linesValid: 50, uncoveredLines: 45 } }),
    ]),
    security: check([
      item('security', 'vulnerability', { rule: 'CVE-2026-0001', path: 'apps/web/pnpm-lock.yaml', symbol: 'left-pad', value: 'HIGH', message: 'left-pad: prototype pollution', detail: { installedVersion: '1.0.0', fixedVersion: '1.0.1', fixable: true } }),
      item('security', 'vulnerability', { rule: 'CVE-2026-0002', path: 'apps/web/pnpm-lock.yaml', symbol: 'left-pad', value: 'CRITICAL', detail: { installedVersion: '1.0.0', fixedVersion: '1.0.2', fixable: true } }),
      item('security', 'vulnerability', { rule: 'CVE-2026-0003', path: 'apps/web/pnpm-lock.yaml', symbol: 'no-fix', value: 'HIGH', mode: 'report', detail: { installedVersion: '2.0.0', fixedVersion: null, fixable: false } }),
    ]),
    semgrep: check([
      item('semgrep', 'finding', { rule: 'platform-hygiene-csharp-empty-catch', path: 'apps/api/Orders/Import.cs', line: 12, value: 2, threshold: 0, message: SEMGREP_MESSAGE, detail: { severity: 'ERROR', lines: [12, 40] } }),
      item('semgrep', 'finding', { rule: 'platform-hygiene-csharp-empty-catch', path: 'apps/api/Orders/Export.cs', line: 7, value: 1, threshold: 0, message: SEMGREP_MESSAGE, detail: { severity: 'ERROR', lines: [7] } }),
    ]),
    deadCode: check(
      [
        item('deadCode', 'unused-export', { rule: 'exports', path: 'apps/web/src/a.ts', symbol: 'unusedA', value: 1, baseline: 2, mode: 'report', detail: { ruleCount: 3, overBaseline: false } }),
        item('deadCode', 'unused-export', { rule: 'exports', path: 'apps/web/src/b.ts', symbol: 'unusedB', value: 1, baseline: 2, mode: 'report', detail: { ruleCount: 3, overBaseline: false } }),
      ],
      { mode: 'report', total: 3, truncated: true, rules: { exports: { count: 3, baseline: 2, over: false } } },
    ),
    patterns: check(
      [
        item('patterns', 'analyzer', { rule: 'MA0004', path: 'apps/api/Orders/Import.cs', line: 3, value: 2, baseline: 2, message: 'Use ConfigureAwait', detail: { level: 'warning', lines: [3, 9], ruleCount: 5, overBaseline: true } }),
        item('patterns', 'analyzer', { rule: 'MA0004', path: 'apps/api/Orders/Export.cs', line: 5, value: 3, baseline: 2, detail: { level: 'warning', lines: [5, 6, 8], ruleCount: 5, overBaseline: true } }),
        item('patterns', 'analyzer', { rule: 'CA1822', path: 'apps/api/Orders/Export.cs', line: 30, value: 1, baseline: 4, detail: { level: 'warning', lines: [30], ruleCount: 4, overBaseline: false } }),
      ],
      { rules: { MA0004: { count: 5, baseline: 2, over: true }, CA1822: { count: 4, baseline: 4, over: false } } },
    ),
    duplication: check([item('duplication', 'clone', { path: 'apps/web/src/x.ts', line: 1, symbol: 'apps/web/src/y.ts', value: 40, threshold: 10, detail: { otherPath: 'apps/web/src/y.ts', otherLine: 5, clones: 1, largestLines: 40, tokens: 300 } })]),
  });
}

// ── The marker ───────────────────────────────────────────────────────────────────────────────────
test('markerFor_roundTripsThroughMarkersIn', () => {
  const unit = { id: '0123456789abcdef', value: 186.5, target: 30 };
  assert.equal(markerFor(unit), '<!-- audit-item: 0123456789abcdef value=186.5 target=30 -->');
  assert.deepEqual(markersIn(`story\n${markerFor(unit)}\n<!-- audit-report: 12 -->`), [{ id: '0123456789abcdef', value: '186.5', target: '30' }]);
  assert.equal(markerFor({ id: 'a'.repeat(16), value: 'CRITICAL', target: '1.0.1 | 2.0.0 --> x' }), `<!-- audit-item: ${'a'.repeat(16)} value=CRITICAL target=1.0.1___2.0.0_--__x -->`);
  assert.deepEqual(markersIn('<!-- audit-item: nothex -->'), []);
});

test('markerFor_neverClosesTheCommentEarly', () => {
  const marker = markerFor({ id: 'b'.repeat(16), value: 'x-->y', target: null });
  assert.equal(marker.indexOf('-->'), marker.length - 3);
  assert.deepEqual(markersIn(marker).map((m) => m.id), ['b'.repeat(16)]);
});

test('storiesByUnit_openTracks_notPlannedDeclines_completedDoesNeither', () => {
  const id = (n) => String(n).repeat(16);
  const { tracked, declined } = storiesByUnit([
    { number: 5, state: 'open', stateReason: null, body: `x <!-- audit-item: ${id(1)} value=1 target=0 -->` },
    { number: 6, state: 'closed', stateReason: 'not_planned', body: `<!-- audit-item: ${id(2)} -->` },
    { number: 7, state: 'closed', stateReason: 'completed', body: `<!-- audit-item: ${id(3)} -->` },
    { number: 8, state: 'open', stateReason: null, body: null },
  ]);
  assert.deepEqual([...tracked], [[id(1), 5]]);
  assert.deepEqual([...declined], [[id(2), 6]]);
});

// ── Units ────────────────────────────────────────────────────────────────────────────────────────
test('unitsOfCheck_complexity_isOneUnitPerFileWithItsMethods', () => {
  const { units } = unitsOfCheck('complexity', fullWorklist().data.checks.complexity.items);
  assert.equal(units.length, 2);
  const pricing = units.find((u) => u.path === 'apps/api/Orders/Pricing.cs');
  assert.equal(pricing.value, 186);
  assert.equal(pricing.target, 30);
  assert.deepEqual(pricing.files.map((f) => f.symbol), ['Pricing.Quote', 'Pricing.Round']);
  assert.equal(pricing.id, itemId({ check: 'complexity', rule: 'crap', path: 'apps/api/Orders/Pricing.cs' }));
});

test('unitsOfCheck_coverage_modulesCarryTheirFilesAndStandInForTheirScope', () => {
  const items = fullWorklist().data.checks.coverage.items.filter((i) => i.mode === 'ratchet');
  const { units, folded } = unitsOfCheck('coverage', items);
  assert.equal(units.length, 1);
  assert.equal(units[0].kind, 'module');
  assert.equal(units[0].id, items[1].id);
  assert.deepEqual(units[0].files.map((f) => f.path), ['apps/api/Domain/Orders', 'apps/api/Domain/Orders/Order.cs']);
  assert.equal(folded, 2);
  // A scope with no module under the floor is its own unit, and so is a file whose module is fine.
  const lone = unitsOfCheck('coverage', [items[0], { ...items[2], detail: { scope: 'App.Domain', module: 'Other' } }]);
  assert.deepEqual(lone.units.map((u) => u.kind), ['scope', 'file']);
});

test('unitsOfCheck_countRatchets_areOneUnitPerRuleMeasuredByTheRuleCount', () => {
  const data = fullWorklist().data.checks.patterns;
  const { units } = unitsOfCheck('patterns', data.items, data.rules);
  const rule = units.find((u) => u.rule === 'MA0004');
  assert.equal(rule.value, 5);
  assert.equal(rule.target, 2);
  assert.equal(rule.bar, 'baseline');
  assert.equal(rule.files.length, 2);
  assert.equal(rule.id, itemId({ check: 'patterns', rule: 'MA0004' }));
  assert.deepEqual(reasonsFor(rule), ['over-baseline']);
  assert.deepEqual(reasonsFor(units.find((u) => u.rule === 'CA1822')), []);
});

test('unitsOfCheck_security_isOneUnitPerPackageWithItsAdvisories', () => {
  const items = fullWorklist().data.checks.security.items.filter((i) => i.mode === 'ratchet');
  const { units } = unitsOfCheck('security', items);
  assert.equal(units.length, 1);
  assert.equal(units[0].value, 'CRITICAL');
  assert.equal(units[0].target, '1.0.1 | 1.0.2');
  assert.deepEqual(units[0].advisories, ['CVE-2026-0001', 'CVE-2026-0002']);
  assert.deepEqual(reasonsFor(units[0]), ['vulnerability']);
});

// ── Score ────────────────────────────────────────────────────────────────────────────────────────
test('distanceOf_isBoundedAndFollowsTheBar', () => {
  assert.equal(distanceOf({ value: 150, target: 30, bar: 'threshold', direction: 'higher' }), 1);
  assert.equal(distanceOf({ value: 60, target: 30, bar: 'threshold', direction: 'higher' }), 0.25);
  assert.equal(distanceOf({ value: 0.35, target: 0.7, bar: 'threshold', direction: 'lower' }), 0.5);
  assert.equal(distanceOf({ value: 3, target: 0, bar: 'threshold', direction: 'higher' }), 0.3);
  assert.equal(distanceOf({ value: 5, target: 2, bar: 'baseline', direction: 'higher' }), 1);
  assert.equal(distanceOf({ value: 3, target: 2, bar: 'baseline', direction: 'higher' }), 0.5);
  assert.equal(distanceOf({ value: 2, target: 2, bar: 'baseline', direction: 'higher' }), 0);
  assert.equal(distanceOf({ value: 'HIGH', target: null }), 1);
  assert.equal(distanceOf({ value: 4, target: null, bar: 'baseline' }), 0);
});

test('scoreOf_isSeverityThenDistanceThenRegression', () => {
  const crap = { check: 'complexity', value: 60, target: 30, bar: 'threshold', direction: 'higher' };
  assert.equal(severityOf(crap), 6);
  assert.equal(scoreOf(crap, ['over-threshold']), 62.5);
  assert.equal(scoreOf(crap, ['over-threshold', 'regressed']), 67.5);
  assert.equal(scoreOf({ check: 'security', kind: 'vulnerable-package', value: 'CRITICAL', target: '1.0.1' }, ['vulnerability']), 110);
  assert.equal(severityOf({ check: 'semgrep', severity: 'WARNING' }), 6);
  assert.equal(severityOf({ check: 'deadCode', bar: 'threshold' }), 5);
  assert.equal(severityOf({ check: 'duplication' }), 2);
});

test('reasonsFor_regression_comparesWithTheLastRunInTheUnitsOwnDirection', () => {
  const rule = { id: 'r'.repeat(16), check: 'patterns', value: 4, target: 4, bar: 'baseline', direction: 'higher' };
  const last = (units, truncated = false) => ({ source: 'worklist', checks: { patterns: { truncated, units } } });
  assert.deepEqual(reasonsFor(rule, last({ [rule.id]: 3 })), ['regressed']);
  assert.deepEqual(reasonsFor(rule, last({ [rule.id]: 4 })), []);
  assert.deepEqual(reasonsFor(rule, last({}), 'worklist'), ['regressed']);
  // Not new when the last run did not see the whole check, came from another source, or lacked the check.
  assert.deepEqual(reasonsFor(rule, last({}, true), 'worklist'), []);
  assert.deepEqual(reasonsFor(rule, last({}), 'facets'), []);
  assert.deepEqual(reasonsFor(rule, { source: 'worklist', checks: {} }, 'worklist'), []);
  const rate = { id: 'c'.repeat(16), check: 'coverage', value: 0.5, target: 0.7, bar: 'threshold', direction: 'lower' };
  assert.deepEqual(reasonsFor(rate, { source: 'worklist', checks: { coverage: { truncated: false, units: { [rate.id]: 0.6 } } } }), ['over-threshold', 'regressed']);
  assert.deepEqual(reasonsFor(rate, { source: 'worklist', checks: { coverage: { truncated: false, units: { [rate.id]: 0.4 } } } }), ['over-threshold']);
});

// ── The selection ────────────────────────────────────────────────────────────────────────────────
test('selectAudit_fullWorklist_ranksCapsAndExplainsWhatItLeftOut', () => {
  const selection = select({ worklist: fullWorklist() });
  assert.equal(selection.source, 'worklist');
  assert.equal(selection.trustworthy, true);
  assert.equal(selection.runAgent, true);
  assert.equal(selection.clean, false);
  assert.deepEqual(selection.selected.map((u) => [u.check, u.kind, u.score]), [
    ['security', 'vulnerable-package', 110],
    ['semgrep', 'rule', 83],
    ['complexity', 'file', 70],
  ]);
  assert.deepEqual(selection.selected.map((u) => u.reasons), [['vulnerability'], ['failed-gate'], ['over-threshold']]);
  for (const unit of selection.selected) assert.deepEqual(markersIn(unit.marker).map((m) => m.id), [unit.id]);
  // Over the cap, in rank order: the other file, the module, the rule over its baseline, the clone.
  assert.deepEqual(selection.excluded.overCap.items.map((u) => u.check), ['complexity', 'coverage', 'patterns', 'duplication']);
  assert.equal(selection.excluded.withinBar, 1);
  assert.equal(selection.excluded.folded, 2);
  // Report mode files no story: the whole dead-code check, the file with no floor, the advisory with no fix.
  assert.deepEqual(selection.excluded.notEnforced, {
    coverage: { mode: 'ratchet', count: 1, previous: null, change: null },
    security: { mode: 'ratchet', count: 1, previous: null, change: null },
    deadCode: { mode: 'report', count: 3, previous: null, change: null, rules: { exports: 3 } },
  });
  assert.deepEqual(selection.notMeasured, ['mutation', 'architecture', 'bundle']);
  assert.equal(selection.judgement.slots, 0);
  assert.deepEqual(selection.riskMap, []);
  assert.equal(selection.worklist.runId, 41);
  assert.equal(selection.worklist.ageDays, 1);
});

test('selectAudit_neverCarriesAToolsMessage', () => {
  const selection = select({ worklist: fullWorklist(), maxStories: 20 });
  assert.equal(selection.selected.length, 7);
  assert.ok(!JSON.stringify(selection).includes('planted source line'));
  assert.ok(!JSON.stringify(selection).includes('ConfigureAwait'));
});

test('selectAudit_isDeterministic_whateverOrderTheItemsArriveIn', () => {
  const forward = select({ worklist: fullWorklist(), maxStories: 20 });
  const shuffled = fullWorklist();
  for (const data of Object.values(shuffled.data.checks)) if (data) data.items.reverse();
  const backward = select({ worklist: shuffled, maxStories: 20 });
  assert.deepEqual(backward.selected.map((u) => u.id), forward.selected.map((u) => u.id));
  assert.deepEqual(backward.selected.map((u) => u.score), forward.selected.map((u) => u.score));
  // Equal scores fall back to the check's order, then the id.
  const tie = select({ worklist: worklistOf({ complexity: check([hotspot('b.cs', 'B.Run', 60), hotspot('a.cs', 'A.Run', 60)]) }) });
  assert.deepEqual(tie.selected.map((u) => u.id), [...tie.selected.map((u) => u.id)].sort());
});

test('selectAudit_storyCap_isHonouredDownToZero', () => {
  assert.equal(select({ worklist: fullWorklist(), maxStories: 1 }).selected.length, 1);
  const none = select({ worklist: fullWorklist(), maxStories: 0 });
  assert.equal(none.selected.length, 0);
  assert.equal(none.excluded.overCap.count, 7);
  assert.equal(none.judgement.slots, 0);
});

test('selectAudit_dedupe_matchesAnOpenStoryByItsMarkerNotItsTitle', () => {
  const first = select({ worklist: fullWorklist() });
  const [vulnerable, semgrep, complex] = first.selected;
  const issues = [
    { number: 31, state: 'open', stateReason: null, body: `Bump it.\n\n${vulnerable.marker}\n\nFound by the audit report #30.` },
    { number: 32, state: 'closed', stateReason: 'not_planned', body: semgrep.marker },
    { number: 33, state: 'closed', stateReason: 'completed', body: complex.marker },
    { number: 34, state: 'open', stateReason: null, body: 'Split Pricing.Quote: the same words, no marker.' },
  ];
  const second = select({ worklist: fullWorklist(), issues });
  assert.deepEqual(second.excluded.tracked, [{ id: vulnerable.id, check: 'security', issue: 31 }]);
  assert.deepEqual(second.excluded.declined, [{ id: semgrep.id, check: 'semgrep', issue: 32 }]);
  // Closed as completed and still measured: it is selected again.
  assert.equal(second.selected[0].id, complex.id);
  assert.ok(!second.selected.some((u) => u.id === vulnerable.id || u.id === semgrep.id));
});

test('selectAudit_ignoreList_dropsRulesAndPathsBeforeTheyBecomeUnits', () => {
  const selection = select({
    worklist: fullWorklist(),
    maxStories: 20,
    config: config({ ignore: { rules: ['MA0004', 'CVE-2026-0002'], paths: ['apps/api/Billing/**', 'apps/web/src/*.ts'] } }),
  });
  assert.ok(!selection.selected.some((u) => u.rule === 'MA0004' || u.path === 'apps/api/Billing/Invoice.cs' || u.check === 'duplication'));
  // The package keeps its other advisory.
  const vulnerable = selection.selected.find((u) => u.check === 'security');
  assert.deepEqual(vulnerable.advisories, ['CVE-2026-0001']);
  assert.equal(vulnerable.value, 'HIGH');
  assert.equal(selection.excluded.ignored.count, 5);
  assert.deepEqual([...new Set(selection.excluded.ignored.items.map((i) => i.by))].sort(), ['path', 'rule']);
});

test('selectAudit_checkSwitchedOff_filesNothingForItAndStillReportsIt', () => {
  const selection = select({ worklist: fullWorklist(), maxStories: 20, config: config({ checks: { complexity: false, security: false } }) });
  assert.deepEqual(selection.excluded.disabled, ['complexity', 'security']);
  assert.ok(!selection.selected.some((u) => u.check === 'complexity' || u.check === 'security'));
  assert.ok(selection.excluded.notEnforced.security);
});

test('selectAudit_reportMode_filesNoStoryAndShowsItsTrend', () => {
  const worklist = worklistOf({ deadCode: fullWorklist().data.checks.deadCode });
  const first = select({ worklist });
  assert.deepEqual(first.selected, []);
  assert.equal(first.clean, true);
  assert.equal(first.runAgent, false);
  const second = select({ worklist, previous: { ...first, excluded: { notEnforced: { deadCode: { count: 1 } } } } });
  assert.deepEqual(second.excluded.notEnforced.deadCode, { mode: 'report', count: 3, previous: 1, change: 2, rules: { exports: 3 } });
  assert.match(selectionSummary(second), /Not yet enforced \(measured, no story\): deadCode 3 \(\+2\)/);
  // The same items once the check is a ratchet over its baseline: one story for the rule.
  const ratchet = structuredClone(worklist);
  ratchet.data.checks.deadCode.mode = 'ratchet';
  ratchet.data.checks.deadCode.rules.exports.over = true;
  for (const i of ratchet.data.checks.deadCode.items) i.mode = 'ratchet';
  const enforced = select({ worklist: ratchet });
  assert.deepEqual(enforced.selected.map((u) => [u.kind, u.rule, u.value, u.target, u.reasons]), [['rule', 'exports', 3, 2, ['over-baseline']]]);
});

test('selectAudit_selectsByItemMode_notByTheChecksMode', () => {
  // Steiger errors are enforced whatever the architecture section says about warnings.
  const worklist = worklistOf({
    architecture: check(
      [
        item('architecture', 'steiger-error', { rule: 'fsd/forbidden-imports', path: 'apps/web/src/a.ts', value: 1, threshold: 0, detail: { ruleCount: 1, overBaseline: true } }),
        item('architecture', 'steiger-warning', { rule: 'fsd/public-api', path: 'apps/web/src/b.ts', value: 1, mode: 'report', detail: { ruleCount: 1, overBaseline: false } }),
      ],
      { mode: 'report', rules: { 'fsd/public-api': { count: 1, baseline: null, over: false } } },
    ),
  });
  const selection = select({ worklist });
  assert.deepEqual(selection.selected.map((u) => [u.kind, u.rule, u.reasons]), [['steiger-error', 'fsd/forbidden-imports', ['failed-gate']]]);
  assert.equal(selection.excluded.notEnforced.architecture.mode, 'report');
});

test('selectAudit_regression_makesAUnitWithinItsBaselineEligible', () => {
  const worklist = worklistOf({ patterns: fullWorklist().data.checks.patterns });
  const first = select({ worklist });
  assert.deepEqual(first.selected.map((u) => u.rule), ['MA0004']);
  const id = itemId({ check: 'patterns', rule: 'CA1822' });
  assert.equal(first.checks.patterns.units[id], 4);
  const previous = structuredClone(first);
  previous.checks.patterns.units[id] = 2;
  const second = select({ worklist, previous });
  const regressed = second.selected.find((u) => u.rule === 'CA1822');
  assert.deepEqual(regressed.reasons, ['regressed']);
  assert.equal(regressed.score, 45);
});

test('selectAudit_partialWorklist_isAuditedOnWhatItHolds', () => {
  const selection = select({ worklist: worklistOf({ semgrep: fullWorklist().data.checks.semgrep }) });
  assert.equal(selection.source, 'worklist');
  assert.deepEqual(selection.selected.map((u) => u.check), ['semgrep']);
  assert.equal(selection.notMeasured.length, CHECKS.length - 1);
});

test('selectAudit_untrustworthyConfig_isFlaggedAndNeverReadsAsClean', () => {
  const unreadable = worklistOf({ deadCode: fullWorklist().data.checks.deadCode }, { unreadable: ['config'] });
  const selection = select({ worklist: unreadable });
  assert.equal(selection.trustworthy, false);
  assert.equal(selection.clean, false);
  assert.equal(selection.runAgent, false);
  assert.match(selection.problems.join('\n'), /quality\.config\.json is not valid/);
  assert.match(selectionSummary(selection), /the data cannot be trusted/);
  assert.doesNotMatch(selectionSummary(selection), /repository is clean/);
  // The checkout's own config failing to parse says the same.
  assert.equal(select({ worklist: worklistOf({}), configValid: false }).trustworthy, false);
  // What is enforced whatever the config says is still selected.
  const withFinding = select({ worklist: worklistOf({ semgrep: fullWorklist().data.checks.semgrep }, { unreadable: ['config'] }) });
  assert.equal(withFinding.trustworthy, false);
  assert.equal(withFinding.runAgent, true);
  assert.equal(withFinding.selected.length, 1);
});

test('selectAudit_noWorklistAndNoFacets_isTheExploratoryFallback', () => {
  const selection = select({});
  assert.equal(selection.source, 'none');
  assert.equal(selection.runAgent, true);
  assert.equal(selection.clean, false);
  assert.deepEqual(selection.selected, []);
  assert.match(selectionSummary(selection), /explores the repository as before/);
  // A facet a selection cannot use (sbom) is not health data to audit on.
  assert.equal(select({ facets: { sbom: { components: 3 } } }).source, 'none');
});

test('selectAudit_staleWorklist_saysSo', () => {
  const old = worklistOf({});
  old.generatedAt = '2026-10-01T00:00:00.000Z';
  assert.match(select({ worklist: old }).problems.join('\n'), /The worklist is 53 days old/);
});

// ── Facets only ──────────────────────────────────────────────────────────────────────────────────
const FACETS = {
  complexity: {
    thresholds: { cc: 10, crap: 30 },
    global: { crapOver30: 1 },
    hotspots: [{ scope: 'api', module: 'Orders', file: 'apps/api/Orders/Pricing.cs', line: 14, method: 'Pricing.Quote', cc: 20, coverage: 0.1, crap: 311.6 }],
  },
  coverage: {
    global: { lineRate: 0.6 },
    scopes: {
      'App.Domain': { lineRate: 0.6, linesValid: 100, linesCovered: 60, floor: 0.7, modules: { Orders: { lineRate: 0.5, linesValid: 40, linesCovered: 20 } } },
      'App.Api': { lineRate: 0.9, linesValid: 100, linesCovered: 90, floor: 0.8, modules: {} },
    },
  },
  mutation: {
    global: { coveredScore: 0.6, survived: 12 },
    scopes: { domain: { coveredScore: 0.6, fullScore: 0.5, survived: 12, noCoverage: 4, valid: 40, floor: 0.8, modules: { Orders: { coveredScore: 0.5, fullScore: 0.4, survived: 9, noCoverage: 2, valid: 20 } } } },
  },
  security: {
    trivy: { vuln: { CRITICAL: 1, HIGH: 2, MEDIUM: 5, LOW: 0, UNKNOWN: 0 }, fixableVulns: 2 },
    semgrep: { ERROR: 0, WARNING: 3, INFO: 1, total: 4 },
    jobs: {},
    passed: false,
  },
  hygiene: {
    thresholds: { minLines: 10 },
    deadCode: { gated: true, warnings: 0, web: { byType: { exports: 12, dependencies: 1, files: 0 }, baseline: { exports: 10 }, gate: { mode: 'ratchet' } } },
    hotspots: [{ scope: 'web', module: 'shared', file: 'apps/web/src/x.ts', duplicatedLines: 40, lines: 120 }],
    gate: { violations: 1 },
  },
};

test('facetChecks_buildsWorklistShapedChecksFromWhatTheFacetsHold', () => {
  const checks = facetChecks(FACETS, config({}, { deadCode: { mode: 'ratchet', baseline: { exports: 10 } } }));
  assert.equal(checks.complexity.items[0].path, 'apps/api/Orders/Pricing.cs');
  assert.deepEqual(checks.coverage.items.map((i) => i.kind), ['scope', 'module']);
  assert.deepEqual(checks.mutation.items.map((i) => i.kind), ['scope', 'module']);
  assert.deepEqual(checks.security.items.map((i) => [i.kind, i.value, i.mode]), [['vulnerability-count', 3, 'ratchet']]);
  assert.deepEqual(checks.semgrep.items.map((i) => [i.rule, i.value]), [['WARNING', 3]]);
  assert.deepEqual(checks.deadCode.rules, { dependencies: { count: 1, baseline: null, over: true }, exports: { count: 12, baseline: 10, over: true }, files: { count: 0, baseline: null, over: false } });
  assert.deepEqual(checks.duplication.items.map((i) => [i.path, i.value]), [['apps/web/src/x.ts', 40]]);
  assert.equal(checks.patterns, null);
});

test('selectAudit_facetsOnly_isAReducedSelectionWithNoWorklist', () => {
  const selection = select({ facets: FACETS, maxStories: 20, config: config({}, { deadCode: { mode: 'ratchet', baseline: { exports: 10 } } }) });
  assert.equal(selection.source, 'facets');
  assert.equal(selection.worklist, null);
  assert.deepEqual(selection.facets, ['complexity', 'coverage', 'mutation', 'security', 'hygiene']);
  assert.deepEqual(selection.selected.map((u) => [u.check, u.kind, u.value, u.target]), [
    ['security', 'vulnerability-count', 3, 0],
    ['complexity', 'file', 311.6, 30],
    ['semgrep', 'rule', 3, 0],
    ['coverage', 'module', 0.5, 0.7],
    ['mutation', 'module', 0.5, 0.8],
    ['deadCode', 'rule', 1, 0],
    ['deadCode', 'rule', 12, 10],
    ['duplication', 'duplicated-file', 40, 10],
  ]);
  // A count has no location; the story says which tool lists the findings.
  assert.deepEqual(selection.selected[0].files, []);
  // Some facets only: audited on those.
  const partial = select({ facets: { security: FACETS.security } });
  assert.equal(partial.source, 'facets');
  assert.deepEqual(partial.selected.map((u) => u.check), ['security', 'semgrep']);
  // A vulnerability count with nothing fixable is what the blocking scan ignores too.
  const unfixable = select({ facets: { security: { trivy: { vuln: { CRITICAL: 0, HIGH: 2 }, fixableVulns: 0 } } } });
  assert.deepEqual(unfixable.selected, []);
  assert.equal(unfixable.excluded.notEnforced.security.count, 1);
});

test('selectAudit_worklistWithoutMutation_readsTheMutationFacetForScopesAndModules', () => {
  const selection = select({ worklist: worklistOf({}), facets: { mutation: FACETS.mutation } });
  assert.equal(selection.source, 'worklist');
  assert.deepEqual(selection.selected.map((u) => [u.check, u.kind, u.symbol, u.value, u.target]), [['mutation', 'module', 'domain/Orders', 0.5, 0.8]]);
  assert.ok(!selection.notMeasured.includes('mutation'));
  // The worklist's own mutation check wins when it has one.
  const own = worklistOf({ mutation: check([]) });
  assert.deepEqual(select({ worklist: own, facets: { mutation: FACETS.mutation } }).selected, []);
});

// ── The risk map and the clean exit ──────────────────────────────────────────────────────────────
test('riskMap_isComplexPoorlyCoveredAndRecentlyChanged_rankedAndCapped', () => {
  const checks = {
    complexity: check([hotspot('a.cs', 'A.Run', 150, 0.1), hotspot('a.cs', 'A.Stop', 40, 0.6), hotspot('b.cs', 'B.Run', 60, 0.5), hotspot('c.cs', 'C.Run', 90, 1), hotspot('d.cs', 'D.Run', 90, 0.3)]),
    coverage: check([item('coverage', 'file', { path: 'b.cs', value: 0.25, threshold: 0.7, detail: { scope: 'api', module: 'B' } })]),
  };
  const all = riskMap(checks, { changes: null, limit: 5 });
  // c.cs is fully covered: complex, and not this map's business.
  assert.deepEqual(all.map((f) => [f.path, f.score, f.coverage, f.commits]), [['a.cs', 76, 0.1, null], ['d.cs', 52, 0.3, null], ['b.cs', 46, 0.25, null]]);
  assert.deepEqual(all[0].methods.map((m) => m.symbol), ['A.Run', 'A.Stop']);
  // With the history at hand, only what changed, and churn counts.
  const changed = riskMap(checks, { changes: { 'b.cs': 5, 'd.cs': 1, 'c.cs': 9 }, limit: 5 });
  assert.deepEqual(changed.map((f) => [f.path, f.score, f.commits]), [['b.cs', 66, 5], ['d.cs', 56, 1]]);
  assert.deepEqual(riskMap(checks, { changes: null, limit: 1 }).map((f) => f.path), ['a.cs']);
  assert.deepEqual(riskMap(checks, { changes: null, limit: 5, ignored: (p) => p === 'a.cs' }).map((f) => f.path), ['d.cs', 'b.cs']);
  assert.deepEqual(riskMap({}, {}), []);
});

test('selectAudit_judgementPass_getsTheFreeSlotsAndTheRiskMap', () => {
  const worklist = worklistOf({ complexity: check([hotspot('apps/api/Orders/Pricing.cs', 'Pricing.Quote', 186)]) });
  const selection = select({ worklist, changes: { 'apps/api/Orders/Pricing.cs': 2 } });
  assert.equal(selection.selected.length, 1);
  assert.deepEqual(selection.judgement, { slots: 2, days: 30, history: true });
  assert.deepEqual(selection.riskMap.map((f) => f.path), ['apps/api/Orders/Pricing.cs']);
  // Switched off, or no slot left: no risk map.
  assert.deepEqual(select({ worklist, config: config({ riskFiles: 0 }) }).riskMap, []);
  assert.deepEqual(select({ worklist, maxStories: 1 }).riskMap, []);
  assert.deepEqual(select({ worklist, config: config({ ignore: { rules: [], paths: ['apps/api/Orders/**'] } }) }).riskMap, []);
});

test('selectAudit_cleanExit_needsNothingSelectedAndAnEmptyRiskMap', () => {
  const issue = (unit) => ({ number: 9, state: 'open', stateReason: null, body: unit.marker });
  const worklist = worklistOf({ complexity: check([hotspot('apps/api/Orders/Pricing.cs', 'Pricing.Quote', 186)]) });
  const tracked = [issue(select({ worklist }).selected[0])];
  // Everything is tracked, and the risky file has not changed: clean, no agent.
  const quiet = select({ worklist, issues: tracked, changes: {} });
  assert.equal(quiet.clean, true);
  assert.equal(quiet.runAgent, false);
  assert.match(selectionSummary(quiet), /The repository is clean/);
  // Tracked, and the file changed: the judgement pass still reads it.
  const changed = select({ worklist, issues: tracked, changes: { 'apps/api/Orders/Pricing.cs': 1 } });
  assert.equal(changed.clean, false);
  assert.equal(changed.runAgent, true);
  assert.equal(changed.selected.length, 0);
  // Nothing measured over any bar.
  assert.equal(select({ worklist: worklistOf({ complexity: check([]) }) }).clean, true);
  // No data at all is never clean: that is the exploratory audit.
  assert.equal(select({}).clean, false);
});

// ── The command ──────────────────────────────────────────────────────────────────────────────────
test('auditSelectCli_offline_writesTheSelectionTheOutputsAndTheSummary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-select-'));
  try {
    const file = (name, value) => {
      writeFileSync(join(dir, name), JSON.stringify(value));
      return join(dir, name);
    };
    mkdirSync(join(dir, 'facets'));
    file('facets/mutation.json', { facet: 'mutation', data: FACETS.mutation });
    const out = join(dir, 'out', 'audit-selection.json');
    const stdout = execFileSync(
      process.execPath,
      [fileURLToPath(new URL('../audit-select.mjs', import.meta.url)), '--out', out, '--offline', '--max-stories', '2', '--worklist', file('worklist.json', fullWorklist()), '--facets', join(dir, 'facets'), '--issues', file('issues.json', []), '--changes', file('changes.json', {})],
      { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'acme/app', GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary') } },
    );
    const selection = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(selection.source, 'worklist');
    assert.equal(selection.selected.length, 2);
    assert.equal(selection.maxStories, 2);
    assert.ok(selection.excluded.overCap.items.some((u) => u.check === 'mutation'));
    assert.match(stdout, /### Audit selection/);
    assert.equal(readFileSync(join(dir, 'output'), 'utf8'), 'source=worklist\ndata_led=true\nrun_agent=true\nclean=false\nselected=2\nrisk_files=0\n');
    assert.match(readFileSync(join(dir, 'summary'), 'utf8'), /\| 1 \| security \|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auditSelectCli_offlineWithNothing_isTheFallbackAndStillSucceeds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-select-'));
  try {
    const out = join(dir, 'audit-selection.json');
    execFileSync(process.execPath, [fileURLToPath(new URL('../audit-select.mjs', import.meta.url)), '--out', out, '--offline', '--worklist', join(dir, 'missing.json')], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_REPOSITORY: '', GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: '' },
    });
    const selection = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(selection.source, 'none');
    assert.equal(selection.runAgent, true);
    assert.match(selection.problems.join('\n'), /Could not read .*missing\.json/);
    assert.match(readFileSync(join(dir, 'output'), 'utf8'), /^source=none\ndata_led=false\nrun_agent=true\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
