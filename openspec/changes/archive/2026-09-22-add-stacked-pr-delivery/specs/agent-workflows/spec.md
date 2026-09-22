## ADDED Requirements

### Requirement: Refine may open a stack for dependent children

When refine splits an issue of 8 or more points into children whose work builds on each other, it
SHALL mark the feature issue with `<!-- stack-root-branch: feat/<number> -->` and, once the root
pull request exists, `<!-- stack-root-pr: <id> -->` markers. It SHALL create the feature branch's
root pull request — the feature spec plus its acceptance journey as a failing e2e, based on the
default branch — and SHALL hand each child over with a `stack-root-branch` marker so the child's
body names the feature branch it belongs to. A split whose children can land independently SHALL
NOT open a stack.

#### Scenario: Stack split

- **WHEN** refine splits an 8+ story whose children depend on each other
- **THEN** the feature issue carries both stack markers, a root pull request is open on
  `feat/<number>` holding the spec and a red journey e2e, and every child issue names the feature
  branch

#### Scenario: Flat split is unchanged

- **WHEN** refine splits a story whose children are independent
- **THEN** no stack markers are written, no root pull request is created, and the split behaves
  exactly as it did before stacks existed

### Requirement: Stacked children implement against the feature branch

The implement workflow SHALL accept a dispatch that names a non-default `ref`, and the router's
`check-stack-branch` job SHALL read the issue's `stack-root-branch` marker and dispatch implement
with `ref` set to the feature branch before the agent runs, because agent sandboxes have no
credentials to fetch or choose branches. The child's `create_pull_request` call SHALL use the
feature branch as its base and SHALL close exactly its own child issue.

#### Scenario: Child implementation

- **WHEN** an issue carrying `stack-root-branch` is dispatched to implement
- **THEN** the run starts from the feature branch, and its pull request targets the feature
  branch and closes exactly that issue

#### Scenario: Flat implementation is unchanged

- **WHEN** an issue without stack markers is dispatched to implement
- **THEN** the run starts from the default branch's tip as resolved today, and its pull request
  targets the default branch

### Requirement: create_pull_request accepts an optional base

The `create_pull_request` safe output SHALL accept an optional `base` parameter whose default is
the repository's default branch, and SHALL reject any base outside the worker's
`allowed-base-branches` allow-list.

#### Scenario: Child pull request base

- **WHEN** an agent calls `create_pull_request` with `base` naming the feature branch
- **THEN** the pull request is created against the feature branch

#### Scenario: Base allow-list holds

- **WHEN** an agent calls `create_pull_request` with a `base` not on the allow-list
- **THEN** the safe output fails and no pull request is created

### Requirement: Merge-gate holds the stack root and closes landed children

Merge-gate SHALL auto-merge a safe child pull request into its base, the feature branch, with the
risk assessment unchanged from default-branch merges, and SHALL close the child issue that pull
request addresses. The root pull request SHALL be held: no disposition, however clean, auto-merges
it; the gate SHALL leave an App-token comment saying the root is held for a human, which raises no
routed events.

#### Scenario: Child auto-merge

- **WHEN** a child pull request's CI is green and its risk assessment is safe
- **THEN** it is squash-merged into the feature branch and its child issue closes

#### Scenario: Root hold

- **WHEN** the root pull request's CI is green and its risk assessment is safe
- **THEN** it is not merged; a comment tells a person the stack root is held and only a human
  may merge it

### Requirement: Housekeeping reconciles stack states without moving labels

Housekeeping SHALL close a child issue whose `implement-pr` marker names a pull request that has
merged, and SHALL close a feature issue whose root pull request has merged with every child
landed. It SHALL report, and never act on: a finished stack that was never announced, a root held
longer than the stale threshold after its announcement, a root closed without merging while
children remain open, and a feature issue whose root pull request cannot be found. It SHALL NOT
move any label, and stack reconciliation SHALL run only when a `stack-root-pr` marker exists.

#### Scenario: Lost child close

- **WHEN** a child's pull request merged into the feature branch but its issue stayed open
- **THEN** housekeeping closes the child issue with an explanatory comment

#### Scenario: Mid-stack is silent

- **WHEN** a stack has open children and an open root
- **THEN** housekeeping does nothing and the digest carries no line for it

## ADDED Requirements (continuing)

### Requirement: Refine splits oversized stories into right-sized children

Refine SHALL split a story estimated 8 or more into at most 6 children of 5 or less. When the
children build on each other it SHALL additionally open a stack per the
*Refine may open a stack for dependent children* requirement; when they do not, the split SHALL
remain marker-free and behave exactly as before.

#### Scenario: Flat split has no stack artifacts

- **WHEN** refine splits a story whose children do not build on each other
- **THEN** no feature branch is created, no root pull request opens, and neither the parent
  nor any child carries a stack marker

#### Scenario: Dependent split opens a stack

- **WHEN** refine splits a story whose children build on each other
- **THEN** the feature branch and root pull request exist and the parent carries
  `stack-root-branch` and `stack-root-pr` markers

### Requirement: Housekeeping closes split parents and reconciles stuck work

Housekeeping SHALL retry stalled work, drop orphaned `pr-pending` labels, close flat split
parents once every child is closed, and delete finished bot-authored branches, with the
single addition of the stack reconciliations defined in the
*Housekeeping reconciles stack states without moving labels* requirement. For a stack feature
issue, the split-parent close SHALL be suppressed: only the root pull request's merge ends a
stack feature issue.

#### Scenario: Flat split parent closes on completion

- **WHEN** every child of a marker-free split is closed
- **THEN** housekeeping closes the split parent as before

#### Scenario: Stack parent survives its children

- **WHEN** every child of a stack feature issue is closed but the root pull request is open
- **THEN** housekeeping leaves the feature issue open
