// Managed by @plainconceptsplatform/workflows. Source: loops/actions/collect-app-errors/group-and-redact.mjs. Update with workflows update --force; consumer edits may be overwritten.
//
// Turn rows from an Application Insights query into findings that are safe to write into an
// issue, or refuse.
//
// A module rather than a block of JavaScript inside an `action.yml`, and that is the point.
// The logic in `report-workflow-errors/action.yml` lives inside a `script:` string, so nothing
// can execute it and its tests are greps over the file. This one runs, so its tests run it,
// and the "replay real history" pass can be done on a laptop with no Azure at all.
//
// Pure: rows in, findings out. It reads no environment, opens no socket and files nothing.

import { createHash } from "node:crypto";

/**
 * The only fields that may reach an issue body. Anything else means nothing is filed.
 *
 * The same shape the workflow-error report uses, for the same reason: a redaction rule is a
 * filter over values and it cannot see a field somebody adds next year. An allowlist can.
 *
 * `run_id` is deliberately absent. It is the one unhashed identifier on this telemetry and it
 * joins to a conversation and to a person, so putting it in an issue is a decision somebody
 * has to take on purpose rather than by adding a line here.
 */
export const FINDING_FIELDS = [
  "exceptionType",
  "problemId",
  "operationName",
  "roleName",
  "occurrences",
  "operations",
  "firstSeen",
  "lastSeen",
  "frames",
  "fingerprint",
];

/**
 * What must never appear in a finding.
 *
 * Narrower than the upstream report's scanner, because the audience is different: this issue
 * is filed in the private repository the application belongs to, so its own name is not a
 * leak. What is still a leak is anything that identifies a customer, anything that would let
 * a reader join this back to one person's conversation, and any credential.
 */
export const LEAK_CHECKS = [
  { what: "a GUID", test: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  { what: "a connection or instrumentation string", test: /(InstrumentationKey|IngestionEndpoint|AccountKey|SharedAccessKey|Password)\s*=/i },
  { what: "a bearer token or long secret", test: /\b(eyJ[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|[A-Za-z0-9+/]{60,}={0,2})\b/ },
  { what: "an absolute path", test: /(^|[\s"'(])(\/home\/|\/Users\/|\/root\/|\/mnt\/|\/var\/|[A-Za-z]:\\)/ },
  { what: "an email address", test: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { what: "a URL with a query string", test: /https?:\/\/\S+\?\S+/ },
];

/**
 * What is masked on the way in, before anything is rendered or scanned.
 *
 * Scrubbing rather than refusing, for the things that are both common and safely
 * replaceable. An operation name that carries a GUID is ordinary -- a route that was never
 * templated, a queue name with an id in it -- and refusing the whole run over one would be a
 * workflow that is red every morning and files nothing, which is worse than one that says
 * `{guid}`. The scanner below is still there for whatever this does not catch.
 */
export const SCRUBS = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "{guid}"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "{email}"],
  [/(\/home\/|\/Users\/|\/root\/|\/mnt\/|\/var\/)[^\s"'),]*/g, "{path}"],
  [/[A-Za-z]:\\[^\s"'),]*/g, "{path}"],
  [/(https?:\/\/[^\s"'),?]+)\?[^\s"'),]*/g, "$1?{query}"],
];

/** How long a single message may be before it is cut. */
export const MAX_MESSAGE_LENGTH = 300;

/** How many stack frames are worth reading in an issue. */
export const MAX_FRAMES = 8;

/**
 * A stable name for one problem, so the same error tomorrow finds today's issue.
 *
 * The environment is in it on purpose: the same exception in pre and in pro are two different
 * pieces of news, and one closing should not silence the other.
 */
export function fingerprint(problemId, operationName, environment) {
  return createHash("sha256")
    .update(`${problemId}|${operationName}|${environment}`)
    .digest("hex")
    .slice(0, 12);
}

/**
 * The frames that belong to us.
 *
 * `Details[].parsedStack` carries our own assemblies mixed in with the framework's and with
 * whatever a package vendored. An empty prefix returns nothing at all, which is the safe
 * direction: a consumer that has not said which code is its own loses the stack rather than
 * publishing somebody else's file paths.
 */
export function ownFrames(details, prefix) {
  if (!prefix) {
    return [];
  }

  const stacks = (Array.isArray(details) ? details : []).flatMap((detail) =>
    Array.isArray(detail?.parsedStack) ? detail.parsedStack : []);

  return stacks
    .filter((frame) => typeof frame?.method === "string" && frame.method.startsWith(prefix))
    // The method alone. `frame.fileName` is an absolute path from the build machine and
    // `frame.line` without it says nothing, so neither is worth the risk.
    .map((frame) => clip(frame.method))
    .slice(0, MAX_FRAMES);
}

/** Masks everything in SCRUBS. Applied to every string before it is rendered or scanned. */
export function scrub(value) {
  return SCRUBS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

/**
 * One field, ready to publish: whitespace flattened, masked, and cut.
 *
 * Scrubbed after flattening and before cutting, so a pattern cannot be split across a line
 * break and survive, and a cut cannot leave half a GUID behind looking like ordinary hex.
 */
export function clip(value) {
  const text = scrub(String(value ?? "").replace(/\s+/g, " ").trim());
  return text.length <= MAX_MESSAGE_LENGTH ? text : `${text.slice(0, MAX_MESSAGE_LENGTH)}…`;
}

/**
 * Whether every field on this finding is one we agreed to publish.
 *
 * Returns the offending names rather than a boolean, so the caller can say which field
 * stopped the run instead of "something did".
 */
export function unexpectedFields(finding) {
  return Object.keys(finding).filter((key) => !FINDING_FIELDS.includes(key));
}

/** Which leak checks a piece of text trips. Empty means it is safe to write. */
export function leaks(text) {
  return LEAK_CHECKS.filter((check) => check.test.test(text)).map((check) => check.what);
}

/**
 * Rows from the query, as findings.
 *
 * Ordered by how often it happened, because that is the order somebody would want to fix
 * them in, and the ceiling is applied by the caller so the ones left over can be named
 * rather than silently dropped.
 */
export function toFindings(rows, { environment, ownCodePrefix = "", minOccurrences = 1, minOperations = 1 } = {}) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      exceptionType: clip(row.ExceptionType),
      problemId: clip(row.ProblemId),
      operationName: clip(row.OperationName),
      roleName: clip(row.AppRoleName),
      occurrences: Number(row.Occurrences) || 0,
      operations: Number(row.Operations) || 0,
      firstSeen: clip(row.FirstSeen),
      lastSeen: clip(row.LastSeen),
      frames: ownFrames(row.AnyDetails, ownCodePrefix),
      fingerprint: fingerprint(clip(row.ProblemId), clip(row.OperationName), environment),
    }))
    .filter((finding) => finding.occurrences >= minOccurrences && finding.operations >= minOperations)
    .sort((first, second) => second.occurrences - first.occurrences);
}

/**
 * The issue this finding becomes.
 *
 * The marker is the first line, which is what the dedupe searches for, and the body says
 * plainly that a machine wrote it: somebody reading this in six months should not have to
 * work out whether a person investigated.
 */
export function render(finding, { environment, lookbackHours }) {
  const marker = `<!-- pcp-app-error: ${finding.fingerprint} -->`;
  const title = `${finding.exceptionType} in ${finding.operationName || finding.roleName || environment}`;

  const body = [
    marker,
    `**${finding.occurrences} occurrence(s)** in the last ${lookbackHours}h in \`${environment}\`, across ${finding.operations} operation(s).`,
    "",
    `- Exception: \`${finding.exceptionType}\``,
    `- Operation: \`${finding.operationName || "(none recorded)"}\``,
    `- Role: \`${finding.roleName || "(none recorded)"}\``,
    `- First seen: ${finding.firstSeen}`,
    `- Last seen: ${finding.lastSeen}`,
    finding.frames.length > 0
      ? `\n**Our own frames, outermost first**\n\n\`\`\`\n${finding.frames.join("\n")}\n\`\`\``
      : "\n_No stack frames are shown: this repository has not said which assemblies are its own._",
    "",
    "---",
    "",
    "Filed automatically from Application Insights. Nothing here was read by a model, and no",
    "identifier that joins back to a person is included, so the reproduction is still somebody's",
    "to work out. Close this with the `error-accepted` label to stop it being filed again.",
  ].join("\n");

  return { title, body, marker };
}

/**
 * Everything the caller needs, and what it must complain about.
 *
 * Two different failures, handled two different ways.
 *
 * A field nobody agreed to publish is a change to this file that got past review, and it
 * stops everything: `refused`, nothing prepared, nothing filed. One report is not worth the
 * risk that the new field is on all of them.
 *
 * A body that still trips the scanner after scrubbing is one bad row. That report is
 * withheld and the others are prepared as usual, because a single unlucky operation name
 * must not mean the belt never hears about anything again. The caller files what it has and
 * then goes red, naming what was withheld -- the same shape the workflow-error report uses.
 */
export function prepare(rows, options) {
  const findings = toFindings(rows, options);
  const prepared = [];
  const withheld = [];

  for (const finding of findings) {
    const unexpected = unexpectedFields(finding);
    if (unexpected.length > 0) {
      return {
        refused: `a finding carries ${unexpected.join(", ")}, which is not in the reportable field list`,
        prepared: [],
        withheld: [],
      };
    }

    const issue = render(finding, options);
    const tripped = leaks(`${issue.title}\n${issue.body}`);
    if (tripped.length > 0) {
      withheld.push({ fingerprint: finding.fingerprint, matched: tripped });
      continue;
    }

    prepared.push({ ...issue, fingerprint: finding.fingerprint, occurrences: finding.occurrences });
  }

  return { refused: "", prepared, withheld };
}
