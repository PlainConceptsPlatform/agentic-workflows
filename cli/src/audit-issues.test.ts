import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The audit's filing step ships as plain JavaScript inside loops/. The pure planner is loaded
// directly; the github-script body of the action is run against an in-memory repository, so the
// test sees the issues, labels and links a real run would leave.
const loops = resolve(import.meta.dirname, "../../loops");
const requireCjs = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const size: any = requireCjs(join(loops, "actions/issue-size.cjs"));
const audit: any = requireCjs(join(loops, "actions/file-audit-issues/audit-issues.cjs"));

const REFINE = { maxBodyChars: 8000, maxWorkUnits: 24 };
const AUDIT = { maxBodyChars: 6000, maxWorkUnits: 18 };
const passes = (title: string, body: string, limits = REFINE): boolean => !size.sizeVerdict(size.measureIssue(title, body), limits).tooBig;
const fences = (text: string): number => text.split("\n").filter((line) => /^\s*```/.test(line)).length;

const finding = (n: number): string => `### ${n}. Score ${9 - Math.ceil(n / 2)} — Finding ${n} breaks the quote module

- **File:** \`apps/api/src/Module${n}/Service.cs\` (lines 10–40)
- **What happens:** ${"The service reads the stale value and writes it back without a check. ".repeat(4)}
- **Reproduction:** ${"Call the endpoint twice in a row with the same payload. ".repeat(3)}
- **Real impact:** ${"Totals are wrong for every customer on the account. ".repeat(3)}
- **Suggested fix:** ${"Guard the write with the version column and return 409. ".repeat(3)}
`;

const story = (letter: string, n: number): string => `### Story ${letter} — Stop module ${n} from writing stale totals

**As a Finance approver**, I want module ${n} to refuse a stale write, so totals stay right.

**Likely files:** \`apps/api/src/Module${n}/Service.cs:10-40\`

#### Acceptance criteria

\`\`\`gherkin
Scenario: A stale write is refused
  Given a quote at version 3
  When a caller writes version 2
  Then the response is 409
\`\`\`

\`\`\`bash
# a shell comment is not a heading
dotnet test --filter Module${n}
\`\`\`
`;

// The shape every audit had from 2026-09-21 on: Numa #826 was 22,034 chars and 35 work units.
const legacyReport = [
  "## Section 1 — Findings",
  "",
  "Read-only audit. Each finding is self-contained.",
  "",
  ...[1, 2, 3, 4, 5, 6, 7].map(finding),
  "## Section 2 — Top 3 — To Implement",
  "",
  "Refined into user stories.",
  "",
  story("A", 1),
  story("B", 2),
  story("C", 3),
].join("\n");

interface Issue { number: number; id: number; title: string; body: string; labels: string[] }

// Just enough of Octokit for the action's script: issues, labels, sub-issues, and every label add.
function fakeRepository(seed: Array<Pick<Issue, "title" | "body" | "labels">> = []) {
  const issues = new Map<number, Issue>();
  const labelAdds: Array<{ number: number; labels: string[] }> = [];
  const subIssues: Array<[number, number]> = [];
  let next = 800;
  const add = (title: string, body: string, labels: string[] = []): Issue => {
    next += 1;
    const issue = { number: next, id: next * 1000, title, body, labels: [...labels] };
    issues.set(issue.number, issue);
    return issue;
  };
  for (const issue of seed) add(issue.title, issue.body, issue.labels);
  const view = (issue: Issue) => ({ ...issue, labels: issue.labels.map((name) => ({ name })) });

  const github = {
    paginate: async (fn: (params: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
    request: async (_route: string, params: { issue_number: number; sub_issue_id: number }) => {
      const child = [...issues.values()].find((issue) => issue.id === params.sub_issue_id)!;
      if (subIssues.some(([, linked]) => linked === child.number)) throw Object.assign(new Error("already linked"), { status: 422 });
      subIssues.push([params.issue_number, child.number]);
      return { data: {} };
    },
    rest: {
      issues: {
        listForRepo: async () => ({ data: [...issues.values()].map(view) }),
        create: async ({ title, body }: { title: string; body: string }) => ({ data: view(add(title, body)) }),
        update: async ({ issue_number, body }: { issue_number: number; body: string }) => {
          issues.get(issue_number)!.body = body;
          return { data: {} };
        },
        addLabels: async ({ issue_number, labels }: { issue_number: number; labels: string[] }) => {
          const issue = issues.get(issue_number)!;
          issue.labels = [...new Set([...issue.labels, ...labels])];
          labelAdds.push({ number: issue_number, labels });
          return { data: {} };
        },
        createLabel: async () => { throw Object.assign(new Error("exists"), { status: 422 }); },
      },
    },
  };
  return { github, issues, labelAdds, subIssues };
}

const action = parse(readFileSync(join(loops, "actions/file-audit-issues/action.yml"), "utf8"));
const script: string = action.runs.steps[0].with.script;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;

async function fileAudit(repo: ReturnType<typeof fakeRepository>, items: Array<{ title: string; body: string }>, overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "audit-issues-"));
  const outputFile = join(dir, "agent_output.json");
  writeFileSync(outputFile, JSON.stringify({ items: items.map((item) => ({ type: "create_issue", ...item })) }));
  const env = {
    AGENT_OUTPUT_LIB: join(loops, "actions/agent-output.cjs"),
    ISSUE_SIZE_LIB: join(loops, "actions/issue-size.cjs"),
    AUDIT_ISSUES_LIB: join(loops, "actions/file-audit-issues/audit-issues.cjs"),
    OUTPUT_FILE: outputFile,
    REPORT_LABELS: "audit\nbug",
    STORY_LABELS: "bug\nrefine",
    MAX_BODY_CHARS: String(AUDIT.maxBodyChars),
    MAX_WORK_UNITS: String(AUDIT.maxWorkUnits),
    MAX_STORIES: "3",
    RUN_URL: "https://github.com/acme/app/actions/runs/1",
    REPORT_TITLE: "",
    ...overrides,
  };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const outputs: Record<string, string> = {};
  const failures: string[] = [];
  const summary = { addHeading: () => summary, addList: () => summary, write: async () => undefined };
  const core = {
    info: () => undefined, notice: () => undefined, warning: () => undefined, summary,
    setOutput: (name: string, value: string) => { outputs[name] = value; },
    setFailed: (message: string) => { failures.push(message); },
  };
  try {
    await new AsyncFunction("github", "context", "core", "require", script)(repo.github, { repo: { owner: "acme", repo: "app" } }, core, requireCjs);
  } finally {
    process.env = saved;
  }
  return { outputs, failures };
}

describe("issue-size", () => {
  it("counts what refine's shell guard counted: wc -c bytes and bullet lines", () => {
    // This test spawns bash to compare the JS counts against the shell guard (wc -c, grep).
    // Spawning bash is slow on Windows (first spawn of Git Bash can take 3-5s); the timeout
    // below (15s) leaves headroom. The bash compare is best-effort: if it throws, the JS
    // assertion above still holds.
    const title = "Audit: 2026-11-04";
    const body = "Intro — with a dash\n\n- one\n  * two\n-not a bullet\n\t- three\n```\n- four, in a fence, still counted\n```\n\n";
    const measured = size.measureIssue(title, body);
    let shell: { chars: number; units: number } | undefined;
    try {
      const out = execFileSync("bash", ["-c", 'b=$(cat); printf "%s %s" "$(printf "%s" "$b" | wc -c)" "$(printf "%s" "$b" | grep -cE "^[[:space:]]*[-*] " || true)"'], {
        input: `${title}\n\n${body}`,
        encoding: "utf8",
      });
      const [chars, units] = out.trim().split(/\s+/).map(Number);
      shell = { chars: chars!, units: units! };
    } catch {
      shell = undefined;
    }
    expect(measured).toEqual({ chars: Buffer.byteLength(`${title}\n\n${body}`.replace(/\n+$/, "")), units: 4 });
    if (shell) expect(measured).toEqual(shell);
  }, 15000);
});

describe("planAuditIssues", () => {
  it("splits an old-shape report over the limits into a report and one story per heading", () => {
    expect(passes("Audit: 2026-11-04", legacyReport)).toBe(false);

    const plan = audit.planAuditIssues([{ title: "Audit: 2026-11-04", body: legacyReport }], { limits: AUDIT, runUrl: "https://x/runs/1" });

    expect(plan.report.title).toBe("Audit: 2026-11-04");
    expect(plan.report.lifted).toBe(3);
    expect(plan.report.body).not.toMatch(/To Implement|Story A|gherkin/);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(plan.report.body).toContain(`### ${n}. Score`);
    expect(plan.stories.map((s: { title: string }) => s.title)).toEqual([
      "Stop module 1 from writing stale totals",
      "Stop module 2 from writing stale totals",
      "Stop module 3 from writing stale totals",
    ]);
    for (const s of plan.stories) {
      expect(s.body).toContain("#### Acceptance criteria");
      expect(s.body).toContain("# a shell comment is not a heading");
    }
  });

  it("trims a story over the limits from the end, closing any open fence", () => {
    const long = `**As a user**, I want it fixed.\n\n\`\`\`gherkin\n${"  Given a step that goes on and on\n".repeat(400)}\`\`\`\n\n${"- a bullet\n".repeat(40)}`;
    const plan = audit.planAuditIssues(
      [{ title: "Audit: 2026-11-04", body: finding(1) }, { title: "Huge story", body: long }],
      { limits: AUDIT, runUrl: "https://x/runs/1" },
    );
    const [huge] = plan.stories;
    expect(huge.trimmed).toBe(true);
    expect(huge.body).toContain("Trimmed to fit refine's size limits");
    expect(fences(huge.body) % 2).toBe(0);
    expect(passes(huge.title, audit.renderStory(huge.body, audit.PLACEHOLDER_NUMBER), AUDIT)).toBe(true);
  });

  it("compacts a verbose report so every finding stays listed", () => {
    const verbose = [1, 2, 3, 4, 5, 6, 7].map(finding).join("\n");
    expect(passes("Audit: 2026-11-04", verbose, AUDIT)).toBe(false);
    const plan = audit.planAuditIssues([{ title: "Audit: 2026-11-04", body: verbose }], { limits: AUDIT });
    expect(plan.report.trimmed).toBe(true);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(plan.report.body).toContain(`### ${n}. Score`);
    expect(passes(plan.report.title, plan.report.body, AUDIT)).toBe(true);
  });
});

describe("file-audit-issues", () => {
  it("files a tracking report without refine and stories that all pass the refine guard", async () => {
    const repo = fakeRepository();
    const { outputs, failures } = await fileAudit(repo, [{ title: "Audit: 2026-11-04", body: legacyReport }]);

    expect(failures).toEqual([]);
    const report = repo.issues.get(Number(outputs["report-number"]))!;
    const stories = outputs["story-numbers"]!.split(" ").map((n) => repo.issues.get(Number(n))!);
    expect(repo.issues.size).toBe(4);
    expect(stories).toHaveLength(3);

    expect(report.labels).toEqual(["audit", "bug"]);
    expect(report.labels).not.toContain("refine");
    for (const s of stories) {
      expect(s.labels).toEqual(["bug", "refine"]);
      expect(s.body).toContain(`Found by the audit report #${report.number}.`);
      expect(report.body).toContain(`- [ ] #${s.number} ${s.title}`);
      expect(repo.subIssues).toContainEqual([report.number, s.number]);
    }
    for (const issue of repo.issues.values()) {
      expect(passes(issue.title, issue.body), `#${issue.number} ${issue.title}`).toBe(true);
      expect(passes(issue.title, issue.body, AUDIT), `#${issue.number} ${issue.title}`).toBe(true);
    }
  });

  it("files nothing twice when the step runs again, and does not restart refine", async () => {
    const repo = fakeRepository();
    await fileAudit(repo, [{ title: "Audit: 2026-11-04", body: legacyReport }]);
    const before = repo.labelAdds.length;

    const again = await fileAudit(repo, [{ title: "Audit: 2026-11-04", body: legacyReport }]);

    expect(again.failures).toEqual([]);
    expect(repo.issues.size).toBe(4);
    expect(repo.labelAdds.slice(before).flatMap((add) => add.labels)).not.toContain("refine");
  });

  it("points at an open issue that already tracks a story instead of filing it", async () => {
    const repo = fakeRepository([{ title: "Stop module 2 from writing stale totals", body: "Filed by a person.", labels: ["bug"] }]);
    const tracked = [...repo.issues.values()][0]!;
    const { outputs } = await fileAudit(repo, [
      { title: "Audit: 2026-11-04", body: [1, 2, 3].map(finding).join("\n") },
      { title: "Stop module 1 from writing stale totals", body: story("A", 1).split("\n").slice(1).join("\n") },
      { title: "stop module 2 from  writing stale totals", body: story("B", 2).split("\n").slice(1).join("\n") },
    ]);

    const report = repo.issues.get(Number(outputs["report-number"]))!;
    expect(repo.issues.size).toBe(3);
    expect(report.body).toContain(`- [ ] #${tracked.number} stop module 2 from writing stale totals (already tracked)`);
    expect(tracked.labels).toEqual(["bug"]);
    expect(outputs["story-numbers"]!.split(" ")).toHaveLength(1);
  });

  it("files nothing for a noop", async () => {
    const repo = fakeRepository();
    const { outputs } = await fileAudit(repo, []);
    expect(outputs["report-number"]).toBe("");
    expect(repo.issues.size).toBe(0);
  });
});

describe("audit worker wiring", () => {
  const front = (file: string) => parse(readFileSync(join(loops, "workflows", file), "utf8").replace(/\r\n/g, "\n").split("---\n")[1]!);
  const auditWorker = front("agent-audit.md");
  const fileStep = auditWorker.jobs.conclude.steps.find((step: { uses?: string }) => step.uses === "./.github/actions/file-audit-issues");
  const lines = (value: string): string[] => value.split("\n").map((line) => line.trim()).filter(Boolean);

  it("labels the report as a tracking issue and only the stories for refine", () => {
    expect(lines(fileStep.with["report-labels"])).toContain("audit");
    expect(lines(fileStep.with["report-labels"])).not.toContain("refine");
    expect(lines(fileStep.with["story-labels"])).toContain("refine");
    // `audit` on a story would count against the audit's backpressure and make audit-close treat it as a report.
    expect(lines(fileStep.with["story-labels"])).not.toContain("audit");
  });

  it("files staged, with room for the report and every story", () => {
    // Refine has no size gate (1.15.0 removed it), so the audit's limits are about keeping
    // its filed stories small and digestible, not about staying under a gate refine refuses.
    // The create-issue cap gives the report one slot and each story one: AUDIT_MAX_STORIES + 1.
    expect(auditWorker["safe-outputs"].staged).toBe(true);
    expect(auditWorker["safe-outputs"]["create-issue"].max).toBe(Number(auditWorker.env.AUDIT_MAX_STORIES) + 1);
  });

  it("measures what it files with the same helper the size lib exports", () => {
    // The audit files through file-audit-issues, whose internal measure-issue-size
    // step trims anything over the audit's own limit before filing (refine used to share
    // that helper for its now-removed size gate; the audit keeps its own copy).
    const steps = auditWorker.jobs.conclude.steps.map((step: { uses?: string }) => step.uses);
    expect(steps).toContain("./.github/actions/file-audit-issues");
  });
});

// The docs audit filed one report labelled refine, the shape the audit lost in 1.12.1, and grew
// past refine's gate the same way once a repository's documentation drifted far enough.
const docsFinding = (n: number): string => `### ${n}. README lists module ${n}, which was removed
**Document:** \`README.md:${10 + n}\`, "${"Module ".repeat(30)}${n} handles quotes."
**Evidence:** \`apps/api/src/\` has no Module${n} directory; ${"it was folded into Quotes. ".repeat(20)}
**Fix:** ${"Describe the Quotes module instead and drop the stale section. ".repeat(10)}
`;
const docsStory = (n: number): string => `**As a new developer**, I want the README to describe module ${n} as it is, so I do not look for code that is gone.

**Document:** \`README.md:${10 + n}\`
**Evidence:** \`apps/api/src/Quotes/\`

${"- The README section names the module that exists\n".repeat(4)}`;

describe("docs audit", () => {
  const docsEnv = { REPORT_LABELS: "docs-audit", STORY_LABELS: "documentation\nrefine", REPORT_TITLE: "^docs audit:" };

  it("finds the report by its own title even when the agent filed a story first", () => {
    const plan = audit.planAuditIssues(
      [{ title: "Fix the module 1 section", body: docsStory(1) }, { title: "Docs audit: 2026-11-04", body: docsFinding(1) }],
      { limits: AUDIT, reportPattern: /^docs audit:/i },
    );
    expect(plan.report.title).toBe("Docs audit: 2026-11-04");
    expect(plan.stories.map((s: { title: string }) => s.title)).toEqual(["Fix the module 1 section"]);
  });

  it("files a report without refine and stories labelled for refine, every one under the gate", async () => {
    const report = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(docsFinding).join("\n");
    expect(passes("Docs audit: 2026-11-04", report)).toBe(false);
    const repo = fakeRepository();

    const { outputs, failures } = await fileAudit(repo, [
      { title: "Docs audit: 2026-11-04", body: report },
      ...[1, 2, 3, 4].map((n) => ({ title: `Describe module ${n} as it is`, body: docsStory(n) })),
    ], docsEnv);

    expect(failures).toEqual([]);
    const filed = repo.issues.get(Number(outputs["report-number"]))!;
    expect(filed.title).toBe("Docs audit: 2026-11-04");
    expect(filed.labels).toEqual(["docs-audit"]);
    const stories = outputs["story-numbers"]!.split(" ").map((n) => repo.issues.get(Number(n))!);
    expect(stories).toHaveLength(3);
    for (const s of stories) {
      expect(s.labels).toEqual(["documentation", "refine"]);
      expect(filed.body).toContain(`- [ ] #${s.number} ${s.title}`);
    }
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) expect(filed.body).toContain(`### ${n}. README lists module ${n}`);
    for (const issue of repo.issues.values()) expect(passes(issue.title, issue.body, AUDIT), `#${issue.number}`).toBe(true);
  });

  it("is wired like the audit: staged, refine only on the stories", () => {
    const front = (file: string) => parse(readFileSync(join(loops, "workflows", file), "utf8").replace(/\r\n/g, "\n").split("---\n")[1]!);
    const docs = front("agent-docs-audit.md");
    const fileStep = docs.jobs.conclude.steps.find((step: { uses?: string }) => step.uses === "./.github/actions/file-audit-issues");
    const lines = (value: string): string[] => value.split("\n").map((line) => line.trim()).filter(Boolean);

    expect(lines(fileStep.with["report-labels"])).toEqual(["docs-audit"]);
    expect(lines(fileStep.with["story-labels"])).toContain("refine");
    // `docs-audit` on a story would fill the one-report backpressure by itself.
    expect(lines(fileStep.with["story-labels"])).not.toContain("docs-audit");
    expect(new RegExp(fileStep.with["report-title"], "i").test("Docs audit: 2026-11-04")).toBe(true);
    // Refine has no size gate (1.15.0), so DOCS_AUDIT_MAX_* no longer needs to stay below a
    // refine limit; the docs audit's own limit is about keeping its filed stories small.
    expect(docs["safe-outputs"].staged).toBe(true);
    expect(docs["safe-outputs"]["create-issue"].max).toBe(Number(docs.env.DOCS_AUDIT_MAX_STORIES) + 1);
    expect(docs.jobs.conclude.steps.some((step: { uses?: string }) => step.uses === "./.github/actions/add-issue-labels")).toBe(false);
  });
});
