#!/usr/bin/env node
// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/check-complexity.mjs. Update with `workflows update --force`; consumer edits may be overwritten.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CC_MAX, CRAP_MAX, buildBaseline, evaluate, pruneBaseline } from './lib/complexity-gate.mjs';
import { apiMethods, scoreMethods, webMethods } from './lib/engineering-excellence.mjs';

const DEFAULT_BASELINE = fileURLToPath(new URL('./complexity-baseline.json', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const api = opt('api');
const webFinal = opt('web-final');
const eslint = opt('eslint');
if (!api || !webFinal || !eslint) {
  console.error('usage: node scripts/check-complexity.mjs --api <Cobertura.xml> --web-final <coverage-final.json> --eslint <eslint.json> [--baseline <file>] [--prune | --write-baseline]');
  process.exit(2);
}
const baselineFile = opt('baseline') ?? DEFAULT_BASELINE;

const methods = scoreMethods([
  ...apiMethods(readFileSync(api, 'utf8')),
  ...webMethods(JSON.parse(readFileSync(eslint, 'utf8')), JSON.parse(readFileSync(webFinal, 'utf8'))),
]);

const writeJson = (file, obj) => writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);

if (flag('write-baseline')) {
  const b = buildBaseline(methods);
  writeJson(baselineFile, b);
  console.log(`· wrote ${Object.keys(b).length} baseline entries to ${baselineFile}`);
  process.exit(0);
}

const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : {};

if (flag('prune')) {
  const pruned = pruneBaseline(baseline, methods);
  writeJson(baselineFile, pruned);
  console.log(`· baseline ${Object.keys(baseline).length} -> ${Object.keys(pruned).length} entries`);
  process.exit(0);
}

const sourceCache = new Map();
const readSource = (file) => {
  if (!sourceCache.has(file)) {
    const path = `${REPO_ROOT}${file}`;
    sourceCache.set(file, existsSync(path) ? readFileSync(path, 'utf8').split('\n') : null);
  }
  return sourceCache.get(file);
};

const { violations, justified, baselined, fixed } = evaluate(methods, baseline, readSource);
const pct = (r) => `${(r * 100).toFixed(0)}%`;
const WHY = {
  new: 'not in the baseline',
  'cc-increased': 'complexity rose above its baseline',
  'crap-increased': 'CRAP rose above its baseline (coverage dropped or complexity rose)',
};

console.log(`### Complexity gate (CC ≤ ${CC_MAX}, CRAP ≤ ${CRAP_MAX})`);
console.log('');
console.log(`${methods.length} methods · ${baselined} baselined backlog · ${justified.length} justified · ${violations.length} violations`);
if (justified.length) {
  console.log('', 'Justified (`complexity-justified:`):', '');
  for (const j of justified) console.log(`- \`${j.file}:${j.line}\` ${j.method} — CC ${j.cc}, CRAP ${j.crap} — ${j.reason} (#${j.issue})`);
}
if (fixed.length) {
  console.log('', `${fixed.length} baseline entries no longer violate — run \`node scripts/check-complexity.mjs ... --prune\` to ratchet the baseline down.`);
}
if (violations.length) {
  console.log('', 'Violations — simplify the method, or test it until CRAP ≤ 30:', '');
  for (const v of violations.sort((a, b) => b.crap - a.crap)) {
    const base = v.baseline ? ` (baseline CC ${v.baseline.cc}, CRAP ${v.baseline.crap})` : '';
    console.log(`- ✗ \`${v.file}:${v.line}\` ${v.method} — CC ${v.cc}, coverage ${pct(v.coverage)}, CRAP ${v.crap}: ${WHY[v.why]}${base}`);
  }
  process.exit(1);
}
console.log('', '✓ no method above the thresholds outside the baseline');
