import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The capture script ships as plain JavaScript inside loops/ and installs its own `yaml`, so it is
// loaded by URL here and handed this package's parser. Only the pure half is tested: replaying a
// plan needs a browser and is exercised against a real app instead.
const script = pathToFileURL(resolve(import.meta.dirname, "../../loops/actions/capture-evidence/capture.mjs")).href;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const capture: any = await import(script);

const fenced = (body: string): string => `# Verification plan\n\nProse.\n\n\`\`\`yaml\n${body}\`\`\`\n\nMore prose.\n`;

describe("extractPlan", () => {
  it("reads a fenced journey in the structured form", () => {
    const plan = capture.extractPlan(fenced(`url: http://localhost:5175
start: pnpm dev
viewport: 1024x700
journey:
  - capture: Home Page
    expect: the roster renders
    steps:
      - open: /
      - click: { role: button, name: Alice Admin }
      - fill: { label: Name, value: Probe }
      - wait: { load: networkidle }
      - wait: Saved
`), parse);
    expect(plan.status).toBe("runnable");
    expect(plan.url).toBe("http://localhost:5175");
    expect(plan.start).toBe("pnpm dev");
    expect(plan.viewport).toEqual({ width: 1024, height: 700 });
    expect(plan.waypoints[0].capture).toBe("home-page");
    expect(plan.waypoints[0].steps).toEqual([
      { action: "open", target: "/" },
      { action: "click", locator: { role: "button", name: "Alice Admin" } },
      { action: "fill", locator: { label: "Name" }, value: "Probe" },
      { action: "wait", load: "networkidle" },
      { action: "wait", text: "Saved" },
    ]);
  });

  it("reads the agent-browser commands the first plans were written in", () => {
    const plan = capture.extractPlan(fenced(`environment:
  start: pnpm dev
  url: http://localhost:3000/
journey:
  - id: 1
    arrive:
      - agent-browser open http://localhost:3000/
      - agent-browser find text "Alice Admin" click
      - agent-browser find role button click --name "Revision Offer Probe" --button right
      - agent-browser find label "Why a colleague would want this" fill "Disposable"
      - agent-browser wait --text "is on the marketplace."
      - agent-browser network requests --filter "api/teams"
    waypoint: wp-1-home
    capture: home
    expect: the home renders
`), parse);
    expect(plan.status).toBe("runnable");
    expect(plan.url).toBe("http://localhost:3000/");
    const [waypoint] = plan.waypoints;
    expect(waypoint.steps).toEqual([
      { action: "open", target: "http://localhost:3000/" },
      { action: "click", locator: { text: "Alice Admin" } },
      { action: "click", locator: { role: "button", name: "Revision Offer Probe" }, button: "right" },
      { action: "fill", locator: { label: "Why a colleague would want this" }, value: "Disposable" },
      { action: "wait", text: "is on the marketplace." },
    ]);
    expect(waypoint.ignored).toEqual(['agent-browser network requests --filter "api/teams"']);
  });

  it("recognises a not-applicable stub, fenced or bare", () => {
    expect(capture.extractPlan(fenced("status: not-applicable\nreason: backend only\n"), parse))
      .toEqual({ status: "not-applicable", reason: "backend only" });
    expect(capture.extractPlan("# plan\n\nstatus: not-applicable\nreason: |\n  Nothing in the web app calls it.\n", parse).status)
      .toBe("not-applicable");
  });

  it("reports a prose-only plan as having no journey rather than failing", () => {
    expect(capture.extractPlan("# Verification plan\n\nRead the code and run the suites.\n", parse).status).toBe("no-journey");
  });

  it("keeps capture names unique", () => {
    const plan = capture.extractPlan(fenced("journey:\n  - capture: home\n    steps: [{ open: / }]\n  - capture: home\n    steps: [{ open: /x }]\n"), parse);
    expect(plan.waypoints.map((waypoint: { capture: string }) => waypoint.capture)).toEqual(["home", "home-2"]);
  });
});

describe("planDir", () => {
  it("keeps screenshots beside the plan, in the plan's own directory", () => {
    expect(capture.planDir("openspec/changes/archive/2026-10-04-chat-home/verification-plan.md"))
      .toBe("openspec/changes/archive/2026-10-04-chat-home");
  });

  it("refuses a path that would write outside the repository or at its root", () => {
    for (const path of ["../x/verification-plan.md", "/etc/verification-plan.md", "verification-plan.md", "a/../../b/verification-plan.md"]) {
      expect(() => capture.planDir(path)).toThrow(/unsafe plan path/);
    }
  });
});

const plan = "openspec/changes/archive/2026-10-04-chat-home";
const captured = {
  sha: "0123456789",
  plans: [{ path: `${plan}/verification-plan.md`, change: "chat-home", status: "captured", waypoints: [
    { n: 1, capture: "home", expect: "renders -- fast", file: `${plan}/evidence/01-home.jpg`, reached: true, errors: [] },
    { n: 2, capture: "save", expect: "", file: `${plan}/evidence/02-save.jpg`, reached: false, errors: ["click role=\"button\": Timeout"] },
  ] }],
};

describe("renderComment", () => {
  it("carries the marker and leaves the image base for the publish job to fill", () => {
    const body = capture.renderComment(captured);
    expect(body.startsWith(capture.MARKER)).toBe(true);
    expect(body).toContain(`](${capture.IMAGE_BASE}/${plan}/evidence/01-home.jpg)`);
    expect(body).toContain("2 waypoints, 1 did not reach their state");
    expect(body).toContain("`0123456`");
    expect(body).toContain("in its `evidence/` folder");
  });

  it("embeds a manifest other tools read back, and a `--` cannot close the comment early", () => {
    // Project Health reads this instead of the markdown. A `--` in an expectation would end the
    // HTML comment and spill the JSON into the rendered page.
    const body = capture.renderComment(captured);
    const embedded = body.slice(body.indexOf(`<!-- ${capture.EMBED_MARKER}`));
    expect(embedded.slice(4, -4)).not.toContain("--");
    const manifest = capture.readEmbeddedManifest(body);
    expect(manifest.version).toBe(2);
    expect(manifest.base).toBe(capture.IMAGE_BASE);
    expect(manifest.plans[0].waypoints[0]).toEqual({
      n: 1, capture: "home", expect: "renders -- fast", reached: true, file: `${plan}/evidence/01-home.jpg`,
    });
  });

  it("drops the expectations from the embedded manifest before it outgrows a comment", () => {
    const long = { ...captured, plans: [{ ...captured.plans[0], waypoints: Array.from({ length: 60 }, (_, i) => ({
      n: i + 1, capture: `step-${i}`, expect: "x".repeat(600), file: `${plan}/evidence/${i}.jpg`, reached: true, errors: [],
    })) }] };
    const manifest = capture.readEmbeddedManifest(capture.renderComment(long));
    expect(manifest.plans[0].waypoints).toHaveLength(60);
    expect(manifest.plans[0].waypoints[0].expect).toBeUndefined();
  });

  it("says why nothing was captured when the app never answered", () => {
    const body = capture.renderComment({
      sha: "abc", app: { started: false, url: "http://localhost:3000", start: "pnpm run dev", waitedSeconds: 900 },
      plans: [{ change: "x", status: "not-run", reason: "the app did not start" }],
    });
    expect(body).toContain("did not answer at http://localhost:3000 within 900 seconds");
  });
});
