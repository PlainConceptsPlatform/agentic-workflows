export const routeNames = [
  "refine",
  "implement",
  "triage",
  "apply-review",
  "merge-gate",
  "audit",
] as const;

export type RouteName = (typeof routeNames)[number];

export interface WorkflowRoute {
  readonly name: RouteName;
  readonly worker: string;
  readonly description: string;
  readonly defaultEnabled: boolean;
}

export const workflowRoutes: readonly WorkflowRoute[] = [
  { name: "refine", worker: "agent-refine.md", description: "Refines an issue into a user story, on a first pass or after the author has answered the bot's questions.", defaultEnabled: true },
  { name: "implement", worker: "agent-implement.md", description: "Implements an issue and opens a pull request. Stops there: the merge decision belongs to the merge gate.", defaultEnabled: true },
  { name: "triage", worker: "agent-triage.md", description: "Triages issues opened by outside collaborators: runs 10 checks (template, security, size, danger, duplicates, clarity, reproducibility, acceptance, cross-cutting). Loops up to 3 rounds. Passes to refine or blocks.", defaultEnabled: true },
  { name: "apply-review", worker: "agent-apply-review.md", description: "Applies reviewer feedback to an open pull request the bot authored, then pushes the fixes to the same branch.", defaultEnabled: true },
  { name: "merge-gate", worker: "agent-merge-gate.md", description: "Decides what happens to a bot-authored pull request once CI has reported: merge, hand to a human, or fix CI.", defaultEnabled: true },
  { name: "audit", worker: "agent-audit.md", description: "Read-only repository audit. Finds 5-7 problems, scores each 1-10, and files a single issue that Refine then sizes and splits.", defaultEnabled: true },
];

export const packageOwnedTargets = [
  ".github/actions",
  ".github/workflows/agent-*.md",
  ".github/workflows/shared/platform-defaults.md",
  ".github/workflows/shared/opencode-ci.md",
  ".github/workflows/work-router.yml",
  "scripts/compile-agent-workflows.mjs",
  "opencode.ci.json",
] as const;

export interface MandatoryFile {
  readonly source: string;
  readonly target: string;
}

export const mandatoryFiles: readonly MandatoryFile[] = [
  { source: "templates/opencode/opencode.ci.json", target: "opencode.ci.json" },
  { source: "scripts/compile-agent-workflows.mjs", target: "scripts/compile-agent-workflows.mjs" },
];

export const generatedConsumerTargets = [
  ".github/workflows/agent-*.lock.yml",
  ".github/aw/actions-lock.json",
] as const;

export const templateNames = [
  "agentics-checks",
  "agentics-maintenance",
  "app-ci-dotnet-next",
  "app-ci-node-monorepo",
  "bug-report",
  "feature-request",
  "github-release",
  "opencode.ci.json",
  "visual-evidence",
] as const;

export type TemplateName = (typeof templateNames)[number];

export interface CatalogTemplate {
  readonly name: TemplateName;
  readonly file: string;
  readonly description: string;
  readonly target?: string;
}

export const catalogTemplates: readonly CatalogTemplate[] = [
  { name: "agentics-checks", file: "agentics-checks.yml", description: "Agentics checks: verifies generated agent lockfiles, actionlint, and compile on PRs touching workflow files." },
  { name: "agentics-maintenance", file: "agentics-maintenance.yml", description: "Agentic maintenance: scheduled daily maintenance workflow for keeping workflows and actions up to date." },
  { name: "app-ci-dotnet-next", file: "app-ci-dotnet-next.yml", description: "App CI pipeline for a .NET + Next.js monorepo: build, test, and lint on PRs and schedule." },
  { name: "app-ci-node-monorepo", file: "app-ci-node-monorepo.yml", description: "App CI pipeline for a Node monorepo: build, test, and lint on PRs and schedule." },
  { name: "bug-report", file: "bug_report.yml", description: "Bug report issue template: what happened, repro steps, expected behavior, acceptance criteria, environment, logs.", target: ".github/ISSUE_TEMPLATE/bug_report.yml" },
  { name: "feature-request", file: "feature_request.yml", description: "Feature request issue template scoped to small, well-scoped improvements (Small/Medium only; large work belongs in a planning issue).", target: ".github/ISSUE_TEMPLATE/feature_request.yml" },
  { name: "github-release", file: "github-release.yml", description: "Publishes or updates a GitHub Release with generated notes whenever a v* tag is pushed." },
  { name: "opencode.ci.json", file: "opencode.ci.json", description: "Standalone OpenCode CI config: plainconcepts provider, GLM model registration, ci-workflow-agent, and LSP defaults for consumer repositories." },
  { name: "visual-evidence", file: "visual-evidence.yml", description: "Visual evidence: captures screenshots of UI changes on bot-authored PRs by reading the capturePlan left by the agent in evidence.json and executing it on a runner with Docker and Chrome access." },
];
