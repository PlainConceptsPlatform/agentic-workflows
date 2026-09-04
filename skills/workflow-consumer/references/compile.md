# Compile, verify, and recover

## Compile

Run the compile script after any change to workflow source, router, shared mechanics, composite
actions, or templates:

```sh
node scripts/compile-agent-workflows.mjs
```

The script wraps `gh aw compile --strict`, patches log levels from DEBUG to ERROR, and stages
regenerated lockfiles. It gates on changed paths so a commit touching only source code does not pay
for a compile.

## What gets generated

| Generated file | From | Committed by consumer? |
|---|---|---|
| `.github/workflows/agent-*.lock.yml` | `.github/workflows/agent-*.md` | Yes |
| `.github/aw/actions-lock.json` | Composite action manifests | Yes |

Generated files are consumer artifacts. Commit them. They are not source; do not hand-edit them.

## CI freshness check

A pull request that changes workflow source must also change the generated lockfiles. The
`agentics-checks` template enforces this:

```bash
gh aw compile --strict
git diff --exit-code -I '^[[:space:]]*GH_AW_INFO_MODEL_COSTS:' -- .github/workflows/*.lock.yml
```

The `-I` flag ignores `GH_AW_INFO_MODEL_COSTS` because model prices change without a source change.
Every other generated line must match.

If the check fails, run `node scripts/compile-agent-workflows.mjs` locally, commit the regenerated
files, and push.

## Verifying the compiled output

After compiling, confirm:

1. Every worker input declared in `on.workflow_call.inputs` matches what the router caller job passes
   in `with:`.
2. Every worker has concrete top-level `env:` defaults. No `env:` value should depend on a shared file
   that is not present.
3. No generated file has been hand-edited. If `git diff` shows changes to a `.lock.yml` that do not
   correspond to a source change, someone edited the lockfile directly. Recompile to fix.
4. The compiled job graph contains the jobs you expect:

```bash
python -c "import yaml,sys; print(sorted(yaml.safe_load(open(sys.argv[1]))['jobs']))" \
  .github/workflows/agent-refine.lock.yml
```

5. Every local composite action manifest does not reference `needs`, `jobs`, or `secrets`:

```bash
grep -oE '\$\{\{[^}]*\}\}' "$manifest" | grep -E '\b(needs|jobs|secrets)\.'
```

## Static checks cannot see everything

Static compilation cannot catch:

- An invalid reusable-workflow call (caller permissions versus worker `permissions: read-all`)
- A missing checkout before a local action
- An artifact write path that applies nothing
- A guard job in `needs` but not in the agent job's `if:`

Verify a narrow real route event before relying on changed automation. The cheapest real check is the
`validate` dispatch operation, which runs the route matrix on a runner without writing anything. The
next cheapest is one label toggle on a known issue.

## Rollback after a bad update

Before a package update, commit or stash consumer work. If `update` reports a managed-file conflict:

1. Compare the ownership header's source path with the local edits.
2. Choose one: keep the local consumer-owned fork (remove the header), transplant the change into a
   source-compatible customization (move the value into the worker's `env:`), or back up then run
   `update --force`.
3. Compile immediately after any force update.
4. Review the generated locks for expected resolved values.
5. Run at least one real route event.

## Common compile problems

| Problem | Fix |
|---|---|
| `Could not run gh aw compile` | Install the gh-aw extension: `gh extension install githubnext/gh-aw` |
| Lockfile freshness check fails after compile | Run `node scripts/compile-agent-workflows.mjs --force` and commit the result |
| Lockfile freshness check fails on every PR | CI is running plain `gh aw compile --strict` instead of the patched script. Both sides must apply the same log-level transform |
| `safe update mode detected unapproved changes` | A new secret or action appeared in the source. Review it, then compile with `--approve` if it is expected |
| A worker is missing from the compiled graph | It was indented one level too deep. Check the source YAML indentation |
