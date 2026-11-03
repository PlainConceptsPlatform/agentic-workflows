#!/usr/bin/env node
// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/check-duplication.mjs. Update with `workflows update --force`; consumer edits may be overwritten.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildBaseline, evaluate, pruneBaseline } from './lib/duplication-gate.mjs';
import { duplicatedLinesByFile, lineCount, repoPath } from './lib/engineering-excellence.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const report = opt('report') ?? 'jscpd-report/jscpd-report.json';
const baselineFile = opt('baseline') ?? fileURLToPath(new URL('./duplication-baseline.json', import.meta.url));
if (!existsSync(report)) {
  console.error(`✗ ${report} not found — run \`npx jscpd -c .jscpd.json\` first`);
  process.exit(2);
}

const jscpd = JSON.parse(readFileSync(report, 'utf8'));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const lengthOf = (file) => (existsSync(`${REPO_ROOT}${file}`) ? lineCount(readFileSync(`${REPO_ROOT}${file}`, 'utf8')) : Infinity);
const duplicated = duplicatedLinesByFile(jscpd, lengthOf);
const clonesOf = (file) =>
  (jscpd.duplicates ?? [])
    .map((d) => [d.firstFile, d.secondFile].map((f) => ({ file: repoPath(f.name), start: f.start, end: f.end })))
    .filter((pair) => pair.some((f) => f.file === file))
    .map((pair) => pair.map((f) => `${f.file}:${f.start}-${f.end}`).join(' ↔ '));
const writeJson = (file, obj) => writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
const total = (b) => Object.values(b).reduce((n, v) => n + v, 0);

if (flag('write-baseline')) {
  const b = buildBaseline(duplicated);
  writeJson(baselineFile, b);
  console.log(`· wrote ${Object.keys(b).length} files (${total(b)} duplicated lines) to ${baselineFile}`);
  process.exit(0);
}

const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : {};

if (flag('prune')) {
  const pruned = pruneBaseline(baseline, duplicated);
  writeJson(baselineFile, pruned);
  console.log(`· baseline ${Object.keys(baseline).length} -> ${Object.keys(pruned).length} files, ${total(baseline)} -> ${total(pruned)} lines`);
  process.exit(0);
}

const { violations, baselined, fixed } = evaluate(duplicated, baseline);
console.log('### Duplication gate (jscpd, no new clones)');
console.log('');
console.log(`${Object.keys(duplicated).length} files with clones · ${baselined} within their baseline · ${violations.length} violations`);
if (fixed.length) {
  console.log('', `${fixed.length} baseline entries improved — run \`node scripts/check-duplication.mjs --prune\` to ratchet the baseline down.`);
}
if (violations.length) {
  console.log('', 'Violations — reuse the existing code instead of copying it:', '');
  for (const v of violations) {
    const why = v.why === 'new' ? 'not in the baseline' : `baseline ${v.baseline}`;
    console.log(`- ✗ \`${v.file}\` — ${v.lines} duplicated lines (${why})`);
    for (const c of clonesOf(v.file)) console.log(`  - ${c}`);
  }
  process.exit(1);
}
console.log('', '✓ no duplicated lines above the baseline');
