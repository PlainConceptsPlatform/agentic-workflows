// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/quality-config.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// The app's quality bar from quality.config.json at the repository root: the gate scripts are shared
// by the platform family, the numbers they enforce are not. Schema: docs/family-templates.md in agentic-workflows.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CONFIG_FILE = fileURLToPath(new URL('../../quality.config.json', import.meta.url));

const KEYS = { root: ['$schema', 'coverage', 'mutation'], coverage: ['api', 'reportOnly', 'web'] };

const isRate = (value) => typeof value === 'number' && value >= 0 && value <= 1;

function rates(map, where, problems) {
  if (map === undefined) return {};
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
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

export function parseQualityConfig(text, file = CONFIG_FILE) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
  const problems = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file} must hold a JSON object`);
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
  if (problems.length > 0) throw new Error(`${file}:\n  ${problems.join('\n  ')}`);
  return { coverage: { api, reportOnly, web: coverage.web ?? null }, mutation };
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
