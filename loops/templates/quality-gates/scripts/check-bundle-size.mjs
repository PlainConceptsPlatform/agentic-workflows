#!/usr/bin/env node
// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/check-bundle-size.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// The web bundle-size check: size-limit's JSON (`size-limit --json`, @size-limit/file over the static
// export's chunks) against the budget in quality.config.json `bundle`.
//
//   node scripts/check-bundle-size.mjs --size-limit apps/web/size-limit.json \
//     --chunks apps/web/out/_next/static/chunks --out apps/web/bundle-report.json
//   ... --write-baseline    # first baseline, budget = baseline + 10%
//   ... --update-baseline   # lower the baseline and budget after the bundle shrank; never raises them
//
// size-limit gives the total; the chunk directory gives the largest chunk, measured with the same
// compression as the first .size-limit.json entry. `--out` writes the measurement the
// engineering-excellence job turns into the bundle facet. Mode `report` (the default) never fails;
// mode `ratchet` fails when the total is over the budget, or when nothing could be measured.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { budgetFor, bundleMeasurement, compressionOf, evaluate, lowerBudget, sizeLimitEntries } from './lib/bundle-gate.mjs';
import { loadCheckConfig, today, writeCheckSection } from './lib/quality-config.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);
// One line per argument: the step summary is Markdown, and a table needs its rows on their own lines.
const say = (...lines) => console.log(lines.join('\n'));

const sizeLimitFile = opt('size-limit');
const chunksDir = opt('chunks');
if (!sizeLimitFile || !chunksDir) {
  console.error('usage: node scripts/check-bundle-size.mjs --size-limit <size-limit.json> --chunks <dir> [--config .size-limit.json] [--out <bundle-report.json>] [--write-baseline | --update-baseline]');
  process.exit(2);
}
const sizeLimitConfig = opt('config') ?? fileURLToPath(new URL('../.size-limit.json', import.meta.url));

const config = loadCheckConfig('bundle');
const kb = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;

console.log('### Bundle size (size-limit)');
say('');
console.log(
  config.mode === 'ratchet'
    ? `Mode: ratchet${config.since ? ` (check introduced ${config.since})` : ''}. A total over the budget fails.`
    : `Mode: report-only${config.since ? ` since ${config.since}` : ''}. Never fails CI; the switch to \`ratchet\` is a reviewed change to quality.config.json.`,
);

const missing = [sizeLimitFile, chunksDir].filter((p) => !existsSync(p));
if (missing.length) {
  say('', `Not measured: ${missing.join(' and ')} missing (the build or size-limit did not finish; see the step log).`);
  process.exit(config.mode === 'ratchet' ? 1 : 0);
}

const entries = sizeLimitEntries(JSON.parse(readFileSync(sizeLimitFile, 'utf8')));
const firstEntry = existsSync(sizeLimitConfig) ? JSON.parse(readFileSync(sizeLimitConfig, 'utf8'))[0] : {};
const compression = compressionOf(firstEntry);

// The same measure @size-limit/file applies to each file.
const sizeOf = (file) => {
  if (compression === 'none') return statSync(file).size;
  const bytes = readFileSync(file);
  if (compression === 'gzip') return gzipSync(bytes, { level: 9 }).length;
  return brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
};
const chunks = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) chunks.push({ file: relative(chunksDir, full).replaceAll('\\', '/'), bytes: sizeOf(full) });
  }
};
walk(chunksDir);

const measurement = bundleMeasurement({ entries, chunks, compression });
if (opt('out')) writeFileSync(opt('out'), `${JSON.stringify(measurement, null, 2)}\n`);

if (flag('write-baseline')) {
  // A ratchet's budget is never raised by a script: that would turn a red gate green without a fix.
  if (config.mode === 'ratchet' && config.baselineBytes !== null && measurement.totalJsBytes > config.baselineBytes) {
    console.error(`✗ bundle is a ratchet and this would raise its baseline from ${config.baselineBytes} to ${measurement.totalJsBytes} bytes. Shrink the bundle, or raise bundle.limitBytes by hand with the reason in the pull request.`);
    process.exit(2);
  }
  const written = writeCheckSection('bundle', (s) => ({
    ...s,
    mode: s.mode ?? 'report',
    since: s.since ?? today(),
    baselineBytes: measurement.totalJsBytes,
    limitBytes: budgetFor(measurement.totalJsBytes),
  }));
  say('', `· wrote bundle.baselineBytes ${written.baselineBytes} and bundle.limitBytes ${written.limitBytes} to quality.config.json`);
  process.exit(0);
}

if (flag('update-baseline')) {
  const lowered = lowerBudget(config, measurement.totalJsBytes);
  if (!lowered) {
    say('', `· no change: ${measurement.totalJsBytes} bytes is not below the baseline (${config.baselineBytes ?? 'none'}). This only ever lowers it.`);
    process.exit(0);
  }
  writeCheckSection('bundle', (s) => ({ ...s, ...lowered }));
  say('', `· bundle.baselineBytes ${config.baselineBytes} -> ${lowered.baselineBytes}, limitBytes ${config.limitBytes} -> ${lowered.limitBytes}`);
  process.exit(0);
}

const { overBudget, improved, failed } = evaluate(measurement, config);
const unit = compression === 'none' ? 'uncompressed' : compression;
say('', `Total JS: ${kb(measurement.totalJsBytes)} ${unit} in ${measurement.chunks} chunks · largest ${measurement.largestChunk ?? 'n/a'} ${kb(measurement.largestChunkBytes)}`);
if (config.limitBytes !== null) {
  console.log(`Budget: ${kb(config.limitBytes)} (baseline ${config.baselineBytes === null ? 'n/a' : kb(config.baselineBytes)} + 10%)`);
}
for (const extra of entries.slice(1)) console.log(`- ${extra.name}: ${kb(extra.size)} (listed, not gated)`);
const chunkTotal = chunks.reduce((n, c) => n + c.bytes, 0);
if (Math.abs(chunkTotal - measurement.totalJsBytes) > Math.max(1024, measurement.totalJsBytes * 0.02)) {
  say('', `Note: the first .size-limit.json entry measures ${kb(measurement.totalJsBytes)} but ${chunksDir} holds ${kb(chunkTotal)}; check that its path is the chunk directory.`);
}
if (improved) {
  say('', `Smaller than the baseline. Run \`node scripts/check-bundle-size.mjs ... --update-baseline\` to lower the budget with it.`);
}
if (config.limitBytes === null) {
  say('', 'No budget yet. Record one in a pull request with `node scripts/check-bundle-size.mjs ... --write-baseline`.');
}
if (overBudget) {
  say('', `${failed ? '✗' : '·'} Over budget by ${kb(measurement.totalJsBytes - config.limitBytes)}${failed ? '' : ' (report-only, not failing)'}. Compare the chunk list with the last green build (\`next build\` prints each route's first-load JS).`);
}
if (failed) process.exit(1);
say('', overBudget ? '· report-only: nothing fails' : '✓ within budget or no budget set');
