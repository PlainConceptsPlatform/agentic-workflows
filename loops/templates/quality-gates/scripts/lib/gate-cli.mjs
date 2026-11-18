// Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/lib/gate-cli.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
// What the report-then-ratchet check scripts share: argument parsing, the mode line, the
// not-measured verdict and the baseline writes. check-dead-code.mjs, check-bundle-size.mjs,
// check-architecture.mjs and check-patterns.mjs print the same sentences from here, so a check reads
// the same in every step summary and a rule (a ratchet's baseline is never raised by a script) lives
// in one place.

import { CONFIG_FILE, today, writeCheckSection } from './quality-config.mjs';

// `--name value` options and `--name` flags.
export function cliArgs(argv = process.argv.slice(2)) {
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const flag = (name) => argv.includes(`--${name}`);
  return { opt, flag };
}

// One line per argument: the step summary is Markdown, and a table needs its rows on their own lines.
export const say = (...lines) => console.log(lines.join('\n'));

// The heading and the mode sentence every check opens with. `ratchetRule` says what fails a ratchet.
export function header(title, config, ratchetRule) {
  const mode = config.mode === 'ratchet'
    ? `Mode: ratchet${config.since ? ` (check introduced ${config.since})` : ''}. ${ratchetRule}`
    : `Mode: report-only${config.since ? ` since ${config.since}` : ''}. Never fails CI; the switch to \`ratchet\` is a reviewed change to quality.config.json.`;
  return [`### ${title}`, '', mode];
}

// A check that could not measure passes in report mode and fails in ratchet mode, because a gate
// that cannot measure must not read as green. Returns the exit code.
export function notMeasured(config, why) {
  say('', `Not measured: ${why}`);
  return config.mode === 'ratchet' ? 1 : 0;
}

// The keys a count baseline would raise: only a ratchet's, which a script never raises.
export function raisedKeys(config, next) {
  if (config.mode !== 'ratchet') return [];
  return Object.entries(next).filter(([key, count]) => count > (config.baseline?.[key] ?? 0)).map(([key]) => key);
}

// `--write-baseline` for a baseline of counts per kind (a Knip issue type, a Steiger rule, an
// analyzer rule). Records `mode` and `since` with the first baseline. Returns the exit code.
export function writeCountBaseline(name, config, next, { fix }, file = CONFIG_FILE) {
  const raised = raisedKeys(config, next);
  if (raised.length) {
    console.error(`✗ ${name} is a ratchet and this would raise its baseline for ${raised.join(', ')}. ${fix}, or lower the baseline with --update-baseline; raising it is a hand edit of quality.config.json with the reason in the pull request.`);
    return 2;
  }
  const written = writeCheckSection(name, (s) => ({
    ...s,
    mode: s.mode ?? 'report',
    since: s.since ?? today(),
    baseline: next,
  }), file);
  say('', `· wrote ${name}.baseline to quality.config.json: ${JSON.stringify(written.baseline)}`);
  return 0;
}

// `--update-baseline`: writes the lowered baseline `lower(baseline)` and nothing else. Returns the exit code.
export function updateCountBaseline(name, config, lower, file = CONFIG_FILE) {
  if (!config.baseline) {
    console.error(`✗ ${name}.baseline does not exist yet; write it with --write-baseline`);
    return 2;
  }
  const lowered = lower(config.baseline);
  writeCheckSection(name, (s) => ({ ...s, baseline: lowered }), file);
  say('', `· ${name}.baseline ${JSON.stringify(config.baseline)} -> ${JSON.stringify(lowered)}`);
  return 0;
}

// The closing lines of a count check: what improved, what is over, the missing baseline and the
// verdict. `command` is the script with its report argument; `describe(v, mark)` prints one
// violation and up to ten of its findings. Returns the exit code.
export function closeCountCheck({ config, improved, violations, failed, command, describe, fixHint, okLine }) {
  if (improved.length) {
    say('', `Improved below the baseline: ${improved.join(', ')}. Run \`${command} --update-baseline\` to ratchet it down.`);
  }
  if (violations.length) {
    say('', failed ? `Violations — ${fixHint}:` : 'Over the baseline (report-only, not failing):', '');
    for (const v of violations) describe(v, failed ? '✗' : '·');
  }
  if (!config.baseline) {
    say('', `No baseline yet. Record one in a pull request with \`${command} --write-baseline\`.`);
  }
  if (failed) return 1;
  say('', violations.length ? '· report-only: nothing fails' : okLine);
  return 0;
}
