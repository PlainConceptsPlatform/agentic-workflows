import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("../../loops/actions/validate-refine-output/validate-refine-output.sh", import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "refine-outcome-"));
const MARKER = "<!-- agent-refine -->";
const PREFIX = "Refinement update";
const DRAFT = "<!-- agent-refine-draft -->";
const QUESTIONS = `${MARKER}\n${PREFIX}\nI have some questions about this issue. Please reply in one comment and I'll process your answers.\n1. Which margin? **Proposed:** gross.`;

const run = (items) => {
  const name = Math.random().toString(36).slice(2);
  const file = join(dir, `${name}.json`);
  const reasonFile = join(dir, `${name}.reason`);
  writeFileSync(file, JSON.stringify({ items }));
  const result = execFileSync("bash", [script.pathname.replace(/^\/([A-Za-z]:)/, "$1"), file, MARKER, PREFIX, "42", DRAFT], {
    encoding: "utf8",
    env: { ...process.env, REFINE_REASON_FILE: reasonFile },
  }).trim();
  return { outcome: result, reason: existsSync(reasonFile) ? readFileSync(reasonFile, "utf8").trim() : "" };
};
const outcome = (items) => run(items).outcome;
const update = (body) => ({ type: "update_issue", issue_number: 42, body });
const comment = (body) => ({ type: "add_comment", item_number: 42, body });

test("a finished body with the completion comment is complete", () => {
  assert.equal(outcome([update("## Story\nDone."), comment(`${MARKER}\n${PREFIX}\nRefinement complete.`)]), "complete");
});

test("questions win over a body that forgot the draft marker", () => {
  assert.equal(outcome([update("## Story\n_pending see questions below_"), comment(QUESTIONS)]), "questions");
  assert.equal(outcome([update("## Story\nLooks final."), comment(QUESTIONS)]), "questions");
});

test("a marked draft with its questions is questions, and questions alone are too", () => {
  assert.equal(outcome([update(`${DRAFT}\n## Story`), comment(QUESTIONS)]), "questions");
  assert.equal(outcome([comment(QUESTIONS)]), "questions");
});

test("a body still pending with no questions asked is not complete", () => {
  assert.equal(outcome([update("## Story\n_pending see questions below_"), comment(`${MARKER}\n${PREFIX}\nRefinement complete.`)]), "invalid");
});

// #574. The shapes refine runs produced on workflow_dispatch runs, where add_comment was refused
// because the worker's add-comment target was "triggering" and a dispatch has no triggering
// issue. Synthetic bodies; the item mix and fields are the ones the refused runs carried.
const DRAFT_BODY = "**Estimate:** 3 points\n\n## Summary\nThe story so far.\n\n- Acceptance: _pending see questions below_";
const BODY_QUESTIONS = "## Open questions\n\nI have some questions about this issue. Each one carries the answer I would take.\n1. Which roles? **Proposed:** managers only.";
const draftUpdate = (body, operation) => ({ type: "update_issue", issue_number: 42, ...(operation ? { operation } : {}), body });

test("the shape the prompt asks for on a dispatch run is questions", () => {
  assert.equal(outcome([draftUpdate(DRAFT_BODY, "replace"), comment(QUESTIONS)]), "questions");
});

test("questions moved into the body because add_comment was refused are refused, and say so", () => {
  const shapes = [
    [draftUpdate(DRAFT_BODY, "replace"), draftUpdate(BODY_QUESTIONS, "append")],
    [draftUpdate(DRAFT_BODY, "replace"), draftUpdate(`${DRAFT_BODY}\n\n${BODY_QUESTIONS}`, "replace"), { type: "report_incomplete", reason: "add_comment was refused" }],
    [draftUpdate(DRAFT_BODY), draftUpdate(`${DRAFT_BODY}\n\n${BODY_QUESTIONS}`, "replace"), { type: "noop", message: "questions are in the body" }],
  ];
  for (const items of shapes) {
    const { outcome: result, reason } = run(items);
    assert.equal(result, "invalid");
    assert.match(reason, /questions were written into the issue body, not posted with add_comment on #42/);
  }
  assert.match(run(shapes[1]).reason, /the agent reported the run incomplete/);
});

test("an appended body would replace the story with the fragment, so it is refused even with its questions", () => {
  const { outcome: result, reason } = run([draftUpdate(DRAFT_BODY, "replace"), draftUpdate("More text.", "append"), comment(QUESTIONS)]);
  assert.equal(result, "invalid");
  assert.match(reason, /^item 2: update_issue with operation append/);
});

test("an update_issue aimed at another issue by issue_number is refused", () => {
  const { outcome: result, reason } = run([{ type: "update_issue", issue_number: 7, body: "## Story\nDone." }, comment(`${MARKER}\n${PREFIX}\nRefinement complete.`)]);
  assert.equal(result, "invalid");
  assert.match(reason, /^item 1: not aimed at #42/);
});

test("a valid outcome writes no reason", () => {
  assert.deepEqual(run([update("## Story\nDone."), comment(`${MARKER}\n${PREFIX}\nRefinement complete.`)]), { outcome: "complete", reason: "" });
});
