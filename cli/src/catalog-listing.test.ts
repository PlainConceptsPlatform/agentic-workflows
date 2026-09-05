import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatCatalog, listCatalog, searchCatalog } from "./catalog-listing.js";
import { workflowRoutes, catalogTemplates } from "./workflow-catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("catalog listing", () => {
  it("returns all routes and templates", async () => {
    const repositoryPath = await createRepository({});

    const entries = await listCatalog({ installedPath: repositoryPath });

    expect(entries).toHaveLength(workflowRoutes.length + catalogTemplates.length);

    const routeNames = entries.filter((entry) => entry.kind === "route").map((entry) => entry.name);
    const templateNames = entries.filter((entry) => entry.kind === "template").map((entry) => entry.name);

    expect(routeNames).toEqual(["refine", "implement", "triage", "apply-review", "merge-gate", "audit"]);
    expect(templateNames).toEqual(["agentics-checks", "agentics-maintenance", "app-ci-dotnet-next", "app-ci-node-monorepo", "bug-report", "feature-request", "github-release", "opencode.ci.json", "visual-evidence"]);
  });

  it("reports all entries as not installed in an empty repository", async () => {
    const repositoryPath = await createRepository({});

    const entries = await listCatalog({ installedPath: repositoryPath });

    expect(entries.every((entry) => entry.installed === false)).toBe(true);
  });

  it("marks a route as installed when its worker file exists", async () => {
    const repositoryPath = await createRepository({
      ".github/workflows/agent-refine.md": "# Refine",
    });

    const entries = await listCatalog({ installedPath: repositoryPath });
    const refineEntry = entries.find((entry) => entry.name === "refine");

    expect(refineEntry).toBeDefined();
    expect(refineEntry!.installed).toBe(true);
  });

  it("marks a template as installed when its template file exists", async () => {
    const repositoryPath = await createRepository({
      ".github/workflows/agentics-checks.yml": "name: Agentics checks",
    });

    const entries = await listCatalog({ installedPath: repositoryPath });
    const checksEntry = entries.find((entry) => entry.name === "agentics-checks");

    expect(checksEntry).toBeDefined();
    expect(checksEntry!.installed).toBe(true);
  });

  it("marks an issue template as installed when its file exists in .github/ISSUE_TEMPLATE/", async () => {
    const repositoryPath = await createRepository({
      ".github/ISSUE_TEMPLATE/bug_report.yml": "name: Bug report",
      ".github/ISSUE_TEMPLATE/feature_request.yml": "name: Feature request",
    });

    const entries = await listCatalog({ installedPath: repositoryPath });
    const bugEntry = entries.find((entry) => entry.name === "bug-report");
    const featureEntry = entries.find((entry) => entry.name === "feature-request");

    expect(bugEntry).toBeDefined();
    expect(bugEntry!.installed).toBe(true);
    expect(featureEntry).toBeDefined();
    expect(featureEntry!.installed).toBe(true);
  });

  it("marks the opencode.ci.json template as installed when the file exists at repository root", async () => {
    const repositoryPath = await createRepository({
      "opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-3\" }",
    });

    const entries = await listCatalog({ installedPath: repositoryPath });
    const opencodeEntry = entries.find((entry) => entry.name === "opencode.ci.json");

    expect(opencodeEntry).toBeDefined();
    expect(opencodeEntry!.installed).toBe(true);
  });

  it("reports mixed installed and uninstalled entries", async () => {
    const repositoryPath = await createRepository({
      ".github/workflows/agent-refine.md": "# Refine",
      ".github/workflows/agent-audit.md": "# Audit",
      ".github/workflows/app-ci-dotnet-next.yml": "name: CI",
      "opencode.ci.json": "{ \"model\": \"plainconcepts/glm-5-3\" }",
    });

    const entries = await listCatalog({ installedPath: repositoryPath });

    expect(entries.filter((entry) => entry.installed).map((entry) => entry.name))
      .toEqual(expect.arrayContaining(["refine", "audit", "app-ci-dotnet-next", "opencode.ci.json"]));
    expect(entries.filter((entry) => !entry.installed)).toHaveLength(
      workflowRoutes.length + catalogTemplates.length - 4,
    );
  });
});

describe("searchCatalog", () => {
  const sampleEntries = [
    { kind: "route" as const, name: "refine", description: "Refines an issue into a user story.", file: "agent-refine.md", installed: false },
    { kind: "route" as const, name: "audit", description: "Read-only repository audit.", file: "agent-audit.md", installed: true },
    { kind: "template" as const, name: "app-ci-dotnet-next", description: "App CI pipeline for .NET + Next.js.", file: "app-ci-dotnet-next.yml", installed: false },
  ];

  it("filters by name match", () => {
    const results = searchCatalog(sampleEntries, "audit");

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("audit");
  });

  it("filters by description match", () => {
    const results = searchCatalog(sampleEntries, "user story");

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("refine");
  });

  it("is case-insensitive", () => {
    const results = searchCatalog(sampleEntries, "AUDIT");

    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("audit");
  });

  it("returns empty array for no matches", () => {
    const results = searchCatalog(sampleEntries, "nonexistent");

    expect(results).toHaveLength(0);
  });

  it("returns empty array for empty query after trim", () => {
    expect(searchCatalog(sampleEntries, "  ")).toHaveLength(0);
  });

  it("returns both routes and templates when the query matches both kinds", () => {
    const entries = [
      { kind: "route" as const, name: "audit", description: "Executes a CI instruction.", file: "agent-audit.md", installed: false },
      { kind: "template" as const, name: "app-ci-dotnet-next", description: "App CI pipeline.", file: "app-ci-dotnet-next.yml", installed: true },
    ];
    const results = searchCatalog(entries, "CI");

    expect(results).toHaveLength(2);
  });
});

describe("formatCatalog", () => {
  it("groups routes under Workflows and templates under Templates", () => {
    const entries = [
      { kind: "route" as const, name: "refine", description: "Refines a story.", file: "agent-refine.md", installed: true },
      { kind: "template" as const, name: "app-ci-dotnet-next", description: "CI for .NET.", file: "app-ci-dotnet-next.yml", installed: false },
    ];

    const output = formatCatalog(entries);

    expect(output).toContain("Workflows:");
    expect(output).toContain("Templates:");
    expect(output).toContain("[x] refine");
    expect(output).toContain("[ ] app-ci-dotnet-next");
  });

  it("prints a no-match message for an empty result", () => {
    expect(formatCatalog([])).toBe("No workflows matched the search query.");
  });

  it("prints only a Workflows section when no templates match", () => {
    const entries = [
      { kind: "route" as const, name: "refine", description: "Refines.", file: "agent-refine.md", installed: false },
    ];

    const output = formatCatalog(entries);

    expect(output).toContain("Workflows:");
    expect(output).not.toContain("Templates:");
  });
});

async function createRepository(files: Record<string, string>): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "workflows-"));
  temporaryDirectories.push(repositoryPath);
  await Promise.all(Object.entries(files).map(async ([relativePath, content]) => {
    const path = join(repositoryPath, relativePath);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
  }));
  return repositoryPath;
}
