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

/** The `env:` block of a worker, which lives inside the markdown frontmatter. */
export function parseWorkerEnv(content: string): WorkerEnv {
  const lines = content.split("\n");
  if (lines[0] !== "---") return absent(lines);

  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end === -1) return absent(lines);

  return parseEnvBlock(lines, lines.findIndex((line, index) => index > 0 && index < end && line === "env:"));
}

/** The top-level `env:` block of a plain YAML workflow, such as the router. */
export function parseYamlEnv(content: string): WorkerEnv {
  const lines = content.split("\n");
  return parseEnvBlock(lines, lines.indexOf("env:"));
}

function absent(lines: readonly string[]): WorkerEnv {
  return { present: false, before: lines, entries: [], trailing: [], after: [] };
}

function parseEnvBlock(lines: readonly string[], envIndex: number): WorkerEnv {
  if (envIndex === -1) return absent(lines);

  // The block runs to the first line that is neither blank nor indented into it. That is the
  // closing `---` of a frontmatter and the next top-level key of a plain YAML file alike.
  let cursor = envIndex + 1;
  while (cursor < lines.length && (lines[cursor] === "" || lines[cursor]!.startsWith("  "))) cursor += 1;

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

// A value that is present but says nothing: empty, or empty quotes.
function isBlank(value: string): boolean {
  return value === "" || value === '""' || value === "''";
}

export function mergeWorkerEnv(
  packageContent: string,
  consumerContent: string,
  baselineContent?: string,
  parse: (content: string) => WorkerEnv = parseWorkerEnv,
): { content: string; report: WorkerMergeReport } {
  const report = { keptEnv: [] as string[], updatedDefaults: [] as string[], consumerOnlyEnv: [] as string[], droppedEnv: [] as string[] };
  const pkg = parse(packageContent);
  const consumer = parse(consumerContent);
  if (!pkg.present || !consumer.present) return { content: packageContent, report };

  const baseline = baselineContent === undefined ? undefined : parse(baselineContent);
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
    // An empty value is the absence of a choice, not a choice of nothing. Treating it as the
    // consumer's is how `VERIFY_COMMANDS: ""` survived in all four consuming repositories with
    // no baseline to compare against, leaving the merge gate pushing repairs it had verified
    // with an empty command block. If the package has something and the consumer has nothing,
    // the package wins.
    if (isBlank(entryValue(mine)) && !isBlank(entryValue(entry))) {
      merged.push(entry);
      report.updatedDefaults.push(entry.key);
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

// The runner pool used to be preserved from the consumer here: a repository naming a single
// non-ubuntu pool had every worker rewritten to it. That is how Pliny-Bot ended up running
// triage, refine, implement, apply-review and audit on RunnerLandingZone while its merge-gate
// and release stayed on agents-arc -- the pool was applied to the workers installed at the time
// and never to the ones added later, and nothing reported the split. The pool is package-owned
// now: the agent jobs belong on the Azure fleet (agents-arc, runner group `agentic`), and the
// router and release worker name RunnerLandingZone. The route matrix asserts both, so a repo
// cannot drift back without a red run. Per the standing rule for this package, anything a
// consumer really must vary belongs in `env:` at the top of the file, not in `runs-on`.

// GitHub evaluates no expression in a `workflow_run.workflows:` list or in a `cron:`, so the two
// router values that are also needed there cannot be read from `env:` at those two lines. The
// installer copies them in instead, which is what keeps the pair in step across an update; the
// route matrix asserts the copies still agree.
const CI_NAME_TRIGGER = /^(\s*workflows: \[")[^"]*("\]\s*)$/m;
const AUDIT_CRON_LINE = /^(\s*- cron: ")[^"]*(" # audit slot.*)$/m;

/** Copy the router's own `env:` values into the two literal lines that cannot read them. */
export function mirrorRouterLiterals(router: string): string {
  const values = new Map(parseYamlEnv(router).entries.map((entry) => [entry.key, unquote(entryValue(entry))]));

  const ciName = values.get("CI_WORKFLOW_NAME");
  const auditCron = values.get("AUDIT_CRON");
  let result = router;
  if (ciName !== undefined) result = result.replace(CI_NAME_TRIGGER, `$1${ciName}$2`);
  if (auditCron !== undefined) result = result.replace(AUDIT_CRON_LINE, `$1${auditCron}$2`);
  return result;
}

function unquote(value: string): string {
  const match = /^(["'])([\s\S]*)\1$/.exec(value);
  return match === null ? value : match[2]!;
}

/** The package's router with the consumer's `env:` values put back and mirrored into place. */
export function mergeRouter(
  packageContent: string,
  consumerContent: string,
  baselineContent?: string,
): { content: string; report: WorkerMergeReport } {
  const { content, report } = mergeWorkerEnv(packageContent, consumerContent, baselineContent, parseYamlEnv);
  return { content: mirrorRouterLiterals(content), report };
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
  return { content: result, report };
}
