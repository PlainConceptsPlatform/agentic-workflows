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
  console.error('usage: node scripts/check-dead-code.mjs --report <knip.json> [--write-baseline | --update-baseline]');
  process.exit(2);
}

const config = loadCheckConfig('deadCode');
const modeLine = config.mode === 'ratchet'
  ? `Mode: ratchet${config.since ? ` (check introduced ${config.since})` : ''}. More findings than the baseline, or any unused or unlisted dependency, fails.`
  : `Mode: report-only${config.since ? ` since ${config.since}` : ''}. Never fails CI; the switch to \`ratchet\` is a reviewed change to quality.config.json.`;

console.log('### Dead code (Knip)');
say('');
console.log(modeLine);

if (!existsSync(report)) {
  say('', `Not measured: ${report} is missing (Knip did not run or did not finish; see the step log).`);
  process.exit(config.mode === 'ratchet' ? 1 : 0);
}

const knip = JSON.parse(readFileSync(report, 'utf8'));
const byType = knipCounts(knip);

if (flag('write-baseline')) {
  // A ratchet's baseline is never raised by a script: that would turn a red gate green without a fix.
  const raised = config.mode === 'ratchet'
    ? Object.entries(buildBaseline(byType)).filter(([type, count]) => count > (config.baseline?.[type] ?? 0)).map(([type]) => type)
    : [];
  if (raised.length) {
    console.error(`✗ deadCode is a ratchet and this would raise its baseline for ${raised.join(', ')}. Fix the findings, or lower the baseline with --update-baseline; raising it is a hand edit of quality.config.json with the reason in the pull request.`);
    process.exit(2);
  }
  const written = writeCheckSection('deadCode', (s) => ({
    ...s,
    mode: s.mode ?? 'report',
    since: s.since ?? today(),
    baseline: buildBaseline(byType),
  }));
  say('', `· wrote deadCode.baseline to quality.config.json: ${JSON.stringify(written.baseline)}`);
  process.exit(0);
}

if (flag('update-baseline')) {
  if (!config.baseline) {
    console.error('✗ deadCode.baseline does not exist yet; write it with --write-baseline');
    process.exit(2);
  }
  const lowered = lowerBaseline(config.baseline, byType);
  writeCheckSection('deadCode', (s) => ({ ...s, baseline: lowered }));
  say('', `· deadCode.baseline ${JSON.stringify(config.baseline)} -> ${JSON.stringify(lowered)}`);
  process.exit(0);
}

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

if (improved.length) {
  say('', `Improved below the baseline: ${improved.join(', ')}. Run \`node scripts/check-dead-code.mjs --report ${report} --update-baseline\` to ratchet it down.`);
}
if (violations.length) {
  say('', failed ? 'Violations — delete the dead code, or remove the dependency:' : 'Over the baseline (report-only, not failing):', '');
  for (const v of violations) {
    const why = v.why === 'dependency' ? 'unused or unlisted dependencies are never baselined' : v.why === 'new' ? 'not in the baseline' : 'more than the baseline';
    console.log(`- ${failed ? '✗' : '·'} ${v.type}: ${v.count} (allowed ${v.allowed}) — ${why}`);
    for (const name of namesOf(v.type)) console.log(`  - \`${name}\``);
  }
}
if (!config.baseline) {
  say('', `No baseline yet. Record one in a pull request with \`node scripts/check-dead-code.mjs --report ${report} --write-baseline\`.`);
}
if (failed) process.exit(1);
say('', violations.length ? '· report-only: nothing fails' : '✓ no Knip issue type over its baseline');
