// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/quality-config.test.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Run: node --test scripts/lib/quality-config.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCheckConfig, parseQualityConfig, writeCheckSection } from './quality-config.mjs';

const CHECK_DEFAULTS = {
  deadCode: { mode: 'report', since: null, baseline: null },
  bundle: { mode: 'report', since: null, baselineBytes: null, limitBytes: null },
  architecture: { mode: 'report', since: null, baseline: null },
};

test('parseQualityConfig_fullConfig_returnsFloors', () => {
  const config = parseQualityConfig(JSON.stringify({
    coverage: { api: { 'App.Domain': 0.94 }, reportOnly: ['App.Api'], web: 0.64 },
    mutation: { domain: 0.82, web: 0.79 },
  }));
  assert.deepEqual(config, {
    coverage: { api: { 'App.Domain': 0.94 }, reportOnly: ['App.Api'], web: 0.64 },
    mutation: { domain: 0.82, web: 0.79 },
    ...CHECK_DEFAULTS,
  });
});

test('parseQualityConfig_missingSections_defaultsToNothingGated', () => {
  assert.deepEqual(parseQualityConfig('{}'), { coverage: { api: {}, reportOnly: [], web: null }, mutation: {}, ...CHECK_DEFAULTS });
});

test('parseQualityConfig_percentInsteadOfRate_listsEveryProblem', () => {
  assert.throws(
    () => parseQualityConfig(JSON.stringify({ coverage: { api: { 'App.Domain': 94 }, web: '64' }, mutaton: {} }), 'quality.config.json'),
    (err) => /coverage\.api\.App\.Domain must be a number between 0 and 1/.test(err.message)
      && /coverage\.web must be a number between 0 and 1/.test(err.message)
      && /mutaton is not a known setting/.test(err.message),
  );
});

test('parseQualityConfig_checkSections_readModeSinceAndBaselines', () => {
  const config = parseQualityConfig(JSON.stringify({
    deadCode: { mode: 'ratchet', since: '2026-11-16', baseline: { files: 2, exports: 40 } },
    bundle: { mode: 'report', since: '2026-11-16', baselineBytes: 412000, limitBytes: 453200 },
    architecture: { mode: 'ratchet', since: '2026-11-17', baseline: { 'fsd/public-api': 3 } },
  }));
  assert.deepEqual(config.deadCode, { mode: 'ratchet', since: '2026-11-16', baseline: { files: 2, exports: 40 } });
  assert.deepEqual(config.bundle, { mode: 'report', since: '2026-11-16', baselineBytes: 412000, limitBytes: 453200 });
  assert.deepEqual(config.architecture, { mode: 'ratchet', since: '2026-11-17', baseline: { 'fsd/public-api': 3 } });
});

test('parseQualityConfig_badCheckSections_listsEveryProblem', () => {
  assert.throws(
    () => parseQualityConfig(JSON.stringify({
      deadCode: { mode: 'strict', since: '16/11/2026', baseline: { files: -1 }, budget: 3 },
      bundle: { mode: 'ratchet', baselineBytes: '400kB' },
      architecture: { mode: 'report', baseline: { 'fsd/public-api': 1.5 }, errors: 0 },
    }), 'quality.config.json'),
    (err) => /deadCode\.mode must be one of report, ratchet/.test(err.message)
      && /deadCode\.since must be a date written YYYY-MM-DD/.test(err.message)
      && /deadCode\.baseline\.files must be a whole number/.test(err.message)
      && /deadCode\.budget is not a known setting/.test(err.message)
      && /bundle\.baselineBytes must be a whole number of bytes/.test(err.message)
      && /bundle\.mode is ratchet but bundle\.limitBytes is missing/.test(err.message)
      && /architecture\.baseline\.fsd\/public-api must be a whole number/.test(err.message)
      && /architecture\.errors is not a known setting/.test(err.message),
  );
});

// A ratchet with nothing to ratchet against would pass every build; it is refused instead.
test('parseQualityConfig_ratchetWithoutBaseline_isRefused', () => {
  assert.throws(() => parseQualityConfig(JSON.stringify({ deadCode: { mode: 'ratchet' } })), /deadCode\.baseline is missing/);
  assert.throws(() => parseQualityConfig(JSON.stringify({ architecture: { mode: 'ratchet' } })), /architecture\.baseline is missing: write it with `node scripts\/check-architecture\.mjs/);
});

test('loadCheckConfig_noConfigFile_isReportModeWithNoBaseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-config-'));
  try {
    assert.deepEqual(loadCheckConfig('deadCode', join(dir, 'quality.config.json')), CHECK_DEFAULTS.deadCode);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeCheckSection_keepsEveryOtherKey_andRefusesAnInvalidWrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-config-'));
  const file = join(dir, 'quality.config.json');
  try {
    writeFileSync(file, JSON.stringify({ coverage: { web: 0.6 }, mutation: { web: 0.7 } }));
    writeCheckSection('bundle', (s) => ({ ...s, mode: 'report', baselineBytes: 10, limitBytes: 11 }), file);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      coverage: { web: 0.6 },
      mutation: { web: 0.7 },
      bundle: { mode: 'report', baselineBytes: 10, limitBytes: 11 },
    });
    assert.throws(() => writeCheckSection('bundle', (s) => ({ ...s, mode: 'ratchet', limitBytes: undefined }), file), /limitBytes is missing/);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).bundle.limitBytes, 11);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
