#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/assess-blast-radius/assess-blast-radius.sh. Update with `workflows update --force`; consumer edits may be overwritten.
# Classify a pull request's blast radius from its changed paths and diff shape.
#
# Reads the changed paths on stdin, one per line. Prints GITHUB_OUTPUT lines on stdout.
# Deliberately model-free: the point of this file is that the most consequential input to the
# merge decision is computed from facts a shell can check, before any agent reads the diff.
#
# Usage: assess-blast-radius.sh <files_changed> <lines_changed> < paths
# Regexes and thresholds arrive in the environment so the caller and the tests share one contract.

set -euo pipefail

files_changed="${1:-0}"
lines_changed="${2:-0}"

PROTECTED_PATHS="${PROTECTED_PATHS:-}"
OWNER_PATHS="${OWNER_PATHS:-}"
SENSITIVE_PATHS="${SENSITIVE_PATHS:-}"
HIGH_FILES="${HIGH_FILES:-20}"
HIGH_LINES="${HIGH_LINES:-800}"
MEDIUM_FILES="${MEDIUM_FILES:-5}"
MEDIUM_LINES="${MEDIUM_LINES:-200}"

files="$(cat)"

# An empty regex matches every line in grep -E, which would mark every pull request protected.
# A list nobody configured must match nothing, not everything.
#
# The `|| true` that used to end this function swallowed grep exit 2 (a regex that does not
# compile) exactly as it swallowed exit 1 (no match), so a consumer typo in PROTECTED_PATHS
# reported "no protected paths touched" and merged. Consumers are told to edit all three of
# these, so the typo is the likely case. Each pattern is compiled once below, in this shell,
# before any of them is used: a `match` failure cannot report itself, because `match` runs
# inside a command substitution and anything it sets dies with the subshell.
match() {
  local pattern="$1"
  [ -n "$pattern" ] || return 0
  printf '%s\n' "$files" | grep -E "$pattern" || true
}

# Compile each configured pattern against nothing. grep exits 2 when the regex is bad, which is
# distinct from 1 for no match, and that is the whole signal.
for name in PROTECTED_PATHS OWNER_PATHS SENSITIVE_PATHS; do
  pattern="${!name}"
  [ -n "$pattern" ] || continue
  if printf '' | grep -E "$pattern" >/dev/null 2>&1; then :; elif [ "$?" -gt 1 ]; then
    echo "assess-blast-radius: ${name} is not a valid extended regular expression: ${pattern}" >&2
    exit 2
  fi
done

protected_hits="$(match "$PROTECTED_PATHS")"
owner_hits="$(match "$OWNER_PATHS")"
sensitive_hits="$(match "$SENSITIVE_PATHS")"

# A threshold that is not a number turns its comparison into a shell error that `set -e` does
# not catch, because the test is an `if` condition: `HIGH_FILES=twenty` printed a diagnostic to
# stderr and quietly produced `level=low` for a diff of any size.
for threshold in HIGH_FILES HIGH_LINES MEDIUM_FILES MEDIUM_LINES files_changed lines_changed; do
  case "${!threshold}" in
    ""|*[!0-9]*)
      echo "assess-blast-radius: ${threshold} must be a whole number, got '${!threshold}'" >&2
      exit 2
      ;;
  esac
done

signals=""
add_signal() { signals="${signals}${signals:+$'\n'}$1"; }

level=low

if [ -n "$protected_hits" ]; then
  level=high
  add_signal "protected paths touched ($(printf '%s\n' "$protected_hits" | tr '\n' ' ' | sed 's/ $//'))"
fi

if [ -n "$owner_hits" ]; then
  level=high
  add_signal "owner paths touched ($(printf '%s\n' "$owner_hits" | tr '\n' ' ' | sed 's/ $//'))"
fi

if [ "$files_changed" -ge "$HIGH_FILES" ]; then
  level=high
  add_signal "$files_changed files changed, at or above the high threshold of $HIGH_FILES"
fi

if [ "$lines_changed" -ge "$HIGH_LINES" ]; then
  level=high
  add_signal "$lines_changed lines changed, at or above the high threshold of $HIGH_LINES"
fi

if [ "$level" != high ]; then
  if [ -n "$sensitive_hits" ]; then
    level=medium
    add_signal "sensitive paths touched ($(printf '%s\n' "$sensitive_hits" | tr '\n' ' ' | sed 's/ $//'))"
  fi
  if [ "$files_changed" -ge "$MEDIUM_FILES" ]; then
    level=medium
    add_signal "$files_changed files changed, at or above the medium threshold of $MEDIUM_FILES"
  fi
  if [ "$lines_changed" -ge "$MEDIUM_LINES" ]; then
    level=medium
    add_signal "$lines_changed lines changed, at or above the medium threshold of $MEDIUM_LINES"
  fi
fi

[ -n "$signals" ] || signals="no blast-radius signal fired: $files_changed files, $lines_changed lines, no configured path matched"

# A fixed heredoc delimiter is a fail-open here. Every multi-line value below is built from
# paths the pull request chose, so a path that is exactly the delimiter closes its block early
# and every line after it is read as a new output -- including `level=low`, which is emitted
# above and would be overridden by the later value. The shipped regexes cannot match a bare
# delimiter, but a consumer who writes a loose one can, and the failure is silent and merges.
# A per-run delimiter removes the class rather than the instance, which is what GitHub
# documents for exactly this reason.
DELIM="BLASTEOF_$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"

emit_block() {
  local name="$1" value="$2"
  printf '%s<<%s\n%s\n%s\n' "$name" "$DELIM" "$value" "$DELIM"
}

echo "level=$level"
echo "files_changed=$files_changed"
echo "lines_changed=$lines_changed"
echo "requires_review=$([ -n "$protected_hits" ] && echo true || echo false)"
emit_block signals "$signals"
emit_block files "$protected_hits"
emit_block owner_hits "$owner_hits"
emit_block sensitive_hits "$sensitive_hits"
