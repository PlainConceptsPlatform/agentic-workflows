#!/usr/bin/env node
// Managed by @plainconceptsplatform/workflows. Source: loops/templates/platform-template/scripts/check-platform-conformance.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// The .platform/manifest paths change only in a template sync (a pull request that moves `_commit` in
// .copier-answers.yml) or under an unexpired .platform/exceptions.yml entry. Conflict markers in a
// manifest file and expired exceptions fail too. Offline; without .copier-answers.yml it passes silently.
//
// Usage: node scripts/check-platform-conformance.mjs [--base <git ref>]   (no --base: markers and exceptions only)

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ANSWERS = '.copier-answers.yml';
const MANIFEST = '.platform/manifest';
const EXCEPTIONS = '.platform/exceptions.yml';
const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)/m;

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
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp — the glob comes from the committed manifest and every metacharacter outside a class is escaped
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}(?:/.*)?$`);
}

export function parseManifest(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const negate = line.startsWith('!');
      const glob = negate ? line.slice(1) : line;
      return { glob, negate, regex: globToRegExp(glob) };
    });
}

// The last pattern that matches decides, as in .gitignore.
export function inManifest(patterns, path) {
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

// The subset of YAML .platform/exceptions.yml uses: one `exceptions:` list of flat mappings.
export function parseExceptions(text) {
  const entries = [];
  const problems = [];
  let inList = false;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) return;
    const at = `${EXCEPTIONS}:${index + 1}`;
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
    const at = `${EXCEPTIONS}:${entry.line}`;
    const missing = ['path', 'reason', 'issue', 'expires'].filter((key) => !entry[key]);
    if (missing.length > 0) problems.push(`${at}: exception without ${missing.join(', ')}`);
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires) || Number.isNaN(Date.parse(entry.expires))) {
      problems.push(`${at}: expires must be a date (YYYY-MM-DD), got "${entry.expires}"`);
    }
  }
  const valid = entries.filter((entry) => entry.path && entry.reason && entry.issue && !Number.isNaN(Date.parse(entry.expires)));
  return { exceptions: valid.map((entry) => ({ ...entry, regex: globToRegExp(entry.path) })), problems };
}

const templateCommit = (answers) => answers?.match(/^_commit:\s*(.+?)\s*$/m)?.[1]?.replace(/^["']|["']$/g, '');

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitShow(root, ref, path) {
  try {
    return git(root, ['show', `${ref}:${path}`]);
  } catch {
    return undefined;
  }
}

export function checkConformance(root, { base, today = new Date().toISOString().slice(0, 10) } = {}) {
  const read = (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined);
  const answers = read(ANSWERS);
  if (answers === undefined) return { adopted: false, failures: [], notes: [] };

  const failures = [];
  const notes = [];
  const manifestText = read(MANIFEST);
  if (manifestText === undefined) return { adopted: true, failures: [`${ANSWERS} exists but ${MANIFEST} does not`], notes };
  const patterns = parseManifest(manifestText);

  const { exceptions, problems } = parseExceptions(read(EXCEPTIONS) ?? '');
  failures.push(...problems);
  const live = exceptions.filter((entry) => entry.expires >= today);
  for (const entry of exceptions.filter((e) => e.expires < today)) {
    failures.push(`${EXCEPTIONS}:${entry.line}: the exception for ${entry.path} expired on ${entry.expires} (${entry.issue}); converge the code or renew it`);
  }

  const tracked = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  for (const file of tracked.filter((path) => inManifest(patterns, path))) {
    const text = read(file);
    if (text !== undefined && !text.includes('\0') && CONFLICT_MARKER.test(text)) {
      failures.push(`${file}: unresolved template-sync conflict markers`);
    }
  }

  if (base !== undefined) {
    const changed = git(root, ['diff', '--name-only', '--no-renames', `${base}...HEAD`]).split('\n').filter(Boolean);
    const platform = changed.filter((path) => inManifest(patterns, path));
    const before = templateCommit(gitShow(root, base, ANSWERS));
    const after = templateCommit(answers);
    if (before !== after) {
      notes.push(`template sync ${before ?? '(adoption)'} -> ${after}: ${platform.length} platform file(s) may change`);
    } else {
      for (const path of platform) {
        const covered = live.find((entry) => entry.regex.test(path));
        if (covered) notes.push(`${path}: allowed by the exception until ${covered.expires} (${covered.issue})`);
        else failures.push(`${path}: platform file changed outside a template sync; change it in Kitchen-Sink, or add an exception to ${EXCEPTIONS}`);
      }
    }
  }
  return { adopted: true, failures, notes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf('--base');
  const base = baseIndex === -1 ? undefined : args[baseIndex + 1];
  if (baseIndex !== -1 && !base) {
    console.error('usage: node scripts/check-platform-conformance.mjs [--base <git ref>]');
    process.exit(2);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { adopted, failures, notes } = checkConformance(root, { base });
  if (!adopted) process.exit(0);
  for (const note of notes) console.log(`· ${note}`);
  for (const failure of failures) console.error(`✗ ${failure}`);
  if (failures.length === 0) console.log('✓ platform files match the template');
  process.exit(failures.length === 0 ? 0 : 1);
}
