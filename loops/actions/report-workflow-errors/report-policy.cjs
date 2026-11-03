// Managed by @plainconceptsplatform/workflows. Source: loops/actions/report-workflow-errors/report-policy.cjs. Update with workflows update --force; consumer edits may be overwritten.
//
// What the error report decides, kept apart from what it reads and files so it can be run on its
// own. Pure: no network, no clock, nothing read from the repository. Everything it sees is a
// finding the report already built from package-owned names and enumerated values, so nothing
// here can widen what leaves a private repository.
//
// The report used to open one issue per job, step and classification, for every failure it saw.
// Read back over a month, 320 issues: 59% were cancelled jobs, 80% carried no diagnosis, 14% were
// a runner shut down under a job, 47% re-filed a signature seen before, every one was closed as
// not planned and none had a comment. What follows is the filter that would have kept about a
// hundred of them out of that pile and left the rest as a count in the job summary.
//
// The 11 that still got through in the week to 2026-11-03 were the next layer: 39 jobs a day failing
// gh-aw's check for an engine secret the repository never set, agent failures the worker had
// already sent back through the router and recovered, a shellcheck step failing on a pull request
// it was right to fail, and installs several minors behind reporting what a release had fixed.

'use strict';

// Causes that say something about the fleet, not about this package. They are counted in the job
// summary, where a trend is visible, and never become an issue: nobody can fix a runner that was
// taken away mid-job by editing a workflow. A job that hit its timeout is NOT here, because that
// can be the package's own work taking too long.
const INFRA = new Set([
  'runner-never-assigned',
  'runner-lost-mid-job',
  'gh-api-rate-limit',
  'model-quota',
  'model-gateway-unreachable',
  'out-of-disk',
  'out-of-memory',
]);

// Causes that belong to the repository that installed the package: a secret it never set. They are
// warned about in that repository's own job summary, where the person who can set it will look,
// and never filed upstream, where nobody can.
const CONSUMER = new Set([
  'missing-secret',
]);

// Causes that are a defect in something this package ships.
const PACKAGE_BUG = new Set([
  'jq-error',
  'yaml-or-expression-invalid',
  'lock-out-of-date',
  'action-not-found',
  'agent-produced-no-output',
  'gh-api-403',
  'gh-api-404',
  'gh-api-409-conflict',
]);

/** infra, consumer, package-bug, or unknown (a cause nobody classified yet, worth a look when it repeats). */
function severityOf(patternId) {
  if (INFRA.has(patternId)) return 'infra';
  if (CONSUMER.has(patternId)) return 'consumer';
  if (PACKAGE_BUG.has(patternId)) return 'package-bug';
  return 'unknown';
}

/**
 * Some steps say what failed by their name alone, and their log says it in words the catalogue
 * cannot safely match: gh-aw's secret check names the variable, and a pattern for that name would
 * put an engine name in a file that asserts it never reaches for a model. Step names are the
 * package's own (or gh-aw's, compiled into the package's lock files), so they are safe to read.
 */
function causeFromStep(step) {
  if (/^Validate .* secrets?$/i.test(step ?? '')) return 'missing-secret';
  if (/^Check workflow lock file$/i.test(step ?? '')) return 'lock-out-of-date';
  return null;
}

/**
 * A worker that hits a short run, a runner shutdown or a cut-off sends the work back through the
 * router (decide-agent-retry) and the next attempt usually lands. The failed agent job stays red in
 * the run that retried it, and used to be filed as if nothing had caught it. A run whose retry step
 * succeeded has had its failure answered; the attempt that finally parks does not retry, so a
 * failure the retries never got past is still counted.
 */
function wasRetried(jobs) {
  return (jobs ?? []).some((job) => (job.steps ?? []).some((step) =>
    /^Send the (work|issue) back through the router$/.test(step.name ?? '') && step.conclusion === 'success'));
}

/**
 * agentics-checks lints the repository's workflows and actions. On a pull request a red check is
 * the check doing its job on somebody's change; only on the default branch, where the package's
 * own files are what is there, can its failure be the package's.
 */
function isReviewCheck({ workflow, event }) {
  return workflow === 'agentics-checks.yml' && (event === 'pull_request' || event === 'pull_request_target');
}

/**
 * Whether the reporting install is a minor or more behind the latest release. Its failure may be
 * one the release already fixed, so it does not open an issue; it still appends to one that is
 * open. Patch versions are left alone: the fleet is rolled out the same day and a patch behind is
 * the normal state for hours after every release.
 */
function isOutdated(reporting, latest) {
  const parse = (v) => /^v?(\d+)\.(\d+)\./.exec(v ?? '')?.slice(1, 3).map(Number);
  const a = parse(reporting);
  const b = parse(latest);
  if (!a || !b) return false;
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

/**
 * The newest release among the upstream tags. Tags, not GitHub releases or the npm dist-tag: the
 * fleet is rolled out from tags, and both of the others have lagged them by several minors.
 */
function latestVersion(tags) {
  let best = '';
  for (const tag of tags ?? []) {
    if (!/^v?\d+\.\d+\.\d+$/.test(tag)) continue;
    const [a, b] = [tag, best].map((v) => v.replace(/^v/, '').split('.').map(Number));
    if (!best || a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) best = tag;
  }
  return best;
}

/**
 * One cause is one issue. A specific cause is the same defect whichever job of the router tripped
 * on it, so the job and the step are not part of its identity: conclude, safe_outputs and reserve
 * failing on one 403 are one finding, not three. A cause nobody could name is told apart by the
 * step it failed in, because that is all there is to go on.
 */
function signatureOf({ workflow, step, conclusion, patternId }) {
  if (patternId === 'unrecognised') return [workflow, step, conclusion, patternId].join('|');
  return [workflow, conclusion, patternId].join('|');
}

/** The text the upstream search matches on, so a repeat lands on the issue that already exists. */
function markerKey({ workflow, step, conclusion, patternId }) {
  return signatureOf({ workflow, step, conclusion, patternId });
}

/**
 * Which findings become issues, and why the others do not.
 *  - infra causes are held: they are a rate, not a bug.
 *  - consumer causes are held: the repository that has them is the one that can fix them.
 *  - a finding seen fewer than `minOccurrences` times in the window is held: once is a blip.
 *  - an unrecognised cause needs `minUnknown`: with no diagnosis, twice in a day was mostly a
 *    provider hiccup nobody could act on.
 *  - at most `maxFindings` are filed per run, the most frequent first, so a bad night opens a
 *    handful of issues and not forty.
 */
function select(findings, { minOccurrences = 2, minUnknown = 3, maxFindings = 5 } = {}) {
  const ranked = [...findings].sort((a, b) => b.count - a.count);
  const file = [];
  const held = [];
  const neededFor = (finding) => (finding.severity === 'unknown' ? Math.max(minOccurrences, minUnknown) : minOccurrences);
  for (const finding of ranked) {
    if (finding.severity === 'infra') {
      held.push({ finding, reason: 'infrastructure cause, counted not filed' });
    } else if (finding.severity === 'consumer') {
      held.push({ finding, reason: "this repository's own configuration, warned here not filed" });
    } else if (finding.count < neededFor(finding)) {
      const needed = neededFor(finding);
      held.push({ finding, reason: `seen ${finding.count} time(s), under the ${needed} needed to file` });
    } else if (file.length >= maxFindings) {
      held.push({ finding, reason: `over the ${maxFindings} filed per run` });
    } else {
      file.push(finding);
    }
  }
  return { file, held };
}

/**
 * A signature closed recently stays quiet. Closing an issue is the answer to it; the report used
 * to search open issues only, so every bulk close reopened the whole set the next morning.
 */
function isQuiet(closedAt, now, quietDays = 30) {
  if (!closedAt) return false;
  const closed = new Date(closedAt).getTime();
  if (Number.isNaN(closed)) return false;
  return now - closed < quietDays * 24 * 3600 * 1000;
}

/**
 * The package version out of the ownership header. The character class used to swallow the
 * full stop that ends the sentence, so every report said `1.2.3.`.
 */
function parseVersion(header) {
  const match = /@plainconceptsplatform\/workflows@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]*[0-9A-Za-z])?)/.exec(header ?? '');
  return match ? match[1] : 'unknown';
}

module.exports = {
  INFRA, CONSUMER, PACKAGE_BUG, severityOf, causeFromStep, wasRetried, isReviewCheck, isOutdated, latestVersion,
  signatureOf, markerKey, select, isQuiet, parseVersion,
};
