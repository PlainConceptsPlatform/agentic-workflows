import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The audit's follow-up (issue #582, phase 3) ships as plain JavaScript inside loops/: the selection
// (scripts/audit-select.mjs, ESM) decides from the numbers, and the audit-follow-up action carries the
// decisions out. The pure helpers are loaded directly; the action's github-script body is run against
// an in-memory repository, so the test sees the comments, states, branches and pull requests a real
// run would leave. Every fixture is synthetic.
const loops = resolve(import.meta.dirname, "../../loops");
const requireCjs = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const lib: any = requireCjs(join(loops, "actions/audit-follow-up/audit-follow-up.cjs"));
const auditIssues: any = requireCjs(join(loops, "actions/file-audit-issues/audit-issues.cjs"));
const select: any = await import(pathToFileURL(join(loops, "templates/quality-gates/scripts/lib/audit-select.mjs")).href);
const qualityConfig: any = await import(pathToFileURL(join(loops, "templates/quality-gates/scripts/lib/quality-config.mjs")).href);

const DAY = 86400000;
const NOW = Date.parse("2026-11-23T01:00:00Z");

describe("audit-follow-up helpers", () => {
  it("respects a graduation pull request a person closed or merged for 90 days", () => {
    expect(lib.pullRequestDecision([], NOW)).toEqual({ open: true, reason: "none was opened before" });
    expect(lib.pullRequestDecision([{ number: 5, state: "open", closed_at: null }], NOW).open).toBe(false);
    const closed = { number: 6, state: "closed", merged_at: null, closed_at: new Date(NOW - 10 * DAY).toISOString() };
    const decision = lib.pullRequestDecision([closed], NOW);
    expect(decision.open).toBe(false);
    expect(decision.reason).toMatch(/#6 was closed without merging on 2026-11-13; not opened again before 2027-02-11/);
    const merged = { ...closed, merged_at: closed.closed_at };
    expect(lib.pullRequestDecision([merged], NOW).reason).toMatch(/was merged/);
    expect(lib.pullRequestDecision([{ ...closed, closed_at: new Date(NOW - 91 * DAY).toISOString() }], NOW).open).toBe(true);
    expect(lib.pullRequestDecision([{ ...closed, closed_at: new Date(NOW - 20 * DAY).toISOString() }], NOW, 14).open).toBe(true);
  });

  it("replaces one section of quality.config.json and keeps every other key", () => {
    const text = `${JSON.stringify({ coverage: { web: 0.6 }, deadCode: { mode: "report", since: "2026-11-01" } }, null, 2)}\n`;
    const next = JSON.parse(lib.applyPatch(text, "deadCode", { mode: "ratchet", since: "2026-11-01", baseline: { exports: 7 } }));
    expect(next).toEqual({ coverage: { web: 0.6 }, deadCode: { mode: "ratchet", since: "2026-11-01", baseline: { exports: 7 } } });
    expect(() => qualityConfig.parseQualityConfig(JSON.stringify(next))).not.toThrow();
    expect(JSON.parse(lib.applyPatch("", "bundle", { mode: "ratchet", baselineBytes: 1, limitBytes: 2 }))).toEqual({ bundle: { mode: "ratchet", baselineBytes: 1, limitBytes: 2 } });
    expect(() => lib.applyPatch("[]", "bundle", {})).toThrow(/JSON object/);
  });

  it("reads the hold label the router names, and falls back to hold", () => {
    expect(lib.holdLabelFrom('env:\n  TRUSTED_BOTS: "bot"\n  MERGE_TRAIN_HOLD_LABEL: "parked"\n')).toBe("parked");
    expect(lib.holdLabelFrom("env:\n  MERGE_TRAIN_HOLD_LABEL: frozen # a comment\n")).toBe("frozen");
    expect(lib.holdLabelFrom("")).toBe("hold");
  });

  it("parses the comments the selection writes, so nothing is said twice", () => {
    const comment = "Closed.\n\n<!-- audit-follow-up: close id=0123456789abcdef check=complexity before=186 after=24 target=30 metric=crap -->";
    expect(lib.followUpsIn(comment)).toEqual([{ verdict: "close", id: "0123456789abcdef", check: "complexity", before: "186", after: "24", target: "30", metric: "crap" }]);
    expect(lib.alreadySaid([{ body: comment }], "close", comment)).toBe(true);
    expect(lib.alreadySaid([{ body: comment }], "reopen", comment)).toBe(false);
    expect(lib.reopenedBefore([{ body: comment }])).toBe(false);
    expect(lib.reopenedBefore([{ body: comment.replace("close", "reopen") }])).toBe(true);
    // A story the audit closed is not confirmed again.
    expect(lib.alreadySaid([{ body: comment }], "verify", comment.replace("close id", "verify id"))).toBe(true);
    expect(lib.cleanupReopenedBefore([{ body: "x\n<!-- audit-graduation-reopen: deadCode -->" }], "deadCode")).toBe(true);
    expect(lib.cleanupReopenedBefore([{ body: "x\n<!-- audit-graduation-reopen: deadCode -->" }], "patterns")).toBe(false);
    expect(lib.hasGraduationMarker("<!-- audit-graduation: deadCode cleanup -->", "deadCode", true)).toBe(true);
    expect(lib.hasGraduationMarker("<!-- audit-graduation: deadCode cleanup -->", "deadCode", false)).toBe(false);
  });

  it("gives audit-close the before and after of every measured story", () => {
    const marker = "<!-- audit-item: 0123456789abcdef value=0.54 target=0.7 check=coverage -->";
    const lines = lib.beforeAfterLines([
      { number: 12, body: `Cover it.\n${marker}`, comments: [{ body: "<!-- audit-follow-up: verify id=0123456789abcdef check=coverage before=0.54 after=0.72 target=0.7 metric=rate -->" }] },
      { number: 13, body: "<!-- audit-item: 1111111111111111 value=186 target=30 check=complexity -->", comments: [] },
      { number: 14, body: "A judgement finding, no marker.", comments: [] },
      { number: 15, body: "<!-- audit-item: 2222222222222222 value=3 target=0 check=semgrep -->", comments: [{ body: "<!-- audit-follow-up: close id=2222222222222222 check=semgrep before=3 after=gone target=0 metric=count -->" }] },
    ]);
    expect(lines).toEqual([
      "- #12 coverage: 54% when filed, 72% after, target 70%",
      "- #13 complexity: 186 when filed, not measured since, target 30",
      "- #15 semgrep: 3 when filed, no longer listed (within its bar), target 0",
    ]);
  });

  it("reads the follow-up markers the selection actually writes", () => {
    const hotspot = (crap: number) => ({
      id: "x", check: "complexity", kind: "method", rule: "crap", path: "src/Pricing.cs", line: 10, symbol: "Pricing.Quote", value: crap, threshold: 30, baseline: null, mode: "ratchet", message: null,
      detail: { scope: "api", module: "Orders", cc: 18, coverage: 0.2 },
    });
    const worklist = (crap: number) => ({
      schemaVersion: 1, facet: "worklist", runId: 1, commitSha: "a".repeat(40), generatedAt: "2026-11-21T08:00:00.000Z",
      data: { limit: 20, unreadable: [], checks: { complexity: { mode: "ratchet", total: 1, truncated: false, sources: ["test"], items: [hotspot(crap)] } } },
    });
    const config = qualityConfig.parseQualityConfig("{}");
    const filed = select.selectAudit({ worklist: worklist(186), config, now: new Date(NOW), env: {} }).selected[0];
    const issue = { number: 51, title: "Split Pricing.Quote", state: "open", stateReason: null, closedAt: null, body: filed.marker, pulls: [{ number: 9, merged: true, mergedAt: "2026-11-20T00:00:00Z" }] };
    const now = select.selectAudit({ worklist: worklist(24), config, issues: [issue], now: new Date(NOW), env: {} });
    const [action] = now.followUp.actions;
    expect(action.action).toBe("close");
    expect(lib.beforeAfterLines([{ number: 51, body: filed.marker, comments: [{ body: action.comment }] }])).toEqual(["- #51 complexity: 186 when filed, 24 after, target 30"]);
  });
});

describe("file-audit-issues: the Since last audit section", () => {
  it("appends the selection's section to the report and drops any issue number", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-appendix-"));
    const file = join(dir, "audit-selection.json");
    writeFileSync(file, JSON.stringify({ sinceLastAudit: { markdown: "## Since last audit\n\nFixed 1, still open 0, regressed 0.\n\n- Fixed: **complexity** (\"Split #12\"): 186 when filed, 24 now, target 30" } }));
    const appendix = auditIssues.selectionAppendix(file);
    expect(appendix).toMatch(/^## Since last audit/);
    expect(appendix).not.toMatch(/#\d/);
    expect(auditIssues.selectionAppendix("")).toBe("");
    expect(auditIssues.selectionAppendix(join(dir, "missing.json"))).toBe("");
    const plan = auditIssues.planAuditIssues([{ title: "Audit: 2026-11-23", body: "### 1. A finding (CRAP 90, target 30)" }], { limits: { maxBodyChars: 6000, maxWorkUnits: 18 }, appendix });
    expect(plan.report.body).toMatch(/### 1\. A finding[\s\S]*## Since last audit[\s\S]*186 when filed, 24 now, target 30/);
  });
});

// ── The action, against an in-memory repository ──────────────────────────────────────────────────
interface Issue { number: number; title: string; body: string; state: string; state_reason?: string | null; labels: string[]; comments: string[]; pull_request?: unknown }
interface Pull { number: number; state: string; head: string; title: string; body: string; merged_at: string | null; closed_at: string | null; labels: string[]; draft?: boolean }

function fakeGitHub(seed: { issues?: Array<Partial<Issue> & { number: number }>; pulls?: Pull[]; config?: string | null } = {}) {
  const issues = new Map<number, Issue>();
  for (const i of seed.issues ?? []) issues.set(i.number, { title: "", body: "", state: "open", labels: [], comments: [], ...i });
  const pulls: Pull[] = [...(seed.pulls ?? [])];
  const refs = new Map<string, string>([["heads/main", "sha-main"]]);
  const files = new Map<string, string>();
  if (seed.config !== null) files.set("sha-main:quality.config.json", seed.config ?? JSON.stringify({ deadCode: { mode: "report", since: "2026-11-01" } }));
  const commits: Array<{ branch: string; message: string; content: string }> = [];
  let next = 900;
  const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
  const shaOf = (ref: string) => refs.get(`heads/${ref}`) ?? ref;

  const github = {
    paginate: async (fn: (params: any) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
    rest: {
      issues: {
        get: async ({ issue_number }: any) => {
          const issue = issues.get(issue_number);
          if (!issue) throw notFound();
          return { data: { ...issue } };
        },
        listComments: async ({ issue_number }: any) => ({ data: (issues.get(issue_number)?.comments ?? []).map((body) => ({ body })) }),
        createComment: async ({ issue_number, body }: any) => {
          const target = issues.get(issue_number) ?? pulls.find((p) => p.number === issue_number);
          (target as Issue).comments?.push(body);
          return { data: {} };
        },
        update: async ({ issue_number, state, state_reason }: any) => {
          Object.assign(issues.get(issue_number)!, { state, state_reason: state_reason ?? null });
          return { data: {} };
        },
        listForRepo: async () => ({ data: [...issues.values()].filter((i) => i.state === "open") }),
        create: async ({ title, body }: any) => {
          next += 1;
          issues.set(next, { number: next, title, body, state: "open", labels: [], comments: [] });
          return { data: { number: next } };
        },
        addLabels: async ({ issue_number, labels }: any) => {
          const target = issues.get(issue_number) ?? pulls.find((p) => p.number === issue_number)!;
          target.labels = [...new Set([...target.labels, ...labels])];
          return { data: {} };
        },
        createLabel: async () => { throw Object.assign(new Error("exists"), { status: 422 }); },
      },
      pulls: {
        list: async ({ head }: any) => ({ data: pulls.filter((p) => `acme:${p.head}` === head).map((p) => ({ ...p, labels: p.labels.map((name) => ({ name })) })) }),
        create: async ({ title, head, body, draft }: any) => {
          next += 1;
          const pr = { number: next, state: "open", head, title, body, draft, merged_at: null, closed_at: null, labels: [] };
          pulls.push(pr);
          return { data: { number: next } };
        },
      },
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getContent: async ({ path, ref }: any) => {
          const content = files.get(`${shaOf(ref)}:${path}`);
          if (content === undefined) throw notFound();
          return { data: { sha: `blob-${shaOf(ref)}`, content: Buffer.from(content).toString("base64") } };
        },
        createOrUpdateFileContents: async ({ path, branch, message, content }: any) => {
          const text = Buffer.from(content, "base64").toString("utf8");
          const sha = `sha-${branch}-${commits.length}`;
          files.set(`${sha}:${path}`, text);
          refs.set(`heads/${branch}`, sha);
          commits.push({ branch, message, content: text });
          return { data: {} };
        },
      },
      git: {
        getRef: async ({ ref }: any) => {
          if (!refs.has(ref)) throw notFound();
          return { data: { object: { sha: refs.get(ref) } } };
        },
        createRef: async ({ ref, sha }: any) => { refs.set(ref.replace(/^refs\//, ""), sha); return { data: {} }; },
        updateRef: async ({ ref, sha }: any) => { refs.set(ref, sha); return { data: {} }; },
      },
    },
  };
  return { github, issues, pulls, refs, commits };
}

const action = parse(readFileSync(join(loops, "actions/audit-follow-up/action.yml"), "utf8"));
const script: string = action.runs.steps[0].with.script;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;

async function followUp(repo: ReturnType<typeof fakeGitHub>, selection: unknown, router = 'env:\n  MERGE_TRAIN_HOLD_LABEL: "hold"\n') {
  const dir = mkdtempSync(join(tmpdir(), "audit-follow-up-"));
  writeFileSync(join(dir, "audit-selection.json"), JSON.stringify(selection));
  writeFileSync(join(dir, "work-router.yml"), router);
  const env = {
    FOLLOW_UP_LIB: join(loops, "actions/audit-follow-up/audit-follow-up.cjs"),
    SELECTION_FILE: join(dir, "audit-selection.json"),
    STORY_LABELS: "bug\nrefine",
    GRADUATION_LABELS: "quality-graduation",
    HOLD_LABEL: "",
    ROUTER_FILE: join(dir, "work-router.yml"),
    RESPECT_DAYS: "90",
  };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const outputs: Record<string, string> = {};
  const failures: string[] = [];
  const summary = { addHeading: () => summary, addList: () => summary, write: async () => undefined };
  const core = { info: () => undefined, warning: () => undefined, summary, setOutput: (k: string, v: string) => { outputs[k] = v; }, setFailed: (m: string) => { failures.push(m); } };
  try {
    await new AsyncFunction("github", "context", "core", "require", script)(repo.github, { repo: { owner: "acme", repo: "app" } }, core, requireCjs);
  } finally {
    process.env = saved;
  }
  return { outputs, failures };
}

const closeComment = "Closed by the audit.\n\n<!-- audit-follow-up: close id=0123456789abcdef check=complexity before=186 after=24 target=30 metric=crap -->";
const reopenComment = closeComment.replace(/close id/, "reopen id").replace("Closed", "Reopened");

describe("audit-follow-up action", () => {
  it("closes, confirms and reopens stories once, and never twice", async () => {
    const repo = fakeGitHub({
      issues: [
        { number: 51, state: "open" },
        { number: 52, state: "closed", state_reason: "completed" },
        { number: 53, state: "closed", state_reason: "completed", comments: [reopenComment] },
        { number: 54, state: "closed", state_reason: "completed" },
      ],
    });
    const selection = {
      followUp: {
        actions: [
          { issue: 51, action: "close", comment: closeComment },
          { issue: 52, action: "reopen", comment: reopenComment },
          { issue: 53, action: "reopen", comment: reopenComment },
          { issue: 54, action: "verify", comment: closeComment.replace("close id", "verify id") },
        ],
      },
    };
    const { failures, outputs } = await followUp(repo, selection);
    expect(failures).toEqual([]);
    expect(repo.issues.get(51)).toMatchObject({ state: "closed", state_reason: "completed", comments: [closeComment] });
    expect(repo.issues.get(52)).toMatchObject({ state: "open", comments: [reopenComment] });
    // Reopened once before: left closed, nothing said.
    expect(repo.issues.get(53)).toMatchObject({ state: "closed", comments: [reopenComment] });
    expect(repo.issues.get(54)!.comments).toHaveLength(1);
    expect(outputs.done).toBe("3");
    // A re-run says nothing twice.
    await followUp(repo, selection);
    expect(repo.issues.get(51)!.comments).toHaveLength(1);
    expect(repo.issues.get(54)!.comments).toHaveLength(1);
  });

  it("opens one graduation pull request with the hold label and the CI baseline, never merged", async () => {
    const repo = fakeGitHub();
    const selection = {
      graduation: {
        actions: [{ kind: "pull-request", check: "deadCode", title: "Quality gates: enforce dead code (Knip) as a ratchet", branch: "audit/graduate-dead-code", body: "Body\n\n<!-- audit-graduation: deadCode -->", patch: { mode: "ratchet", since: "2026-11-01", baseline: { exports: 7 } } }],
      },
    };
    const { failures } = await followUp(repo, selection, 'env:\n  MERGE_TRAIN_HOLD_LABEL: "parked"\n');
    expect(failures).toEqual([]);
    expect(repo.pulls).toHaveLength(1);
    const [pr] = repo.pulls;
    expect(pr).toMatchObject({ head: "audit/graduate-dead-code", title: "Quality gates: enforce dead code (Knip) as a ratchet", state: "open", draft: true });
    // The merge train skips a pull request with its hold label.
    expect(pr!.labels).toEqual(["parked", "quality-graduation"]);
    expect(repo.commits).toHaveLength(1);
    expect(JSON.parse(repo.commits[0]!.content)).toEqual({ deadCode: { mode: "ratchet", since: "2026-11-01", baseline: { exports: 7 } } });
    expect(repo.commits[0]!.message).toBe("chore(quality): enforce deadCode as a ratchet from CI's baseline");
    // Open already: a second run opens nothing, and puts back a hold label someone removed.
    pr!.labels = ["quality-graduation"];
    await followUp(repo, selection);
    expect(repo.pulls).toHaveLength(1);
    expect(pr!.labels).toEqual(["quality-graduation", "hold"]);
  });

  it("does not open a graduation pull request again within 90 days of a person closing one", async () => {
    const closedAt = new Date(Date.now() - 5 * DAY).toISOString();
    const repo = fakeGitHub({ pulls: [{ number: 40, state: "closed", head: "audit/graduate-dead-code", title: "t", body: "b", merged_at: null, closed_at: closedAt, labels: ["hold"] }] });
    repo.refs.set("heads/audit/graduate-dead-code", "sha-old");
    const selection = { graduation: { actions: [{ kind: "pull-request", check: "deadCode", title: "t", branch: "audit/graduate-dead-code", body: "b", patch: { mode: "ratchet", baseline: {} } }] } };
    const { failures } = await followUp(repo, selection);
    expect(failures).toEqual([]);
    expect(repo.pulls).toHaveLength(1);
    expect(repo.commits).toHaveLength(0);
    // Long ago: the leftover branch is reset to the default branch and a new pull request opens.
    repo.pulls[0]!.closed_at = new Date(Date.now() - 100 * DAY).toISOString();
    await followUp(repo, selection);
    expect(repo.pulls).toHaveLength(2);
    expect(repo.commits).toHaveLength(1);
  });

  it("files the clean-up story once, labelled for refine", async () => {
    const repo = fakeGitHub();
    const selection = { graduation: { actions: [{ kind: "cleanup-story", check: "deadCode", title: "Clear dependencies before dead code (Knip) becomes a ratchet", body: "Clear them.\n\n<!-- audit-graduation: deadCode cleanup -->" }] } };
    await followUp(repo, selection);
    await followUp(repo, selection);
    const filed = [...repo.issues.values()];
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ title: "Clear dependencies before dead code (Knip) becomes a ratchet", labels: ["bug", "refine"] });
    expect(repo.pulls).toHaveLength(0);
  });
});

describe("agent-audit wiring", () => {
  const worker = readFileSync(join(loops, "workflows/agent-audit.md"), "utf8");
  const front = parse(worker.split(/^---$/m)[1]!);

  it("runs the follow-up after select, with the App token, whether or not the agent runs", () => {
    const job = front.jobs.follow_up;
    expect(job.needs).toEqual(["select", "agent"]);
    expect(job.if).toBe("${{ !cancelled() && needs.select.outputs.follow_up == 'true' }}");
    const token = job.steps.find((s: { id?: string }) => s.id === "app-token");
    expect(token.with).toMatchObject({ "permission-issues": "write", "permission-contents": "write", "permission-pull-requests": "write" });
    const step = job.steps.find((s: { uses?: string }) => s.uses === "./.github/actions/audit-follow-up");
    expect(step.with.token).toBe("${{ steps.app-token.outputs.token }}");
    expect(front.jobs.select.outputs.follow_up).toBe("${{ steps.select.outputs.follow_up }}");
    expect(front.jobs.select.permissions).toMatchObject({ "pull-requests": "read" });
  });

  it("files only the slots open stories leave, and appends the Since last audit section", () => {
    const step = front.jobs.conclude.steps.find((s: { uses?: string }) => s.uses === "./.github/actions/file-audit-issues");
    expect(step.with["max-stories"]).toBe("${{ needs.select.outputs.story_slots || env.AUDIT_MAX_STORIES }}");
    expect(step.with["selection-file"]).toBe("${{ runner.temp }}/audit-selection/audit-selection.json");
    expect(front.jobs.conclude.needs).toContain("select");
  });
});

describe("audit-follow-up action: clean-up stories", () => {
  it("reopens a clean-up story once, never twice", async () => {
    const reopen = { kind: "cleanup-reopen", check: "deadCode", issue: 80, comment: "Reopened.\n\n<!-- audit-graduation-reopen: deadCode -->" };
    const repo = fakeGitHub({ issues: [{ number: 80, state: "closed" }] });
    await followUp(repo, { graduation: { actions: [reopen] } });
    expect(repo.issues.get(80)!.state).toBe("open");
    repo.issues.get(80)!.state = "closed";
    await followUp(repo, { graduation: { actions: [reopen] } });
    expect(repo.issues.get(80)!).toMatchObject({ state: "closed" });
    expect(repo.issues.get(80)!.comments).toHaveLength(1);
  });
});
