// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/bundle-gate.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Rules for the web bundle-size check (size-limit with @size-limit/file over the static export's
// JavaScript chunks). Pure functions; the CLI is scripts/check-bundle-size.mjs, which measures in the
// web job, and the bundle facet reads the same measurement, so the gate and the facet agree.
//
// The budget is the baseline plus 10%, both in quality.config.json `bundle`. In `ratchet` mode a build
// whose total is over the budget fails; in `report` mode nothing fails. The headroom is there so an
// ordinary feature does not need a config change. Scripts only ever lower the baseline
// (--update-baseline); raising it is a person's reviewed edit.

export const BUDGET_HEADROOM_PERCENT = 10;

// Integer arithmetic: 412000 * 1.1 is 453200.00000000006 in floating point, a byte the budget never meant.
export const budgetFor = (baselineBytes) => Math.ceil((baselineBytes * (100 + BUDGET_HEADROOM_PERCENT)) / 100);

// @size-limit/file compresses with brotli unless an entry says `gzip: true` or `brotli: false`.
export function compressionOf(entry = {}) {
  if (entry.gzip === true) return 'gzip';
  if (entry.brotli === false) return 'none';
  return 'brotli';
}

// `size-limit --json` prints [{ name, size, passed?, sizeLimit? }, ...]. The first entry is the budgeted
// total; the others, if an app added any, are listed but not gated.
export function sizeLimitEntries(json) {
  if (!Array.isArray(json) || json.length === 0) throw new Error('not a size-limit --json report: expected a non-empty array');
  return json.map((entry, i) => {
    if (!Number.isInteger(entry?.size) || entry.size < 0) throw new Error(`size-limit entry ${i} has no size`);
    return { name: String(entry.name ?? `entry ${i + 1}`), size: entry.size };
  });
}

// `chunks` is [{ file, bytes }] measured with the entry's compression; file is relative to the chunk directory.
export function bundleMeasurement({ entries, chunks, compression }) {
  const largest = [...chunks].sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file))[0] ?? null;
  return {
    tool: 'size-limit',
    compression,
    totalJsBytes: entries[0].size,
    largestChunkBytes: largest?.bytes ?? 0,
    largestChunk: largest?.file ?? null,
    chunks: chunks.length,
    entries,
  };
}

// `config` is quality.config.json's bundle section: { mode, since, baselineBytes, limitBytes }.
export function evaluate(measurement, config) {
  const limit = config.limitBytes ?? null;
  const overBudget = limit !== null && measurement.totalJsBytes > limit;
  const improved = config.baselineBytes !== null && config.baselineBytes !== undefined && measurement.totalJsBytes < config.baselineBytes;
  return { overBudget, improved, failed: config.mode === 'ratchet' && overBudget };
}

export function bundleFacetData(measurement, config) {
  const { overBudget, failed } = evaluate(measurement, config);
  return {
    tool: measurement.tool,
    compression: measurement.compression,
    totalJsBytes: measurement.totalJsBytes,
    largestChunkBytes: measurement.largestChunkBytes,
    largestChunk: measurement.largestChunk,
    chunks: measurement.chunks,
    baselineBytes: config.baselineBytes ?? null,
    limitBytes: config.limitBytes ?? null,
    overBudget,
    gate: { mode: config.mode, since: config.since ?? null, violations: overBudget ? 1 : 0, failed },
  };
}

// Only ever downwards: a smaller bundle lowers the baseline and the budget with it; a larger one
// changes nothing. Raising the budget is a reviewed edit of quality.config.json, never this.
export function lowerBudget(config, totalJsBytes) {
  if (config.baselineBytes === null || config.baselineBytes === undefined || totalJsBytes >= config.baselineBytes) return null;
  return { baselineBytes: totalJsBytes, limitBytes: Math.min(config.limitBytes ?? Infinity, budgetFor(totalJsBytes)) };
}
