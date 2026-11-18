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
import { loadCheckConfig, today, writeCheckSection } from './lib/quality-config.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);
// One line per argument: the step summary is Markdown, and a table needs its rows on their own lines.
const say = (...lines) => console.log(lines.join('\n'));

const report = opt('report');
if (!report) {
  console.error('usage: node scripts/check-architecture.mjs --report <steiger-report.json> [--write-baseline | --update-baseline]');
  process.exit(2);
}

const config = loadCheckConfig('architecture');
const modeLine = config.mode === 'ratchet'
  ? `Mode: ratchet${config.since ? ` (check introduced ${config.since})` : ''}. A rule with more warnings than its baseline fails.`
  : `Mode: report-only${config.since ? ` since ${config.since}` : ''}. Never fails CI; the switch to \`ratchet\` is a reviewed change to quality.config.json.`;

console.log('### Architecture (Steiger)');
say('');
console.log(modeLine);

if (!existsSync(report)) {
  say('', `Not measured: ${report} is missing (Steiger did not run, or is older than 0.10 and has no JSON reporter; see the boundary step's log).`);
  process.exit(config.mode === 'ratchet' ? 1 : 0);
}

const diagnostics = JSON.parse(readFileSync(report, 'utf8'));
const { errors, warnings, byRule } = steigerCounts(diagnostics);

if (flag('write-baseline')) {
  // A ratchet's baseline is never raised by a script: that would turn a red gate green without a fix.
  const next = buildBaseline(byRule);
  const raised = config.mode === 'ratchet'
    ? Object.entries(next).filter(([rule, count]) => count > (config.baseline?.[rule] ?? 0)).map(([rule]) => rule)
    : [];
  if (raised.length) {
    console.error(`✗ architecture is a ratchet and this would raise its baseline for ${raised.join(', ')}. Fix the warnings, or lower the baseline with --update-baseline; raising it is a hand edit of quality.config.json with the reason in the pull request.`);
    process.exit(2);
  }
  const written = writeCheckSection('architecture', (s) => ({
    ...s,
    mode: s.mode ?? 'report',
    since: s.since ?? today(),
    baseline: next,
  }));
  say('', `· wrote architecture.baseline to quality.config.json: ${JSON.stringify(written.baseline)}`);
  process.exit(0);
}

if (flag('update-baseline')) {
  if (!config.baseline) {
    console.error('✗ architecture.baseline does not exist yet; write it with --write-baseline');
    process.exit(2);
  }
  const lowered = lowerBaseline(config.baseline, buildBaseline(byRule));
  writeCheckSection('architecture', (s) => ({ ...s, baseline: lowered }));
  say('', `· architecture.baseline ${JSON.stringify(config.baseline)} -> ${JSON.stringify(lowered)}`);
  process.exit(0);
}

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

if (improved.length) {
  say('', `Improved below the baseline: ${improved.join(', ')}. Run \`node scripts/check-architecture.mjs --report ${report} --update-baseline\` to ratchet it down.`);
}
if (violations.length) {
  say('', failed ? 'Violations — fix the import, the public API or the slice:' : 'Over the baseline (report-only, not failing):', '');
  for (const v of violations) {
    console.log(`- ${failed ? '✗' : '·'} ${v.rule}: ${v.count} (allowed ${v.allowed}) — ${v.why === 'new' ? 'not in the baseline' : 'more than the baseline'}`);
    for (const finding of findingsOf(v.rule)) console.log(`  - \`${finding}\``);
  }
}
if (!config.baseline) {
  say('', `No baseline yet. Record one in a pull request with \`node scripts/check-architecture.mjs --report ${report} --write-baseline\`.`);
}
if (failed) process.exit(1);
say('', violations.length ? '· report-only: nothing fails' : '✓ no Steiger rule over its warning baseline');
