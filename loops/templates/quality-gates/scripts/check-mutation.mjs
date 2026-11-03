#!/usr/bin/env node
// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/check-mutation.mjs. Update with `workflows update --force`; consumer edits may be overwritten.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { mutationScores, tallyMutants } from './lib/engineering-excellence.mjs';
import { loadQualityConfig } from './lib/quality-config.mjs';

// The covered-code floor per scope is the app's: `mutation` in quality.config.json.

// Mutant states and the score formula live in scripts/lib/engineering-excellence.mjs so the
// Engineering Excellence facet reports exactly what this gate judged. `Killed`/`Timeout` are
// detections; `CompileError`/`RuntimeError` are Stryker's problem rather than the
// suite's, and `Ignored` was filtered deliberately, so all three are excluded.

function main() {
  const [scope, file] = process.argv.slice(2);
  if (!scope || !file) {
    console.error('usage: node scripts/check-mutation.mjs <scope> <mutation-report.json>');
    process.exit(2);
  }
  let floors;
  try {
    floors = loadQualityConfig().mutation;
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(2);
  }
  if (!(scope in floors)) {
    console.error(`✗ unknown scope '${scope}' — quality.config.json sets mutation floors for: ${Object.keys(floors).join(', ') || 'none'}`);
    process.exit(2);
  }

  // The gate step runs with if: always(), so a Stryker run that died before writing
  // its report lands here. Say that plainly instead of throwing an ENOENT stack.
  let report;
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`✗ ${scope}: cannot read ${file} — ${err.message}`);
    process.exit(1);
  }
  const s = mutationScores(tallyMutants(report));
  const { survived, noCoverage } = s;

  if (s.valid === 0) {
    console.error(`✗ ${scope}: no valid mutants in ${file} — the run produced nothing to score`);
    process.exit(1);
  }

  const pct = (r) => `${(r * 100).toFixed(2)}%`;
  const floor = floors[scope];
  const { coveredScore, fullScore } = s;

  // Printed on every run, pass or fail: the NoCoverage population is not a
  // deficiency to gate on, it is the backlog of logic no unit test reaches.
  console.log(`· ${scope}: full score ${pct(fullScore)} · ${noCoverage} mutants with no unit coverage · ${survived} survived`);

  if (coveredScore < floor) {
    console.error(`✗ ${scope}: covered-code ${pct(coveredScore)} < floor ${pct(floor)}`);
    process.exit(1);
  }

  console.log(`✓ ${scope}: covered-code ${pct(coveredScore)} (floor ${pct(floor)})`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
