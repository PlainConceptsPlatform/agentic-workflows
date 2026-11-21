#!/usr/bin/env node
// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/engineering-excellence.mjs. Update with `workflows update --force`; consumer edits may be overwritten.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  architectureDotnetData,
  architectureFacetData,
  architectureLibrary,
  architectureWebData,
} from './lib/architecture-gate.mjs';
import { bundleFacetData } from './lib/bundle-gate.mjs';
import { CC_MAX, CRAP_MAX, evaluate } from './lib/complexity-gate.mjs';
import { deadCodeWebData } from './lib/dead-code-gate.mjs';
import { evaluate as evaluateDuplication } from './lib/duplication-gate.mjs';
import { patternsDotnetData, patternsFacetData, patternsSemgrepData, readSarifLogs, semgrepRuleIds } from './lib/patterns-gate.mjs';
import { CONFIG_FILE, loadCheckConfig, loadQualityConfig, parseQualityConfig } from './lib/quality-config.mjs';
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
import { buildWorklist, normalizeLimit, validateWorklist, worklistSummary } from './lib/worklist.mjs';

const BUILT = ['coverage', 'complexity', 'mutation', 'security', 'sbom', 'hygiene', 'bundle', 'architecture', 'patterns'];
const SCHEMA = JSON.parse(readFileSync(new URL('./engineering-excellence.schema.json', import.meta.url), 'utf8'));
// Not a facet: the audit's worklist, built from the facets in ee/ and the raw reports (see lib/worklist.mjs).
const WORKLIST = 'worklist';
const REPEATABLE = ['job', 'lcov'];

function parseArgs(argv) {
  const [facet, ...rest] = argv;
  const opts = { job: [], lcov: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.replace(/^--/, '');
    const value = rest[i + 1];
    if (!key || value === undefined) usage(`missing value for ${rest[i]}`);
    if (REPEATABLE.includes(key)) opts[key].push(value);
    else opts[key] = value;
  }
  return { facet, opts };
}

function usage(msg) {
  if (msg) console.error(`✗ ${msg}`);
  console.error(`usage: node scripts/engineering-excellence.mjs <${[...BUILT, WORKLIST].join('|')}> --out <file> [inputs] — see the header of this file`);
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

// The rule ids of the repository's own Semgrep rules (.semgrep/*.yml), or null without the directory.
function semgrepRules(dir) {
  if (!dir || !existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  return semgrepRuleIds(files.map((f) => read(join(dir, f))));
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
      // Knip's report from the web job; without it the facet keeps the .NET dead-code count alone.
      const knip = readOptional(opts.knip);
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
        deadCodeWeb: knip && deadCodeWebData(JSON.parse(knip), loadCheckConfig('deadCode')),
        thresholds: { minLines: cfg.minLines, minTokens: cfg.minTokens },
        gate,
      });
    }
    // The measurement check-bundle-size.mjs wrote in the web job, judged against the same budget.
    case 'bundle':
      return bundleFacetData(JSON.parse(read(required(opts, 'report'))), loadCheckConfig('bundle'));
    // Steiger's JSON from the web job and the architecture tests' TRX from the api job; either may be
    // absent (no web app, Steiger older than 0.10, no ARCHITECTURE_TEST_PROJECT), not both.
    case 'architecture': {
      const steiger = readOptional(opts.steiger);
      const trx = readOptional(opts.trx);
      if (!steiger && !trx) return usage('architecture needs --steiger <steiger-report.json> or --trx <architecture.trx>');
      const version = readOptional(opts['steiger-version-file'])?.split('\n')[0].trim() || null;
      return architectureFacetData({
        web: steiger && architectureWebData(JSON.parse(steiger), version, loadCheckConfig('architecture')),
        dotnet: trx && architectureDotnetData(trx, architectureLibrary(readOptional(opts['test-project']))),
      });
    }
    // The compiler's SARIF logs from the api job (one per project) and the blocking Semgrep scan's
    // JSON, read for the repository's own .semgrep/ rules; either may be absent, not both.
    case 'patterns': {
      const logs = opts.sarif ? readSarifLogs(opts.sarif).logs : [];
      const semgrep = readOptional(opts.semgrep);
      if (!logs.length && !semgrep) return usage('patterns needs --sarif <file.sarif | dir> with a SARIF log, or --semgrep <semgrep.json>');
      return patternsFacetData({
        dotnet: logs.length ? patternsDotnetData(logs, loadCheckConfig('patterns')) : null,
        semgrep: semgrep && patternsSemgrepData(JSON.parse(semgrep), semgrepRules(opts['semgrep-rules'])),
      });
    }
    default:
      return usage(`unknown facet '${facet}'`);
  }
}

// The worklist's inputs, each optional:
//   node scripts/engineering-excellence.mjs worklist --out ee/worklist.json [--limit 20]   (default: quality.config.json audit.limit, else 20)
//     [--facets ee]                        the facets already built (coverage, complexity, mutation, architecture, bundle)
//     [--api Cobertura.xml] [--web cobertura-coverage.xml] [--lcov lcov.info ...]
//     [--mutation-reports <dir of mutation-<scope>/mutation-report.json>]
//     [--trivy trivy.json] [--semgrep semgrep.json] [--knip knip-report.json] [--jscpd jscpd-report.json]
//     [--steiger steiger-report.json] [--trx architecture.trx] [--sarif <file.sarif | dir>]
//     [--bundle-report bundle-report.json] [--size-limit size-limit.json]
// A file that is not there is skipped; one that is there and cannot be parsed is named in `unreadable`
// by its check. Neither fails the run: a repository that publishes some reports still gets a worklist.
function worklistInputs(opts) {
  const unreadable = [];
  const attempt = (check, file, parse) => {
    if (!file || !existsSync(file)) return null;
    try {
      return parse(file);
    } catch {
      console.log(`· ${file} could not be read: ${check} recorded as null`);
      unreadable.push(check);
      return null;
    }
  };
  const json = (file) => JSON.parse(read(file).replace(/^\uFEFF/, ''));
  const facet = (name) => attempt(name, opts.facets && join(opts.facets, `${name}.json`), (file) => json(file).data ?? null);
  const jscpdConfig = attempt('duplication', join(REPO_ROOT, '.jscpd.json'), json);
  return {
    facets: Object.fromEntries(['coverage', 'complexity', 'mutation', 'architecture', 'bundle'].map((name) => [name, facet(name)])),
    apiCoverage: attempt('coverage', opts.api, read),
    webCoverage: attempt('coverage', opts.web, read),
    lcov: opts.lcov.map((file) => attempt('coverage', file, read)).filter(Boolean),
    mutationReports: attempt('mutation', opts['mutation-reports'], mutationReports),
    trivy: attempt('security', opts.trivy, json),
    semgrep: attempt('semgrep', opts.semgrep, json),
    knip: attempt('deadCode', opts.knip, json),
    jscpd: attempt('duplication', opts.jscpd, json),
    jscpdMinLines: jscpdConfig?.minLines ?? null,
    steiger: attempt('architecture', opts.steiger, json),
    trx: attempt('architecture', opts.trx, read),
    sarifLogs: attempt('patterns', opts.sarif, (path) => readSarifLogs(path).logs),
    bundleReport: attempt('bundle', opts['bundle-report'], json),
    sizeLimit: attempt('bundle', opts['size-limit'], json),
    unreadable: [...new Set(unreadable)],
  };
}

// The modes, floors and baselines the gates read. A quality.config.json the gates would reject is
// their failure to report; the worklist falls back to the defaults (every check in report mode).
function worklistConfig() {
  try {
    return { config: parseQualityConfig(existsSync(CONFIG_FILE) ? read(CONFIG_FILE) : '{}', CONFIG_FILE), valid: true };
  } catch {
    console.log('· quality.config.json is not valid (the gates say why): the worklist uses the default modes and no floors');
    return { config: parseQualityConfig('{}', CONFIG_FILE), valid: false };
  }
}

function writeWorklist(opts) {
  const out = required(opts, 'out');
  const inputs = worklistInputs(opts);
  const { config, valid } = worklistConfig();
  if (!valid) inputs.unreadable.push('config');
  const doc = envelope(WORKLIST, buildWorklist(inputs, config, { limit: normalizeLimit(opts.limit ?? config.audit.limit) }));
  const errors = validateWorklist(doc, JSON.parse(read(new URL('./engineering-excellence-worklist.schema.json', import.meta.url))));
  if (errors.length) {
    console.error('✗ worklist violates scripts/engineering-excellence-worklist.schema.json');
    for (const e of errors.slice(0, 20)) console.error(`  ${e}`);
    process.exit(1);
  }
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(worklistSummary(doc.data));
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
    const web = d.deadCode.web;
    if (web) {
      lines.push('', `Dead code (Knip, ${web.gate.mode}${web.gate.since ? ` since ${web.gate.since}` : ''}): ${web.unusedFiles} files · ${web.unusedExports} exports · ${web.unusedDependencies} unused deps · ${web.unlistedDependencies} unlisted deps · ${web.gate.violations} over the baseline`);
    }
  } else if (facet === 'bundle') {
    const kb = (b) => (b === null ? 'n/a' : `${(b / 1000).toFixed(1)} kB`);
    lines.push(`Total JS ${kb(d.totalJsBytes)} (${d.compression}) in ${d.chunks} chunks · largest ${kb(d.largestChunkBytes)} · budget ${kb(d.limitBytes)} · ${d.gate.mode}${d.gate.since ? ` since ${d.gate.since}` : ''}${d.overBudget ? ' · OVER BUDGET' : ''}`);
  } else if (facet === 'architecture') {
    const { web, dotnet } = d;
    if (web) {
      lines.push(`Web (Steiger${web.version ? ` ${web.version}` : ''}, ${web.gate.mode}${web.gate.since ? ` since ${web.gate.since}` : ''}): ${web.errors} errors · ${web.warnings} warnings · ${web.gate.violations} over the warning baseline`);
    }
    if (dotnet) {
      lines.push(`.NET (${dotnet.project ?? 'architecture tests'}${dotnet.tool ? `, ${dotnet.tool}` : ''}): ${dotnet.passed} of ${dotnet.rules} rules pass · ${dotnet.failed} failing${dotnet.failing.length ? `: ${dotnet.failing.slice(0, 10).join(', ')}` : ''}`);
    }
  } else if (facet === 'patterns') {
    lines.push(...patternsSummary(d));
  }
  return lines.join('\n');
}

function patternsSummary({ dotnet, semgrep }) {
  const lines = [];
  if (dotnet) {
    const analyzers = Object.entries(dotnet.byAnalyzer).map(([a, c]) => `${a} ${c.errors + c.warnings}`).join(', ');
    lines.push(`.NET analyzers (${dotnet.logs} projects, ${dotnet.gate.mode}${dotnet.gate.since ? ` since ${dotnet.gate.since}` : ''}): ${dotnet.errors} errors · ${dotnet.warnings} warnings · ${dotnet.notes} notes · ${dotnet.suppressed} suppressed · ${dotnet.gate.violations} over the baseline${analyzers ? ` (${analyzers})` : ''}`);
  }
  if (semgrep) {
    lines.push(`Semgrep, the repository's own rules${semgrep.rules === null ? '' : ` (${semgrep.rules})`}: ${semgrep.errors} errors · ${semgrep.warnings} warnings · ${semgrep.notes} info`);
  }
  return lines;
}

const { facet, opts } = parseArgs(process.argv.slice(2));
if (facet === WORKLIST) {
  writeWorklist(opts);
  process.exit(0);
}
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
