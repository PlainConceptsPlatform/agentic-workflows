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

Hand-authored, one file, no framework and no build step. It follows the Plain Concepts Platform look
(platform.plainconcepts.com): the Outfit typeface, the `--pc-blue-*` and neutral tokens, light and dark
themes. The theme is stored under the same `archify-theme` key the diagrams read, so a choice made on
the landing page carries into every diagram.

- `<title>Agentic Workflows diagrams</title>`
- The same four groups, each its own section:
  - **Router**: the hero holds the Work Router fragment (pick an event, see the route it takes) and
    links `diagrams/router.html`; the "Everything around the seven workers" table links
    `diagrams/router.html` and `diagrams/route-chain.html`
  - **Workers**: the "Seven workers" pills, one link per `agent-*.html` in `diagrams.md` order. Each
    pill loads that worker's diagram into the embedded viewer and shows a one-line fact taken from the
    worker's intro in `diagrams.md`
  - **Infrastructure**: `housekeeping.html`, `agentics-app-errors.html`, `agentics-error-report.html`
    in the same table
  - **Docs**: `ownership.md`, `self-hosted-runners.md` and `release.md`, linked on GitHub so they
    render (Pages serves `.md` raw because of `.nojekyll`)
- The "From issue to merge" strip shows one sample issue at four stages. It is illustrative content;
  keep it in step with the route chain when triage, refine, implement or the merge gate change.
- Inline CSS and script. Every link works without the script; the script only adds the router
  fragment, the worker switcher, entrances and the theme toggle, all with a reduced-motion fallback.

Update `index.html` when a worker is added or removed: the router fragment's routes, the worker list,
its `facts` and `names` entries in the script, and the footer columns. The link text is the section
header from `diagrams.md` (e.g. "agent-triage.md" becomes "Triage").

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
