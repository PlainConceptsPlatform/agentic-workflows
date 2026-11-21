// Managed by @plainconceptsplatform/workflows. Source: loops/actions/audit-follow-up/audit-follow-up.cjs. Update with `workflows update --force`; consumer edits may be overwritten.
'use strict';

// The decisions the audit's follow-up makes against GitHub as it is when it runs, apart from the API
// calls so they can be tested on their own. Pure: no network, no clock. What to close, reopen or open
// was decided by scripts/audit-select.mjs from the numbers; this only refuses to repeat itself and to
// undo what a person decided.

const DAY = 86400000;

// `key=value` pairs separated by spaces, as the markers write them.
const fieldsOf = (text) => Object.fromEntries(String(text).trim().split(/\s+/).map((pair) => pair.split('=')).filter((pair) => pair.length === 2 && pair[0]));

// The verdict lines a follow-up comment carries: `<!-- audit-follow-up: <verdict> id=<id> ... -->`.
const FOLLOW_UP = /<!--\s*audit-follow-up:\s*(close|verify|reopen)\s+id=([0-9a-f]{16})\b([^>]*?)-->/g;

function followUpsIn(text) {
  return [...String(text ?? '').matchAll(FOLLOW_UP)].map((match) => {
    const field = fieldsOf(match[3]);
    return { verdict: match[1], id: match[2], check: field.check ?? null, before: field.before ?? null, after: field.after ?? null, target: field.target ?? null, metric: field.metric ?? null };
  });
}

// Whether any of `comments` already says this verdict about these ids: a re-run posts nothing twice.
// A story the audit closed already carries its numbers, so a later confirmation is not repeated.
const SAYS = { close: ['close'], verify: ['verify', 'close'], reopen: ['reopen'] };
function alreadySaid(comments, verdict, text) {
  const ids = new Set(followUpsIn(text).map((f) => f.id));
  const verdicts = SAYS[verdict] ?? [verdict];
  return (comments ?? []).some((comment) => followUpsIn(comment.body).some((f) => verdicts.includes(f.verdict) && (ids.size === 0 || ids.has(f.id))));
}

// A clean-up story is reopened once, too.
const cleanupReopenedBefore = (comments, check) =>
  (comments ?? []).some((comment) => [...String(comment.body ?? '').matchAll(/<!--\s*audit-graduation-reopen:\s*([A-Za-z]+)\s*-->/g)].some((match) => match[1] === check));

// A story is reopened once, ever: a comment from an earlier reopen is enough to leave it closed.
const reopenedBefore = (comments) => (comments ?? []).some((comment) => followUpsIn(comment.body).some((f) => f.verdict === 'reopen'));

// Whether to open a graduation pull request, given every pull request ever opened from its branch.
// One that is open is left alone; one a person closed without merging is respected for
// `respectDays`, and so is one merged in that time (a later revert is a person's decision too).
function pullRequestDecision(pulls, now, respectDays = 90) {
  const list = [...(pulls ?? [])];
  const open = list.find((pr) => pr.state === 'open');
  if (open) return { open: false, existing: open.number, reason: `pull request #${open.number} is already open` };
  const latest = list.filter((pr) => pr.closed_at).sort((a, b) => Date.parse(b.closed_at) - Date.parse(a.closed_at))[0];
  if (latest && now - Date.parse(latest.closed_at) < respectDays * DAY) {
    const until = new Date(Date.parse(latest.closed_at) + respectDays * DAY).toISOString().slice(0, 10);
    const what = latest.merged_at ? 'was merged' : 'was closed without merging';
    return { open: false, reason: `pull request #${latest.number} ${what} on ${latest.closed_at.slice(0, 10)}; not opened again before ${until}` };
  }
  return { open: true, reason: latest ? `the last one closed on ${latest.closed_at.slice(0, 10)}, over ${respectDays} days ago` : 'none was opened before' };
}

// quality.config.json with one section's keys replaced; every other key kept as it is.
function applyPatch(text, check, patch) {
  const raw = text && text.trim() ? JSON.parse(text.replace(/^﻿/, '')) : {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('quality.config.json does not hold a JSON object');
  const section = raw[check] && typeof raw[check] === 'object' && !Array.isArray(raw[check]) ? raw[check] : {};
  raw[check] = { ...section, ...patch };
  return `${JSON.stringify(raw, null, 2)}\n`;
}

// The merge train's hold label, as the repository's router names it (MERGE_TRAIN_HOLD_LABEL).
function holdLabelFrom(routerText, fallback = 'hold') {
  const match = String(routerText ?? '').match(/^[ \t]+MERGE_TRAIN_HOLD_LABEL:[ \t]*["']?([^"'\n#]*?)["']?[ \t]*(?:#.*)?$/m);
  return match && match[1].trim() ? match[1].trim() : fallback;
}

const GRADUATION_MARKER = /<!--\s*audit-graduation:\s*([A-Za-z]+)(\s+cleanup)?\s*-->/g;
const hasGraduationMarker = (body, check, cleanup) =>
  [...String(body ?? '').matchAll(GRADUATION_MARKER)].some((match) => match[1] === check && Boolean(match[2]) === Boolean(cleanup));

// ── The numbers audit-close puts on a report it closes ──
const ITEM_MARKER = /<!--\s*audit-item:\s*([0-9a-f]{16})\b([^>]*?)-->/g;

function itemMarkersIn(text) {
  return [...String(text ?? '').matchAll(ITEM_MARKER)].map((match) => {
    const field = fieldsOf(match[2]);
    return { id: match[1], value: field.value ?? null, target: field.target ?? null, check: field.check ?? null };
  });
}

function measure(value, metric) {
  if (value === null || value === undefined || value === 'n/a') return 'n/a';
  const n = Number(value);
  if (metric === 'rate' && Number.isFinite(n)) return `${Math.round(n * 1000) / 10}%`;
  if (metric === 'bytes' && Number.isFinite(n)) return `${n} bytes`;
  return String(value);
}

// One line per measured story a report closes on: the number when it was filed and, from the
// audit's follow-up comment, the number CI measured after the fix. `stories` are
// { number, body, comments: [{ body }] }; a story with no item marker (a judgement finding) has none.
function beforeAfterLines(stories) {
  const lines = [];
  for (const story of stories ?? []) {
    const followUps = (story.comments ?? []).flatMap((comment) => followUpsIn(comment.body));
    for (const marker of itemMarkersIn(story.body)) {
      const latest = followUps.filter((f) => f.id === marker.id).pop();
      const check = marker.check ?? latest?.check ?? 'measured';
      const metric = latest?.metric && latest.metric !== 'n/a' ? latest.metric : null;
      const target = measure(latest?.target ?? marker.target, metric);
      const before = measure(marker.value, metric);
      if (!latest) lines.push(`- #${story.number} ${check}: ${before} when filed, not measured since, target ${target}`);
      else if (latest.after === 'gone') lines.push(`- #${story.number} ${check}: ${before} when filed, no longer listed (within its bar), target ${target}`);
      else lines.push(`- #${story.number} ${check}: ${before} when filed, ${measure(latest.after, metric)} after${latest.verdict === 'reopen' ? ' (still over its bar)' : ''}, target ${target}`);
    }
  }
  return lines;
}

module.exports = { alreadySaid, applyPatch, beforeAfterLines, cleanupReopenedBefore, followUpsIn, hasGraduationMarker, holdLabelFrom, itemMarkersIn, pullRequestDecision, reopenedBefore };
