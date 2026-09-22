# Tasks: add-stacked-pr-delivery

## 1. Workers

- [x] 1.1 `agent-refine.md`: stack markers on the feature issue; root pull request safe-output
  (`allowed-branches: ["feat/*"]`, `allowed-base-branches: ["main"]`, preserve-branch-name);
  `stack-root-branch` stamping on children at hand-over.
- [x] 1.2 `agent-implement.md`: `workflow_dispatch` trigger; `allowed-base-branches:
  ["main", "feat/*"]`; marker-gated base instruction in the prompt.
- [x] 1.3 `agent-merge-gate.md`: root-hold guard (no auto-merge of a stack root, App-token held
  comment); child-issue close when a PR whose base is a feature branch merges.
- [x] 1.4 `compile-agent-workflows.mjs`: checkout `ref` ternary for dispatched runs.

## 2. Router

- [x] 2.1 `check-stack-branch` + `dispatch-implement` jobs (marker-gated, fail closed).
- [x] 2.2 Stack-completion check in the merged-PR arm of `detect-pr-conflicts`, idempotent via
  the `<!-- stack-complete -->` comment marker.

## 3. Housekeeping

- [x] 3.1 Section 3 skips stack feature issues (the root PR's merge ends them, not the child
  count).
- [x] 3.2 Section 3b: stack-ready, stack-held, stack-orphaned, stack-root-closed,
  stack-root-missing; auto-close of merged children and of the merged-root feature issue;
  digest section for stacked features.

## 4. Safe-output surface

- [x] 4.1 `skills/workflow-author/references/safe-outputs.md`: document `base` on
  `create_pull_request` and both allow-lists (gh-aw v0.87.5 surface).

## 5. Specs and docs

- [x] 5.1 `docs/diagrams.md`: stack flow diagrams (router pJobs, refine, implement, merge-gate,
  housekeeping) and the "How a feature stacks" section.
- [x] 5.2 `README.md`: housekeeping table row, "Stacked features" section, compat guarantee.
- [x] 5.3 This OpenSpec change: proposal, capability deltas, tasks.

## 6. Validation and release

- [x] 6.1 Flat-mode regression: compile is green (7 succeeded / 8 warnings) and
  `verify-route-matrix.sh` passes (161 assertions, including the stacked-features section and
  the compat-as-absence group); router YAML, maintenance template, and housekeeping script all
  parse clean.
- [ ] 6.2 Dogfood this repository: a real 8+ story split through the full stack lifecycle.
- [ ] 6.3 Version bump + changelog; consumer rollout via `workflows update --force`, Lyceum
  first. `version-bump=minor` fits: `feat:` scopes (refine, router, merge-gate, housekeeping)
  on an existing surface, no breaking marker — repos without markers are untouched.
