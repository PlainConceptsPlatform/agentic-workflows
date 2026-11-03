// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/quality-config.test.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Run: node --test scripts/lib/quality-config.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQualityConfig } from './quality-config.mjs';

test('parseQualityConfig_fullConfig_returnsFloors', () => {
  const config = parseQualityConfig(JSON.stringify({
    coverage: { api: { 'App.Domain': 0.94 }, reportOnly: ['App.Api'], web: 0.64 },
    mutation: { domain: 0.82, web: 0.79 },
  }));
  assert.deepEqual(config, {
    coverage: { api: { 'App.Domain': 0.94 }, reportOnly: ['App.Api'], web: 0.64 },
    mutation: { domain: 0.82, web: 0.79 },
  });
});

test('parseQualityConfig_missingSections_defaultsToNothingGated', () => {
  assert.deepEqual(parseQualityConfig('{}'), { coverage: { api: {}, reportOnly: [], web: null }, mutation: {} });
});

test('parseQualityConfig_percentInsteadOfRate_listsEveryProblem', () => {
  assert.throws(
    () => parseQualityConfig(JSON.stringify({ coverage: { api: { 'App.Domain': 94 }, web: '64' }, mutaton: {} }), 'quality.config.json'),
    (err) => /coverage\.api\.App\.Domain must be a number between 0 and 1/.test(err.message)
      && /coverage\.web must be a number between 0 and 1/.test(err.message)
      && /mutaton is not a known setting/.test(err.message),
  );
});
