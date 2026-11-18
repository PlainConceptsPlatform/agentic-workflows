#!/usr/bin/env node
// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/check-dead-code.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// The web dead-code check: Knip's JSON report against quality.config.json `deadCode`.
//
//   node scripts/check-dead-code.mjs --report apps/web/knip-report.json
//   node scripts/check-dead-code.mjs --report apps/web/knip-report.json --write-baseline    # first baseline
//   node scripts/check-dead-code.mjs --report apps/web/knip-report.json --update-baseline   # lower it only
//
// Mode `report` (the default) prints the counts and never fails. Mode `ratchet` fails when a Knip issue
// type has more findings than its baseline, or when there is any unused or unlisted dependency. A
// report that is missing (Knip crashed or was not run) passes in report mode and fails in ratchet mode,
// because a gate that cannot measure must not read as green.

import { existsSync, readFileSync } from 'node:fs';
import {
  ZERO_TOLERANCE_TYPES,
  buildBaseline,
  deadCodeSummary,
  evaluate,
  knipCounts,
  lowerBaseline,
} from './lib/dead-code-gate.mjs';
import { cliArgs, closeCountCheck, header, notMeasured, say, updateCountBaseline, writeCountBaseline } from './lib/gate-cli.mjs';
import { loadCheckConfig } from './lib/quality-config.mjs';

const { opt, flag } = cliArgs();
const report = opt('report');
if (!report) {
  console.error('usage: node scripts/check-dead-code.mjs --report <knip.json> [--write-baseline | --update-baseline]');
  process.exit(2);
}

const config = loadCheckConfig('deadCode');
say(...header('Dead code (Knip)', config, 'More findings than the baseline, or any unused or unlisted dependency, fails.'));

if (!existsSync(report)) {
  process.exit(notMeasured(config, `${report} is missing (Knip did not run or did not finish; see the step log).`));
}

const knip = JSON.parse(readFileSync(report, 'utf8'));
const byType = knipCounts(knip);

if (flag('write-baseline')) process.exit(writeCountBaseline('deadCode', config, buildBaseline(byType), { fix: 'Fix the findings' }));
if (flag('update-baseline')) process.exit(updateCountBaseline('deadCode', config, (baseline) => lowerBaseline(baseline, byType)));

const { violations, improved, failed } = evaluate(byType, config);
const summary = deadCodeSummary(byType);
say('', `${summary.unusedFiles} unused files · ${summary.unusedExports} unused exports · ${summary.unusedDependencies} unused dependencies · ${summary.unlistedDependencies} unlisted dependencies`);
say('', '| Knip issue type | Findings | Allowed |', '|---|---|---|');
for (const [type, count] of Object.entries(byType)) {
  if (count === 0 && !(config.baseline?.[type] > 0)) continue;
  const allowed = ZERO_TOLERANCE_TYPES.includes(type) ? '0 (dependency)' : String(config.baseline?.[type] ?? 0);
  console.log(`| ${type} | ${count} | ${allowed} |`);
}

// Up to ten findings per offending type, so a red build names what to delete.
const namesOf = (type) =>
  knip.issues.flatMap((row) => (Array.isArray(row[type]) ? row[type].map((f) => `${row.file}${f?.name && f.name !== row.file ? `: ${f.name}` : ''}`) : [])).slice(0, 10);

process.exit(closeCountCheck({
  config,
  improved,
  violations,
  failed,
  command: `node scripts/check-dead-code.mjs --report ${report}`,
  fixHint: 'delete the dead code, or remove the dependency',
  okLine: '✓ no Knip issue type over its baseline',
  describe: (v, mark) => {
    const why = v.why === 'dependency' ? 'unused or unlisted dependencies are never baselined' : v.why === 'new' ? 'not in the baseline' : 'more than the baseline';
    console.log(`- ${mark} ${v.type}: ${v.count} (allowed ${v.allowed}) — ${why}`);
    for (const name of namesOf(v.type)) console.log(`  - \`${name}\``);
  },
}));
