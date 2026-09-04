#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/verify-refine-output/verify-refine-output.sh. Update with `workflows update --force`; consumer edits may be overwritten.
# Exercise real validation script so incomplete agent output cannot be applied.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR="${HERE}/../validate-refine-output/validate-refine-output.sh"
MARKER='<!-- agent-refine -->'
PREFIX='Refinement update'
TEMP_DIR="$(mktemp -d)"

trap 'rm -rf "$TEMP_DIR"' EXIT

PASS=0
FAIL=0

assert_output() {
  local label="$1"
  local expected="$2"
  local payload="$3"
  local output_file="${TEMP_DIR}/agent_output.json"
  local actual

  printf '%s' "$payload" > "$output_file"
  actual="$(bash "$VALIDATOR" "$output_file" "$MARKER" "$PREFIX" 42)"

  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' "$label" "$expected" "$actual" >&2
  fi
}

assert_output 'complete refinement is classified without labels' complete \
  '{"items":[{"type":"update_issue","item_number":42,"body":"# User story"}]}'
assert_output 'fallback-targeted refinement is complete' complete \
  '{"items":[{"type":"update_issue","body":"# User story"}]}'
assert_output 'clarification is classified without labels' questions \
  '{"items":[{"type":"add_comment","item_number":42,"body":"<!-- agent-refine -->\nRefinement update\nWhich users need this feature?"}]}'
assert_output 'agent label actions are invalid' invalid \
  '{"items":[{"type":"update_issue","item_number":42,"body":"# User story"},{"type":"add_labels","item_number":42,"labels":[{"name":"review"}]}]}'
assert_output 'single hyphen comment is invalid' invalid \
  '{"items":[{"type":"add_comment","body":"-"}]}'
assert_output 'marker and prefix alone are invalid' invalid \
  '{"items":[{"type":"add_comment","body":"<!-- agent-refine -->\nRefinement update\n---"}]}'
assert_output 'blank issue body is invalid' invalid \
  '{"items":[{"type":"update_issue","item_number":42,"body":" \n\t "}]}'
assert_output 'question with an update is complete' complete \
  '{"items":[{"type":"update_issue","item_number":42,"body":"# User story"},{"type":"add_comment","item_number":42,"body":"Which users need this feature?"}]}'
assert_output 'question with a blank update is invalid' invalid \
  '{"items":[{"type":"update_issue","item_number":42,"body":" "},{"type":"add_comment","item_number":42,"body":"Which users need this feature?"}]}'
assert_output 'wrong issue output is invalid' invalid \
  '{"items":[{"type":"add_comment","item_number":7,"body":"Which users need this feature?"}]}'
assert_output 'complete output cannot update another issue' invalid \
  '{"items":[{"type":"update_issue","item_number":42,"body":"# User story"},{"type":"update_issue","item_number":7,"body":"# Other story"}]}'

echo
if [ "$FAIL" -eq 0 ]; then
  echo "Refine output validation: ${PASS} passed"
else
  echo "Refine output validation: ${PASS} passed, ${FAIL} FAILED" >&2
fi

exit $((FAIL > 0))
