// Managed by @plainconceptsplatform/workflows. Source: loops/actions/issue-size.cjs. Update with `workflows update --force`; consumer edits may be overwritten.
'use strict';

// Refine's size gate, as one rule both sides read: the refine guard measures an issue with it,
// and the audit measures every issue it files with it before filing. While the audit had no way to
// ask, every report it filed from 2026-09-21 on was over the gate and was refused.
//
// The numbers match what the guard's shell counted: `wc -c` (UTF-8 bytes) of the title, a blank
// line and the body with trailing newlines dropped, and one work unit per `-` or `*` bullet line.

const BULLET = /^[ \t\r\v\f]*[-*] /;

function issueText(title, body) {
  return `${title ?? ''}\n\n${body ?? ''}`.replace(/\n+$/, '');
}

function measureIssue(title, body) {
  const text = issueText(title, body);
  return {
    chars: Buffer.byteLength(text, 'utf8'),
    units: text.split('\n').filter((line) => BULLET.test(line)).length,
  };
}

function sizeVerdict(size, limits) {
  const reasons = [];
  if (size.chars > limits.maxBodyChars) reasons.push(`body ${size.chars} chars > ${limits.maxBodyChars}`);
  if (size.units > limits.maxWorkUnits) reasons.push(`work units ${size.units} > ${limits.maxWorkUnits}`);
  return { tooBig: reasons.length > 0, reason: reasons.join('; ') };
}

function fitsLimits(title, body, limits) {
  return !sizeVerdict(measureIssue(title, body), limits).tooBig;
}

module.exports = { BULLET, measureIssue, sizeVerdict, fitsLimits };
