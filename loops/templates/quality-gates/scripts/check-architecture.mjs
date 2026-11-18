#!/usr/bin/env node
// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/check-architecture.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// The web architecture check: Steiger's JSON report against quality.config.json `architecture`.
//
//   node scripts/check-architecture.mjs --report apps/web/steiger-report.json
//   node scripts/check-architecture.mjs --report apps/web/steiger-report.json --write-baseline    # first baseline
//   node scripts/check-architecture.mjs --report apps/web/steiger-report.json --update-baseline   # lower it only
//
// The report is `steiger ./src --reporter json` (Steiger 0.10+), run in apps/web. Steiger errors are not
// this script's: the web job's boundary step (the app's `lint:fsd`) already fails on any, and they are
// never baselined. Warnings are: mode `report` (the default) prints them and never fails; mode
// `ratchet` fails when a rule has more warnings than its baseline. A missing report (Steiger older
// than 0.10, or it did not run) passes in report mode and fails in ratchet mode, because a gate that
// cannot measure must not read as green.

import { existsSync, readFileSync } from 'node:fs';
import { buildBaseline, evaluate, lowerBaseline, steigerCounts } from './lib/architecture-gate.mjs';
import { cliArgs, closeCountCheck, header, notMeasured, say, updateCountBaseline, writeCountBaseline } from './lib/gate-cli.mjs';
import { loadCheckConfig } from './lib/quality-config.mjs';

const { opt, flag } = cliArgs();
const report = opt('report');
if (!report) {
  console.error('usage: node scripts/check-architecture.mjs --report <steiger-report.json> [--write-baseline | --update-baseline]');
  process.exit(2);
}

const config = loadCheckConfig('architecture');
say(...header('Architecture (Steiger)', config, 'A rule with more warnings than its baseline fails.'));

if (!existsSync(report)) {
  process.exit(notMeasured(config, `${report} is missing (Steiger did not run, or is older than 0.10 and has no JSON reporter; see the boundary step's log).`));
}

const diagnostics = JSON.parse(readFileSync(report, 'utf8'));
const { errors, warnings, byRule } = steigerCounts(diagnostics);

if (flag('write-baseline')) process.exit(writeCountBaseline('architecture', config, buildBaseline(byRule), { fix: 'Fix the warnings' }));
if (flag('update-baseline')) process.exit(updateCountBaseline('architecture', config, (baseline) => lowerBaseline(baseline, buildBaseline(byRule))));

const { violations, improved, failed } = evaluate(byRule, config);
say('', `${errors} errors · ${warnings} warnings`);
if (Object.keys(byRule).length) {
  say('', '| Steiger rule | Errors | Warnings | Warnings allowed |', '|---|---|---|---|');
  for (const [rule, r] of Object.entries(byRule)) console.log(`| ${rule} | ${r.errors} | ${r.warnings} | ${config.baseline?.[rule] ?? 0} |`);
}
if (errors > 0) {
  say('', 'Steiger errors fail the FSD boundary step, not this one, and are never baselined: fix the import or the slice.');
}

// Up to ten findings per offending rule, so a red build names what to fix.
const root = process.cwd();
const findingsOf = (rule) =>
  diagnostics
    .filter((d) => d.ruleName === rule && d.severity === 'warn')
    .map((d) => `${String(d.location?.path ?? '').replace(`${root}/`, '')}${d.location?.start?.line ? `:${d.location.start.line}` : ''}: ${d.message}`)
    .slice(0, 10);

process.exit(closeCountCheck({
  config,
  improved,
  violations,
  failed,
  command: `node scripts/check-architecture.mjs --report ${report}`,
  fixHint: 'fix the import, the public API or the slice',
  okLine: '✓ no Steiger rule over its warning baseline',
  describe: (v, mark) => {
    console.log(`- ${mark} ${v.rule}: ${v.count} (allowed ${v.allowed}) — ${v.why === 'new' ? 'not in the baseline' : 'more than the baseline'}`);
    for (const finding of findingsOf(v.rule)) console.log(`  - \`${finding}\``);
  },
}));
