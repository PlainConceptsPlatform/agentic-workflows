// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/patterns-gate.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Rules for the code-patterns check. Pure functions but for readSarifLogs; the CLI is
// scripts/check-patterns.mjs and the patterns facet reads the same counts, so the gate and the facet agree.
//
// Two sources, each run in the app's own CI:
// - .NET: the compiler's SARIF error log (`dotnet build -p:ErrorLog=dotnet-analyzers.sarif%2Cversion%3D2.1`),
//   one per compiled project. It holds every diagnostic the build reported: the analyzers the app
//   references (Meziantou.Analyzer, Roslynator.Analyzers), the .NET analyzers (CA), the code-style
//   rules (IDE) and the compiler's own warnings (CS). Their severities are the app's (.editorconfig);
//   this check only records them. Errors and warnings per rule get the report-then-ratchet treatment:
//   quality.config.json `patterns.baseline` records how many each rule has today; in `ratchet` mode a
//   rule may keep that many but never more, and a rule outside the baseline may have none. Notes and
//   findings suppressed in source are counted, never gated. In `report` mode nothing fails.
// - Semgrep: the family's and the app's own rules in .semgrep/, from the blocking SAST scan's JSON.
//   That scan already fails on any finding, so these are recorded, never baselined.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateCounts, gateState, lowerBaseline, positiveCounts } from './dead-code-gate.mjs';

export { lowerBaseline };

export const SARIF_NAME = 'dotnet-analyzers.sarif';

// The analyzer behind a rule id, by its prefix, so the dashboard can say whose rules fire.
const ANALYZERS = { MA: 'meziantou', RCS: 'roslynator', CA: 'netanalyzers', IDE: 'codestyle', CS: 'compiler', xUnit: 'xunit' };
export const analyzerOf = (ruleId) => ANALYZERS[/^([A-Za-z]+)\d/.exec(ruleId ?? '')?.[1]] ?? 'other';

const LEVELS = { error: 'errors', warning: 'warnings', note: 'notes', none: 'notes' };
const emptyCounts = () => ({ errors: 0, warnings: 0, notes: 0 });
const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

const fileOf = (uri) => {
  if (typeof uri !== 'string') return '';
  if (!uri.startsWith('file://')) return decodeURIComponent(uri);
  return decodeURIComponent(new URL(uri).pathname);
};

// One finding per SARIF result, SARIF 2.1 (`version=2.1`) or 1.0 (the compiler's default).
function sarifResult(r) {
  const v2 = r.locations?.[0]?.physicalLocation;
  const v1 = r.locations?.[0]?.resultFile;
  const where = v2 ? { uri: v2.artifactLocation?.uri, region: v2.region } : { uri: v1?.uri, region: v1?.region };
  return {
    ruleId: r.ruleId ?? 'unknown',
    level: LEVELS[r.level] ? r.level : 'warning',
    suppressed: (r.suppressions?.length ?? 0) > 0 || (r.suppressionStates?.length ?? 0) > 0,
    file: fileOf(where.uri),
    line: where.region?.startLine ?? null,
    column: where.region?.startColumn ?? null,
    message: (typeof r.message === 'string' ? r.message : r.message?.text) ?? '',
  };
}

const compilerOf = (run) => {
  const tool = run.tool?.driver ?? run.tool ?? {};
  return tool.semanticVersion ?? tool.version ?? null;
};

// Every finding of every log. A project that targets several frameworks reports each finding once
// per target; those duplicates are dropped.
export function sarifFindings(logs) {
  const seen = new Set();
  const findings = [];
  let compiler = null;
  for (const log of logs) {
    if (!log || !Array.isArray(log.runs)) throw new Error('not a SARIF log: expected { "runs": [...] }');
    for (const run of log.runs) {
      compiler ??= compilerOf(run);
      for (const raw of run.results ?? []) {
        const f = sarifResult(raw);
        const key = [f.ruleId, f.file, f.line, f.column, f.message].join('\u0000');
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push(f);
      }
    }
  }
  return { findings, compiler };
}

// Errors, warnings and notes overall, per rule and per analyzer; findings suppressed in source apart.
export function analyzerCounts(findings) {
  const totals = { ...emptyCounts(), suppressed: 0 };
  const byRule = {};
  const byAnalyzer = {};
  for (const f of findings) {
    if (f.suppressed) {
      totals.suppressed += 1;
      continue;
    }
    const key = LEVELS[f.level];
    totals[key] += 1;
    (byRule[f.ruleId] ??= emptyCounts())[key] += 1;
    (byAnalyzer[analyzerOf(f.ruleId)] ??= emptyCounts())[key] += 1;
  }
  return { ...totals, byRule: sortKeys(byRule), byAnalyzer: sortKeys(byAnalyzer) };
}

// What the gate holds per rule: errors and warnings. Notes are informational.
const gatedByRule = (byRule) => Object.fromEntries(Object.entries(byRule).map(([rule, r]) => [rule, r.errors + r.warnings]));

// `config` is quality.config.json's patterns section: { mode, since, baseline }.
export const evaluate = (byRule, config) => evaluateCounts(gatedByRule(byRule), config);

// Errors and warnings per rule, only the rules that have any.
export const buildBaseline = (byRule) => positiveCounts(gatedByRule(byRule));

// The SARIF logs at a path: the file itself, or every *.sarif under a directory (the dotnet-analyzers
// artifact holds one per project). An unreadable log (a compiler that died mid-write) is listed, not fatal.
export function readSarifLogs(path) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.sarif')) files.push(full);
    }
  };
  if (existsSync(path)) {
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
  const logs = [];
  const unreadable = [];
  for (const file of files) {
    try {
      logs.push(JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')));
    } catch {
      unreadable.push(file);
    }
  }
  return { files, logs, unreadable };
}

// The patterns facet's dotnet block: the analyzers' counts, the baseline and the gate as evaluated here.
export function patternsDotnetData(logs, config) {
  const { findings, compiler } = sarifFindings(logs);
  const counts = analyzerCounts(findings);
  const { excess, failed } = evaluate(counts.byRule, config);
  return {
    tool: 'roslyn',
    compiler,
    logs: logs.length,
    errors: counts.errors,
    warnings: counts.warnings,
    notes: counts.notes,
    suppressed: counts.suppressed,
    byAnalyzer: counts.byAnalyzer,
    byRule: counts.byRule,
    baseline: config.baseline ?? null,
    gate: gateState(config, excess, failed),
  };
}

// The rule ids in .semgrep/*.yml, read without a YAML parser: every `- id:` entry.
export function semgrepRuleIds(texts) {
  const ids = new Set();
  for (const text of texts) {
    for (const m of text.matchAll(/^\s*-\s+id:\s*["']?([\w.-]+)/gm)) ids.add(m[1]);
  }
  return [...ids].sort();
}

const SEMGREP_LEVELS = { ERROR: 'errors', WARNING: 'warnings', INFO: 'notes' };

// The patterns facet's semgrep block: the findings of the repository's own rules (.semgrep/), per
// rule. Semgrep prefixes a local rule's id with its config path (`.semgrep.<id>`); with the rule ids
// known every rule is listed, at zero too, and without them the `.semgrep.` prefix picks them out.
export function patternsSemgrepData(report, ruleIds = null) {
  if (!report || !Array.isArray(report.results)) throw new Error('not a Semgrep JSON report: expected { "results": [...] }');
  const byRule = Object.fromEntries((ruleIds ?? []).map((id) => [id, emptyCounts()]));
  const idOf = (checkId) => {
    if (typeof checkId !== 'string') return null;
    if (ruleIds) return ruleIds.find((id) => checkId === id || checkId.endsWith(`.${id}`)) ?? null;
    return checkId.startsWith('.semgrep.') ? checkId.slice('.semgrep.'.length) : null;
  };
  const totals = emptyCounts();
  for (const r of report.results) {
    const id = idOf(r.check_id);
    if (!id) continue;
    const key = SEMGREP_LEVELS[r.extra?.severity] ?? 'warnings';
    totals[key] += 1;
    (byRule[id] ??= emptyCounts())[key] += 1;
  }
  return {
    tool: 'semgrep',
    version: typeof report.version === 'string' ? report.version : null,
    rules: ruleIds ? ruleIds.length : null,
    ...totals,
    byRule: sortKeys(byRule),
  };
}

export const patternsFacetData = ({ dotnet = null, semgrep = null }) => ({ dotnet, semgrep });
