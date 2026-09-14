// Managed by @plainconceptsplatform/workflows. Source: loops/actions/verify-app-errors/verify-app-errors.mjs. Update with workflows update --force; consumer edits may be overwritten.
//
// Executes the real grouping and redaction against rows shaped the way Application Insights
// actually returns them.
//
// It runs the shipped module rather than grepping it. The workflow-error report's logic lives
// inside a `script:` string in its action.yml, so nothing can execute it and its tests are
// greps; that was the reason to put this one in a module, and this is the payoff.

import {
  FINDING_FIELDS,
  MAX_FRAMES,
  clip,
  fingerprint,
  leaks,
  ownFrames,
  prepare,
  render,
  scrub,
  toFindings,
  unexpectedFields,
} from "../collect-app-errors/group-and-redact.mjs";

let pass = 0;
let fail = 0;

function check(label, condition, detail = "") {
  if (condition) {
    pass += 1;
    return;
  }

  fail += 1;
  console.error(`FAIL: ${label}${detail ? `\n  ${detail}` : ""}`);
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

/** A row in the shape `az monitor log-analytics query` returns, from a real exception. */
function row(overrides = {}) {
  return {
    ProblemId: "System.InvalidOperationException at Pliny.Application.Agents.RunExecutor.ExecuteAsync",
    ExceptionType: "System.InvalidOperationException",
    OperationName: "POST Runs/Start",
    AppRoleName: "plinybot-pre-app-01",
    Occurrences: 42,
    Operations: 3,
    FirstSeen: "2026-09-13T01:10:00Z",
    LastSeen: "2026-09-13T06:40:00Z",
    AnyOperationId: "6f1c1b0e9a2f4d55",
    AnyDetails: [
      {
        parsedStack: [
          { method: "Pliny.Application.Agents.RunExecutor.ExecuteAsync", fileName: "/home/vsts/work/1/s/src/RunExecutor.cs", line: 512 },
          { method: "Microsoft.AspNetCore.Routing.EndpointMiddleware.Invoke", fileName: "/_/src/Http/Routing.cs", line: 90 },
        ],
      },
    ],
    ...overrides,
  };
}

const options = { environment: "pre", lookbackHours: "24", ownCodePrefix: "Pliny" };

section("Scrubbing");

check(
  "a GUID is masked",
  scrub("run 6f1c1b0e-9a2f-4d55-8b3e-1f2a3b4c5d6e failed") === "run {guid} failed",
  scrub("run 6f1c1b0e-9a2f-4d55-8b3e-1f2a3b4c5d6e failed"));

check(
  "every GUID is masked, not just the first",
  !/[0-9a-f]{8}-[0-9a-f]{4}/i.test(scrub("a 6f1c1b0e-9a2f-4d55-8b3e-1f2a3b4c5d6e b 7f1c1b0e-9a2f-4d55-8b3e-1f2a3b4c5d6e")));

check("an email address is masked", scrub("from someone@example.com") === "from {email}");

check(
  "a build-machine path is masked",
  clip("at /home/vsts/work/1/s/src/RunExecutor.cs line 5") === "at {path} line 5",
  clip("at /home/vsts/work/1/s/src/RunExecutor.cs line 5"));

check(
  "a query string is masked but the address survives",
  clip("GET https://api.example.com/v1/items?token=abc123") === "GET https://api.example.com/v1/items?{query}",
  clip("GET https://api.example.com/v1/items?token=abc123"));

check(
  "a pattern split across a newline is still caught",
  !/example\.com/.test(scrub("mail\nto")) && clip("someone@example.com\nnext") === "{email} next",
  clip("someone@example.com\nnext"));

section("Frames");

check("only our own frames survive", ownFrames(row().AnyDetails, "Pliny").length === 1);

check(
  "a frame carries the method and never the path",
  ownFrames(row().AnyDetails, "Pliny")[0] === "Pliny.Application.Agents.RunExecutor.ExecuteAsync");

check(
  "an empty prefix publishes no frames at all",
  ownFrames(row().AnyDetails, "").length === 0);

check(
  "frames are capped",
  ownFrames(
    [{ parsedStack: Array.from({ length: 40 }, (_, i) => ({ method: `Pliny.Frame${i}` })) }],
    "Pliny",
  ).length === MAX_FRAMES);

check("a row with no details does not throw", ownFrames(undefined, "Pliny").length === 0);

section("Fingerprints");

check(
  "the same problem in the same place is the same fingerprint",
  fingerprint("a", "b", "pre") === fingerprint("a", "b", "pre"));

check(
  "the same problem in another environment is a different one",
  fingerprint("a", "b", "pre") !== fingerprint("a", "b", "pro"));

check("a fingerprint is short enough to read", fingerprint("a", "b", "pre").length === 12);

section("Thresholds");

check(
  "a finding below the floor is dropped",
  toFindings([row({ Occurrences: 2 })], { ...options, minOccurrences: 5 }).length === 0);

check(
  "a finding on the floor is kept",
  toFindings([row({ Occurrences: 5 })], { ...options, minOccurrences: 5 }).length === 1);

check(
  "the loudest comes first",
  toFindings([row({ Occurrences: 5, ProblemId: "quiet" }), row({ Occurrences: 99, ProblemId: "loud" })], options)[0]
    .problemId === "loud");

section("The field allowlist");

check(
  "a finding carries exactly the agreed fields",
  unexpectedFields(toFindings([row()], options)[0]).length === 0);

check(
  "a field nobody agreed to publish is named",
  unexpectedFields({ ...toFindings([row()], options)[0], runId: "6f1c1b0e" }).join() === "runId");

check(
  "an ordinary batch is not refused",
  prepare([row()], options).refused === "" && prepare([row()], options).prepared.length === 1);

check(
  "run_id is not a reportable field",
  !FINDING_FIELDS.includes("runId") && !FINDING_FIELDS.includes("run_id"));

section("Rendering and the scanner");

const rendered = render(toFindings([row()], options)[0], options);

check("the marker is the first line", rendered.body.startsWith("<!-- pcp-app-error: "));

check("the marker carries the fingerprint", rendered.body.includes(toFindings([row()], options)[0].fingerprint));

check("the count is said plainly", rendered.body.includes("**42 occurrence(s)**"));

check("a clean report trips nothing", leaks(`${rendered.title}\n${rendered.body}`).length === 0,
  leaks(`${rendered.title}\n${rendered.body}`).join("; "));

check(
  "no build-machine path reaches the body",
  !rendered.body.includes("/home/vsts"));

// Two ways to have no frames, and they ask the reader for different things. Pliny-Bot #191 was
// filed with OWN_CODE_PREFIX set to "Pliny" and still said the repository had not said which
// assemblies were its own -- it sent a reader to configure a knob that had been set the day
// before. Only the unconfigured case was covered here, which is why the wording survived.
check(
  "no prefix configured says which knob to set",
  render(toFindings([row()], { ...options, ownCodePrefix: "" })[0], { ...options, ownCodePrefix: "" })
    .body.includes("has not said which assemblies are its own"));

check(
  "a prefix that matched nothing does not claim the prefix is missing",
  !render(toFindings([row()], { ...options, ownCodePrefix: "NoSuchAssembly" })[0], { ...options, ownCodePrefix: "NoSuchAssembly" })
    .body.includes("has not said which assemblies are its own"));

check(
  "a prefix that matched nothing names the prefix it tried",
  render(toFindings([row()], { ...options, ownCodePrefix: "NoSuchAssembly" })[0], { ...options, ownCodePrefix: "NoSuchAssembly" })
    .body.includes("No frame in this exception belongs to `NoSuchAssembly`"));

section("Fail-closed, but not fail-dead");

const mixed = prepare(
  [row(), row({ ProblemId: "Secret", ExceptionType: "AccountKey=abc123def456;Other" })],
  options);

check("the clean report is still prepared", mixed.prepared.length === 1, JSON.stringify(mixed.withheld));

check("the tripped report is withheld", mixed.withheld.length === 1);

check("the caller is told what matched", (mixed.withheld[0]?.matched ?? []).length > 0);

check("a withheld report does not refuse the run", mixed.refused === "");

check("nothing is prepared from no rows", prepare([], options).prepared.length === 0);

check("a non-array does not throw", prepare(null, options).prepared.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
