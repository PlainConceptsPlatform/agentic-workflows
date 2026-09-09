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

  # `actions/github-script` steps carry real JavaScript inside a YAML string, and nothing on
  # the way to production parses it: not the YAML check above, not actionlint, not gh aw
  # compile. A typo there is a green push and a red run at whatever hour the schedule fires.
  # The same shape of bug shipped in a jq filter in the router and broke an hourly job in a
  # consumer for a day, so every inline script gets syntax-checked here.
  #
  # `${{ }}` is substituted before checking: it is a runner expression, not JavaScript, and
  # standing in a string literal keeps the surrounding syntax intact.
  scripts="$(python3 - "$manifest" <<'PY' 2>/dev/null || true
import re, sys, yaml, pathlib, tempfile, os

manifest = pathlib.Path(sys.argv[1])
doc = yaml.safe_load(manifest.read_text(encoding='utf-8')) or {}
out = []
for index, step in enumerate(((doc.get('runs') or {}).get('steps') or [])):
    if not isinstance(step, dict):
        continue
    if 'github-script' not in str(step.get('uses', '')):
        continue
    body = ((step.get('with') or {}).get('script'))
    if not isinstance(body, str):
        continue
    body = re.sub(r'\$\{\{[^}]*\}\}', '"__expr__"', body)
    # github-script runs the body as the content of an async function, so a top-level `return`
    # and a top-level `await` are both legal there. Wrap it the same way or every early return
    # reads as a syntax error.
    handle, path = tempfile.mkstemp(suffix='.mjs')
    with os.fdopen(handle, 'w', encoding='utf-8') as sink:
        sink.write('async function __ghScript(github, context, core, exec, io, glob, require, getOctokit) {\n')
        sink.write(body)
        sink.write('\n}\n')
    out.append('%s\t%s' % (step.get('name', 'step %d' % index), path))
print('\n'.join(out))
PY
)"

  script_ok=1
  while IFS=$'\t' read -r step_name script_file; do
    [ -n "${script_file:-}" ] || continue
    if ! node --check "$script_file" 2>/tmp/node-check.err; then
      script_ok=0
      echo "FAIL: ${rel} step '${step_name}' has a JavaScript syntax error:" >&2
      sed -n '1,6p' /tmp/node-check.err >&2
    fi
    rm -f "$script_file"
  done <<<"$scripts"
  rm -f /tmp/node-check.err

  if [ "$script_ok" -eq 0 ]; then
    FAIL=$((FAIL + 1))
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
