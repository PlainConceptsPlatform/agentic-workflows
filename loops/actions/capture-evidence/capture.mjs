// Managed by @plainconceptsplatform/workflows. Source: loops/actions/capture-evidence/capture.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
//
// Replays a change's verification plan against the running app and saves one screenshot per
// waypoint. No model runs here: the plan was written by the agent that implemented the change
// (the harness skill pc-repo-verify), and this only follows it.
//
//   node capture.mjs inspect <repo-root> <plan.md>...
//     prints {"runnable","url","start","plans"} as JSON, so the workflow knows whether to start
//     the app at all and which address to wait for
//   node capture.mjs capture <repo-root> <out-dir> <plan.md>...
//     writes one screenshot per waypoint under <out-dir>/files/, laid out as the repository is:
//     <plan's directory>/evidence/NN-<capture>.jpg beside a manifest.json for that plan, so the
//     publish job copies files/ over the default branch as is. Writes the run's manifest.json and
//     comment.md into <out-dir>
//   node capture.mjs unreached <repo-root> <out-dir> <plan.md>...
//     the app never answered: writes manifest.json and comment.md saying so, and nothing else
//
// The action installs `yaml` and `playwright-core` next to a copy of this file, which is why the
// imports are bare: ESM resolves them from the file's own directory, never from NODE_PATH.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_URL = "http://localhost:3000";
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const STEP_TIMEOUT_MS = Number(process.env.EVIDENCE_STEP_TIMEOUT_MS || 15000);
const NAVIGATION_TIMEOUT_MS = Number(process.env.EVIDENCE_NAVIGATION_TIMEOUT_MS || 45000);
// Stands in for the address the screenshots end up at. Only the publish job knows it, because it
// is the commit that job pushes, so the comment is written here and the publish job fills it in.
export const IMAGE_BASE = "__EVIDENCE_BASE__";
export const MARKER = "<!-- agentic-evidence -->";
// Opens the machine-readable copy of the manifest at the end of the comment, which is what other
// tools read (Project Health shows the screenshots with each issue) instead of parsing markdown.
export const EMBED_MARKER = "agentic-evidence-manifest";
// The folder beside each verification plan that keeps its screenshots.
export const EVIDENCE_DIR = "evidence";
// Stays well under GitHub's 65,536 character comment limit with the markdown above it.
const EMBED_LIMIT = 30000;

const ACTIONS = new Set(["open", "click", "dblclick", "fill", "press", "select", "check", "uncheck", "hover", "wait"]);
const LOCATOR_KEYS = ["role", "text", "label", "placeholder", "testid", "alt", "title", "css"];
const LOAD_STATES = new Set(["load", "domcontentloaded", "networkidle"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const asArray = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
const firstLine = (error) => String(error?.message ?? error).split("\n")[0].trim();

export function slug(value) {
  const text = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text.slice(0, 60) || "waypoint";
}

// The directory a plan lives in, which is where its screenshots are kept. The path comes from the
// pull request's file list, so it is repository-relative; anything that could climb out of the
// repository is refused rather than written.
export function planDir(planPath) {
  const dir = posix.dirname(String(planPath).replace(/\\/g, "/"));
  if (dir === "." || dir.startsWith("/") || dir.split("/").includes("..")) {
    throw new Error(`unsafe plan path ${planPath}`);
  }
  return dir;
}

// The change a plan belongs to, from its directory. Archived changes carry a date prefix.
export function changeName(planPath) {
  return basename(dirname(planPath)).replace(/^\d{4}-\d{2}-\d{2}-/, "") || "change";
}

// ── Parsing ─────────────────────────────────────────────────────────────────────────────────

// A plan is a markdown file with one fenced ```yaml block holding the journey. Plans written
// before the fenced form put the YAML straight into the file, so those are tried as a fallback
// from their first top-level key to the end of the file.
export function extractPlan(markdown, parseYaml) {
  const text = String(markdown).replace(/\r\n/g, "\n");
  const candidates = [...text.matchAll(/^```ya?ml[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1]);
  for (const key of ["environment", "journey"]) {
    const at = text.search(new RegExp(`^${key}:`, "m"));
    if (at >= 0) candidates.push(text.slice(at));
  }

  for (const source of candidates) {
    let doc;
    try {
      doc = parseYaml(source);
    } catch {
      continue;
    }
    if (!isObject(doc)) continue;
    if (doc.status === "not-applicable") return { status: "not-applicable", reason: String(doc.reason ?? "").trim() };
    if (Array.isArray(doc.journey) && doc.journey.length > 0) return normalizePlan(doc);
  }

  const stub = text.match(/^status:\s*not-applicable\s*$/m);
  if (stub) {
    const reason = text.slice(stub.index + stub[0].length).match(/^reason:\s*\|?\s*\n?([\s\S]*)/m);
    return { status: "not-applicable", reason: reason ? reason[1].trim().split("\n")[0].trim() : "" };
  }
  return { status: "no-journey", reason: "the plan has no replayable journey block" };
}

function parseViewport(value) {
  if (isObject(value) && Number(value.width) > 0 && Number(value.height) > 0) {
    return { width: Number(value.width), height: Number(value.height) };
  }
  const match = String(value ?? "").match(/^(\d+)\s*x\s*(\d+)$/i);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : DEFAULT_VIEWPORT;
}

export function normalizePlan(doc) {
  const environment = isObject(doc.environment) ? doc.environment : {};
  const used = new Set();
  const waypoints = doc.journey.map((entry, index) => {
    const raw = isObject(entry) ? entry : {};
    let capture = slug(raw.capture ?? raw.waypoint ?? `waypoint-${index + 1}`);
    while (used.has(capture)) capture = `${capture}-${index + 1}`;
    used.add(capture);
    const steps = [];
    const ignored = [];
    for (const step of [...asArray(raw.steps), ...asArray(raw.arrive)]) {
      const parsed = parseStep(step);
      if (parsed.ignored !== undefined) ignored.push(parsed.ignored);
      else steps.push(parsed);
    }
    return { n: index + 1, capture, expect: String(raw.expect ?? "").trim(), steps, ignored };
  });

  return {
    status: "runnable",
    url: String(doc.url ?? environment.url ?? DEFAULT_URL).trim() || DEFAULT_URL,
    start: String(doc.start ?? environment.start ?? "").trim(),
    viewport: parseViewport(doc.viewport ?? environment.viewport),
    waypoints,
  };
}

function locatorOf(value) {
  if (typeof value === "string") return { text: value };
  if (!isObject(value)) return undefined;
  const key = LOCATOR_KEYS.find((name) => value[name] !== undefined && value[name] !== null);
  if (key === undefined) return undefined;
  const locator = { [key]: String(value[key]) };
  if (key === "role" && value.name !== undefined) locator.name = String(value.name);
  if (value.exact === true) locator.exact = true;
  if (value.nth !== undefined && Number.isInteger(Number(value.nth))) locator.nth = Number(value.nth);
  if (value.last === true) locator.last = true;
  return locator;
}

function parseWait(value) {
  if (typeof value === "number") return { ms: value };
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) return { ms: Number(value) };
    if (LOAD_STATES.has(value)) return { load: value };
    return { text: value };
  }
  if (!isObject(value)) return undefined;
  if (value.load !== undefined) return { load: String(value.load) };
  if (value.ms !== undefined) return { ms: Number(value.ms) };
  if (value.url !== undefined) return { url: String(value.url) };
  if (value.text !== undefined && Object.keys(value).length === 1) return { text: String(value.text) };
  const locator = locatorOf(value);
  return locator ? { locator } : undefined;
}

export function parseStep(step) {
  if (typeof step === "string") return parseCommand(step);
  if (!isObject(step)) return { ignored: String(step) };
  const actions = Object.keys(step).filter((key) => ACTIONS.has(key));
  if (actions.length !== 1) return { ignored: JSON.stringify(step) };
  const action = actions[0];
  const argument = step[action];

  switch (action) {
    case "open":
      return argument ? { action, target: String(argument) } : { ignored: JSON.stringify(step) };
    case "wait": {
      const wait = parseWait(argument);
      return wait ? { action, ...wait } : { ignored: JSON.stringify(step) };
    }
    case "press": {
      const key = isObject(argument) ? argument.key : argument;
      if (!key) return { ignored: JSON.stringify(step) };
      const locator = isObject(argument) ? locatorOf(argument) : undefined;
      return { action, key: String(key), ...(locator ? { locator } : {}) };
    }
    case "fill":
    case "select": {
      const locator = locatorOf(argument);
      if (!locator || !isObject(argument)) return { ignored: JSON.stringify(step) };
      return { action, locator, value: String(argument.value ?? "") };
    }
    default: {
      const locator = locatorOf(argument);
      if (!locator) return { ignored: JSON.stringify(step) };
      const button = isObject(argument) && argument.button ? String(argument.button) : undefined;
      return { action, locator, ...(button ? { button } : {}) };
    }
  }
}

export function tokenize(line) {
  const tokens = [];
  let current = "";
  let inToken = false;
  let quote = null;
  for (const character of line) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      inToken = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
      continue;
    }
    current += character;
    inToken = true;
  }
  if (inToken) tokens.push(current);
  return tokens;
}

// The agent-browser idiom the first plans were written in: `agent-browser find role button click
// --name "Save"`. Every command that only reads (snapshot, network, text) has nothing to replay
// and is reported as ignored rather than failed.
export function parseCommand(line) {
  const tokens = tokenize(String(line).trim());
  if (tokens[0] === "agent-browser") tokens.shift();
  const flags = {};
  const args = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.startsWith("--")) {
      const next = tokens[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[token.slice(2)] = next;
        index++;
      } else {
        flags[token.slice(2)] = true;
      }
    } else {
      args.push(token);
    }
  }

  const [verb, ...rest] = args;
  const ignored = { ignored: String(line).trim() };
  switch (verb) {
    case "open":
    case "goto":
    case "navigate":
      return rest[0] ? { action: "open", target: rest[0] } : ignored;
    case "wait":
      if (typeof flags.load === "string") return { action: "wait", load: flags.load };
      if (typeof flags.text === "string") return { action: "wait", text: flags.text };
      if (typeof flags.url === "string") return { action: "wait", url: flags.url };
      if (rest[0] && /^\d+$/.test(rest[0])) return { action: "wait", ms: Number(rest[0]) };
      return rest[0] ? { action: "wait", locator: { css: rest[0] } } : ignored;
    case "find":
      return parseFind(rest, flags) ?? ignored;
    case "click":
    case "dblclick":
    case "hover":
    case "check":
    case "uncheck":
      return rest[0] ? { action: verb, locator: { css: rest[0] }, ...(typeof flags.button === "string" ? { button: flags.button } : {}) } : ignored;
    case "fill":
    case "type":
      return rest.length >= 2 ? { action: "fill", locator: { css: rest[0] }, value: rest[1] } : ignored;
    case "select":
      return rest.length >= 2 ? { action: "select", locator: { css: rest[0] }, value: rest[1] } : ignored;
    case "press":
    case "key":
      return rest[0] ? { action: "press", key: rest[0] } : ignored;
    default:
      return ignored;
  }
}

function parseFind(rest, flags) {
  const [kind, ...more] = rest;
  let locator;
  let tail;
  switch (kind) {
    case "role":
      locator = { role: more[0], ...(typeof flags.name === "string" ? { name: flags.name } : {}) };
      tail = more.slice(1);
      break;
    case "text":
    case "label":
    case "placeholder":
    case "alt":
    case "title":
    case "testid":
      locator = { [kind]: more[0] };
      tail = more.slice(1);
      break;
    case "first":
      locator = { css: more[0] };
      tail = more.slice(1);
      break;
    case "last":
      locator = { css: more[0], last: true };
      tail = more.slice(1);
      break;
    case "nth":
      locator = { css: more[1], nth: Number(more[0]) };
      tail = more.slice(2);
      break;
    default:
      return undefined;
  }
  if (Object.values(locator).some((value) => value === undefined || Number.isNaN(value))) return undefined;
  if (flags.exact === true) locator.exact = true;

  const [verb, value] = tail;
  switch (verb) {
    case "click":
    case "dblclick":
    case "hover":
    case "check":
    case "uncheck":
      return { action: verb, locator, ...(typeof flags.button === "string" ? { button: flags.button } : {}) };
    case "fill":
    case "type":
      return { action: "fill", locator, value: value ?? "" };
    case "select":
      return { action: "select", locator, value: value ?? "" };
    case "press":
      return value ? { action: "press", locator, key: value } : undefined;
    default:
      return undefined;
  }
}

// ── Replay ──────────────────────────────────────────────────────────────────────────────────

export function describeStep(step) {
  const where = step.locator
    ? Object.entries(step.locator).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ")
    : "";
  switch (step.action) {
    case "open":
      return `open ${step.target}`;
    case "wait":
      if (step.load) return `wait for ${step.load}`;
      if (step.text) return `wait for text ${JSON.stringify(step.text)}`;
      if (step.url) return `wait for url ${step.url}`;
      if (step.ms !== undefined) return `wait ${step.ms}ms`;
      return `wait for ${where}`;
    case "fill":
    case "select":
      return `${step.action} ${where}`;
    case "press":
      return `press ${step.key}${where ? ` on ${where}` : ""}`;
    default:
      return `${step.action} ${where}`;
  }
}

function locate(page, locator) {
  let found;
  const exact = locator.exact === true ? { exact: true } : {};
  if (locator.role !== undefined) found = page.getByRole(locator.role, { ...(locator.name !== undefined ? { name: locator.name } : {}), ...exact });
  else if (locator.text !== undefined) found = page.getByText(locator.text, exact);
  else if (locator.label !== undefined) found = page.getByLabel(locator.label, exact);
  else if (locator.placeholder !== undefined) found = page.getByPlaceholder(locator.placeholder, exact);
  else if (locator.testid !== undefined) found = page.getByTestId(locator.testid);
  else if (locator.alt !== undefined) found = page.getByAltText(locator.alt, exact);
  else if (locator.title !== undefined) found = page.getByTitle(locator.title, exact);
  else found = page.locator(locator.css);
  // Lenient on purpose: this archives what a person would have seen, it is not a test, and a
  // strict-mode error on two matching buttons would lose the screenshot for nothing.
  if (locator.nth !== undefined) return found.nth(locator.nth);
  if (locator.last) return found.last();
  return found.first();
}

export function resolveUrl(target, base) {
  return new URL(target, base.endsWith("/") ? base : `${base}/`).href;
}

async function runStep(page, step, baseUrl) {
  switch (step.action) {
    case "open":
      await page.goto(resolveUrl(step.target, baseUrl), { waitUntil: "load" });
      return;
    case "click":
      await locate(page, step.locator).click(step.button ? { button: step.button } : {});
      return;
    case "dblclick":
      await locate(page, step.locator).dblclick();
      return;
    case "hover":
      await locate(page, step.locator).hover();
      return;
    case "check":
      await locate(page, step.locator).check();
      return;
    case "uncheck":
      await locate(page, step.locator).uncheck();
      return;
    case "fill":
      await locate(page, step.locator).fill(step.value);
      return;
    case "select":
      await locate(page, step.locator).selectOption(step.value);
      return;
    case "press":
      if (step.locator) await locate(page, step.locator).press(step.key);
      else await page.keyboard.press(step.key);
      return;
    case "wait":
      if (step.ms !== undefined) {
        await page.waitForTimeout(Math.min(Math.max(step.ms, 0), 30000));
      } else if (step.load) {
        // An app that keeps a poll or a stream open never goes network-idle. Waiting for it is
        // a courtesy before the screenshot, so running out of patience is not a failure.
        const state = LOAD_STATES.has(step.load) ? step.load : "load";
        await page.waitForLoadState(state, { timeout: STEP_TIMEOUT_MS }).catch(() => {});
      } else if (step.text) {
        await page.getByText(step.text).first().waitFor({ state: "visible" });
      } else if (step.url) {
        await page.waitForURL((url) => url.href.includes(step.url));
      } else if (step.locator) {
        await locate(page, step.locator).waitFor({ state: "visible" });
      }
      return;
    default:
      throw new Error(`unsupported step ${step.action}`);
  }
}

async function replay(browser, plan, outDir, dir) {
  const context = await browser.newContext({ viewport: plan.viewport, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

  const results = [];
  try {
    for (const waypoint of plan.waypoints) {
      const errors = [];
      for (const step of waypoint.steps) {
        try {
          await runStep(page, step, plan.url);
        } catch (error) {
          // The rest of this waypoint depends on the step that failed. The screenshot is still
          // taken: where the journey stopped is the most useful picture there is.
          errors.push(`${describeStep(step)}: ${firstLine(error)}`);
          break;
        }
      }
      // Repository-relative, so the comment, the manifest and the commit all name the same path.
      const file = `${dir}/${EVIDENCE_DIR}/${String(waypoint.n).padStart(2, "0")}-${waypoint.capture}.jpg`;
      let captured = false;
      try {
        await page.screenshot({ path: join(outDir, "files", file), type: "jpeg", quality: 70, fullPage: true });
        captured = true;
      } catch (error) {
        errors.push(`screenshot: ${firstLine(error)}`);
      }
      results.push({
        n: waypoint.n,
        capture: waypoint.capture,
        expect: waypoint.expect,
        file: captured ? file : null,
        reached: errors.length === 0,
        errors,
        ignored: waypoint.ignored,
      });
      console.log(`${dir} ${waypoint.n} ${waypoint.capture}: ${errors.length === 0 ? "ok" : errors.join("; ")}`);
    }
  } finally {
    await context.close();
  }
  return results;
}

// ── Report ──────────────────────────────────────────────────────────────────────────────────

const escapeMarkdown = (text) => String(text).replace(/([\\`*_[\]<>|])/g, "\\$1");

// The manifest other tools read, as an HTML comment so it never renders. JSON can carry `--` only
// inside strings, where `\u002d` means the same character, so escaping it keeps the comment closed.
export function embedManifest(manifest) {
  const compact = (keepExpect) => ({
    version: 2,
    base: IMAGE_BASE,
    sha: manifest.sha ?? "",
    runUrl: manifest.runUrl ?? "",
    ...(manifest.app ? { app: manifest.app } : {}),
    plans: (manifest.plans ?? []).map((plan) => ({
      path: plan.path,
      change: plan.change,
      status: plan.status,
      ...(plan.reason ? { reason: plan.reason } : {}),
      ...(plan.waypoints
        ? {
            waypoints: plan.waypoints.map((w) => ({
              n: w.n,
              capture: w.capture,
              ...(keepExpect && w.expect ? { expect: w.expect } : {}),
              reached: w.reached,
              file: w.file,
            })),
          }
        : {}),
    })),
  });
  let json = JSON.stringify(compact(true));
  if (json.length > EMBED_LIMIT) json = JSON.stringify(compact(false));
  if (json.length > EMBED_LIMIT) return "";
  return `<!-- ${EMBED_MARKER}\n${json.replace(/-(?=-)/g, "\\u002d")}\n-->`;
}

// Reads the embedded manifest back out of a comment body, or null when there is none.
export function readEmbeddedManifest(body) {
  const match = String(body ?? "").match(new RegExp(`<!-- ${EMBED_MARKER}\\n([\\s\\S]*?)\\n-->`));
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function renderComment(manifest) {
  const lines = [MARKER, "## Visual evidence", ""];
  const short = manifest.sha ? manifest.sha.slice(0, 7) : "";
  const run = manifest.runUrl ? ` ([run](${manifest.runUrl}))` : "";
  lines.push(`The verification plan replayed against \`${short}\`, the head of this pull request${run}.`, "");
  if ((manifest.plans ?? []).some((plan) => plan.status === "captured")) {
    lines.push(`The screenshots are kept beside each plan, in its \`${EVIDENCE_DIR}/\` folder on the default branch.`, "");
  }

  if (manifest.app && manifest.app.started === false) {
    lines.push(`Nothing was captured: the app did not answer at ${manifest.app.url} within ${manifest.app.waitedSeconds} seconds of \`${manifest.app.start}\`. The run log has the app's output.`, "");
  }

  for (const plan of manifest.plans) {
    lines.push(`### ${escapeMarkdown(plan.change)}`, "");
    if (plan.status === "not-applicable") {
      lines.push(`No UI surface${plan.reason ? `: ${escapeMarkdown(plan.reason)}` : "."}`, "");
      continue;
    }
    if (plan.status !== "captured") {
      lines.push(`Not replayed: ${escapeMarkdown(plan.reason || plan.status)}.`, "");
      continue;
    }
    const missed = plan.waypoints.filter((waypoint) => !waypoint.reached).length;
    const summary = `${plan.waypoints.length} waypoint${plan.waypoints.length === 1 ? "" : "s"}${missed > 0 ? `, ${missed} did not reach their state` : ""}`;
    lines.push("<details>", `<summary>${summary}</summary>`, "");
    for (const waypoint of plan.waypoints) {
      const heading = `**${waypoint.n}. ${escapeMarkdown(waypoint.capture)}**${waypoint.expect ? `: ${escapeMarkdown(waypoint.expect)}` : ""}`;
      lines.push(heading);
      if (!waypoint.reached) lines.push(`> Stopped at ${escapeMarkdown(waypoint.errors.join("; "))}`);
      if (waypoint.file) lines.push("", `![${escapeMarkdown(waypoint.capture)}](${IMAGE_BASE}/${waypoint.file})`);
      lines.push("");
    }
    lines.push("</details>", "");
  }
  const embedded = embedManifest(manifest);
  if (embedded) lines.push(embedded, "");
  return `${lines.join("\n").trimEnd()}\n`;
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────

async function loadPlans(root, paths, parseYaml) {
  const plans = [];
  for (const path of paths) {
    let plan;
    try {
      plan = extractPlan(await readFile(join(root, path), "utf8"), parseYaml);
    } catch (error) {
      plan = { status: "unreadable", reason: firstLine(error) };
    }
    plans.push({ path, change: changeName(path), ...plan });
  }
  return plans;
}

async function inspect(root, paths) {
  const { parse } = await import("yaml");
  const plans = await loadPlans(root, paths, parse);
  const runnable = plans.filter((plan) => plan.status === "runnable");
  const first = runnable[0];
  return {
    runnable: runnable.length > 0,
    url: first?.url ?? "",
    start: first?.start ?? "",
    plans: plans.map((plan) => ({ path: plan.path, change: plan.change, status: plan.status, waypoints: plan.waypoints?.length ?? 0 })),
  };
}

async function capture(root, outDir, paths) {
  const { parse } = await import("yaml");
  const { chromium } = await import("playwright-core");
  await mkdir(outDir, { recursive: true });
  const plans = await loadPlans(root, paths, parse);
  const runnable = plans.filter((plan) => plan.status === "runnable");
  const manifest = { version: 2, plans: [] };

  const browser = runnable.length > 0 ? await chromium.launch({ headless: true }) : undefined;
  try {
    for (const plan of plans) {
      if (plan.status !== "runnable") {
        manifest.plans.push({ path: plan.path, change: plan.change, status: plan.status, reason: plan.reason ?? "" });
        continue;
      }
      const dir = planDir(plan.path);
      await mkdir(join(outDir, "files", dir, EVIDENCE_DIR), { recursive: true });
      const waypoints = await replay(browser, plan, outDir, dir);
      manifest.plans.push({ path: plan.path, change: plan.change, status: "captured", url: plan.url, waypoints });
    }
  } finally {
    await browser?.close();
  }
  return manifest;
}

async function main(argv) {
  const [mode, root, ...rest] = argv;
  if (mode === "inspect" && root) {
    process.stdout.write(`${JSON.stringify(await inspect(root, rest))}\n`);
    return;
  }
  if (mode === "capture" && root && rest.length > 0) {
    const [outDir, ...paths] = rest;
    const manifest = await capture(root, outDir, paths);
    manifest.sha = process.env.EVIDENCE_SHA ?? "";
    manifest.runUrl = process.env.EVIDENCE_RUN_URL ?? "";
    // Each plan keeps its own record beside its screenshots, so the folder explains itself on the
    // default branch without the pull request comment.
    for (const plan of manifest.plans.filter((p) => p.status === "captured")) {
      const record = { version: 2, sha: manifest.sha, runUrl: manifest.runUrl, plan };
      await writeFile(join(outDir, "files", planDir(plan.path), EVIDENCE_DIR, "manifest.json"), `${JSON.stringify(record, null, 2)}\n`);
    }
    await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(outDir, "comment.md"), renderComment(manifest));
    const shots = manifest.plans.flatMap((plan) => plan.waypoints ?? []).filter((waypoint) => waypoint.file).length;
    console.log(`captured ${shots} screenshot(s)`);
    return;
  }
  if (mode === "unreached" && root && rest.length > 0) {
    // The app never answered: no browser, only the record that says so and why.
    const [outDir, ...paths] = rest;
    const { parse } = await import("yaml");
    await mkdir(outDir, { recursive: true });
    const plans = await loadPlans(root, paths, parse);
    const manifest = {
      version: 2,
      sha: process.env.EVIDENCE_SHA ?? "",
      runUrl: process.env.EVIDENCE_RUN_URL ?? "",
      app: {
        started: false,
        url: process.env.EVIDENCE_APP_URL ?? "",
        start: process.env.EVIDENCE_START ?? "",
        waitedSeconds: Number(process.env.EVIDENCE_WAITED_SECONDS ?? 0),
      },
      plans: plans.map((plan) => ({
        path: plan.path,
        change: plan.change,
        status: plan.status === "runnable" ? "not-run" : plan.status,
        reason: plan.status === "runnable" ? "the app did not start" : plan.reason ?? "",
      })),
    };
    await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(outDir, "comment.md"), renderComment(manifest));
    return;
  }
  throw new Error("usage: capture.mjs inspect <root> <plan>... | capture|unreached <root> <out-dir> <plan>...");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(firstLine(error));
    process.exit(1);
  });
}
