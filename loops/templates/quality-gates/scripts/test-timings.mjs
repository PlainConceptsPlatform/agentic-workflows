#!/usr/bin/env node
// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/test-timings.mjs. Update with `workflows update --force`; consumer edits may be overwritten.

// Usage: node scripts/test-timings.mjs <dir-with-trx> [--top 15]
// Prints where the test run's time went as Markdown, for the job summary. Never fails the job.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseTrx, summarize, toMarkdown } from './lib/test-timings.mjs';

const [dir = 'TestResults', ...rest] = process.argv.slice(2);
const top = Number(rest[rest.indexOf('--top') + 1]) || 15;

function trxFiles(root) {
  try {
    return readdirSync(root).flatMap((entry) => {
      const full = join(root, entry);
      return statSync(full).isDirectory() ? trxFiles(full) : entry.endsWith('.trx') ? [full] : [];
    });
  } catch {
    return [];
  }
}

const runs = trxFiles(dir).map((file) => summarize(parseTrx(readFileSync(file, 'utf8')), top)).filter((t) => t.tests > 0);
console.log(runs.length ? toMarkdown(runs.sort((a, b) => b.wall - a.wall)) : `### Test timings\n\nNo .trx reports under ${dir}.`);
