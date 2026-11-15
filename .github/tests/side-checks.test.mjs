// The side-workflow check both merge points run before landing a pull request.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const script = join(import.meta.dirname, '../../loops/actions/land-pull-request/side-checks.sh');
const bin = mkdtempSync(join(tmpdir(), 'side-checks-'));
writeFileSync(join(bin, 'gh'), '#!/usr/bin/env bash\n[ "${STUB_FAIL:-}" = 1 ] && exit 1\necho "$STUB_RUNS"\n');
chmodSync(join(bin, 'gh'), 0o755);

const sha = '0123456789abcdef0123456789abcdef01234567';
const run = (name, status, conclusion, created) => ({ name, status, conclusion, created_at: created });
const check = (runs, env = {}) =>
  execFileSync('bash', [script, 'o/r', sha], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_RUNS: JSON.stringify(runs), ...env },
  }).trim();

test('sideChecks_failedAgenticsChecks_refusesWithTheReason', () => {
  assert.equal(check([run('App: CI', 'completed', 'success', '1'), run('Agentics checks', 'completed', 'failure', '2')]), 'Agentics checks ended failure on 0123456');
});

test('sideChecks_aGreenRerunAfterARedOne_lands', () => {
  assert.equal(check([run('Agentics checks', 'completed', 'failure', '1'), run('Agentics checks', 'completed', 'success', '2')]), '');
});

test('sideChecks_stillRunning_waits', () => {
  assert.equal(check([run('Agentics checks', 'in_progress', null, '1')]), 'Agentics checks is still running on 0123456');
});

test('sideChecks_sideWorkflowDidNotRun_lands', () => {
  assert.equal(check([run('App: CI', 'completed', 'failure', '1')]), '');
});

test('sideChecks_runsUnreadable_refuses', () => {
  assert.equal(check([], { STUB_FAIL: '1' }), 'the workflow runs on 0123456 could not be read');
});

test('sideChecks_configuredList_checksEveryNamedWorkflow', () => {
  const runs = [run('Agentics checks', 'completed', 'success', '1'), run('Docs', 'completed', 'cancelled', '2')];
  assert.equal(check(runs, { SIDE_CHECK_WORKFLOWS: 'Agentics checks, Docs' }), 'Docs ended cancelled on 0123456');
  assert.equal(check(runs, { SIDE_CHECK_WORKFLOWS: '' }), '');
});
