import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    expect(templateNames).toEqual(["agentics-checks", "agentics-error-report", "agentics-maintenance", "app-ci-dotnet-next", "app-ci-node-monorepo", "bug-report", "feature-request", "github-release", "opencode.ci.json"]);
  });

  it("gives every catalog template a non-empty description and file", () => {
    expect(catalogTemplates.map((template) => template.name)).toEqual([...templateNames]);
    expect(new Set(catalogTemplates.map((template) => template.file)).size).toBe(catalogTemplates.length);
    for (const template of catalogTemplates) {
      expect(template.description.length).toBeGreaterThan(0);
    }
  });

  // The source directory used to be inferred from the template name by a chain of ternaries
  // whose final branch was "agentics", so a template whose file lived anywhere else resolved
  // to a path that does not exist and `add --template` failed on a missing file. Resolve every
  // one against the real tree instead of trusting the inference.
  it("resolves every template to a file that exists", async () => {
    const loops = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "loops");

    for (const template of catalogTemplates) {
      const directory = template.directory
        ?? (template.name.startsWith("opencode")
          ? "opencode"
          : template.name.startsWith("app-ci-")
            ? "ci"
            : template.name === "github-release"
              ? "release"
              : template.name === "bug-report" || template.name === "feature-request"
                ? "issues"
                : "agentics");
      const source = join(loops, "templates", directory, template.file);
      expect(existsSync(source), `${template.name} resolves to ${source}`).toBe(true);
    }
  });
});
