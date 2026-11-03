// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/hygiene-facet.test.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Run: node --test scripts/lib/hygiene-facet.test.mjs
// Vendored from PlainConceptsPlatform/Atlas scripts/lib/hygiene-facet.test.mjs (Atlas#1942): paths and
// rule ids made neutral for the platform family, and Atlas's mock-data exclusion is dropped.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  commentStats,
  duplicatedLinesByFile,
  envelope,
  globToRegExp,
  hygieneFacetData,
  justifiedSwallows,
  scannedBy,
  swallowFindings,
  validateFacet,
} from './engineering-excellence.mjs';

const SCHEMA = JSON.parse(readFileSync(new URL('../engineering-excellence.schema.json', import.meta.url), 'utf8'));
const JSCPD_CONFIG = JSON.parse(readFileSync(new URL('../../.jscpd.json', import.meta.url), 'utf8'));
const doc = (data) => envelope('hygiene', data, { GITHUB_SHA: 'abc', GITHUB_RUN_ID: '1' }, new Date('2026-10-11T00:00:00Z'));

// Shaped like jscpd 5's JSON reporter with `absolute: true`.
const ROOT = '/home/runner/work/app/app';
const clone = (a, aStart, aEnd, b, bStart, bEnd) => ({
  format: 'csharp',
  lines: aEnd - aStart + 1,
  firstFile: { name: `${ROOT}/${a}`, start: aStart, end: aEnd },
  secondFile: { name: `${ROOT}/${b}`, start: bStart, end: bEnd },
});
const ENDPOINTS = 'apps/api/src/App.Api/Audit/AuditEndpoints.cs';
const EXPORT = 'apps/api/src/App.Api/Audit/AuditExport.cs';
const TABLE = 'apps/web/src/components/assets/AssetTable.tsx';
const REPORT = {
  duplicates: [
    clone(ENDPOINTS, 10, 21, ENDPOINTS, 40, 51),
    // Overlaps the first clone's lines 10-21 by six lines: counted once.
    clone(ENDPOINTS, 16, 27, EXPORT, 1, 12),
  ],
};

const SEMGREP = {
  results: [
    { check_id: '.semgrep.platform-hygiene-ts-empty-catch', path: TABLE, extra: { severity: 'ERROR' } },
    { check_id: 'csharp.lang.security.something-else', path: EXPORT, extra: { severity: 'WARNING' } },
  ],
  errors: [],
};

const lines = (n, line = 'x();') => Array.from({ length: n }, () => line).join('\n') + '\n';
const FILES = [
  { file: ENDPOINTS, text: `// The audit read model.\n${lines(59)}` },
  { file: EXPORT, text: `// nosemgrep: platform-hygiene-csharp-empty-catch — the client is gone\n${lines(39)}` },
  { file: TABLE, text: lines(20) },
];

test('duplicatedLinesByFile_overlappingClones_countsEachLineOncePerFile', () => {
  // AuditEndpoints: 10-21 and 40-51 from the first clone, plus 22-27 from the second.
  assert.deepEqual(duplicatedLinesByFile(REPORT), { [ENDPOINTS]: 30, [EXPORT]: 12 });
});

test('duplicatedLinesByFile_fragmentEndPastItsFile_isClampedToCloneLengthAndFileEnd', () => {
  // jscpd 4.3.0 shape: a 16-line clone whose second fragment "ends" at another file's last line.
  const bogus = { duplicates: [{ ...clone(EXPORT, 381, 396, ENDPOINTS, 74, 1605), lines: 16 }] };

  assert.deepEqual(duplicatedLinesByFile(bogus), { [ENDPOINTS]: 16, [EXPORT]: 16 });
  assert.deepEqual(duplicatedLinesByFile(bogus, (f) => (f === ENDPOINTS ? 86 : 400)), { [ENDPOINTS]: 13, [EXPORT]: 16 });
});

test('duplicatedLinesByFile_noDuplicates_isEmpty', () => {
  assert.deepEqual(duplicatedLinesByFile({ duplicates: [] }), {});
});

test('commentStats_mixedSource_separatesCommentOnlyLinesFromCode', () => {
  const text = [
    '/// <summary>Doc.</summary>',
    'public int X() => 1; // trailing comments leave a code line',
    '',
    '/* one-line block */',
    '/*',
    ' * multi-line',
    ' */',
    '/* closes */ var y = 2;',
    'var url = "http://not-a-comment";',
    '{/* JSX comment child */}',
  ].join('\n');

  assert.deepEqual(commentStats(text), { codeLines: 4, commentLines: 5 });
});

test('commentStats_blockCommentEndingBeforeCode_countsTheCode', () => {
  assert.deepEqual(commentStats('/*\n still comment\n*/ return 1;\n'), { codeLines: 1, commentLines: 2 });
});

test('justifiedSwallows_hygieneAndOtherNosemgrep_countsOnlyHygieneRules', () => {
  const text = [
    '// nosemgrep: platform-hygiene-csharp-empty-catch — a reason',
    '// nosemgrep: platform-hygiene-ts-empty-catch — another reason',
    '// nosemgrep: csharp.lang.security.sqli — parameterised',
  ].join('\n');

  assert.equal(justifiedSwallows(text), 2);
});

test('swallowFindings_semgrepJson_countsOnlyHygieneRuleFindingsPerFile', () => {
  assert.deepEqual(swallowFindings(SEMGREP), { [TABLE]: 1 });
});

test('globToRegExp_jscpdIgnoreGlobs_matchAtAnyDepthOrLiteralPath', () => {
  assert.ok(globToRegExp('**/obj/**').test('apps/api/src/App.Api/obj/Debug/x.g.cs'));
  assert.ok(globToRegExp('**/*.test.tsx').test('apps/web/src/App.test.tsx'));
  assert.ok(globToRegExp('apps/web/src/data/mock.ts').test('apps/web/src/data/mock.ts'));
  assert.equal(globToRegExp('apps/web/src/data/mock.ts').test('apps/web/src/data/mockXts'), false);
  assert.equal(globToRegExp('**/*.g.cs').test('apps/api/src/App.Api/Program.cs'), false);
});

test('scannedBy_repoJscpdConfig_excludesTestsGeneratedAndMigrations', () => {
  const scanned = scannedBy(JSCPD_CONFIG);

  assert.ok(scanned('apps/api/src/App.Domain/Inventory/Asset.cs'));
  assert.ok(scanned('apps/web/src/pages/Settings.tsx'));
  assert.equal(scanned('apps/api/tests/App.UnitTests/AssetTests.cs'), false, 'outside the scanned roots');
  assert.equal(scanned('apps/api/src/App.Infrastructure/Persistence/Migrations/20260101_Init.cs'), false);
  assert.equal(scanned('apps/api/src/App.Api/obj/Release/App.Api.AssemblyInfo.cs'), false);
  assert.equal(scanned('apps/api/src/App.Domain/Regexes.g.cs'), false);
  assert.equal(scanned('apps/web/src/components/DataTable.test.tsx'), false);
  assert.equal(scanned('apps/web/src/index.css'), false, 'not a scanned format');
});

test('hygieneFacetData_fixtures_aggregatesPerScopeAndModuleAndValidates', () => {
  const d = hygieneFacetData({
    files: FILES,
    duplicated: duplicatedLinesByFile(REPORT),
    semgrep: SEMGREP,
    thresholds: { minLines: 10, minTokens: 70 },
    gate: { baselinedFiles: 2, baselineLines: 42, violations: 0, fixed: 0 },
  });

  assert.deepEqual(validateFacet(doc(d), SCHEMA), []);
  const api = d.scopes.api;
  assert.equal(api.files, 2);
  assert.equal(api.lines, 100);
  assert.equal(api.duplicatedLines, 42);
  assert.equal(api.duplicationRate, 0.42);
  assert.equal(api.codeLines, 98);
  assert.equal(api.commentLines, 2);
  assert.equal(api.commentDensity, 0.0204);
  assert.equal(api.swallowedExceptions, 0);
  assert.equal(api.justifiedSwallows, 1);
  assert.equal(api.deadCodeWarnings, 0);
  assert.deepEqual(Object.keys(api.modules), ['Audit']);
  assert.equal(d.scopes.web.swallowedExceptions, 1);
  assert.equal(d.scopes.web.modules['components/assets'].duplicationRate, 0);
  assert.equal(d.global.files, 3);
  assert.equal(d.global.duplicationRate, 0.35);
  assert.deepEqual(d.deadCode, { gated: true, warnings: 0 });
  assert.deepEqual(d.hotspots.map((h) => [h.file, h.duplicatedLines, h.duplicationRate]), [
    [ENDPOINTS, 30, 0.5],
    [EXPORT, 12, 0.3],
  ]);
});

test('hygieneFacetData_noSemgrepReport_recordsNullSwallowCountsNotZero', () => {
  const d = hygieneFacetData({ files: FILES, duplicated: {}, semgrep: null, thresholds: { minLines: 10, minTokens: 70 } });

  assert.equal(d.scopes.api.swallowedExceptions, null);
  assert.equal(d.global.swallowedExceptions, null);
  assert.equal(d.global.justifiedSwallows, 1, 'the justification count comes from the source, not the scan');
  assert.equal(d.gate, null);
  assert.deepEqual(validateFacet(doc(d), SCHEMA), []);
});

test('validateFacet_hygieneRateOutOfRange_isReported', () => {
  const d = hygieneFacetData({ files: FILES, duplicated: {}, semgrep: null, thresholds: { minLines: 10, minTokens: 70 } });
  d.global.duplicationRate = 1.5;

  assert.deepEqual(validateFacet(doc(d), SCHEMA), ['$.data.global.duplicationRate: 1.5 > 1']);
});
