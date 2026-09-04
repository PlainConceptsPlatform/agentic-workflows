# Standalone worker customization

Every installed `agent-*.md` worker is complete at its own top-level `env:`. No `repo-config` file
exists. Do not add one.

## What each worker owns

Each worker's frontmatter owns these values. Edit them directly after installation when the
repository differs from the defaults:

| Value | Where | Default |
|---|---|---|
| `OPENAI_BASE_URL` | `env:` block | Consumer's OpenAI-compatible gateway URL |
| Labels (`WORKING_LABEL`, `REVIEW_LABEL`, etc.) | `env:` block | `bot-working`, `review` |
| Issue context path | `env: ISSUE_CONTEXT_PATH` | `/tmp/gh-aw/agent/issue-context.json` |
| Prompt rules | `env: REPO_RULES` | Worker-specific, stack-aware base from CLI |
| Required onboarding commands | `env:` block | Worker-specific |
| Model gateway endpoint | `engine.env: OPENAI_BASE_URL` | Consumer's OpenAI-compatible gateway URL |
| Turn budgets | `max-turns`, `max-turn-cache-misses`, `max-ai-credits` | `300`, `3000`, `5000` |
| Verification commands | `env:` block | Stack-aware from CLI |
| Permissions | `permissions:` | `read-all` |
| Runner | `runs-on`, `runs-on-slim` | `ubuntu-latest` |
| Safe Outputs policy | `safe-outputs:` | Worker-specific |
| Timeout | `timeout-minutes` | Worker-specific |

The CLI generates `VERIFY_COMMANDS` and a base `REPO_RULES` from stack detection at install time.
It inspects for `.slnx` and `pnpm-lock.yaml` and injects appropriate values into each worker's
`env:` block. The base `REPO_RULES` provides general architecture guidance (e.g., Clean Architecture
layering for .NET repos). However, route-specific rules require domain knowledge the CLI does not
have. Consumers MUST edit each worker's `REPO_RULES` to add route-specific rules after installation.

## Route-specific REPO_RULES guidance

Each route needs different rules in its `REPO_RULES` env. The CLI provides a stack-aware base, but
the consumer is responsible for adding the route-specific focus areas:

| Route | REPO_RULES should focus on |
|---|---|
| **implement** | Architecture constraints (layering, dependency directions), testing rules, coverage floors, naming conventions, and what must be tested before creating a PR |
| **refine** | Domain model terminology, bounded contexts, acceptance criteria patterns, story structure the repository expects, and what constitutes an implementation-ready user story |
| **direct** | Instruction boundaries, what the agent may and may not do, verification commands to run after execution, and how to report results |
| **apply-review** | Minimal changes principle, preserve architecture, do not refactor beyond the review scope, keep diffs small, and respect the original author's design decisions |
| **merge-gate** | Risk indicators specific to the repository: any calculation engine, audit chain integrity, auth flows, database migrations, and money/financial calculations. What constitutes an auto-merge risk vs a human-review trigger |
| **audit** | What to look for: layer violations, N+1 queries, missing audit logs, security gaps, performance anti-patterns, documentation drift, and what the repository considers a critical vs minor issue |
| **propose** | Product scope, constraints from the project radar, what the project explicitly refuses to become, and how proposed features should align with the product vision |

## Keeping Forge aligned

`OPENAI_BASE_URL` appears in two places in each worker:

1. `env: OPENAI_BASE_URL` (top-level, visible to shell steps and the prompt)
2. `engine.env: OPENAI_BASE_URL` (passed to the OpenCode CLI)

Both must carry the same URL. If you change one, change the other. The endpoint and corresponding
secret are consumer configuration, not package defaults.

## Git identity

Every worker carries these in its top-level `env:` block. Keep them: without them, any `git commit`
inside the agent fails with "unable to auto-detect email".

```yaml
env:
  GIT_AUTHOR_NAME: "github-actions[bot]"
  GIT_AUTHOR_EMAIL: "github-actions[bot]@users.noreply.github.com"
  GIT_COMMITTER_NAME: "github-actions[bot]"
  GIT_COMMITTER_EMAIL: "github-actions[bot]@users.noreply.github.com"
```

## Imports are not configuration inheritance

Shared files (`shared/platform-defaults.md`, `shared/opencode-ci.md`) provide mechanics: network
allowlists, version pins, caches, and the OpenCode CI config merge step. They do not own policy.

The `shared/platform-defaults.md` file no longer carries `VERIFY_COMMANDS`. That value is now
generated per-worker by the CLI during installation, based on stack detection. If a worker requires
verification commands that differ from the generated defaults, edit that worker's `VERIFY_COMMANDS`
in its own `env:` block. Do not add it back to the shared file.

The `shared/opencode-ci.md` file serves as the base template. The CLI appends stack-specific steps
to it during installation: NuGet cache and `dotnet restore` when `.slnx` is found, OpenSpec CLI
install when `openspec/` exists. These are generated from the inspection at install time and become
part of the consumer's copy.

A worker that imports a shared file still owns its own:

- `permissions` (imports do not merge this)
- `engine` and `model` (imports do not merge these)
- `runs-on` and `runs-on-slim` (imports do not merge these)
- `safe-outputs` policy
- `timeout-minutes`
- Trigger inputs (`on.workflow_call`)

If a value is policy, it must live in the worker frontmatter, not in an import. This makes copied
workers readable and portable: reading one file tells you everything the worker does.

## Migration from shared configuration

If upgrading from an older installation that used a shared `repo-config` or relied on inherited
defaults:

1. Move each shared configuration value into every worker that uses it.
2. Set a concrete default for each value in the worker's `env:` block.
3. Remove the old shared configuration reference.
4. Compile: `node scripts/compile-agent-workflows.mjs`.
5. Inspect the generated lockfiles for the expected resolved values.
6. Diff the lockfiles against the previous version to confirm no value was lost.

Preserve consumer changes before running `workflows update --force`. Back up the `.github/workflows/`
directory, run the update, then diff the backup against the new files to identify what the update
restored and what local customisation must be re-applied.

## What not to customise

Do not change these in the consumer repository unless you have a documented reason:

- `name:` (workflow_run matches this)
- Worker inputs (`on.workflow_call.inputs`)
- Router caller job wiring (the router owns this)
- Concurrency groups (the router owns this)
- The compiler script (`scripts/compile-agent-workflows.mjs`)

If you need a different worker shape, fork the worker by removing its ownership header. The package
will stop updating it, and you own it.
