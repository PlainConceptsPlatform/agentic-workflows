#!/usr/bin/env node
// Managed by @plainconceptsplatform/workflows. Source: loops/templates/platform-template/scripts/check-platform-conformance.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// Keeps the paths a platform contract (.platform/contract.yml) marks as `owned` equal to the template
// they come from. A pull request may change them only in a template sync (it changes `sync.marker` or
// moves `sync.version`) or under an unexpired exception; conflict markers and expired exceptions fail.
// With --compare, owned files are also compared with `source.url` at the recorded version.
// Without a contract it passes silently. .copier-answers.yml + .platform/manifest is read as one.
//
// Usage: node scripts/check-platform-conformance.mjs [--base <git ref>] [--compare]
//        node scripts/check-platform-conformance.mjs --contract   (key=value lines for $GITHUB_OUTPUT)

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CONTRACT = '.platform/contract.yml';
const LEGACY_ANSWERS = '.copier-answers.yml';
const LEGACY_MANIFEST = '.platform/manifest';
const DEFAULT_EXCEPTIONS = '.platform/exceptions.yml';
const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)/m;

export class ContractError extends Error {}

// gitwildmatch, the .gitignore syntax: a pattern with no inner slash matches at any depth, `**`
// crosses directories, and a match on a directory covers everything below it.
export function globToRegExp(glob) {
  let pattern = glob.endsWith('/') ? `${glob}**` : glob;
  const anchored = pattern.replace(/\/\*\*$/, '').includes('/');
  pattern = pattern.replace(/^\//, '');
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else {
        re += `[${pattern.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp — the glob comes from the committed contract and every metacharacter outside a class is escaped
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}(?:/.*)?$`);
}

export function parsePatterns(globs) {
  return globs
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const negate = line.startsWith('!');
      const glob = negate ? line.slice(1) : line;
      return { glob, negate, regex: globToRegExp(glob) };
    });
}

export const parseManifest = (text) => parsePatterns(text.split(/\r?\n/));

// The last pattern that matches decides, as in .gitignore.
export function isOwned(patterns, path) {
  let matched = false;
  for (const { negate, regex } of patterns) if (regex.test(path)) matched = !negate;
  return matched;
}

const unquote = (value) => {
  const v = value.trim();
  const quoted = v.match(/^"(.*)"$|^'(.*)'$/);
  if (quoted) return quoted[1] ?? quoted[2];
  return v.replace(/\s+#.*$/, '');
};

function stripComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function scalar(raw, at) {
  const text = raw.trim();
  if (/^[|>][+-]?$/.test(text) || /^[&*!{]/.test(text)) throw new ContractError(`${at}: "${text}" is not supported; write the value on one line`);
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new ContractError(`${at}: unclosed "["`);
    const inner = text.slice(1, -1).trim();
    return inner === '' ? [] : (inner.match(/"[^"]*"|'[^']*'|[^,]+/g) ?? []).map((item) => scalar(item, at));
  }
  if (/^["']/.test(text)) return unquote(text);
  if (/^-?\d+$/.test(text)) return Number(text);
  if (text === 'true' || text === 'false') return text === 'true';
  if (text === '' || text === '~' || text === 'null') return null;
  return text;
}

// The YAML a contract needs: nested mappings, block and flow lists of scalars, quotes and comments.
export function parseYamlSubset(text, file) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const content = stripComment(raw).replace(/\s+$/, '');
    if (content.trim() === '' || /^---\s*$/.test(content)) return;
    if (/^\s*\t/.test(raw)) throw new ContractError(`${file}:${index + 1}: indent with spaces, not tabs`);
    lines.push({ indent: content.length - content.trimStart().length, text: content.trim(), at: `${file}:${index + 1}` });
  });
  let next = 0;
  const isItem = (line) => line.text === '-' || line.text.startsWith('- ');
  const block = (indent) => {
    if (isItem(lines[next])) {
      const list = [];
      while (next < lines.length && lines[next].indent === indent && isItem(lines[next])) {
        const { text, at } = lines[next++];
        if (text === '-') throw new ContractError(`${at}: a list item must be a value on the same line`);
        list.push(scalar(text.slice(2), at));
      }
      return list;
    }
    const map = {};
    while (next < lines.length && lines[next].indent === indent && !isItem(lines[next])) {
      const { text, at } = lines[next++];
      const pair = text.match(/^([A-Za-z_][\w-]*):(?:\s+(.*))?$/);
      if (!pair) throw new ContractError(`${at}: cannot read "${text}"; expected "key: value"`);
      const following = lines[next];
      const nested = following && (following.indent > indent || (following.indent === indent && isItem(following)));
      if (pair[2] !== undefined) map[pair[1]] = scalar(pair[2], at);
      else map[pair[1]] = nested ? block(following.indent) : null;
    }
    return map;
  };
  if (lines.length === 0) return {};
  if (lines[0].indent !== 0 || isItem(lines[0])) throw new ContractError(`${lines[0].at}: the file must be a mapping of top-level keys`);
  const root = block(0);
  if (next < lines.length) throw new ContractError(`${lines[next].at}: unexpected indentation`);
  return root;
}

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const repositoryName = (url) => basename(url.replace(/\.git$/, '').replace(/\/+$/, '')) || url;

export function validateContract(data, file = CONTRACT) {
  const fail = (field, problem) => {
    throw new ContractError(`${file}: ${field} ${problem}`);
  };
  if (!isMapping(data)) fail('the file', 'must be a YAML mapping');
  if (data.version === undefined || data.version === null) fail('version', 'is required (version: 1)');
  if (data.version !== 1) fail('version', `${JSON.stringify(data.version)} is not supported; this guard reads version 1`);
  if (!isMapping(data.source)) fail('source', 'is required: a mapping with at least url');
  if (!isText(data.source.url)) fail('source.url', 'is required: where the shared code lives');
  for (const key of ['name', 'changes']) {
    if (data.source[key] != null && !isText(data.source[key])) fail(`source.${key}`, 'must be text');
  }
  if (!Array.isArray(data.owned) || data.owned.length === 0) fail('owned', 'is required: a list of repository-relative globs');
  data.owned.forEach((glob, index) => isText(glob) || fail(`owned[${index}]`, 'must be a glob'));
  if (data.exceptions != null && !isText(data.exceptions)) fail('exceptions', 'must be a repository-relative path');
  const sync = data.sync ?? {};
  if (!isMapping(sync)) fail('sync', 'must be a mapping');
  for (const key of ['marker', 'update']) if (sync[key] != null && !isText(sync[key])) fail(`sync.${key}`, 'must be text');
  if (sync.version != null) {
    if (!isMapping(sync.version)) fail('sync.version', 'must be a mapping with file and key');
    for (const key of ['file', 'key']) if (!isText(sync.version[key])) fail(`sync.version.${key}`, 'is required');
  }
  return {
    version: 1,
    source: { name: data.source.name ?? repositoryName(data.source.url), url: data.source.url, changes: data.source.changes ?? data.source.url },
    owned: data.owned,
    exceptions: data.exceptions ?? DEFAULT_EXCEPTIONS,
    sync: { marker: sync.marker ?? undefined, version: sync.version ?? undefined, update: sync.update ?? undefined },
    file,
  };
}

// What harness 3.7.0 and workflows 1.11.0 read before the contract existed.
export function legacyContract(answers, manifest) {
  const source = topLevelValue(answers, '_src_path');
  if (!source) throw new ContractError(`${LEGACY_ANSWERS}: _src_path is required to read it as a platform contract`);
  const url = source.replace(/^git\+/, '').replace(/^gh:/, 'https://github.com/').replace(/^gl:/, 'https://gitlab.com/');
  return {
    version: 1,
    source: { name: repositoryName(url), url, changes: url },
    owned: manifest.split(/\r?\n/),
    exceptions: DEFAULT_EXCEPTIONS,
    sync: {
      marker: LEGACY_ANSWERS,
      version: { file: LEGACY_ANSWERS, key: '_commit' },
      update: 'copier update --trust --defaults --conflict inline',
    },
    file: `${LEGACY_ANSWERS} + ${LEGACY_MANIFEST}`,
  };
}

export function topLevelValue(text, key) {
  if (text === undefined) return undefined;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp — the key is escaped
  const value = text.match(new RegExp(`^${escaped}:[ \\t]*(.*?)[ \\t]*$`, 'm'))?.[1];
  return value === undefined ? undefined : unquote(stripComment(value)) || undefined;
}

// undefined when the repository declares no contract, explicit or legacy.
export function readContract(root) {
  const read = (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined);
  const text = read(CONTRACT);
  if (text !== undefined) return validateContract(parseYamlSubset(text, CONTRACT));
  const answers = read(LEGACY_ANSWERS);
  const manifest = read(LEGACY_MANIFEST);
  return answers !== undefined && manifest !== undefined ? legacyContract(answers, manifest) : undefined;
}

export const recordedVersion = (contract, readFile) =>
  contract.sync.version ? topLevelValue(readFile(contract.sync.version.file), contract.sync.version.key) : undefined;

export function normalizeUrl(url) {
  return url
    .trim()
    .replace(/^git\+/, '')
    .replace(/^gh:/, 'https://github.com/')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^(https?:\/\/)[^@/]+@/, '$1')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// The template repository carries the contract too; its owned paths are its own.
function isSourceRepository(root, contract) {
  try {
    return normalizeUrl(git(root, ['remote', 'get-url', 'origin'])) === normalizeUrl(contract.source.url);
  } catch {
    return false;
  }
}

// The subset of YAML the exceptions file uses: one `exceptions:` list of flat mappings.
export function parseExceptions(text, file = DEFAULT_EXCEPTIONS) {
  const entries = [];
  const problems = [];
  let inList = false;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) return;
    const at = `${file}:${index + 1}`;
    const top = line.match(/^exceptions:\s*(\[\s*\])?\s*(?:#.*)?$/);
    if (top) {
      inList = !top[1];
      return;
    }
    const item = line.match(/^\s*-\s+([A-Za-z_]+):(.*)$/);
    const field = line.match(/^\s+([A-Za-z_]+):(.*)$/);
    if (inList && item) entries.push({ line: index + 1, [item[1]]: unquote(item[2]) });
    else if (inList && field && entries.length > 0) entries.at(-1)[field[1]] = unquote(field[2]);
    else problems.push(`${at}: cannot read "${line.trim()}"; expected exceptions: [{ path, reason, issue, expires }]`);
  });
  for (const entry of entries) {
    const at = `${file}:${entry.line}`;
    const missing = ['path', 'reason', 'issue', 'expires'].filter((key) => !entry[key]);
    if (missing.length > 0) problems.push(`${at}: exception without ${missing.join(', ')}`);
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires) || Number.isNaN(Date.parse(entry.expires))) {
      problems.push(`${at}: expires must be a date (YYYY-MM-DD), got "${entry.expires}"`);
    }
  }
  const valid = entries.filter((entry) => entry.path && entry.reason && entry.issue && !Number.isNaN(Date.parse(entry.expires)));
  return { exceptions: valid.map((entry) => ({ ...entry, regex: globToRegExp(entry.path) })), problems };
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitShow(root, ref, path) {
  try {
    return git(root, ['show', `${ref}:${path}`]);
  } catch {
    return undefined;
  }
}

// `git ls-tree -r` and `git ls-files -s` lines, as path -> blob id; submodules are skipped.
function blobIds(listing, idField) {
  const ids = new Map();
  for (const entry of listing.split('\0').filter(Boolean)) {
    const [meta, path] = entry.split('\t');
    const fields = meta.split(' ');
    if (fields[0] !== '160000') ids.set(path, fields[idField]);
  }
  return ids;
}

// Blob ids of the source's files at the version: a tag or commit, or `git describe` output.
function sourceBlobs(url, version) {
  const scratch = mkdtempSync(join(tmpdir(), 'platform-source-'));
  try {
    git(scratch, ['init', '--quiet', '--bare']);
    let ref = 'FETCH_HEAD';
    try {
      git(scratch, ['fetch', '--quiet', '--depth', '1', url, version]);
    } catch {
      git(scratch, ['fetch', '--quiet', url, '+refs/tags/*:refs/tags/*', '+refs/heads/*:refs/heads/*']);
      ref = version.match(/-\d+-g([0-9a-f]{4,})$/)?.[1] ?? version;
    }
    return blobIds(git(scratch, ['ls-tree', '-r', '-z', `${ref}^{commit}`]), 2);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function compareWithSource(root, contract, patterns, live, version) {
  const failures = [];
  const notes = [];
  const { name, url, changes } = contract.source;
  if (!version) return { failures: [`cannot compare with ${name}: ${contract.sync.version?.file ?? 'the contract'} records no template version (sync.version)`], notes };
  let source;
  try {
    source = sourceBlobs(url, version);
  } catch (error) {
    const reason = String(error.stderr ?? error.message).trim().split('\n').at(-1);
    return { failures, notes: [`cannot read ${url} at ${version} (${reason}); owned files were not compared with the source`] };
  }
  const local = blobIds(git(root, ['ls-files', '-s', '-z']), 1);
  for (const [path, id] of source) {
    if (!isOwned(patterns, path) || local.get(path) === id) continue;
    const problem = local.has(path) ? `differs from ${name} at ${version}` : `is missing; ${name} at ${version} has it`;
    const covered = live.find((entry) => entry.regex.test(path));
    if (covered) notes.push(`${path}: ${problem}, allowed by the exception until ${covered.expires} (${covered.issue})`);
    else failures.push(`${path}: ${problem}; change it in ${name} (${changes}) or add an exception to ${contract.exceptions}`);
  }
  const onlyHere = [...local.keys()].filter((path) => isOwned(patterns, path) && !source.has(path));
  if (onlyHere.length > 0) notes.push(`${onlyHere.length} owned file(s) are not in ${name} at ${version} under the same path; not compared`);
  return { failures, notes };
}

export function checkConformance(root, { base, compare = false, today = new Date().toISOString().slice(0, 10) } = {}) {
  const read = (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined);
  let contract;
  try {
    contract = readContract(root);
  } catch (error) {
    if (error instanceof ContractError) return { adopted: true, failures: [error.message], notes: [] };
    throw error;
  }
  if (contract === undefined) return { adopted: false, failures: [], notes: [] };
  if (isSourceRepository(root, contract)) {
    return { adopted: true, failures: [], notes: [`this repository is ${contract.source.name}, the source of its own owned paths`] };
  }

  const failures = [];
  const notes = [];
  const patterns = parsePatterns(contract.owned);
  const { exceptions, problems } = parseExceptions(read(contract.exceptions) ?? '', contract.exceptions);
  failures.push(...problems);
  const live = exceptions.filter((entry) => entry.expires >= today);
  for (const entry of exceptions.filter((e) => e.expires < today)) {
    failures.push(`${contract.exceptions}:${entry.line}: the exception for ${entry.path} expired on ${entry.expires} (${entry.issue}); converge the code or renew it`);
  }

  const tracked = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  for (const file of tracked.filter((path) => isOwned(patterns, path))) {
    const text = read(file);
    if (text !== undefined && !text.includes('\0') && CONFLICT_MARKER.test(text)) {
      failures.push(`${file}: unresolved template-sync conflict markers`);
    }
  }

  const version = recordedVersion(contract, read);
  if (base !== undefined) {
    const changed = git(root, ['diff', '--name-only', '--no-renames', `${base}...HEAD`]).split('\n').filter(Boolean);
    const owned = changed.filter((path) => isOwned(patterns, path));
    const before = contract.sync.version ? topLevelValue(gitShow(root, base, contract.sync.version.file), contract.sync.version.key) : undefined;
    const moved = contract.sync.version !== undefined && before !== version;
    if (moved || (contract.sync.marker && changed.includes(contract.sync.marker))) {
      const step = moved ? `${before ?? '(adoption)'} -> ${version}` : `(${contract.sync.marker} changed)`;
      notes.push(`template sync ${step}: ${owned.length} owned file(s) may change`);
    } else {
      for (const path of owned) {
        const covered = live.find((entry) => entry.regex.test(path));
        if (covered) notes.push(`${path}: allowed by the exception until ${covered.expires} (${covered.issue})`);
        else failures.push(`${path}: owned by ${contract.source.name} and changed outside a template sync; change it in ${contract.source.name} (${contract.source.changes}), or add an exception to ${contract.exceptions}`);
      }
    }
  }
  if (compare) {
    const result = compareWithSource(root, contract, patterns, live, version);
    failures.push(...result.failures);
    notes.push(...result.notes);
  }
  return { adopted: true, failures, notes };
}

// One key=value line per field, for $GITHUB_OUTPUT; contract=absent when there is none.
export function contractOutputs(root) {
  const contract = readContract(root);
  if (contract === undefined) return 'contract=absent\n';
  const read = (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined);
  const web = contract.source.url.replace(/^git\+/, '').replace(/\.git$/, '');
  const fields = {
    contract: 'present',
    self: String(isSourceRepository(root, contract)),
    source_name: contract.source.name,
    source_url: contract.source.url,
    source_web: /^https?:\/\//.test(web) ? web : '',
    version: recordedVersion(contract, read) ?? '',
    update: contract.sync.update ?? '',
  };
  for (const [key, value] of Object.entries(fields)) {
    if (/[\r\n]/.test(value)) throw new ContractError(`${contract.file}: ${key} must be a single line`);
  }
  return Object.entries(fields).map(([key, value]) => `${key}=${value}\n`).join('');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf('--base');
  const base = baseIndex === -1 ? undefined : args[baseIndex + 1];
  const unknown = args.filter((arg, i) => i !== baseIndex + 1 || baseIndex === -1).filter((arg) => !['--base', '--compare', '--contract'].includes(arg));
  if ((baseIndex !== -1 && !base) || unknown.length > 0) {
    console.error('usage: node scripts/check-platform-conformance.mjs [--base <git ref>] [--compare] | --contract');
    process.exit(2);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  if (args.includes('--contract')) {
    try {
      process.stdout.write(contractOutputs(root));
      process.exit(0);
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      console.error(`✗ ${error.message}`);
      process.exit(1);
    }
  }
  const { adopted, failures, notes } = checkConformance(root, { base, compare: args.includes('--compare') });
  if (!adopted) process.exit(0);
  for (const note of notes) console.log(`· ${note}`);
  for (const failure of failures) console.error(`✗ ${failure}`);
  if (failures.length === 0) console.log('✓ owned files match the template');
  process.exit(failures.length === 0 ? 0 : 1);
}
