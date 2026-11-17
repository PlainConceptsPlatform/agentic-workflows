// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/architecture-gate.test.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Run: node --test scripts/lib/architecture-gate.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  FAILING_LIMIT,
  architectureDotnetData,
  architectureFacetData,
  architectureLibrary,
  architectureWebData,
  buildBaseline,
  evaluate,
  lowerBaseline,
  steigerCounts,
} from './architecture-gate.mjs';
import { envelope, validateFacet } from './engineering-excellence.mjs';

const SCHEMA = JSON.parse(readFileSync(new URL('../engineering-excellence.schema.json', import.meta.url), 'utf8'));

// `steiger ./src --reporter json` from Steiger 0.10.0 with @feature-sliced/steiger-plugin 0.8.2, verbatim
// but for the checkout path: a cross-import and a public-API sidestep at error, two slices without a
// public API and an unreferenced slice at warn. `getRuleDescriptionUrl` is a function and never reaches the JSON.
const W = '/home/runner/work/app/app/apps/web';
const STEIGER = [
  { message: 'Forbidden cross-import from slice "about".', location: { path: `${W}/src/pages/home/ui/Home.tsx`, start: { line: 1, column: 20 }, end: { line: 1, column: 42 } }, ruleName: 'fsd/forbidden-imports', severity: 'error' },
  { message: 'This slice has no references. Consider removing it.', location: { path: `${W}/src/entities/user` }, ruleName: 'fsd/insignificant-slice', severity: 'warn' },
  { message: 'Forbidden sidestep of public API when importing from "@/pages/about/ui/About".', location: { path: `${W}/src/pages/home/ui/Home.tsx`, start: { line: 1, column: 20 }, end: { line: 1, column: 42 } }, ruleName: 'fsd/no-public-api-sidestep', severity: 'error' },
  { message: 'This slice is missing a public API.', fixes: [{ type: 'create-file', path: `${W}/src/entities/user/index.js`, content: '' }], location: { path: `${W}/src/entities/user` }, ruleName: 'fsd/public-api', severity: 'warn' },
  { message: 'This slice is missing a public API.', fixes: [{ type: 'create-file', path: `${W}/src/pages/about/index.js`, content: '' }], location: { path: `${W}/src/pages/about` }, ruleName: 'fsd/public-api', severity: 'warn' },
];

// A VSTest TRX as `dotnet test --logger "trx;LogFileName=architecture.trx"` writes it for an xUnit project:
// two passing rules, a failing one with its message, a theory row with an escaped name, and a skipped rule.
const TEST_TYPE = '13cdc9d9-ddb5-4fa4-a97d-d965ccfc6d4b';
const unit = (id, cls, name) =>
  `<UnitTest name="App.ArchitectureTests.${cls}.${name}" storage="/home/runner/work/app/app/apps/api/tests/App.ArchitectureTests/bin/Release/net10.0/App.ArchitectureTests.dll" id="${id}">
      <Execution id="e-${id}" />
      <TestMethod codeBase="/home/runner/work/app/app/apps/api/tests/App.ArchitectureTests/bin/Release/net10.0/App.ArchitectureTests.dll" adapterTypeName="executor://xunit/VsTestRunner3/netcore/" className="App.ArchitectureTests.${cls}" name="${name}" />
    </UnitTest>`;
const result = (id, cls, name, outcome, body = '') =>
  `<UnitTestResult executionId="e-${id}" testId="${id}" testName="App.ArchitectureTests.${cls}.${name}" computerName="runner" duration="00:00:00.0412345" startTime="2026-11-17T10:00:01.0000000+00:00" endTime="2026-11-17T10:00:01.0412345+00:00" testType="${TEST_TYPE}" outcome="${outcome}" testListId="8c84fa94-04c1-424b-9868-57a2d4851a1d" relativeResultsDirectory="e-${id}">${body}</UnitTestResult>`;
const FAILURE = `<Output>
        <ErrorInfo>
          <Message>Assert.True() Failure&#xD;
Expected: True&#xD;
Actual:   False</Message>
          <StackTrace>   at App.ArchitectureTests.LayerTests.Application_has_no_framework() in /home/runner/work/app/app/apps/api/tests/App.ArchitectureTests/LayerTests.cs:line 44</StackTrace>
        </ErrorInfo>
      </Output>`;
const TRX = `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="5b7a5ac2-0b5e-4c5e-9d2b-7f0f6a1b2c3d" name="runner@runner 2026-11-17 10:00:00" runUser="runner" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Times creation="2026-11-17T10:00:00.0000000+00:00" queuing="2026-11-17T10:00:00.0000000+00:00" start="2026-11-17T10:00:00.5000000+00:00" finish="2026-11-17T10:00:02.0000000+00:00" />
  <TestSettings name="default" id="0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0">
    <Deployment runDeploymentRoot="runner_runner_2026-11-17_10_00_00" />
  </TestSettings>
  <Results>
    ${result('t1', 'LayerTests', 'Domain_depends_on_nothing_but_the_shared_kernel', 'Passed')}
    ${result('t2', 'LayerTests', 'Application_has_no_framework', 'Failed', FAILURE)}
    ${result('t3', 'LayerTests', 'Platform_never_knows_the_app', 'Passed')}
    ${result('t4', 'NamingTests', 'Handlers_end_with(suffix: &quot;Handler&quot;)', 'Failed', FAILURE)}
    ${result('t5', 'NamingTests', 'Legacy_rule', 'NotExecuted')}
  </Results>
  <TestDefinitions>
    ${unit('t1', 'LayerTests', 'Domain_depends_on_nothing_but_the_shared_kernel')}
    ${unit('t2', 'LayerTests', 'Application_has_no_framework')}
    ${unit('t3', 'LayerTests', 'Platform_never_knows_the_app')}
    ${unit('t4', 'NamingTests', 'Handlers_end_with')}
    ${unit('t5', 'NamingTests', 'Legacy_rule')}
  </TestDefinitions>
  <TestEntries>
    <TestEntry testId="t1" executionId="e-t1" testListId="8c84fa94-04c1-424b-9868-57a2d4851a1d" />
  </TestEntries>
  <TestLists>
    <TestList name="Results Not in a List" id="8c84fa94-04c1-424b-9868-57a2d4851a1d" />
  </TestLists>
  <ResultSummary outcome="Failed">
    <Counters total="5" executed="4" passed="2" failed="2" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="1" disconnected="0" warning="0" completed="0" inProgress="0" pending="0" />
  </ResultSummary>
</TestRun>`;

const REPORT_MODE = { mode: 'report', since: '2026-11-17', baseline: null };
const RATCHET = { mode: 'ratchet', since: '2026-11-17', baseline: { 'fsd/public-api': 2, 'fsd/insignificant-slice': 1 } };

test('steigerCounts_jsonReport_countsErrorsAndWarningsPerRule', () => {
  assert.deepEqual(steigerCounts(STEIGER), {
    errors: 2,
    warnings: 3,
    byRule: {
      'fsd/forbidden-imports': { errors: 1, warnings: 0 },
      'fsd/insignificant-slice': { errors: 0, warnings: 1 },
      'fsd/no-public-api-sidestep': { errors: 1, warnings: 0 },
      'fsd/public-api': { errors: 0, warnings: 2 },
    },
  });
  // A clean run prints an empty array: a measured zero, not a missing report.
  assert.deepEqual(steigerCounts([]), { errors: 0, warnings: 0, byRule: {} });
});

test('steigerCounts_notASteigerReport_throws', () => {
  assert.throws(() => steigerCounts({ issues: [] }), /not a Steiger JSON report/);
  assert.throws(() => steigerCounts([{ message: 'x', severity: 'info', ruleName: 'fsd/x' }]), /severity other than error or warn/);
});

test('evaluate_reportMode_listsNewWarningsButNeverFails', () => {
  const r = evaluate(steigerCounts(STEIGER).byRule, REPORT_MODE);
  assert.equal(r.failed, false);
  assert.deepEqual(r.violations.map((v) => [v.rule, v.count, v.allowed, v.why]), [
    ['fsd/insignificant-slice', 1, 0, 'new'],
    ['fsd/public-api', 2, 0, 'new'],
  ]);
  assert.equal(r.excess, 3);
});

test('evaluate_ratchetAtBaseline_passesWhateverTheErrors', () => {
  // Errors are the boundary step's verdict, never this gate's.
  const r = evaluate(steigerCounts(STEIGER).byRule, RATCHET);
  assert.deepEqual(r, { violations: [], improved: [], excess: 0, failed: false });
});

test('evaluate_ratchetOverBaseline_failsAndNamesTheRule', () => {
  const r = evaluate(steigerCounts(STEIGER).byRule, { ...RATCHET, baseline: { 'fsd/public-api': 1, 'fsd/insignificant-slice': 1 } });
  assert.equal(r.failed, true);
  assert.deepEqual(r.violations, [{ rule: 'fsd/public-api', count: 2, allowed: 1, why: 'increased' }]);
});

test('evaluate_ratchetBelowBaseline_reportsTheImprovement', () => {
  const r = evaluate(steigerCounts(STEIGER.slice(0, 2)).byRule, RATCHET);
  assert.equal(r.failed, false);
  assert.deepEqual(r.improved, ['fsd/public-api']);
});

test('buildBaseline_keepsWarningsOnly_andLowerBaselineNeverRaises', () => {
  const byRule = steigerCounts(STEIGER).byRule;
  assert.deepEqual(buildBaseline(byRule), { 'fsd/insignificant-slice': 1, 'fsd/public-api': 2 });
  // fsd/public-api fell to one, fsd/insignificant-slice to none; a new rule's warnings are never added.
  const after = buildBaseline(steigerCounts([...STEIGER.slice(3, 4), { ...STEIGER[1], ruleName: 'fsd/segments-by-purpose' }]).byRule);
  assert.deepEqual(lowerBaseline({ 'fsd/insignificant-slice': 1, 'fsd/public-api': 2 }, after), { 'fsd/public-api': 1 });
});

test('architectureDotnetData_trx_countsRulesAndNamesTheFailingOnes', () => {
  assert.deepEqual(architectureDotnetData(TRX, 'netarchtest'), {
    tool: 'netarchtest',
    project: 'App.ArchitectureTests',
    rules: 5,
    passed: 2,
    failed: 2,
    skipped: 1,
    failing: ['LayerTests.Application_has_no_framework', 'NamingTests.Handlers_end_with(suffix: "Handler")'],
  });
});

test('architectureDotnetData_manyFailures_keepsTheCountAndCapsTheNames', () => {
  const many = Array.from({ length: FAILING_LIMIT + 5 }, (_, i) => result(`f${i}`, 'LayerTests', `Rule_${String(i).padStart(3, '0')}`, 'Failed')).join('');
  const d = architectureDotnetData(`<TestRun id="r"><Results>${many}</Results></TestRun>`);
  assert.equal(d.failed, FAILING_LIMIT + 5);
  assert.equal(d.failing.length, FAILING_LIMIT);
  assert.equal(d.tool, null);
});

test('architectureDotnetData_notATrx_throws', () => {
  assert.throws(() => architectureDotnetData('{"results": []}'), /not a VSTest TRX report/);
});

test('architectureLibrary_readsThePackageReference_whicheverLibrary', () => {
  assert.equal(architectureLibrary('<PackageReference Include="NetArchTest.Rules" />'), 'netarchtest');
  assert.equal(architectureLibrary('<PackageReference Include="TngTech.ArchUnitNET.xUnit" Version="0.11.1" />'), 'archunitnet');
  // Mid-migration both are referenced; the library the app is moving to is named.
  assert.equal(architectureLibrary('<PackageReference Include="NetArchTest.Rules" /><PackageReference Include="TngTech.ArchUnitNET" />'), 'archunitnet');
  assert.equal(architectureLibrary('<PackageReference Include="xunit" />'), null);
  assert.equal(architectureLibrary(null), null);
});

test('architectureFacet_webAndDotnet_validatesAgainstTheSchema', () => {
  const data = architectureFacetData({
    web: architectureWebData(STEIGER, '0.10.0', RATCHET),
    dotnet: architectureDotnetData(TRX, 'archunitnet'),
  });
  assert.deepEqual(data.web.gate, { mode: 'ratchet', since: '2026-11-17', violations: 0, failed: false });
  assert.equal(data.web.version, '0.10.0');
  assert.deepEqual(validateFacet(envelope('architecture', data, {}), SCHEMA), []);
});

test('architectureFacet_eitherPartAlone_validates', () => {
  const webOnly = architectureFacetData({ web: architectureWebData([], null, REPORT_MODE) });
  assert.deepEqual(webOnly.web.gate, { mode: 'report', since: '2026-11-17', violations: 0, failed: false });
  assert.deepEqual(validateFacet(envelope('architecture', webOnly, {}), SCHEMA), []);
  const dotnetOnly = architectureFacetData({ dotnet: architectureDotnetData(TRX) });
  assert.deepEqual(validateFacet(envelope('architecture', dotnetOnly, {}), SCHEMA), []);
});

test('architectureFacet_unknownLibraryOrMissingGate_isRejectedByTheSchema', () => {
  const data = architectureFacetData({ web: architectureWebData(STEIGER, '0.10.0', REPORT_MODE), dotnet: { ...architectureDotnetData(TRX), tool: 'archtest' } });
  delete data.web.gate;
  const errors = validateFacet(envelope('architecture', data, {}), SCHEMA);
  assert.ok(errors.some((e) => /web: missing 'gate'/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /dotnet\.tool: "archtest" not in enum/.test(e)), errors.join('\n'));
});
