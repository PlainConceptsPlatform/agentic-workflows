import { describe, expect, it } from "vitest";

import { entryValue, mergeRouter, mergeWorker, mergeWorkerEnv, mirrorRouterLiterals, parseWorkerEnv, parseYamlEnv, serializeWorkerEnv } from "./worker-env.js";

const worker = (env: string, rest = "") => `---\n# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/agent-x.md. Update with \`workflows update --force\`; consumer edits may be overwritten.\nenv:\n${env}description: |\n  A worker.\n${rest}---\n\n1. Do the thing with \${{ env.REPO_RULES }}.\n`;

describe("parseWorkerEnv", () => {
  it("reads entries with their leading comments and continuation lines", () => {
    const parsed = parseWorkerEnv(worker(
      "  REPO_RULES: \"rules\"\n" +
      "  # Why this exists.\n" +
      "  # Two lines of it.\n" +
      "  MAX_ATTEMPTS: \"5\"\n" +
      "  LONG: >-\n" +
      "    first\n" +
      "    second\n" +
      "\n",
    ));

    expect(parsed.present).toBe(true);
    expect(parsed.entries.map((entry) => entry.key)).toEqual(["REPO_RULES", "MAX_ATTEMPTS", "LONG"]);
    expect(parsed.entries[1]!.leading).toEqual(["  # Why this exists.", "  # Two lines of it."]);
    expect(parsed.entries[2]!.lines).toEqual(["  LONG: >-", "    first", "    second"]);
    expect(entryValue(parsed.entries[2]!)).toBe(">-\nfirst\nsecond");
    expect(parsed.trailing).toEqual([""]);
    expect(parsed.after[0]).toBe("description: |");
  });

  it("round-trips a file it parsed", () => {
    const content = worker("  A: \"1\"\n  # about B\n  B: \"2\"\n");
    expect(serializeWorkerEnv(parseWorkerEnv(content))).toBe(content);
  });

  it("reports a file without frontmatter or without an env block as absent", () => {
    expect(parseWorkerEnv("# just a file\n").present).toBe(false);
    expect(parseWorkerEnv("---\nname: x\n---\nbody\n").present).toBe(false);
  });
});

describe("mergeWorkerEnv without a baseline", () => {
  it("keeps every consumer value and takes new package keys with their defaults", () => {
    const pkg = worker("  VERIFY_COMMANDS: \"pnpm verify\"\n  REPO_RULES: \"package rules\"\n  # new in this version\n  NEW_KEY: \"default\"\n");
    const consumer = worker("  VERIFY_COMMANDS: \"dotnet test\"\n  REPO_RULES: \"package rules\"\n");

    const { content, report } = mergeWorkerEnv(pkg, consumer);

    expect(content).toContain("  VERIFY_COMMANDS: \"dotnet test\"\n");
    expect(content).toContain("  REPO_RULES: \"package rules\"\n");
    expect(content).toContain("  # new in this version\n  NEW_KEY: \"default\"\n");
    expect(report.keptEnv).toEqual(["VERIFY_COMMANDS"]);
    expect(report.updatedDefaults).toEqual([]);
  });

  it("keeps keys only the consumer defines, at the end of the block", () => {
    const pkg = worker("  REPO_RULES: \"package rules\"\n");
    const consumer = worker("  REPO_RULES: \"mine\"\n  # my own\n  MY_KEY: \"x\"\n");

    const { content, report } = mergeWorkerEnv(pkg, consumer);

    expect(content).toContain("env:\n  REPO_RULES: \"mine\"\n  # my own\n  MY_KEY: \"x\"\ndescription:");
    expect(report.consumerOnlyEnv).toEqual(["MY_KEY"]);
  });

  it("keeps the package's comments even when the consumer's copy lost them", () => {
    const pkg = worker("  # The model provider fails in bursts.\n  MAX_ATTEMPTS: \"5\"\n");
    const consumer = worker("  MAX_ATTEMPTS: \"9\"\n");

    const { content } = mergeWorkerEnv(pkg, consumer);

    expect(content).toContain("  # The model provider fails in bursts.\n  MAX_ATTEMPTS: \"9\"\n");
  });

  it("leaves everything after the env block as the package has it", () => {
    const pkg = worker("  REPO_RULES: \"package rules\"\n", "timeout-minutes: 240\n");
    const consumer = worker("  REPO_RULES: \"mine\"\n", "timeout-minutes: 30\n").replace("Do the thing", "Do something else");

    const { content } = mergeWorkerEnv(pkg, consumer);

    expect(content).toContain("timeout-minutes: 240\n");
    expect(content).toContain("Do the thing");
    expect(content).not.toContain("Do something else");
  });

  it("returns the package file untouched when either side has no env block", () => {
    const pkg = worker("  A: \"1\"\n");
    expect(mergeWorkerEnv(pkg, "---\nname: x\n---\n").content).toBe(pkg);
  });
});

describe("mergeWorkerEnv with a baseline", () => {
  const baseline = worker("  VERIFY_COMMANDS: \"pnpm verify\"\n  INCOMPLETE_COMMENT: \"old wording\"\n  REMOVED_AT_DEFAULT: \"gone\"\n  REMOVED_BUT_MINE: \"gone\"\n");
  const pkg = worker("  VERIFY_COMMANDS: \"pnpm verify\"\n  INCOMPLETE_COMMENT: \"new wording\"\n");

  it("applies a changed default the consumer never touched, and keeps a value the consumer changed", () => {
    const consumer = worker("  VERIFY_COMMANDS: \"dotnet test\"\n  INCOMPLETE_COMMENT: \"old wording\"\n");

    const { content, report } = mergeWorkerEnv(pkg, consumer, baseline);

    expect(content).toContain("  INCOMPLETE_COMMENT: \"new wording\"\n");
    expect(content).toContain("  VERIFY_COMMANDS: \"dotnet test\"\n");
    expect(report.updatedDefaults).toEqual(["INCOMPLETE_COMMENT"]);
    expect(report.keptEnv).toEqual(["VERIFY_COMMANDS"]);
  });

  it("keeps a consumer value that differs from both the baseline and the package", () => {
    const consumer = worker("  VERIFY_COMMANDS: \"pnpm verify\"\n  INCOMPLETE_COMMENT: \"my wording\"\n");

    const { content, report } = mergeWorkerEnv(pkg, consumer, baseline);

    expect(content).toContain("  INCOMPLETE_COMMENT: \"my wording\"\n");
    expect(report.keptEnv).toEqual(["INCOMPLETE_COMMENT"]);
  });

  it("drops a key the package removed when the consumer still had the old default, and keeps it when changed", () => {
    const consumer = worker("  VERIFY_COMMANDS: \"pnpm verify\"\n  INCOMPLETE_COMMENT: \"old wording\"\n  REMOVED_AT_DEFAULT: \"gone\"\n  REMOVED_BUT_MINE: \"customised\"\n");

    const { content, report } = mergeWorkerEnv(pkg, consumer, baseline);

    expect(content).not.toContain("REMOVED_AT_DEFAULT");
    expect(content).toContain("  REMOVED_BUT_MINE: \"customised\"\n");
    expect(report.droppedEnv).toEqual(["REMOVED_AT_DEFAULT"]);
    expect(report.consumerOnlyEnv).toEqual(["REMOVED_BUT_MINE"]);
  });
});

const router = (env: string, ciName = "App: CI", cron = "17 1 * * 1") =>
  `# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/work-router.yml. Update with \`workflows update --force\`; consumer edits may be overwritten.\nname: "All Work Router"\n\nenv:\n${env}\non:\n  workflow_run:\n    # Mirrored from env.CI_WORKFLOW_NAME by the installer.\n    workflows: ["${ciName}"]\n    types: [completed]\n\n  schedule:\n    - cron: "${cron}" # audit slot, mirrored from env.AUDIT_CRON by the installer\n    - cron: "43 3 * * *"\n\njobs:\n  classify:\n    runs-on: ubuntu-latest\n`;

describe("parseYamlEnv", () => {
  it("reads a top-level env block from plain YAML and round-trips it", () => {
    const content = router('  CI_WORKFLOW_NAME: "App: CI"\n  # slot 0\n  AUDIT_CRON: "17 1 * * 1"\n');
    const parsed = parseYamlEnv(content);

    expect(parsed.present).toBe(true);
    expect(parsed.entries.map((entry) => entry.key)).toEqual(["CI_WORKFLOW_NAME", "AUDIT_CRON"]);
    expect(parsed.entries[1]!.leading).toEqual(["  # slot 0"]);
    expect(serializeWorkerEnv(parsed)).toBe(content);
  });

  it("reports a plain YAML file with no env block as absent", () => {
    expect(parseYamlEnv("name: x\non:\n  push:\n").present).toBe(false);
  });
});

describe("mirrorRouterLiterals", () => {
  it("copies the env values into the trigger and the audit cron", () => {
    const content = mirrorRouterLiterals(router('  CI_WORKFLOW_NAME: "Build and test"\n  AUDIT_CRON: "17 1 * * 4"\n'));

    expect(content).toContain('    workflows: ["Build and test"]\n');
    expect(content).toContain('    - cron: "17 1 * * 4" # audit slot');
    // Only the marked cron moves; the others are the package's schedule.
    expect(content).toContain('    - cron: "43 3 * * *"\n');
  });

  it("leaves the file alone when the env block or the marked lines are absent", () => {
    const noEnv = "name: x\non:\n  schedule:\n    - cron: \"43 3 * * *\"\n";
    expect(mirrorRouterLiterals(noEnv)).toBe(noEnv);
    // A router whose audit route was stripped has no marked cron left to mirror into.
    const noAudit = router('  CI_WORKFLOW_NAME: "CI"\n  AUDIT_CRON: "17 1 * * 4"\n').replace(/^ *- cron: "[^"]*" # audit slot.*\n/m, "");
    expect(mirrorRouterLiterals(noAudit)).toContain('    workflows: ["CI"]\n');
    expect(mirrorRouterLiterals(noAudit)).not.toContain("audit slot");
  });
});

describe("mergeRouter", () => {
  it("keeps the consumer's values and mirrors them into the literal lines", () => {
    const pkg = router('  CI_WORKFLOW_NAME: "App: CI"\n  AUDIT_CRON: "17 1 * * 1"\n');
    const consumer = router('  CI_WORKFLOW_NAME: "Build"\n  AUDIT_CRON: "17 1 * * 5"\n', "Build", "17 1 * * 5")
      .replace("  classify:\n    runs-on: ubuntu-latest\n", "  classify:\n    runs-on: something-else\n");

    const { content, report } = mergeRouter(pkg, consumer);

    expect(report.keptEnv).toEqual(["CI_WORKFLOW_NAME", "AUDIT_CRON"]);
    expect(content).toContain('  CI_WORKFLOW_NAME: "Build"\n');
    expect(content).toContain('    workflows: ["Build"]\n');
    expect(content).toContain('    - cron: "17 1 * * 5" # audit slot');
    // Everything outside env: is the package's again.
    expect(content).toContain("    runs-on: ubuntu-latest\n");
  });

  it("applies a changed package default when the consumer was still on the old one", () => {
    const baseline = router('  CI_WORKFLOW_NAME: "App: CI"\n  AUDIT_CRON: "17 1 * * 1"\n');
    const pkg = router('  CI_WORKFLOW_NAME: "App: CI"\n  AUDIT_CRON: "30 2 * * 1"\n', "App: CI", "30 2 * * 1");
    const consumer = router('  CI_WORKFLOW_NAME: "Build"\n  AUDIT_CRON: "17 1 * * 1"\n', "Build");

    const { content, report } = mergeRouter(pkg, consumer, baseline);

    expect(report.keptEnv).toEqual(["CI_WORKFLOW_NAME"]);
    expect(report.updatedDefaults).toEqual(["AUDIT_CRON"]);
    expect(content).toContain('    - cron: "30 2 * * 1" # audit slot');
    expect(content).toContain('    workflows: ["Build"]\n');
  });
});

describe("mergeWorker", () => {
  // The gateway URL is the consumer's; the runner pool is not, and used to be. Preserving it is
  // how a repository ended up with five workers on its own pool and two on the package's, with
  // nothing reporting the split.
  it("keeps the engine gateway URL and overwrites the runner pool", () => {
    const pkg = worker("  REPO_RULES: \"package rules\"\n", "jobs:\n  reserve:\n    runs-on: agents-arc\n  hosted:\n    runs-on: ubuntu-latest\nruns-on: agents-arc\nruns-on-slim: agents-arc\nengine:\n  env:\n    OPENAI_BASE_URL: https://forge.plainconcepts.com/v1\n");
    const consumer = worker("  REPO_RULES: \"mine\"\n", "jobs:\n  reserve:\n    runs-on: OwnPool\n  hosted:\n    runs-on: ubuntu-latest\nruns-on: OwnPool\nruns-on-slim: OwnPool\nengine:\n  env:\n    OPENAI_BASE_URL: https://gateway.example/v1\n");

    const { content, report } = mergeWorker(pkg, consumer);

    expect(content).toContain("  REPO_RULES: \"mine\"\n");
    expect(content).toContain("    OPENAI_BASE_URL: https://gateway.example/v1\n");
    expect(content).toContain("runs-on: agents-arc\nruns-on-slim: agents-arc\n");
    expect(content).not.toContain("OwnPool");
    expect(content).toContain("    runs-on: ubuntu-latest\n");
    expect(report.keptEnv).toEqual(["REPO_RULES"]);
  });
});
