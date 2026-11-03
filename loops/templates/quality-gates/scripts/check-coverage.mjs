// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/check-coverage.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Enforces per-assembly line-coverage floors from a Cobertura XML report, and the web floor from
// the vitest v8 report. Shape vendored from PlainConceptsPlatform/Atlas scripts/check-coverage.mjs.
//
// Why a floor map (not one global number): coverage is only honest where the test run actually
// exercises the assembly. The CI report this runs against is the MERGED unit + acceptance +
// integration coverage (the Application assembly is mostly exercised by the SQL-backed integration suite).
//
// The web floor gates the v8 Cobertura report from `vitest run --coverage`. It reads the report's
// root line-rate: the web suite is one run, so there is nothing to merge.
//
// The floors are the app's, in quality.config.json (`coverage.api`, `coverage.reportOnly`,
// `coverage.web`). They sit just under the measured baseline and only ever ratchet up; never
// lower one to go green. The rule is in Foundations, ai/ENGINEERING.md, "Thresholds and ratchets".
//
// Usage: node scripts/check-coverage.mjs <coverage.cobertura.xml>
//        node scripts/check-coverage.mjs --web <cobertura-coverage.xml>

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { coberturaRoot, packageRates } from './lib/engineering-excellence.mjs';
import { loadQualityConfig } from './lib/quality-config.mjs';

const pct = (r) => `${(r * 100).toFixed(2)}%`;

function checkApi(file, { api: floors, reportOnly }) {
  const rates = packageRates(readFileSync(file, 'utf8'));
  let failed = false;
  if (Object.keys(floors).length === 0) {
    console.error('✗ quality.config.json sets no coverage.api floors: nothing would be gated');
    return true;
  }
  for (const [pkg, floor] of Object.entries(floors)) {
    const rate = rates[pkg];
    if (rate === undefined) {
      console.error(`✗ ${pkg}: no coverage data in ${file} (assembly not measured)`);
      failed = true;
      continue;
    }
    if (rate < floor) {
      console.error(`✗ ${pkg}: ${pct(rate)} < floor ${pct(floor)}`);
      failed = true;
    } else {
      console.log(`✓ ${pkg}: ${pct(rate)} (floor ${pct(floor)})`);
    }
  }
  for (const pkg of reportOnly) {
    if (rates[pkg] !== undefined) {
      console.log(`· ${pkg}: ${pct(rates[pkg])} (report-only — not gated yet)`);
    }
  }
  return failed;
}

function checkWeb(file, { web: floor }) {
  if (floor === null) {
    console.error('✗ web: quality.config.json sets no coverage.web floor');
    return true;
  }
  const { lineRate } = coberturaRoot(readFileSync(file, 'utf8'));
  if (Number.isNaN(lineRate)) {
    console.error(`✗ web: no line-rate in ${file}`);
    return true;
  }
  if (lineRate < floor) {
    console.error(`✗ web: ${pct(lineRate)} < floor ${pct(floor)}`);
    return true;
  }
  console.log(`✓ web: ${pct(lineRate)} (floor ${pct(floor)})`);
  return false;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const web = args[0] === '--web';
  const file = web ? args[1] : args[0];
  if (!file) {
    console.error('usage: node scripts/check-coverage.mjs [--web] <coverage.cobertura.xml>');
    process.exit(2);
  }
  let coverage;
  try {
    ({ coverage } = loadQualityConfig());
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(2);
  }
  process.exit((web ? checkWeb(file, coverage) : checkApi(file, coverage)) ? 1 : 0);
}
