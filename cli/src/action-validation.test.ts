import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface CompositeStep {
  name?: string;
  id?: string;
  shell?: string;
  run?: string;
  env?: Record<string, unknown>;
  uses?: string;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
  if?: string;
}

interface ActionManifest {
  name: string;
  description?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  runs?: {
    using?: string;
    steps?: CompositeStep[];
  };
}

async function collectActionYmlFiles(actionsDir: string): Promise<string[]> {
  const entries = await readdir(actionsDir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const sub of await readdir(join(actionsDir, entry.name), { withFileTypes: true })) {
        if (sub.isFile() && sub.name === "action.yml") {
          results.push(join(actionsDir, entry.name, sub.name));
        }
      }
    }
  }
  return results;
}

async function loadManifests(): Promise<{ file: string; content: string; manifest: ActionManifest }[]> {
  // catalogSourcePath() resolves against the published package layout, where loops/ ships
  // next to the compiled module. In this repository loops/ lives at the root, two levels
  // above this test, so resolve it from the source tree instead.
  const actionsDir = join(fileURLToPath(new URL("../../loops", import.meta.url)), "actions");
  const files = await collectActionYmlFiles(actionsDir);
  return Promise.all(files.map(async (file) => {
    const content = await readFile(file, "utf8");
    return { file, content, manifest: parse(content) as ActionManifest };
  }));
}

describe("action.yml manifest validation", () => {
  it("finds action.yml files under loops/actions/", async () => {
    const manifests = await loadManifests();
    expect(manifests.length).toBeGreaterThanOrEqual(1);
  });

  it("every action.yml parses as valid YAML", async () => {
    for (const { file, content } of await loadManifests()) {
      expect(() => parse(content), `${file}: failed to parse as YAML`).not.toThrow();
    }
  });

  it("every action.yml has runs.using === composite", async () => {
    for (const { file, manifest } of await loadManifests()) {
      expect(manifest.runs?.using, `${file}: runs.using is not "composite"`).toBe("composite");
    }
  });

  it("every action.yml has at least one step in runs.steps", async () => {
    for (const { file, manifest } of await loadManifests()) {
      expect(manifest.runs?.steps, `${file}: runs.steps is undefined`).toBeDefined();
      expect(manifest.runs!.steps!.length, `${file}: runs.steps is empty — file may be truncated`).toBeGreaterThanOrEqual(1);
    }
  });

  it("every step with shell: also has run:", async () => {
    for (const { file, manifest } of await loadManifests()) {
      const steps = manifest.runs?.steps ?? [];
      for (const [index, step] of steps.entries()) {
        const label = step.name ?? step.id ?? `step ${index}`;
        if (step.shell !== undefined) {
          expect(step.run, `${file}: step "${label}" has shell: but no run:`).toBeDefined();
          expect(typeof step.run, `${file}: step "${label}" run is not a string`).toBe("string");
          expect(step.run!.trim().length, `${file}: step "${label}" run is empty`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("every step with env: also has run: or uses:", async () => {
    for (const { file, manifest } of await loadManifests()) {
      const steps = manifest.runs?.steps ?? [];
      for (const [index, step] of steps.entries()) {
        const label = step.name ?? step.id ?? `step ${index}`;
        if (step.env !== undefined) {
          expect(
            step.run !== undefined || step.uses !== undefined,
            `${file}: step "${label}" has env: but no run: or uses:`,
          ).toBe(true);
        }
      }
    }
  });

  it("no action.yml is truncated (last step has run: or uses: with non-empty value)", async () => {
    for (const { file, manifest } of await loadManifests()) {
      const steps = manifest.runs?.steps ?? [];
      expect(steps.length, `${file}: no steps found — file may be truncated`).toBeGreaterThanOrEqual(1);
      const lastStep = steps[steps.length - 1]!;
      const hasTerminal = (lastStep.run !== undefined && lastStep.run.trim().length > 0) ||
        (lastStep.uses !== undefined && lastStep.uses.trim().length > 0) ||
        (lastStep.with !== undefined);
      expect(hasTerminal, `${file}: last step appears truncated`).toBe(true);
    }
  });
});
