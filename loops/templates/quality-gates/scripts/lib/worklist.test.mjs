// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/worklist.test.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Run: node --test scripts/lib/worklist.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { complexityFacetData, coverageFacetData, envelope, useLayout } from './engineering-excellence.mjs';
import { parseQualityConfig } from './quality-config.mjs';
import {
  CHECKS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  architectureCheck,
  buildWorklist,
  bundleCheck,
  complexityCheck,
  coverageCheck,
  deadCodeCheck,
  duplicationCheck,
  itemId,
  lcovFiles,
  mutationCheck,
  normalizeLimit,
  oneLine,
  patternsCheck,
  securityCheck,
  semgrepCheck,
  validateWorklist,
  worklistPath,
  worklistSummary,
} from './worklist.mjs';

// The fixtures use the family layout whatever API_WORKING_DIRECTORY and WEB_DIRECTORY say in the app's CI.
useLayout({ api: 'apps/api', web: 'apps/web' });

const SCHEMA = JSON.parse(readFileSync(new URL('../engineering-excellence-worklist.schema.json', import.meta.url), 'utf8'));
const RUNNER = '/home/runner/work/app/app';

// Text a worklist must never carry: the reports below plant it where a tool puts source or a secret.
const SOURCE_SNIPPET = 'catch (Exception) { /* planted source line */ }';
const SECRET_VALUE = 'planted-secret-value-0123456789';

// ── Fixtures, all synthetic ──────────────────────────────────────────────────────────────────────
const lines = (hits) => hits.map((h, i) => `<line number="${i + 1}" hits="${h}" branch="false" />`).join('');
const cls = (name, file, hits, method = 'Run', complexity = 1) =>
  `<class name="${name}" filename="${file}" line-rate="0" complexity="${complexity}">
    <methods><method name="${method}" signature="()" line-rate="${hits.filter((h) => h > 0).length / hits.length}" complexity="${complexity}"><lines>${lines(hits)}</lines></method></methods>
    <lines>${lines(hits)}</lines>
  </class>`;
const API_COBERTURA = `<?xml version="1.0"?>
<coverage line-rate="0.5" branch-rate="0.5" lines-covered="10" lines-valid="20">
  <packages>
    <package name="App.Domain" line-rate="0.5" branch-rate="1" complexity="30">
      <classes>
        ${cls('App.Domain.Orders.OrderService', `${RUNNER}/apps/api/src/App.Domain/Orders/OrderService.cs`, [1, 0, 0, 0, 0, 0, 0, 0], 'Place', 24)}
        ${cls('App.Domain.Orders.OrderRules', `${RUNNER}/apps/api/src/App.Domain/Orders/OrderRules.cs`, [1, 1, 0, 0])}
        ${cls('App.Domain.Billing.Invoice', `${RUNNER}/apps/api/src/App.Domain/Billing/Invoice.cs`, [1, 1, 1, 1, 1, 1, 1, 1])}
        ${cls('App.Domain.Generated', `${RUNNER}/apps/api/src/App.Domain/obj/Release/Generated.g.cs`, [0, 0, 0, 0])}
      </classes>
    </package>
    <package name="App.Api" line-rate="0.25" branch-rate="1" complexity="2">
      <classes>
        ${cls('App.Api.Endpoints.Health', `${RUNNER}/apps/api/src/App.Api/Endpoints/Health.cs`, [1, 0, 0, 0])}
      </classes>
    </package>
  </packages>
</coverage>`;
const WEB_COBERTURA = `<?xml version="1.0"?>
<coverage line-rate="0.6" branch-rate="0.5" lines-covered="6" lines-valid="10">
  <packages>
    <package name="features.cart" line-rate="0.6" branch-rate="1">
      <classes>
        ${cls('cart.ts', 'src/features/cart/model/cart.ts', [1, 1, 1, 1, 1, 1])}
        ${cls('total.ts', 'src/features/cart/lib/total.ts', [0, 0, 0, 0])}
      </classes>
    </package>
  </packages>
</coverage>`;
const LCOV = `TN:
SF:packages/tools/src/index.ts
DA:1,1
DA:2,0
DA:3,0
end_of_record
SF:packages/tools/src/done.ts
DA:1,4
end_of_record
`;
const CONFIG = parseQualityConfig(
  JSON.stringify({
    coverage: { api: { 'App.Domain': 0.8 }, reportOnly: ['App.Api'], web: 0.7 },
    mutation: { domain: 0.8, web: 0.6 },
    deadCode: { mode: 'ratchet', since: '2026-11-16', baseline: { exports: 1, files: 1 } },
    bundle: { mode: 'ratchet', since: '2026-11-16', baselineBytes: 400000, limitBytes: 440000 },
    architecture: { mode: 'report', since: '2026-11-17', baseline: { 'fsd/public-api': 1 } },
    patterns: { mode: 'ratchet', since: '2026-11-18', baseline: { MA0004: 2 } },
  }),
);
const DEFAULTS = parseQualityConfig('{}');

const method = (file, name, line, cc, coverage) => ({ scope: 'App.Domain', module: 'Orders', file, method: name, line, cc, coverage });
const COMPLEXITY_FACET = complexityFacetData([
  method('apps/api/src/App.Domain/Orders/OrderService.cs', 'OrderService.Place', 42, 24, 0.1),
  method('apps/api/src/App.Domain/Orders/OrderService.cs', 'OrderService.Cancel', 90, 12, 0),
  method('apps/api/src/App.Domain/Orders/OrderRules.cs', 'OrderRules.Check', 7, 3, 1),
]);

const mutant = (status, line) => ({ id: `${status}-${line}`, mutatorName: 'ConditionalExpression', replacement: SOURCE_SNIPPET, status, location: { start: { line, column: 1 }, end: { line, column: 9 } } });
const STRYKER = {
  web: {
    schemaVersion: '1',
    files: {
      'src/features/cart/lib/total.ts': { language: 'typescript', source: SOURCE_SNIPPET, mutants: [mutant('Survived', 12), mutant('Survived', 4), mutant('Killed', 5), mutant('NoCoverage', 20)] },
      'src/features/cart/model/cart.ts': { language: 'typescript', source: SOURCE_SNIPPET, mutants: [mutant('Killed', 3), mutant('Killed', 9)] },
    },
  },
};

const TRIVY = {
  SchemaVersion: 2,
  Results: [
    {
      Target: 'pnpm-lock.yaml',
      Class: 'lang-pkgs',
      Vulnerabilities: [
        { VulnerabilityID: 'CVE-2026-0001', PkgName: 'left-pad', InstalledVersion: '1.0.0', FixedVersion: '1.0.1', Severity: 'HIGH', Title: 'left-pad: prototype pollution' },
        { VulnerabilityID: 'CVE-2026-0002', PkgName: 'tiny-yaml', InstalledVersion: '2.0.0', FixedVersion: '2.0.4', Severity: 'CRITICAL', Title: 'tiny-yaml: code execution\non load' },
        { VulnerabilityID: 'CVE-2026-0003', PkgName: 'old-lib', InstalledVersion: '0.1.0', Severity: 'HIGH', Title: 'old-lib: no fix yet' },
        { VulnerabilityID: 'CVE-2026-0004', PkgName: 'meh', InstalledVersion: '0.1.0', FixedVersion: '0.2.0', Severity: 'MEDIUM', Title: 'meh' },
      ],
    },
    {
      Target: 'infra/Dockerfile',
      Class: 'config',
      Misconfigurations: [
        { ID: 'DS002', AVDID: 'AVD-DS-0002', Title: 'Image user should not be root', Severity: 'HIGH', Status: 'FAIL', CauseMetadata: { StartLine: 3, Code: { Lines: [{ Content: SOURCE_SNIPPET }] } } },
        { ID: 'DS026', Title: 'No HEALTHCHECK', Severity: 'LOW', Status: 'FAIL' },
        { ID: 'DS001', Title: 'Latest tag', Severity: 'HIGH', Status: 'PASS' },
      ],
    },
    { Target: 'apps/api/appsettings.json', Class: 'secret', Secrets: [{ RuleID: 'generic-key', Severity: 'CRITICAL', Title: 'Generic key', StartLine: 4, Match: SECRET_VALUE, Code: { Lines: [{ Content: SECRET_VALUE }] } }] },
  ],
};

const semgrepResult = (rule, path, line, severity = 'ERROR') => ({
  check_id: rule,
  path,
  start: { line, col: 5 },
  end: { line, col: 20 },
  extra: { severity, message: 'An empty catch block swallows the exception.', lines: SOURCE_SNIPPET, metadata: {} },
});
const SEMGREP = {
  version: '1.168.0',
  errors: [],
  results: [
    semgrepResult('.semgrep.platform-hygiene-csharp-empty-catch', 'apps/api/src/App.Api/Endpoints/Health.cs', 30),
    semgrepResult('.semgrep.platform-hygiene-csharp-empty-catch', 'apps/api/src/App.Api/Endpoints/Health.cs', 12),
    semgrepResult('typescript.react.security.audit.react-dangerouslysetinnerhtml', 'apps/web/src/shared/ui/Html.tsx', 8, 'WARNING'),
  ],
};

const KNIP = {
  issues: [
    { file: 'apps/web/src/shared/lib/legacy.ts', files: [{ name: 'apps/web/src/shared/lib/legacy.ts' }] },
    { file: 'apps/web/src/entities/order/index.ts', exports: [{ name: 'orderTone', line: 4, col: 3 }, { name: 'isOrderOpen', line: 5, col: 3 }], types: [{ name: 'OrderDraft', line: 9, col: 13 }] },
    { file: 'apps/web/package.json', owners: [], dependencies: [{ name: 'unused-lib', line: 12, col: 5 }], unlisted: [{ name: 'ghost-lib' }], duplicates: [[{ name: 'a' }, { name: 'b' }]] },
  ],
};

const clone = (first, firstStart, second, secondStart, count) => ({
  format: 'typescript',
  lines: count,
  tokens: count * 9,
  fragment: SOURCE_SNIPPET,
  firstFile: { name: first, start: firstStart, end: firstStart + count - 1 },
  secondFile: { name: second, start: secondStart, end: secondStart + count - 1 },
});
const JSCPD = {
  duplicates: [
    clone('apps/web/src/features/cart/lib/total.ts', 10, 'apps/web/src/features/checkout/lib/total.ts', 14, 12),
    clone('apps/web/src/features/cart/lib/total.ts', 40, 'apps/web/src/features/checkout/lib/total.ts', 60, 30),
    clone('apps/api/src/App.Domain/Orders/OrderRules.cs', 5, 'apps/api/src/App.Domain/Billing/Invoice.cs', 9, 15),
  ],
};

const W = `${RUNNER}/apps/web`;
const STEIGER = [
  { message: 'Forbidden cross-import from slice "about".', location: { path: `${W}/src/pages/home/ui/Home.tsx`, start: { line: 1, column: 20 } }, ruleName: 'fsd/forbidden-imports', severity: 'error' },
  { message: 'This slice is missing a public API.', location: { path: `${W}/src/entities/user` }, ruleName: 'fsd/public-api', severity: 'warn' },
  { message: 'This slice is missing a public API.', location: { path: `${W}/src/pages/about` }, ruleName: 'fsd/public-api', severity: 'warn' },
];
const trxResult = (id, name, outcome, body = '') => `<UnitTestResult testId="${id}" testName="App.ArchitectureTests.LayerTests.${name}" duration="00:00:00.04" outcome="${outcome}">${body}</UnitTestResult>`;
const trxUnit = (id, name) => `<UnitTest name="App.ArchitectureTests.LayerTests.${name}" storage="${RUNNER}/apps/api/tests/App.ArchitectureTests/bin/App.ArchitectureTests.dll" id="${id}"><TestMethod className="App.ArchitectureTests.LayerTests" name="${name}" /></UnitTest>`;
const TRX = `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="r1" name="runner 2026-11-17">
  <Results>
    ${trxResult('t1', 'Domain_depends_on_nothing', 'Passed')}
    ${trxResult('t2', 'Application_has_no_framework', 'Failed', '<Output><ErrorInfo><Message>Types that failed:&#xD;\n App.Application.Orders.PlaceOrder &lt;- Microsoft.AspNetCore</Message><StackTrace>at LayerTests.cs:line 44</StackTrace></ErrorInfo></Output>')}
  </Results>
  <TestDefinitions>${trxUnit('t1', 'Domain_depends_on_nothing')}${trxUnit('t2', 'Application_has_no_framework')}</TestDefinitions>
</TestRun>`;

const sarifResult = (ruleId, level, file, line, extra = {}) => ({
  ruleId,
  level,
  message: { text: `${ruleId} fires here` },
  locations: [{ physicalLocation: { artifactLocation: { uri: `file://${RUNNER}/apps/api/src/App.Api/${file}` }, region: { startLine: line, startColumn: 9 } } }],
  ...extra,
});
const SARIF = [
  {
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'Microsoft (R) Visual C# Compiler', semanticVersion: '5.0.0' } },
        results: [
          sarifResult('MA0004', 'warning', 'Orders/Create.cs', 50),
          sarifResult('MA0004', 'warning', 'Orders/Create.cs', 20),
          sarifResult('MA0004', 'warning', 'Orders/Cancel.cs', 9),
          sarifResult('RCS1036', 'warning', 'Orders/Cancel.cs', 3),
          sarifResult('CA1822', 'note', 'Orders/Cancel.cs', 5),
          sarifResult('CS8618', 'warning', 'Orders/Cancel.cs', 6, { suppressions: [{ kind: 'inSource' }] }),
        ],
      },
    ],
  },
];

const BUNDLE_REPORT = { tool: 'size-limit', compression: 'brotli', totalJsBytes: 450000, largestChunkBytes: 120000, largestChunk: 'framework-abc.js', chunks: 14, entries: [{ name: 'static JavaScript', size: 450000 }] };
const SIZE_LIMIT = [
  { name: 'static JavaScript', size: 450000 },
  { name: 'vendor', size: 90000, sizeLimit: 80000, passed: false },
  { name: 'app', size: 10, sizeLimit: 80000, passed: true },
];

const coverageFacet = () => coverageFacetData({ apiXml: API_COBERTURA, webXml: WEB_COBERTURA, floors: { api: CONFIG.coverage.api, web: CONFIG.coverage.web } });
const fullInputs = () => ({
  facets: { complexity: COMPLEXITY_FACET, coverage: coverageFacet() },
  apiCoverage: API_COBERTURA,
  webCoverage: WEB_COBERTURA,
  lcov: [LCOV],
  mutationReports: STRYKER,
  trivy: TRIVY,
  semgrep: SEMGREP,
  knip: KNIP,
  jscpd: JSCPD,
  jscpdMinLines: 10,
  steiger: STEIGER,
  trx: TRX,
  sarifLogs: SARIF,
  bundleReport: BUNDLE_REPORT,
  sizeLimit: SIZE_LIMIT,
});
const kinds = (check, kind) => check.items.filter((i) => i.kind === kind);

// ── Ids, paths, messages ─────────────────────────────────────────────────────────────────────────
test('an item id is the hash of check, rule, path and symbol, and nothing else', () => {
  const id = itemId({ check: 'complexity', rule: 'crap', path: 'apps/api/src/A.cs', symbol: 'A.Run' });
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(id, itemId({ check: 'complexity', rule: 'crap', path: 'apps/api/src/A.cs', symbol: 'A.Run' }));
  assert.notEqual(id, itemId({ check: 'complexity', rule: 'crap', path: 'apps/api/src/A.cs', symbol: 'A.Stop' }));
  assert.notEqual(id, itemId({ check: 'coverage', rule: 'crap', path: 'apps/api/src/A.cs', symbol: 'A.Run' }));
  assert.notEqual(itemId({ check: 'x', rule: 'ab', path: 'c' }), itemId({ check: 'x', rule: 'a', path: 'bc' }));
});

test('an item keeps its id when its line and value change', () => {
  const at = (line, crap) => complexityCheck({ ...COMPLEXITY_FACET, hotspots: [{ ...COMPLEXITY_FACET.hotspots[0], line, crap }] }).items[0];
  assert.equal(at(42, 400).id, at(57, 380).id);
  const moved = { ...SEMGREP, results: SEMGREP.results.map((r) => ({ ...r, start: { line: r.start.line + 100 } })) };
  assert.deepEqual(semgrepCheck(moved).items.map((i) => i.id), semgrepCheck(SEMGREP).items.map((i) => i.id));
});

test('paths are repository-relative with forward slashes on any runner', () => {
  assert.equal(worklistPath(`${RUNNER}/apps/api/src/App.Api/Program.cs`), 'apps/api/src/App.Api/Program.cs');
  assert.equal(worklistPath(`file://${RUNNER}/apps/web/src/app/page.tsx`), 'apps/web/src/app/page.tsx');
  assert.equal(worklistPath('D:\\a\\app\\app\\apps\\api\\src\\X.cs'), 'apps/api/src/X.cs');
  assert.equal(worklistPath(`${RUNNER}/tools/build/Program.cs`), 'tools/build/Program.cs');
  assert.equal(worklistPath('/runner/_work/app/app/infra/main.bicep'), 'infra/main.bicep');
  assert.equal(worklistPath('./pnpm-lock.yaml'), 'pnpm-lock.yaml');
  assert.equal(worklistPath('src/features/cart/x.ts', 'web'), 'apps/web/src/features/cart/x.ts');
  assert.equal(worklistPath(''), null);
  assert.equal(worklistPath(undefined), null);
});

test('a message is one bounded line', () => {
  assert.equal(oneLine('  two\r\n  lines '), 'two lines');
  assert.equal(oneLine('x'.repeat(500)).length, 200);
  assert.equal(oneLine('   '), null);
  assert.equal(oneLine(undefined), null);
});

test('the limit is a whole number between 1 and the maximum', () => {
  assert.equal(normalizeLimit(undefined), DEFAULT_LIMIT);
  assert.equal(normalizeLimit('5'), 5);
  assert.equal(normalizeLimit('0'), DEFAULT_LIMIT);
  assert.equal(normalizeLimit('many'), DEFAULT_LIMIT);
  assert.equal(normalizeLimit('100000'), MAX_LIMIT);
});

// ── Per check ────────────────────────────────────────────────────────────────────────────────────
test('complexity lists the facet hotspots with their CRAP and the threshold', () => {
  const c = complexityCheck(COMPLEXITY_FACET);
  assert.equal(c.mode, 'ratchet');
  assert.deepEqual(c.sources, ['facet:complexity']);
  assert.equal(c.total, 2);
  const [worst] = c.items;
  assert.deepEqual(
    { kind: worst.kind, rule: worst.rule, path: worst.path, line: worst.line, symbol: worst.symbol, threshold: worst.threshold, mode: worst.mode },
    { kind: 'method', rule: 'crap', path: 'apps/api/src/App.Domain/Orders/OrderService.cs', line: 42, symbol: 'OrderService.Place', threshold: 30, mode: 'ratchet' },
  );
  assert.ok(worst.value > c.items[1].value);
  assert.equal(worst.detail.cc, 24);
  assert.equal(complexityCheck(null), null);
});

test('complexity counts every hotspot when the facet lists only the worst', () => {
  const c = complexityCheck({ ...COMPLEXITY_FACET, global: { ...COMPLEXITY_FACET.global, crapOver30: 57 } });
  assert.equal(c.total, 57);
  assert.equal(c.truncated, true);
});

test('coverage lists the scopes and modules under their floor and the least covered files', () => {
  const c = coverageCheck({ apiXml: API_COBERTURA, webXml: WEB_COBERTURA, config: CONFIG.coverage });
  assert.deepEqual(c.sources, ['cobertura:api', 'cobertura:web']);
  assert.deepEqual(kinds(c, 'scope').map((i) => [i.symbol, i.value, i.threshold]), [['App.Domain', 0.5, 0.8], ['web', 0.6, 0.7]]);
  const modules = kinds(c, 'module');
  assert.deepEqual(modules.map((i) => i.symbol), ['App.Domain/Orders', 'web/features/cart']);
  assert.equal(modules[0].path, 'apps/api/src/App.Domain/Orders');
  assert.equal(modules[0].value, 0.25);
  assert.equal(modules[1].path, 'apps/web/src/features/cart');
  const files = kinds(c, 'file');
  assert.deepEqual(files.map((i) => i.path), [
    'apps/api/src/App.Domain/Orders/OrderService.cs',
    'apps/web/src/features/cart/lib/total.ts',
    'apps/api/src/App.Api/Endpoints/Health.cs',
    'apps/api/src/App.Domain/Orders/OrderRules.cs',
  ]);
  assert.deepEqual(files[0].detail, { scope: 'App.Domain', module: 'Orders', linesValid: 8, uncoveredLines: 7 });
  assert.ok(!c.items.some((i) => i.path?.includes('Generated.g.cs')), 'generated code is nobody\'s to cover');
});

test('a file in a scope with no floor is listed as report, never as a ratchet', () => {
  const c = coverageCheck({ apiXml: API_COBERTURA, config: CONFIG.coverage });
  const health = c.items.find((i) => i.path === 'apps/api/src/App.Api/Endpoints/Health.cs');
  assert.equal(health.mode, 'report');
  assert.equal(health.threshold, null);
  assert.equal(c.items.find((i) => i.path?.endsWith('OrderService.cs')).mode, 'ratchet');
});

test('coverage reads the facet for the scopes and lcov for the files', () => {
  assert.deepEqual(lcovFiles(LCOV).map((f) => [f.file, f.hits.size]), [['packages/tools/src/index.ts', 3], ['packages/tools/src/done.ts', 1]]);
  const c = coverageCheck({ facet: coverageFacet(), lcov: [LCOV], config: CONFIG.coverage });
  assert.deepEqual(c.sources, ['facet:coverage', 'lcov']);
  assert.equal(kinds(c, 'scope').length, 2);
  assert.deepEqual(kinds(c, 'file').map((i) => [i.path, i.value, i.mode]), [['packages/tools/src/index.ts', 0.3333, 'report']]);
  assert.equal(kinds(c, 'module')[0].path, null, 'no Cobertura, so no folder for the module');
  assert.equal(coverageCheck({ config: CONFIG.coverage }), null);
});

test('mutation lists what is under the floor and the files with most survivors', () => {
  const c = mutationCheck({ reports: STRYKER, floors: CONFIG.mutation });
  assert.deepEqual(c.sources, ['stryker']);
  assert.deepEqual(kinds(c, 'scope'), [], 'a score at the floor is not under it');
  const [file] = kinds(c, 'file');
  assert.deepEqual(
    { path: file.path, line: file.line, value: file.value, mode: file.mode, lines: file.detail.lines, noCoverage: file.detail.noCoverage },
    { path: 'apps/web/src/features/cart/lib/total.ts', line: 4, value: 2, mode: 'ratchet', lines: [4, 12], noCoverage: 1 },
  );
  assert.equal(kinds(c, 'file').length, 1, 'a file with no survivor is not listed');
  const strict = mutationCheck({ reports: STRYKER, floors: { web: 0.9 } });
  assert.deepEqual(kinds(strict, 'scope').map((i) => [i.symbol, i.value, i.threshold]), [['web', 0.6, 0.9]]);
  assert.deepEqual(kinds(strict, 'module').map((i) => i.symbol), ['web/features/cart']);
});

test('mutation falls back to the facet scores without the reports', () => {
  const facet = { scopes: { domain: { coveredScore: 0.5, fullScore: 0.4, survived: 9, noCoverage: 3, valid: 30, floor: 0.8, modules: { Orders: { coveredScore: 0.4, fullScore: 0.3, survived: 8, noCoverage: 3, valid: 20 } } } }, global: { coveredScore: 0.5, survived: 9 } };
  const c = mutationCheck({ facet, floors: CONFIG.mutation });
  assert.deepEqual(c.sources, ['facet:mutation']);
  assert.deepEqual(c.items.map((i) => [i.kind, i.symbol]), [['scope', 'domain'], ['module', 'domain/Orders']]);
  assert.equal(mutationCheck({ floors: CONFIG.mutation }), null);
  assert.equal(mutationCheck({ reports: {}, floors: CONFIG.mutation }), null);
});

test('security lists critical and high vulnerabilities with their fix, and failed misconfigurations', () => {
  const c = securityCheck(TRIVY);
  assert.deepEqual(c.summary, { critical: 1, high: 2, fixable: 2, secrets: 1 });
  assert.deepEqual(kinds(c, 'vulnerability').map((i) => [i.rule, i.symbol, i.value, i.mode, i.detail.fixedVersion]), [
    ['CVE-2026-0002', 'tiny-yaml', 'CRITICAL', 'ratchet', '2.0.4'],
    ['CVE-2026-0001', 'left-pad', 'HIGH', 'ratchet', '1.0.1'],
    ['CVE-2026-0003', 'old-lib', 'HIGH', 'report', null],
  ]);
  assert.equal(c.items[0].path, 'pnpm-lock.yaml');
  assert.equal(c.items[0].message, 'tiny-yaml: code execution on load');
  assert.deepEqual(kinds(c, 'misconfiguration').map((i) => [i.rule, i.path, i.line]), [['DS002', 'infra/Dockerfile', 3]]);
  assert.equal(securityCheck(null), null);
  assert.throws(() => securityCheck([]), /Trivy/);
});

test('a secret is counted and never listed', () => {
  const text = JSON.stringify(securityCheck(TRIVY));
  assert.ok(!text.includes(SECRET_VALUE));
  assert.ok(!text.includes('appsettings.json'));
});

test('semgrep groups a rule\'s findings per file and drops the matched code', () => {
  const c = semgrepCheck(SEMGREP);
  assert.equal(c.total, 2);
  assert.deepEqual(c.items.map((i) => [i.rule, i.path, i.line, i.value, i.detail.lines]), [
    ['.semgrep.platform-hygiene-csharp-empty-catch', 'apps/api/src/App.Api/Endpoints/Health.cs', 12, 2, [12, 30]],
    ['typescript.react.security.audit.react-dangerouslysetinnerhtml', 'apps/web/src/shared/ui/Html.tsx', 8, 1, [8]],
  ]);
  assert.equal(c.items[0].message, 'An empty catch block swallows the exception.');
  assert.ok(!JSON.stringify(c).includes(SOURCE_SNIPPET));
  assert.throws(() => semgrepCheck({}), /Semgrep/);
});

test('dead code lists Knip\'s findings by kind, dependencies first, with the rule table', () => {
  const c = deadCodeCheck(KNIP, CONFIG.deadCode);
  assert.equal(c.mode, 'ratchet');
  assert.equal(c.total, 7);
  assert.deepEqual(c.items.map((i) => [i.kind, i.rule, i.path, i.symbol]), [
    ['unused-dependency', 'dependencies', 'apps/web/package.json', 'unused-lib'],
    ['unlisted-dependency', 'unlisted', 'apps/web/package.json', 'ghost-lib'],
    ['unused-file', 'files', 'apps/web/src/shared/lib/legacy.ts', null],
    ['unused-export', 'exports', 'apps/web/src/entities/order/index.ts', 'isOrderOpen'],
    ['unused-export', 'exports', 'apps/web/src/entities/order/index.ts', 'orderTone'],
    ['unused-export', 'types', 'apps/web/src/entities/order/index.ts', 'OrderDraft'],
    ['other', 'duplicates', 'apps/web/package.json', 'a|b'],
  ]);
  assert.deepEqual(c.rules.exports, { count: 2, baseline: 1, over: true });
  assert.deepEqual(c.rules.files, { count: 1, baseline: 1, over: false });
  assert.deepEqual(c.rules.dependencies, { count: 1, baseline: null, over: true });
  const dependency = c.items[0];
  assert.deepEqual([dependency.threshold, dependency.baseline, dependency.line], [0, null, 12]);
  const exported = c.items[3];
  assert.deepEqual([exported.threshold, exported.baseline, exported.detail], [null, 1, { ruleCount: 2, overBaseline: true }]);
  assert.equal(deadCodeCheck(KNIP, DEFAULTS.deadCode).items[0].mode, 'report');
  assert.throws(() => deadCodeCheck({}, CONFIG.deadCode), /Knip/);
});

test('duplication lists the largest clone pairs without their text', () => {
  const c = duplicationCheck(JSCPD, { minLines: 10 });
  assert.equal(c.total, 2);
  assert.deepEqual(c.items.map((i) => [i.path, i.line, i.symbol, i.value, i.threshold]), [
    ['apps/web/src/features/cart/lib/total.ts', 40, 'apps/web/src/features/checkout/lib/total.ts', 42, 10],
    ['apps/api/src/App.Domain/Orders/OrderRules.cs', 5, 'apps/api/src/App.Domain/Billing/Invoice.cs', 15, 10],
  ]);
  assert.deepEqual(c.items[0].detail, { otherPath: 'apps/web/src/features/checkout/lib/total.ts', otherLine: 60, clones: 2, largestLines: 30, tokens: 378 });
  assert.ok(!JSON.stringify(c).includes(SOURCE_SNIPPET));
  assert.throws(() => duplicationCheck({}), /jscpd/);
});

test('architecture lists the failing tests, then Steiger errors, then its warnings', () => {
  const c = architectureCheck({ steiger: STEIGER, trx: TRX, config: CONFIG.architecture });
  assert.equal(c.mode, 'report');
  assert.deepEqual(c.sources, ['steiger', 'trx']);
  assert.deepEqual(c.items.map((i) => [i.kind, i.rule, i.path, i.symbol, i.mode]), [
    ['architecture-test', null, null, 'LayerTests.Application_has_no_framework', 'ratchet'],
    ['steiger-error', 'fsd/forbidden-imports', 'apps/web/src/pages/home/ui/Home.tsx', null, 'ratchet'],
    ['steiger-warning', 'fsd/public-api', 'apps/web/src/entities/user', null, 'report'],
    ['steiger-warning', 'fsd/public-api', 'apps/web/src/pages/about', null, 'report'],
  ]);
  assert.equal(c.items[0].message, 'Types that failed: App.Application.Orders.PlaceOrder <- Microsoft.AspNetCore');
  assert.deepEqual([c.items[1].line, c.items[1].threshold], [1, 0]);
  assert.deepEqual([c.items[2].baseline, c.items[2].detail], [1, { ruleCount: 2, overBaseline: true }]);
  assert.deepEqual(c.rules['fsd/public-api'], { count: 2, baseline: 1, over: true });
});

test('architecture reads either part alone, and the facet for the tests without a TRX', () => {
  assert.deepEqual(architectureCheck({ trx: TRX, config: DEFAULTS.architecture }).items.map((i) => i.kind), ['architecture-test']);
  assert.equal(architectureCheck({ steiger: STEIGER, config: DEFAULTS.architecture }).items.length, 3);
  const fromFacet = architectureCheck({ facet: { web: null, dotnet: { failing: ['LayerTests.Application_has_no_framework'] } }, config: DEFAULTS.architecture });
  assert.deepEqual(fromFacet.sources, ['facet:architecture']);
  assert.equal(fromFacet.items[0].id, architectureCheck({ trx: TRX, config: DEFAULTS.architecture }).items[0].id);
  assert.equal(architectureCheck({ config: DEFAULTS.architecture }), null);
  assert.equal(architectureCheck({ facet: { web: {}, dotnet: null }, config: DEFAULTS.architecture }), null);
  assert.throws(() => architectureCheck({ trx: '<nope/>', config: DEFAULTS.architecture }), /TRX/);
});

test('patterns lists analyzer findings per rule and file, the rules over their baseline first', () => {
  const c = patternsCheck(SARIF, CONFIG.patterns);
  assert.equal(c.mode, 'ratchet');
  assert.deepEqual(c.items.map((i) => [i.rule, i.path, i.line, i.value, i.detail.overBaseline]), [
    ['MA0004', 'apps/api/src/App.Api/Orders/Create.cs', 20, 2, true],
    ['MA0004', 'apps/api/src/App.Api/Orders/Cancel.cs', 9, 1, true],
    ['RCS1036', 'apps/api/src/App.Api/Orders/Cancel.cs', 3, 1, true],
  ]);
  assert.deepEqual(c.items[0].detail, { level: 'warning', analyzer: 'meziantou', lines: [20, 50], ruleCount: 3, overBaseline: true });
  assert.equal(c.items[0].baseline, 2);
  assert.equal(c.items[2].baseline, null);
  assert.deepEqual(c.rules, { MA0004: { count: 3, baseline: 2, over: true }, RCS1036: { count: 1, baseline: null, over: true } });
  assert.equal(patternsCheck(SARIF, { ...CONFIG.patterns, baseline: { MA0004: 3, RCS1036: 1 } }).items[0].detail.overBaseline, false);
  assert.equal(patternsCheck([], CONFIG.patterns), null);
  assert.equal(patternsCheck(null, CONFIG.patterns), null);
});

test('bundle lists the total over its budget and the entries over their own limit', () => {
  const c = bundleCheck({ measurement: BUNDLE_REPORT, sizeLimit: SIZE_LIMIT, config: CONFIG.bundle });
  assert.deepEqual(c.sources, ['bundle-report', 'size-limit']);
  assert.deepEqual(c.items.map((i) => [i.kind, i.symbol, i.value, i.threshold, i.baseline, i.mode]), [
    ['total', 'total', 450000, 440000, 400000, 'ratchet'],
    ['entry', 'vendor', 90000, 80000, null, 'report'],
  ]);
  assert.equal(c.summary.largestChunk, 'framework-abc.js');
  const within = bundleCheck({ measurement: { ...BUNDLE_REPORT, totalJsBytes: 1000, gate: { mode: 'ratchet' } }, config: CONFIG.bundle });
  assert.deepEqual([within.total, within.items, within.sources], [0, [], ['facet:bundle']]);
  assert.equal(bundleCheck({ measurement: BUNDLE_REPORT, config: DEFAULTS.bundle }).items.length, 0, 'no budget, nothing over it');
  assert.equal(bundleCheck({ config: CONFIG.bundle }), null);
});

// ── The worklist ─────────────────────────────────────────────────────────────────────────────────
test('with every input the worklist has every check, valid against its schema', () => {
  const data = buildWorklist(fullInputs(), CONFIG);
  assert.deepEqual(Object.keys(data.checks), CHECKS);
  for (const check of CHECKS) assert.ok(data.checks[check], `${check} is built`);
  assert.deepEqual(data.unreadable, []);
  const doc = envelope('worklist', data, { GITHUB_REPOSITORY: 'acme/app', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'abc123', GITHUB_RUN_ID: '7' });
  assert.deepEqual(validateWorklist(doc, SCHEMA), []);
  assert.equal(doc.facet, 'worklist');
  assert.equal(doc.repo, 'acme/app');
  const ids = Object.values(data.checks).flatMap((c) => c.items.map((i) => i.id));
  assert.equal(new Set(ids).size, ids.length, 'ids are unique across the worklist');
  for (const item of Object.values(data.checks).flatMap((c) => c.items)) {
    assert.ok(item.path === null || (!item.path.startsWith('/') && !item.path.includes('\\')), `${item.path} is repository-relative`);
    assert.ok(['report', 'ratchet'].includes(item.mode));
  }
});

test('no source code and no secret reaches the worklist', () => {
  const text = JSON.stringify(buildWorklist(fullInputs(), CONFIG));
  assert.ok(!text.includes(SOURCE_SNIPPET));
  assert.ok(!text.includes(SECRET_VALUE));
  assert.ok(!text.includes('planted'));
});

test('a repository with only coverage and complexity gets those two checks', () => {
  const data = buildWorklist({ facets: { complexity: COMPLEXITY_FACET, coverage: coverageFacet() }, apiCoverage: API_COBERTURA }, CONFIG);
  const built = CHECKS.filter((check) => data.checks[check]);
  assert.deepEqual(built, ['complexity', 'coverage']);
  assert.deepEqual(validateWorklist(envelope('worklist', data), SCHEMA), []);
});

test('with no input every check is null and nothing fails', () => {
  const data = buildWorklist({}, DEFAULTS);
  assert.deepEqual(Object.values(data.checks), CHECKS.map(() => null));
  assert.deepEqual(validateWorklist(envelope('worklist', data), SCHEMA), []);
  assert.match(worklistSummary(data), /\| bundle \| n\/a \| n\/a \| n\/a \| no report \|/);
});

test('a report that cannot be read leaves its check null and the others built', () => {
  const data = buildWorklist({ ...fullInputs(), knip: { nope: true }, steiger: { nope: true }, trivy: 'text' }, CONFIG);
  assert.deepEqual(data.unreadable, ['architecture', 'deadCode', 'security']);
  assert.equal(data.checks.deadCode, null);
  assert.equal(data.checks.architecture, null);
  assert.ok(data.checks.patterns);
  assert.deepEqual(validateWorklist(envelope('worklist', data), SCHEMA), []);
  assert.match(worklistSummary(data), /Could not be read \(recorded as null\): architecture, deadCode, security\./);
});

test('the cap is per check, every kind gets its turn and the total shows what was cut', () => {
  const data = buildWorklist(fullInputs(), CONFIG, { limit: 3 });
  const { coverage, deadCode } = data.checks;
  assert.equal(data.limit, 3);
  assert.equal(coverage.items.length, 3);
  assert.deepEqual(coverage.items.map((i) => i.kind), ['scope', 'module', 'file']);
  assert.equal(coverage.total, 9);
  assert.equal(coverage.truncated, true);
  assert.deepEqual(deadCode.items.map((i) => i.kind), ['unused-dependency', 'unlisted-dependency', 'unused-file']);
  assert.equal(deadCode.total, 7);
  assert.deepEqual(Object.keys(deadCode.rules).length > 3, true, 'the rule table is not capped');
  assert.equal(data.checks.complexity.truncated, false);
  assert.match(worklistSummary(data), /\| coverage \| ratchet \| 9 \| 3 \| facet:coverage, cobertura:api, cobertura:web, lcov \|/);
});

// ── The command, end to end ──────────────────────────────────────────────────────────────────────
// The command and what it imports are copied beside a quality.config.json, as they sit in an app,
// and run from there.
const SCRIPTS = fileURLToPath(new URL('..', import.meta.url));
function app(config) {
  const root = mkdtempSync(join(tmpdir(), 'worklist-'));
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  for (const file of ['engineering-excellence.mjs', 'engineering-excellence.schema.json', 'engineering-excellence-worklist.schema.json']) {
    cpSync(join(SCRIPTS, file), join(root, 'scripts', file));
  }
  for (const file of readdirSync(join(SCRIPTS, 'lib')).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))) {
    cpSync(join(SCRIPTS, 'lib', file), join(root, 'scripts', 'lib', file));
  }
  if (config !== null) writeFileSync(join(root, 'quality.config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  writeFileSync(join(root, '.jscpd.json'), JSON.stringify({ path: ['apps'], minLines: 10, minTokens: 70 }));
  mkdirSync(join(root, 'ee'));
  const put = (name, content) => {
    const file = join(root, 'ee', name);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  };
  const run = (...args) => {
    const out = join(root, 'ee', 'worklist.json');
    const stdout = execFileSync(process.execPath, [join(root, 'scripts', 'engineering-excellence.mjs'), 'worklist', '--out', out, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_REPOSITORY: 'acme/app', GITHUB_SHA: 'abc123', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '42', API_WORKING_DIRECTORY: '', WEB_DIRECTORY: '' },
    });
    return { stdout, doc: JSON.parse(readFileSync(out, 'utf8')) };
  };
  return { root, put, run };
}
const RAW_CONFIG = {
  coverage: { api: { 'App.Domain': 0.8 }, reportOnly: ['App.Api'], web: 0.7 },
  mutation: { web: 0.9 },
  deadCode: { mode: 'ratchet', since: '2026-11-16', baseline: { exports: 1, files: 1 } },
  bundle: { mode: 'ratchet', since: '2026-11-16', baselineBytes: 400000, limitBytes: 440000 },
  patterns: { mode: 'report', since: '2026-11-18' },
};

test('the command builds the worklist from every report an app has', () => {
  const { root, put, run } = app(RAW_CONFIG);
  try {
    put('coverage.json', envelope('coverage', coverageFacet()));
    put('complexity.json', envelope('complexity', COMPLEXITY_FACET));
    const args = [
      '--facets', join(root, 'ee'),
      '--api', put('api/Cobertura.xml', API_COBERTURA),
      '--web', put('web/cobertura-coverage.xml', WEB_COBERTURA),
      '--lcov', put('lcov.info', LCOV),
      '--mutation-reports', join(root, 'ee', 'reports'),
      '--trivy', put('trivy/trivy.json', TRIVY),
      '--semgrep', put('semgrep/semgrep.json', SEMGREP),
      '--knip', put('web-quality/knip-report.json', KNIP),
      '--jscpd', put('jscpd-report.json', JSCPD),
      '--steiger', put('web-quality/steiger-report.json', STEIGER),
      '--trx', put('architecture/architecture.trx', TRX),
      '--sarif', join(root, 'ee', 'dotnet-analyzers'),
      '--bundle-report', put('web-quality/bundle-report.json', BUNDLE_REPORT),
      '--size-limit', put('web-quality/size-limit.json', SIZE_LIMIT),
    ];
    put('reports/mutation-web/mutation-report.json', STRYKER.web);
    put('dotnet-analyzers/src/App.Api/dotnet-analyzers.sarif', `\uFEFF${JSON.stringify(SARIF[0])}`);
    const { stdout, doc } = run(...args);
    assert.deepEqual(validateWorklist(doc, SCHEMA), []);
    assert.deepEqual([doc.facet, doc.repo, doc.commitSha, doc.runId, doc.schemaVersion], ['worklist', 'acme/app', 'abc123', 42, 1]);
    for (const check of CHECKS) assert.ok(doc.data.checks[check], `${check} is built`);
    assert.equal(doc.data.checks.deadCode.mode, 'ratchet');
    assert.equal(doc.data.checks.patterns.mode, 'report');
    assert.equal(doc.data.checks.architecture.mode, 'report');
    assert.equal(doc.data.checks.duplication.items[0].threshold, 10);
    assert.equal(doc.data.checks.mutation.items[0].threshold, 0.9);
    assert.match(stdout, /### Engineering Excellence · worklist/);
    const text = JSON.stringify(doc);
    assert.ok(!text.includes('planted') && !text.includes(root));
    assert.equal(run(...args, '--limit', '1').doc.data.checks.semgrep.items.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the command works for a repository with only coverage and complexity', () => {
  const { root, put, run } = app({ coverage: { api: { 'App.Domain': 0.8 } } });
  try {
    put('complexity.json', envelope('complexity', COMPLEXITY_FACET));
    const { doc } = run('--facets', join(root, 'ee'), '--api', put('api/Cobertura.xml', API_COBERTURA), '--knip', join(root, 'ee', 'missing.json'), '--sarif', join(root, 'ee', 'missing'));
    assert.deepEqual(CHECKS.filter((check) => doc.data.checks[check]), ['complexity', 'coverage']);
    assert.deepEqual(doc.data.unreadable, []);
    assert.deepEqual(doc.data.checks.coverage.sources, ['cobertura:api']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the command writes an empty worklist, exit 0, with no input and no quality.config.json', () => {
  const { root, run } = app(null);
  try {
    const { doc } = run();
    assert.deepEqual(Object.values(doc.data.checks), CHECKS.map(() => null));
    assert.deepEqual(doc.data.unreadable, []);
    assert.deepEqual(validateWorklist(doc, SCHEMA), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the command survives a truncated report and a quality.config.json the gates reject', () => {
  const { root, put, run } = app('{ "coverage": { "web": 94 } }');
  try {
    const { stdout, doc } = run('--knip', put('knip-report.json', '{"issues": ['), '--semgrep', put('semgrep.json', SEMGREP), '--trivy', put('trivy.json', '[]'));
    assert.deepEqual(doc.data.unreadable, ['config', 'deadCode', 'security']);
    assert.equal(doc.data.checks.deadCode, null);
    assert.equal(doc.data.checks.security, null);
    assert.equal(doc.data.checks.semgrep.total, 2);
    assert.match(stdout, /knip-report\.json could not be read/);
    assert.match(stdout, /quality\.config\.json is not valid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
