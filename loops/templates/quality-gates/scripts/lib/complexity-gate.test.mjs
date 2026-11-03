// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/complexity-gate.test.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Run: node --test scripts/lib/complexity-gate.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBaseline, evaluate, justification, pruneBaseline } from './complexity-gate.mjs';
import { scoreMethods } from './engineering-excellence.mjs';

const m = (method, cc, coverage, file = 'apps/api/src/App.Domain/Renting/Contract.cs', line = 10) =>
  scoreMethods([{ scope: 'App.Domain', module: 'Renting', file, method, line, cc, coverage }])[0];

test('evaluate_newMethodAboveCcCap_isViolationEvenWhenFullyCovered', () => {
  const { violations } = evaluate([m('Contract.Price', 16, 1)], {});

  assert.equal(violations.length, 1);
  assert.equal(violations[0].why, 'new');
  assert.equal(violations[0].crap, 16);
});

test('evaluate_newMethodUnderCcCapButUntested_isViolationOnCrap', () => {
  // CC 12 at 0% coverage: 144 + 12 = 156 > 30.
  const { violations } = evaluate([m('Contract.Renew', 12, 0)], {});

  assert.deepEqual(violations.map((v) => [v.method, v.crap]), [['Contract.Renew', 156]]);
});

test('evaluate_complexMethodTestedInProportion_passes', () => {
  // CC 12 at 60% coverage: 144 * 0.064 + 12 = 21.2 <= 30.
  const r = evaluate([m('Contract.Renew', 12, 0.6), m('Contract.Id', 1, 0)], {});

  assert.deepEqual(r.violations, []);
});

test('evaluate_baselinedMethodUnchanged_passesAndCountsAsBacklog', () => {
  const method = m('Contract.Parse', 40, 0.5);
  const r = evaluate([method], { [`${method.file}::Contract.Parse`]: { cc: 40, crap: method.crap } });

  assert.deepEqual(r.violations, []);
  assert.equal(r.baselined, 1);
});

test('evaluate_baselinedMethodMoreComplex_isViolation', () => {
  const method = m('Contract.Parse', 41, 0.5);
  const { violations } = evaluate([method], { [`${method.file}::Contract.Parse`]: { cc: 40, crap: 9999 } });

  assert.equal(violations[0].why, 'cc-increased');
  assert.deepEqual(violations[0].baseline, { cc: 40, crap: 9999 });
});

test('evaluate_baselinedMethodLostCoverageBeyondTolerance_isViolation', () => {
  const method = m('Contract.Parse', 20, 0.4); // CRAP 106.4
  const key = `${method.file}::Contract.Parse`;

  assert.equal(evaluate([method], { [key]: { cc: 20, crap: 105.5 } }).violations.length, 0, 'within the 1-point tolerance');
  assert.equal(evaluate([method], { [key]: { cc: 20, crap: 100 } }).violations[0].why, 'crap-increased');
});

test('evaluate_justifiedMethod_isExemptAndReported', () => {
  const method = m('Contract.Route', 18, 1, 'apps/web/src/lib/route.ts', 4);
  const source = ['', '// complexity-justified: exhaustive status table, splitting hides it (#1941)', '', 'export function route() {'];

  const r = evaluate([method], {}, () => source);

  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.justified.map((j) => [j.method, j.issue]), [['Contract.Route', 1941]]);
});

test('justification_commentWithoutIssueOrTooFarAbove_isIgnored', () => {
  const lines = ['// complexity-justified: trust me', 'a', 'b', 'c', 'd', 'e', 'f', 'fn()'];
  assert.equal(justification(lines, 8), null, 'no (#issue)');
  const far = ['// complexity-justified: ok (#1)', 'a', 'b', 'c', 'd', 'e', 'fn()'];
  assert.equal(justification(far, 7), null, 'more than 5 lines above');
  assert.deepEqual(justification(far, 6), { reason: 'ok', issue: 1 });
});

test('evaluate_baselineEntriesNoLongerViolating_areReportedFixed', () => {
  const tested = m('Contract.Parse', 12, 1);
  const r = evaluate([tested], {
    [`${tested.file}::Contract.Parse`]: { cc: 12, crap: 156 },
    'apps/web/src/gone.ts::removed': { cc: 30, crap: 900 },
  });

  assert.deepEqual(r.fixed, ['apps/api/src/App.Domain/Renting/Contract.cs::Contract.Parse', 'apps/web/src/gone.ts::removed']);
});

test('buildBaseline_overloads_keepsOnlyViolatorsAtTheirWorst', () => {
  const b = buildBaseline([m('Contract.Parse', 20, 0), m('Contract.Parse', 25, 0), m('Contract.Id', 1, 0)]);

  assert.deepEqual(b, { 'apps/api/src/App.Domain/Renting/Contract.cs::Contract.Parse': { cc: 25, crap: 650 } });
});

test('pruneBaseline_improvementsAndRegressions_onlyEverShrinks', () => {
  const key = (name) => `apps/api/src/App.Domain/Renting/Contract.cs::${name}`;
  const baseline = {
    [key('Improved')]: { cc: 30, crap: 900 },
    [key('Worse')]: { cc: 20, crap: 100 },
    [key('Fixed')]: { cc: 16, crap: 16 },
  };

  const pruned = pruneBaseline(baseline, [m('Improved', 25, 1), m('Worse', 22, 0), m('Fixed', 10, 1), m('Brand', 50, 0)]);

  assert.deepEqual(pruned, {
    [key('Improved')]: { cc: 25, crap: 25 },
    [key('Worse')]: { cc: 20, crap: 100 },
  });
});
