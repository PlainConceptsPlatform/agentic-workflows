#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/decide-agent-retry/classify-failure.sh. Update with `workflows update --force`; consumer edits may be overwritten.
# Say why an agent job died, when the reason is one that repeating the run fixes.
#
# Duration alone could not tell the difference. A run that dies in three minutes produced nothing;
# a run that works for forty minutes and is then killed by its machine produced nothing either, and
# was parked for the janitor's six-hourly sweep as if the agent had been wrong. Two causes are
# infrastructure, not judgement:
#
#   runner-shutdown  the VM was taken away mid-job: the process is killed with SIGTERM and GitHub
#                    annotates the job "Process completed with exit code 143" (the log has the
#                    longer "The runner has received a shutdown signal"), whatever the model was
#                    doing. 137, a SIGKILL, is left out: an out-of-memory kill repeats itself
#   cut-off          the engine was stopped one turn after it started: the last thing the log shows
#                    before the sandbox stops is the header opencode prints when it sends a request
#                    to the model, with no reply under it. The AI gateway answered nothing, or an
#                    error opencode did not surface, and the run ended with the work unsaid
#
# A tool's output in the log can quote either phrase, so neither is searched for in the body: the
# shutdown is read from the annotations, which only GitHub writes, and the cut-off from the one line
# immediately above the sandbox teardown.
#
# Usage: classify-failure.sh LOG_FILE ANNOTATIONS_FILE
# Prints one word: runner-shutdown, cut-off or none.

set -euo pipefail

log="${1:-}"
annotations="${2:-}"

if [ -n "$annotations" ] && [ -f "$annotations" ] && grep -qiE 'exit code 143|runner has received a shutdown signal|lost communication with the server|runner.*(was|has been) (deleted|terminated)' "$annotations"; then
  echo runner-shutdown
  exit 0
fi

if [ -n "$log" ] && [ -f "$log" ]; then
  # The line the sandbox teardown starts on. grep exits 1 for none, which is an answer here.
  stop=$(grep -n '\[INFO\] Stopping containers' "$log" | head -1 | cut -d: -f1 || true)
  if [ -n "$stop" ] && [ "$stop" -gt 1 ]; then
    # The last line with any text above it, ignoring the ANSI colour codes opencode wraps its
    # output in and the timestamp every runner line carries.
    last=$(sed -n "1,$((stop - 1))p" "$log" | sed -E 's/\x1b\[[0-9;]*m//g' | grep -vE '^(\S+Z )?[[:space:]]*$' | tail -1 || true)
    if printf '%s' "$last" | grep -qE '^(\S+Z )?> [A-Za-z0-9_.-]+ · [A-Za-z0-9_./:-]+[[:space:]]*$'; then
      echo cut-off
      exit 0
    fi
  fi
fi

echo none
