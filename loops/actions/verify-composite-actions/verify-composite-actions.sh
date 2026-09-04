#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/verify-composite-actions/verify-composite-actions.sh. Update with `workflows update --force`; consumer edits may be overwritten.
# Validate every local composite action manifest.
#
# The runner evaluates ${{ }} everywhere in an action.yml, including inside `description:`,
# and a composite action has no `needs`, `jobs` or `secrets` context. Referencing one, even as
# documentation, fails the action at load time with "Unrecognized named-value", which surfaces
# as a one-second job failure with no other clue.
#
# `gh aw compile` does not read these files and actionlint does not lint them, so this is the
# only thing between a typo here and a runtime failure.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTIONS_DIR="${1:-$(cd "${HERE}/.." && pwd)}"

PASS=0
FAIL=0

while IFS= read -r manifest; do
  rel="${manifest#"${ACTIONS_DIR}/"}"

  if ! python3 -c "import sys, yaml; yaml.safe_load(open(sys.argv[1], encoding='utf-8'))" "$manifest" 2>/dev/null; then
    FAIL=$((FAIL + 1))
    echo "FAIL: ${rel} is not valid YAML" >&2
    continue
  fi

  # Only what is inside an expression matters; the same word in prose is fine.
  offenders="$(grep -oE '\$\{\{[^}]*\}\}' "$manifest" |
    grep -E '\b(needs|jobs|secrets)\.' || true)"

  if [ -n "$offenders" ]; then
    FAIL=$((FAIL + 1))
    echo "FAIL: ${rel} uses a context a composite action does not have:" >&2
    printf '  %s\n' "$offenders" >&2
    continue
  fi

  PASS=$((PASS + 1))
done < <(find "$ACTIONS_DIR" -name 'action.yml' | sort)

echo
if [ "$FAIL" -eq 0 ]; then
  echo "Composite action manifests: ${PASS} valid"
else
  echo "Composite action manifests: ${PASS} valid, ${FAIL} INVALID" >&2
fi

exit $((FAIL > 0))
