#!/usr/bin/env node
// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/audit-select.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// What this week's audit works on, from the repository's own health data. Runs as a plain step
// before the audit agent (agent-audit's `select` job), with no model:
//
//   node scripts/audit-select.mjs --out audit-selection.json [--max-stories 3]
//
// It reads the newest `engineering-excellence-worklist` artifact of the default branch; without one,
// the `engineering-excellence-*` facets it finds (a repository whose own CI has not adopted the
// worklist step); with neither, the selection says `source: none` and the audit explores as before.
// The mutation facet is read either way: the worklist is built where Stryker's reports are not.
// Open issues give what is already tracked (by the marker in a story's body) and, with the stories
// closed lately and the pull requests that close them, what the follow-up closes, confirms or
// reopens; the last run's selection gives what got worse, and `git log` the files that changed lately.
// It writes nothing to GitHub: the selection lists the follow-up and graduation actions, and the
// audit's `follow_up` job carries them out (actions/audit-follow-up).
//
// Needs `gh` with GH_TOKEN (actions: read, issues: read, pull-requests: read) and GITHUB_REPOSITORY. Every read is
// optional: one that fails is named in `problems` and the selection is built from the rest.
// For a run without the network, give the inputs as files:
//   [--worklist worklist.json] [--facets <dir of <facet>.json>] [--issues issues.json]
//   [--previous audit-selection.json] [--changes changes.json] [--offline]
// Settings: quality.config.json `audit` (lib/quality-config.mjs). Selection rules: lib/audit-select.mjs.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_STORIES, SELECTION_FACETS, selectAudit, selectionSummary } from './lib/audit-select.mjs';
import { CONFIG_FILE, parseQualityConfig } from './lib/quality-config.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKLIST_ARTIFACT = 'engineering-excellence-worklist';
const SELECTION_ARTIFACT = 'audit-selection';
const CLOSED_DAYS = 180;
const MAX_BUFFER = 256 * 1024 * 1024;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'offline') opts.offline = true;
    else opts[key] = argv[(i += 1)];
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.out) {
  console.error('usage: node scripts/audit-select.mjs --out <file> [--max-stories 3] — see the header of this file');
  process.exit(2);
}
const repo = process.env.GITHUB_REPOSITORY ?? '';
const offline = Boolean(opts.offline) || !repo;
const problems = [];
const json = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));

// A read that fails is a problem to report, never a crash: the audit then runs on what is left.
function attempt(what, read) {
  try {
    return read();
  } catch (error) {
    const reason = String(error.stderr || error.message || error).replace(/\s+/g, ' ').trim().slice(0, 200);
    problems.push(`Could not read ${what}: ${reason}`);
    return null;
  }
}

const gh = (args, encoding = 'utf8') => execFileSync('gh', ['api', ...args], { encoding, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });

// The newest unexpired artifact of that name, from the default branch when `branch` is given.
function newestArtifact(name, { branch = null, notRun = null } = {}) {
  const { artifacts = [] } = JSON.parse(gh([`repos/${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`]));
  return (
    artifacts
      .filter((a) => !a.expired && (!branch || a.workflow_run?.head_branch === branch) && (!notRun || String(a.workflow_run?.id) !== String(notRun)))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] ?? null
  );
}

// An artifact is a zip of one JSON file. It is printed, never unpacked: nothing in it names a path.
function artifactJson(artifact) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-select-'));
  try {
    const zip = join(dir, 'artifact.zip');
    writeFileSync(zip, gh([`repos/${repo}/actions/artifacts/${artifact.id}/zip`], 'buffer'));
    return JSON.parse(execFileSync('unzip', ['-p', zip], { encoding: 'utf8', maxBuffer: MAX_BUFFER }).replace(/^﻿/, ''));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fetchArtifact(name, filter) {
  return attempt(`the ${name} artifact`, () => {
    const artifact = newestArtifact(name, filter);
    return artifact ? artifactJson(artifact) : null;
  });
}

function readWorklist(branch) {
  if (opts.worklist) return attempt(opts.worklist, () => json(opts.worklist));
  if (offline) return null;
  const doc = fetchArtifact(WORKLIST_ARTIFACT, { branch });
  if (doc && !(doc.facet === 'worklist' && doc.data?.checks)) {
    problems.push(`The ${WORKLIST_ARTIFACT} artifact is not a worklist; it was not used.`);
    return null;
  }
  return doc;
}

// With a worklist only the mutation facet is read; without one, every facet a selection can use.
function readFacets(names, branch) {
  const facets = {};
  for (const name of names) {
    const file = opts.facets && join(opts.facets, `${name}.json`);
    let doc = null;
    if (file) doc = existsSync(file) ? attempt(file, () => json(file)) : null;
    else if (!offline) doc = fetchArtifact(`engineering-excellence-${name}`, { branch });
    if (doc?.data) facets[name] = doc.data;
  }
  return facets;
}

const issueRows = (query, filter) =>
  gh(['--paginate', `repos/${repo}/issues?${query}&per_page=100`, '--jq', `.[] | select(.pull_request | not) | ${filter} | {number, title, state, stateReason: .state_reason, closedAt: .closed_at, body}`])
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

// The pull requests that close an open story, merged or not: a story is closed on the numbers only
// once its fix is merged.
const PULLS_QUERY = 'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number merged mergedAt } } } } }';
function pullsOf(number) {
  const [owner, name] = repo.split('/');
  const out = JSON.parse(execFileSync('gh', ['api', 'graphql', '-f', `query=${PULLS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`], { encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] }));
  return out.data?.repository?.issue?.closedByPullRequestsReferences?.nodes ?? [];
}

// Open issues, and the stories closed in the last months: one closed as not planned is not filed
// again, and one closed lately is checked against the numbers. Clean-up stories for a graduating
// check carry their own marker.
function readIssues() {
  if (opts.issues) return attempt(opts.issues, () => json(opts.issues)) ?? [];
  if (offline) return [];
  const marked = 'select((.body // "") | (contains("audit-item:") or contains("audit-graduation:")))';
  const since = new Date(Date.now() - CLOSED_DAYS * 86400000).toISOString();
  const open = attempt('the open issues', () => issueRows('state=open', marked)) ?? [];
  for (const issue of open.filter((i) => String(i.body).includes('audit-item:'))) {
    issue.pulls = attempt(`the pull requests of issue ${issue.number}`, () => pullsOf(issue.number)) ?? [];
  }
  return [...open, ...(attempt('the closed issues', () => issueRows(`state=closed&since=${since}`, marked)) ?? [])];
}

// The last selection that was really computed: a run whose script failed left the fallback
// (`source: none`), which carries no snapshot, follow-up or graduation state to build on.
function readPrevious() {
  if (opts.previous) return attempt(opts.previous, () => json(opts.previous));
  if (offline) return null;
  return attempt(`the ${SELECTION_ARTIFACT} artifact`, () => {
    const { artifacts = [] } = JSON.parse(gh([`repos/${repo}/actions/artifacts?name=${SELECTION_ARTIFACT}&per_page=100`]));
    const runs = artifacts
      .filter((a) => !a.expired && String(a.workflow_run?.id) !== String(process.env.GITHUB_RUN_ID))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 5);
    for (const artifact of runs) {
      const doc = artifactJson(artifact);
      if (doc?.source && doc.source !== 'none') return doc;
    }
    return null;
  });
}

// When the measured commit was made, from the checkout's history; null when it is not at hand.
function commitTime(sha) {
  if (!/^[0-9a-f]{7,40}$/.test(String(sha ?? ''))) return null;
  try {
    const out = execFileSync('git', ['-C', REPO_ROOT, 'show', '-s', '--format=%cI', sha], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out ? new Date(out).toISOString() : null;
  } catch {
    return null;
  }
}

// Commits per file over the last `days`, or null when the checkout has no history to read.
function readChanges(days) {
  if (opts.changes) return attempt(opts.changes, () => json(opts.changes));
  try {
    const git = (args) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] });
    if (git(['rev-parse', '--is-shallow-repository']).trim() !== 'false') return null;
    const changes = {};
    for (const file of git(['log', `--since=${days} days ago`, '--name-only', '--pretty=format:', '--no-renames']).split('\n')) {
      if (file) changes[file] = (changes[file] ?? 0) + 1;
    }
    return changes;
  } catch {
    return null;
  }
}

function readConfig() {
  try {
    return { config: parseQualityConfig(existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf8') : '{}', CONFIG_FILE), configValid: true };
  } catch (error) {
    console.log(`· quality.config.json is not valid (the gates say why): ${error.message.split('\n').slice(0, 3).join(' ')}`);
    return { config: parseQualityConfig('{}', CONFIG_FILE), configValid: false };
  }
}

const { config, configValid } = readConfig();
const branch = offline ? null : (attempt('the default branch', () => JSON.parse(gh([`repos/${repo}`])).default_branch) ?? 'main');
const worklist = readWorklist(branch);
const facets = readFacets(worklist ? ['mutation'] : SELECTION_FACETS, branch);
const maxStories = Number.isInteger(Number(opts['max-stories'])) && Number(opts['max-stories']) >= 0 ? Number(opts['max-stories']) : DEFAULT_MAX_STORIES;
const selection = selectAudit({
  worklist,
  facets,
  config,
  configValid,
  issues: readIssues(),
  previous: readPrevious(),
  maxStories,
  commitTime: commitTime(worklist?.commitSha),
  changes: readChanges(config.audit.riskDays),
  problems,
});

mkdirSync(dirname(opts.out), { recursive: true });
writeFileSync(opts.out, `${JSON.stringify(selection, null, 2)}\n`);
const summary = selectionSummary(selection);
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `source=${selection.source}`,
      `data_led=${selection.source !== 'none'}`,
      `run_agent=${selection.runAgent}`,
      `clean=${selection.clean}`,
      `selected=${selection.selected.length}`,
      `risk_files=${selection.riskMap.length}`,
      `story_slots=${selection.storySlots}`,
      `follow_up=${(selection.followUp?.actions?.length ?? 0) + (selection.graduation?.actions?.length ?? 0) > 0}`,
    ].join('\n') + '\n',
  );
}
