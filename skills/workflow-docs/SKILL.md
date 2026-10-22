---
name: workflow-docs
description: >
  Refresh loop diagrams and the GitHub Pages site. Owns the Mermaid convention in
  loops/docs/diagrams.md and the derived archify-rendered HTML site in docs/diagrams/.
  Load when a worker or its diagram changes, when refreshing the Pages site, or when
  workflow-author reaches its diagram step.
license: MIT
---

# Workflow docs

Use when a loop workflow or its diagram changes. This skill is self-contained. Read reference
files in `references/` within this folder only.

## Two paths, one source of truth

`loops/docs/diagrams.md` is the canonical Mermaid source. It is distributed to consumers via
`sourceMappings` and validated by the CI `diagrams` job. The GitHub Pages site at `docs/` is a
derived view: archify-rendered interactive HTML, one file per worker. When Mermaid and archify
disagree, Mermaid wins.

## When to load

- **Automatically**: `workflow-author` step 5 delegates here. When you reach "Add or update the
  worker's section in `docs/diagrams.md`", load this skill in full before continuing.
- **Directly**: when only the Pages site needs a refresh (no worker change), load this skill and
  follow Path B only.

## Path A Mermaid refresh

Every worker has a corresponding section in `docs/diagrams.md` (installed from
`loops/docs/diagrams.md`). Node roles, class definitions, the Mermaid convention, and the
Checks list are in `references/diagram.md`. `verify-route-matrix.sh` rejects `` ```mermaid ``
blocks in worker prompts; diagrams live in `docs/diagrams.md` only.

When updating a worker's diagram:

1. Read `references/diagram.md` for the node-role table, glyph table, verbatim `classDef` lines,
   and the Checks list.
2. Read the worker's prompt body in `loops/workflows/agent-<name>.md` to understand the branches.
3. Add or update the `## agent-<name>.md` section in `loops/docs/diagrams.md`. Done when every
   check in `references/diagram.md` passes and the diagram matches the prompt body's branches.
4. The CI `diagrams` job (`.github/workflows/ci.yml`) enforces structural parity: one `##
   agent-<name>.md` section per worker, `flowchart TD`, all six `classDef` lines present, every
   styled node used in the body.

## Path B archify HTML refresh (Pages site)

For each `## agent-<name>.md` section in `loops/docs/diagrams.md` (plus the router and the
route-chain), re-author the diagram as fresh archify JSON IR using the `archify` skill's bounded
authoring path. Do **not** mechanically translate Mermaid read it for topology and meaning,
then author fresh IR with new stable IDs, domain wording, and layout.

### Choosing the archify diagram type

| Mermaid shape | archify type | When |
|---|---|---|
| `flowchart TD` with pass/fail/branch nodes | `workflow` | Most workers: triage, refine, implement, merge-gate, apply-review, release |
| Terminal-state-heavy (success/failure/idle) | `lifecycle` | Workers where state transitions dominate (e.g. audit has a backpressure→active→quiet loop) |
| Request/response over time | `sequence` | Only if the request-lifecycle nature dominates (none currently) |
| ETL / data pipeline | `dataflow` | Not applicable to current loop diagrams |
| Component / service map | `architecture` | Not applicable to current loop diagrams |

When ambiguous, run:
```bash
node .agents/skills/archify/bin/archify.mjs guide "<scenario>" --json
```

### Authoring path

1. Load the `archify` skill at `.agents/skills/archify/SKILL.md` for its full bounded authoring
   path. Read one matching schema in `.agents/skills/archify/schemas/`,
   `schemas/common.schema.json`, and one matching JSON example in
   `.agents/skills/archify/examples/`. Read only those files.
2. Artifact first: write the candidate JSON IR to `docs/diagrams/<worker-stem>.json` before
   inspecting renderer internals. Start with one clear main path, short side branches, sparse
   labels, and at most 12 primary nodes.
3. Validate after every candidate edit:
   ```bash
   node .agents/skills/archify/bin/archify.mjs validate <type> docs/diagrams/<worker-stem>.json --quality showcase --json
   ```
   A showcase pass must report all 9 artifact checks with 0 composition errors and 0 warnings.
4. Deliver to `docs/diagrams/<worker-stem>.html`:
   ```bash
   node .agents/skills/archify/bin/archify.mjs deliver <type> docs/diagrams/<worker-stem>.json docs/diagrams/<worker-stem>.html --quality showcase --json
   ```
   A non-zero exit is never success. If validation fails, change only the diagnosed `subject`,
   verify `evidence`, choose from `supportedFixes`, and rerun. Continue focused correction while
   the objective error count reaches a new minimum. If two consecutive rounds do not improve that
   best count, stop and report the unresolved diagnostics truthfully.
5. Keep the JSON IR at `docs/diagrams/<worker-stem>.json` so the next refresh can edit instead of
   starting from scratch.
6. Update `docs/index.html` if a new worker was added or removed, or if a diagram's `viewBox`
   changed (the embed ratios in its script; see `references/site.md`).

### Naming convention

| Section in diagrams.md | archify HTML | archify JSON IR |
|---|---|---|
| `## The router` | `docs/diagrams/router.html` | `docs/diagrams/router.json` |
| `### How the routes chain` | `docs/diagrams/route-chain.html` | `docs/diagrams/route-chain.json` |
| `## agent-triage.md` | `docs/diagrams/agent-triage.html` | `docs/diagrams/agent-triage.json` |
| `## housekeeping` | `docs/diagrams/housekeeping.html` | `docs/diagrams/housekeeping.json` |
| `## agentics-app-errors` | `docs/diagrams/agentics-app-errors.html` | `docs/diagrams/agentics-app-errors.json` |
| `## agentics-error-report` | `docs/diagrams/agentics-error-report.html` | `docs/diagrams/agentics-error-report.json` |

The `<worker-stem>` is the section header minus `.md` (if present), lowercased.

### Authoring invariants for this site

- Omit `meta.visual_preset` (default `classic`).
- Omit `meta.subtitle` (the parent `## agent-<name>.md` section already names the worker).
- Choose `meta.locale: "en"` (matches the Mermaid labels and the repo's documentation language).
- Set `meta.quality_profile: "showcase"`.
- Map the existing Mermaid node roles to archify component types:

  | Mermaid role | archify type | variant |
  |---|---|---|
  | Trigger (`start`) | `external` | `default` |
  | Action (`action`) | `backend` | `default` |
  | Decision (`decision`) | `security` | `default` |
  | Success terminal (`success`) | `backend` | `emphasis` |
  | Failure terminal (`failure`) | `backend` | `dashed` |
  | Idle terminal (`idle`) | `backend` | `default` |

  The archify author chooses precise component types per worker. These mappings are a starting
  point, not a mechanical rule adjust if the worker's domain suggests a better type (e.g.
  `database` for a storage step, `messagebus` for a queue, `cloud` for an infrastructure node).

- Leave archify's default export menu intact (PNG/JPEG/WebP/SVG/WebM are reader capabilities, not
  authoring work).

### Constraints

- Never edit `loops/docs/diagrams.md` and `docs/diagrams/*.html` in the same step on different
  flows. Refresh Mermaid first (Path A), then derive archify from the updated Mermaid (Path B).
- One archify diagram per `## agent-<name>.md` section. The CI invariant (one section per worker)
  extends naturally: one `docs/diagrams/<worker>.html` per worker.
- The archify JSON IR is a derived artifact, not source. If a worker is removed, delete both its
  `docs/diagrams/<worker>.json` and `docs/diagrams/<worker>.html`, and update `docs/index.html`.
- Reproducibility: archify's `deliver` reports SHA-256 + byte counts. Record these in the commit
  message so a reviewer can verify the HTML matches the JSON IR.

## Site assembly

`docs/index.html` is a single hand-authored page in the platform.plainconcepts.dev style that links to
each `docs/diagrams/<worker>.html`, the router, and the route-chain view, embeds the diagrams
themselves in archify's `?embed=1` mode, and links the docs (`ownership.md`, `self-hosted-runners.md`,
`release.md`) on GitHub. `references/site.md` describes its structure. The archify-rendered HTML
files are standalone and need no wrapper.

## Setup

Verify the archify skill is available:
```bash
node .agents/skills/archify/bin/archify.mjs doctor
```
This checks Node >= 18 and archify's bundled validators. No npm install is required inside the
skill package.

## Output

Return the list of updated files, the validation summary for each archify artifact, and the
specification/artifact receipt. Do not claim success for a non-zero command or claim visual
inspection you did not perform.

## References

Load these as needed; do not read all of them up front.

| File | Read it when |
|---|---|
| `references/diagram.md` | Writing the `## Diagram` section in Mermaid. Contains the verbatim `classDef` lines and the Checks list |
| `references/site.md` | The archify-to-Pages site contract: file naming, index page structure, `.nojekyll`, authoring invariants |
