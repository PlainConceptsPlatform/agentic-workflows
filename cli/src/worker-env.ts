// The `env:` block at the top of a worker is the only part of it a consumer may customise.
// Everything else in the file is the package's, so an update takes the package's file and
// puts the consumer's env values back. This module does that merge.
//
// With a baseline (the package version the consumer installed from) the merge is three-way:
// a value the consumer never touched follows the package when the default changes, and a
// value the consumer changed is kept. Without one it is two-way: every consumer value is kept.

export interface EnvEntry {
  readonly key: string;
  /** Comment and blank lines that precede the key. They belong to the key they describe. */
  readonly leading: readonly string[];
  /** The `  KEY: value` line, followed by any continuation lines of a multi-line value. */
  readonly lines: readonly string[];
}

export interface WorkerEnv {
  readonly present: boolean;
  readonly before: readonly string[];
  readonly entries: readonly EnvEntry[];
  readonly trailing: readonly string[];
  readonly after: readonly string[];
}

export interface WorkerMergeReport {
  /** Consumer values kept because they differ from the package (and from the baseline, when known). */
  readonly keptEnv: readonly string[];
  /** Package defaults applied because the consumer still had the previous default. */
  readonly updatedDefaults: readonly string[];
  /** Keys only the consumer defines, kept at the end of the block. */
  readonly consumerOnlyEnv: readonly string[];
  /** Keys the package removed that the consumer still carried at the old default. */
  readonly droppedEnv: readonly string[];
}

const ENTRY = /^  ([A-Za-z_][A-Za-z0-9_.-]*):(.*)$/;

export function parseWorkerEnv(content: string): WorkerEnv {
  const lines = content.split("\n");
  const none: WorkerEnv = { present: false, before: lines, entries: [], trailing: [], after: [] };
  if (lines[0] !== "---") return none;

  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end === -1) return none;

  const envIndex = lines.findIndex((line, index) => index > 0 && index < end && line === "env:");
  if (envIndex === -1) return none;

  let cursor = envIndex + 1;
  while (cursor < end && (lines[cursor] === "" || lines[cursor]!.startsWith("  "))) cursor += 1;

  const entries: EnvEntry[] = [];
  let leading: string[] = [];
  let current: { key: string; leading: string[]; lines: string[] } | undefined;

  for (const line of lines.slice(envIndex + 1, cursor)) {
    const match = ENTRY.exec(line);
    if (match !== null) {
      if (current) entries.push(current);
      current = { key: match[1]!, leading, lines: [line] };
      leading = [];
    } else if (current && leading.length === 0 && /^   +\S/.test(line)) {
      current.lines.push(line);
    } else {
      leading.push(line);
    }
  }
  if (current) entries.push(current);

  return {
    present: true,
    before: lines.slice(0, envIndex + 1),
    entries,
    trailing: leading,
    after: lines.slice(cursor),
  };
}

export function serializeWorkerEnv(env: WorkerEnv): string {
  if (!env.present) return env.before.join("\n");
  return [
    ...env.before,
    ...env.entries.flatMap((entry) => [...entry.leading, ...entry.lines]),
    ...env.trailing,
    ...env.after,
  ].join("\n");
}

export function entryValue(entry: EnvEntry): string {
  const first = entry.lines[0]!.replace(ENTRY, "$2").trim();
  return [first, ...entry.lines.slice(1).map((line) => line.trim())].join("\n").trim();
}

export function mergeWorkerEnv(
  packageContent: string,
  consumerContent: string,
  baselineContent?: string,
): { content: string; report: WorkerMergeReport } {
  const report = { keptEnv: [] as string[], updatedDefaults: [] as string[], consumerOnlyEnv: [] as string[], droppedEnv: [] as string[] };
  const pkg = parseWorkerEnv(packageContent);
  const consumer = parseWorkerEnv(consumerContent);
  if (!pkg.present || !consumer.present) return { content: packageContent, report };

  const baseline = baselineContent === undefined ? undefined : parseWorkerEnv(baselineContent);
  const consumerByKey = new Map(consumer.entries.map((entry) => [entry.key, entry]));
  const baselineByKey = new Map((baseline?.entries ?? []).map((entry) => [entry.key, entry]));
  const packageKeys = new Set(pkg.entries.map((entry) => entry.key));

  const merged: EnvEntry[] = [];
  for (const entry of pkg.entries) {
    const mine = consumerByKey.get(entry.key);
    if (mine === undefined || entryValue(mine) === entryValue(entry)) {
      merged.push(entry);
      continue;
    }
    const base = baselineByKey.get(entry.key);
    if (base !== undefined && entryValue(base) === entryValue(mine)) {
      // Still the previous default: the package changed it, the consumer never did.
      merged.push(entry);
      report.updatedDefaults.push(entry.key);
      continue;
    }
    merged.push({ key: entry.key, leading: entry.leading, lines: mine.lines });
    report.keptEnv.push(entry.key);
  }

  for (const entry of consumer.entries) {
    if (packageKeys.has(entry.key)) continue;
    const base = baselineByKey.get(entry.key);
    if (base !== undefined && entryValue(base) === entryValue(entry)) {
      report.droppedEnv.push(entry.key);
      continue;
    }
    merged.push(entry);
    report.consumerOnlyEnv.push(entry.key);
  }

  return { content: serializeWorkerEnv({ ...pkg, entries: merged }), report };
}

// Two more per-repository values live outside `env:` because GitHub gives them no other home:
// `runs-on` cannot read the env context, and the engine's gateway URL is read by the engine
// before the workflow's env exists.

function engineEndpoint(content: string): string | undefined {
  return /^    OPENAI_BASE_URL: (.+)$/m.exec(content)?.[1];
}

// Which self-hosted pool a worker's agent jobs run on. gh-aw cannot share runs-on through an
// import, so every worker names it. ubuntu-latest is excluded, being GitHub's own runner, used
// by the deterministic jobs everywhere and chosen by nobody.
function runnerPools(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(/^\s*runs-on(?:-slim)?: (\S+)\s*$/gm)) {
    if (match[1] !== "ubuntu-latest") found.add(match[1]!);
  }
  return [...found];
}

function preserveRunnerPool(packageContent: string, consumerContent: string): string {
  const mine = runnerPools(consumerContent);
  const theirs = runnerPools(packageContent);
  // Only an unambiguous swap. A consumer naming several pools has drifted rather than
  // decided, and guessing which it meant is worse than leaving the package's.
  if (mine.length !== 1 || theirs.length !== 1 || mine[0] === theirs[0]) return packageContent;
  return packageContent.replace(
    /^(\s*runs-on(?:-slim)?: )(\S+)(\s*)$/gm,
    (line, prefix: string, pool: string, tail: string) =>
      pool === "ubuntu-latest" ? line : `${prefix}${mine[0]}${tail}`,
  );
}

/** The package's worker with the consumer's customisable values put back. */
export function mergeWorker(
  packageContent: string,
  consumerContent: string,
  baselineContent?: string,
): { content: string; report: WorkerMergeReport } {
  const { content: envMerged, report } = mergeWorkerEnv(packageContent, consumerContent, baselineContent);
  let result = envMerged;
  const endpoint = engineEndpoint(consumerContent);
  if (endpoint !== undefined) {
    result = result.replace(/^    OPENAI_BASE_URL: .+$/m, `    OPENAI_BASE_URL: ${endpoint}`);
  }
  return { content: preserveRunnerPool(result, consumerContent), report };
}
