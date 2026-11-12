// Managed by @plainconceptsplatform/workflows. Source: loops/actions/capture-mockup/capture.mjs. Update with `workflows update --force`; consumer edits may be overwritten.
//
// Checks a UX mockup against the contract in the agent harness (pc-plan-mockup's
// mockup-contract.md) and renders it to PNG. No model runs here: the mockup was written by the
// refine agent or by a person with /plan-mockup, and this only checks and photographs it.
//
//   node capture.mjs validate <mockup-dir>
//     prints {"valid","problems","mockup"} as JSON and exits 0 either way
//   node capture.mjs render <mockup-dir> <out-dir>
//     copies index.html and mockup.json to <out-dir> and writes desktop.png and mobile.png there
//
// The HTML is agent-written, so the browser runs with every request outside the file refused,
// and the action runs it in a container with no network at all.

import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_HTML_BYTES = 400 * 1024;
export const BANNER = "UX mockup: intent, not a spec";
export const VIEWPORTS = [
  { file: "desktop.png", width: 1440, height: 900 },
  { file: "mobile.png", width: 390, height: 844 },
];
const SECTION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATES = new Set(["default", "empty", "loading", "error", "success", "disabled", "mobile"]);

// Literal patterns only: a RegExp built from a variable is a blocking Semgrep finding
// (detect-non-literal-regexp) in every consumer that runs the family scan.
const ATTRIBUTE_PATTERNS = {
  "data-mockup-section": /\bdata-mockup-section\s*=\s*["']([^"']*)["']/gi,
  "data-component": /\bdata-component\s*=\s*["']([^"']*)["']/gi,
};
const attributeValues = (html, name) => [...html.matchAll(ATTRIBUTE_PATTERNS[name])].map((match) => match[1].trim());

// What the contract forbids, as the reasons a person reading the run would want.
export function htmlProblems(html) {
  const problems = [];
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) problems.push(`index.html is over ${MAX_HTML_BYTES / 1024} KB`);
  if (/\b(?:src|href|action|poster|srcset)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html)) problems.push("index.html loads something from another host");
  if (/url\(\s*["']?\s*(?:https?:)?\/\//i.test(html) || /@import\s+(?:url\()?\s*["']?\s*(?:https?:)?\/\//i.test(html)) problems.push("index.html styles load something from another host");
  if (/<script\b[^>]*\bsrc\s*=/i.test(html)) problems.push("index.html loads a script file");
  if (/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i.test(html)) problems.push("index.html links a stylesheet file");
  if (!html.includes(BANNER)) problems.push(`index.html has no "${BANNER}" banner`);
  return problems;
}

export function mockupProblems(mockup, html) {
  const problems = [];
  if (mockup === null || typeof mockup !== "object" || Array.isArray(mockup)) return ["mockup.json is not an object"];
  if (mockup.version !== 1) problems.push("mockup.json version is not 1");
  if (typeof mockup.title !== "string" || !mockup.title.trim()) problems.push("mockup.json has no title");
  const sections = Array.isArray(mockup.sections) ? mockup.sections : [];
  if (sections.length === 0) problems.push("mockup.json lists no sections");
  const ids = sections.map((section) => section?.id);
  for (const id of ids) {
    if (typeof id !== "string" || !SECTION_ID.test(id)) problems.push(`section id ${JSON.stringify(id)} is not kebab-case`);
  }
  const inHtml = attributeValues(html, "data-mockup-section");
  if (inHtml.length === 0) problems.push("index.html has no data-mockup-section");
  const missing = ids.filter((id) => typeof id === "string" && !inHtml.includes(id));
  if (missing.length > 0) problems.push(`sections missing from index.html: ${missing.join(", ")}`);
  const undeclared = [...new Set(inHtml)].filter((id) => !ids.includes(id));
  if (undeclared.length > 0) problems.push(`sections in index.html but not in mockup.json: ${undeclared.join(", ")}`);
  const components = Array.isArray(mockup.components) ? mockup.components : [];
  if (components.length === 0) problems.push("mockup.json maps no components");
  for (const entry of components) {
    if (!entry || typeof entry.component !== "string" || typeof entry.path !== "string" || !entry.component || !entry.path) {
      problems.push(`component entry ${JSON.stringify(entry)} needs a component and a path`);
    } else if (entry.section !== undefined && !ids.includes(entry.section)) {
      problems.push(`component ${entry.component} names unknown section ${entry.section}`);
    }
  }
  if (attributeValues(html, "data-component").length === 0) problems.push("index.html has no data-component");
  for (const state of Array.isArray(mockup.states) ? mockup.states : []) {
    if (typeof state !== "string" || (!STATES.has(state) && !SECTION_ID.test(state))) problems.push(`state ${JSON.stringify(state)} is not a known or kebab-case state`);
  }
  return problems;
}

export async function validate(dir) {
  let html;
  try {
    html = await readFile(join(dir, "index.html"), "utf8");
  } catch {
    return { valid: false, problems: ["index.html is missing"], mockup: null };
  }
  let mockup;
  try {
    mockup = JSON.parse(await readFile(join(dir, "mockup.json"), "utf8"));
  } catch {
    return { valid: false, problems: ["mockup.json is missing or not JSON", ...htmlProblems(html)], mockup: null };
  }
  const problems = [...htmlProblems(html), ...mockupProblems(mockup, html)];
  return { valid: problems.length === 0, problems, mockup };
}

export async function render(dir, out) {
  const { chromium } = await import("playwright-core");
  await mkdir(out, { recursive: true });
  await copyFile(join(dir, "index.html"), join(out, "index.html"));
  await copyFile(join(dir, "mockup.json"), join(out, "mockup.json"));
  const page_url = pathToFileURL(join(out, "index.html")).href;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, javaScriptEnabled: true });
      // The contract already refuses remote URLs; this makes a slip harmless rather than a request.
      await context.route("**/*", (route) => (route.request().url().startsWith("file:") ? route.continue() : route.abort()));
      const page = await context.newPage();
      await page.goto(page_url, { waitUntil: "load", timeout: 30000 });
      await page.screenshot({ path: join(out, viewport.file), type: "png", fullPage: true });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  for (const viewport of VIEWPORTS) await stat(join(out, viewport.file));
}

async function main(argv) {
  const [mode, dir, out] = argv;
  if (mode === "validate" && dir) {
    process.stdout.write(`${JSON.stringify(await validate(dir))}\n`);
    return 0;
  }
  if (mode === "render" && dir && out) {
    await render(dir, out);
    return 0;
  }
  process.stderr.write("usage: capture.mjs validate <mockup-dir> | render <mockup-dir> <out-dir>\n");
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
