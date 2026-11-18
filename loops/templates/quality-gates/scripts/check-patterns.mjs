#!/usr/bin/env node
// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/check-patterns.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// The .NET code-patterns check: the compiler's SARIF error logs against quality.config.json `patterns`.
//
//   node scripts/check-patterns.mjs --sarif ee/dotnet-analyzers
//   node scripts/check-patterns.mjs --sarif ee/dotnet-analyzers --write-baseline    # first baseline
//   node scripts/check-patterns.mjs --sarif ee/dotnet-analyzers --update-baseline   # lower it only
//
// `--sarif` is one SARIF file or a directory of them: the api job's build writes one per project
// (`dotnet-analyzers.sarif`, `-p:ErrorLog=dotnet-analyzers.sarif%2Cversion%3D2.1`) and uploads them as
// the `dotnet-analyzers` artifact. The analyzers are the app's own package references (Meziantou.Analyzer,
// Roslynator.Analyzers) at the severities its .editorconfig sets, warning for a start; this script
// never changes the build's verdict. Errors and warnings are counted per rule: mode `report` (the
// default) prints them and never fails; mode `ratchet` fails when a rule has more than its baseline.
// Notes and findings suppressed in source are listed, never gated. No SARIF at all passes in report
// mode and fails in ratchet mode, because a gate that cannot measure must not read as green.

import { analyzerCounts, analyzerOf, buildBaseline, evaluate, lowerBaseline, readSarifLogs, sarifFindings } from './lib/patterns-gate.mjs';
import { cliArgs, closeCountCheck, header, notMeasured, say, updateCountBaseline, writeCountBaseline } from './lib/gate-cli.mjs';
import { loadCheckConfig } from './lib/quality-config.mjs';

const { opt, flag } = cliArgs();
const sarif = opt('sarif');
if (!sarif) {
  console.error('usage: node scripts/check-patterns.mjs --sarif <file.sarif | dir> [--write-baseline | --update-baseline]');
  process.exit(2);
}

const config = loadCheckConfig('patterns');
say(...header('Code patterns (.NET analyzers)', config, 'A rule with more errors and warnings than its baseline fails.'));

const { logs, unreadable } = readSarifLogs(sarif);
for (const file of unreadable) say('', `· ${file} is not valid JSON and was skipped (the compiler died writing it?).`);
if (!logs.length) {
  process.exit(notMeasured(config, `no SARIF log at ${sarif} (the build did not run, or did not write \`-p:ErrorLog\`; see the api job's build step).`));
}

const { findings } = sarifFindings(logs);
const counts = analyzerCounts(findings);
const { byRule } = counts;

if (flag('write-baseline')) process.exit(writeCountBaseline('patterns', config, buildBaseline(byRule), { fix: 'Fix the findings' }));
if (flag('update-baseline')) process.exit(updateCountBaseline('patterns', config, (baseline) => lowerBaseline(baseline, buildBaseline(byRule))));

const { violations, improved, failed } = evaluate(byRule, config);
say('', `${logs.length} projects · ${counts.errors} errors · ${counts.warnings} warnings · ${counts.notes} notes · ${counts.suppressed} suppressed in source`);

// The rules over their baseline first, then the busiest; the facet keeps every rule.
const over = new Set(violations.map((v) => v.rule));
const rows = Object.entries(byRule)
  .map(([rule, r]) => ({ rule, ...r, gated: r.errors + r.warnings }))
  .filter((r) => r.gated > 0 || config.baseline?.[r.rule] > 0)
  .sort((a, b) => Number(over.has(b.rule)) - Number(over.has(a.rule)) || b.gated - a.gated || a.rule.localeCompare(b.rule));
if (rows.length) {
  say('', '| Rule | Analyzer | Errors | Warnings | Allowed |', '|---|---|---|---|---|');
  for (const r of rows.slice(0, 30)) console.log(`| ${r.rule} | ${analyzerOf(r.rule)} | ${r.errors} | ${r.warnings} | ${config.baseline?.[r.rule] ?? 0} |`);
  if (rows.length > 30) say('', `… and ${rows.length - 30} more rules (the patterns facet lists every one).`);
}

// Up to ten findings per offending rule, so a red build names what to fix.
const root = `${process.cwd()}/`;
const findingsOf = (rule) =>
  findings
    .filter((f) => f.ruleId === rule && !f.suppressed && (f.level === 'error' || f.level === 'warning'))
    .map((f) => `${f.file.replace(root, '')}${f.line ? `:${f.line}` : ''}: ${f.message}`)
    .slice(0, 10);

process.exit(closeCountCheck({
  config,
  improved,
  violations,
  failed,
  command: `node scripts/check-patterns.mjs --sarif ${sarif}`,
  fixHint: 'fix the code the analyzer names',
  okLine: '✓ no analyzer rule over its baseline',
  describe: (v, mark) => {
    console.log(`- ${mark} ${v.rule} (${analyzerOf(v.rule)}): ${v.count} (allowed ${v.allowed}) — ${v.why === 'new' ? 'not in the baseline' : 'more than the baseline'}`);
    for (const finding of findingsOf(v.rule)) console.log(`  - \`${finding}\``);
  },
}));
