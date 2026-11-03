#!/usr/bin/env node
// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/engineering-excellence.mjs. Update with `workflows update --force`; consumer edits may be overwritten.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CC_MAX, CRAP_MAX, evaluate } from './lib/complexity-gate.mjs';
import { evaluate as evaluateDuplication } from './lib/duplication-gate.mjs';
import { loadQualityConfig } from './lib/quality-config.mjs';
import { scopedSources } from './lib/source-files.mjs';
import {
  apiMethods,
  complexityFacetData,
  coverageFacetData,
  duplicatedLinesByFile,
  envelope,
  hygieneFacetData,
  lineCount,
  mutationFacetData,
  scoreMethods,
  sbomFacetData,
  securityFacetData,
  validateFacet,
  webMethods,
} from './lib/engineering-excellence.mjs';

const BUILT = ['coverage', 'complexity', 'mutation', 'security', 'sbom', 'hygiene'];
const SCHEMA = JSON.parse(readFileSync(new URL('./engineering-excellence.schema.json', import.meta.url), 'utf8'));

function parseArgs(argv) {
  const [facet, ...rest] = argv;
  const opts = { job: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, '');
    const value = rest[i + 1];
    if (!key || value === undefined) usage(`missing value for ${rest[i]}`);
    if (key === 'job') opts.job.push(value);
    else opts[key] = value;
  }
  return { facet, opts };
}

function usage(msg) {
  if (msg) console.error(`✗ ${msg}`);
  console.error(`usage: node scripts/engineering-excellence.mjs <${BUILT.join('|')}> --out <file> [inputs] — see the header of this file`);
  process.exit(2);
}

const read = (file) => readFileSync(file, 'utf8');
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const sourceLines = (file) => (existsSync(`${REPO_ROOT}${file}`) ? read(`${REPO_ROOT}${file}`).split('\n') : null);
const readOptional = (file) => {
  if (!file) return null;
  if (existsSync(file)) return read(file);
  console.log(`· ${file} not found — recorded as null (the producing job did not write it)`);
  return null;
};
const required = (opts, key) => opts[key] ?? usage(`--${key} is required`);

function mutationReports(dir) {
  const reports = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const scope = entry.isDirectory() && entry.name.match(/^mutation-(.+)$/)?.[1];
    if (!scope) continue;
    const file = join(dir, entry.name, 'mutation-report.json');
    // A scope whose Stryker run died has no report; the gate already failed it.
    if (existsSync(file)) reports[scope] = JSON.parse(read(file));
    else console.log(`· ${scope}: no mutation-report.json — scope omitted`);
  }
  return reports;
}

function build(facet, opts) {
  switch (facet) {
    case 'coverage': {
      const { coverage } = loadQualityConfig();
      return coverageFacetData({
        apiXml: read(required(opts, 'api')),
        webXml: read(required(opts, 'web')),
        floors: { api: coverage.api, web: coverage.web },
      });
    }
    case 'complexity': {
      const methods = [
        ...apiMethods(read(required(opts, 'api'))),
        ...webMethods(JSON.parse(read(required(opts, 'eslint'))), JSON.parse(read(required(opts, 'web-final')))),
      ];
      const data = complexityFacetData(methods);
      // The backlog size is the gate's ratchet: it should only ever go down.
      if (opts.baseline && existsSync(opts.baseline)) {
        const r = evaluate(scoreMethods(methods), JSON.parse(read(opts.baseline)), sourceLines);
        data.gate = { ccMax: CC_MAX, crapMax: CRAP_MAX, baselined: r.baselined, violations: r.violations.length, justified: r.justified.length };
      }
      return data;
    }
    case 'mutation':
      return mutationFacetData(mutationReports(required(opts, 'reports')), loadQualityConfig().mutation);
    case 'security': {
      const trivy = readOptional(opts.trivy);
      const semgrep = readOptional(opts.semgrep);
      const jobs = Object.fromEntries(opts.job.map((j) => j.split('=')));
      return securityFacetData({
        trivy: trivy && JSON.parse(trivy),
        semgrep: semgrep && JSON.parse(semgrep),
        jobs,
      });
    }
    case 'sbom':
      return sbomFacetData(read(required(opts, 'cyclonedx')));
    case 'hygiene': {
      const cfg = JSON.parse(read(join(REPO_ROOT, '.jscpd.json')));
      const files = scopedSources(cfg, REPO_ROOT);
      const lengths = new Map(files.map((f) => [f.file, lineCount(f.text)]));
      const duplicated = duplicatedLinesByFile(JSON.parse(read(required(opts, 'jscpd'))), (f) => lengths.get(f));
      const semgrep = readOptional(opts.semgrep);
      let gate = null;
      if (opts.baseline && existsSync(opts.baseline)) {
        const baseline = JSON.parse(read(opts.baseline));
        const r = evaluateDuplication(duplicated, baseline);
        gate = {
          baselinedFiles: Object.keys(baseline).length,
          baselineLines: Object.values(baseline).reduce((n, v) => n + v, 0),
          violations: r.violations.length,
          fixed: r.fixed.length,
        };
      }
      return hygieneFacetData({
        files,
        duplicated,
        semgrep: semgrep && JSON.parse(semgrep),
        thresholds: { minLines: cfg.minLines, minTokens: cfg.minTokens },
        gate,
      });
    }
    default:
      return usage(`unknown facet '${facet}'`);
  }
}

const pct = (r) => (r === null || r === undefined ? 'n/a' : `${(r * 100).toFixed(2)}%`);

// A short Markdown digest for $GITHUB_STEP_SUMMARY, so the numbers are readable on
// the run itself, not only in the dashboard.
function summary(facet, d) {
  const lines = [`### Engineering Excellence · ${facet}`, ''];
  if (facet === 'coverage') {
    lines.push('| Scope | Lines | Branches | Floor |', '|---|---|---|---|');
    for (const [k, s] of Object.entries(d.scopes)) lines.push(`| ${k} | ${pct(s.lineRate)} | ${pct(s.branchRate)} | ${pct(s.floor)} |`);
    lines.push('', `Global: ${pct(d.global.lineRate)}`);
  } else if (facet === 'complexity') {
    lines.push('| Scope | Methods | CC p90 | CC max | CC>10 | CRAP>30 |', '|---|---|---|---|---|---|');
    for (const [k, s] of Object.entries(d.scopes)) lines.push(`| ${k} | ${s.methods} | ${s.ccP90} | ${s.ccMax} | ${s.over10} | ${s.crapOver30} |`);
    if (d.gate) lines.push('', `Gate backlog: ${d.gate.baselined} baselined · ${d.gate.violations} violations · ${d.gate.justified} justified`);
    lines.push('', 'Top CRAP hotspots:', '');
    for (const h of d.hotspots.slice(0, 10)) lines.push(`- \`${h.file}:${h.line}\` ${h.method} — CC ${h.cc}, cov ${pct(h.coverage)}, CRAP ${h.crap}`);
  } else if (facet === 'mutation') {
    lines.push('| Scope | Covered-code | Full | Survived | NoCoverage | Floor |', '|---|---|---|---|---|---|');
    for (const [k, s] of Object.entries(d.scopes)) lines.push(`| ${k} | ${pct(s.coveredScore)} | ${pct(s.fullScore)} | ${s.survived} | ${s.noCoverage} | ${pct(s.floor)} |`);
    lines.push('', `Global covered-code: ${pct(d.global.coveredScore)}`);
  } else if (facet === 'security') {
    if (d.trivy) lines.push(`Trivy vulns: ${JSON.stringify(d.trivy.vuln)} · fixable ${d.trivy.fixableVulns}`);
    if (d.semgrep) lines.push(`Semgrep: ${d.semgrep.ERROR} error · ${d.semgrep.WARNING} warning · ${d.semgrep.INFO} info`);
    lines.push(`Jobs: ${Object.entries(d.jobs).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  } else if (facet === 'sbom') {
    lines.push(`${d.components} components · ${JSON.stringify(d.byEcosystem)} · ${d.unlicensed} without a license`);
  } else if (facet === 'hygiene') {
    const n = (v) => (v === null ? 'n/a' : v);
    lines.push('| Scope | Files | Duplication | Dup. lines | Swallowed | Justified | Dead code | Comment density |', '|---|---|---|---|---|---|---|---|');
    for (const [k, s] of Object.entries(d.scopes)) {
      lines.push(`| ${k} | ${s.files} | ${pct(s.duplicationRate)} | ${s.duplicatedLines} | ${n(s.swallowedExceptions)} | ${s.justifiedSwallows} | ${s.deadCodeWarnings} | ${n(s.commentDensity)} |`);
    }
    if (d.gate) lines.push('', `Duplication gate: ${d.gate.baselinedFiles} baselined files (${d.gate.baselineLines} lines) · ${d.gate.violations} violations · ${d.gate.fixed} improved`);
  }
  return lines.join('\n');
}

const { facet, opts } = parseArgs(process.argv.slice(2));
if (!BUILT.includes(facet)) usage(`unknown facet '${facet}'`);
const out = required(opts, 'out');
const doc = envelope(facet, build(facet, opts));
const errors = validateFacet(doc, SCHEMA);
if (errors.length) {
  console.error(`✗ ${facet}: facet violates scripts/engineering-excellence.schema.json`);
  for (const e of errors.slice(0, 20)) console.error(`  ${e}`);
  process.exit(1);
}
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(summary(facet, doc.data));
