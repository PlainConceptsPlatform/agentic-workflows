// Managed by @plainconceptsplatform/workflows. Source: loops/actions/file-audit-issues/audit-issues.cjs. Update with `workflows update --force`; consumer edits may be overwritten.
'use strict';

// What the audit files, decided apart from the API calls so it can be tested on its own. Pure: no
// network, no clock. The audit used to file one issue holding every finding and three stories,
// labelled `refine`; refine's size gate refused every one. Now the report is a tracking issue that
// refine never sees, each story is its own issue, and every body is measured with refine's own
// rule before anything is filed: a body over the limits is trimmed here, never filed to be refused.

const { measureIssue, sizeVerdict } = require('../issue-size.cjs');

// Wide enough for any issue number, so a body measured with it only shrinks once the real one is in.
const PLACEHOLDER_NUMBER = 9999999;
const MAX_TITLE = 200;
const STORY_HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
// The story section of the old single-issue shape: "## Top 3 — To Implement", "## Section 2 ...".
const STORY_SECTION = /^(#{1,6})\s+(?:.*\bto implement\b|section 2\b)/i;
const FENCE = /^\s*(```|~~~)/;

const bytes = (text) => Buffer.byteLength(text, 'utf8');
const units = (text) => measureIssue('', text).units;
const titleKey = (title) => String(title ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const cleanTitle = (title) => {
  const flat = String(title ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE - 1)}…` : flat;
};

function reportMarker(number) {
  return `<!-- audit-report: ${number} -->`;
}

function renderStory(body, reportNumber) {
  return `${body.replace(/\s+$/, '')}\n\nFound by the audit report #${reportNumber}.\n${reportMarker(reportNumber)}`;
}

function renderReport(body, links) {
  const trimmed = body.replace(/\s+$/, '');
  if (links.length === 0) return trimmed;
  const lines = links.map((link) => `- [ ] #${link.number} ${link.title}${link.tracked ? ' (already tracked)' : ''}`);
  return `${trimmed}\n\n## To implement\n\n${lines.join('\n')}`;
}

// The longest prefix of `text`, whole lines, that fits the budget. An open code fence is closed, so
// a cut never turns the rest of the issue into code. A first line too long on its own is cut short.
function trimLines(text, budget) {
  const lines = text.split('\n');
  const kept = [];
  let inFence = false;
  for (const line of lines) {
    const opensOrCloses = FENCE.test(line);
    const nextInFence = opensOrCloses ? !inFence : inFence;
    const candidate = [...kept, line, ...(nextInFence ? ['```'] : [])].join('\n');
    if (bytes(candidate) > budget.bytes || units(candidate) > budget.units) {
      // A bullet cut short is still a bullet, so it is only kept while a unit is left for it.
      if (kept.length === 0 && units(line) <= budget.units) {
        const chars = [...line];
        while (chars.length > 0 && bytes(`${chars.join('')}…`) > budget.bytes) chars.pop();
        if (chars.length > 0) kept.push(`${chars.join('')}…`);
      }
      if (inFence) kept.push('```');
      return { text: kept.join('\n'), trimmed: true };
    }
    kept.push(line);
    inFence = nextInFence;
  }
  return { text: kept.join('\n'), trimmed: false };
}

function trimNote(runUrl) {
  return runUrl
    ? `_Trimmed to fit refine's size limits. The full text is in the audit run: ${runUrl}_`
    : "_Trimmed to fit refine's size limits._";
}

// Fits `body` so that title + body + suffix passes the limits, trimming from the end.
function fitBody(title, body, suffix, limits, runUrl) {
  const fits = (text) => !sizeVerdict(measureIssue(title, `${text}${suffix}`), limits).tooBig;
  if (fits(body)) return { body, trimmed: false };
  const note = `\n\n${trimNote(runUrl)}`;
  const overhead = measureIssue(title, `${note}${suffix}`);
  const budget = { bytes: limits.maxBodyChars - overhead.chars - 1, units: limits.maxWorkUnits - overhead.units };
  const { text } = trimLines(body, budget);
  const trimmedBody = `${text}${note}`;
  return { body: fits(trimmedBody) ? trimmedBody : trimNote(runUrl), trimmed: true };
}

// Splits markdown at headings (only those `depth` deep, when given) into [preamble, ...sections].
function splitAtHeadings(body, depth = 0) {
  const blocks = [];
  let current = [];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = !inFence && STORY_HEADING.exec(line);
    if (heading && (!depth || heading[1].length === depth) && current.length > 0) {
      blocks.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  blocks.push(current.join('\n'));
  return blocks;
}

// The old single-issue shape carried its stories under a "To implement" heading. Lifts that section
// out of the report and returns its subsections as stories, so a report written the old way still
// becomes a report plus stories rather than one issue refine refuses.
function extractStorySection(body) {
  const lines = body.split('\n');
  let start = -1;
  let level = 0;
  let inFence = false;
  for (const [index, line] of lines.entries()) {
    if (FENCE.test(line)) inFence = !inFence;
    if (inFence) continue;
    const match = STORY_SECTION.exec(line);
    if (match) {
      start = index;
      level = match[1].length;
      break;
    }
  }
  if (start === -1) return { report: body, stories: [] };

  let end = lines.length;
  inFence = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (FENCE.test(lines[index])) inFence = !inFence;
    const heading = !inFence && STORY_HEADING.exec(lines[index]);
    if (heading && heading[1].length <= level) {
      end = index;
      break;
    }
  }

  // Stories are the shallowest headings inside the section; deeper ones belong to a story.
  const section = lines.slice(start + 1, end).join('\n');
  let fenced = false;
  const depths = section.split('\n')
    .map((line) => ((fenced = FENCE.test(line) ? !fenced : fenced) ? null : STORY_HEADING.exec(line)))
    .filter(Boolean)
    .map((match) => match[1].length);
  const depth = depths.length > 0 ? Math.min(...depths) : 0;
  const stories = splitAtHeadings(section, depth)
    .map((block) => {
      const [first, ...rest] = block.split('\n');
      const heading = STORY_HEADING.exec(first);
      if (!heading || heading[1].length !== depth) return null;
      const title = heading[2].replace(/^(story\s+\w+|\d+[.)])\s*[—–:-]\s*/i, '');
      return { title, body: rest.join('\n').trim() };
    })
    .filter((story) => story && story.title && story.body);

  const report = [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\s+$/, '');
  return { report, stories };
}

// Shares a budget among blocks so short ones keep everything and long ones split what is left.
function shareBudget(sizes, total) {
  const shares = new Array(sizes.length).fill(0);
  let remaining = Math.max(0, total);
  const order = sizes.map((size, index) => ({ size, index })).sort((a, b) => a.size - b.size);
  order.forEach(({ size, index }, position) => {
    const fair = Math.floor(remaining / (order.length - position));
    shares[index] = Math.min(size, fair);
    remaining -= shares[index];
  });
  return shares;
}

// Fits the report by trimming every finding to a share of the budget, so all of them stay listed
// with their heading and first lines rather than the last ones vanishing.
function fitReport(title, body, suffix, limits, runUrl) {
  const fits = (text) => !sizeVerdict(measureIssue(title, `${text}${suffix}`), limits).tooBig;
  if (fits(body)) return { body, trimmed: false };
  const note = `\n\n${trimNote(runUrl)}`;
  const blocks = splitAtHeadings(body);
  const overhead = measureIssue(title, `${note}${suffix}`);
  const separators = 2 * Math.max(0, blocks.length - 1);
  const byteShares = shareBudget(blocks.map(bytes), limits.maxBodyChars - overhead.chars - separators - 1);
  const unitShares = shareBudget(blocks.map(units), limits.maxWorkUnits - overhead.units);
  const compact = blocks.map((block, index) => trimLines(block, { bytes: byteShares[index], units: unitShares[index] }).text.trimEnd())
    .filter((block) => block.length > 0)
    .join('\n\n');
  const trimmedBody = `${compact}${note}`;
  if (fits(trimmedBody)) return { body: trimmedBody, trimmed: true };
  return fitBody(title, compact, suffix, limits, runUrl);
}

// `items` are the agent's create_issue items. The report is the one titled "Audit: ...", or the
// first; the others are stories. Returns bodies that pass `limits` once rendered with any issue
// number, which is the refine guard's check run before filing instead of after.
function planAuditIssues(items, options) {
  const { limits, maxStories = 3, runUrl = '' } = options;
  const usable = items.filter((item) => item && String(item.title ?? '').trim());
  if (usable.length === 0) return null;

  const reportIndex = Math.max(0, usable.findIndex((item) => /^audit\b/i.test(String(item.title).trim())));
  const reportItem = usable[reportIndex];
  const lifted = extractStorySection(String(reportItem.body ?? ''));
  const separate = usable.filter((_, index) => index !== reportIndex)
    .map((item) => ({ title: item.title, body: String(item.body ?? '').trim() }));

  // Separate stories win; the lifted section is only used when the agent filed the old shape.
  const candidates = (separate.length > 0 ? separate : lifted.stories)
    .map((story) => ({ title: cleanTitle(story.title), body: story.body }))
    .filter((story) => story.title && story.body);
  const seen = new Set();
  const unique = candidates.filter((story) => {
    const key = titleKey(story.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const dropped = unique.slice(maxStories).map((story) => story.title);

  const stories = unique.slice(0, maxStories).map((story) => {
    const suffix = renderStory('', PLACEHOLDER_NUMBER);
    const fitted = fitBody(story.title, story.body, suffix, limits, runUrl);
    return { title: story.title, body: fitted.body, trimmed: fitted.trimmed };
  });

  const reportTitle = cleanTitle(reportItem.title);
  const links = stories.map((story) => ({ number: PLACEHOLDER_NUMBER, title: story.title, tracked: true }));
  const suffix = renderReport('', links);
  const fitted = fitReport(reportTitle, lifted.report.trim(), suffix, limits, runUrl);

  return {
    report: { title: reportTitle, body: fitted.body, trimmed: fitted.trimmed, lifted: lifted.stories.length },
    stories,
    dropped,
  };
}

module.exports = {
  PLACEHOLDER_NUMBER,
  extractStorySection,
  planAuditIssues,
  renderReport,
  renderStory,
  reportMarker,
  titleKey,
  trimLines,
};
