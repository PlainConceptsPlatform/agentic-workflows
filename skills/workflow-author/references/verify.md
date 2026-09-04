# Compiling, linting, probing, debugging

Verified against gh-aw v0.83.4.

---

## What the checks can and cannot see

Start here, because the gap is where the expensive failures live.

| Check | Catches | Blind to |
|---|---|---|
| `gh aw compile --strict` | Frontmatter errors, dropped fields, stale locks | Anything about how GitHub loads the workflow |
| `actionlint` | Expression syntax, `needs` references, unknown keys, shell in `run:` | Reusable-workflow permission satisfaction, file modes |
| `shellcheck` | Quoting, unused variables, unsafe patterns | Whether the script is executable |
| The route matrix | Every event selects one route, every route has a job | Everything outside the classifier |
| A manifest linter | Contexts a composite action does not have | Nothing else reads those files at all |
| A real run | All of the above, plus the four below | Nothing |

Four failure modes are invisible to every static check, and each one produces a run that did nothing:

1. A caller job granted narrower `permissions` than a worker's `read-all`. GitHub rejects the call
   before creating any job. `startup_failure`, zero jobs, no annotation, no log, no downloadable
   logs.
2. A job using a local action with no `actions/checkout`. Fails at the first step with `Can't find
   'action.yml'`.
3. A script invoked by path with no executable bit. Exit 126 before its first line. A checkout from a
   Windows clone never has one.
4. A guard job in `needs` but not in the dependent's `if:`. Everything is green and the agent ran on
   work the guard rejected.
5. A conclude job downloading an artifact name that does not exist. gh-aw prefixes the agent artifact
   once a workflow becomes `workflow_call`. With `continue-on-error: true` on the download, the miss is
   swallowed, the item count is zero, every apply step is skipped by its `!= '0'` guard, and the job
   reports success having written nothing.

Number 5 is the one to check first after any migration, and it has a cheap assertion:

```bash
gh api repos/OWNER/REPO/actions/runs/<id>/artifacts --jq '.artifacts[].name'
```

Compare that with the name the conclude job asked for. If the run produced `30a4125e-agent` and the
action wanted `agent`, that is the whole bug.

So the definition of done includes one observed real event, not a clean local run. Trigger it
deliberately: toggle the label, dispatch the operation, and read the job list.

---

## The local loop

This package uses a custom compile script that wraps `gh aw compile` and patches log levels:

```bash
node loops/scripts/compile-agent-workflows.mjs          # compile all workflows
node loops/scripts/compile-agent-workflows.mjs --watch   # recompile on save
```

In a consumer repository after installation, the same script lives at `scripts/compile-agent-workflows.mjs`:

```bash
node scripts/compile-agent-workflows.mjs
```

Actions cannot read markdown. `gh aw compile` turns each `.md` into a `.lock.yml`, and that is what
GitHub runs. Both files must be siblings in `.github/workflows/`, and the `.lock.yml` is committed in
the consumer repository.

Only frontmatter changes require recompilation. The markdown body is read at runtime, so a prompt fix
can be edited on github.com directly. That is a convenience and a trap: a body edited on the web is
not reflected in the lock file's hash.

### Compile on commit, not on review

Relying on people to remember to compile does not work. The failure is quiet: the commit looks fine,
and the pull request fails a check that names a file nobody edited. Put it in a pre-commit hook
instead.

The compile script (`loops/scripts/compile-agent-workflows.mjs`) gates on staged paths, so a commit
touching only source does not pay for a compile. It includes `opencode.ci.json`, because the engine
config is merged into the run and changing it changes the lock. And it stages what it regenerates, so
the commit cannot be half-updated.

The hook needs the extension present. Fail with a real message rather than a bare `ENOENT`:

```
Could not run `gh aw compile`. Install it with:
  gh extension install githubnext/gh-aw
```

### Quieten the agent log, and keep the lockfile check honest

gh-aw hardcodes `--log-level DEBUG` for the opencode engine. One run then emits thousands of lines of
`service=bus type=... publishing` and permission rulesets containing kilobytes of inlined JSON. The
line explaining why the run failed is in there somewhere.

The compile script patches the generated locks after compiling:

```js
content.replaceAll('--log-level DEBUG', '--log-level ERROR');
```

Nothing diagnostic is lost. The failures that actually cost time (a `ConfigInvalidError` from a
malformed `opencode.jsonc`, a provider rejection, a firewall verdict) are logged at ERROR. Shell
steps such as `npm install` are unaffected, because the flag only reaches opencode.

Then make the lockfile check apply the same patch. This is the part that is easy to get wrong, and
the resulting breakage is invisible until someone edits a workflow. If CI runs a plain
`gh aw compile --strict` and diffs, it regenerates DEBUG, the committed locks say ERROR, and the check
fails on every workflow change:

```yaml
# wrong: recompiles without the transform, so the diff can never be clean
- run: gh aw compile --strict

# right: both sides apply the same post-processing
- run: node scripts/compile-agent-workflows.mjs --force
```

Give the script a `--force` mode that compiles and patches but stages nothing, and have CI call that.
The check stays strict about everything else. Verify the pairing by running it twice: the only
difference should be `GH_AW_INFO_MODEL_COSTS`, which the freshness check already tolerates because
model prices change without a source change.

The general rule: any deliberate post-processing of a generated file has to be applied on both sides
of the freshness check, or the check is measuring the transform instead of the drift.

### Lint what you authored, not what was generated

```bash
mapfile -t authored < <(
  git ls-files '.github/workflows/*.yml' |
    grep -vE '\.lock\.yml$|agentics-maintenance\.yml$'
)
actionlint "${authored[@]}"

find .github/actions -name '*.sh' -print0 | xargs -0 -r shellcheck -x
bash .github/actions/verify-route-matrix/verify-route-matrix.sh
bash .github/actions/verify-composite-actions/verify-composite-actions.sh
```

Nothing in that list reads a composite `action.yml`, so the last one is not optional. The runner
evaluates `${{ }}` everywhere in a manifest, `description:` included, and a composite action has no
`needs`, `jobs` or `secrets`. The whole check is a parse plus one grep:

```bash
grep -oE '\$\{\{[^}]*\}\}' "$manifest" | grep -E '\b(needs|jobs|secrets)\.'
```

Also assert the compiled job list, because a job indented one level too deep is absorbed into the one
above it and the workflow compiles with it missing:

```bash
python -c "import yaml,sys; print(sorted(yaml.safe_load(open(sys.argv[1]))['jobs']))" \
  .github/workflows/agent-merge-gate.lock.yml
```

The exclusion is not laziness. actionlint does not model gh-aw's frontmatter extensions
(`concurrency.queue`) or the newer `job.workflow_*` context, so it reports false positives on every
generated file. `gh aw compile --strict` already guards those properly. Excluding them keeps the
signal usable.

`shellcheck -x` follows `source` directives, which a test that sources the classifier needs. Add
`# shellcheck source-path=SCRIPTDIR` above the `source` line so it can resolve a path built from
`$BASH_SOURCE`.

### Put it in CI on pull requests

```yaml
on:
  pull_request:
    paths:
      - .github/workflows/*.md
      - .github/workflows/shared/*.md
      - .github/workflows/*.yml
      - .github/workflows/aw.json
      - .github/actions/**
```

The path filter is the part people get wrong. A filter listing `*.md` and `*.lock.yml` but not
`*.yml` leaves the router itself covered by nothing, so changing it runs no checks at all and the
only way to learn whether it works is to merge it and fire an event. That is what a run of
consecutive one-line fix commits looks like from the outside.

Pin the linter and verify the download, the same as any other supply-chain dependency:

```bash
curl -fsSL -o "$TARBALL" \
  "https://github.com/rhysd/actionlint/releases/download/v${VERSION}/actionlint_${VERSION}_linux_amd64.tar.gz"
echo "${ACTIONLINT_SHA256}  $TARBALL" | sha256sum --check --strict
```

### Read the warnings

Zero errors is not the bar. The warnings describe things that fail at runtime rather than at compile
time.

| Warning | Meaning |
|---|---|
| `'tools' section ignored when using engine: opencode` | The whole block was dropped. Delete it |
| `workflow_run trigger should include branch restrictions` | It will fire for every branch |
| `push-to-pull-request-branch: target: "*" requires ... wildcard fetch` | The push will fail at the end of a successful run |
| `target: "*" allows pushing to any PR branch` | Add `required-labels:` or `required-title-prefix:` |
| `recommend using ecosystem identifiers` | Replace hostnames with `dotnet`, `node`, `github` |
| `Action X is outdated` | A pinned action has a newer release |
| `Using experimental ...` | Expected on every compile |
| `safe update mode detected unapproved changes` | A new secret or action appeared. Review, then `--approve` |

`gh aw compile --approve` exists because compilation stopped to ask for a security review when a new
secret or action appeared. Do not reach for it as a reflex; the value of the gate is that someone
looked.

---

## Probing an unfamiliar field

The published docs run ahead of the installed compiler. Do not teach a field you have not seen
compile.

1. Write `.github/workflows/zz-probe.md` with the smallest frontmatter that exercises the field, plus
   a two-line body.
2. `gh aw compile zz-probe`.
3. If it errors, the error names the valid fields. If it compiles, grep the `.lock.yml` to confirm
   the field produced something.
4. Delete both files.

Step 3 is the one that matters, and there are two ways a field can compile yet do nothing.

It was dropped. `tools: cache-memory:` compiles perfectly and produces nothing:

```bash
grep -c 'cache-memory' .github/workflows/zz-probe.lock.yml   # 0
```

It was wired to a job that cannot see it. Check the graph, not the presence of the reference:

```bash
awk '/^  agent:/{f=1} f&&/^    needs:/{g=1;next} g&&/^      - /{print $2; next} g{exit}' \
  .github/workflows/zz-probe.lock.yml
```

Useful greps on a lock file:

```bash
grep -nE '^  [a-z_]+:$' x.lock.yml            # the job graph
grep -n 'permissions: read-all' x.lock.yml    # what the caller must be able to grant
awk '/^  agent:/{f=1} f&&/^    if:/{print; exit}' x.lock.yml   # the real agent gate
```

The expected job graph for a worker:

```
pre_activation   rung 2, if on.steps present
activation       credits guardrail, run metadata
<custom jobs>    rung 4: guard, reserve
agent            rung 3 steps + the model
detection        threat-detection, if enabled
safe_outputs     rung 6
conclude         terminal: agent succeeded
incomplete       terminal: agent did not
conclusion       gh-aw reporting
```

If a job you expected is missing, the field that should have produced it was dropped.

---

## Testing the shell before a run

### Syntax-check what the compiler produced

```bash
python - <<'PY'
import yaml
d = yaml.safe_load(open(".github/workflows/my-workflow.lock.yml"))
for name, job in d["jobs"].items():
    for i, s in enumerate(job.get("steps", [])):
        if "run" in s:
            open(f"./.tmp/{name}-{i}.sh", "w", newline="\n").write(s["run"])
PY
bash -n ./.tmp/*.sh
```

### Syntax-check embedded github-script

An `actions/github-script` body is JavaScript inside YAML, and a typo in it is a runtime failure in a
job that only runs on the unhappy path. Parse every one of them locally:

```javascript
new Function('github', 'context', 'core', `(async () => {\n${body}\n})()`);
```

Extract the `script: |` blocks by indentation and run that over each. It catches syntax errors without
executing anything.

### Run a custom job's script from a directory with no `.git`

A custom job is not checked out. Reproduce that, or `gh`'s repo inference papers over a missing
`--repo`:

```bash
mkdir -p /tmp/nogit && cd /tmp/nogit
GH_TOKEN=$(gh auth token) REPO=owner/repo GITHUB_OUTPUT=/tmp/nogit/out bash /path/to/pick.sh
cat /tmp/nogit/out
```

Assert on `$GITHUB_OUTPUT`, not just the exit code. A script that exits 0 having written
`found=false` when there is work is a silent no-op.

### Mutation-test the route matrix

A test that restates the implementation cannot fail. Prove yours can:

```bash
cp classify-route.sh /tmp/backup
sed -i 's/= "Bot"/= "definitely-not-bot"/' classify-route.sh
bash verify-route-matrix.sh > /dev/null; echo "broken exit=$?"    # expect 1
cp /tmp/backup classify-route.sh
bash verify-route-matrix.sh > /dev/null; echo "clean exit=$?"     # expect 0
```

If the broken run still exits 0, the test is decorative.

---

## Running it

```bash
gh aw run my-workflow --dry-run
gh workflow run work-router.yml -f operation=validate
gh aw trial ./my-workflow.md --logical-repo owner/repo   # in a throwaway repo
```

For a router fleet, the cheapest real end-to-end check is the `validate` operation: it runs the route
matrix on a runner, so it proves the workflow loads, the classifier resolves, checkout works, and the
local action is found. It writes nothing.

The next cheapest is one label toggle on a known issue, which exercises a full worker.

### Rolling out safely

1. `safe-outputs.staged: true`. The run happens, the reasoning happens, nothing is written. This
   catches bad judgement.
2. `gh aw trial`, or a throwaway repository. This catches a broken write path, which staged mode
   cannot see.
3. Real events, narrow scope. Add `stop-after: "+7d"` so the trial expires instead of being
   forgotten.
4. Production. Remove `stop-after`, keep the safe-output surface narrow.

---

## Debugging a run

```bash
gh run list --limit 10 --json databaseId,workflowName,event,status,conclusion,displayTitle \
  --jq '.[] | "\(.workflowName) | \(.event) | \(.status)/\(.conclusion) | \(.displayTitle)"'
gh run view <id> --json conclusion,jobs --jq '{conclusion, jobs:[.jobs[]|{name,conclusion}]}'
gh run view <id> --log-failed
gh aw audit <run-id>
gh aw logs --format markdown
```

`gh aw audit` shows the firewall verdict per domain, token usage, turn count, and the agent's tool
calls. It is the first thing to run when a workflow "did nothing".

If the raw log is thousands of lines of `service=bus ... publishing`, the engine is still on gh-aw's
default DEBUG. See "Quieten the agent log" above; it is worth fixing before the next incident rather
than during one.

### Diagnosing a startup failure

There are no jobs, no annotations, and `/actions/runs/<id>/logs` returns 404. What you have:

```bash
gh api repos/OWNER/REPO/actions/runs/<id> --jq '{conclusion, path, head_sha}'
```

`path` tells you which file GitHub refused. Then work down this list, because the cause is structural
and not in any log:

1. A caller job's `permissions` versus every worker's `permissions: read-all`. This is the most common
   by a distance. `grep -n 'permissions: read-all' *.lock.yml` and compare with the caller grants.
2. Inputs. Every `with:` key must be declared by the called workflow, and every required input must
   be passed.
3. Forbidden keys on a `uses:` job, such as `runs-on`, `env`, `steps` or `timeout-minutes`.
4. YAML duplicate keys. PyYAML's `safe_load` keeps the last one silently; GitHub rejects the file.
   Load with a constructor that reports duplicates.

Confirm the workflow itself still registers, which distinguishes "file is unparseable" from "the call
is invalid":

```bash
gh api repos/OWNER/REPO/actions/workflows --jq '.workflows[] | select(.path|contains("work-router")) | {name,state}'
```

An `active` state with a `startup_failure` run means the file parsed and the call was rejected, which
points straight at 1 or 2.

### Symptoms

| Symptom | Look at |
|---|---|
| `startup_failure`, zero jobs, no log | Caller `permissions` versus the worker's `read-all`. Then inputs |
| `Can't find 'action.yml'` | A job used `./.github/actions/...` without `actions/checkout` first |
| Exit code 126, no output | No executable bit. Invoke as `bash path/to.sh` and `git update-index --chmod=+x` |
| `require is not defined in ES module scope` | A `.js` helper in a `"type": "module"` repo. Rename to `.cjs` |
| A guard rejected the work but the agent ran | The guard is in `needs` but not in the dependent's `if:` |
| `Unrecognized named-value`, job fails in ~1s | An `action.yml` used `needs`, `jobs` or `secrets`, possibly only in a `description:` |
| A job you wrote is not in the compiled graph | It was indented one level too deep and YAML absorbed it into the job above |
| Agent emitted output, every job green, nothing written | Compare the run's artifact names with what `conclude` downloaded. Expect a prefix |
| The agent log shows `{"result":"success"}` per safe output but the issue is untouched | Same. `staged: true` means gh-aw validated and stored them; applying them is your job |
| Workflow never fires | `workflow_run.workflows` versus the target's `name:` |
| Run skipped, not failed | A gate output was false. That is the designed behaviour for "no work" |
| Prompt says `issue #` with no number | A `needs.pre_activation.outputs.*` reference |
| `fatal: not a git repository` in a custom job | A `gh` call without `--repo` |
| The bot triggers itself repeatedly | An App-token write fired the event. `GITHUB_TOKEN` writes do not |
| Three runs for one human action | Same cause, benign version. Two classify to `none` |
| Every run on one issue has the same title | GitHub defaults to the issue title. Set `run-name` |
| A `gh api` state comparison never matches | `gh api` returns lowercase (`open`), `gh issue view` returns uppercase (`OPEN`) |
| A bot's PR is treated as a human's | A `*[bot]` login match. `gh pr list` reports an App as `app/name`; use `.author.is_bot` or GraphQL `author.__typename` |
| Agent stalls, then times out | `network.allowed` missing `forge.plainconcepts.com` |
| Agent hunts for a tool it lacks | The prompt asks it to do a write instead of proposing one |
| Safe output silently absent | `threat-detection` blocked it, the type was never declared, or `max` was 1 |
| Push fails after a good run | `target: "*"` without `checkout.fetch: ["*"]` |
| Cache or memory does nothing | `tools:` under opencode. It was dropped |
| PR opens with a `REQUEST_CHANGES` review | `protected-files` fired. That is correct |

### When the model did something odd

Read the prompt as the model received it. `gh aw audit` shows it, including interpolated values and
resolved `{{#if}}` blocks. Two recurring causes:

- Documentation leaked into the prompt. A `## Diagram` section without the exclusion line, or
  explanation that belonged in `description:`.
- The model was asked to decide something it could not know, or something a job had already decided
  and then contradicted. If the prompt says "the conclusion above is the answer", make sure the job
  above actually passed the conclusion through.

---

## Before deleting a workflow

Two things make a live workflow look dead.

A `workflow_call`-only workflow never appears in the Actions tab. Find its callers:

```bash
grep -rn 'uses: \./\.github/workflows/' .github/workflows/*.yml
```

A `workflow_run` consumer is referenced by workflow name, not filename:

```bash
grep -rn -A4 'workflow_run:' .github/workflows/*.yml .github/workflows/*.md
```

The same reachability question applies to composite actions, and the answer is usually worse:

```bash
for a in $(ls .github/actions); do
  n=$(grep -rl "actions/$a" .github --include=*.yml --include=*.md | grep -v "^.github/actions/$a/" | wc -l)
  [ "$n" -eq 0 ] && echo "UNREFERENCED: $a"
done
```

A directory of composite actions accumulates dead entries faster than workflows do, because nothing
fails when one stops being called. Run that check whenever you delete a route.

Also audit for unpinned action references, since nothing else will:

```bash
grep -rhoE 'uses: [a-zA-Z][^ #]*' .github/workflows/*.yml .github/actions/*/*.yml |
  grep -v '@[0-9a-f]\{40\}$' | sort -u
```

`.lock.yml` files are compiled artifacts, not workflows. Handle them at the display layer:

```gitattributes
.github/workflows/*.lock.yml linguist-generated=true merge=ours
```

---

## Repository maintenance

`gh aw compile` generates `agentics-maintenance.yml`. Do not hand-edit it. It gives you
`create_labels` (creates every label the workflows reference), `disable` / `enable` (a kill switch for
the whole fleet), `activity_report`, `forecast`, and `safe_outputs` (replays a run's safe outputs).

Configure its runner in `.github/workflows/aw.json`:

```json
{ "maintenance": { "runs_on": "ubuntu-latest" } }
```

`gh aw compile --dependabot` generates a `dependabot.yml`. Platform repositories do not use
Dependabot, so do not pass that flag, and pin every action reference by hand instead.

---

## Keeping the locks honest in CI

```bash
gh aw compile --strict
git diff --exit-code -- .github/workflows/*.lock.yml
```

Compilation is not fully reproducible: `gh aw compile` embeds model prices in
`GH_AW_INFO_MODEL_COSTS`, and those figures move. A drift check has to ignore that one key and
compare every other generated line:

```bash
git diff --exit-code -I '^[[:space:]]*GH_AW_INFO_MODEL_COSTS:' -- .github/workflows/*.lock.yml
```

Worth asserting in the same job: that every `workflow_run.workflows` entry resolves to a real `name:`,
and that every route in the classifier has a job in the router. Both failures are otherwise silent.

---

## Source repository policy

In this source repository, generated `*.lock.yml` and `actions-lock.json` stay untracked. The compile
script and `gh aw compile` generate them in `loops/workflows/` during development and testing, but
they are not committed. Consumers compile their own locks after installation.

Do not commit generated artifacts to `loops/`. The `.gitignore` in this repository excludes them.
