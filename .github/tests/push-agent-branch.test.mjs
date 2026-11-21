// What conclude does with the agent's push request: apply it, refuse it, or fail loudly.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const script = join(import.meta.dirname, '../../loops/actions/push-agent-branch/read-push-request.sh');
const dir = mkdtempSync(join(tmpdir(), 'push-request-'));
const bundle = join(dir, 'aw-o-r-feature-x.bundle');
writeFileSync(bundle, 'bundle');

let n = 0;
const read = (items, { bundleFile = bundle, expected = 'feature/x' } = {}) => {
  n += 1;
  const output = join(dir, `agent_output-${n}.json`);
  const githubOutput = join(dir, `github_output-${n}`);
  writeFileSync(output, JSON.stringify({ items }));
  writeFileSync(githubOutput, '');
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, OUTPUT_FILE: output, BUNDLE_FILE: bundleFile, EXPECTED_BRANCH: expected, GITHUB_OUTPUT: githubOutput },
  });
  return { status: result.status, stdout: result.stdout, written: readFileSync(githubOutput, 'utf8').trim() };
};
const push = (branch) => ({ type: 'push_to_pull_request_branch', branch });
const comment = { type: 'add_comment', body: '**Verdict:** remediated' };

test('pushRequest_withBundle_namesTheBranch', () => {
  assert.deepEqual(read([push('feature/x'), comment]).written, 'branch=feature/x');
});

test('pushRequest_noPushItem_writesNothingAndSucceeds', () => {
  const result = read([comment], { bundleFile: '' });
  assert.equal(result.status, 0);
  assert.equal(result.written, '');
});

test('pushRequest_pushWithoutBundle_failsInsteadOfSkipping', () => {
  const result = read([push('feature/x'), comment], { bundleFile: '' });
  assert.equal(result.status, 1);
  assert.equal(result.written, '');
  assert.match(result.stdout, /::error::.*carries no git bundle, so the repair could not be applied/);
});

test('pushRequest_bundlePathThatDoesNotExist_fails', () => {
  assert.equal(read([push('feature/x')], { bundleFile: join(dir, 'missing.bundle') }).status, 1);
});

test('pushRequest_otherBranch_isRefused', () => {
  const result = read([push('main')]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /may only push to 'feature\/x'/);
});

test('pushRequest_noBranchNamed_usesTheExpectedOne', () => {
  assert.equal(read([push(null)]).written, 'branch=feature/x');
  assert.equal(read([{ type: 'push_to_pull_request_branch' }]).written, 'branch=feature/x');
});

test('pushRequest_noBranchAnywhere_fails', () => {
  assert.equal(read([push(null)], { expected: '' }).status, 1);
});

test('pushRequest_duplicatePush_appliesTheFirst', () => {
  // gh-aw keeps one push item (max 1); a second one must not turn the branch into two lines.
  assert.equal(read([push('feature/x'), push('feature/x')]).written, 'branch=feature/x');
  assert.equal(read([push('feature/x'), push('main')]).written, 'branch=feature/x');
});
