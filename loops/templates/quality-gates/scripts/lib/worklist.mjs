// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/worklist.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// The audit worklist: per check, the worst items with where they are. The facets say how much is
// wrong; several hold counts only, and the files and lines sit in raw tool reports that live one to
// seven days. `engineering-excellence.mjs worklist` folds both into ee/worklist.json, uploaded from
// main as `engineering-excellence-worklist` for the weekly audit to read. Contract:
// scripts/engineering-excellence-worklist.schema.json.
//
// Pure functions over parsed reports; the CLI does the reading. Every input is optional: a check
// whose report is absent is null, and a report that cannot be read is null too and named in
// `unreadable`. Nothing here throws for a missing input.
//
// What never enters the worklist: source code and secrets. Semgrep's matched lines, jscpd's clone
// fragments and Trivy's secret matches are dropped; a finding keeps its rule, path, line and the
// tool's one-line message.

import { createHash } from 'node:crypto';
import { evaluate as evaluateArchitecture, steigerCounts } from './architecture-gate.mjs';
import {
  EXPORT_TYPES,
  UNLISTED_DEPENDENCY_TYPES,
  UNUSED_DEPENDENCY_TYPES,
  ZERO_TOLERANCE_TYPES,
  evaluate as evaluateDeadCode,
  knipCounts,
} from './dead-code-gate.mjs';
import {
  CRAP_THRESHOLD,
  coberturaClasses,
  coverageFacetData,
  hygieneScopeOf,
  isGenerated,
  moduleOf,
  mutationFacetData,
  mutationScores,
  repoPath,
  validate,
} from './engineering-excellence.mjs';
import { analyzerCounts, analyzerOf, evaluate as evaluatePatterns, sarifFindings } from './patterns-gate.mjs';
import { parseTrx } from './test-timings.mjs';

export const CHECKS = ['complexity', 'coverage', 'mutation', 'security', 'semgrep', 'deadCode', 'duplication', 'architecture', 'patterns', 'bundle'];
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 200;
const MESSAGE_MAX = 200;
const LINES_MAX = 10;

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const ratio = (num, den) => (den === 0 ? null : round(num / den));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

// Stable across runs: the same finding keeps its id when the lines above it move, so a story filed
// for an item still matches it next week. Line numbers and measured values stay out of the hash.
export function itemId({ check, rule = null, path = null, symbol = null }) {
  const key = [check, rule ?? '', path ?? '', symbol ?? ''].join('\u0000');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// Repository-relative with forward slashes, on any runner: the app roots first, then the working
// directory, then the Actions workspace shape (`.../<repo>/<repo>/...`).
export function worklistPath(file, scope) {
  if (typeof file !== 'string' || file === '') return null;
  let f = file;
  if (f.startsWith('file://')) f = decodeURIComponent(new URL(f).pathname);
  f = repoPath(f, scope).replace(/^[A-Za-z]:\//, '/');
  const workspace = f.match(/\/_?work\/([^/]+)\/\1\/(.+)$/);
  if (workspace) f = workspace[2];
  return f.replace(/^\.\//, '');
}

// A tool's message on one line, bounded: enough to recognise the finding, never a dump.
export function oneLine(text, max = MESSAGE_MAX) {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const firstLines = (lines) => [...new Set(lines.filter(Number.isInteger))].sort((a, b) => a - b).slice(0, LINES_MAX);

function makeItem(check, mode, kind, fields) {
  const { rule = null, path = null, line = null, symbol = null, value = null, threshold = null, baseline = null, message = null, detail } = fields;
  return {
    id: itemId({ check, rule, path, symbol }),
    check,
    kind,
    rule,
    path,
    line,
    symbol,
    value,
    threshold,
    baseline,
    mode,
    message,
    ...(detail ? { detail } : {}),
  };
}

// Two findings with one id are one item (overloads, one rule twice on a line): the first, which the
// caller ranked worst, is kept.
function distinct(items) {
  const seen = new Set();
  return items.filter((i) => !seen.has(i.id) && seen.add(i.id));
}

// The cap is per check. A check with several kinds of item (modules and files) gives each kind its
// turn, so one long list cannot push the others out; each kind keeps its own order.
function capGroups(groups, limit) {
  const taken = groups.map(() => 0);
  let left = limit;
  let moved = true;
  while (left > 0 && moved) {
    moved = false;
    for (const [i, group] of groups.entries()) {
      if (left === 0 || taken[i] >= group.length) continue;
      taken[i] += 1;
      left -= 1;
      moved = true;
    }
  }
  return groups.flatMap((group, i) => group.slice(0, taken[i]));
}

// `groups` are ranked lists, worst first. `total` overrides the count when the source was already
// capped (the complexity facet lists its top hotspots and counts them all).
function checkResult({ mode, groups, limit, sources, total = null, extra = {} }) {
  const lists = groups.map(distinct);
  const items = capGroups(lists, limit);
  const found = lists.reduce((n, g) => n + g.length, 0);
  const count = Math.max(total ?? 0, found);
  return { mode, total: count, truncated: count > items.length, sources, ...extra, items };
}

// ── Complexity: the facet's CRAP hotspots ────────────────────────────────────────────────────────
// The gate is blocking against scripts/complexity-baseline.json, so the check is always a ratchet.
export function complexityCheck(facet, limit = DEFAULT_LIMIT) {
  if (!facet) return null;
  const crapMax = facet.thresholds?.crap ?? CRAP_THRESHOLD;
  const items = (facet.hotspots ?? []).map((h) =>
    makeItem('complexity', 'ratchet', 'method', {
      rule: 'crap',
      path: worklistPath(h.file),
      line: h.line ?? null,
      symbol: h.method,
      value: h.crap,
      threshold: crapMax,
      detail: { scope: h.scope, module: h.module, cc: h.cc, coverage: h.coverage },
    }),
  );
  return checkResult({
    mode: 'ratchet',
    groups: [items],
    limit,
    sources: ['facet:complexity'],
    total: facet.global?.crapOver30 ?? null,
    extra: { summary: { ccThreshold: facet.thresholds?.cc ?? null, crapThreshold: crapMax, gate: facet.gate ?? null } },
  });
}

// ── Coverage: scopes and modules under their floor, and the least covered files ──────────────────
// One record per source file: `SF:` opens it, `DA:<line>,<hits>` are its lines.
export function lcovFiles(text) {
  const files = [];
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      current = { file: line.slice(3), hits: new Map() };
      files.push(current);
    } else if (current && line.startsWith('DA:')) {
      const [n, h] = line.slice(3).split(',');
      current.hits.set(Number(n), Math.max(current.hits.get(Number(n)) ?? 0, Number(h) || 0));
    }
  }
  return files;
}

// Lines per file from a Cobertura report. A file split over several classes (partials, nested
// types) is one file; generated code is nobody's to cover. `scopeOf(class)` names the scope.
function coberturaFileLines(xml, scopeOf, pathScope) {
  const files = new Map();
  for (const c of coberturaClasses(xml)) {
    if (isGenerated(c.filename)) continue;
    const scope = scopeOf(c);
    const path = worklistPath(c.filename, pathScope ?? scope);
    const key = `${scope}\u0000${path}`;
    const entry = files.get(key) ?? { scope, path, module: moduleOf(c.filename), hits: new Map() };
    for (const [n, h] of c.hits) entry.hits.set(n, Math.max(entry.hits.get(n) ?? 0, h));
    files.set(key, entry);
  }
  return [...files.values()];
}

function lcovFileLines(text) {
  return lcovFiles(text).map(({ file, hits }) => {
    const path = worklistPath(file);
    return { scope: hygieneScopeOf(path) ?? 'lcov', path, module: moduleOf(path), hits };
  });
}

const byUncovered = (a, b) => b.detail.uncoveredLines - a.detail.uncoveredLines || a.value - b.value || String(a.path ?? a.symbol).localeCompare(String(b.path ?? b.symbol));

function coverageScopeItems(scopes) {
  return Object.entries(scopes)
    .filter(([, s]) => s.floor !== null && s.lineRate !== null && s.lineRate < s.floor)
    .map(([scope, s]) =>
      makeItem('coverage', 'ratchet', 'scope', {
        symbol: scope,
        value: s.lineRate,
        threshold: s.floor,
        detail: { scope, linesValid: s.linesValid, uncoveredLines: s.linesValid - s.linesCovered },
      }),
    )
    .sort(byUncovered);
}

// The floor is the scope's: a module under it is where the scope's gap sits.
function coverageModuleItems(scopes, moduleDirs) {
  const items = [];
  for (const [scope, s] of Object.entries(scopes)) {
    if (s.floor === null) continue;
    for (const [module, m] of Object.entries(s.modules ?? {})) {
      if (m.lineRate === null || m.lineRate >= s.floor) continue;
      items.push(
        makeItem('coverage', 'ratchet', 'module', {
          path: moduleDirs.get(`${scope}/${module}`) ?? null,
          symbol: `${scope}/${module}`,
          value: m.lineRate,
          threshold: s.floor,
          detail: { scope, module, linesValid: m.linesValid, uncoveredLines: m.linesValid - m.linesCovered },
        }),
      );
    }
  }
  return items.sort(byUncovered);
}

// A file is listed when it has uncovered lines and sits under its scope's floor; in a scope with no
// floor (a report-only assembly, an lcov report) every file with uncovered lines is, as `report`.
function coverageFileItems(files, floorOf) {
  const items = [];
  for (const f of files) {
    const valid = f.hits.size;
    const covered = [...f.hits.values()].filter((h) => h > 0).length;
    const floor = floorOf(f.scope);
    const rate = ratio(covered, valid);
    if (rate === null || covered === valid || (floor !== null && rate >= floor)) continue;
    items.push(
      makeItem('coverage', floor === null ? 'report' : 'ratchet', 'file', {
        path: f.path,
        value: rate,
        threshold: floor,
        detail: { scope: f.scope, module: f.module, linesValid: valid, uncoveredLines: valid - covered },
      }),
    );
  }
  return items.sort(byUncovered);
}

const commonDir = (a, b) => {
  const x = a.split('/');
  const y = b.split('/');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i += 1;
  return x.slice(0, i).join('/');
};

// The folder a module's files share, so a module item points somewhere.
function moduleDirsOf(files) {
  const dirs = new Map();
  for (const f of files) {
    const key = `${f.scope}/${f.module}`;
    const dir = f.path.split('/').slice(0, -1).join('/');
    dirs.set(key, dirs.has(key) ? commonDir(dirs.get(key), dir) : dir);
  }
  return new Map([...dirs].filter(([, dir]) => dir !== ''));
}

// `facet` is the coverage facet's data; without it the same numbers are computed from the Cobertura
// reports. `config` is quality.config.json's coverage section.
const coverageReports = ({ apiXml, webXml, lcov }) =>
  [
    { name: 'cobertura:api', files: apiXml ? coberturaFileLines(apiXml, (c) => c.package) : null },
    { name: 'cobertura:web', files: webXml ? coberturaFileLines(webXml, () => 'web', 'web') : null },
    { name: 'lcov', files: lcov.length ? lcov.flatMap(lcovFileLines) : null },
  ].filter((r) => r.files);

export function coverageCheck({ facet = null, apiXml = null, webXml = null, lcov = [], config = {} }, limit = DEFAULT_LIMIT) {
  const reports = coverageReports({ apiXml, webXml, lcov });
  if (!facet && reports.length === 0) return null;
  const floors = { api: config.api ?? {}, web: config.web ?? null };
  const data = facet ?? coverageFacetData({ apiXml, webXml, floors });
  const files = reports.flatMap((r) => r.files);
  const floorOf = (scope) => data.scopes[scope]?.floor ?? (scope === 'web' ? floors.web : null);
  return checkResult({
    mode: 'ratchet',
    groups: [coverageScopeItems(data.scopes), coverageModuleItems(data.scopes, moduleDirsOf(files)), coverageFileItems(files, floorOf)],
    limit,
    sources: [...(facet ? ['facet:coverage'] : []), ...reports.map((r) => r.name)],
    extra: { summary: { lineRate: data.global.lineRate, files: files.length } },
  });
}

// ── Mutation: scopes and modules under their floor, and the files with most survivors ────────────
const bySurvived = (a, b) => b.detail.survived - a.detail.survived || String(a.path ?? a.symbol).localeCompare(String(b.path ?? b.symbol));

function mutationScoreItems(scopes) {
  const scopeItems = [];
  const moduleItems = [];
  for (const [scope, s] of Object.entries(scopes)) {
    if (s.floor === null || s.floor === undefined) continue;
    const under = (m) => m.valid > 0 && m.coveredScore < s.floor;
    const detail = (m, extra) => ({ scope, ...extra, survived: m.survived, noCoverage: m.noCoverage, fullScore: m.fullScore });
    if (under(s)) scopeItems.push(makeItem('mutation', 'ratchet', 'scope', { symbol: scope, value: s.coveredScore, threshold: s.floor, detail: detail(s) }));
    for (const [module, m] of Object.entries(s.modules ?? {})) {
      if (!under(m)) continue;
      moduleItems.push(makeItem('mutation', 'ratchet', 'module', { symbol: `${scope}/${module}`, value: m.coveredScore, threshold: s.floor, detail: detail(m, { module }) }));
    }
  }
  return [scopeItems.sort(bySurvived), moduleItems.sort(bySurvived)];
}

// Stryker's report per scope: { files: { <path>: { mutants: [{ status, location }] } } }.
function mutationFileItems(reports, floors) {
  const items = [];
  for (const [scope, report] of Object.entries(reports)) {
    const floor = floors[scope] ?? null;
    for (const [file, info] of Object.entries(report.files ?? {})) {
      const mutants = info.mutants ?? [];
      const survivors = mutants.filter((m) => m.status === 'Survived');
      if (survivors.length === 0) continue;
      const counts = {};
      for (const m of mutants) counts[m.status] = (counts[m.status] ?? 0) + 1;
      const scores = mutationScores(counts);
      items.push(
        makeItem('mutation', floor === null ? 'report' : 'ratchet', 'file', {
          path: worklistPath(file, scope),
          line: firstLines(survivors.map((m) => m.location?.start?.line))[0] ?? null,
          value: survivors.length,
          detail: { scope, survived: survivors.length, noCoverage: scores.noCoverage, coveredScore: round(scores.coveredScore), lines: firstLines(survivors.map((m) => m.location?.start?.line)) },
        }),
      );
    }
  }
  return items.sort(bySurvived);
}

// `reports` is Stryker's JSON per scope (the weekly run); `facet` is the mutation facet's data, used
// for the scores when the reports are not at hand. `floors` is quality.config.json's mutation section.
export function mutationCheck({ facet = null, reports = null, floors = {} }, limit = DEFAULT_LIMIT) {
  const hasReports = isObject(reports) && Object.keys(reports).length > 0;
  if (!facet && !hasReports) return null;
  const data = hasReports ? mutationFacetData(reports, floors) : facet;
  return checkResult({
    mode: 'ratchet',
    groups: [...mutationScoreItems(data.scopes ?? {}), hasReports ? mutationFileItems(reports, floors) : []],
    limit,
    sources: hasReports ? ['stryker'] : ['facet:mutation'],
    extra: { summary: { coveredScore: data.global?.coveredScore ?? null, survived: data.global?.survived ?? null } },
  });
}

// ── Security: Trivy's critical and high findings ─────────────────────────────────────────────────
const SEVERE = ['CRITICAL', 'HIGH'];
const bySeverity = (a, b) =>
  SEVERE.indexOf(a.value) - SEVERE.indexOf(b.value) || Number(b.detail?.fixable ?? false) - Number(a.detail?.fixable ?? false) || `${a.rule}${a.path}`.localeCompare(`${b.rule}${b.path}`);

// The blocking scan ignores advisories with no fix, so only a fixable one is enforced.
function vulnerabilityItems(results) {
  const items = [];
  for (const r of results) {
    for (const v of r.Vulnerabilities ?? []) {
      if (!SEVERE.includes(v.Severity)) continue;
      const fixable = Boolean(v.FixedVersion);
      items.push(
        makeItem('security', fixable ? 'ratchet' : 'report', 'vulnerability', {
          rule: v.VulnerabilityID ?? null,
          path: worklistPath(r.Target),
          symbol: v.PkgName ?? null,
          value: v.Severity,
          message: oneLine(v.Title),
          detail: { installedVersion: v.InstalledVersion ?? null, fixedVersion: v.FixedVersion || null, fixable },
        }),
      );
    }
  }
  return items.sort(bySeverity);
}

function misconfigurationItems(results) {
  const items = [];
  for (const r of results) {
    for (const m of r.Misconfigurations ?? []) {
      if (!SEVERE.includes(m.Severity) || (m.Status && m.Status !== 'FAIL')) continue;
      items.push(
        makeItem('security', 'ratchet', 'misconfiguration', {
          rule: m.ID ?? m.AVDID ?? null,
          path: worklistPath(r.Target),
          line: m.CauseMetadata?.StartLine ?? null,
          symbol: m.CauseMetadata?.Resource || null,
          value: m.Severity,
          message: oneLine(m.Title),
        }),
      );
    }
  }
  return items.sort(bySeverity);
}

// Secrets are counted and never listed: Trivy's match is the secret's neighbourhood.
export function securityCheck(trivy, limit = DEFAULT_LIMIT) {
  if (!trivy) return null;
  if (!isObject(trivy)) throw new Error('not a Trivy JSON report');
  const results = trivy.Results ?? [];
  const vulnerabilities = vulnerabilityItems(results);
  const count = (severity) => vulnerabilities.filter((i) => i.value === severity).length;
  const secrets = results.reduce((n, r) => n + (r.Secrets ?? []).filter((s) => SEVERE.includes(s.Severity)).length, 0);
  return checkResult({
    mode: 'ratchet',
    groups: [vulnerabilities, misconfigurationItems(results)],
    limit,
    sources: ['trivy'],
    extra: { summary: { critical: count('CRITICAL'), high: count('HIGH'), fixable: vulnerabilities.filter((i) => i.detail.fixable).length, secrets } },
  });
}

// ── Semgrep: findings per rule and file ──────────────────────────────────────────────────────────
const SEMGREP_SEVERITIES = ['ERROR', 'WARNING', 'INFO'];

// One item per rule and file with the lines it fires on; the matched code (`extra.lines`) is left out.
export function semgrepCheck(report, limit = DEFAULT_LIMIT) {
  if (!report) return null;
  if (!Array.isArray(report.results)) throw new Error('not a Semgrep JSON report: expected { "results": [...] }');
  const groups = new Map();
  for (const r of report.results) {
    const path = worklistPath(r.path);
    const key = `${r.check_id}\u0000${path}`;
    const g = groups.get(key) ?? { rule: r.check_id ?? null, path, lines: [], severity: r.extra?.severity ?? null, message: oneLine(r.extra?.message) };
    g.lines.push(r.start?.line);
    groups.set(key, g);
  }
  // An unknown severity ranks last.
  const rank = (g) => (SEMGREP_SEVERITIES.includes(g.severity) ? SEMGREP_SEVERITIES.indexOf(g.severity) : SEMGREP_SEVERITIES.length);
  const items = [...groups.values()]
    .sort((a, b) => rank(a) - rank(b) || b.lines.length - a.lines.length || `${a.rule}${a.path}`.localeCompare(`${b.rule}${b.path}`))
    .map((g) =>
      makeItem('semgrep', 'ratchet', 'finding', {
        rule: g.rule,
        path: g.path,
        line: firstLines(g.lines)[0] ?? null,
        value: g.lines.length,
        threshold: 0,
        message: g.message,
        detail: { severity: g.severity, lines: firstLines(g.lines) },
      }),
    );
  return checkResult({ mode: 'ratchet', groups: [items], limit, sources: ['semgrep'], extra: { summary: { findings: report.results.length } } });
}

// ── Count baselines (dead code, architecture warnings, code patterns) ────────────────────────────
// What a per-rule ratchet holds: how many the rule has, how many it may have, and whether it is over.
function ruleTable(counts, baseline, violations, keyOf) {
  const over = new Set(violations.map(keyOf));
  return sortKeys(Object.fromEntries(Object.entries(counts).map(([rule, count]) => [rule, { count, baseline: baseline?.[rule] ?? null, over: over.has(rule) }])));
}

const byOverThenValue = (a, b) =>
  Number(b.detail.overBaseline) - Number(a.detail.overBaseline) || b.value - a.value || `${a.rule}${a.path}${a.symbol}`.localeCompare(`${b.rule}${b.path}${b.symbol}`);

// ── Dead code: Knip's unused files, exports and dependencies ─────────────────────────────────────
const deadCodeKind = (type) => {
  if (type === 'files') return 'unused-file';
  if (EXPORT_TYPES.includes(type)) return 'unused-export';
  if (UNUSED_DEPENDENCY_TYPES.includes(type)) return 'unused-dependency';
  if (UNLISTED_DEPENDENCY_TYPES.includes(type)) return 'unlisted-dependency';
  return 'other';
};
const DEAD_CODE_ORDER = ['unused-dependency', 'unlisted-dependency', 'unused-file', 'unused-export', 'other'];

// A Knip finding is { name, line?, col? }, a bare name, or (duplicates) a list of them.
const knipName = (finding) => {
  if (Array.isArray(finding)) return finding.map(knipName).filter(Boolean).join('|') || null;
  if (typeof finding === 'string') return finding;
  return typeof finding?.name === 'string' ? finding.name : null;
};

// `config` is quality.config.json's deadCode section. Unused and unlisted dependencies are held at
// zero once the check is a ratchet, whatever the baseline says.
export function deadCodeCheck(report, config, limit = DEFAULT_LIMIT) {
  if (!report) return null;
  const byType = knipCounts(report);
  const { violations } = evaluateDeadCode(byType, config);
  const rules = ruleTable(byType, config.baseline, violations, (v) => v.type);
  const groups = Object.fromEntries(DEAD_CODE_ORDER.map((kind) => [kind, []]));
  for (const row of report.issues) {
    for (const [type, findings] of Object.entries(row ?? {})) {
      if (type === 'file' || type === 'owners' || !Array.isArray(findings)) continue;
      const kind = deadCodeKind(type);
      for (const finding of findings) {
        groups[kind].push(
          makeItem('deadCode', config.mode, kind, {
            rule: type,
            path: worklistPath(row.file),
            line: Number.isInteger(finding?.line) ? finding.line : null,
            symbol: type === 'files' ? null : knipName(finding),
            value: 1,
            threshold: ZERO_TOLERANCE_TYPES.includes(type) ? 0 : null,
            baseline: ZERO_TOLERANCE_TYPES.includes(type) ? null : (config.baseline?.[type] ?? null),
            detail: { ruleCount: byType[type], overBaseline: rules[type].over },
          }),
        );
      }
    }
  }
  return checkResult({ mode: config.mode, groups: DEAD_CODE_ORDER.map((kind) => groups[kind].sort(byOverThenValue)), limit, sources: ['knip'], extra: { rules } });
}

// ── Duplication: jscpd's largest clones ──────────────────────────────────────────────────────────
// One item per pair of files, however many clones they share; the clone's text (`fragment`) is left
// out. The gate is blocking against scripts/duplication-baseline.json, so the check is a ratchet.
function clonePairs(duplicates) {
  const pairs = new Map();
  for (const d of duplicates) {
    if (!d.firstFile || !d.secondFile) continue;
    const path = worklistPath(d.firstFile.name);
    const other = worklistPath(d.secondFile.name);
    const lines = d.lines ?? 0;
    const pair = pairs.get(`${path}\u0000${other}`) ?? { path, other, lines: 0, tokens: 0, clones: 0, largest: { lines: -1 } };
    pair.lines += lines;
    pair.tokens += d.tokens ?? 0;
    pair.clones += 1;
    if (lines > pair.largest.lines) pair.largest = { lines, line: d.firstFile.start ?? null, otherLine: d.secondFile.start ?? null };
    pairs.set(`${path}\u0000${other}`, pair);
  }
  return [...pairs.values()];
}

export function duplicationCheck(report, { minLines = null } = {}, limit = DEFAULT_LIMIT) {
  if (!report) return null;
  if (!Array.isArray(report.duplicates)) throw new Error('not a jscpd JSON report: expected { "duplicates": [...] }');
  const items = clonePairs(report.duplicates)
    .sort((a, b) => b.lines - a.lines || `${a.path}${a.other}`.localeCompare(`${b.path}${b.other}`))
    .map((p) =>
      makeItem('duplication', 'ratchet', 'clone', {
        path: p.path,
        line: p.largest.line,
        symbol: p.other,
        value: p.lines,
        threshold: minLines,
        detail: { otherPath: p.other, otherLine: p.largest.otherLine, clones: p.clones, largestLines: p.largest.lines, tokens: p.tokens },
      }),
    );
  return checkResult({ mode: 'ratchet', groups: [items], limit, sources: ['jscpd'], extra: { summary: { clones: report.duplicates.length } } });
}

// ── Architecture: Steiger's diagnostics and the failing architecture tests ───────────────────────
// One item per rule and location. An error fails the web job in every mode; warnings follow the
// architecture section's mode and baseline.
function steigerItems(report, config) {
  const { byRule } = steigerCounts(report);
  const { violations } = evaluateArchitecture(byRule, config);
  const warnings = Object.fromEntries(Object.entries(byRule).map(([rule, r]) => [rule, r.warnings]));
  const rules = ruleTable(warnings, config.baseline, violations, (v) => v.rule);
  const groups = new Map();
  for (const d of report) {
    const path = worklistPath(d.location?.path, 'web');
    const key = [d.ruleName, d.severity, path].join('\u0000');
    const g = groups.get(key) ?? { rule: d.ruleName, error: d.severity === 'error', path, lines: [], message: oneLine(d.message) };
    g.lines.push(d.location?.start?.line);
    groups.set(key, g);
  }
  const items = [...groups.values()].map((g) =>
    makeItem('architecture', g.error ? 'ratchet' : config.mode, g.error ? 'steiger-error' : 'steiger-warning', {
      rule: g.rule,
      path: g.path,
      line: firstLines(g.lines)[0] ?? null,
      value: g.lines.length,
      threshold: g.error ? 0 : null,
      baseline: g.error ? null : (config.baseline?.[g.rule] ?? null),
      message: g.message,
      detail: { ruleCount: g.error ? byRule[g.rule].errors : byRule[g.rule].warnings, overBaseline: g.error || rules[g.rule].over },
    }),
  );
  return { rules, errors: items.filter((i) => i.kind === 'steiger-error').sort(byOverThenValue), warnings: items.filter((i) => i.kind === 'steiger-warning').sort(byOverThenValue) };
}

const decodeXml = (text) =>
  text.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const FAILED_OUTCOMES = new Set(['Failed', 'Error', 'Timeout', 'Aborted']);

// The failure message of each failed result, by position: the text between one <UnitTestResult and
// the next holds that result's <Message>.
function trxMessages(trx) {
  return trx.split('<UnitTestResult').slice(1).map((chunk) => {
    const message = chunk.match(/<Message>([\s\S]*?)<\/Message>/)?.[1];
    return message === undefined ? null : oneLine(decodeXml(message));
  });
}

// A failing architecture test fails the api job in every mode. The TRX names no source file.
function architectureTestItems(trx) {
  if (!/<TestRun\b/.test(trx)) throw new Error('not a VSTest TRX report: no <TestRun>');
  const messages = trxMessages(trx);
  return parseTrx(trx)
    .results.map((r, i) => ({ ...r, message: messages[i] ?? null }))
    .filter((r) => FAILED_OUTCOMES.has(r.outcome))
    .map((r) =>
      makeItem('architecture', 'ratchet', 'architecture-test', {
        symbol: decodeXml(r.className === 'unknown' ? r.name : `${r.className}.${r.name}`),
        value: 1,
        threshold: 0,
        message: r.message,
      }),
    )
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

const facetTestItems = (dotnet) =>
  (dotnet?.failing ?? []).map((name) => makeItem('architecture', 'ratchet', 'architecture-test', { symbol: name, value: 1, threshold: 0 }));

// `steiger` is Steiger's JSON, `trx` the architecture tests' report; `facet` (the architecture
// facet's data) names the failing tests when the TRX is not at hand. `config` is the architecture section.
export function architectureCheck({ steiger = null, trx = null, facet = null, config }, limit = DEFAULT_LIMIT) {
  if (!steiger && !trx && !facet?.dotnet) return null;
  const web = steiger ? steigerItems(steiger, config) : { rules: null, errors: [], warnings: [] };
  const tests = trx ? architectureTestItems(trx) : facetTestItems(facet?.dotnet);
  const sources = [steiger ? 'steiger' : null, trx ? 'trx' : null, !trx && facet?.dotnet ? 'facet:architecture' : null];
  return checkResult({
    mode: config.mode,
    groups: [tests, web.errors, web.warnings],
    limit,
    sources: sources.filter(Boolean),
    extra: web.rules ? { rules: web.rules } : {},
  });
}

// ── Code patterns: the .NET analyzers' findings ──────────────────────────────────────────────────
const LEVEL_RANK = { error: 0, warning: 1 };

// One item per rule and file, errors and warnings only (what the gate counts): notes and findings
// suppressed in source stay out. `config` is quality.config.json's patterns section.
export function patternsCheck(logs, config, limit = DEFAULT_LIMIT) {
  if (!logs || logs.length === 0) return null;
  const { findings } = sarifFindings(logs);
  const counts = analyzerCounts(findings);
  const gated = Object.fromEntries(Object.entries(counts.byRule).map(([rule, r]) => [rule, r.errors + r.warnings]).filter(([, n]) => n > 0));
  const { violations } = evaluatePatterns(counts.byRule, config);
  const rules = ruleTable(gated, config.baseline, violations, (v) => v.rule);
  const groups = new Map();
  for (const f of findings) {
    if (f.suppressed || !(f.level in LEVEL_RANK)) continue;
    const path = worklistPath(f.file);
    const key = `${f.ruleId}\u0000${path}`;
    const g = groups.get(key) ?? { rule: f.ruleId, path, lines: [], level: f.level, message: oneLine(f.message) };
    if (LEVEL_RANK[f.level] < LEVEL_RANK[g.level]) g.level = f.level;
    g.lines.push(f.line);
    groups.set(key, g);
  }
  const items = [...groups.values()].map((g) =>
    makeItem('patterns', config.mode, 'analyzer', {
      rule: g.rule,
      path: g.path,
      line: firstLines(g.lines)[0] ?? null,
      value: g.lines.length,
      baseline: config.baseline?.[g.rule] ?? null,
      message: g.message,
      detail: { level: g.level, analyzer: analyzerOf(g.rule), lines: firstLines(g.lines), ruleCount: gated[g.rule], overBaseline: rules[g.rule].over },
    }),
  );
  return checkResult({ mode: config.mode, groups: [items.sort(byOverThenValue)], limit, sources: ['sarif'], extra: { rules } });
}

// ── Bundle: entries over their budget ────────────────────────────────────────────────────────────
// `measurement` is the bundle facet's data or check-bundle-size.mjs's report; `sizeLimit` is
// `size-limit --json`, for the entries an app added with a limit of their own (listed, never gated).
// `config` is quality.config.json's bundle section. The budgeted total is always `total`, so its id
// does not depend on how an app names its first size-limit entry.
const bundleSummary = (measurement, config) => ({
  totalJsBytes: measurement.totalJsBytes,
  limitBytes: config.limitBytes ?? null,
  baselineBytes: config.baselineBytes ?? null,
  largestChunk: measurement.largestChunk ?? null,
  largestChunkBytes: measurement.largestChunkBytes ?? null,
});

export function bundleCheck({ measurement = null, sizeLimit = null, config }, limit = DEFAULT_LIMIT) {
  if (!measurement) return null;
  const entries = Array.isArray(sizeLimit) ? sizeLimit : [];
  const summary = bundleSummary(measurement, config);
  const items = [];
  if (summary.limitBytes !== null && summary.totalJsBytes > summary.limitBytes) {
    items.push(
      makeItem('bundle', config.mode, 'total', {
        symbol: 'total',
        value: summary.totalJsBytes,
        threshold: summary.limitBytes,
        baseline: summary.baselineBytes,
        detail: { compression: measurement.compression ?? null, largestChunk: summary.largestChunk, largestChunkBytes: summary.largestChunkBytes },
      }),
    );
  }
  for (const entry of entries.slice(1).filter((e) => e?.passed === false)) {
    items.push(makeItem('bundle', 'report', 'entry', { symbol: String(entry.name), value: entry.size ?? null, threshold: entry.sizeLimit ?? null }));
  }
  const sources = [measurement.gate ? 'facet:bundle' : 'bundle-report', ...(entries.length ? ['size-limit'] : [])];
  return checkResult({ mode: config.mode, groups: [items], limit, sources, extra: { summary } });
}

// ── The worklist ─────────────────────────────────────────────────────────────────────────────────
export function normalizeLimit(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// `inputs` holds whatever was found, parsed: `facets` (the data of each facet in ee/), and the raw
// reports. `config` is the parsed quality.config.json (parseQualityConfig). A check that throws on a
// malformed report is recorded as null and named in `unreadable`; the others are still built.
export function buildWorklist(inputs, config, { limit = DEFAULT_LIMIT } = {}) {
  const facets = inputs.facets ?? {};
  const builders = {
    complexity: () => complexityCheck(facets.complexity, limit),
    coverage: () => coverageCheck({ facet: facets.coverage, apiXml: inputs.apiCoverage, webXml: inputs.webCoverage, lcov: inputs.lcov ?? [], config: config.coverage }, limit),
    mutation: () => mutationCheck({ facet: facets.mutation, reports: inputs.mutationReports, floors: config.mutation }, limit),
    security: () => securityCheck(inputs.trivy, limit),
    semgrep: () => semgrepCheck(inputs.semgrep, limit),
    deadCode: () => deadCodeCheck(inputs.knip, config.deadCode, limit),
    duplication: () => duplicationCheck(inputs.jscpd, { minLines: inputs.jscpdMinLines ?? null }, limit),
    architecture: () => architectureCheck({ steiger: inputs.steiger, trx: inputs.trx, facet: facets.architecture, config: config.architecture }, limit),
    patterns: () => patternsCheck(inputs.sarifLogs, config.patterns, limit),
    bundle: () => bundleCheck({ measurement: facets.bundle ?? inputs.bundleReport, sizeLimit: inputs.sizeLimit, config: config.bundle }, limit),
  };
  const checks = {};
  const unreadable = [...(inputs.unreadable ?? [])];
  for (const check of CHECKS) {
    try {
      checks[check] = builders[check]() ?? null;
    } catch {
      checks[check] = null;
      if (!unreadable.includes(check)) unreadable.push(check);
    }
  }
  return { limit, checks, unreadable: unreadable.sort() };
}

// A short Markdown digest for the step summary.
export function worklistSummary(data) {
  const lines = ['### Engineering Excellence · worklist', '', '| Check | Mode | Items | Listed | From |', '|---|---|--:|--:|---|'];
  for (const check of CHECKS) {
    const c = data.checks[check];
    lines.push(c ? `| ${check} | ${c.mode} | ${c.total} | ${c.items.length} | ${c.sources.join(', ')} |` : `| ${check} | n/a | n/a | n/a | no report |`);
  }
  if (data.unreadable.length) lines.push('', `Could not be read (recorded as null): ${data.unreadable.join(', ')}.`);
  return lines.join('\n');
}

// `schema` is scripts/engineering-excellence-worklist.schema.json; the envelope is the facets' own.
export const validateWorklist = (doc, schema) => validate(doc, schema.$defs.envelope, '$', schema);
