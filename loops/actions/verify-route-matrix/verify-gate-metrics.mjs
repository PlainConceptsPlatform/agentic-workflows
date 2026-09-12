// Managed by @plainconceptsplatform/workflows. Source: loops/actions/verify-route-matrix/verify-gate-metrics.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Runs the housekeeping digest's gate-metrics renderer against fixtures. The auto-merge rate
// is the number the merge gate asks to be judged on, and the one Phase 7 would widen trust
// from, so "it cannot merge anything wrong" is not a reason to leave its arithmetic untested.
import { readFileSync } from "node:fs";
const yml = readFileSync(process.argv[2], "utf8").replace(/\r\n/g, "\n");

// Pull the gate metrics renderer out of the inline github-script block and run it. The counting
// loops above it need a GitHub API to exercise, but the arithmetic does not, and the arithmetic
// is the part that reports a number somebody will act on.
const start = yml.indexOf("const gateSection = () => {");
if (start === -1) { console.error("FAIL: housekeeping has no gateSection renderer"); process.exit(1); }
let depth = 0, end = start;
for (let i = yml.indexOf("{", start); i < yml.length; i++) {
  if (yml[i] === "{") depth++;
  else if (yml[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
const src = yml.slice(start, end).replace(/^\s+/gm, "  ");

const run = (dispositions, autoMerged, reverts) =>
  new Function("dispositions", "autoMerged", "reverts", "metricsWindowMs",
    `${src}; return gateSection();`)(dispositions, autoMerged, reverts, 14 * 24 * 3600000);

let failed = 0;
const check = (name, got, want) => {
  const ok = typeof want === "function" ? want(got) : got === want;
  if (!ok) { failed = 1; console.error(`FAIL: gate metrics ${name}: got ${JSON.stringify(got)}`); }
};

check("is empty when the gate has posted nothing",
  run({}, [], []), "");
check("reports the auto-merge share",
  run({ "auto-merge": 12, "human-review": 2, "owner-review": 1 }, [], []),
  (s) => s.includes("**80% auto-merged** (12 of 15 dispositions)"));
check("rounds rather than truncates",
  run({ "auto-merge": 2, "human-review": 1 }, [], []),
  (s) => s.includes("**67% auto-merged**"));
check("counts a revert only against the pull request it names",
  run({ "auto-merge": 2 }, [11, 12], [12, 99]),
  (s) => s.includes("later reverted: 1"));
check("counts no reverts when none match",
  run({ "auto-merge": 2 }, [11, 12], [77]),
  (s) => s.includes("later reverted: 0"));
check("a repository with only parked pull requests reads as zero, not as an error",
  run({ "human-review": 3 }, [], []),
  (s) => s.includes("**0% auto-merged** (0 of 3 dispositions)"));
check("lists every disposition it saw",
  run({ "auto-merge": 1, blocked: 2 }, [], []),
  (s) => s.includes("`blocked` · 2") && s.includes("`auto-merge` · 1"));


// The triage loop's entry guard. An issue carrying `stalled` is the janitor's to retry; one
// carrying `stalled` without `review` used to be skipped before any branch could see it, so it
// was neither retried nor reported. Extracted and run rather than grepped, because "which
// issues does this loop even look at" is exactly the kind of condition a grep reads past.
const guardSrc = yml.match(/if \(!labels\.includes\('review'\)[^\n]*\n/);
if (!guardSrc) { console.error("FAIL: housekeeping has no triage entry guard"); process.exit(1); }
const looksAt = (labels) => !new Function("labels", `return ${guardSrc[0].trim().replace(/^if \(/, "").replace(/\)\s*continue;$/, "")};`)(labels);

check("looks at a parked issue (review + stalled)", looksAt(["review", "stalled", "implement"]), true);
check("looks at a decided issue (review only)", looksAt(["review", "implement"]), true);
check("looks at an orphaned stall (stalled, no review)", looksAt(["stalled", "implement"]), true);
check("ignores an issue with neither", looksAt(["implement", "sp-2"]), false);
check("ignores a plain refined issue", looksAt(["refined"]), false);

process.exit(failed);
