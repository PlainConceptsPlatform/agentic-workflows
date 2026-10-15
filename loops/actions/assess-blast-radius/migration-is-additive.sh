#!/usr/bin/env bash
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/assess-blast-radius/migration-is-additive.sh. Update with `workflows update --force`; consumer edits may be overwritten.
# Decide whether a newly added EF Core migration only adds schema. Reads the file's diff patch on
# stdin; exits 0 and prints "additive" when it does, exits 1 and prints the reason when it does not.
#
# Only Up() is read: Down() of an additive migration is all drops by construction. Anything that
# can lose or rewrite data, or a structure this cannot follow, is not additive.

set -euo pipefail

awk '
  /^\+/ { line = substr($0, 2) }
  !/^\+/ { next }
  line ~ /void[ \t]+Up[ \t]*\(/ { in_up = 1; seen_up = 1; next }
  line ~ /void[ \t]+Down[ \t]*\(/ { in_up = 0; next }
  !in_up { next }
  line ~ /\.(Drop[A-Za-z]*|Rename[A-Za-z]*|Alter[A-Za-z]*|Sql|DeleteData|UpdateData|RestartSequence)[ \t]*[(<]/ {
    match(line, /\.[A-Za-z]+[ \t]*[(<]/)
    reason = "Up() calls " substr(line, RSTART + 1, RLENGTH - 1)
    exit
  }
  line ~ /\.AddColumn[ \t]*</ { in_column = 1; column = "" }
  in_column {
    column = column " " line
    if (line ~ /\);/) {
      in_column = 0
      if (column ~ /nullable:[ \t]*false/ && column !~ /defaultValue/) {
        reason = "Up() adds a required column with no default"
        exit
      }
    }
  }
  END {
    if (reason == "" && !seen_up) reason = "no Up() method found in the added lines"
    if (reason != "") { print reason; exit 1 }
    print "additive"
  }
'
