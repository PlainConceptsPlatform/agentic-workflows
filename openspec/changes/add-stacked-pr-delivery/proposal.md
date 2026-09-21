# Stacked-PR feature delivery

## Why

A feature refined into children that depend on each other has no clean landing path today. The
children merge to the default branch one at a time, so `main` carries half a feature between
child merges — code that exists, is green, and does not work yet. The only alternative is one
large pull request, which loses the one-child-one-issue review discipline the pipeline is built
on and puts the feature's integration risk inside every child review.

Stacked pull requests solve exactly this: the integration lives on a feature branch nobody
ships from, each child stays a small, independently reviewed change, and the whole feature
reaches `main` in one human-approved merge.

## What Changes

Refine gains a stack mode for splits whose children build on each other:

- The feature issue is stamped with `<!-- stack-root-branch: feat/N -->` and
  `<!-- stack-root-pr: M -->` markers.
- A root pull request opens on the feature branch at split time: the spec plus the feature's
  acceptance journey as a failing e2e, based on the default branch, and held from auto-merge
  for its whole life.
- Each child carries `stack-root-branch` and is implemented on the feature branch: the router
  resolves the feature branch and dispatches implement with that `ref`; the child's pull
  request targets the feature branch and closes exactly its own issue.
- `create_pull_request` accepts a `base` parameter (default remains the default branch).
- Merge-gate auto-merges safe child pull requests into the feature branch, with the risk
  assessment unchanged, and closes each child issue.
- When every child has landed, the router announces on the root pull request that the stack is
  complete and green. A human merges the root, closing the feature issue.
- Housekeeping backstops the races: child issues whose merges outlived their closes are closed,
  and held, orphaned, silently-finished or accidentally-closed stacks get one digest line each.

### Modified Capabilities

- `agent-workflows`: refine (stack split), implement (stack dispatch + base), merge-gate
  (root hold + child close), housekeeping (stack reconciliation).
- `agentic-work-router`: two new deterministic jobs (`check-stack-branch`, `dispatch-implement`)
  and a stack-completion check on child merge.

## Backward compatibility

Every stack behaviour is gated on issue markers. A repository whose issues carry no
`stack-root-branch` / `stack-root-pr` markers sees zero new labels, zero new routes firing, and
byte-for-byte identical flat-mode workflow behaviour.

## Impact

Source of truth: `PlainConceptsPlatform/agentic-workflows` (loops and docs). Consumers receive
it through `workflows update --force`. Consumer-side changes are limited to adopting this
proposal's spec deltas; no new secrets, services or databases.

## Consumers' openspec shape

If the consumer tracks `agent-workflows` / `agentic-work-router` specs, adopt this change as the
delta. The full requirement text lives in `openspec/changes/add-stacked-pr-delivery/specs/` in
the agentic-workflows repository, below.
