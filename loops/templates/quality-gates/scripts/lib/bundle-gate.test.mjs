// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/bundle-gate.test.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Run: node --test scripts/lib/bundle-gate.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  budgetFor,
  bundleFacetData,
  bundleMeasurement,
  compressionOf,
  evaluate,
  lowerBudget,
  sizeLimitEntries,
} from './bundle-gate.mjs';
import { envelope, validateFacet } from './engineering-excellence.mjs';

const SCHEMA = JSON.parse(readFileSync(new URL('../engineering-excellence.schema.json', import.meta.url), 'utf8'));

// `size-limit --json` with @size-limit/file and no `limit` in the config.
const SIZE_LIMIT = [{ name: 'web: static export JavaScript chunks', size: 412_000 }];
const CHUNKS = [
  { file: 'app/page-1a2b.js', bytes: 18_000 },
  { file: 'framework-9f8e.js', bytes: 61_000 },
  { file: '4821-77aa.js', bytes: 61_000 },
  { file: 'main-0c0c.js', bytes: 40_000 },
];
const measurement = () => bundleMeasurement({ entries: sizeLimitEntries(SIZE_LIMIT), chunks: CHUNKS, compression: 'brotli' });

test('budgetFor_isTheBaselinePlusTenPercent_roundedUp', () => {
  assert.equal(budgetFor(412_000), 453_200);
  assert.equal(budgetFor(1001), 1102);
});

test('compressionOf_followsSizeLimitFileDefaults', () => {
  assert.equal(compressionOf({ path: 'x' }), 'brotli');
  assert.equal(compressionOf({ gzip: true }), 'gzip');
  assert.equal(compressionOf({ brotli: false }), 'none');
  assert.equal(compressionOf(undefined), 'brotli');
});

test('sizeLimitEntries_rejectsWhatIsNotSizeLimitJson', () => {
  assert.throws(() => sizeLimitEntries([]), /non-empty array/);
  assert.throws(() => sizeLimitEntries({ size: 1 }), /non-empty array/);
  assert.throws(() => sizeLimitEntries([{ name: 'x' }]), /has no size/);
});

test('bundleMeasurement_takesTheTotalFromSizeLimitAndTheLargestChunkFromTheDirectory', () => {
  const m = measurement();
  assert.equal(m.totalJsBytes, 412_000);
  // Ties break by name, so the same build always names the same chunk.
  assert.equal(m.largestChunk, '4821-77aa.js');
  assert.equal(m.largestChunkBytes, 61_000);
  assert.equal(m.chunks, 4);
});

test('bundleMeasurement_noChunks_reportsZeroNotACrash', () => {
  const m = bundleMeasurement({ entries: sizeLimitEntries(SIZE_LIMIT), chunks: [], compression: 'none' });
  assert.equal(m.largestChunk, null);
  assert.equal(m.largestChunkBytes, 0);
});

test('evaluate_reportMode_overBudget_neverFails', () => {
  const r = evaluate({ totalJsBytes: 500_000 }, { mode: 'report', since: null, baselineBytes: 412_000, limitBytes: 453_200 });
  assert.deepEqual(r, { overBudget: true, improved: false, failed: false });
});

test('evaluate_ratchet_failsOnlyAboveTheBudget', () => {
  const config = { mode: 'ratchet', since: '2026-11-16', baselineBytes: 412_000, limitBytes: 453_200 };
  assert.equal(evaluate({ totalJsBytes: 453_200 }, config).failed, false);
  assert.equal(evaluate({ totalJsBytes: 453_201 }, config).failed, true);
  assert.equal(evaluate({ totalJsBytes: 400_000 }, config).improved, true);
});

test('evaluate_noBudgetYet_isNeverOver', () => {
  assert.equal(evaluate({ totalJsBytes: 9e9 }, { mode: 'report', since: null, baselineBytes: null, limitBytes: null }).overBudget, false);
});

test('lowerBudget_onlyEverLowers', () => {
  const config = { mode: 'ratchet', since: null, baselineBytes: 412_000, limitBytes: 453_200 };
  assert.equal(lowerBudget(config, 420_000), null);
  assert.equal(lowerBudget(config, 412_000), null);
  assert.deepEqual(lowerBudget(config, 300_000), { baselineBytes: 300_000, limitBytes: 330_000 });
  assert.equal(lowerBudget({ ...config, baselineBytes: null }, 1), null);
});

test('bundleFacetData_validatesAgainstTheSchema', () => {
  const data = bundleFacetData(measurement(), { mode: 'report', since: '2026-11-16', baselineBytes: 400_000, limitBytes: 440_000 });
  assert.equal(data.overBudget, false);
  assert.deepEqual(data.gate, { mode: 'report', since: '2026-11-16', violations: 0, failed: false });
  const doc = envelope('bundle', data, { GITHUB_SHA: 'abc', GITHUB_RUN_ID: '1' }, new Date('2026-11-16T00:00:00Z'));
  assert.deepEqual(validateFacet(doc, SCHEMA), []);
});

test('bundleFacetData_ratchetOverBudget_recordsTheFailure', () => {
  const data = bundleFacetData(measurement(), { mode: 'ratchet', since: null, baselineBytes: 350_000, limitBytes: 385_000 });
  assert.deepEqual(data.gate, { mode: 'ratchet', since: null, violations: 1, failed: true });
  assert.equal(data.overBudget, true);
});
