import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("../../loops/actions/validate-refine-output/validate-refine-output.sh", import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "refine-outcome-"));
const MARKER = "<!-- agent-refine -->";
const PREFIX = "Refinement update";
const DRAFT = "<!-- agent-refine-draft -->";
const QUESTIONS = `${MARKER}\n${PREFIX}\nI have some questions about this issue. Please reply in one comment and I'll process your answers.\n1. Which margin? **Proposed:** gross.`;

const outcome = (items) => {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ items }));
  return execFileSync("bash", [script.pathname.replace(/^\/([A-Za-z]:)/, "$1"), file, MARKER, PREFIX, "42", DRAFT], { encoding: "utf8" }).trim();
};
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
