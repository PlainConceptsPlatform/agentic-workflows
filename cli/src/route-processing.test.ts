import { describe, expect, it } from "vitest";

import { excludedWorkerFiles, processRoutes, stripRouteFromRouter } from "./route-processing.js";
import { routeNames, type RouteName } from "./workflow-catalog.js";

const ROUTER_YAML = `# header
name: "# Main Work Router"

on:
  schedule:
    - cron: "17 1 * * 1"
    - cron: "43 3 * * *"
    - cron: "0 6 * * *"
    - cron: "17 * * * *"

  workflow_dispatch:
    inputs:
      operation:
        description: "Operation to run"
        required: true
        type: choice
        options:
          - refine
          - implement
          - triage
          - apply-review
          - merge-gate
          - merge-train
          - audit
          - audit-close
          - cleanup-artifacts
          - reconcile-bot-pr-runs
          - validate
          - release
      issue-number:
        description: "Issue number"
        required: false
        type: string

jobs:
  classify:
    runs-on: ubuntu-latest

  dispatch-refine:
    needs: [classify, authorize]
    if: needs.classify.outputs.route == 'refine' && needs.authorize.outputs.trusted == 'true'
    runs-on: ubuntu-latest

  # Checks whether an open bot PR already exists for the issue. If it does, implement is
  # skipped.
  check-implement-pr:
    needs: [classify, authorize]
    if: needs.classify.outputs.route == 'implement' && needs.authorize.outputs.trusted == 'true'
    runs-on: ubuntu-latest

  # A stack child implements on the feature branch its parent issue names.
  check-stack-branch:
    needs: [classify, authorize]
    if: needs.classify.outputs.route == 'implement' && needs.authorize.outputs.trusted == 'true'
    runs-on: ubuntu-latest

  dispatch-implement:
    needs: [classify, authorize, check-implement-pr, check-stack-branch]
    if: needs.classify.outputs.route == 'implement' && needs.authorize.outputs.trusted == 'true'
    runs-on: ubuntu-latest

  dispatch-triage:
    needs: [classify, authorize]
    if: needs.classify.outputs.route == 'triage' && (needs.authorize.outputs.trusted == 'true' || needs.authorize.outputs.is_outside_collaborator == 'true')
    runs-on: ubuntu-latest

  dispatch-apply-review:
    needs: [classify, authorize]
    if: needs.classify.outputs.route == 'apply-review' && needs.authorize.outputs.trusted == 'true'
    runs-on: ubuntu-latest

  # The merge belt is one lock for the whole repository.
  call-merge-gate:
    needs: classify
    if: needs.classify.outputs.route == 'merge-gate'
    uses: ./.github/workflows/agent-merge-gate.lock.yml
    concurrency:
      group: merge-belt

  # The merge train: one step for the oldest open pull request that can move.
  merge-train:
    needs: [classify, call-merge-gate]
    if: always() && needs.classify.outputs.route == 'merge-train'
    runs-on: ubuntu-latest

  merge-approved:
    needs: classify
    if: needs.classify.outputs.route == 'merge-approved'
    runs-on: ubuntu-latest

  dispatch-audit:
    needs: classify
    if: needs.classify.outputs.route == 'audit'
    runs-on: ubuntu-latest

  dispatch-release:
    needs: [classify, authorize]
    if: needs.classify.outputs.route == 'release' && needs.authorize.outputs.trusted == 'true'
    runs-on: ubuntu-latest
    env:
      VERSION_BUMP: \${{ github.event.inputs.version-bump || 'auto' }}

  bot-approve:
    needs: classify
    if: needs.classify.outputs.route == 'bot-approve'
    runs-on: ubuntu-latest

  audit-close:
    needs: classify
    if: needs.classify.outputs.route == 'audit-close'
    runs-on: ubuntu-latest

  validate:
    needs: classify
    if: needs.classify.outputs.route == 'validate'
    runs-on: ubuntu-latest
`;

const CLASSIFIER = "readonly AUDIT_CRON=\"17 1 * * 1\"\ncase x in audit) ;; esac\n";
const MATRIX = "#!/usr/bin/env bash\nfor route in refine implement; do :; done\n";

const jobs = (yaml: string): string[] => [...yaml.slice(yaml.indexOf("\njobs:\n")).matchAll(/^  ([a-z-]+):\s*$/gm)].map((match) => match[1]!);
const options = (yaml: string): string[] => [...yaml.matchAll(/^          - ([a-z-]+)$/gm)].map((match) => match[1]!);

describe("stripRouteFromRouter", () => {
  it("removes the audit cron, job and dispatch option", () => {
    const result = stripRouteFromRouter(ROUTER_YAML, "audit");

    expect(result).not.toContain('- cron: "17 1 * * 1"');
    expect(result).toContain('- cron: "43 3 * * *"');
    expect(jobs(result)).not.toContain("dispatch-audit");
    expect(jobs(result)).toContain("audit-close");
    expect(options(result)).not.toContain("audit");
    expect(options(result)).toContain("audit-close");
  });

  it("removes a route's cron by its slot comment, whichever slot the repository picked", () => {
    const yaml = `on:
  schedule:
    - cron: "9 4 2,16 * *" # docs-audit slot, mirrored from env.DOCS_AUDIT_CRON by the installer
    - cron: "43 3 * * *"
`;
    const result = stripRouteFromRouter(yaml, "docs-audit");

    expect(result).not.toContain("docs-audit slot");
    expect(result).toContain('- cron: "43 3 * * *"');
  });

  it("removes the release job and dispatch option", () => {
    const result = stripRouteFromRouter(ROUTER_YAML, "release");

    expect(jobs(result)).not.toContain("dispatch-release");
    expect(options(result)).not.toContain("release");
    expect(result).not.toContain("route == 'release'");
    expect(jobs(result)).toContain("bot-approve");
  });

  it("removes a route's helper job together with the route", () => {
    const withoutImplement = stripRouteFromRouter(ROUTER_YAML, "implement");
    expect(jobs(withoutImplement)).not.toContain("dispatch-implement");
    expect(jobs(withoutImplement)).not.toContain("check-implement-pr");
    expect(jobs(withoutImplement)).not.toContain("check-stack-branch");
    expect(withoutImplement).not.toContain("route == 'implement'");
    // The comment that introduced the helper job goes with it.
    expect(withoutImplement).not.toContain("Checks whether an open bot PR");
    expect(jobs(withoutImplement)).toContain("dispatch-refine");

    const withoutTriage = stripRouteFromRouter(ROUTER_YAML, "triage");
    expect(jobs(withoutTriage)).not.toContain("dispatch-triage");
    expect(jobs(withoutTriage)).not.toContain("dispatch-triage");
    expect(withoutTriage).not.toContain("route == 'triage'");
 
    const withoutGate = stripRouteFromRouter(ROUTER_YAML, "merge-gate");
    expect(jobs(withoutGate)).not.toContain("call-merge-gate");
    expect(jobs(withoutGate)).not.toContain("merge-approved");
    // The train needs call-merge-gate, so it cannot outlive it, and its dispatch operation
    // would be answered by no job.
    expect(jobs(withoutGate)).not.toContain("merge-train");
    expect(options(withoutGate)).not.toContain("merge-train");
    expect(withoutGate).not.toContain("The merge train: one step");
  });

  it("removes the comment that introduces a job, and keeps the job before it intact", () => {
    const result = stripRouteFromRouter(ROUTER_YAML, "merge-gate");

    expect(result).not.toContain("The merge belt is one lock");
    expect(result).toContain("runs-on: ubuntu-latest\n\n  dispatch-audit:");
  });

  it("does not modify the yaml when stripping a route that has no cron and no helper", () => {
    const result = stripRouteFromRouter(ROUTER_YAML, "apply-review");
    expect(result).toContain('- cron: "17 1 * * 1"');
    expect(jobs(result)).toEqual(jobs(ROUTER_YAML).filter((job) => job !== "dispatch-apply-review"));
  });
});

describe("processRoutes", () => {
  const files = (): Map<string, string> => new Map([
    [".github/workflows/work-router.yml", ROUTER_YAML],
    [".github/actions/classify-route/classify-route.sh", CLASSIFIER],
    [".github/actions/verify-route-matrix/verify-route-matrix.sh", MATRIX],
  ]);

  it("returns the same map when all routes are selected", () => {
    const input = files();
    expect(processRoutes(input, [...routeNames])).toBe(input);
  });

  it("strips every worker route from the router when no routes are selected, and keeps the plumbing", () => {
    const result = processRoutes(files(), []);
    const router = result.get(".github/workflows/work-router.yml")!;

    expect(jobs(router)).toEqual(["classify", "bot-approve", "audit-close", "validate"]);
    expect(options(router)).toEqual(["audit-close", "cleanup-artifacts", "reconcile-bot-pr-runs", "validate"]);
    expect(router).not.toContain('- cron: "17 1 * * 1"');
  });

  it("keeps exactly the selected routes", () => {
    const selected: RouteName[] = ["refine", "implement", "release"];
    const router = processRoutes(files(), selected).get(".github/workflows/work-router.yml")!;

    expect(jobs(router)).toEqual(["classify", "dispatch-refine", "check-implement-pr", "check-stack-branch", "dispatch-implement", "dispatch-release", "bot-approve", "audit-close", "validate"]);
    expect(options(router)).toEqual(["refine", "implement", "audit-close", "cleanup-artifacts", "reconcile-bot-pr-runs", "validate", "release"]);
  });

  // The merge gate's helpers live in agentics-merge-belt.yml and leave it with the gate; the router
  // loses the forwarder that would hand the belt an operation it no longer offers.
  it("strips the merge gate from the merge belt and its forwarder from the router", () => {
    const belt = [
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      operation:",
      "        options:",
      "          - merge-gate",
      "          - merge-train",
      "          - reconcile-bot-pr-runs",
      "jobs:",
      "  classify:",
      "    runs-on: x",
      "  # The gate.",
      "  call-merge-gate:",
      "    uses: ./.github/workflows/agent-merge-gate.lock.yml",
      "  merge-train:",
      "    runs-on: x",
      "  merge-approved:",
      "    runs-on: x",
      "  reconcile-bot-pr-runs:",
      "    runs-on: x",
      "",
    ].join("\n");
    const router = ROUTER_YAML.replace("  validate:", "  forward-merge-train:\n    runs-on: x\n  validate:");
    const input = new Map([...files(), [".github/workflows/work-router.yml", router], [".github/workflows/agentics-merge-belt.yml", belt]]);

    const result = processRoutes(input, routeNames.filter((route) => route !== "merge-gate"));

    expect(jobs(result.get(".github/workflows/agentics-merge-belt.yml")!)).toEqual(["classify", "reconcile-bot-pr-runs"]);
    expect(options(result.get(".github/workflows/agentics-merge-belt.yml")!)).toEqual(["reconcile-bot-pr-runs"]);
    expect(result.get(".github/workflows/agentics-merge-belt.yml")).not.toContain("# The gate.");
    expect(jobs(result.get(".github/workflows/work-router.yml")!)).not.toContain("forward-merge-train");
    expect(processRoutes(input, [...routeNames]).get(".github/workflows/agentics-merge-belt.yml")).toBe(belt);
  });

  it("never rewrites the classifier or the route matrix", () => {
    const result = processRoutes(files(), ["refine"]);

    expect(result.get(".github/actions/classify-route/classify-route.sh")).toBe(CLASSIFIER);
    expect(result.get(".github/actions/verify-route-matrix/verify-route-matrix.sh")).toBe(MATRIX);
  });
});

describe("excludedWorkerFiles", () => {
  it("returns worker files for unselected routes", () => {
    const excluded = excludedWorkerFiles(["refine", "implement"]);
    expect(excluded.has("agent-audit.md")).toBe(true);
    expect(excluded.has("agent-release.md")).toBe(true);
    expect(excluded.has("agent-refine.md")).toBe(false);
  });

  // release-tag.yml tags what the release PR merged. Left behind without agent-release.md it
  // would sit on every push to main serving a route that no longer exists.
  it("excludes a route's companion workflows with its worker", () => {
    expect(excludedWorkerFiles(["refine"]).has("release-tag.yml")).toBe(true);
    expect(excludedWorkerFiles(["refine", "release"]).has("release-tag.yml")).toBe(false);
  });

  it("returns an empty set when all routes are selected", () => {
    expect(excludedWorkerFiles([...routeNames]).size).toBe(0);
  });

  it("returns all worker and companion files when no routes are selected", () => {
    const excluded = excludedWorkerFiles([]);
    expect([...excluded].filter((file) => file.startsWith("agent-")).length).toBe(routeNames.length);
    expect([...excluded].filter((file) => !file.startsWith("agent-"))).toEqual(["release-tag.yml", "release-to-production.yml"]);
  });
});
