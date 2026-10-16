export const routeNames = [
  "refine",
  "implement",
  "triage",
  "apply-review",
  "merge-gate",
  "audit",
  "release",
] as const;

export type RouteName = (typeof routeNames)[number];

export interface WorkflowRoute {
  readonly name: RouteName;
  readonly worker: string;
  readonly description: string;
  readonly defaultEnabled: boolean;
  /** Plain workflows that exist only to serve this route. They are installed and removed with it. */
  readonly companions?: readonly string[];
}

export const workflowRoutes: readonly WorkflowRoute[] = [
  { name: "refine", worker: "agent-refine.md", description: "Refines an issue into a user story, on a first pass or after the author has answered the bot's questions.", defaultEnabled: true },
  { name: "implement", worker: "agent-implement.md", description: "Implements an issue and opens a pull request. Stops there: the merge decision belongs to the merge gate.", defaultEnabled: true },
  { name: "triage", worker: "agent-triage.md", description: "Triages issues opened from outside the organisation: runs 10 checks (template, security, size, danger, duplicates, clarity, reproducibility, acceptance, cross-cutting, product scope). Loops up to 3 rounds. Passes to refine, asks the author for more, parks out-of-scope work open for a maintainer, or closes what is genuinely rejected.", defaultEnabled: true },
  { name: "apply-review", worker: "agent-apply-review.md", description: "Applies reviewer feedback to an open pull request the bot authored, then pushes the fixes to the same branch.", defaultEnabled: true },
  { name: "merge-gate", worker: "agent-merge-gate.md", description: "Decides what happens to the pull request the merge train hands it, the bot's or a person's: repair it, merge it, or hand it to a human.", defaultEnabled: true },
  { name: "audit", worker: "agent-audit.md", description: "Read-only repository audit. Finds 5-7 problems, scores each 1-10, and files a single issue that Refine then sizes and splits.", defaultEnabled: true },
  { name: "release", worker: "agent-release.md", description: "Writes release notes from the commit log, then a deterministic job opens a version-bump pull request with auto-merge; once it merges, release-tag.yml tags the commit and publishes the GitHub Release. Manual dispatch only (operation=release).", defaultEnabled: true, companions: ["release-tag.yml"] },
];

// Workflow files the package used to ship and no longer does. `.github/workflows/` is not pruned
// wholesale, because a missing worker there means a route the consumer left out, so a retired one
// is named here or it sits in every consumer forever with a lock that still compiles.
// agent-visual-verify was replaced by evidence.yml in 1.1.0.
export const retiredWorkflowFiles = [
  "agent-visual-verify.md",
  "agent-visual-verify.lock.yml",
] as const;

export const packageOwnedTargets = [
  ".github/actions",
  ".github/workflows/agent-*.md",
  ".github/workflows/shared/platform-defaults.md",
  ".github/workflows/shared/opencode-ci.md",
  ".github/workflows/work-router.yml",
  ".github/workflows/evidence.yml",
  "scripts/compile-agent-workflows.mjs",
  "opencode.ci.json",
  "docs/diagrams.md",
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
  "agentics-app-errors",
  "agentics-checks",
  "agentics-error-report",
  "agentics-maintenance",
  "app-ci-dotnet-next",
  "app-ci-node-monorepo",
  "bug-report",
  "feature-request",
  "github-release",
  "opencode.ci.json",
] as const;

export type TemplateName = (typeof templateNames)[number];

export interface CatalogTemplate {
  readonly name: TemplateName;
  readonly file: string;
  readonly description: string;
  readonly target?: string;
  /** Subdirectory of `templates/` holding the file. Defaults to "agentics". */
  readonly directory?: string;
}

export const catalogTemplates: readonly CatalogTemplate[] = [
  { name: "agentics-app-errors", file: "agentics-app-errors.yml", description: "Daily application error report: asks Application Insights what the deployed app threw, groups it, and files one issue per distinct problem HERE, labelled bug + refine so the belt picks it up. Deterministic, no model; the report never leaves this repository, and a leak scanner withholds anything carrying an identifier." },
  { name: "agentics-checks", file: "agentics-checks.yml", description: "Agentics checks: verifies generated agent lockfiles, actionlint, and compile on PRs touching workflow files." },
  { name: "agentics-error-report", file: "agentics-error-report.yml", description: "Daily error report: classifies the last day of failures in the workflows this package ships and files them upstream so the package gets fixed. Deterministic, no model; sends only package-owned names, conclusions and counts, and refuses to file anything a leak scanner flags." },
  { name: "agentics-maintenance", file: "agentics-maintenance.yml", description: "Agentic maintenance: scheduled daily maintenance workflow for keeping workflows and actions up to date." },
  { name: "app-ci-dotnet-next", file: "app-ci-dotnet-next.yml", description: "App CI pipeline for a .NET + Next.js monorepo: build, test, and lint on PRs and schedule." },
  { name: "app-ci-node-monorepo", file: "app-ci-node-monorepo.yml", description: "App CI pipeline for a Node monorepo: build, test, and lint on PRs and schedule." },
  { name: "bug-report", file: "bug_report.yml", description: "Bug report issue template: what happened, repro steps, expected behavior, acceptance criteria, environment, logs.", target: ".github/ISSUE_TEMPLATE/bug_report.yml" },
  { name: "feature-request", file: "feature_request.yml", description: "Feature request issue template scoped to small, well-scoped improvements (Small/Medium only; large work belongs in a planning issue).", target: ".github/ISSUE_TEMPLATE/feature_request.yml" },
  { name: "github-release", file: "github-release.yml", description: "Publishes or updates a GitHub Release with generated notes whenever a v* tag is pushed." },
  { name: "opencode.ci.json", file: "opencode.ci.json", description: "Standalone OpenCode CI config: plainconcepts provider, GLM model registration, ci-workflow-agent, and LSP defaults for consumer repositories." },
];
