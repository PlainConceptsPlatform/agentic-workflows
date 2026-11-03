// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/engineering-excellence.test.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Run: node --test scripts/lib/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  apiMethods,
  complexityFacetData,
  coverageFacetData,
  crap,
  envelope,
  isGenerated,
  moduleOf,
  mutationFacetData,
  mutationScores,
  sbomFacetData,
  securityFacetData,
  semgrepSummary,
  tallyMutants,
  trivySummary,
  validateFacet,
  webMethods,
} from './engineering-excellence.mjs';

const SCHEMA = JSON.parse(readFileSync(new URL('../engineering-excellence.schema.json', import.meta.url), 'utf8'));
const ENV = { GITHUB_REPOSITORY: 'o/r', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'abc', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' };
const NOW = new Date('2026-10-11T00:00:00Z');

// Shaped like ReportGenerator's merged output: class-level <lines> after <methods>.
const API_XML = `<?xml version="1.0"?>
<coverage line-rate="0.6" branch-rate="0.5" lines-covered="3" lines-valid="5">
  <packages>
    <package name="App.Domain" line-rate="0.6" branch-rate="0.5">
      <classes>
        <class name="App.Domain.Inventory.Asset" filename="/home/runner/work/app/app/apps/api/src/App.Domain/Inventory/Asset.cs" line-rate="0.6667">
          <methods>
            <method name="Retire" signature="()" line-rate="0.5" complexity="12">
              <lines><line number="10" hits="1"/><line number="11" hits="0"/></lines>
            </method>
          </methods>
          <lines>
            <line number="10" hits="1" branch="True" condition-coverage="50% (1/2)"/>
            <line number="11" hits="0"/>
            <line number="20" hits="4"/>
          </lines>
        </class>
        <class name="App.Domain.Entity" filename="/home/runner/work/app/app/apps/api/src/App.Domain/Entity.cs" line-rate="0.5">
          <methods>
            <method name="get_Id" signature="()" line-rate="1" complexity="1">
              <lines><line number="3" hits="2"/></lines>
            </method>
          </methods>
          <lines><line number="3" hits="2"/><line number="4" hits="0"/></lines>
        </class>
        <class name="App.Domain.Generated" filename="/home/runner/work/app/app/apps/api/src/App.Domain/obj/Release/net10.0/Regex.g.cs" line-rate="0">
          <methods>
            <method name="TryMatch" signature="()" line-rate="0" complexity="900">
              <lines><line number="1" hits="0"/></lines>
            </method>
          </methods>
          <lines><line number="1" hits="0"/></lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

const WEB_XML = `<coverage lines-valid="4" lines-covered="1" line-rate="0.25" branch-rate="0">
  <packages>
    <package name="src.lib" line-rate="0.25">
      <classes>
        <class name="format.ts" filename="src/lib/format.ts" line-rate="0.25">
          <methods/>
          <lines><line number="1" hits="1"/><line number="2" hits="0"/><line number="3" hits="0"/><line number="4" hits="0"/></lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

const doc = (facet, data) => envelope(facet, data, ENV, NOW);

test('moduleOf_backendFile_returnsBoundedContextFolder', () => {
  assert.equal(moduleOf('/x/apps/api/src/App.Application/Inventory/Assets/Svc.cs'), 'Inventory');
  assert.equal(moduleOf('/x/apps/api/src/App.SharedKernel/AuditHash.cs'), '(root)');
});

test('moduleOf_webFile_returnsUpToTwoFoldersUnderSrc', () => {
  assert.equal(moduleOf('src/components/assets/AssetCard.tsx'), 'components/assets');
  assert.equal(moduleOf('/x/apps/web/src/pages/a/b/Deep.tsx'), 'pages/a');
  assert.equal(moduleOf('src/App.tsx'), '(root)');
});

test('isGenerated_objAndGeneratedSources_areExcluded', () => {
  assert.equal(isGenerated('/x/src/App.Application/obj/Release/net10.0/RegexGenerator.g.cs'), true);
  assert.equal(isGenerated('/x/src/App.Application/Foo.g.cs'), true);
  assert.equal(isGenerated('/x/src/App.Application/Objects/Foo.cs'), false);
});

test('coverageFacetData_mergedReport_reportsGateRateAndPerContextCounts', () => {
  const d = coverageFacetData({ apiXml: API_XML, webXml: WEB_XML, floors: { api: { 'App.Domain': 0.85 }, web: 0.2 } });
  const domain = d.scopes['App.Domain'];
  // The scope reports the package attribute the gate judges, not a recount.
  assert.equal(domain.lineRate, 0.6);
  assert.equal(domain.floor, 0.85);
  assert.deepEqual(Object.keys(domain.modules), ['(root)', 'Inventory']);
  assert.deepEqual(domain.modules.Inventory, { lineRate: 0.6667, branchRate: 0.5, linesCovered: 2, linesValid: 3 });
  assert.equal(domain.modules['(root)'].linesValid, 2);
  assert.equal('obj' in domain.modules, false);
  assert.equal(d.scopes.web.lineRate, 0.25);
  assert.equal(d.scopes.web.linesValid, 4);
  assert.equal(d.passed, false);
  assert.deepEqual(validateFacet(doc('coverage', d), SCHEMA), []);
});

test('coverageFacetData_allScopesAtOrAboveFloor_passes', () => {
  const d = coverageFacetData({ apiXml: API_XML, webXml: WEB_XML, floors: { api: { 'App.Domain': 0.6 }, web: 0.25 } });
  assert.equal(d.passed, true);
});

test('crap_fullyCoveredMethod_equalsComplexity', () => {
  assert.equal(crap(5, 1), 5);
  assert.equal(crap(5, 0), 30);
  assert.equal(crap(10, 0.5), 22.5);
});

test('apiMethods_generatedAndDuplicateMethods_areSkipped', () => {
  const xml = API_XML.replace('</classes>', `
        <class name="App.Domain.Inventory.Asset/Nested" filename="/home/runner/work/app/app/apps/api/src/App.Domain/Inventory/Asset.cs">
          <methods><method name="Retire" line-rate="0.5" complexity="12"><lines><line number="10" hits="1"/></lines></method></methods>
          <lines/>
        </class></classes>`);
  const methods = apiMethods(xml);
  assert.deepEqual(methods.map((m) => m.method).sort(), ['Asset.Retire', 'Entity.get_Id']);
  const retire = methods.find((m) => m.method === 'Asset.Retire');
  assert.equal(retire.file, 'apps/api/src/App.Domain/Inventory/Asset.cs');
  assert.equal(retire.line, 10);
  assert.equal(retire.cc, 12);
});

test('webMethods_eslintHeadInsideNestedFunctions_attributesInnermostSpan', () => {
  const coverageFinal = {
    '/r/apps/web/src/lib/format.ts': {
      path: '/r/apps/web/src/lib/format.ts',
      fnMap: {
        0: { name: 'outer', loc: { start: { line: 1, column: 0 }, end: { line: 10, column: 1 } } },
        1: { name: '(anonymous_1)', loc: { start: { line: 3, column: 10 }, end: { line: 5, column: 3 } } },
      },
      f: { 0: 1, 1: 0 },
      statementMap: {
        0: { start: { line: 2, column: 2 }, end: { line: 2, column: 9 } },
        1: { start: { line: 4, column: 4 }, end: { line: 4, column: 9 } },
        2: { start: { line: 6, column: 2 }, end: { line: 6, column: 9 } },
      },
      s: { 0: 1, 1: 0, 2: 1 },
    },
  };
  const eslint = [{
    filePath: '/r/apps/web/src/lib/format.ts',
    messages: [
      { ruleId: 'complexity', message: "Function 'outer' has a complexity of 4. Maximum allowed is 0.", line: 1, column: 10 },
      { ruleId: 'complexity', message: 'Arrow function has a complexity of 11. Maximum allowed is 0.', line: 3, column: 14 },
      { ruleId: 'no-unused-vars', message: 'x', line: 2, column: 1 },
    ],
  }, { filePath: '/r/apps/web/src/lib/format.test.ts', messages: [{ ruleId: 'complexity', message: 'has a complexity of 3.', line: 1, column: 1 }] }];
  const [outer, arrow, ...rest] = webMethods(eslint, coverageFinal);
  assert.equal(rest.length, 0, 'files outside coverage (tests) are not production code');
  assert.deepEqual({ method: outer.method, cc: outer.cc, coverage: outer.coverage }, { method: 'outer', cc: 4, coverage: 2 / 3 });
  assert.deepEqual({ method: arrow.method, line: arrow.line, cc: arrow.cc, coverage: arrow.coverage }, { method: 'outer/anonymous', line: 3, cc: 11, coverage: 0 });
  assert.equal(arrow.module, 'lib');
});

test('complexityFacetData_methods_summarisesPerScopeAndRanksHotspotsByCrap', () => {
  const m = (scope, module, cc, coverage, method) => ({ scope, module, file: `f/${method}`, method, line: 1, cc, coverage });
  const d = complexityFacetData([
    m('web', 'lib', 1, 1, 'a'),
    m('web', 'lib', 12, 0, 'b'),
    m('web', 'pages', 40, 0.5, 'c'),
    m('App.Domain', 'Inventory', 6, 0, 'd'),
  ]);
  assert.deepEqual(d.scopes.web, {
    methods: 3, ccP50: 12, ccP90: 40, ccMax: 40, over10: 2, crapOver30: 2,
    modules: {
      lib: { methods: 2, ccP50: 12, ccP90: 12, ccMax: 12, over10: 1, crapOver30: 1 },
      pages: { methods: 1, ccP50: 40, ccP90: 40, ccMax: 40, over10: 1, crapOver30: 1 },
    },
  });
  assert.deepEqual(d.hotspots.map((h) => [h.method, h.crap]), [['c', 240], ['b', 156], ['d', 42]]);
  assert.equal(d.global.methods, 4);
  assert.deepEqual(validateFacet(doc('complexity', d), SCHEMA), []);
});

const report = (files) => ({ files: Object.fromEntries(Object.entries(files).map(([f, st]) => [f, { mutants: st.map((status) => ({ status })) }])) });

test('mutationScores_noCoverageAndCompileErrors_onlyNoCoverageCountsInFullScore', () => {
  const s = mutationScores(tallyMutants(report({ a: ['Killed', 'Killed', 'Timeout', 'Survived', 'NoCoverage', 'CompileError', 'Ignored'] })));
  assert.equal(s.coveredScore, 3 / 4);
  assert.equal(s.fullScore, 3 / 5);
  assert.equal(s.valid, 5);
});

test('mutationFacetData_reports_scoresPerModuleAndWeightsGlobalByMutants', () => {
  const d = mutationFacetData({
    domain: report({
      '/w/apps/api/src/App.Domain/Renting/Contract.cs': ['Killed', 'Killed', 'Survived'],
      '/w/apps/api/src/App.Domain/Common/Guard.cs': ['Killed'],
    }),
    web: report({ 'src/lib/format.ts': ['Survived'] }),
  }, { domain: 0.7, web: 0.92 });
  assert.equal(d.scopes.domain.coveredScore, 0.75);
  assert.equal(d.scopes.domain.passed, true);
  assert.equal(d.scopes.domain.modules.Renting.coveredScore, 0.6667);
  assert.equal(d.scopes.web.passed, false);
  assert.equal(d.global.coveredScore, 0.6);
  assert.equal(d.passed, false);
  assert.deepEqual(validateFacet(doc('mutation', d), SCHEMA), []);
});

test('trivySummary_findings_countsBySeverityAndScannerIgnoringPassedChecks', () => {
  const t = trivySummary({ Results: [
    { Vulnerabilities: [{ Severity: 'HIGH', FixedVersion: '1.2' }, { Severity: 'LOW' }] },
    { Misconfigurations: [{ Severity: 'MEDIUM', Status: 'FAIL' }, { Severity: 'HIGH', Status: 'PASS' }] },
    { Secrets: [{ Severity: 'CRITICAL' }] },
  ] });
  assert.equal(t.vuln.HIGH, 1);
  assert.equal(t.vuln.LOW, 1);
  assert.equal(t.fixableVulns, 1);
  assert.equal(t.misconfig.MEDIUM, 1);
  assert.equal(t.misconfig.HIGH, 0);
  assert.equal(t.secret.CRITICAL, 1);
});

const SEMGREP = { results: [{ extra: { severity: 'ERROR' } }, { extra: { severity: 'WARNING' } }], errors: [{}] };

test('semgrepSummary_findingsAndScanErrors_countsBySeverity', () => {
  assert.deepEqual(semgrepSummary(SEMGREP), { ERROR: 1, WARNING: 1, INFO: 0, total: 2, scanErrors: 1 });
});

test('securityFacetData_anyBlockingJobFailed_isNotPassed', () => {
  const d = securityFacetData({ trivy: { Results: [] }, semgrep: SEMGREP, jobs: { secretScan: 'success', sast: 'failure' } });

  assert.equal(d.passed, false);
  assert.deepEqual(validateFacet(doc('security', d), SCHEMA), []);
});

test('securityFacetData_reportsMissing_recordsNullBlocksAndStillValidates', () => {
  const d = securityFacetData({ trivy: null, semgrep: null, jobs: { sast: 'success' } });

  assert.equal(d.trivy, null);
  assert.equal(d.passed, true);
  assert.deepEqual(validateFacet(doc('security', d), SCHEMA), []);
});

test('sbomFacetData_cyclonedx_countsEcosystemsLicensesAndUnlicensed', () => {
  const text = JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', components: [
    { purl: 'pkg:nuget/Foo@1', licenses: [{ license: { id: 'MIT' } }] },
    { purl: 'pkg:npm/bar@2', licenses: [{ expression: 'Apache-2.0 OR MIT' }] },
    { purl: 'pkg:npm/baz@3', licenses: [{ license: { id: 'MIT' } }, { license: { id: 'MIT' } }] },
    { name: 'no-purl' },
  ] });
  const d = sbomFacetData(text);
  assert.equal(d.components, 4);
  assert.deepEqual(d.byEcosystem, { npm: 2, nuget: 1, unknown: 1 });
  assert.deepEqual(d.licenses, { MIT: 2, 'Apache-2.0 OR MIT': 1 });
  assert.equal(d.unlicensed, 1);
  assert.match(d.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(validateFacet(doc('sbom', d), SCHEMA), []);
});

test('validateFacet_contractViolations_areReported', () => {
  assert.deepEqual(validateFacet({ ...doc('sbom', {}), extra: 1 }, SCHEMA), ["$: unexpected 'extra'"]);
  const bad = doc('mutation', { scopes: { domain: { coveredScore: 1.5 } }, global: {}, passed: true });
  const errors = validateFacet(bad, SCHEMA);
  assert.ok(errors.includes('$.data.scopes.domain.coveredScore: 1.5 > 1'), errors.join('\n'));
  assert.ok(errors.some((e) => e.includes("missing 'floor'")));
});

test('envelope_githubEnv_carriesProvenance', () => {
  const e = doc('sbom', {});
  assert.deepEqual(
    { repo: e.repo, ref: e.ref, commitSha: e.commitSha, runId: e.runId, runAttempt: e.runAttempt, generatedAt: e.generatedAt, schemaVersion: e.schemaVersion },
    { repo: 'o/r', ref: 'refs/heads/main', commitSha: 'abc', runId: 42, runAttempt: 1, generatedAt: '2026-10-11T00:00:00.000Z', schemaVersion: 1 },
  );
});
