// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/engineering-excellence.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Vendored from PlainConceptsPlatform/Atlas scripts/lib/engineering-excellence.mjs (Atlas#1939, hygiene
// from Atlas#1942). Family changes: `moduleOf` reads any <App>.<Project> assembly, and the hygiene
// Semgrep rules are .semgrep/platform-hygiene.yml. The facet contract, scripts/engineering-excellence.schema.json,
// is vendored verbatim. See Foundations ai/ENGINEERING.md.
//
// Parsers and facet builders for the Engineering Excellence artifacts that the Project-Health
// collector reads.
//
// Pure functions over report text/JSON, no I/O, so the gates (check-coverage.mjs,
// check-mutation.mjs) and the facet emitter (engineering-excellence.mjs) share one calculation:
// a facet can never disagree with the gate that ran in the same job.

import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const FACETS = ['coverage', 'complexity', 'mutation', 'security', 'sbom', 'hygiene'];
export const CC_THRESHOLD = 10;
export const CRAP_THRESHOLD = 30;
const HOTSPOT_LIMIT = 20;

const attr = (tag, name) => {
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) if (m[1] === name) return m[2];
  return undefined;
};
const decode = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const ratio = (num, den) => (den === 0 ? null : num / den);
const round = (n, d = 4) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

// Repo-relative path, so a hotspot links to the same file on every runner.
export function repoPath(file, scope) {
  const f = file.replace(/\\/g, '/');
  const m = f.match(/(apps\/(?:api|web)\/.*)$/);
  if (m) return m[1];
  return scope === 'web' ? `apps/web/${f.replace(/^\.?\//, '')}` : f;
}

// Compiler/source-generator output (obj/, *.g.cs — the [GeneratedRegex] matchers
// alone reach CC 1600) is nobody's code to simplify, so it stays out of modules,
// complexity and hotspots. The gated assembly line-rate still includes it, as it
// always has: the facet reports the gate's number, not a recount.
export const isGenerated = (file) => /(^|\/)obj\/|\.g\.cs$|\.g\.i\.cs$|\.designer\.cs$/i.test(file.replace(/\\/g, '/'));

// The module a file belongs to. Backend: the bounded-context folder directly under
// the assembly (src/App.Domain/<Context>/...), a PascalCase folder with a dot, which no web folder
// is. Web: up to two folders under src/ (features/claim-editor, pages/projects, shared/ui). Files
// at the root report as "(root)".
export function moduleOf(file) {
  const f = file.replace(/\\/g, '/');
  const api = f.match(/(?:^|\/)src\/[A-Z][A-Za-z0-9]*\.[^/]+\/(.+)$/);
  if (api) {
    const parts = api[1].split('/');
    return parts.length > 1 ? parts[0] : '(root)';
  }
  const web = f.match(/(?:^|\/)src\/(.+)$/);
  const rest = (web ? web[1] : f).split('/');
  const dirs = rest.slice(0, -1).slice(0, 2);
  return dirs.length ? dirs.join('/') : '(root)';
}

export function coberturaRoot(xml) {
  const tag = xml.match(/<coverage\b[^>]*>/)?.[0] ?? '';
  return {
    lineRate: parseFloat(attr(tag, 'line-rate') ?? 'NaN'),
    branchRate: parseFloat(attr(tag, 'branch-rate') ?? 'NaN'),
    linesCovered: parseInt(attr(tag, 'lines-covered') ?? '0', 10),
    linesValid: parseInt(attr(tag, 'lines-valid') ?? '0', 10),
  };
}

// <package line-rate> per package — the number check-coverage.mjs gates on.
export function packageRates(xml) {
  const rates = {};
  for (const m of xml.matchAll(/<package name="([^"]+)"[^>]*\bline-rate="([0-9.]+)"/g)) {
    rates[m[1]] = parseFloat(m[2]);
  }
  return rates;
}

function lineStats(linesXml) {
  let valid = 0, covered = 0, branchValid = 0, branchCovered = 0;
  const hits = new Map();
  for (const m of linesXml.matchAll(/<line\b[^>]*>/g)) {
    const tag = m[0];
    const n = parseInt(attr(tag, 'number'), 10);
    const h = parseInt(attr(tag, 'hits') ?? '0', 10);
    valid++;
    if (h > 0) covered++;
    hits.set(n, h);
    const cc = attr(tag, 'condition-coverage')?.match(/\((\d+)\/(\d+)\)/);
    if (cc) {
      branchCovered += parseInt(cc[1], 10);
      branchValid += parseInt(cc[2], 10);
    }
  }
  return { valid, covered, branchValid, branchCovered, hits };
}

// Every <class> with its line counts and its <method>s. Class-level <lines> sit
// after <methods>; the method blocks are stripped first so no line counts twice.
export function coberturaClasses(xml) {
  const out = [];
  for (const pkg of xml.matchAll(/<package\b([^>]*)>([\s\S]*?)<\/package>/g)) {
    const pkgName = attr(pkg[1], 'name');
    for (const cls of pkg[2].matchAll(/<class\b([^>]*)>([\s\S]*?)<\/class>/g)) {
      const body = cls[2];
      const methods = [];
      for (const m of body.matchAll(/<method\b([^>]*)>([\s\S]*?)<\/method>/g)) {
        const stats = lineStats(m[2]);
        const lines = [...stats.hits.keys()];
        methods.push({
          name: decode(attr(m[1], 'name') ?? ''),
          complexity: attr(m[1], 'complexity') !== undefined ? parseFloat(attr(m[1], 'complexity')) : null,
          lineRate: parseFloat(attr(m[1], 'line-rate') ?? 'NaN'),
          line: lines.length ? Math.min(...lines) : null,
        });
      }
      const own = lineStats(body.replace(/<methods>[\s\S]*?<\/methods>/g, ''));
      out.push({
        package: pkgName,
        name: decode(attr(cls[1], 'name') ?? ''),
        filename: decode(attr(cls[1], 'filename') ?? ''),
        ...own,
        methods,
      });
    }
  }
  return out;
}

function addLines(acc, c) {
  acc.linesValid += c.valid;
  acc.linesCovered += c.covered;
  acc.branchesValid += c.branchValid;
  acc.branchesCovered += c.branchCovered;
  return acc;
}
const emptyLines = () => ({ linesValid: 0, linesCovered: 0, branchesValid: 0, branchesCovered: 0 });
const finishLines = (a) => ({
  lineRate: round(ratio(a.linesCovered, a.linesValid)),
  branchRate: round(ratio(a.branchesCovered, a.branchesValid)),
  linesCovered: a.linesCovered,
  linesValid: a.linesValid,
});

// One coverage scope per gated assembly (from the merged backend report) plus
// `web`. `floors` comes from check-coverage.mjs so the facet carries the same bar.
export function coverageFacetData({ apiXml, webXml, floors }) {
  const scopes = {};
  if (apiXml) {
    const rates = packageRates(apiXml);
    const byPkg = {};
    for (const c of coberturaClasses(apiXml)) {
      const p = (byPkg[c.package] ??= { total: emptyLines(), modules: {} });
      addLines(p.total, c);
      if (!isGenerated(c.filename)) addLines((p.modules[moduleOf(c.filename)] ??= emptyLines()), c);
    }
    for (const [pkg, p] of Object.entries(byPkg)) {
      scopes[pkg] = {
        ...finishLines(p.total),
        // The gate reads the package attribute; report that, not our recount.
        lineRate: round(rates[pkg] ?? ratio(p.total.linesCovered, p.total.linesValid)),
        floor: floors.api?.[pkg] ?? null,
        modules: Object.fromEntries(Object.entries(p.modules).sort().map(([k, v]) => [k, finishLines(v)])),
      };
    }
  }
  if (webXml) {
    const root = coberturaRoot(webXml);
    const total = emptyLines();
    const modules = {};
    for (const c of coberturaClasses(webXml)) {
      addLines(total, c);
      addLines((modules[moduleOf(c.filename)] ??= emptyLines()), c);
    }
    scopes.web = {
      ...finishLines(total),
      lineRate: round(root.lineRate),
      linesCovered: root.linesCovered,
      linesValid: root.linesValid,
      floor: floors.web ?? null,
      modules: Object.fromEntries(Object.entries(modules).sort().map(([k, v]) => [k, finishLines(v)])),
    };
  }
  const g = Object.values(scopes).reduce(
    (a, s) => ({ c: a.c + s.linesCovered, v: a.v + s.linesValid }),
    { c: 0, v: 0 },
  );
  return {
    scopes,
    global: { lineRate: round(ratio(g.c, g.v)), linesCovered: g.c, linesValid: g.v },
    passed: Object.values(scopes).every((s) => s.floor === null || s.lineRate >= s.floor),
  };
}

// CRAP (Savoia & Evans): CC^2 * (1 - cov)^3 + CC, coverage as a 0..1 fraction.
export const crap = (cc, cov) => cc * cc * (1 - cov) ** 3 + cc;

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);

function summarise(methods) {
  const ccs = methods.map((m) => m.cc).sort((a, b) => a - b);
  return {
    methods: methods.length,
    ccP50: percentile(ccs, 0.5),
    ccP90: percentile(ccs, 0.9),
    ccMax: ccs.length ? ccs[ccs.length - 1] : null,
    over10: methods.filter((m) => m.cc > CC_THRESHOLD).length,
    crapOver30: methods.filter((m) => m.crap > CRAP_THRESHOLD).length,
  };
}

// Backend methods straight from Cobertura: coverlet writes `complexity` on each
// <method>, so complexity costs no extra tool.
export function apiMethods(xml) {
  const out = [];
  // ReportGenerator lists a method once per class that owns it (partial classes,
  // nested generated types), so the same file:line can appear twice.
  const seen = new Set();
  for (const c of coberturaClasses(xml)) {
    if (isGenerated(c.filename)) continue;
    for (const m of c.methods) {
      if (m.complexity === null || Number.isNaN(m.lineRate)) continue;
      const key = `${c.filename}:${m.line}:${m.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        scope: c.package,
        module: moduleOf(c.filename),
        file: repoPath(c.filename, c.package),
        method: `${c.name.split('.').pop()}.${m.name}`,
        line: m.line,
        cc: m.complexity,
        coverage: m.lineRate,
      });
    }
  }
  return out;
}

const contains = (loc, line, col) =>
  (line > loc.start.line || (line === loc.start.line && col >= loc.start.column)) &&
  (line < loc.end.line || (line === loc.end.line && col <= loc.end.column));
const isNamed = (fn) => Boolean(fn.name) && !fn.name.startsWith('(anonymous');
const span = (loc) => (loc.end.line - loc.start.line) * 1e6 + (loc.end.column - loc.start.column);

export function webMethods(eslintResults, coverageFinal) {
  const byFile = new Map();
  for (const fc of Object.values(coverageFinal ?? {})) byFile.set(repoPath(fc.path, 'web'), fc);
  const out = [];
  for (const r of eslintResults) {
    const file = repoPath(r.filePath, 'web');
    const fc = byFile.get(file);
    if (!fc) continue; // excluded from coverage (tests, mocks): not production code
    const fns = Object.entries(fc.fnMap).map(([id, fn]) => ({ id, ...fn }));
    const stmts = Object.entries(fc.statementMap);
    for (const msg of r.messages ?? []) {
      if (msg.ruleId !== 'complexity') continue;
      const cc = parseInt(msg.message.match(/complexity of (\d+)/)?.[1] ?? '', 10);
      if (Number.isNaN(cc)) continue;
      // ESLint columns are 1-based, istanbul's 0-based.
      const fn = fns
        .filter((f) => contains(f.loc, msg.line, msg.column - 1))
        .sort((x, y) => span(x.loc) - span(y.loc))[0];
      if (!fn) continue;
      let valid = 0, covered = 0;
      for (const [id, loc] of stmts) {
        if (!contains(fn.loc, loc.start.line, loc.start.column)) continue;
        valid++;
        if (fc.s[id] > 0) covered++;
      }
      const named = msg.message.match(/'([^']+)'/)?.[1] ?? (isNamed(fn) ? fn.name : null);
      // Callbacks have no name; qualify them by the innermost named function around
      // them, so the complexity baseline keys one component's callbacks, not a file's.
      const parent = named ? null : fns
        .filter((f) => f !== fn && isNamed(f) && contains(f.loc, fn.loc.start.line, fn.loc.start.column))
        .sort((x, y) => span(x.loc) - span(y.loc))[0];
      out.push({
        scope: 'web',
        module: moduleOf(file),
        file,
        method: named ?? (parent ? `${parent.name}/anonymous` : 'anonymous'),
        line: fn.loc.start.line,
        cc,
        coverage: valid === 0 ? (fc.f[fn.id] > 0 ? 1 : 0) : covered / valid,
      });
    }
  }
  return out;
}

// Shared by the facet and the blocking gate (check-complexity.mjs), so both see the
// same CRAP for the same method.
export const scoreMethods = (methods) =>
  methods.map((m) => ({ ...m, coverage: round(m.coverage), crap: round(crap(m.cc, m.coverage), 2) }));

export function complexityFacetData(methods) {
  const scored = scoreMethods(methods);
  const scopes = {};
  const byScope = Map.groupBy(scored, (m) => m.scope);
  for (const [scope, list] of [...byScope].sort(([a], [b]) => a.localeCompare(b))) {
    const modules = Object.fromEntries(
      [...Map.groupBy(list, (m) => m.module)].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, summarise(v)]),
    );
    scopes[scope] = { ...summarise(list), modules };
  }
  const hotspots = scored
    .filter((m) => m.crap > CRAP_THRESHOLD)
    .sort((a, b) => b.crap - a.crap || b.cc - a.cc)
    .slice(0, HOTSPOT_LIMIT);
  return {
    thresholds: { cc: CC_THRESHOLD, crap: CRAP_THRESHOLD },
    scopes,
    global: summarise(scored),
    hotspots,
  };
}

// Same state split as check-mutation.mjs documents: Killed/Timeout detect,
// Survived/NoCoverage do not, CompileError/RuntimeError/Ignored are excluded.
const DETECTED = ['Killed', 'Timeout'];

export function tallyMutants(report) {
  const counts = {};
  for (const info of Object.values(report.files ?? {})) {
    for (const mutant of info.mutants ?? []) counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
  }
  return counts;
}

export function mutationScores(counts) {
  const killed = counts.Killed ?? 0;
  const timeout = counts.Timeout ?? 0;
  const survived = counts.Survived ?? 0;
  const noCoverage = counts.NoCoverage ?? 0;
  const detected = DETECTED.reduce((n, s) => n + (counts[s] ?? 0), 0);
  const covered = detected + survived;
  const valid = covered + noCoverage;
  return {
    coveredScore: covered === 0 ? 0 : detected / covered,
    fullScore: valid === 0 ? 0 : detected / valid,
    killed,
    timeout,
    survived,
    noCoverage,
    valid,
  };
}

const roundScores = (s) => ({ ...s, coveredScore: round(s.coveredScore), fullScore: round(s.fullScore) });

export function mutationFacetData(reportsByScope, floors) {
  const scopes = {};
  const total = {};
  for (const [scope, report] of Object.entries(reportsByScope).sort()) {
    const counts = tallyMutants(report);
    for (const [k, v] of Object.entries(counts)) total[k] = (total[k] ?? 0) + v;
    const modules = {};
    for (const [file, info] of Object.entries(report.files ?? {})) {
      const mod = (modules[moduleOf(file)] ??= {});
      for (const m of info.mutants ?? []) mod[m.status] = (mod[m.status] ?? 0) + 1;
    }
    const s = mutationScores(counts);
    const floor = floors[scope] ?? null;
    scopes[scope] = {
      ...roundScores(s),
      floor,
      passed: floor === null || s.coveredScore >= floor,
      modules: Object.fromEntries(
        Object.entries(modules).sort().map(([k, v]) => [k, roundScores(mutationScores(v))]),
      ),
    };
  }
  return {
    scopes,
    // Mutant-weighted across scopes, so a small scope cannot swing the headline.
    global: roundScores(mutationScores(total)),
    passed: Object.values(scopes).every((s) => s.passed),
  };
}

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
const zeroSev = () => Object.fromEntries(SEVERITIES.map((s) => [s, 0]));

export function trivySummary(report) {
  const out = { vuln: zeroSev(), misconfig: zeroSev(), secret: zeroSev(), fixableVulns: 0 };
  for (const r of report.Results ?? []) {
    for (const v of r.Vulnerabilities ?? []) {
      out.vuln[v.Severity in out.vuln ? v.Severity : 'UNKNOWN']++;
      if (v.FixedVersion) out.fixableVulns++;
    }
    for (const m of r.Misconfigurations ?? []) {
      if (m.Status && m.Status !== 'FAIL') continue;
      out.misconfig[m.Severity in out.misconfig ? m.Severity : 'UNKNOWN']++;
    }
    for (const s of r.Secrets ?? []) out.secret[s.Severity in out.secret ? s.Severity : 'UNKNOWN']++;
  }
  return out;
}

export function semgrepSummary(report) {
  const out = { ERROR: 0, WARNING: 0, INFO: 0, total: 0, scanErrors: (report.errors ?? []).length };
  for (const r of report.results ?? []) {
    const sev = r.extra?.severity;
    if (sev in out) out[sev]++;
    out.total++;
  }
  return out;
}

// `jobs` are the needs.<job>.result values of the blocking scanners — the verdict
// a human saw on the run, recorded as-is.
export function securityFacetData({ trivy, semgrep, jobs }) {
  return {
    trivy: trivy ? trivySummary(trivy) : null,
    semgrep: semgrep ? semgrepSummary(semgrep) : null,
    jobs,
    passed: Object.values(jobs).every((r) => r === 'success'),
  };
}

export function sbomFacetData(text) {
  const bom = JSON.parse(text);
  const components = bom.components ?? [];
  const byEcosystem = {};
  const licenses = {};
  let unlicensed = 0;
  for (const c of components) {
    const eco = c.purl?.match(/^pkg:([^/]+)\//)?.[1] ?? 'unknown';
    byEcosystem[eco] = (byEcosystem[eco] ?? 0) + 1;
    const ids = (c.licenses ?? [])
      .map((l) => l.license?.id ?? l.license?.name ?? l.expression)
      .filter(Boolean);
    if (ids.length === 0) unlicensed++;
    for (const id of new Set(ids)) licenses[id] = (licenses[id] ?? 0) + 1;
  }
  const sortDesc = (o) => Object.fromEntries(Object.entries(o).sort(([, a], [, b]) => b - a));
  return {
    format: bom.bomFormat ?? 'CycloneDX',
    specVersion: bom.specVersion ?? null,
    components: components.length,
    byEcosystem: sortDesc(byEcosystem),
    licenses: sortDesc(licenses),
    unlicensed,
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

// The Semgrep rules in .semgrep/platform-hygiene.yml. Semgrep prefixes a local rule's id
// with its config path (`.semgrep.platform-hygiene-...`), so findings match on the suffix.
export const SWALLOW_RULES = ['platform-hygiene-csharp-empty-catch', 'platform-hygiene-ts-empty-catch'];
const isSwallowRule = (checkId) => SWALLOW_RULES.some((r) => checkId === r || checkId?.endsWith(`.${r}`));
const JUSTIFIED_SWALLOW = new RegExp(`nosemgrep:\\s*(?:${SWALLOW_RULES.join('|')})\\b`, 'g');

// The subset of glob syntax .jscpd.json uses (`**/`, `*`, literal paths), so the facet
// and jscpd read their file scope from one config.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp — the glob comes from the committed .jscpd.json, metacharacters are escaped, and the output has no nested quantifier
  return new RegExp(`^${re}$`);
}

const FORMAT_EXTENSIONS = { csharp: ['.cs'], typescript: ['.ts'], tsx: ['.tsx'], javascript: ['.js', '.mjs'] };

// `cfg` is the parsed .jscpd.json; `file` is repo-relative.
export function scannedBy(cfg) {
  const ignore = (cfg.ignore ?? []).map(globToRegExp);
  const exts = (cfg.format ?? []).flatMap((f) => FORMAT_EXTENSIONS[f] ?? []);
  const roots = (cfg.path ?? []).map((p) => `${p.replace(/\/$/, '')}/`);
  return (file) =>
    roots.some((r) => file.startsWith(r)) &&
    exts.some((e) => file.endsWith(e)) &&
    !ignore.some((re) => re.test(file));
}

export const lineCount = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

export const hygieneScopeOf = (file) => file.match(/^apps\/(api|web)\//)?.[1] ?? null;

export function duplicatedLinesByFile(report, lengthOf = () => Infinity) {
  const lines = new Map();
  for (const d of report.duplicates ?? []) {
    for (const f of [d.firstFile, d.secondFile]) {
      if (!f) continue;
      const file = repoPath(f.name);
      const end = Math.min(f.end, f.start + Math.max(d.lines ?? 0, 1) - 1, lengthOf(file) ?? Infinity);
      const set = lines.get(file) ?? new Set();
      for (let n = f.start; n <= end; n++) set.add(n);
      lines.set(file, set);
    }
  }
  return Object.fromEntries([...lines].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.size]));
}

// Line-based and C-family only (C#, TS/TSX share `//` and `/* */`). A line is a
// comment line when it holds nothing but comment; a trailing comment leaves it a code
// line. Good enough for a trend, and why the density is report-only.
export function commentStats(text) {
  let code = 0, comment = 0, inBlock = false;
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) {
        if (line) comment++;
        continue;
      }
      inBlock = false;
      line = line.slice(end + 2).trim();
      if (!line || line.startsWith('//')) {
        comment++;
        continue;
      }
      code++;
      continue;
    }
    if (!line) continue;
    if (line.startsWith('//')) comment++;
    else if (line.startsWith('/*')) {
      const end = line.indexOf('*/', 2);
      if (end === -1) inBlock = true;
      const rest = end === -1 ? '' : line.slice(end + 2).trim();
      if (rest && !rest.startsWith('//')) code++;
      else comment++;
    } else code++;
  }
  return { codeLines: code, commentLines: comment };
}

export const justifiedSwallows = (text) => (text.match(JUSTIFIED_SWALLOW) ?? []).length;

// Files with an unjustified swallow, from the blocking scan's JSON. On main the scan
// is blocking, so this is normally zero and the justified count carries the trend.
export function swallowFindings(semgrep) {
  const byFile = {};
  for (const r of semgrep.results ?? []) {
    if (!isSwallowRule(r.check_id)) continue;
    byFile[r.path] = (byFile[r.path] ?? 0) + 1;
  }
  return byFile;
}

const emptyHygiene = () => ({
  files: 0, lines: 0, duplicatedLines: 0, codeLines: 0, commentLines: 0, swallowedExceptions: 0, justifiedSwallows: 0,
});
function addHygiene(acc, f) {
  acc.files++;
  acc.lines += f.lines;
  acc.duplicatedLines += f.duplicatedLines;
  acc.codeLines += f.codeLines;
  acc.commentLines += f.commentLines;
  acc.swallowedExceptions += f.swallowedExceptions;
  acc.justifiedSwallows += f.justifiedSwallows;
  return acc;
}
const finishHygiene = (a, swallowKnown) => ({
  ...a,
  duplicationRate: round(ratio(a.duplicatedLines, a.lines)),
  commentDensity: round(ratio(a.commentLines, a.codeLines)),
  swallowedExceptions: swallowKnown ? a.swallowedExceptions : null,
});

export function hygieneFacetData({ files, duplicated, semgrep, deadCode = {}, thresholds, gate = null, commentSlop }) {
  const swallowed = semgrep ? swallowFindings(semgrep) : {};
  const measured = files
    .map(({ file, text }) => ({
      file,
      scope: hygieneScopeOf(file),
      module: moduleOf(file),
      lines: lineCount(text),
      duplicatedLines: duplicated[file] ?? 0,
      ...commentStats(text),
      swallowedExceptions: swallowed[file] ?? 0,
      justifiedSwallows: justifiedSwallows(text),
    }))
    .filter((f) => f.scope);
  const scopes = {};
  for (const [scope, list] of [...Map.groupBy(measured, (f) => f.scope)].sort(([a], [b]) => a.localeCompare(b))) {
    const modules = Object.fromEntries(
      [...Map.groupBy(list, (f) => f.module)]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, finishHygiene(v.reduce(addHygiene, emptyHygiene()), Boolean(semgrep))]),
    );
    scopes[scope] = {
      ...finishHygiene(list.reduce(addHygiene, emptyHygiene()), Boolean(semgrep)),
      deadCodeWarnings: deadCode[scope] ?? 0,
      modules,
    };
  }
  const hotspots = measured
    .filter((f) => f.duplicatedLines > 0)
    .sort((a, b) => b.duplicatedLines - a.duplicatedLines || a.file.localeCompare(b.file))
    .slice(0, HOTSPOT_LIMIT)
    .map((f) => ({
      scope: f.scope,
      module: f.module,
      file: f.file,
      duplicatedLines: f.duplicatedLines,
      lines: f.lines,
      duplicationRate: round(ratio(f.duplicatedLines, f.lines)),
    }));
  return {
    thresholds,
    scopes,
    global: finishHygiene(measured.reduce(addHygiene, emptyHygiene()), Boolean(semgrep)),
    deadCode: { gated: true, warnings: Object.values(deadCode).reduce((n, v) => n + v, 0) },
    hotspots,
    gate,
    ...(commentSlop ? { commentSlop } : {}),
  };
}

export function envelope(facet, data, env = process.env, now = new Date()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    facet,
    repo: env.GITHUB_REPOSITORY ?? null,
    ref: env.GITHUB_REF ?? null,
    commitSha: env.GITHUB_SHA ?? null,
    runId: env.GITHUB_RUN_ID ? Number(env.GITHUB_RUN_ID) : null,
    runAttempt: env.GITHUB_RUN_ATTEMPT ? Number(env.GITHUB_RUN_ATTEMPT) : null,
    generatedAt: now.toISOString(),
    data,
  };
}

// The subset of JSON Schema that scripts/engineering-excellence.schema.json uses: local $ref,
// type, required, properties, additionalProperties, items, enum, minimum, maximum.
// Enough to keep the contract honest without adding a validator dependency.
export function validate(value, schema, path = '$', root = schema) {
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], root);
    if (!target) return [`${path}: unresolved $ref ${schema.$ref}`];
    return validate(value, target, path, root);
  }
  const errors = [];
  const types = [].concat(schema.type ?? []);
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  if (types.length) {
    const t = typeOf(value);
    const ok = types.some((want) => want === t || (want === 'number' && t === 'integer'));
    if (!ok) return [`${path}: expected ${types.join('|')}, got ${t}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > ${schema.maximum}`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}: missing '${key}'`);
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties?.[key] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : null);
      if (sub) errors.push(...validate(v, sub, `${path}.${key}`, root));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected '${key}'`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errors.push(...validate(v, schema.items, `${path}[${i}]`, root)));
  return errors;
}

export function validateFacet(doc, schema) {
  const errors = validate(doc, schema.$defs.envelope, '$', schema);
  if (errors.length) return errors;
  return validate(doc.data, schema.$defs[doc.facet], '$.data', schema);
}
