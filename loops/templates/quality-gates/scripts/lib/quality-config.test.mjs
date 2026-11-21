// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/quality-config.test.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Run: node --test scripts/lib/quality-config.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUDIT_CHECKS, loadCheckConfig, parseQualityConfig, writeCheckSection } from './quality-config.mjs';
import { CHECKS } from './worklist.mjs';

const CHECK_DEFAULTS = {
  deadCode: { mode: 'report', since: null, baseline: null },
  bundle: { mode: 'report', since: null, baselineBytes: null, limitBytes: null },
  architecture: { mode: 'report', since: null, baseline: null },
  patterns: { mode: 'report', since: null, baseline: null },
  audit: {
    checks: { complexity: true, coverage: true, mutation: true, security: true, semgrep: true, deadCode: true, duplication: true, architecture: true, patterns: true, bundle: true },
    ignore: { rules: [], paths: [] },
    junk: { deadCode: ['dependencies', 'devDependencies', 'optionalPeerDependencies', 'unlisted', 'binaries'], patterns: ['AD0001'] },
    limit: null,
    riskFiles: 5,
    riskDays: 30,
    graduateAfterDays: 14,
  },
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
    patterns: { mode: 'report', since: '2026-11-18', baseline: { MA0004: 12, RCS1036: 3 } },
  }));
  assert.deepEqual(config.deadCode, { mode: 'ratchet', since: '2026-11-16', baseline: { files: 2, exports: 40 } });
  assert.deepEqual(config.bundle, { mode: 'report', since: '2026-11-16', baselineBytes: 412000, limitBytes: 453200 });
  assert.deepEqual(config.architecture, { mode: 'ratchet', since: '2026-11-17', baseline: { 'fsd/public-api': 3 } });
  assert.deepEqual(config.patterns, { mode: 'report', since: '2026-11-18', baseline: { MA0004: 12, RCS1036: 3 } });
});

test('parseQualityConfig_badCheckSections_listsEveryProblem', () => {
  assert.throws(
    () => parseQualityConfig(JSON.stringify({
      deadCode: { mode: 'strict', since: '16/11/2026', baseline: { files: -1 }, budget: 3 },
      bundle: { mode: 'ratchet', baselineBytes: '400kB' },
      architecture: { mode: 'report', baseline: { 'fsd/public-api': 1.5 }, errors: 0 },
      patterns: { mode: 'report', baseline: ['MA0004'], severity: 'warning' },
    }), 'quality.config.json'),
    (err) => /deadCode\.mode must be one of report, ratchet/.test(err.message)
      && /deadCode\.since must be a date written YYYY-MM-DD/.test(err.message)
      && /deadCode\.baseline\.files must be a whole number/.test(err.message)
      && /deadCode\.budget is not a known setting/.test(err.message)
      && /bundle\.baselineBytes must be a whole number of bytes/.test(err.message)
      && /bundle\.mode is ratchet but bundle\.limitBytes is missing/.test(err.message)
      && /architecture\.baseline\.fsd\/public-api must be a whole number/.test(err.message)
      && /architecture\.errors is not a known setting/.test(err.message)
      && /patterns\.baseline must be an object of analyzer rule -> count/.test(err.message)
      && /patterns\.severity is not a known setting/.test(err.message),
  );
});

// A ratchet with nothing to ratchet against would pass every build; it is refused instead.
test('parseQualityConfig_ratchetWithoutBaseline_isRefused', () => {
  assert.throws(() => parseQualityConfig(JSON.stringify({ deadCode: { mode: 'ratchet' } })), /deadCode\.baseline is missing/);
  assert.throws(() => parseQualityConfig(JSON.stringify({ architecture: { mode: 'ratchet' } })), /architecture\.baseline is missing: write it with `node scripts\/check-architecture\.mjs/);
  assert.throws(() => parseQualityConfig(JSON.stringify({ patterns: { mode: 'ratchet' } })), /patterns\.baseline is missing: write it with `node scripts\/check-patterns\.mjs/);
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

test('parseQualityConfig_auditSection_readsChecksIgnoreAndLimits', () => {
  const { audit } = parseQualityConfig(JSON.stringify({
    audit: { checks: { duplication: false }, ignore: { rules: [' MA0004 '], paths: ['apps/web/src/generated/**'] }, junk: { patterns: [] }, limit: 40, riskFiles: 0, riskDays: 14, graduateAfterDays: 0 },
  }));
  assert.deepEqual(audit, {
    checks: { ...CHECK_DEFAULTS.audit.checks, duplication: false },
    ignore: { rules: ['MA0004'], paths: ['apps/web/src/generated/**'] },
    junk: { deadCode: CHECK_DEFAULTS.audit.junk.deadCode, patterns: [] },
    limit: 40,
    riskFiles: 0,
    riskDays: 14,
    graduateAfterDays: 0,
  });
  assert.deepEqual(parseQualityConfig(JSON.stringify({ audit: {} })).audit, CHECK_DEFAULTS.audit);
});

test('parseQualityConfig_auditSection_listsEveryProblem', () => {
  assert.throws(
    () => parseQualityConfig(JSON.stringify({
      audit: { checks: { lint: true, coverage: 'off' }, ignore: { rules: 'MA0004', globs: [] }, limit: 500, riskFiles: -1, riskDays: 0, cap: 3, junk: { coverage: [] }, graduateAfterDays: 400 },
    })),
    (err) => /audit\.checks\.lint is not a known check/.test(err.message)
      && /audit\.checks\.coverage must be true or false/.test(err.message)
      && /audit\.ignore\.rules must be an array of non-empty strings/.test(err.message)
      && /audit\.ignore\.globs is not a known setting/.test(err.message)
      && /audit\.limit must be a whole number from 1 to 200/.test(err.message)
      && /audit\.riskFiles must be a whole number from 0 to 20/.test(err.message)
      && /audit\.riskDays must be a whole number from 1 to 365/.test(err.message)
      && /audit\.cap is not a known setting/.test(err.message)
      && /audit\.junk\.coverage is not a check the audit graduates/.test(err.message)
      && /audit\.graduateAfterDays must be a whole number from 0 to 365/.test(err.message),
  );
  assert.throws(() => parseQualityConfig(JSON.stringify({ audit: [] })), /audit must be an object/);
  assert.throws(() => parseQualityConfig(JSON.stringify({ audit: { checks: [], ignore: [] } })), /audit\.checks must be an object[\s\S]*audit\.ignore must be an object/);
});

test('AUDIT_CHECKS_areTheWorklistChecks', () => {
  assert.deepEqual(AUDIT_CHECKS, CHECKS);
});
