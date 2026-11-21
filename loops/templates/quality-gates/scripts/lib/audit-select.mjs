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

import { budgetFor } from './bundle-gate.mjs';
import { ZERO_TOLERANCE_TYPES, buildBaseline as deadCodeBaseline, positiveCounts } from './dead-code-gate.mjs';
import { globToRegExp } from './engineering-excellence.mjs';
import { GRADUATION_CHECKS, parseQualityConfig } from './quality-config.mjs';
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
// what was measured when the story was filed, for the run that later checks whether it moved, and
// the check says where to look for the unit when CI no longer lists it.
const MARKER = /<!--\s*audit-item:\s*([0-9a-f]{16})\b([^>]*?)-->/g;
const markerValue = (value) => (value === null || value === undefined ? 'n/a' : String(value).replace(/[^\w.:+-]/g, '_'));

export function markerFor(unit) {
  return `<!-- audit-item: ${unit.id} value=${markerValue(unit.value)} target=${markerValue(unit.target)}${unit.check ? ` check=${unit.check}` : ''} -->`;
}

// Every marker in a text: [{ id, value, target, check }]. A marker written before 1.32.0 has no check.
export function markersIn(text) {
  const found = [];
  for (const match of String(text ?? '').matchAll(MARKER)) {
    const field = (name) => match[2].match(new RegExp(`\\b${name}=(\\S+)`))?.[1] ?? null;
    found.push({ id: match[1], value: field('value'), target: field('target'), check: field('check') });
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
  const reasons = [barReason(unit)].filter(Boolean);
  if (gotWorse(unit, previous, source)) reasons.push('regressed');
  return reasons;
}

const ALWAYS = ['vulnerable-package', 'vulnerability-count'];

// The unit against its own bar.
function barReason(unit) {
  const { value, target, bar } = unit;
  if (ALWAYS.includes(unit.kind)) return 'vulnerability';
  if (!isNumber(value)) return 'failed-gate';
  if (bar === 'baseline') return unit.over === true || (isNumber(target) && value > target) ? 'over-baseline' : null;
  if (bar !== 'threshold' || !isNumber(target)) return null;
  if (target === 0) return value > 0 ? 'failed-gate' : null;
  return worse(unit.direction, value, target) ? 'over-threshold' : null;
}

// The unit against the last audit.
function gotWorse(unit, previous, source) {
  const before = previous?.checks?.[unit.check];
  if (!before || !isNumber(unit.value)) return false;
  const was = before.units?.[unit.id];
  if (isNumber(was)) return worse(unit.direction, unit.value, was);
  return was === undefined && before.truncated === false && previous.source === source;
}

const SEMGREP_SEVERITY = { ERROR: 8, WARNING: 6, INFO: 4 };

// How much the check matters, 0 to 10. Fixed, so two runs over the same data rank alike.
const critical = (unit) => unit.value === 'CRITICAL';
const SEVERITY = {
  security: (unit) => {
    if (unit.kind === 'misconfiguration') return critical(unit) ? 9 : 8;
    if (unit.kind === 'vulnerability-count') return unit.critical > 0 ? 10 : 9;
    return critical(unit) ? 10 : 9;
  },
  architecture: (unit) => (unit.kind === 'steiger-warning' ? 4 : 8),
  semgrep: (unit) => SEMGREP_SEVERITY[unit.severity] ?? 5,
  complexity: () => 6,
  coverage: () => 6,
  mutation: () => 5,
  bundle: () => 5,
  deadCode: (unit) => (unit.bar === 'threshold' ? 5 : 3),
  patterns: (unit) => (unit.severity === 'error' ? 5 : 4),
  duplication: () => 2,
};

export const severityOf = (unit) => SEVERITY[unit.check]?.(unit) ?? 2;

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
  return riskFiles(checks)
    .filter((f) => f.coverage !== null && f.coverage < 1 && !ignored(f.path))
    .map((f) => ({ ...f, commits: changes ? (changes[f.path] ?? 0) : null }))
    .filter((f) => f.commits === null || f.commits > 0)
    .map(({ threshold, ...f }) => ({ ...f, score: riskScore(f, threshold) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

const riskScore = (file, threshold) => Math.round(100 * (0.4 * clamp(file.crap / (5 * (threshold || 30))) + 0.4 * (1 - file.coverage) + 0.2 * clamp((file.commits ?? 0) / 5)));

// Every file with a method over the CRAP threshold: its worst score, its methods, and how covered it
// is (the file's own rate when the worklist has it, else its least covered hotspot).
function riskFiles(checks) {
  const files = new Map();
  for (const item of checks.complexity?.items ?? []) {
    if (!item.path || !isNumber(item.value)) continue;
    const file = files.get(item.path) ?? { path: item.path, crap: 0, threshold: item.threshold, coverage: null, methods: [] };
    file.crap = Math.max(file.crap, item.value);
    file.coverage = leastCovered(file.coverage, item.detail?.coverage);
    if (file.methods.length < FILES_MAX) file.methods.push({ symbol: item.symbol, line: item.line, crap: item.value, cc: item.detail?.cc ?? null });
    files.set(item.path, file);
  }
  for (const item of checks.coverage?.items ?? []) {
    if (item.kind === 'file' && files.has(item.path) && isNumber(item.value)) files.get(item.path).coverage = item.value;
  }
  return [...files.values()];
}

const leastCovered = (known, coverage) => (isNumber(coverage) ? Math.min(known ?? 1, coverage) : known);

// ── Closing the loop ─────────────────────────────────────────────────────────────────────────────
// Each run compares the stories it filed with what CI measures now, by the unit id in their marker
// (re-derived from the worklist with unitsOfCheck, never a raw item id):
//   open, its pull request merged before the worklist was built, and within its bar or gone: closed
//     as completed with the numbers;
//   closed as completed and within its bar or gone: confirmed with the numbers, once;
//   closed as completed and still over its bar: reopened with the numbers, once. A story a person
//     closes again after that is their answer, and the unit is not filed again while it is in reach;
//   open otherwise: it keeps its story slot, so the audit files fewer new stories while old ones wait.
// Nothing is decided on data that cannot be believed, or that was measured before the change landed.
export const FOLLOW_UP_DAYS = 30;
const DAY = 86400000;
const FOLLOW_UP_MARKER = 'audit-follow-up';
const ROWS_MAX = 20;

// A check's rule counts as units where the worklist listed no item for the rule (cut by the limit,
// or at zero), so a rule-level story can still be measured.
function ruleUnits(check, data, known) {
  if (!isObject(data.rules) || !['deadCode', 'patterns', 'architecture'].includes(check)) return [];
  const units = [];
  for (const [rule, row] of Object.entries(data.rules)) {
    if (known.has(itemId({ check, rule })) || !isNumber(row?.count)) continue;
    const zero = check === 'deadCode' && ZERO_TOLERANCE_TYPES.includes(rule);
    const item = {
      id: itemId({ check, rule }),
      check,
      kind: check === 'architecture' ? 'steiger-warning' : 'count',
      rule,
      path: null,
      line: null,
      symbol: null,
      value: row.count,
      threshold: zero ? 0 : null,
      baseline: row.baseline ?? null,
      mode: 'ratchet',
      detail: {},
    };
    units.push(...groupedUnits(check, [item], data.rules));
  }
  return units;
}

// Every unit CI measures now, ignored ones included (an ignored unit is still measured), and per
// check whether a unit it does not list can be called gone.
export function measuredUnits(checks) {
  const units = new Map();
  const scope = {};
  for (const check of CHECKS.filter((name) => checks?.[name])) {
    const data = checks[check];
    scope[check] = { truncated: data.truncated !== false, mode: data.mode };
    if (data.mode === 'report') continue;
    for (const unit of unitsOfCheck(check, data.items.filter((i) => i.mode === 'ratchet'), data.rules ?? null).units) units.set(unit.id, unit);
    for (const unit of ruleUnits(check, data, units)) units.set(unit.id, unit);
  }
  return { units, scope };
}

const fromMarker = (value) => {
  if (value === null || value === undefined || value === 'n/a') return null;
  return Number.isFinite(Number(value)) && value !== '' ? Number(value) : value;
};

// Where a story's unit stands now: measured (and whether it is over its bar), gone, or unknown.
function standing(marker, measured, previous) {
  const unit = measured.units.get(marker.id);
  if (unit) return { state: 'measured', unit, check: unit.check, over: barReason(unit) !== null };
  const check = marker.check ?? CHECKS.find((name) => isObject(previous?.checks?.[name]?.units) && marker.id in previous.checks[name].units) ?? null;
  const scope = check ? measured.scope[check] : null;
  if (!scope || scope.truncated || scope.mode === 'report') return { state: 'unknown', check };
  return { state: 'gone', check };
}

const PERCENT_METRICS = ['rate'];
export function formatMeasure(value, metric = null) {
  if (value === null || value === undefined) return 'n/a';
  if (typeof value === 'number' && PERCENT_METRICS.includes(metric)) return `${round(value * 100, 1)}%`;
  if (typeof value === 'number' && metric === 'bytes') return `${value} bytes`;
  return String(value);
}

const shortTitle = (title) => {
  const flat = String(title ?? '').replace(/#/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
};

// One unit of a story: its numbers then and now. `after` is null when CI no longer lists it.
function rowOf(issue, marker, where, status) {
  const metric = where.unit?.metric ?? null;
  const target = where.unit ? where.unit.target : fromMarker(marker.target);
  return {
    issue: issue.number,
    title: shortTitle(issue.title),
    id: marker.id,
    check: where.check ?? marker.check ?? null,
    what: where.unit ? shown(where.unit) : null,
    metric,
    before: fromMarker(marker.value),
    after: where.state === 'measured' ? where.unit.value : null,
    gone: where.state === 'gone',
    target,
    status,
  };
}

const numbersOf = (row) =>
  `${formatMeasure(row.before, row.metric)} when filed, ${row.gone ? 'no longer listed by the check (within its bar)' : `${formatMeasure(row.after, row.metric)} now`}, target ${formatMeasure(row.target, row.metric)}`;

const rowLine = (row) => `**${row.check ?? 'unknown check'}**${row.what ? ` \`${row.what}\`` : ''}: ${numbersOf(row)}`;

const followUpMarker = (verdict, row) =>
  `<!-- ${FOLLOW_UP_MARKER}: ${verdict} id=${row.id} check=${row.check ?? 'n/a'} before=${markerValue(row.before)} after=${row.gone ? 'gone' : markerValue(row.after)} target=${markerValue(row.target)} metric=${row.metric ?? 'n/a'} -->`;

const COMMENT_LEAD = {
  close: 'Closed by the audit: the fix is merged and CI now measures this within its bar.',
  verify: 'Checked by the audit: CI now measures this within its bar.',
  reopen:
    'Reopened by the audit: this was closed as done, but CI still measures it over its bar. If the number is acceptable as it is, close this as not planned and the audit leaves it alone; it reopens a story only once.',
};

function followUpComment(verdict, rows, measuredAt) {
  const when = measuredAt ? ` (worklist of ${String(measuredAt).slice(0, 10)})` : '';
  return [COMMENT_LEAD[verdict], '', ...rows.map((row) => `- ${rowLine(row)}${when}`), '', ...rows.map((row) => followUpMarker(verdict, row))].join('\n');
}

const issueTime = (value) => (value ? Date.parse(value) : null);

// `issues` are { number, title, state, stateReason, body, closedAt, pulls: [{ number, merged, mergedAt }] }.
// `measuredAt` is when the worklist was built; `enabled` false only keeps track (no verdicts), for
// data that cannot be believed or a selection read from the facets.
export function followUp({ issues = [], checks = null, previous = null, measuredAt = null, now = new Date(), enabled = true } = {}) {
  const last = isObject(previous?.followUp) ? previous.followUp : {};
  const settledBefore = isObject(last.settled) ? last.settled : {};
  const reopenedBefore = new Set(Array.isArray(last.reopened) ? last.reopened : []);
  const measured = enabled && checks ? measuredUnits(checks) : null;
  const measuredTime = issueTime(measuredAt);
  const out = { tracked: new Map(), declined: new Map(), held: new Set(), actions: [], rows: [], settled: {}, reopened: [] };
  const inReach = new Set();

  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    const markers = markersIn(issue.body);
    if (markers.length === 0) continue;
    inReach.add(issue.number);
    const ids = markers.map((m) => m.id);
    const track = (map) => ids.forEach((id) => map.set(id, issue.number));

    if (issue.state === 'open') {
      track(out.tracked);
      out.held.add(issue.number);
      if (!measured || measuredTime === null) continue;
      const where = markers.map((m) => standing(m, measured, previous));
      const met = where.every((w) => w.state === 'gone' || (w.state === 'measured' && !w.over));
      const merged = (issue.pulls ?? []).some((p) => p?.merged && issueTime(p.mergedAt) !== null && issueTime(p.mergedAt) <= measuredTime);
      if (met && merged) {
        const rows = markers.map((m, i) => rowOf(issue, m, where[i], 'fixed'));
        out.rows.push(...rows);
        out.actions.push({ issue: issue.number, action: 'close', comment: followUpComment('close', rows, measuredAt) });
        out.held.delete(issue.number);
      } else {
        out.rows.push(...markers.map((m, i) => rowOf(issue, m, where[i], 'open')));
      }
      continue;
    }

    if (issue.stateReason === 'not_planned') {
      track(out.declined);
      continue;
    }

    // Closed as completed (or with no reason, as an older closing leaves it).
    const prior = settledBefore[issue.number];
    if (isObject(prior) && prior.closedAt === (issue.closedAt ?? null)) {
      out.settled[issue.number] = prior;
      if (prior.verdict === 'accepted') track(out.declined);
      continue;
    }
    const closedTime = issueTime(issue.closedAt);
    if (!measured || measuredTime === null || closedTime === null || now - closedTime > FOLLOW_UP_DAYS * DAY) continue;
    const where = markers.map((m) => standing(m, measured, previous));
    if (closedTime > measuredTime) {
      // Closed after CI last measured: the next worklist says whether it worked. Not filed again meanwhile.
      track(out.tracked);
      out.rows.push(...markers.map((m, i) => rowOf(issue, m, where[i], 'pending')));
      continue;
    }
    if (where.some((w) => w.state === 'measured' && w.over)) {
      const rows = markers.map((m, i) => rowOf(issue, m, where[i], 'regressed'));
      out.rows.push(...rows);
      if (reopenedBefore.has(issue.number)) {
        // Reopened once and closed again by a person: their answer.
        out.settled[issue.number] = { closedAt: issue.closedAt, verdict: 'accepted' };
        track(out.declined);
      } else {
        out.actions.push({ issue: issue.number, action: 'reopen', comment: followUpComment('reopen', rows, measuredAt) });
        out.reopened.push(issue.number);
        track(out.tracked);
        out.held.add(issue.number);
      }
      continue;
    }
    if (where.every((w) => w.state === 'gone' || w.state === 'measured')) {
      const rows = markers.map((m, i) => rowOf(issue, m, where[i], 'fixed'));
      out.rows.push(...rows);
      out.actions.push({ issue: issue.number, action: 'verify', comment: followUpComment('verify', rows, measuredAt) });
      out.settled[issue.number] = { closedAt: issue.closedAt, verdict: 'fixed' };
    }
  }

  out.reopened = [...new Set([...[...reopenedBefore].filter((n) => inReach.has(n)), ...out.reopened])].sort((a, b) => a - b);
  return out;
}

const STATUS_ORDER = ['fixed', 'regressed', 'open', 'pending'];
const STATUS_LABEL = { fixed: 'Fixed', regressed: 'Regressed (closed as done, still over its bar: reopened)', open: 'Still open', pending: 'Closed, waiting for CI to measure it' };

export function followUpCounts(rows) {
  const stories = (status) => new Set(rows.filter((r) => r.status === status).map((r) => r.issue)).size;
  return { fixed: stories('fixed'), open: stories('open'), regressed: stories('regressed'), pending: stories('pending') };
}

// The report's "Since last audit" section. No issue number: audit-close reads every `#N` in a
// report as work it waits on.
export function sinceLastAudit(rows) {
  if (!rows.length) return '';
  const counts = followUpCounts(rows);
  const lines = ['## Since last audit', '', `Fixed ${counts.fixed}, still open ${counts.open}, regressed ${counts.regressed}${counts.pending ? `, waiting for CI ${counts.pending}` : ''} (stories the audit filed before, by the number CI measures now).`, ''];
  const sorted = [...rows].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.issue - b.issue);
  for (const row of sorted.slice(0, ROWS_MAX)) {
    const numbers = row.after === null && !row.gone ? `${formatMeasure(row.before, row.metric)} when filed, not measured now, target ${formatMeasure(row.target, row.metric)}` : numbersOf(row);
    lines.push(`- ${STATUS_LABEL[row.status]}: **${row.check ?? 'unknown check'}**${row.what ? ` \`${row.what}\`` : ''}${row.title ? ` ("${row.title}")` : ''}: ${numbers}`);
  }
  if (sorted.length > ROWS_MAX) lines.push(`- and ${sorted.length - ROWS_MAX} more.`);
  return lines.join('\n');
}

// ── Graduation of report-only checks ─────────────────────────────────────────────────────────────
// A check in `report` mode for `audit.graduateAfterDays` (quality.config.json `<check>.since`, or the
// day the audit first saw it in report mode) gets ONE pull request that writes its baseline from the
// worklist (CI's data, never a local run) and switches it to `ratchet`. Never merged automatically:
// it carries the hold label, and a person decides. When the baseline would freeze junk
// (`audit.junk`), one clean-up story is filed first and the pull request waits for it.
const GRADUATION_LABEL = {
  deadCode: 'dead code (Knip)',
  architecture: 'architecture (Steiger warnings)',
  patterns: 'code patterns (.NET analyzers)',
  bundle: 'bundle size',
};
const JUNK_WHY = {
  deadCode: 'unused and unlisted dependencies are never baselined, so a ratchet fails on the first build while any is left',
  patterns: 'AD0001 means an analyzer crashed instead of reporting, so a baseline would freeze the crash and hide what it should have found',
};
const JUNK_LOCATIONS_MAX = 15;
export const graduationMarker = (check, cleanup = false) => `<!-- audit-graduation: ${check}${cleanup ? ' cleanup' : ''} -->`;
export const graduationBranch = (check) => `audit/graduate-${check.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
const GRADUATION_MARKER = /<!--\s*audit-graduation:\s*([A-Za-z]+)(\s+cleanup)?\s*-->/;

const dateOf = (date) => date.toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.floor((to - Date.parse(`${from}T00:00:00Z`)) / DAY);

// What the pull request writes into quality.config.json: the section's new keys, and the table.
function graduationPatch(check, data, since) {
  if (check === 'bundle') {
    const total = data.summary?.totalJsBytes;
    if (!isNumber(total)) return null;
    return { patch: { mode: 'ratchet', since, baselineBytes: total, limitBytes: budgetFor(total) }, table: { 'total JavaScript bytes': total, 'limit (baseline + 10%)': budgetFor(total) } };
  }
  if (!isObject(data.rules)) return null;
  const counts = Object.fromEntries(Object.entries(data.rules).filter(([, r]) => isNumber(r?.count)).map(([rule, r]) => [rule, r.count]));
  const baseline = check === 'deadCode' ? deadCodeBaseline(counts) : positiveCounts(counts);
  return { patch: { mode: 'ratchet', since, baseline }, table: baseline };
}

function cleanupStory(check, junk, data, since, measuredAt) {
  const label = GRADUATION_LABEL[check];
  const rules = Object.keys(junk);
  const locations = data.items
    .filter((i) => rules.includes(i.rule) && (i.path || i.symbol))
    .slice(0, JUNK_LOCATIONS_MAX)
    .map((i) => `- \`${i.path ?? ''}${i.line ? `:${i.line}` : ''}\`${i.symbol ? ` · \`${i.symbol}\`` : ''} (${i.rule})`);
  return {
    title: `Clear ${rules.join(', ')} before ${label} becomes a ratchet`,
    body: [
      `**As a** maintainer, **I want** the ${rules.join(', ')} findings of the ${label} check cleared, **so that** the check becomes a ratchet on a clean baseline.`,
      '',
      `The ${label} check has been in report mode since ${since}. Before the audit opens the pull request that records its baseline and switches it to \`ratchet\`, these findings go: ${JUNK_WHY[check] ?? 'a baseline would freeze them'}.`,
      '',
      '| Rule | Findings |',
      '|---|--:|',
      ...rules.map((rule) => `| ${rule} | ${junk[rule]} |`),
      '',
      `Where, from CI's worklist of ${String(measuredAt ?? '').slice(0, 10) || 'the default branch'}:`,
      ...(locations.length ? locations : ['- The worklist lists the counts only; the check\'s own report on the default branch names them.']),
      '',
      '#### Acceptance criteria',
      `- The default branch's worklist counts no ${rules.join(', ')} finding for this check.`,
      '- No baseline is written here: the audit opens that pull request itself once this is closed.',
      '',
      graduationMarker(check, true),
    ].join('\n'),
  };
}

function graduationPullRequest(check, { patch, table }, { since, sinceSource, ageDays, afterDays, worklist, junkAccepted }) {
  const label = GRADUATION_LABEL[check];
  const from = sinceSource === 'config' ? `\`${check}.since\` in quality.config.json` : 'the day the audit first saw it in report mode';
  const rows = Object.entries(table);
  const keys = check === 'bundle' ? '`bundle.baselineBytes` and `bundle.limitBytes`' : `\`${check}.baseline\``;
  return {
    title: `Quality gates: enforce ${label} as a ratchet`,
    branch: graduationBranch(check),
    patch,
    body: [
      `The **${label}** check has been in report mode since ${since} (${from}): ${ageDays} days, and the audit graduates a check after ${afterDays}. This pull request records its baseline from CI's own measurement and switches it to \`ratchet\`, so from now on a build fails when it gets worse than today.`,
      '',
      `**Baseline**, from the worklist of the default branch built ${String(worklist?.generatedAt ?? 'n/a').slice(0, 10)}${worklist?.commitSha ? ` at commit ${String(worklist.commitSha).slice(0, 7)}` : ''}${worklist?.runId ? `, run ${worklist.runId}` : ''}:`,
      '',
      check === 'bundle' ? '| Measure | Bytes |' : '| Rule | Findings |',
      '|---|--:|',
      ...(rows.length ? rows.map(([key, value]) => `| ${key} | ${value} |`) : ['| (none) | 0 |']),
      '',
      `**What changes:** \`quality.config.json\`: \`${check}.mode\` becomes \`ratchet\`, ${keys} as above, \`${check}.since\` ${sinceSource === 'config' ? 'kept' : `recorded as ${since}`}. Nothing else.`,
      ...(junkAccepted ? ['', `The clean-up story for this check was closed as not planned, so the baseline is written as CI measures it.`] : []),
      '',
      '**Not merged automatically.** A ratchet can block merges, so a person decides: approve and merge it, or close it. It carries the merge train\'s hold label, so nothing merges it on its own. Closed without merging, the audit does not open it again for 90 days.',
      '',
      graduationMarker(check),
    ].join('\n'),
  };
}

// `checks` are the worklist's; `issues` the audit's (clean-up stories carry a graduation marker).
export function graduation({ checks = null, config, previous = null, issues = [], worklist = null, now = new Date(), enabled = true } = {}) {
  const last = isObject(previous?.graduation) ? previous.graduation : {};
  const seenBefore = isObject(last.firstSeen) ? last.firstSeen : {};
  const reopenedBefore = new Set(Array.isArray(last.reopened) ? last.reopened : []);
  const out = { firstSeen: {}, reopened: [], checks: {}, actions: [] };
  if (!enabled || !checks) return { ...out, firstSeen: { ...seenBefore }, reopened: [...reopenedBefore] };
  const afterDays = config.audit.graduateAfterDays;
  const measuredTime = issueTime(worklist?.generatedAt);
  const today = dateOf(now);

  for (const check of GRADUATION_CHECKS) {
    const data = checks[check];
    const section = config[check];
    if (!data) {
      if (typeof seenBefore[check] === 'string' && section.mode !== 'ratchet') out.firstSeen[check] = seenBefore[check];
      continue;
    }
    if (section.mode === 'ratchet' || data.mode === 'ratchet') {
      out.checks[check] = { state: 'enforced' };
      continue;
    }
    const sinceSource = section.since ? 'config' : 'first-seen';
    const since = section.since ?? (typeof seenBefore[check] === 'string' ? seenBefore[check] : today);
    if (!section.since) out.firstSeen[check] = since;
    const ageDays = daysBetween(since, now);
    const facts = { since, sinceSource, ageDays, afterDays };
    if (afterDays === 0) {
      out.checks[check] = { state: 'off', ...facts };
      continue;
    }
    if (ageDays < afterDays) {
      out.checks[check] = { state: 'waiting', ...facts, readyOn: dateOf(new Date(Date.parse(`${since}T00:00:00Z`) + afterDays * DAY)) };
      continue;
    }
    const built = graduationPatch(check, data, since);
    let valid = Boolean(built);
    try {
      if (built) parseQualityConfig(JSON.stringify({ [check]: built.patch }));
    } catch {
      valid = false;
    }
    if (!valid) {
      out.checks[check] = { state: 'no-data', ...facts };
      continue;
    }

    const junkRules = config.audit.junk[check] ?? [];
    const junk = Object.fromEntries(junkRules.filter((rule) => (data.rules?.[rule]?.count ?? 0) > 0).map((rule) => [rule, data.rules[rule].count]));
    const story = [...issues]
      .filter((i) => GRADUATION_MARKER.exec(i.body ?? '')?.[1] === check && GRADUATION_MARKER.exec(i.body ?? '')?.[2])
      .sort((a, b) => b.number - a.number)[0];
    let junkAccepted = false;
    if (Object.keys(junk).length) {
      if (!story) {
        out.actions.push({ kind: 'cleanup-story', check, ...cleanupStory(check, junk, data, since, worklist?.generatedAt) });
        out.checks[check] = { state: 'cleanup-filed', ...facts, junk };
        continue;
      }
      if (story.state === 'open') {
        out.checks[check] = { state: 'cleanup-open', ...facts, junk, issue: story.number };
        continue;
      }
      if (story.stateReason === 'not_planned' || reopenedBefore.has(check)) junkAccepted = true;
      else if (issueTime(story.closedAt) !== null && measuredTime !== null && issueTime(story.closedAt) > measuredTime) {
        out.checks[check] = { state: 'cleanup-pending', ...facts, junk, issue: story.number };
        continue;
      } else {
        const counts = Object.entries(junk).map(([rule, count]) => `${rule} ${count}`).join(', ');
        out.actions.push({
          kind: 'cleanup-reopen',
          check,
          issue: story.number,
          comment: `Reopened by the audit: this was closed as done, but CI's worklist of ${String(worklist?.generatedAt ?? '').slice(0, 10)} still counts ${counts}. The ${GRADUATION_LABEL[check]} check graduates once they are gone. If they are acceptable, close this as not planned and the audit writes the baseline as it is.`,
        });
        out.reopened.push(check);
        out.checks[check] = { state: 'cleanup-reopened', ...facts, junk, issue: story.number };
        continue;
      }
    } else if (story?.state === 'open') {
      out.actions.push({ kind: 'cleanup-close', check, issue: story.number, comment: `Closed by the audit: CI's worklist of ${String(worklist?.generatedAt ?? '').slice(0, 10)} counts none of these any more, so the ${GRADUATION_LABEL[check]} check can graduate.` });
    }
    out.actions.push({ kind: 'pull-request', check, ...graduationPullRequest(check, built, { ...facts, worklist, junkAccepted }) });
    out.checks[check] = { state: 'ready', ...facts, ...(Object.keys(junk).length ? { junk } : {}) };
  }
  out.reopened = [...new Set([...reopenedBefore, ...out.reopened])].filter((check) => out.checks[check]?.state !== 'enforced').sort();
  return out;
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
export function selectAudit(input) {
  const { worklist, facets, config, configValid, previous, maxStories, changes, issues, now } = { ...INPUT_DEFAULTS, now: new Date(), ...input };
  const audit = config.audit;
  const limit = audit.limit ?? DEFAULT_LIMIT;
  const facetNames = SELECTION_FACETS.filter((name) => facets[name]);
  const base = baseDocument({ ...input, maxStories, now }, sourceOf(worklist, facetNames));
  if (base.source === 'none') return { ...base, clean: false, runAgent: true, storySlots: maxStories, storiesHeld: [], selected: [], riskMap: [] };

  const about = worklistFacts(worklist, now);
  const trustworthy = configValid && !about.unreadable.includes('config');
  base.problems.push(...dataProblems(trustworthy, about.ageDays));

  const checks = withMutationFacet(worklist ? worklist.data.checks : facetChecks(facets, config, limit), facets.mutation, limit);
  // Verdicts on stories and graduation pull requests are taken on the worklist only, and only when
  // its settings could be read: a selection from the facets, or from a broken config, only tracks.
  const decides = base.source === 'worklist' && trustworthy;
  const loop = followUp({ issues, checks, previous, measuredAt: about.generatedAt, now, enabled: decides });
  const graduating = graduation({ checks, config, previous, issues, worklist: about, now, enabled: decides });
  const ignore = ignoreMatcher(audit.ignore);
  const sorted = sortUnits(checks, { audit, ignore, source: base.source, previous, stories: { tracked: loop.tracked, declined: loop.declined } });
  // An open story keeps its slot: the audit files fewer new stories while old ones are unfinished.
  const storySlots = Math.max(0, maxStories - loop.held.size);
  const selected = sorted.eligible.slice(0, storySlots);
  const overCap = sorted.eligible.slice(selected.length).map(({ id, check, score }) => ({ id, check, score }));

  const slots = Math.max(0, storySlots - selected.length);
  const risk = slots > 0 ? riskMap(checks, { changes, limit: audit.riskFiles, ignored: ignore.path }) : [];
  const idle = selected.length === 0 && risk.length === 0;
  return {
    ...base,
    trustworthy,
    worklist: worklist ? about : null,
    facets: facetNames,
    notMeasured: CHECKS.filter((check) => !checks[check]),
    // Nothing to work on and data that can be believed: the agent does not start. Work that waits
    // only because open stories hold every slot is not clean.
    clean: idle && trustworthy && sorted.eligible.length === 0,
    runAgent: !idle,
    storySlots,
    storiesHeld: [...loop.held].sort((a, b) => a - b),
    selected,
    judgement: { slots, days: audit.riskDays, history: changes !== null },
    riskMap: risk,
    excluded: { ...sorted.excluded, ignored: listed(sorted.excluded.ignored), overCap: listed(overCap) },
    checks: sorted.snapshot,
    followUp: { enabled: decides, measuredAt: about.generatedAt, counts: followUpCounts(loop.rows), rows: loop.rows, actions: loop.actions, settled: loop.settled, reopened: loop.reopened },
    sinceLastAudit: { markdown: sinceLastAudit(loop.rows) },
    graduation: graduating,
  };
}

const INPUT_DEFAULTS = { worklist: null, facets: {}, configValid: true, previous: null, maxStories: DEFAULT_MAX_STORIES, changes: null, issues: [] };

function dataProblems(trustworthy, ageDays) {
  const problems = [];
  if (!trustworthy) problems.push('quality.config.json is not valid: the modes, floors and baselines are unknown, so a check that depends on them reads as not enforced.');
  if (ageDays !== null && ageDays > STALE_DAYS) problems.push(`The worklist is ${ageDays} days old: the default branch has not published one since.`);
  return problems;
}

function sourceOf(worklist, facetNames) {
  if (worklist) return 'worklist';
  return facetNames.length ? 'facets' : 'none';
}

function baseDocument({ maxStories = DEFAULT_MAX_STORIES, problems = [], now = new Date(), env = process.env }, source) {
  return {
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
}

function worklistFacts(worklist, now) {
  const generatedAt = worklist?.generatedAt ?? null;
  return {
    runId: worklist?.runId ?? null,
    commitSha: worklist?.commitSha ?? null,
    generatedAt,
    ageDays: generatedAt ? Math.floor((now - new Date(generatedAt)) / 86400000) : null,
    unreadable: worklist?.data?.unreadable ?? [],
  };
}

// Every check's items sorted into what is eligible (ranked) and why the rest is not, with the
// snapshot of every enforced unit's value for the next audit to compare against.
function sortUnits(checks, { audit, ignore, source, previous, stories }) {
  const last = isObject(previous) ? { source: previous.source ?? null, checks: isObject(previous.checks) ? previous.checks : {} } : null;
  const excluded = { notEnforced: {}, disabled: [], ignored: [], tracked: [], declined: [], withinBar: 0, folded: 0 };
  const snapshot = {};
  const eligible = [];
  for (const check of CHECKS.filter((name) => checks[name])) {
    const data = checks[check];
    const reportItems = data.items.filter((i) => i.mode !== 'ratchet');
    if (data.mode === 'report' || reportItems.length) excluded.notEnforced[check] = notEnforced(data, reportItems, previous?.excluded?.notEnforced?.[check]);
    if (!audit.checks[check]) {
      excluded.disabled.push(check);
      continue;
    }
    const { units, folded } = unitsOfCheck(check, enforcedItems(data.items, ignore, excluded.ignored), data.rules ?? null);
    excluded.folded += folded;
    snapshot[check] = { truncated: data.truncated, units: Object.fromEntries(units.filter((u) => isNumber(u.value)).map((u) => [u.id, u.value])) };
    for (const unit of units) placeUnit(unit, { excluded, eligible, stories, last, source });
  }
  return { eligible: eligible.sort(byRank), excluded, snapshot };
}

// The items CI enforces today, less the ones on the ignore list (recorded in `ignored`).
function enforcedItems(items, ignore, ignored) {
  const kept = [];
  for (const item of items.filter((i) => i.mode === 'ratchet')) {
    const by = ignore.item(item);
    if (by) ignored.push({ id: item.id, check: item.check, rule: item.rule, path: item.path, by });
    else kept.push(item);
  }
  return kept;
}

function placeUnit(unit, { excluded, eligible, stories, last, source }) {
  const { id, check } = unit;
  if (stories.tracked.has(id)) return excluded.tracked.push({ id, check, issue: stories.tracked.get(id) });
  if (stories.declined.has(id)) return excluded.declined.push({ id, check, issue: stories.declined.get(id) });
  const reasons = reasonsFor(unit, last, source);
  if (reasons.length === 0) return (excluded.withinBar += 1);
  return eligible.push({ ...present(unit), reasons, score: scoreOf(unit, reasons), marker: markerFor(unit) });
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
    const held = selection.storiesHeld ?? [];
    if (selection.clean) lines.push('**The repository is clean:** nothing enforced is over its bar or got worse, and no risky file changed. The agent does not start and nothing is filed.');
    else if (!selection.runAgent && selection.trustworthy && held.length && selection.storySlots === 0) lines.push(`**Every story slot is held by an open audit story** (${held.length} of ${selection.maxStories}). The agent does not start; new stories wait until those are done.`);
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
    if (held.length) lines.push(`Open audit stories holding a slot: ${held.length} of ${selection.maxStories}.`);
    if (selection.sinceLastAudit?.markdown) lines.push('', selection.sinceLastAudit.markdown.replace(/^## /, '#### '));
    const actions = selection.followUp?.actions ?? [];
    if (actions.length) lines.push('', `Follow-up: ${actions.map((a) => `${a.action} story ${a.issue}`).join(', ')}.`);
    const graduating = Object.entries(selection.graduation?.checks ?? {}).filter(([, g]) => g.state !== 'enforced');
    if (graduating.length) lines.push('', `Graduation of report-only checks: ${graduating.map(([check, g]) => `${check} ${g.state}${g.state === 'waiting' ? ` until ${g.readyOn}` : ''}`).join(', ')}.`);
  }
  for (const problem of selection.problems) lines.push('', `> ${problem}`);
  return lines.join('\n');
}
