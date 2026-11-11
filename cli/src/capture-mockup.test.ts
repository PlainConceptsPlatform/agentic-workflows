import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

// The mockup script ships as plain JavaScript inside loops/. Only the contract check is tested
// here: rendering needs the Playwright image and is exercised by a real refine run.
const script = pathToFileURL(resolve(import.meta.dirname, "../../loops/actions/capture-mockup/capture.mjs")).href;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const capture: any = await import(script);

const html = (body: string): string =>
  `<!doctype html><html><head><style>:root{--primary:#2f69ff}</style></head><body><div class="banner">${capture.BANNER}</div>${body}</body></html>`;

const goodHtml = html(
  `<section data-mockup-section="timeline"><span data-component="apps/web/src/shared/ui/badge.tsx">Approved</span></section>`,
);
const goodMockup = {
  version: 1,
  title: "Claim timeline",
  issue: 42,
  designSource: "DESIGN.md",
  sections: [{ id: "timeline", purpose: "Every status change" }],
  components: [{ section: "timeline", element: "Status chip", component: "Badge", path: "apps/web/src/shared/ui/badge.tsx" }],
  states: ["empty", "mobile"],
};

async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mockup-"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

describe("validate", () => {
  it("accepts a mockup that meets the contract", async () => {
    const result = await capture.validate(await folder({ "index.html": goodHtml, "mockup.json": JSON.stringify(goodMockup) }));
    expect(result.problems).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("refuses a folder without index.html or a readable mockup.json", async () => {
    expect((await capture.validate(await folder({ "mockup.json": "{}" }))).problems).toEqual(["index.html is missing"]);
    const broken = await capture.validate(await folder({ "index.html": goodHtml, "mockup.json": "{ not json" }));
    expect(broken.valid).toBe(false);
    expect(broken.problems).toContain("mockup.json is missing or not JSON");
  });
});

describe("htmlProblems", () => {
  it("refuses anything loaded from another host, because the render has no network", () => {
    const problems = (body: string): string[] => capture.htmlProblems(html(body));
    expect(problems('<script src="https://cdn.example.com/tailwind.js"></script>')).toEqual(
      expect.arrayContaining(["index.html loads something from another host", "index.html loads a script file"]),
    );
    expect(problems('<link rel="stylesheet" href="theme.css">')).toContain("index.html links a stylesheet file");
    expect(problems('<img src="//images.example.com/a.png">')).toContain("index.html loads something from another host");
    expect(problems('<div style="background:url(https://example.com/a.png)"></div>')).toContain(
      "index.html styles load something from another host",
    );
  });

  it("keeps in-page links and inline SVG", () => {
    expect(capture.htmlProblems(html('<a href="#filters">Filters</a><svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toEqual([]);
  });

  it("requires the intent banner, so nobody mistakes the picture for a spec", () => {
    expect(capture.htmlProblems("<html><body><section data-mockup-section=\"a\"></section></body></html>")).toEqual([
      `index.html has no "${capture.BANNER}" banner`,
    ]);
  });

  it("refuses a file over the size cap", () => {
    expect(capture.htmlProblems(html("x".repeat(capture.MAX_HTML_BYTES)))).toContain("index.html is over 400 KB");
  });
});

describe("mockupProblems", () => {
  it("keeps the sections in mockup.json and the HTML in step", () => {
    const extra = { ...goodMockup, sections: [...goodMockup.sections, { id: "filters", purpose: "Narrow the list" }] };
    expect(capture.mockupProblems(extra, goodHtml)).toContain("sections missing from index.html: filters");
    const undeclared = html('<section data-mockup-section="timeline"></section><aside data-mockup-section="totals" data-component="new:Totals"></aside>');
    expect(capture.mockupProblems(goodMockup, undeclared)).toContain("sections in index.html but not in mockup.json: totals");
  });

  it("requires a component map, because the map is what implement builds from", () => {
    expect(capture.mockupProblems({ ...goodMockup, components: [] }, goodHtml)).toContain("mockup.json maps no components");
    expect(capture.mockupProblems({ ...goodMockup, components: [{ component: "Badge" }] }, goodHtml)[0]).toMatch(/needs a component and a path/);
    expect(capture.mockupProblems({ ...goodMockup, components: [{ ...goodMockup.components[0], section: "nowhere" }] }, goodHtml)).toContain(
      "component Badge names unknown section nowhere",
    );
  });

  it("refuses ids and states the workflow cannot link to", () => {
    const bad = { ...goodMockup, sections: [{ id: "Time Line" }], states: ["Sort Of Empty"] };
    const problems = capture.mockupProblems(bad, html('<section data-mockup-section="Time Line" data-component="new:X"></section>'));
    expect(problems).toContain('section id "Time Line" is not kebab-case');
    expect(problems).toContain('state "Sort Of Empty" is not a known or kebab-case state');
  });

  it("refuses an unversioned or untitled mockup", () => {
    expect(capture.mockupProblems({ ...goodMockup, version: 2, title: "" }, goodHtml)).toEqual(
      expect.arrayContaining(["mockup.json version is not 1", "mockup.json has no title"]),
    );
    expect(capture.mockupProblems([], goodHtml)).toEqual(["mockup.json is not an object"]);
  });
});
