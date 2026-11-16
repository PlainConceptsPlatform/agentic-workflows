// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/dead-code-gate.test.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Run: node --test scripts/lib/dead-code-gate.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildBaseline,
  deadCodeSummary,
  deadCodeWebData,
  evaluate,
  knipCounts,
  lowerBaseline,
} from './dead-code-gate.mjs';
import { envelope, hygieneFacetData, validateFacet } from './engineering-excellence.mjs';

const SCHEMA = JSON.parse(readFileSync(new URL('../engineering-excellence.schema.json', import.meta.url), 'utf8'));

// Shaped like `knip --reporter json` (Knip 6): one row per file with findings, one array per issue type.
const row = (file, issues) => ({
  file,
  binaries: [], catalog: [], dependencies: [], devDependencies: [], duplicates: [], enumMembers: [], exports: [],
  files: [], namespaceMembers: [], nsExports: [], nsTypes: [], optionalPeerDependencies: [], types: [], unlisted: [],
  unresolved: [],
  ...issues,
});
const REPORT = {
  issues: [
    row('apps/web/src/shared/lib/legacy.ts', { files: [{ name: 'apps/web/src/shared/lib/legacy.ts' }] }),
    row('apps/web/src/entities/order/index.ts', {
      exports: [{ name: 'orderTone', line: 4, col: 3 }, { name: 'isOrderOpen', line: 5, col: 3 }],
      types: [{ name: 'OrderDraft', line: 9, col: 13 }],
    }),
    row('apps/web/package.json', {
      dependencies: [{ name: 'left-pad', line: 20, col: 6 }],
      devDependencies: [{ name: '@testing-library/user-event', line: 40, col: 6 }],
    }),
    row('apps/web/src/features/upload/api.ts', { unlisted: [{ name: 'zod' }] }),
    // A row for a type Knip adds later must still be counted, not dropped.
    row('apps/web/src/shared/ui/index.ts', { subpaths: [{ name: './internal' }] }),
  ],
};

const REPORT_MODE = { mode: 'report', since: '2026-11-16', baseline: null };

test('knipCounts_jsonReport_countsEveryFindingPerType', () => {
  const byType = knipCounts(REPORT);
  assert.equal(byType.files, 1);
  assert.equal(byType.exports, 2);
  assert.equal(byType.types, 1);
  assert.equal(byType.dependencies, 1);
  assert.equal(byType.devDependencies, 1);
  assert.equal(byType.unlisted, 1);
  assert.equal(byType.subpaths, 1);
  // A measured zero is present, so the facet tells "none" from "not measured".
  assert.equal(byType.binaries, 0);
  assert.deepEqual(Object.keys(byType), [...Object.keys(byType)].sort());
});

test('knipCounts_notAKnipReport_throws', () => {
  assert.throws(() => knipCounts({ results: [] }), /not a Knip JSON report/);
  assert.throws(() => knipCounts([]), /not a Knip JSON report/);
});

test('deadCodeSummary_groupsTypesIntoTheFourHeadlineCounts', () => {
  assert.deepEqual(deadCodeSummary(knipCounts(REPORT)), {
    unusedFiles: 1,
    unusedExports: 3,
    unusedDependencies: 2,
    unlistedDependencies: 1,
  });
});

test('evaluate_reportMode_listsViolationsButNeverFails', () => {
  const r = evaluate(knipCounts(REPORT), REPORT_MODE);
  assert.equal(r.failed, false);
  assert.deepEqual(r.violations.map((v) => v.type).sort(), ['dependencies', 'devDependencies', 'exports', 'files', 'subpaths', 'types', 'unlisted']);
});

test('evaluate_ratchetAtBaseline_passesExceptDependencies', () => {
  const byType = knipCounts(REPORT);
  const config = { mode: 'ratchet', since: '2026-11-16', baseline: { files: 1, exports: 2, types: 1, subpaths: 1, dependencies: 5, devDependencies: 5, unlisted: 5 } };
  const r = evaluate(byType, config);
  // Dependencies fail whatever the baseline says: they are never baselined.
  assert.deepEqual(r.violations.map((v) => [v.type, v.why]), [
    ['dependencies', 'dependency'],
    ['devDependencies', 'dependency'],
    ['unlisted', 'dependency'],
  ]);
  assert.equal(r.failed, true);
  assert.equal(r.excess, 3);
});

test('evaluate_ratchetWithCleanDependencies_holdsEachTypeAtItsBaseline', () => {
  const byType = { dependencies: 0, devDependencies: 0, unlisted: 0, binaries: 0, files: 2, exports: 2, types: 0 };
  const config = { mode: 'ratchet', since: null, baseline: { files: 1, exports: 4, types: 3 } };
  const r = evaluate(byType, config);
  assert.deepEqual(r.violations, [{ type: 'files', count: 2, allowed: 1, why: 'increased' }]);
  assert.deepEqual(r.improved, ['exports', 'types']);
  assert.equal(r.failed, true);

  const fixed = evaluate({ ...byType, files: 1 }, config);
  assert.equal(fixed.failed, false);
  assert.equal(fixed.excess, 0);
});

test('evaluate_typeMissingFromBaseline_isNew', () => {
  const r = evaluate({ files: 0, enumMembers: 1 }, { mode: 'ratchet', since: null, baseline: { files: 0 } });
  assert.deepEqual(r.violations, [{ type: 'enumMembers', count: 1, allowed: 0, why: 'new' }]);
});

test('buildBaseline_leavesDependenciesAndZerosOut', () => {
  assert.deepEqual(buildBaseline(knipCounts(REPORT)), { exports: 2, files: 1, subpaths: 1, types: 1 });
});

test('lowerBaseline_onlyEverLowers', () => {
  const baseline = { files: 3, exports: 10, types: 2 };
  assert.deepEqual(lowerBaseline(baseline, { files: 5, exports: 4, types: 0, nsTypes: 7 }), { files: 3, exports: 4 });
});

test('deadCodeWebData_inTheHygieneFacet_validatesAgainstTheSchema', () => {
  const web = deadCodeWebData(REPORT, REPORT_MODE);
  assert.deepEqual(web.gate, { mode: 'report', since: '2026-11-16', violations: 8, failed: false });
  const data = hygieneFacetData({ files: [], duplicated: {}, semgrep: null, deadCodeWeb: web, thresholds: { minLines: 10, minTokens: 70 } });
  assert.equal(data.deadCode.web.unusedExports, 3);
  const doc = envelope('hygiene', data, { GITHUB_SHA: 'abc', GITHUB_RUN_ID: '1' }, new Date('2026-11-16T00:00:00Z'));
  assert.deepEqual(validateFacet(doc, SCHEMA), []);
});

test('hygieneFacetData_withoutKnip_keepsTheOldShape', () => {
  // A repository that runs no Knip publishes the facet exactly as before, so older readers accept it.
  const data = hygieneFacetData({ files: [], duplicated: {}, semgrep: null, thresholds: { minLines: 10, minTokens: 70 } });
  assert.deepEqual(data.deadCode, { gated: true, warnings: 0 });
});

test('deadCodeWebData_schemaRejectsAnUnknownMode', () => {
  const web = deadCodeWebData(REPORT, { ...REPORT_MODE, mode: 'warn' });
  const data = hygieneFacetData({ files: [], duplicated: {}, semgrep: null, deadCodeWeb: web, thresholds: { minLines: 10, minTokens: 70 } });
  const errors = validateFacet(envelope('hygiene', data, {}, new Date()), SCHEMA);
  assert.ok(errors.some((e) => /mode.*not in enum/.test(e)), errors.join('\n'));
});
