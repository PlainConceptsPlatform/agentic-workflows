// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/test-timings.mjs. Update with `workflows update --force`; consumer edits may be overwritten.

// Reads VSTest .trx reports and says where a test run's time goes: by test class, since a class is
// what xUnit runs in parallel and where a fixture's setup is paid once.

const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

function seconds(duration) {
  const [h, m, s] = (duration ?? '0:0:0').split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

export function parseTrx(xml) {
  const classes = new Map();
  for (const [, id, body] of xml.matchAll(/<UnitTest\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/UnitTest>/g)) {
    const method = body.match(/<TestMethod\b[^>]*>/)?.[0];
    if (method) classes.set(id, attr(method, 'className'));
  }
  const results = [];
  for (const [tag] of xml.matchAll(/<UnitTestResult\b[^>]*>/g)) {
    const className = classes.get(attr(tag, 'testId')) ?? 'unknown';
    results.push({
      className: className.split('.').pop(),
      name: (attr(tag, 'testName') ?? '').replace(`${className}.`, ''),
      seconds: seconds(attr(tag, 'duration')),
      start: Date.parse(attr(tag, 'startTime') ?? ''),
      end: Date.parse(attr(tag, 'endTime') ?? ''),
      outcome: attr(tag, 'outcome') ?? 'Unknown',
    });
  }
  const times = xml.match(/<Times\b[^>]*>/)?.[0] ?? '';
  const wall = (Date.parse(attr(times, 'finish') ?? '') - Date.parse(attr(times, 'start') ?? '')) / 1000;
  const runName = xml.match(/<TestRun\b[^>]*>/)?.[0];
  const storage = xml.match(/<UnitTest\b[^>]*\bstorage="([^"]+)"/)?.[1] ?? attr(runName ?? '', 'name') ?? 'tests';
  return { name: storage.split(/[\\/]/).pop().replace(/\.dll$/i, ''), wall: Number.isFinite(wall) ? wall : 0, results };
}

export function summarize(run, top = 15) {
  const byClass = new Map();
  for (const r of run.results) {
    const c = byClass.get(r.className) ?? { name: r.className, tests: 0, seconds: 0, first: null };
    c.tests += 1;
    c.seconds += r.seconds;
    if (!c.first || r.start < c.first.start) c.first = r;
    byClass.set(r.className, c);
  }
  const total = run.results.reduce((sum, r) => sum + r.seconds, 0);
  const classes = [...byClass.values()].sort((a, b) => b.seconds - a.seconds);
  return {
    name: run.name,
    tests: run.results.length,
    wall: run.wall,
    total,
    concurrency: run.wall > 0 ? total / run.wall : 0,
    classes: classes.slice(0, top).map(({ name, tests, seconds, first }) => ({ name, tests, seconds, firstTest: first?.seconds ?? 0 })),
    slowest: [...run.results].sort((a, b) => b.seconds - a.seconds).slice(0, top).map(({ className, name, seconds }) => ({ className, name, seconds })),
  };
}

const s = (n) => `${n.toFixed(1)} s`;

export function toMarkdown(summaries) {
  const lines = ['### Test timings', ''];
  for (const t of summaries) {
    lines.push(`**${t.name}**: ${t.tests} tests, ${s(t.wall)} wall, ${s(t.total)} of test time, ${t.concurrency.toFixed(1)} running at once on average.`, '');
    if (t.tests < 20) continue;
    lines.push('| Class | Tests | Time | First test |', '|---|--:|--:|--:|');
    for (const c of t.classes) lines.push(`| ${c.name} | ${c.tests} | ${s(c.seconds)} | ${s(c.firstTest)} |`);
    lines.push('', '<details><summary>Slowest tests</summary>', '');
    for (const r of t.slowest) lines.push(`- ${s(r.seconds)} ${r.className}: ${r.name.replace(/\|/g, '\\|')}`);
    lines.push('', '</details>', '');
  }
  return lines.join('\n');
}
