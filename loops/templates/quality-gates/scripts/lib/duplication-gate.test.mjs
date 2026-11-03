// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/duplication-gate.test.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Run: node --test scripts/lib/duplication-gate.test.mjs
// Vendored from PlainConceptsPlatform/Atlas scripts/lib/duplication-gate.test.mjs (Atlas#1942).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBaseline, evaluate, pruneBaseline } from './duplication-gate.mjs';

const A = 'apps/api/src/App.Api/Audit/AuditEndpoints.cs';
const B = 'apps/web/src/pages/Settings.tsx';
const C = 'apps/web/src/lib/api.ts';

test('evaluate_cloneInFileOutsideBaseline_isNewViolation', () => {
  const r = evaluate({ [A]: 30, [C]: 12 }, { [A]: 30 });

  assert.deepEqual(r.violations, [{ file: C, lines: 12, baseline: null, why: 'new' }]);
  assert.equal(r.baselined, 1);
});

test('evaluate_baselinedFileGainsDuplicatedLines_isIncreasedViolation', () => {
  const r = evaluate({ [A]: 41 }, { [A]: 30 });

  assert.deepEqual(r.violations, [{ file: A, lines: 41, baseline: 30, why: 'increased' }]);
});

test('evaluate_baselinedFilesAtOrUnderBaseline_passAndReportImprovements', () => {
  const r = evaluate({ [A]: 30, [B]: 5 }, { [A]: 30, [B]: 20, [C]: 12 });

  assert.deepEqual(r.violations, []);
  assert.equal(r.baselined, 2);
  assert.deepEqual(r.fixed, [C, B], 'C lost its clones and B shrank, sorted by path');
});

test('evaluate_noClonesAndEmptyBaseline_passes', () => {
  assert.deepEqual(evaluate({}, {}), { violations: [], baselined: 0, fixed: [] });
});

test('buildBaseline_duplicatedLines_keepsOnlyFilesWithClonesSorted', () => {
  const b = buildBaseline({ [C]: 12, [A]: 30, [B]: 0 });

  assert.deepEqual(Object.entries(b), [[A, 30], [C, 12]]);
});

test('pruneBaseline_improvementsAndRegressions_onlyEverShrinks', () => {
  const pruned = pruneBaseline({ [A]: 30, [B]: 20, [C]: 12 }, { [A]: 45, [B]: 8, 'apps/web/src/new.ts': 50 });

  assert.deepEqual(pruned, { [A]: 30, [B]: 8 }, 'A is not raised, B is lowered, C is dropped, the new file is not added');
});
