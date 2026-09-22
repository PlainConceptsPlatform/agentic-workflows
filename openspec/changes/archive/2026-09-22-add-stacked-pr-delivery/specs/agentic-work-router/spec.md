## ADDED Requirements

### Requirement: Router routes child-pull-request events by base, not default branch

CI conclusions and merge events on pull requests whose base is not the default branch SHALL route
exactly as default-branch pull requests do: `merge-gate` for CI conclusions on bot pull requests,
`apply-review` for review activity, and the close/merge reconciliation arm for merged pull
requests.

#### Scenario: Child CI failure routes

- **WHEN** a child pull request whose base is `feat/123` reports a failed CI run
- **THEN** the router dispatches merge-gate for that pull request exactly as for a
  default-branch pull request

#### Scenario: Child merge completes the stack

- **WHEN** a child pull request merges into a feature branch
- **THEN** the router runs the stack-completion check: it resolves the feature issue's
  `stack-root-pr` marker, counts that issue's open children, and when the count is zero posts
  the stack-complete announcement on the root pull request with the App token

### Requirement: check-stack-branch resolves the feature branch before dispatch

The router SHALL run a `check-stack-branch` job for implements of issues carrying a
`stack-root-branch` marker: it SHALL verify the feature branch exists and the root pull request
is open, and SHALL dispatch the compiled implement workflow with `ref` set to the feature branch
via the `dispatch-implement` job. Issues without the marker SHALL take the plain implement call,
byte-for-byte the previous path.

#### Scenario: Marker present

- **WHEN** the selected implement issue carries `stack-root-branch: feat/45`
- **THEN** the router dispatches `agent-implement.lock.yml` with `ref: feat/45`

#### Scenario: Marker absent

- **WHEN** the selected implement issue carries no stack markers
- **THEN** the router calls the implement worker directly as before and no stack job produces
  output

#### Scenario: Feature branch or root is gone

- **WHEN** the marker names a branch that no longer exists or a root pull request that is closed
- **THEN** no dispatch happens and the job's step summary says why, so a person can act; the
  issue is not silently retried

### Requirement: Stack completion is announced exactly once

The stack-completion check SHALL be idempotent: before announcing, it SHALL read the root pull
request's comments and skip when a `<!-- stack-complete -->` marker is already present, so
re-merges and racing events produce one announcement. The announcement SHALL be posted with the
App token so the event it raises can route.

#### Scenario: Last child merges

- **WHEN** the final child pull request merges and the count of open children is zero
- **THEN** exactly one stack-complete announcement appears on the root pull request

#### Scenario: Duplicate child-merge events

- **WHEN** two merge events for the same stack fire close together
- **THEN** only one announcement exists on the root pull request afterwards

### Requirement: Stale-work reconciliation covers stacks

The router's stale-work reconciliation SHALL leave stack states to housekeeping's stack section
(digest lines, no label writes), and SHALL NOT delete a feature branch while its root pull
request is open. No new polling cadence SHALL be introduced for stacks.

#### Scenario: Feature branch protection

- **WHEN** branch cleanup sees a feature branch whose root pull request is open
- **THEN** the branch is not deleted

#### Scenario: No new polling

- **WHEN** stacks exist in the repository
- **THEN** no schedule fires that did not fire before stacks existed
