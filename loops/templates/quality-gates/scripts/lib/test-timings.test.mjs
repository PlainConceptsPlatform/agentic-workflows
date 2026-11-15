// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/test-timings.test.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Run: node --test scripts/lib/test-timings.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTrx, summarize, toMarkdown } from './test-timings.mjs';

const unit = (id, cls, name) =>
  `<UnitTest name="${name}" storage="/w/App.IntegrationTests.dll" id="${id}"><Execution id="e${id}" /><TestMethod codeBase="x" className="App.Tests.${cls}" name="${name}" /></UnitTest>`;
const result = (id, duration, start, end) =>
  `<UnitTestResult executionId="e${id}" testId="${id}" testName="${id} name" duration="${duration}" startTime="${start}" endTime="${end}" outcome="Passed" />`;

const trx = `<?xml version="1.0"?><TestRun id="r" name="run">
<Times creation="2026-01-01T00:00:00Z" start="2026-01-01T00:00:00.000Z" finish="2026-01-01T00:00:10.000Z" />
<Results>
${result('a', '00:00:06.0000000', '2026-01-01T00:00:00Z', '2026-01-01T00:00:06Z')}
${result('b', '00:00:01.0000000', '2026-01-01T00:00:06Z', '2026-01-01T00:00:07Z')}
${result('c', '00:00:08.0000000', '2026-01-01T00:00:01Z', '2026-01-01T00:00:09Z')}
</Results>
<TestDefinitions>${unit('a', 'OrdersTests', 'First')}${unit('b', 'OrdersTests', 'Second')}${unit('c', 'StockTests', 'Only')}</TestDefinitions>
</TestRun>`;

test('parseTrx_resultsAndDefinitions_joinsClassAndDurationAndWallTime', () => {
  const run = parseTrx(trx);
  assert.equal(run.name, 'App.IntegrationTests');
  assert.equal(run.wall, 10);
  assert.deepEqual(run.results.map((r) => [r.className, r.seconds]), [['OrdersTests', 6], ['OrdersTests', 1], ['StockTests', 8]]);
});

test('summarize_classesBySummedTime_reportsConcurrencyAndTheFirstTestCost', () => {
  const t = summarize(parseTrx(trx));
  assert.equal(t.total, 15);
  assert.equal(t.concurrency, 1.5);
  assert.deepEqual(t.classes.map((c) => [c.name, c.tests, c.seconds, c.firstTest]), [['StockTests', 1, 8, 8], ['OrdersTests', 2, 7, 6]]);
  assert.equal(t.slowest[0].className, 'StockTests');
});

test('toMarkdown_smallRun_givesTheTotalsWithoutTables', () => {
  const md = toMarkdown([summarize(parseTrx(trx))]);
  assert.match(md, /\*\*App\.IntegrationTests\*\*: 3 tests, 10\.0 s wall, 15\.0 s of test time, 1\.5 running at once on average\./);
  assert.doesNotMatch(md, /\| Class \|/);
});

test('parseTrx_fullyQualifiedTestName_dropsTheClassPrefix', () => {
  const xml = `<TestRun><UnitTestResult testId="x" testName="App.Tests.OrdersTests.Saves(total: 1.5)" duration="00:00:01" outcome="Passed" />${unit('x', 'OrdersTests', 'Saves')}</TestRun>`;
  assert.equal(parseTrx(xml).results[0].name, 'Saves(total: 1.5)');
});
