import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorshipProblem, bumpLevel, createClient, decide, highestBump, NO_CHECKS_GRACE_MINUTES, parseUpdates,
  readConfig, ReadDenied, rebaseAlreadyRequested, renderSummary, run, scopeAllows, summarizeChecks,
} from "../../loops/actions/merge-dependabot/merge-dependabot.mjs";

const REPO = "acme/app";
const NOW = Date.parse("2026-11-04T12:00:00Z");
const HEAD_DATE = "2026-11-04T09:00:00Z";

const commit = (overrides = {}) => ({
  sha: "a".repeat(40),
  author: { login: "dependabot[bot]" },
  committer: { login: "web-flow" },
  commit: { committer: { date: HEAD_DATE }, verification: { verified: true } },
  ...overrides,
});

const pullRequest = (overrides = {}) => ({
  number: 66,
  node_id: "PR_1",
  title: "chore(deps): Bump next from 15.5.23 to 15.5.28",
  body: "Bumps [next](https://github.com/vercel/next.js) from 15.5.23 to 15.5.28.\n<details>\n<summary>Release notes</summary>\nUpgrade from 14.0.0 to 16.0.0 first.\n</details>",
  draft: false,
  user: { login: "dependabot[bot]" },
  base: { ref: "main" },
  head: { ref: "dependabot/npm_and_yarn/next-15.5.28", sha: "b".repeat(40), repo: { full_name: REPO } },
  labels: [],
  mergeable: true,
  mergeable_state: "clean",
  updated_at: HEAD_DATE,
  ...overrides,
});

const green = { state: "success", failing: [], pending: [] };

const decideFor = (overrides = {}) => decide({
  pr: pullRequest(), commits: [commit()], defaultBranch: "main", repository: REPO,
  skipLabels: ["do-not-merge", "blocked", "human-review", "hold"], scope: "all", checks: green,
  comments: [], mergeWithoutChecks: true, now: NOW, ...overrides,
});

test("authorship: only Dependabot's pull request, branch and verified commits pass", () => {
  assert.equal(authorshipProblem(pullRequest(), [commit()], REPO), null);
  assert.equal(authorshipProblem(pullRequest({ user: { login: "app/dependabot" } }), [commit()], REPO), null);
  // GitHub reports the head repository in its own case, which need not match the workflow's.
  assert.equal(authorshipProblem(pullRequest({ head: { ref: "dependabot/x", sha: "b", repo: { full_name: "Acme/App" } } }), [commit()], REPO), null);
  assert.match(authorshipProblem(pullRequest({ user: { login: "mallory" } }), [commit()], REPO), /opened by mallory/);
  assert.match(authorshipProblem(pullRequest(), [commit(), commit({ author: { login: "mallory" } })], REPO), /is by mallory/);
  assert.match(authorshipProblem(pullRequest(), [commit({ committer: { login: "mallory" } })], REPO), /committed by mallory/);
  // An author email can be forged; GitHub's signature cannot.
  assert.match(authorshipProblem(pullRequest(), [commit({ commit: { verification: { verified: false } } })], REPO), /not verified/);
  assert.match(authorshipProblem(pullRequest({ head: { ref: "dependabot/x", sha: "b", repo: { full_name: "fork/app" } } }), [commit()], REPO), /another repository/);
  assert.match(authorshipProblem(pullRequest({ head: { ref: "feature/x", sha: "b", repo: { full_name: REPO } } }), [commit()], REPO), /not a Dependabot branch/);
  assert.match(authorshipProblem(pullRequest(), [], REPO), /no commits/);
  assert.match(authorshipProblem(pullRequest(), Array.from({ length: 250 }, () => commit()), REPO), /too many commits/);
});

test("parseUpdates reads the title, the Bumps and Updates lines and the From/To table, never the release notes", () => {
  assert.deepEqual(parseUpdates(pullRequest().title, pullRequest().body), [{ name: "next", from: "15.5.23", to: "15.5.28" }]);
  assert.deepEqual(parseUpdates("build(deps): bump undici in /.opencode", "Bumps  and [undici](https://x). Together.\nUpdates `undici` from 8.12.1 to 8.12.3\n<details>\nUpdates `undici` from 1.0.0 to 9.0.0\n</details>"),
    [{ name: "undici", from: "8.12.1", to: "8.12.3" }]);
  const grouped = parseUpdates(
    "chore(deps): bump the npm-minor-patch group across 1 directory with 2 updates",
    "Bumps the npm-minor-patch group with 2 updates in the / directory:\n| Package | From | To |\n| --- | --- | --- |\n| [lint-staged](https://x) | `17.2.0` | `17.6.0` |\n| [react](https://y) | `19.0.1` | `19.0.2` |\n\nNot a table row | `1.0.0` | `2.0.0` |",
  );
  assert.deepEqual(grouped.map((update) => update.name), ["lint-staged", "react"]);
  assert.deepEqual(parseUpdates("ci(deps): bump actions/checkout from v4 to v5 in the actions group", ""), [{ name: "actions/checkout", from: "v4", to: "v5" }]);
  assert.deepEqual(parseUpdates("Bump the nuget group with 2 updates", "Updated [coverlet.collector](https://x) from 10.0.1 to 10.1.0.\n- Updated `Other` dependency to `8.0.32`."),
    [{ name: "coverlet.collector", from: "10.0.1", to: "10.1.0" }]);
  assert.deepEqual(parseUpdates("Bump the nuget group with 5 updates", "Release notes only"), []);
});

test("bump levels, with a group counted as its highest bump and the unreadable as above major", () => {
  assert.equal(bumpLevel("15.5.23", "15.5.28"), "patch");
  assert.equal(bumpLevel("17.2.0", "17.6.0"), "minor");
  assert.equal(bumpLevel("3.2.7", "4.1.11"), "major");
  assert.equal(bumpLevel("v4", "v5"), "major");
  assert.equal(bumpLevel("10.8.4-preview.3", "10.8.4-preview.4"), "patch");
  assert.equal(bumpLevel("abc1234", "def5678"), "unknown");
  assert.equal(highestBump([{ from: "1.0.0", to: "1.0.1" }, { from: "2.0.0", to: "2.1.0" }]), "minor");
  assert.equal(highestBump([{ from: "1.0.0", to: "1.0.1" }, { from: "abc", to: "def" }]), "unknown");
  assert.equal(highestBump([]), "unknown");
});

test("scope: all takes everything, minor and patch take what they name, off takes nothing", () => {
  assert.deepEqual(["patch", "minor", "major", "unknown"].map((bump) => scopeAllows("all", bump)), [true, true, true, true]);
  assert.deepEqual(["patch", "minor", "major", "unknown"].map((bump) => scopeAllows("minor", bump)), [true, true, false, false]);
  assert.deepEqual(["patch", "minor", "major", "unknown"].map((bump) => scopeAllows("patch", bump)), [true, false, false, false]);
  assert.equal(scopeAllows("off", "patch"), false);
  assert.equal(decideFor({ pr: pullRequest({ title: "Bump vitest from 3.2.7 to 4.1.11", body: "" }), scope: "minor" }).action, "skip");
  assert.equal(decideFor({ scope: "patch" }).action, "merge");
});

test("checks: green, pending, failing, none, a rerun and a required check that never reported", () => {
  const run = (id, name, status, conclusion) => ({ id, name, status, conclusion });
  assert.equal(summarizeChecks({ checkRuns: [run(1, "build", "completed", "success"), run(2, "lint", "completed", "skipped")] }).state, "success");
  assert.equal(summarizeChecks({ checkRuns: [run(1, "build", "in_progress", null)] }).state, "pending");
  assert.deepEqual(summarizeChecks({ checkRuns: [run(1, "build", "completed", "failure")] }).failing, ["build (failure)"]);
  assert.equal(summarizeChecks({}).state, "none");
  // The latest run of a name stands: a cancelled run superseded by a green one is green.
  assert.equal(summarizeChecks({ checkRuns: [run(1, "build", "completed", "cancelled"), run(2, "build", "completed", "success")] }).state, "success");
  assert.equal(summarizeChecks({ statuses: [{ context: "ci/legacy", state: "error" }] }).state, "failure");
  assert.equal(summarizeChecks({ statuses: [{ context: "ci/legacy", state: "pending" }] }).state, "pending");
  assert.deepEqual(summarizeChecks({ checkRuns: [run(1, "build", "completed", "success")], required: ["e2e"] }).pending, ["e2e (required, not reported)"]);
});

test("decide merges green, waits on pending, leaves failing, and merges a repository with no checks once settled", () => {
  assert.deepEqual(decideFor(), { action: "merge", reason: "checks green", bump: "patch" });
  assert.equal(decideFor({ checks: { state: "pending", failing: [], pending: ["build"] } }).action, "wait");
  assert.deepEqual(decideFor({ checks: { state: "failure", failing: ["build (failure)"], pending: [] } }), { action: "fail", reason: "failing: build (failure)", bump: "patch" });
  const none = { state: "none", failing: [], pending: [] };
  assert.equal(decideFor({ checks: none }).action, "merge");
  assert.equal(decideFor({ checks: none, mergeWithoutChecks: false }).action, "skip");
  const fresh = NOW - (NO_CHECKS_GRACE_MINUTES - 5) * 60000;
  assert.equal(decideFor({ checks: none, commits: [commit({ commit: { committer: { date: new Date(fresh).toISOString() }, verification: { verified: true } } })] }).action, "wait");
});

test("decide skips drafts, other bases, held labels and anything not wholly Dependabot's", () => {
  assert.equal(decideFor({ pr: pullRequest({ draft: true }) }).reason, "draft");
  assert.match(decideFor({ pr: pullRequest({ base: { ref: "release" } }) }).reason, /targets release/);
  for (const name of ["do-not-merge", "blocked", "human-review", "hold"]) {
    assert.equal(decideFor({ pr: pullRequest({ labels: [{ name }, { name: "dependencies" }] }) }).reason, `labelled ${name}`);
  }
  assert.equal(decideFor({ pr: pullRequest({ labels: [{ name: "dependencies" }] }) }).action, "merge");
  assert.equal(decideFor({ commits: [commit(), commit({ author: { login: "octocat" } })] }).action, "skip");
});

test("behind or conflicting asks for a rebase once per head commit", () => {
  assert.equal(decideFor({ pr: pullRequest({ mergeable_state: "behind" }) }).action, "rebase");
  assert.equal(decideFor({ pr: pullRequest({ mergeable: false, mergeable_state: "dirty" }) }).action, "rebase");
  const asked = [{ body: "@dependabot rebase", created_at: "2026-11-04T10:00:00Z" }];
  assert.equal(decideFor({ pr: pullRequest({ mergeable_state: "behind" }), comments: asked }).action, "wait");
  assert.equal(rebaseAlreadyRequested(asked, HEAD_DATE), true);
  // A rebase Dependabot already did moved the head past the old request, so it can be asked again.
  assert.equal(rebaseAlreadyRequested(asked, "2026-11-04T11:00:00Z"), false);
  assert.equal(rebaseAlreadyRequested([{ body: "please @dependabot rebase", created_at: "2026-11-04T10:00:00Z" }], HEAD_DATE), false);
  assert.equal(decideFor({ pr: pullRequest({ mergeable: null, mergeable_state: "unknown" }) }).action, "wait");
});

test("readConfig validates the scope and reads the switches", () => {
  assert.deepEqual(readConfig({}), { scope: "all", maxMerges: 5, mergeWithoutChecks: true, skipLabels: [], dryRun: false, postMergeEvent: "" });
  assert.equal(readConfig({ SCOPE: " Minor " }).scope, "minor");
  assert.equal(readConfig({ MERGE_WITHOUT_CHECKS: "false" }).mergeWithoutChecks, false);
  assert.deepEqual(readConfig({ SKIP_LABELS: "hold  blocked" }).skipLabels, ["hold", "blocked"]);
  assert.throws(() => readConfig({ SCOPE: "major" }), /DEPENDABOT_MERGE must be one of/);
  assert.throws(() => readConfig({ MAX_MERGES: "-1" }), /whole number/);
});

// A fake GitHub: answers by method and path, records every write.
function fakeGitHub({ pulls, commits = {}, comments = {}, checkRuns = {}, mergeStatus = 200, token = "t", forbid = null }) {
  const writes = [];
  const reads = [];
  const routes = [
    [/^GET \/repos\/acme\/app$/, () => ({ default_branch: "main" })],
    [/^GET \/repos\/acme\/app\/pulls\?/, () => pulls],
    [/^GET \/repos\/acme\/app\/pulls\/(\d+)$/, (n) => pulls.find((pr) => pr.number === Number(n))],
    [/^GET \/repos\/acme\/app\/pulls\/(\d+)\/commits/, (n) => commits[n] ?? [commit()]],
    [/^GET \/repos\/acme\/app\/issues\/(\d+)\/comments/, (n) => comments[n] ?? []],
    [/^GET \/repos\/acme\/app\/rules\/branches\/main$/, () => []],
    [/^GET \/repos\/acme\/app\/branches\/main$/, () => ({ protection: { required_status_checks: { contexts: [] } } })],
    [/^GET \/repos\/acme\/app\/commits\/(\w+)\/check-runs/, (sha) => ({ check_runs: checkRuns[sha] ?? [] })],
    [/^GET \/repos\/acme\/app\/commits\/\w+\/status/, () => ({ statuses: [] })],
  ];
  const fetchImpl = async (url, init) => {
    const path = url.replace("https://api.github.com", "");
    const key = `${init.method} ${path}`;
    let status = 200;
    let data = null;
    if (init.method === "GET") {
      reads.push(key);
      const route = routes.find(([pattern]) => pattern.test(key));
      if (!route) throw new Error(`unexpected ${key}`);
      if (forbid?.test(key)) { status = 403; data = { message: "Resource not accessible by integration" }; }
      else data = route[1](...key.match(route[0]).slice(1));
    } else {
      writes.push({ key, body: JSON.parse(init.body ?? "null") });
      if (/\/merge$/.test(path)) { status = mergeStatus; data = status === 200 ? { sha: "c".repeat(40) } : { message: "Pull Request is not mergeable" }; }
    }
    return { status, headers: new Map([["x-ratelimit-remaining", "4000"]]), text: async () => JSON.stringify(data) };
  };
  return { client: createClient({ token, fetchImpl }), writes, reads };
}

const config = (overrides = {}) => ({ ...readConfig({ SKIP_LABELS: "do-not-merge blocked human-review hold", POST_MERGE_EVENT: "agentic-post-merge" }), ...overrides });
const silent = () => undefined;
const greenRun = (sha) => ({ [sha]: [{ id: 1, name: "build", status: "completed", conclusion: "success" }] });

test("run merges a green Dependabot pull request by squash at its head, deletes the branch and dispatches", async () => {
  const pr = pullRequest();
  const human = pullRequest({ number: 7, user: { login: "octocat" } });
  const { client, writes } = fakeGitHub({ pulls: [human, pr], checkRuns: greenRun(pr.head.sha) });
  const result = await run({ client, repository: REPO, config: config(), now: NOW, log: silent });
  assert.deepEqual(result.rows.map((row) => [row.number, row.action]), [[66, "merged"]]);
  assert.deepEqual(writes.map((write) => write.key), [
    "PUT /repos/acme/app/pulls/66/merge",
    "DELETE /repos/acme/app/git/refs/heads/dependabot/npm_and_yarn/next-15.5.28",
    "POST /repos/acme/app/dispatches",
  ]);
  assert.deepEqual(writes[0].body, { merge_method: "squash", sha: pr.head.sha });
  assert.match(renderSummary(result, config()), /\| #66 \| chore\(deps\): Bump next from 15\.5\.23 to 15\.5\.28 \| patch \| merged \|/);
});

test("run approves a blocked pull request first, and reports a refused merge without failing the job", async () => {
  const pr = pullRequest({ mergeable_state: "blocked" });
  const { client, writes } = fakeGitHub({ pulls: [pr], checkRuns: greenRun(pr.head.sha), mergeStatus: 405 });
  const result = await run({ client, repository: REPO, config: config(), now: NOW, log: silent });
  assert.equal(writes[0].key, "POST /repos/acme/app/pulls/66/reviews");
  assert.equal(writes[0].body.event, "APPROVE");
  assert.equal(result.rows[0].action, "blocked");
});

test("run comments the rebase command once, honours dry-run, the merge limit and off", async () => {
  const behind = pullRequest({ number: 1, mergeable_state: "behind" });
  const first = fakeGitHub({ pulls: [behind] });
  await run({ client: first.client, repository: REPO, config: config(), now: NOW, log: silent });
  assert.deepEqual(first.writes, [{ key: "POST /repos/acme/app/issues/1/comments", body: { body: "@dependabot rebase" } }]);

  const again = fakeGitHub({ pulls: [behind], comments: { 1: [{ body: "@dependabot rebase", created_at: "2026-11-04T10:00:00Z" }] } });
  await run({ client: again.client, repository: REPO, config: config(), now: NOW, log: silent });
  assert.deepEqual(again.writes, []);

  const two = [pullRequest({ number: 2 }), pullRequest({ number: 3 })];
  const limited = fakeGitHub({ pulls: two, checkRuns: greenRun(two[0].head.sha) });
  const limitedResult = await run({ client: limited.client, repository: REPO, config: config({ maxMerges: 1 }), now: NOW, log: silent });
  assert.deepEqual(limitedResult.rows.map((row) => row.action), ["merged", "wait"]);

  const dry = fakeGitHub({ pulls: [pullRequest(), behind], checkRuns: greenRun(pullRequest().head.sha) });
  const dryResult = await run({ client: dry.client, repository: REPO, config: config({ dryRun: true }), now: NOW, log: silent });
  assert.deepEqual(dryResult.rows.map((row) => row.action), ["would merge", "would ask rebase"]);
  assert.deepEqual(dry.writes, []);

  const off = await run({ client: dry.client, repository: REPO, config: config({ scope: "off" }), now: NOW, log: silent });
  assert.deepEqual(off, { rows: [], off: true });
  assert.match(renderSummary(off, config({ scope: "off" })), /DEPENDABOT_MERGE is off/);
});

test("run reads with the read token and writes with the App token", async () => {
  const pr = pullRequest({ mergeable_state: "blocked" });
  const app = fakeGitHub({ pulls: [pr], token: "app", forbid: /./ });
  const workflow = fakeGitHub({ pulls: [pr], token: "workflow", checkRuns: greenRun(pr.head.sha) });
  const result = await run({ client: app.client, reader: workflow.client, repository: REPO, config: config(), now: NOW, log: silent });
  assert.equal(result.rows[0].action, "merged");
  assert.deepEqual(app.reads, []);
  assert.deepEqual(workflow.writes, []);
  assert.ok(workflow.reads.some((key) => /\/check-runs/.test(key)));
  assert.deepEqual(app.writes.map((write) => write.key.split(" ")[0]), ["POST", "PUT", "DELETE", "POST"]);
});

test("a refused read skips that pull request with a warning and the run goes on", async () => {
  const first = pullRequest({ number: 1 });
  const second = pullRequest({ number: 2, head: { ...pullRequest().head, sha: "d".repeat(40) } });
  const { client, writes } = fakeGitHub({ pulls: [first, second], checkRuns: greenRun(second.head.sha), forbid: /\/commits\/b+\/check-runs/ });
  const logged = [];
  const result = await run({ client, repository: REPO, config: config(), now: NOW, log: (line) => logged.push(line) });
  const denied = "cannot read checks: grant Checks: read to the App or the workflow token";
  assert.deepEqual(result.rows.map((row) => [row.number, row.action]), [[1, "skip"], [2, "merged"]]);
  assert.equal(result.rows[0].reason, denied);
  assert.deepEqual(result.denied, [denied]);
  assert.ok(logged.includes(`::warning::#1 skipped: ${denied}`));
  assert.equal(writes[0].key, "PUT /repos/acme/app/pulls/2/merge");
  assert.ok(renderSummary(result, config()).includes(`> ${denied}.`));

  const statuses = fakeGitHub({ pulls: [first], checkRuns: greenRun(first.head.sha), forbid: /\/status\?/ });
  const statusResult = await run({ client: statuses.client, repository: REPO, config: config(), now: NOW, log: silent });
  assert.match(statusResult.rows[0].reason, /grant Commit statuses: read/);
  assert.ok(new ReadDenied("checks", "Checks") instanceof Error);
});

test("a read failing for any reason but a 403 still fails the run", async () => {
  const pr = pullRequest();
  const { client } = fakeGitHub({ pulls: [pr] });
  const broken = { ...client, paginate: async (path) => {
    if (/check-runs/.test(path)) throw Object.assign(new Error("GET check-runs answered 502"), { status: 502 });
    return client.paginate(path);
  } };
  await assert.rejects(run({ client: broken, repository: REPO, config: config(), now: NOW, log: silent }), /answered 502/);
});
