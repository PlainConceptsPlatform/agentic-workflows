// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/gate-cli.test.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Run: node --test scripts/lib/gate-cli.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { cliArgs, closeCountCheck, header, notMeasured, raisedKeys, updateCountBaseline, writeCountBaseline } from './gate-cli.mjs';

// Runs `fn` with console.log and console.error captured; returns what it returned and what it printed.
function captured(fn) {
  const out = [];
  const err = [];
  const log = mock.method(console, 'log', (...a) => out.push(a.join(' ')));
  const error = mock.method(console, 'error', (...a) => err.push(a.join(' ')));
  try {
    return { value: fn(), out: out.join('\n'), err: err.join('\n') };
  } finally {
    log.mock.restore();
    error.mock.restore();
  }
}

function withConfig(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cli-'));
  const file = join(dir, 'quality.config.json');
  if (content !== undefined) writeFileSync(file, JSON.stringify(content));
  try {
    return fn(file, () => JSON.parse(readFileSync(file, 'utf8')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('cliArgs_optionsAndFlags_areRead', () => {
  const { opt, flag } = cliArgs(['--report', 'knip.json', '--write-baseline']);
  assert.equal(opt('report'), 'knip.json');
  assert.equal(opt('chunks'), undefined);
  assert.equal(flag('write-baseline'), true);
  assert.equal(flag('update-baseline'), false);
});

test('header_reportAndRatchet_sayWhatFails', () => {
  assert.deepEqual(header('Dead code (Knip)', { mode: 'report', since: '2026-11-16' }, 'More fails.'), [
    '### Dead code (Knip)',
    '',
    'Mode: report-only since 2026-11-16. Never fails CI; the switch to `ratchet` is a reviewed change to quality.config.json.',
  ]);
  assert.equal(header('X', { mode: 'ratchet', since: null }, 'More fails.')[2], 'Mode: ratchet. More fails.');
});

test('notMeasured_failsOnlyARatchet', () => {
  assert.equal(captured(() => notMeasured({ mode: 'report' }, 'x missing')).value, 0);
  const ratchet = captured(() => notMeasured({ mode: 'ratchet' }, 'x missing'));
  assert.equal(ratchet.value, 1);
  assert.match(ratchet.out, /Not measured: x missing/);
});

test('raisedKeys_onlyARatchetsRaisesCount', () => {
  assert.deepEqual(raisedKeys({ mode: 'report', baseline: { a: 1 } }, { a: 9 }), []);
  assert.deepEqual(raisedKeys({ mode: 'ratchet', baseline: { a: 1, b: 3 } }, { a: 2, b: 3, c: 1 }), ['a', 'c']);
});

test('writeCountBaseline_firstBaseline_recordsModeSinceAndKeepsOtherKeys', () => {
  withConfig({ coverage: { web: 0.6 } }, (file, read) => {
    const r = captured(() => writeCountBaseline('patterns', { mode: 'report', baseline: null }, { MA0004: 3 }, { fix: 'Fix the findings' }, file));
    assert.equal(r.value, 0);
    const written = read();
    assert.deepEqual(written.coverage, { web: 0.6 });
    assert.equal(written.patterns.mode, 'report');
    assert.match(written.patterns.since, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(written.patterns.baseline, { MA0004: 3 });
    assert.match(r.out, /wrote patterns\.baseline/);
  });
});

// A script never turns a red ratchet green by raising its baseline.
test('writeCountBaseline_ratchetRaise_isRefusedAndWritesNothing', () => {
  const config = { patterns: { mode: 'ratchet', since: '2026-11-18', baseline: { MA0004: 1 } } };
  withConfig(config, (file, read) => {
    const r = captured(() => writeCountBaseline('patterns', config.patterns, { MA0004: 2 }, { fix: 'Fix the findings' }, file));
    assert.equal(r.value, 2);
    assert.match(r.err, /patterns is a ratchet and this would raise its baseline for MA0004\. Fix the findings, or lower/);
    assert.deepEqual(read(), config);
  });
});

test('updateCountBaseline_lowersOrRefusesWithoutABaseline', () => {
  const config = { architecture: { mode: 'ratchet', since: '2026-11-17', baseline: { 'fsd/public-api': 3 } } };
  withConfig(config, (file, read) => {
    const r = captured(() => updateCountBaseline('architecture', config.architecture, () => ({ 'fsd/public-api': 1 }), file));
    assert.equal(r.value, 0);
    assert.deepEqual(read().architecture.baseline, { 'fsd/public-api': 1 });
    const none = captured(() => updateCountBaseline('architecture', { mode: 'report', baseline: null }, () => ({}), file));
    assert.equal(none.value, 2);
    assert.match(none.err, /architecture\.baseline does not exist yet/);
  });
});

test('closeCountCheck_verdicts', () => {
  const describe = (v, mark) => console.log(`- ${mark} ${v.rule}`);
  const base = { improved: [], command: 'node scripts/check-patterns.mjs --sarif ee', fixHint: 'fix it', okLine: '✓ fine', describe };
  const ok = captured(() => closeCountCheck({ ...base, config: { mode: 'ratchet', baseline: { a: 2 } }, improved: ['a'], violations: [], failed: false }));
  assert.equal(ok.value, 0);
  assert.match(ok.out, /Improved below the baseline: a\. Run `node scripts\/check-patterns\.mjs --sarif ee --update-baseline`/);
  assert.match(ok.out, /✓ fine/);
  const report = captured(() => closeCountCheck({ ...base, config: { mode: 'report', baseline: null }, violations: [{ rule: 'b' }], failed: false }));
  assert.equal(report.value, 0);
  assert.match(report.out, /Over the baseline \(report-only, not failing\)/);
  assert.match(report.out, /- · b/);
  assert.match(report.out, /No baseline yet\. Record one in a pull request with `node scripts\/check-patterns\.mjs --sarif ee --write-baseline`/);
  assert.match(report.out, /· report-only: nothing fails/);
  const failed = captured(() => closeCountCheck({ ...base, config: { mode: 'ratchet', baseline: {} }, violations: [{ rule: 'b' }], failed: true }));
  assert.equal(failed.value, 1);
  assert.match(failed.out, /Violations — fix it:/);
  assert.match(failed.out, /- ✗ b/);
});
