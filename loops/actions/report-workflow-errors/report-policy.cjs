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

/** infra, package-bug, or unknown (a cause nobody classified yet, worth a look when it repeats). */
function severityOf(patternId) {
  if (INFRA.has(patternId)) return 'infra';
  if (PACKAGE_BUG.has(patternId)) return 'package-bug';
  return 'unknown';
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
 *  - a finding seen fewer than `minOccurrences` times in the window is held: once is a blip.
 *  - at most `maxFindings` are filed per run, the most frequent first, so a bad night opens a
 *    handful of issues and not forty.
 */
function select(findings, { minOccurrences = 2, maxFindings = 5 } = {}) {
  const ranked = [...findings].sort((a, b) => b.count - a.count);
  const file = [];
  const held = [];
  for (const finding of ranked) {
    if (finding.severity === 'infra') {
      held.push({ finding, reason: 'infrastructure cause, counted not filed' });
    } else if (finding.count < minOccurrences) {
      held.push({ finding, reason: `seen ${finding.count} time(s), under the ${minOccurrences} needed to file` });
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

module.exports = { INFRA, PACKAGE_BUG, severityOf, signatureOf, markerKey, select, isQuiet, parseVersion };
