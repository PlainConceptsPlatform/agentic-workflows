import { describe, expect, it } from "vitest";

import { excludedWorkerFiles, processRoutes, stripRouteFromRouter } from "./route-processing.js";
import { routeNames, type RouteName } from "./workflow-catalog.js";

const ROUTER_YAML = `# header
name: "All Work Router"

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

  call-refine:
    needs: [classify, authorize]
    if: needs.classify.outputs.route == 'refine' && needs.authorize.outputs.trusted == 'true'
    uses: ./.github/workflows/agent-refine.lock.yml

  # Checks whether an open bot PR already exists for the issue. If it does, implement is
  # skipped.
  check-implement-pr:
    needs: [classify, authorize]
    if: needs.classify.outputs.route == 'implement' && needs.authorize.outputs.trusted == 'true'
    runs-on: ubuntu-latest

  call-implement:
    needs: [classify, authorize, check-implement-pr]
    if: needs.classify.outputs.route == 'implement' && needs.authorize.outputs.trusted == 'true'
    uses: ./.github/workflows/agent-implement.lock.yml

  dispatch-triage:
    needs: [classify, authorize]
    if: needs.classify.outputs.route == 'triage' && needs.authorize.outputs.is_outside_collaborator == 'true'
    runs-on: ubuntu-latest

  call-triage:
    needs: [classify, authorize]
    if: needs.classify.outputs.route == 'triage' && needs.authorize.outputs.trusted == 'true'
    uses: ./.github/workflows/agent-triage.lock.yml

  call-apply-review:
    needs: [classify, authorize]
    if: needs.classify.outputs.route == 'apply-review' && needs.authorize.outputs.trusted == 'true'
    uses: ./.github/workflows/agent-apply-review.lock.yml

  # The merge belt is one lock for the whole repository.
  call-merge-gate:
    needs: classify
    if: needs.classify.outputs.route == 'merge-gate'
    uses: ./.github/workflows/agent-merge-gate.lock.yml
    concurrency:
      group: merge-belt

  call-audit:
    needs: classify
    if: needs.classify.outputs.route == 'audit'
    uses: ./.github/workflows/agent-audit.lock.yml

  call-release:
    needs: [classify, authorize]
    if: needs.classify.outputs.route == 'release' && needs.authorize.outputs.trusted == 'true'
    uses: ./.github/workflows/agent-release.lock.yml
    with:
      version-bump: \${{ github.event.inputs.version-bump || 'auto' }}

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
    expect(jobs(result)).not.toContain("call-audit");
    expect(jobs(result)).toContain("audit-close");
    expect(options(result)).not.toContain("audit");
    expect(options(result)).toContain("audit-close");
  });

  it("removes the release job and dispatch option", () => {
    const result = stripRouteFromRouter(ROUTER_YAML, "release");

    expect(jobs(result)).not.toContain("call-release");
    expect(options(result)).not.toContain("release");
    expect(result).not.toContain("route == 'release'");
    expect(jobs(result)).toContain("bot-approve");
  });

  it("removes a route's helper job together with the route", () => {
    const withoutImplement = stripRouteFromRouter(ROUTER_YAML, "implement");
    expect(jobs(withoutImplement)).not.toContain("call-implement");
    expect(jobs(withoutImplement)).not.toContain("check-implement-pr");
    expect(withoutImplement).not.toContain("route == 'implement'");
    // The comment that introduced the helper job goes with it.
    expect(withoutImplement).not.toContain("Checks whether an open bot PR");
    expect(jobs(withoutImplement)).toContain("call-refine");

    const withoutTriage = stripRouteFromRouter(ROUTER_YAML, "triage");
    expect(jobs(withoutTriage)).not.toContain("call-triage");
    expect(jobs(withoutTriage)).not.toContain("dispatch-triage");
    expect(withoutTriage).not.toContain("route == 'triage'");
  });

  it("removes the comment that introduces a job, and keeps the job before it intact", () => {
    const result = stripRouteFromRouter(ROUTER_YAML, "merge-gate");

    expect(result).not.toContain("The merge belt is one lock");
    expect(result).toContain("uses: ./.github/workflows/agent-apply-review.lock.yml\n\n  call-audit:");
  });

  it("does not modify the yaml when stripping a route that has no cron and no helper", () => {
    const result = stripRouteFromRouter(ROUTER_YAML, "apply-review");
    expect(result).toContain('- cron: "17 1 * * 1"');
    expect(jobs(result)).toEqual(jobs(ROUTER_YAML).filter((job) => job !== "call-apply-review"));
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

    expect(jobs(router)).toEqual(["classify", "call-refine", "check-implement-pr", "call-implement", "call-release", "bot-approve", "audit-close", "validate"]);
    expect(options(router)).toEqual(["refine", "implement", "audit-close", "cleanup-artifacts", "reconcile-bot-pr-runs", "validate", "release"]);
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

  it("returns an empty set when all routes are selected", () => {
    expect(excludedWorkerFiles([...routeNames]).size).toBe(0);
  });

  it("returns all worker files when no routes are selected", () => {
    expect(excludedWorkerFiles([]).size).toBe(routeNames.length);
  });
});
