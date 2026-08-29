#!/usr/bin/env python3
# Managed by @plainconceptsplatform/workflows. Source: loops/actions/summarize-mutation-report/summarize.py. Update with `workflows update --force`; consumer edits may be overwritten.
"""Reduce a Stryker mutation report to the survivors, and only the survivors.

The raw report is megabytes of JSON holding every mutant, killed ones included, each with its
own copy of the source file. Handing that to an agent buries the handful of lines that matter
and burns the context window on mutants that are already dead. This writes the digest the
prompt actually reads: the score, the totals, and one compact record per surviving mutant.

Usage: summarize.py <mutation-report.json> <survivors.json>
"""

import collections
import json
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: summarize.py <mutation-report.json> <survivors.json>", file=sys.stderr)
        return 2

    report_path, out_path = sys.argv[1], sys.argv[2]
    try:
        with open(report_path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError) as err:
        print(f"could not read the mutation report: {err}", file=sys.stderr)
        return 1

    survivors: list[dict] = []
    tally: collections.Counter = collections.Counter()

    for path, entry in (data.get("files") or {}).items():
        lines = (entry.get("source") or "").splitlines()
        for mutant in entry.get("mutants") or []:
            status = mutant.get("status", "Unknown")
            tally[status] += 1
            if status != "Survived":
                continue
            line_no = ((mutant.get("location") or {}).get("start") or {}).get("line")
            original = ""
            if isinstance(line_no, int) and 0 < line_no <= len(lines):
                original = lines[line_no - 1].strip()[:200]
            survivors.append(
                {
                    "file": path,
                    "line": line_no,
                    "mutator": mutant.get("mutatorName"),
                    "original": original,
                    "replacement": (mutant.get("replacement") or "")[:200],
                }
            )

    # Stryker's own definition: timeouts count as killed, because the mutant changed behaviour
    # enough to hang. Mutants with no covering test are counted but cannot be killed.
    killed = tally.get("Killed", 0) + tally.get("Timeout", 0)
    scored = killed + tally.get("Survived", 0) + tally.get("NoCoverage", 0)
    score = round(100.0 * killed / scored, 1) if scored else None

    # Worst first: the agent keeps between three and seven, so the ordering decides which
    # gaps a person ever sees.
    survivors.sort(key=lambda item: (item["file"], item["line"] or 0))

    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(
            {"score": score, "totals": dict(tally), "survivor_count": len(survivors), "survivors": survivors},
            handle,
            indent=1,
        )

    print(f"mutation score: {score if score is not None else 'n/a'}%  survivors: {len(survivors)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
