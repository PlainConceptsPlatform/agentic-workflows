import { describe, expect, it } from "vitest";

import {
  catalogTemplates,
  generatedConsumerTargets,
  packageOwnedTargets,
  routeNames,
  templateNames,
  workflowRoutes,
} from "./workflow-catalog.js";

describe("workflow catalog", () => {
  it("assigns one worker to each route", () => {
    expect(workflowRoutes.map((route) => route.name)).toEqual(routeNames);
    expect(new Set(workflowRoutes.map((route) => route.worker)).size).toBe(workflowRoutes.length);
  });

  it("gives every route a non-empty description", () => {
    for (const route of workflowRoutes) {
      expect(route.description.length).toBeGreaterThan(0);
    }
  });

  it("keeps generated files outside package ownership", () => {
    const packageTargets = new Set<string>(packageOwnedTargets);

    for (const target of generatedConsumerTargets) {
      expect(packageTargets.has(target)).toBe(false);
    }
  });

  it("lists supported optional templates", () => {
    expect(templateNames).toEqual(["agentics-checks", "agentics-maintenance", "app-ci-dotnet-next", "app-ci-node-monorepo", "bug-report", "feature-request", "github-release", "opencode.ci.json", "visual-evidence"]);
  });

  it("gives every catalog template a non-empty description and file", () => {
    expect(catalogTemplates.map((template) => template.name)).toEqual([...templateNames]);
    expect(new Set(catalogTemplates.map((template) => template.file)).size).toBe(catalogTemplates.length);
    for (const template of catalogTemplates) {
      expect(template.description.length).toBeGreaterThan(0);
    }
  });
});
