// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/patterns-gate.test.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Run: node --test scripts/lib/patterns-gate.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  analyzerCounts,
  analyzerOf,
  buildBaseline,
  evaluate,
  lowerBaseline,
  patternsDotnetData,
  patternsFacetData,
  patternsSemgrepData,
  readSarifLogs,
  sarifFindings,
  semgrepRuleIds,
} from './patterns-gate.mjs';
import { envelope, validateFacet } from './engineering-excellence.mjs';

const SCHEMA = JSON.parse(readFileSync(new URL('../engineering-excellence.schema.json', import.meta.url), 'utf8'));

// A SARIF 2.1 error log as `dotnet build -p:ErrorLog=dotnet-analyzers.sarif%2Cversion%3D2.1` writes it
// for one project: Meziantou and Roslynator warnings, a CA note, a compiler warning and a finding
// suppressed with #pragma.
const SRC = 'file:///home/runner/work/app/app/apps/api/src/App.Api';
const result = (ruleId, level, file, line, text, extra = {}) => ({
  ruleId,
  level,
  message: { text },
  locations: [{ physicalLocation: { artifactLocation: { uri: `${SRC}/${file}` }, region: { startLine: line, startColumn: 9, endLine: line, endColumn: 30 } } }],
  properties: { warningLevel: 1 },
  ...extra,
});
const sarif2 = (results) => ({
  $schema: 'http://json.schemastore.org/sarif-2.1.0',
  version: '2.1.0',
  runs: [{
    results,
    tool: { driver: { name: 'Microsoft (R) Visual C# Compiler', version: '4.14.0-3.25279.5 (abcdef01)', dottedQuadFileVersion: '4.14.0.0', semanticVersion: '4.14.0', language: 'en-US' } },
    columnKind: 'utf16CodeUnits',
  }],
});
const API = sarif2([
  result('MA0004', 'warning', 'Program.cs', 12, 'Use Task.ConfigureAwait(false) as the current SynchronizationContext is not needed'),
  result('MA0004', 'warning', 'Orders/OrderService.cs', 40, 'Use Task.ConfigureAwait(false) as the current SynchronizationContext is not needed'),
  result('RCS1036', 'warning', 'Program.cs', 3, 'Remove unnecessary blank line'),
  result('CA1822', 'note', 'Orders/OrderService.cs', 18, "Member 'Total' does not access instance data and can be marked as static"),
  result('CS8618', 'warning', 'Orders/Order.cs', 7, "Non-nullable property 'Name' must contain a non-null value when exiting constructor"),
  result('MA0051', 'warning', 'Orders/OrderService.cs', 60, 'Method is too long (75 lines; maximum allowed: 60)', { suppressions: [{ kind: 'inSource' }] }),
]);
// The compiler's default SARIF 1.0, from a second project.
const DOMAIN_V1 = {
  version: '1.0.0',
  runs: [{
    tool: { name: 'Microsoft (R) Visual C# Compiler', version: '4.14.0.0', fileVersion: '4.14.0', semanticVersion: '4.14.0' },
    results: [
      { ruleId: 'RCS1036', level: 'warning', message: 'Remove unnecessary blank line', locations: [{ resultFile: { uri: 'file:///home/runner/work/app/app/apps/api/src/App.Domain/Order.cs', region: { startLine: 5, startColumn: 1 } } }] },
      { ruleId: 'IDE0005', level: 'error', message: 'Using directive is unnecessary.', locations: [{ resultFile: { uri: 'file:///home/runner/work/app/app/apps/api/src/App.Domain/Order.cs', region: { startLine: 1, startColumn: 1 } } }] },
      { ruleId: 'MA0004', level: 'warning', message: 'suppressed', suppressionStates: ['suppressedInSource'], locations: [] },
    ],
  }],
};

test('analyzerOf_rulePrefix_namesTheAnalyzer', () => {
  assert.equal(analyzerOf('MA0004'), 'meziantou');
  assert.equal(analyzerOf('RCS1036'), 'roslynator');
  assert.equal(analyzerOf('CA1822'), 'netanalyzers');
  assert.equal(analyzerOf('IDE0005'), 'codestyle');
  assert.equal(analyzerOf('CS8618'), 'compiler');
  assert.equal(analyzerOf('xUnit1004'), 'xunit');
  assert.equal(analyzerOf('AD0001'), 'other');
  assert.equal(analyzerOf(undefined), 'other');
});

test('sarifFindings_sarif21And10_readsRuleLevelLocationAndSuppression', () => {
  const { findings, compiler } = sarifFindings([API, DOMAIN_V1]);
  assert.equal(compiler, '4.14.0');
  assert.equal(findings.length, 9);
  assert.deepEqual(findings[0], {
    ruleId: 'MA0004',
    level: 'warning',
    suppressed: false,
    file: '/home/runner/work/app/app/apps/api/src/App.Api/Program.cs',
    line: 12,
    column: 9,
    message: 'Use Task.ConfigureAwait(false) as the current SynchronizationContext is not needed',
  });
  assert.equal(findings.filter((f) => f.suppressed).length, 2);
  assert.equal(findings.find((f) => f.ruleId === 'IDE0005').file, '/home/runner/work/app/app/apps/api/src/App.Domain/Order.cs');
});

// A project with two target frameworks reports every finding twice.
test('sarifFindings_multiTargetDuplicates_areCountedOnce', () => {
  const { findings } = sarifFindings([API, API]);
  assert.equal(findings.length, 6);
});

test('sarifFindings_notSarif_throws', () => {
  assert.throws(() => sarifFindings([{ results: [] }]), /not a SARIF log/);
});

test('analyzerCounts_findings_countsPerRuleAndAnalyzerWithoutSuppressed', () => {
  const counts = analyzerCounts(sarifFindings([API, DOMAIN_V1]).findings);
  assert.deepEqual(
    { errors: counts.errors, warnings: counts.warnings, notes: counts.notes, suppressed: counts.suppressed },
    { errors: 1, warnings: 5, notes: 1, suppressed: 2 },
  );
  assert.deepEqual(counts.byRule, {
    CA1822: { errors: 0, warnings: 0, notes: 1 },
    CS8618: { errors: 0, warnings: 1, notes: 0 },
    IDE0005: { errors: 1, warnings: 0, notes: 0 },
    MA0004: { errors: 0, warnings: 2, notes: 0 },
    RCS1036: { errors: 0, warnings: 2, notes: 0 },
  });
  assert.deepEqual(Object.keys(counts.byAnalyzer), ['codestyle', 'compiler', 'meziantou', 'netanalyzers', 'roslynator']);
  assert.deepEqual(counts.byAnalyzer.roslynator, { errors: 0, warnings: 2, notes: 0 });
});

test('buildBaseline_errorsAndWarningsPerRule_leavesNotesOut', () => {
  const { byRule } = analyzerCounts(sarifFindings([API, DOMAIN_V1]).findings);
  assert.deepEqual(buildBaseline(byRule), { CS8618: 1, IDE0005: 1, MA0004: 2, RCS1036: 2 });
});

test('evaluate_reportMode_listsOverButNeverFails', () => {
  const { byRule } = analyzerCounts(sarifFindings([API]).findings);
  const r = evaluate(byRule, { mode: 'report', baseline: { MA0004: 1 } });
  assert.equal(r.failed, false);
  assert.deepEqual(r.violations.map((v) => [v.rule, v.why]), [['CS8618', 'new'], ['MA0004', 'increased'], ['RCS1036', 'new']]);
  assert.equal(r.excess, 3);
});

test('evaluate_ratchet_failsOnANewFindingAndReportsImprovement', () => {
  const { byRule } = analyzerCounts(sarifFindings([API]).findings);
  const held = evaluate(byRule, { mode: 'ratchet', baseline: { MA0004: 2, RCS1036: 1, CS8618: 1, CA2007: 4 } });
  assert.equal(held.failed, false);
  assert.deepEqual(held.improved, ['CA2007']);
  const worse = evaluate(byRule, { mode: 'ratchet', baseline: { MA0004: 2, CS8618: 1 } });
  assert.equal(worse.failed, true);
  assert.deepEqual(worse.violations, [{ rule: 'RCS1036', count: 1, allowed: 0, why: 'new' }]);
});

test('lowerBaseline_onlyEverLowers', () => {
  assert.deepEqual(lowerBaseline({ MA0004: 5, RCS1036: 1 }, { MA0004: 2, RCS1036: 3, CA1822: 9 }), { MA0004: 2, RCS1036: 1 });
});

test('readSarifLogs_directory_readsEveryLogAndListsTheUnreadable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'patterns-'));
  try {
    mkdirSync(join(dir, 'src/App.Api'), { recursive: true });
    mkdirSync(join(dir, 'src/App.Domain'), { recursive: true });
    writeFileSync(join(dir, 'src/App.Api/dotnet-analyzers.sarif'), `﻿${JSON.stringify(API)}`);
    writeFileSync(join(dir, 'src/App.Domain/dotnet-analyzers.sarif'), '{"runs": [');
    writeFileSync(join(dir, 'src/App.Domain/notes.txt'), 'not a log');
    const read = readSarifLogs(dir);
    assert.equal(read.files.length, 2);
    assert.equal(read.logs.length, 1);
    assert.deepEqual(read.unreadable, [join(dir, 'src/App.Domain/dotnet-analyzers.sarif')]);
    assert.equal(readSarifLogs(join(dir, 'src/App.Api/dotnet-analyzers.sarif')).logs.length, 1);
    assert.deepEqual(readSarifLogs(join(dir, 'missing')), { files: [], logs: [], unreadable: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SEMGREP_RULES = `rules:
  - id: platform-hygiene-csharp-empty-catch
    languages: [csharp]
  - id: platform-hygiene-ts-empty-catch
    languages: [typescript]
`;
const SEMGREP = {
  version: '1.168.0',
  results: [
    { check_id: '.semgrep.platform-hygiene-ts-empty-catch', path: 'apps/web/src/a.ts', extra: { severity: 'ERROR' } },
    { check_id: '.semgrep.app-no-console', path: 'apps/web/src/b.ts', extra: { severity: 'WARNING' } },
    { check_id: 'csharp.lang.security.sqli.csharp-sqli', path: 'apps/api/src/c.cs', extra: { severity: 'ERROR' } },
  ],
  errors: [],
};

test('semgrepRuleIds_ruleFiles_readsEveryId', () => {
  assert.deepEqual(semgrepRuleIds([SEMGREP_RULES, "rules:\n  - id: 'app-no-console'\n"]), ['app-no-console', 'platform-hygiene-csharp-empty-catch', 'platform-hygiene-ts-empty-catch']);
});

test('patternsSemgrepData_knownRules_listsEveryRuleAndSkipsTheRegistry', () => {
  const data = patternsSemgrepData(SEMGREP, semgrepRuleIds([SEMGREP_RULES]));
  assert.deepEqual(data, {
    tool: 'semgrep',
    version: '1.168.0',
    rules: 2,
    errors: 1,
    warnings: 0,
    notes: 0,
    byRule: {
      'platform-hygiene-csharp-empty-catch': { errors: 0, warnings: 0, notes: 0 },
      'platform-hygiene-ts-empty-catch': { errors: 1, warnings: 0, notes: 0 },
    },
  });
});

test('patternsSemgrepData_withoutRuleFiles_readsTheLocalConfigPrefix', () => {
  const data = patternsSemgrepData(SEMGREP);
  assert.equal(data.rules, null);
  assert.deepEqual(Object.keys(data.byRule), ['app-no-console', 'platform-hygiene-ts-empty-catch']);
  assert.throws(() => patternsSemgrepData({}), /not a Semgrep JSON report/);
});

test('patternsFacet_bothParts_validatesAgainstTheSchema', () => {
  const config = { mode: 'report', since: '2026-11-18', baseline: { MA0004: 1 } };
  const data = patternsFacetData({
    dotnet: patternsDotnetData([API, DOMAIN_V1], config),
    semgrep: patternsSemgrepData(SEMGREP, semgrepRuleIds([SEMGREP_RULES])),
  });
  assert.equal(data.dotnet.tool, 'roslyn');
  assert.equal(data.dotnet.logs, 2);
  assert.deepEqual(data.dotnet.gate, { mode: 'report', since: '2026-11-18', violations: 5, failed: false });
  assert.deepEqual(validateFacet(envelope('patterns', data, {}), SCHEMA), []);
  for (const part of [{ dotnet: data.dotnet }, { semgrep: data.semgrep }]) {
    assert.deepEqual(validateFacet(envelope('patterns', patternsFacetData(part), {}), SCHEMA), []);
  }
  const { gate: _gate, ...ungated } = data.dotnet;
  assert.notDeepEqual(validateFacet(envelope('patterns', { ...data, dotnet: ungated }, {}), SCHEMA), []);
});
