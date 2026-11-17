// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/quality-config.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// The app's quality bar from quality.config.json at the repository root: the gate scripts are shared
// by the platform family, the numbers they enforce are not. Schema: docs/family-templates.md in agentic-workflows.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CONFIG_FILE = fileURLToPath(new URL('../../quality.config.json', import.meta.url));

// A check starts in `report` (measured, never fails CI) and becomes a `ratchet` against its committed
// baseline when the app flips the mode in a reviewed change. Nothing flips it automatically.
export const CHECK_MODES = ['report', 'ratchet'];

const KEYS = {
  root: ['$schema', 'architecture', 'bundle', 'coverage', 'deadCode', 'mutation'],
  coverage: ['api', 'reportOnly', 'web'],
  deadCode: ['baseline', 'mode', 'since'],
  bundle: ['baselineBytes', 'limitBytes', 'mode', 'since'],
  architecture: ['baseline', 'mode', 'since'],
};

const isRate = (value) => typeof value === 'number' && value >= 0 && value <= 1;
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function rates(map, where, problems) {
  if (map === undefined) return {};
  if (!isObject(map)) {
    problems.push(`${where} must be an object of name -> rate`);
    return {};
  }
  for (const [name, value] of Object.entries(map)) {
    if (!isRate(value)) problems.push(`${where}.${name} must be a number between 0 and 1, got ${JSON.stringify(value)}`);
  }
  return map;
}

function unknownKeys(object, allowed, where, problems) {
  for (const key of Object.keys(object ?? {})) {
    if (!allowed.includes(key)) problems.push(`${where}${key} is not a known setting (expected one of: ${allowed.join(', ')})`);
  }
}

// The settings every report-then-ratchet check shares: its mode and the day it was introduced.
function checkSection(raw, name, problems) {
  if (raw === undefined) return { section: {}, mode: 'report', since: null };
  if (!isObject(raw)) {
    problems.push(`${name} must be an object`);
    return { section: {}, mode: 'report', since: null };
  }
  unknownKeys(raw, KEYS[name], `${name}.`, problems);
  const mode = raw.mode ?? 'report';
  if (!CHECK_MODES.includes(mode)) problems.push(`${name}.mode must be one of ${CHECK_MODES.join(', ')}, got ${JSON.stringify(raw.mode)}`);
  const since = raw.since ?? null;
  if (since !== null && (typeof since !== 'string' || !DATE.test(since))) {
    problems.push(`${name}.since must be a date written YYYY-MM-DD, got ${JSON.stringify(raw.since)}`);
  }
  return { section: raw, mode, since };
}

// A baseline of counts per kind (a Knip issue type, a Steiger rule), required once the check is a ratchet.
function countBaselineSection(raw, name, what, writeWith, problems) {
  const { section, mode, since } = checkSection(raw, name, problems);
  let baseline = section.baseline ?? null;
  if (baseline !== null) {
    if (!isObject(baseline)) {
      problems.push(`${name}.baseline must be an object of ${what} -> count`);
      baseline = null;
    } else {
      for (const [key, value] of Object.entries(baseline)) {
        if (!isCount(value)) problems.push(`${name}.baseline.${key} must be a whole number of findings, got ${JSON.stringify(value)}`);
      }
    }
  }
  if (mode === 'ratchet' && baseline === null) {
    problems.push(`${name}.mode is ratchet but ${name}.baseline is missing: write it with \`${writeWith}\` first`);
  }
  return { mode, since, baseline };
}

const deadCodeSection = (raw, problems) =>
  countBaselineSection(raw, 'deadCode', 'Knip issue type', 'node scripts/check-dead-code.mjs --report <knip.json> --write-baseline', problems);

const architectureSection = (raw, problems) =>
  countBaselineSection(raw, 'architecture', 'Steiger rule', 'node scripts/check-architecture.mjs --report <steiger-report.json> --write-baseline', problems);

function bundleSection(raw, problems) {
  const { section, mode, since } = checkSection(raw, 'bundle', problems);
  const baselineBytes = section.baselineBytes ?? null;
  const limitBytes = section.limitBytes ?? null;
  if (baselineBytes !== null && !isCount(baselineBytes)) problems.push(`bundle.baselineBytes must be a whole number of bytes, got ${JSON.stringify(baselineBytes)}`);
  if (limitBytes !== null && !isCount(limitBytes)) problems.push(`bundle.limitBytes must be a whole number of bytes, got ${JSON.stringify(limitBytes)}`);
  if (mode === 'ratchet' && limitBytes === null) {
    problems.push('bundle.mode is ratchet but bundle.limitBytes is missing: write it with `node scripts/check-bundle-size.mjs ... --write-baseline` first');
  }
  return { mode, since, baselineBytes, limitBytes };
}

export function parseQualityConfig(text, file = CONFIG_FILE) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
  const problems = [];
  if (!isObject(raw)) throw new Error(`${file} must hold a JSON object`);
  unknownKeys(raw, KEYS.root, '', problems);
  const coverage = raw.coverage ?? {};
  unknownKeys(coverage, KEYS.coverage, 'coverage.', problems);
  const api = rates(coverage.api, 'coverage.api', problems);
  const reportOnly = coverage.reportOnly ?? [];
  if (!Array.isArray(reportOnly) || reportOnly.some((name) => typeof name !== 'string')) {
    problems.push('coverage.reportOnly must be an array of assembly names');
  }
  if (coverage.web !== undefined && !isRate(coverage.web)) {
    problems.push(`coverage.web must be a number between 0 and 1, got ${JSON.stringify(coverage.web)}`);
  }
  const mutation = rates(raw.mutation, 'mutation', problems);
  const deadCode = deadCodeSection(raw.deadCode, problems);
  const bundle = bundleSection(raw.bundle, problems);
  const architecture = architectureSection(raw.architecture, problems);
  if (problems.length > 0) throw new Error(`${file}:\n  ${problems.join('\n  ')}`);
  return { coverage: { api, reportOnly, web: coverage.web ?? null }, mutation, deadCode, bundle, architecture };
}

export function loadQualityConfig(file = CONFIG_FILE) {
  if (!existsSync(file)) {
    throw new Error(
      `${file} not found. The quality gates read the app's floors from it; see "quality.config.json" in ` +
        'https://github.com/PlainConceptsPlatform/agentic-workflows/blob/main/docs/family-templates.md',
    );
  }
  return parseQualityConfig(readFileSync(file, 'utf8'), file);
}

// The report-then-ratchet checks run before an app has a quality.config.json section for them, so a
// missing file reads as their defaults (report mode, no baseline) instead of failing a report-only run.
export function loadCheckConfig(name, file = CONFIG_FILE) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '{}';
  return parseQualityConfig(text, file)[name];
}

// Writes one section of quality.config.json (a baseline, written on purpose by a person or an agent
// in a pull request a person reviews). Every other key is kept as it is; the file is re-indented.
export function writeCheckSection(name, update, file = CONFIG_FILE) {
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  raw[name] = update(raw[name] ?? {});
  // Validate before writing, so a bad write never lands in the file.
  parseQualityConfig(JSON.stringify(raw), file);
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  return raw[name];
}

export const today = (now = new Date()) => now.toISOString().slice(0, 10);
