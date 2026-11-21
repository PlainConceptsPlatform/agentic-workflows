// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/audit-select.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// What this week's audit works on, decided from the repository's own health data and without a
// model. `scripts/audit-select.mjs` runs before the audit agent, reads the newest
// `engineering-excellence-worklist` from the default branch (or, where a repository publishes facets
// and no worklist, the facets), and writes the selection the agent starts from.
//
// Pure functions over parsed documents; the CLI does the reading. Nothing here throws for a missing
// input: a repository is audited on whatever it publishes.
//
// Items become units, because a story is about a unit and several items are often one problem: a
// file's methods, a rule's findings, a package's advisories. A unit keeps a stable id, so a story
// filed for it is found again next week by the marker in its body, whatever its title says.
//
// What never leaves the worklist: a tool's message. Semgrep's and an analyzer's can echo the code
// they matched, and a story is public-facing text; a unit carries the rule, the path and the line.

import { ZERO_TOLERANCE_TYPES } from './dead-code-gate.mjs';
import { globToRegExp } from './engineering-excellence.mjs';
import { CHECKS, DEFAULT_LIMIT, buildWorklist, itemId, mutationCheck } from './worklist.mjs';

export const SELECTION_VERSION = 1;
export const SOURCES = ['worklist', 'facets', 'none'];
// The facets a selection is built from when there is no worklist.
export const SELECTION_FACETS = ['complexity', 'coverage', 'mutation', 'security', 'hygiene', 'architecture', 'bundle'];
export const DEFAULT_MAX_STORIES = 3;
const FILES_MAX = 8;
const LIST_MAX = 50;
const STALE_DAYS = 14;

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const clamp = (n) => Math.max(0, Math.min(1, n));
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// ── The marker ───────────────────────────────────────────────────────────────────────────────────
// Hidden in the story's body. The id is what matches a story to its unit; the value and target are
// what was measured when the story was filed, for the run that later checks whether it moved.
const MARKER = /<!--\s*audit-item:\s*([0-9a-f]{16})\b([^>]*?)-->/g;
const markerValue = (value) => (value === null || value === undefined ? 'n/a' : String(value).replace(/[^\w.:+-]/g, '_'));

export function markerFor(unit) {
  return `<!-- audit-item: ${unit.id} value=${markerValue(unit.value)} target=${markerValue(unit.target)} -->`;
}

// Every marker in a text: [{ id, value, target }].
export function markersIn(text) {
  const found = [];
  for (const match of String(text ?? '').matchAll(MARKER)) {
    const attr = (name) => match[2].match(new RegExp(`\\b${name}=(\\S+)`))?.[1] ?? null;
    found.push({ id: match[1], value: attr('value'), target: attr('target') });
  }
  return found;
}

// `issues` are { number, state, stateReason, body }. An open story tracks its unit; one closed as
// not planned is the team's answer, and the unit is not filed again while that issue is in reach.
export function storiesByUnit(issues) {
  const tracked = new Map();
  const declined = new Map();
  for (const issue of [...(issues ?? [])].sort((a, b) => a.number - b.number)) {
    for (const { id } of markersIn(issue.body)) {
      if (issue.state === 'open') tracked.set(id, issue.number);
      else if (issue.stateReason === 'not_planned') declined.set(id, issue.number);
    }
  }
  return { tracked, declined };
}

// ── Facets, when there is no worklist ────────────────────────────────────────────────────────────
// A facet that only counts gives an item with no location: the story says how many and which tool
// lists them. `rules` is { rule: { count, baseline, over } } where the facet has a baseline.
function countItem(check, mode, kind, { rule = null, value, threshold = null, baseline = null, detail }) {
  return { id: itemId({ check, rule, symbol: kind }), check, kind, rule, path: null, line: null, symbol: null, value, threshold, baseline, mode, message: null, detail };
}

const countCheck = (mode, items, sources, extra = {}) => ({ mode, total: items.length, truncated: false, sources, ...extra, items });

// The security facet: Trivy's and Semgrep's counts by severity, with no finding named.
function securityFacetChecks(facet) {
  const out = {};
  const vuln = facet?.trivy?.vuln;
  if (vuln) {
    const severe = (vuln.CRITICAL ?? 0) + (vuln.HIGH ?? 0);
    const fixable = facet.trivy.fixableVulns ?? 0;
    const items = severe > 0 ? [countItem('security', fixable > 0 ? 'ratchet' : 'report', 'vulnerability-count', { value: severe, threshold: 0, detail: { critical: vuln.CRITICAL ?? 0, high: vuln.HIGH ?? 0, fixable } })] : [];
    out.security = countCheck('ratchet', items, ['facet:security'], { summary: { critical: vuln.CRITICAL ?? 0, high: vuln.HIGH ?? 0, fixable, secrets: null } });
  }
  const semgrep = facet?.semgrep;
  if (semgrep) {
    const items = ['ERROR', 'WARNING']
      .filter((severity) => (semgrep[severity] ?? 0) > 0)
      .map((severity) => countItem('semgrep', 'ratchet', 'finding-count', { rule: severity, value: semgrep[severity], threshold: 0, detail: { severity } }));
    out.semgrep = countCheck('ratchet', items, ['facet:security'], { summary: { findings: semgrep.total ?? null } });
  }
  return out;
}

// The hygiene facet: Knip's counts per issue type, and the files with most duplicated lines when the
// duplication gate reports violations.
function hygieneFacetChecks(facet, config) {
  const out = {};
  const web = facet?.deadCode?.web;
  if (web?.byType) {
    const { mode, baseline } = config.deadCode;
    const rules = {};
    const items = [];
    for (const [type, count] of Object.entries(web.byType).sort(([a], [b]) => a.localeCompare(b))) {
      const zero = ZERO_TOLERANCE_TYPES.includes(type);
      const allowed = zero ? null : (baseline?.[type] ?? null);
      const over = mode === 'ratchet' && (zero ? count > 0 : allowed !== null && count > allowed);
      rules[type] = { count, baseline: allowed, over };
      if (count > 0) items.push(countItem('deadCode', mode, 'count', { rule: type, value: count, threshold: zero ? 0 : null, baseline: allowed, detail: { ruleCount: count, overBaseline: over } }));
    }
    out.deadCode = countCheck(mode, items, ['facet:hygiene'], { rules });
  }
  if ((facet?.gate?.violations ?? 0) > 0) {
    const items = (facet.hotspots ?? []).map((h) => ({
      ...countItem('duplication', 'ratchet', 'duplicated-file', { value: h.duplicatedLines, threshold: facet.thresholds?.minLines ?? null, detail: { lines: h.lines ?? null, gateViolations: facet.gate.violations } }),
      id: itemId({ check: 'duplication', path: h.file }),
      path: h.file,
    }));
    out.duplication = countCheck('ratchet', items, ['facet:hygiene'], { summary: { clones: null } });
  }
  return out;
}

// `facets` is { name: data } for whichever facets were found; `config` the parsed quality.config.json.
// The checks have the worklist's shape, built by the worklist's own functions where a facet has the
// detail (complexity, coverage, mutation, architecture, bundle) and from counts where it has not.
export function facetChecks(facets, config, limit = DEFAULT_LIMIT) {
  const { checks } = buildWorklist({ facets }, config, { limit });
  return { ...checks, ...securityFacetChecks(facets.security), ...hygieneFacetChecks(facets.hygiene, config) };
}

// The worklist is built where Stryker's reports are not (they live in the weekly mutation run), so
// its mutation check is null; the mutation facet fills it with the scopes and modules under their floor.
export function withMutationFacet(checks, facet, limit = DEFAULT_LIMIT) {
  if (checks.mutation || !facet) return checks;
  return { ...checks, mutation: mutationCheck({ facet }, limit) };
}

// ── Units ────────────────────────────────────────────────────────────────────────────────────────
const SEVERITIES = ['CRITICAL', 'HIGH'];
const worstSeverity = (items) => SEVERITIES.find((s) => items.some((i) => i.value === s)) ?? null;
const sum = (items) => items.reduce((n, i) => n + (isNumber(i.value) ? i.value : 0), 0);
const fileOf = (item) => ({
  path: item.path,
  line: item.line,
  symbol: item.symbol,
  value: item.value,
  ...(item.detail?.lines ? { lines: item.detail.lines } : {}),
  ...(item.detail?.otherPath ? { otherPath: item.detail.otherPath, otherLine: item.detail.otherLine ?? null } : {}),
});

// How each check's items group, and what the group measures. `bar` says what `target` is: a fixed
// `threshold`, or a ratchet's `baseline`. `direction` is the way that is worse.
const GROUPING = {
  complexity: (item) => ({
    key: item.path ?? item.symbol,
    id: () => itemId({ check: 'complexity', rule: 'crap', path: item.path, symbol: item.path ? null : item.symbol }),
    unit: (items) => ({ kind: 'file', rule: 'crap', path: item.path, symbol: null, value: Math.max(...items.map((i) => i.value)), target: item.threshold, metric: 'crap', direction: 'higher', bar: 'threshold' }),
  }),
  security: (item) =>
    item.kind === 'vulnerability'
      ? {
          key: `package\u0000${item.path}\u0000${item.symbol}`,
          id: () => itemId({ check: 'security', path: item.path, symbol: item.symbol }),
          unit: (items) => ({
            kind: 'vulnerable-package',
            rule: null,
            path: item.path,
            symbol: item.symbol,
            value: worstSeverity(items),
            target: [...new Set(items.map((i) => i.detail?.fixedVersion).filter(Boolean))].join(' | ') || null,
            metric: 'severity',
            direction: null,
            bar: null,
            advisories: items.map((i) => i.rule).filter(Boolean).slice(0, FILES_MAX),
            installedVersion: item.detail?.installedVersion ?? null,
          }),
        }
      : single(item, item.kind === 'vulnerability-count' ? { metric: 'count', direction: 'higher', bar: 'threshold', critical: item.detail?.critical ?? 0 } : { metric: 'severity', direction: null, bar: null }),
  semgrep: (item) => byRule(item, 'semgrep', (items) => ({ value: sum(items), target: 0, bar: 'threshold', severity: item.detail?.severity ?? null })),
  deadCode: (item) =>
    byRule(item, 'deadCode', (items, rules) => ({
      value: rules?.[item.rule]?.count ?? sum(items),
      target: item.threshold === 0 ? 0 : (rules?.[item.rule]?.baseline ?? item.baseline),
      bar: item.threshold === 0 ? 'threshold' : 'baseline',
      over: rules?.[item.rule]?.over ?? null,
    })),
  patterns: (item) =>
    byRule(item, 'patterns', (items, rules) => ({
      value: rules?.[item.rule]?.count ?? sum(items),
      target: rules?.[item.rule]?.baseline ?? item.baseline,
      bar: 'baseline',
      over: rules?.[item.rule]?.over ?? null,
      severity: items.some((i) => i.detail?.level === 'error') ? 'error' : 'warning',
    })),
  architecture: (item) => {
    if (item.kind === 'steiger-error') {
      return {
        key: `error\u0000${item.rule}`,
        id: () => itemId({ check: 'architecture', rule: item.rule, symbol: 'error' }),
        unit: (items) => ({ kind: 'steiger-error', rule: item.rule, path: null, symbol: null, value: item.detail?.ruleCount ?? sum(items), target: 0, metric: 'count', direction: 'higher', bar: 'threshold' }),
      };
    }
    if (item.kind === 'steiger-warning') {
      return byRule(item, 'architecture', (items, rules) => ({
        kind: 'steiger-warning',
        value: rules?.[item.rule]?.count ?? sum(items),
        target: rules?.[item.rule]?.baseline ?? item.baseline,
        bar: 'baseline',
        over: rules?.[item.rule]?.over ?? null,
      }));
    }
    return single(item, { metric: 'count', direction: 'higher', bar: 'threshold' });
  },
  duplication: (item) => single(item, { metric: 'lines', direction: 'higher', bar: 'threshold' }),
  bundle: (item) => single(item, { metric: 'bytes', direction: 'higher', bar: 'threshold' }),
};

function single(item, measure) {
  return {
    key: `item\u0000${item.id}`,
    id: () => item.id,
    unit: () => ({ kind: item.kind, rule: item.rule, path: item.path, symbol: item.symbol, value: item.value, target: item.threshold, ...measure }),
  };
}

function byRule(item, check, measure) {
  return {
    key: `rule\u0000${item.rule}`,
    id: () => itemId({ check, rule: item.rule }),
    unit: (items, rules) => ({ kind: 'rule', rule: item.rule, path: null, symbol: null, metric: 'count', direction: 'higher', ...measure(items, rules) }),
  };
}

function groupedUnits(check, items, rules) {
  const groups = new Map();
  for (const item of items) {
    const grouping = GROUPING[check](item);
    const group = groups.get(grouping.key) ?? { grouping, items: [] };
    group.items.push(item);
    groups.set(grouping.key, group);
  }
  return [...groups.values()].map(({ grouping, items: members }) => ({
    id: grouping.id(),
    check,
    ...grouping.unit(members, rules),
    files: members.filter((i) => i.path || i.symbol).slice(0, FILES_MAX).map(fileOf),
    items: members.length,
  }));
}

// The work a rate hides: the lines still to cover to reach the floor, or the mutants that survived.
// A module of four lines at 0% is further from its floor than a large one at 50%, and far less work.
function gapOf(check, item) {
  if (check === 'mutation') return isNumber(item.detail?.survived) ? item.detail.survived : null;
  if (!isNumber(item.value) || !isNumber(item.threshold) || !isNumber(item.detail?.linesValid)) return null;
  return Math.max(0, Math.ceil((item.threshold - item.value) * item.detail.linesValid));
}

// Coverage and mutation: a scope under its floor, the modules that hold the gap, the files in them.
// A module is the story; its files go with it, and a scope with modules under the floor is told
// through them. `folded` counts what was merged into another unit.
function rateUnits(check, items) {
  const rate = (item) => ({
    id: item.id,
    check,
    kind: item.kind,
    rule: null,
    path: item.path,
    symbol: item.symbol,
    value: item.value,
    target: item.threshold,
    metric: item.kind === 'file' && check === 'mutation' ? 'survivors' : 'rate',
    direction: item.kind === 'file' && check === 'mutation' ? 'higher' : 'lower',
    bar: 'threshold',
    gap: gapOf(check, item),
    files: item.path ? [fileOf(item)] : [],
    items: 1,
  });
  const moduleItems = items.filter((i) => i.kind === 'module');
  const units = moduleItems.map(rate);
  const moduleOf = new Map(moduleItems.map((i, index) => [`${i.detail?.scope}\u0000${i.detail?.module}`, units[index]]));
  const scopesWithModules = new Set(moduleItems.map((i) => i.detail?.scope));
  let folded = 0;
  for (const item of items) {
    if (item.kind === 'scope') {
      if (scopesWithModules.has(item.detail?.scope ?? item.symbol)) folded += 1;
      else units.push(rate(item));
    } else if (item.kind === 'file') {
      const owner = moduleOf.get(`${item.detail?.scope}\u0000${item.detail?.module}`);
      if (!owner) units.push(rate(item));
      else {
        folded += 1;
        owner.items += 1;
        if (owner.files.length < FILES_MAX) owner.files.push(fileOf(item));
      }
    }
  }
  return { units, folded };
}

// The units of one check's items (ratchet items only reach here).
export function unitsOfCheck(check, items, rules = null) {
  if (check === 'coverage' || check === 'mutation') return rateUnits(check, items);
  return { units: groupedUnits(check, items, rules), folded: 0 };
}

// ── Eligibility and score ────────────────────────────────────────────────────────────────────────
const worse = (direction, now, before) => (direction === 'lower' ? now < before : now > before);

// Why a unit is worked on this week, or [] when it is within its bar and did not get worse.
// `previous` is the last run's { source, checks: { check: { truncated, units: { id: value } } } }.
// A unit it does not hold is new only when that run saw the whole check from the same source.
export function reasonsFor(unit, previous = null, source = previous?.source) {
  const reasons = [];
  const { value, target, bar, direction } = unit;
  if (unit.kind === 'vulnerable-package' || unit.kind === 'vulnerability-count') reasons.push('vulnerability');
  else if (!isNumber(value)) reasons.push('failed-gate');
  else if (bar === 'threshold' && target === 0 && value > 0) reasons.push('failed-gate');
  else if (bar === 'threshold' && isNumber(target) && worse(direction, value, target)) reasons.push('over-threshold');
  else if (bar === 'baseline' && (unit.over === true || (isNumber(target) && value > target))) reasons.push('over-baseline');

  const before = previous?.checks?.[unit.check];
  if (before && isNumber(value)) {
    const was = before.units?.[unit.id];
    if (isNumber(was) ? worse(direction, value, was) : was === undefined && before.truncated === false && previous.source === source) reasons.push('regressed');
  }
  return reasons;
}

const SEMGREP_SEVERITY = { ERROR: 8, WARNING: 6, INFO: 4 };

// How much the check matters, 0 to 10. Fixed, so two runs over the same data rank alike.
export function severityOf(unit) {
  switch (unit.check) {
    case 'security':
      if (unit.kind === 'misconfiguration') return unit.value === 'CRITICAL' ? 9 : 8;
      if (unit.kind === 'vulnerability-count') return unit.critical > 0 ? 10 : 9;
      return unit.value === 'CRITICAL' ? 10 : 9;
    case 'architecture':
      return unit.kind === 'steiger-warning' ? 4 : 8;
    case 'semgrep':
      return SEMGREP_SEVERITY[unit.severity] ?? 5;
    case 'complexity':
    case 'coverage':
      return 6;
    case 'mutation':
    case 'bundle':
      return 5;
    case 'deadCode':
      return unit.bar === 'threshold' ? 5 : 3;
    case 'patterns':
      return unit.severity === 'error' ? 5 : 4;
    default:
      return 2;
  }
}

// How far past its bar, 0 to 1: five times a threshold, ten findings where none is allowed, double a
// baseline, a hundred lines short of a coverage floor or twenty surviving mutants all count as 1. A
// rate with no size beside it counts by how far under its floor it is.
const GAP_FULL = { coverage: 100, mutation: 20 };

export function distanceOf(unit) {
  const { value, target, bar, direction } = unit;
  if (!isNumber(value)) return 1;
  if (!isNumber(target)) return 0;
  if (direction === 'lower' && isNumber(unit.gap) && GAP_FULL[unit.check]) return value < target ? clamp(unit.gap / GAP_FULL[unit.check]) : 0;
  if (bar === 'baseline') return clamp((value - target) / Math.max(target, 1));
  if (target === 0) return clamp(value / 10);
  if (direction === 'lower') return clamp((target - value) / target);
  return clamp((value / target - 1) / 4);
}

// score = 10 x severity + 10 x distance + 5 when it got worse since the last audit.
export const scoreOf = (unit, reasons) => round(10 * severityOf(unit) + 10 * distanceOf(unit) + (reasons.includes('regressed') ? 5 : 0));

const byRank = (a, b) => b.score - a.score || CHECKS.indexOf(a.check) - CHECKS.indexOf(b.check) || a.id.localeCompare(b.id);

// ── The risk map ─────────────────────────────────────────────────────────────────────────────────
// Where the judgement pass reads: files that are complex and poorly covered and, when the history
// is at hand, changed in the last `days`. `changes` is { path: commits } or null without history.
// risk = 100 x (0.4 x complexity + 0.4 x uncovered + 0.2 x churn), each from 0 to 1.
export function riskMap(checks, { changes = null, limit = 5, ignored = () => false } = {}) {
  const files = new Map();
  const entry = (path) => files.get(path) ?? files.set(path, { path, crap: null, threshold: null, coverage: null, methods: [] }).get(path);
  for (const item of checks.complexity?.items ?? []) {
    if (!item.path || !isNumber(item.value)) continue;
    const file = entry(item.path);
    file.crap = Math.max(file.crap ?? 0, item.value);
    file.threshold = item.threshold;
    if (isNumber(item.detail?.coverage)) file.coverage = Math.min(file.coverage ?? 1, item.detail.coverage);
    if (file.methods.length < FILES_MAX) file.methods.push({ symbol: item.symbol, line: item.line, crap: item.value, cc: item.detail?.cc ?? null });
  }
  for (const item of checks.coverage?.items ?? []) {
    if (item.kind === 'file' && item.path && files.has(item.path) && isNumber(item.value)) entry(item.path).coverage = item.value;
  }
  return [...files.values()]
    .filter((f) => f.crap !== null && f.coverage !== null && f.coverage < 1 && !ignored(f.path))
    .map((f) => ({ ...f, commits: changes ? (changes[f.path] ?? 0) : null }))
    .filter((f) => f.commits === null || f.commits > 0)
    .map((f) => ({
      ...f,
      score: Math.round(100 * (0.4 * clamp(f.crap / (5 * (f.threshold || 30))) + 0.4 * (1 - f.coverage) + 0.2 * clamp((f.commits ?? 0) / 5))),
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map(({ threshold, ...f }) => f);
}

// ── The selection ────────────────────────────────────────────────────────────────────────────────
function ignoreMatcher(ignore) {
  const rules = new Set(ignore.rules);
  const globs = ignore.paths.map(globToRegExp);
  const path = (p) => typeof p === 'string' && globs.some((re) => re.test(p));
  return { path, item: (item) => (item.rule !== null && rules.has(item.rule) ? 'rule' : path(item.path) ? 'path' : null) };
}

const listed = (list) => ({ count: list.length, items: list.slice(0, LIST_MAX) });

// What a check that is measured and not enforced holds, for the report's "Not yet enforced" section.
function notEnforced(check, reportItems, before) {
  const whole = check.mode === 'report';
  const count = whole ? Math.max(check.total, reportItems.length) : reportItems.length;
  const rules = whole && check.rules ? Object.fromEntries(Object.entries(check.rules).filter(([, r]) => r.count > 0).sort(([, a], [, b]) => b.count - a.count).slice(0, 5).map(([rule, r]) => [rule, r.count])) : null;
  const previous = isNumber(before?.count) ? before.count : null;
  return { mode: check.mode, count, previous, change: previous === null ? null : count - previous, ...(rules ? { rules } : {}) };
}

const present = (unit) => {
  const { over, bar, direction, critical, ...rest } = unit;
  return rest;
};

// `input`:
//   worklist   the worklist document (envelope) or null
//   facets     { name: data } for the facets found, used when there is no worklist (mutation: always)
//   config     parsed quality.config.json; configValid false when it could not be parsed
//   issues     [{ number, state, stateReason, body }]: open issues and those closed lately
//   previous   the last run's selection document, or null
//   changes    { path: commits in the last riskDays } or null when the history is not at hand
export function selectAudit({ worklist = null, facets = {}, config, configValid = true, issues = [], previous = null, maxStories = DEFAULT_MAX_STORIES, changes = null, problems = [], now = new Date(), env = process.env }) {
  const audit = config.audit;
  const limit = audit.limit ?? DEFAULT_LIMIT;
  const facetNames = SELECTION_FACETS.filter((name) => facets[name]);
  const source = worklist ? 'worklist' : facetNames.length ? 'facets' : 'none';
  const base = {
    schemaVersion: SELECTION_VERSION,
    kind: 'audit-selection',
    repo: env.GITHUB_REPOSITORY ?? null,
    runId: env.GITHUB_RUN_ID ? Number(env.GITHUB_RUN_ID) : null,
    generatedAt: now.toISOString(),
    source,
    trustworthy: true,
    problems: [...problems],
    maxStories,
  };
  if (source === 'none') return { ...base, clean: false, runAgent: true, selected: [], riskMap: [] };

  const unreadable = worklist?.data?.unreadable ?? [];
  const trustworthy = configValid && !unreadable.includes('config');
  if (!trustworthy) base.problems.push('quality.config.json is not valid: the modes, floors and baselines are unknown, so a check that depends on them reads as not enforced.');
  const ageDays = worklist?.generatedAt ? Math.floor((now - new Date(worklist.generatedAt)) / 86400000) : null;
  if (ageDays !== null && ageDays > STALE_DAYS) base.problems.push(`The worklist is ${ageDays} days old: the default branch has not published one since.`);

  const checks = withMutationFacet(worklist ? worklist.data.checks : facetChecks(facets, config, limit), facets.mutation, limit);
  const ignore = ignoreMatcher(audit.ignore);
  const { tracked, declined } = storiesByUnit(issues);
  const last = isObject(previous) ? { source: previous.source ?? null, checks: isObject(previous.checks) ? previous.checks : {} } : null;

  const excluded = { notEnforced: {}, disabled: [], ignored: [], tracked: [], declined: [], withinBar: 0, folded: 0, overCap: [] };
  const snapshot = {};
  const eligible = [];
  for (const check of CHECKS) {
    const data = checks[check];
    if (!data) continue;
    const reportItems = data.items.filter((i) => i.mode !== 'ratchet');
    if (data.mode === 'report' || reportItems.length) excluded.notEnforced[check] = notEnforced(data, reportItems, previous?.excluded?.notEnforced?.[check]);
    if (!audit.checks[check]) {
      excluded.disabled.push(check);
      continue;
    }
    const kept = [];
    for (const item of data.items) {
      if (item.mode !== 'ratchet') continue;
      const by = ignore.item(item);
      if (by) excluded.ignored.push({ id: item.id, check, rule: item.rule, path: item.path, by });
      else kept.push(item);
    }
    const { units, folded } = unitsOfCheck(check, kept, data.rules ?? null);
    excluded.folded += folded;
    snapshot[check] = { truncated: data.truncated, units: {} };
    for (const unit of units) {
      if (isNumber(unit.value)) snapshot[check].units[unit.id] = unit.value;
      if (tracked.has(unit.id)) excluded.tracked.push({ id: unit.id, check, issue: tracked.get(unit.id) });
      else if (declined.has(unit.id)) excluded.declined.push({ id: unit.id, check, issue: declined.get(unit.id) });
      else {
        const reasons = reasonsFor(unit, last, source);
        if (reasons.length === 0) excluded.withinBar += 1;
        else eligible.push({ ...present(unit), reasons, score: scoreOf(unit, reasons), marker: markerFor(unit) });
      }
    }
  }
  eligible.sort(byRank);
  const selected = eligible.slice(0, Math.max(0, maxStories));
  excluded.overCap = eligible.slice(selected.length).map(({ id, check, score }) => ({ id, check, score }));

  const slots = Math.max(0, maxStories - selected.length);
  const risk = slots > 0 && audit.riskFiles > 0 ? riskMap(checks, { changes, limit: audit.riskFiles, ignored: ignore.path }) : [];
  const idle = selected.length === 0 && risk.length === 0;
  return {
    ...base,
    trustworthy,
    worklist: worklist ? { runId: worklist.runId ?? null, commitSha: worklist.commitSha ?? null, generatedAt: worklist.generatedAt ?? null, ageDays, unreadable } : null,
    facets: facetNames,
    notMeasured: CHECKS.filter((check) => !checks[check]),
    // Nothing to work on and data that can be believed: the agent does not start.
    clean: idle && trustworthy,
    runAgent: !idle,
    selected,
    judgement: { slots, days: audit.riskDays, history: changes !== null },
    riskMap: risk,
    excluded: { ...excluded, ignored: listed(excluded.ignored), overCap: listed(excluded.overCap) },
    checks: snapshot,
  };
}

// ── The run summary ──────────────────────────────────────────────────────────────────────────────
const shown = (unit) => [unit.rule, unit.symbol, unit.path].filter(Boolean).join(' · ') || unit.kind;

export function selectionSummary(selection) {
  const lines = ['### Audit selection', ''];
  if (selection.source === 'none') {
    lines.push('This repository publishes no engineering health data (no `engineering-excellence-worklist` and no facet on the default branch), so the audit explores the repository as before.');
  } else {
    const from = selection.source === 'worklist' ? `the worklist of ${selection.worklist.generatedAt ?? 'an unknown date'}` : `the facets (${selection.facets.join(', ')}); this repository publishes no worklist yet`;
    lines.push(`Read from ${from}.`, '');
    if (selection.clean) lines.push('**The repository is clean:** nothing enforced is over its bar or got worse, and no risky file changed. The agent does not start and nothing is filed.');
    else if (!selection.runAgent) lines.push('**Nothing could be selected, and the data cannot be trusted** (see below). The agent does not start; this is not a clean audit.');
    if (selection.selected.length) {
      lines.push('| # | Check | What | Measured | Target | Why | Score |', '|--:|---|---|---|---|---|--:|');
      selection.selected.forEach((u, i) => lines.push(`| ${i + 1} | ${u.check} | \`${shown(u)}\` | ${u.value ?? 'n/a'} | ${u.target ?? 'n/a'} | ${u.reasons.join(', ')} | ${u.score} |`));
    }
    const e = selection.excluded;
    lines.push(
      '',
      `Not selected: ${e.tracked.length} already tracked by an open story, ${e.declined.length} closed as not planned, ${e.ignored.count} on the ignore list, ${e.withinBar} within their bar, ${e.overCap.count} over the limit of ${selection.maxStories} stories${e.disabled.length ? `, checks switched off: ${e.disabled.join(', ')}` : ''}.`,
    );
    const pending = Object.entries(e.notEnforced).map(([check, n]) => `${check} ${n.count}${n.change ? ` (${n.change > 0 ? '+' : ''}${n.change})` : ''}`);
    if (pending.length) lines.push(`Not yet enforced (measured, no story): ${pending.join(', ')}.`);
    lines.push(`Judgement pass: ${selection.riskMap.length} file(s), ${selection.judgement.slots} story slot(s) free.`);
  }
  for (const problem of selection.problems) lines.push('', `> ${problem}`);
  return lines.join('\n');
}
