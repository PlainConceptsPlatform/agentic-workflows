# The archify-to-Pages site contract

The GitHub Pages site lives in `docs/` at the repository root. It is published by
`.github/workflows/pages.yml` on push to `main` when `loops/docs/diagrams.md` or `docs/**`
changes. The site is a derived view of the canonical Mermaid source in
`loops/docs/diagrams.md`.

## File layout

```
docs/
  .nojekyll                  disables Jekyll; raw HTML/MD serves as-is
  index.html                 hand-authored landing page; links to every diagram
  ownership.md                (existing) consumer-facing ownership doc
  self-hosted-runners.md      (existing) self-hosted runner doc
  diagrams/
    router.html               archify-rendered router diagram
    router.json               archify JSON IR source for the router
    route-chain.html          archify-rendered route-chain diagram
    route-chain.json          archify JSON IR source for the route-chain
    agent-triage.html         one per worker
    agent-triage.json
    ...
```

## Naming convention

The `<worker-stem>` is the `## ` section header in `loops/docs/diagrams.md`, minus `.md` if
present, lowercased.

| Section header | worker-stem | Files |
|---|---|---|
| `## The router` | `router` | `diagrams/router.{json,html}` |
| `### How the routes chain` | `route-chain` | `diagrams/route-chain.{json,html}` |
| `## agent-triage.md` | `agent-triage` | `diagrams/agent-triage.{json,html}` |
| `## agent-refine.md` | `agent-refine` | `diagrams/agent-refine.{json,html}` |
| `## agent-implement.md` | `agent-implement` | `diagrams/agent-implement.{json,html}` |
| `## agent-merge-gate.md` | `agent-merge-gate` | `diagrams/agent-merge-gate.{json,html}` |
| `## agent-apply-review.md` | `agent-apply-review` | `diagrams/agent-apply-review.{json,html}` |
| `## agent-audit.md` | `agent-audit` | `diagrams/agent-audit.{json,html}` |
| `## agent-release.md` | `agent-release` | `diagrams/agent-release.{json,html}` |
| `## housekeeping` | `housekeeping` | `diagrams/housekeeping.{json,html}` |
| `## agentics-app-errors` | `agentics-app-errors` | `diagrams/agentics-app-errors.{json,html}` |
| `## agentics-error-report` | `agentics-error-report` | `diagrams/agentics-error-report.{json,html}` |

## Index page (`docs/index.html`)

Hand-authored, one file, no framework and no build step. It follows platform.plainconcepts.com
closely: the Outfit typeface, its light and dark tokens, a centred column about 1000px wide, a 48px
title, 20px section headings with a muted paragraph, and bordered cards (6px radius, a 16px blue
icon, a title and a muted line). Keep it that restrained. The theme is stored under the same
`archify-theme` key the diagrams read, so a choice made on the landing page carries into every
diagram.

- `<title>Agentic Workflows diagrams</title>`
- Sections, in order:
  - **The router**: an event picker beside the path it takes (classify, authorize, route, worker),
    linking `diagrams/router.html` and the worker's diagram
  - **From issue to merge**: four cards for triage, refine, implement and the merge gate, linking
    `diagrams/route-chain.html`
  - **Seven workers**: tabs, one link per `agent-*.html` in `diagrams.md` order, over one embedded
    viewer; each tab loads that worker's diagram and a one-line fact from its intro in `diagrams.md`
  - **Router and infrastructure**: the router embedded beside cards for `route-chain.html`,
    `housekeeping.html`, `agentics-app-errors.html` and `agentics-error-report.html`
  - **Docs**: `ownership.md`, `self-hosted-runners.md` and `release.md`, linked on GitHub so they
    render (Pages serves `.md` raw because of `.nojekyll`)
  - **Install**: the `npx @plainconceptsplatform/workflows` command and the agent-harness
    prerequisite
- Inline CSS and script. Every link works without the script.

Update `index.html` when a worker is added or removed: the router's routes, the worker tabs and
their `workers` entries in the script, and the cards that name it.

### Embedded diagrams

The landing page embeds the archify pages themselves, not pictures of them: an `<iframe>` on
`diagrams/<stem>.html?embed=1&theme=<light|dark>`. Embed mode hides archify's toolbar and chrome and
leaves the interactive diagram; the page rewrites `theme` when its own theme changes. Each iframe's
`--ratio` is the diagram's SVG `viewBox` width over height, so the frame fits it without scrolling:
update the `diagrams` map in the script when a worker's diagram changes shape.

## `.nojekyll`

An empty file at `docs/.nojekyll`. Disables Jekyll processing so GitHub Pages serves the raw
HTML and JSON files verbatim. Without it, Jekyll would ignore files matching its exclusion
rules (leading underscores, certain extensions).

## Authoring invariants (site-specific)

These are the subset of archify's authoring invariants (see
`.agents/skills/archify/SKILL.md:75-94` and `references/authoring-contract.md`) that matter for
this site. They constrain the JSON IR, not the Mermaid source.

- **`meta.quality_profile`**: always `"showcase"`.
- **`meta.locale`**: always `"en"` (matches the Mermaid labels and repo documentation language).
- **`meta.visual_preset`**: omit (default `classic`). Set `signal-flow`, `blueprint`, or
  `editorial` only if the user explicitly requests that visual style.
- **`meta.subtitle`**: omit. The parent `## agent-<name>.md` section already names the worker.
- **`meta.animation`**: omit (default static). Set `"trace"` only if the user asks for motion.
- **Component types**: use `frontend`, `backend`, `database`, `cloud`, `security`,
  `messagebus`, `external`. The Mermaid node-role table in `references/diagram.md` maps cleanly:

  | Mermaid role | archify type | variant |
  |---|---|---|
  | Trigger (`start`) | `external` | `default` |
  | Action (`action`) | `backend` | `default` |
  | Decision (`decision`) | `security` | `default` |
  | Success terminal (`success`) | `backend` | `emphasis` |
  | Failure terminal (`failure`) | `backend` | `dashed` |
  | Idle terminal (`idle`) | `backend` | `default` |

  Adjust per worker if its domain suggests a better type (e.g. `database` for a storage step,
  `messagebus` for a queue, `cloud` for an infrastructure node).

## Relationship to the Mermaid source

- `loops/docs/diagrams.md` is canonical. It is distributed to consumers via `sourceMappings`
  (`cli/src/catalog-installation.ts:73-78`) and validated by the CI `diagrams` job
  (`.github/workflows/ci.yml:240-285`).
- `docs/diagrams/*.html` and `docs/diagrams/*.json` are derived. They are not distributed to
  consumers and are not in `sourceMappings`.
- If a worker is removed, delete both its `docs/diagrams/<worker>.json` and
  `docs/diagrams/<worker>.html`, and update `docs/index.html`.
- If Mermaid and archify disagree, Mermaid wins. Fix the archify JSON IR to match.

## Exports

Leave archify's default export menu intact. PNG/JPEG/WebP/SVG/WebM export, theme switching,
pan/zoom, search, focus, relationship tracing, and semantic views are reader capabilities of
the generated HTML, not extra authoring work (`.agents/skills/archify/SKILL.md:118-122`).

## Publish

`.github/workflows/pages.yml` deploys `docs/` to GitHub Pages on push to `main` when
`loops/docs/diagrams.md`, `docs/**`, `skills/workflow-docs/**`, or the workflow file itself
changes. No build step runs in CI the committed HTML is the published artifact. `workflow_dispatch`
is available for manual redeploy.
