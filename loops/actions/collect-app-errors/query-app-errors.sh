#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/collect-app-errors/query-app-errors.sh. Update with `workflows update --force`; consumer edits may be overwritten.
#
# Ask the Log Analytics workspace what the application threw, and write the rows to a file.
#
# Two tables, both named, and never any others. `AppServiceConsoleLogs` and
# `ContainerAppConsoleLogs` sit in this same workspace and carry raw engine stdout, which is
# not governed by the no-content rule the application's own telemetry follows. A `union *`
# here would be a privacy incident rather than a wider query.
#
# `AppExceptions` alone was not enough, and the first dry run against a real workspace is what
# said so: nought exceptions in a day, on a service that had been failing all morning. Nothing
# in these applications calls RecordException or marks an activity failed. Every failure they
# actually care about is caught in code and reported through ILogger, so it lands in
# `AppTraces` at severity Error and never reaches `AppExceptions` at all. Querying only the
# exception table would have meant a report that ran green every morning and never once saw
# the thing it was built for.
#
# Workspace table names, not the classic ones. These resources are workspace-based
# (`IngestionMode: LogAnalytics`), so the table is `AppExceptions` and its columns are
# capitalised: `ProblemId`, not `problemId`. A query written against the classic schema
# returns an error, or worse, nothing.

set -euo pipefail

WORKSPACE_ID="${1:?workspace id}"
LOOKBACK_HOURS="${2:?lookback hours}"
MIN_OCCURRENCES="${3:?minimum occurrences}"
MAX_ROWS="${4:?maximum rows}"
OUTPUT="${5:?output file}"

# `sum(ItemCount)`, never `count()`.
#
# Telemetry is sampled -- 0.3 in a pre environment -- and every row carries the number of real
# events it stands for. Counting rows under-reports by roughly the inverse of the ratio, which
# is how a problem that happened two hundred times reads as sixty and falls under a floor set
# to catch it.
# Grouped on the message TEMPLATE, not the message.
#
# "Run {RunId} failed" is one problem however many runs hit it; the rendered messages are all
# different and would group into one finding each. The template is what ILogger was given and
# what Azure Monitor keeps in OriginalFormat, so it is the closest thing traces have to the
# exception table's ProblemId. Falling back to the rendered message where it is missing costs
# some grouping and loses nothing.
read -r -d '' QUERY <<KQL || true
let window = ago(${LOOKBACK_HOURS}h);
let thrown =
    AppExceptions
    | where TimeGenerated > window
    | extend Problem = ProblemId, Kind = ExceptionType, Stack = Details;
let logged =
    AppTraces
    | where TimeGenerated > window
    | where SeverityLevel >= 3
    | extend Problem = tostring(coalesce(Properties["OriginalFormat"], Message)),
             Kind    = tostring(coalesce(Properties["ExceptionType"], "LoggedError")),
             Stack   = dynamic([]);
union thrown, logged
| summarize Occurrences = sum(ItemCount),
            Operations  = dcount(OperationName),
            FirstSeen   = min(TimeGenerated),
            LastSeen    = max(TimeGenerated),
            AnyDetails  = any(Stack)
    by ProblemId = Problem, ExceptionType = Kind, OperationName, AppRoleName
| where Occurrences >= ${MIN_OCCURRENCES}
| order by Occurrences desc
| take ${MAX_ROWS}
KQL

# An empty file rather than a missing one, so the step after this always has something to
# read and says "nothing to report" rather than failing on a path that is not there.
echo '[]' > "$OUTPUT"

# A query that will not run is a warning, not a failure.
#
# The commonest reason by far is the one grant this needs: the deploy identity can create the
# workspace and cannot read it, because creating is a control-plane right and querying is a
# data-plane one. That grant arrives with an infra apply, which is a deliberate act somebody
# does later, so between installing this and applying that the job would be red every single
# morning -- and a job that is red every morning is a job somebody switches off, taking the
# working version with it.
#
# Nothing is lost by being quiet here. There is no report to withhold and no half-written
# issue: there are no rows. The reason is on the run, in the log and in the job summary.
if ! az monitor log-analytics query \
  --workspace "$WORKSPACE_ID" \
  --analytics-query "$QUERY" \
  --output json > "${OUTPUT}.tmp" 2> "${OUTPUT}.err"; then

  # The reason, without the token the CLI sometimes prints beside it.
  reason="$(sed -E 's/(Bearer|access_token|client_secret)[^ ]*/\1 [redacted]/gi' "${OUTPUT}.err" | tail -3 | tr '\n' ' ')"
  rm -f "${OUTPUT}.tmp" "${OUTPUT}.err"

  echo "::warning::The workspace could not be read, so nothing was collected. The identity needs Monitoring Reader on this workspace. ${reason}"
  exit 0
fi

mv "${OUTPUT}.tmp" "$OUTPUT"
rm -f "${OUTPUT}.err"

# Counted here rather than in the step after, so a query that returns nothing is visible in
# the log at the point it happened instead of looking like a parsing problem later.
rows="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$OUTPUT" 2>/dev/null || echo 0)"
echo "The workspace returned ${rows} grouped exception(s) over the last ${LOOKBACK_HOURS}h."
