---
# Managed by @plainconceptsplatform/workflows. Source: loops/docs/diagrams.md. Update with workflows update --force; consumer edits may be overwritten.
---
# Diagrams

One picture per route, plus the router that chooses between them.

These used to live at the bottom of each worker's markdown file. Everything below a worker's
frontmatter is the prompt, so each diagram was sent to the model on every run and then explicitly
skipped by a closing instruction telling it to ignore the section. They were about 240 lines across
the eight workers, and in the release worker's case 21 of its 48 prompt lines. They are documentation
for people, so they live here, and `verify-route-matrix.sh` fails if one reappears in a prompt.

Every diagram uses the same shapes and the same palette, so reading one teaches you the rest:

| Shape | Means |
|---|---|
| Rounded, indigo | a job that does something |
| Square, amber | a decision the workflow or the agent makes |
| Doubled circle, green | a terminal state that made progress |
| Doubled circle, red | a terminal state that needs a person |
| Doubled circle, dark | nothing to do, the run ends idle |
| Dotted arrow | the unhappy path |

Each worker diagram also names the rung each stage sits on, from the determinism ladder in
`skills/workflow-author`: the lower the rung, the cheaper and more reproducible the decision.

---

## The router

Every trigger the repository has arrives here, and exactly one thing happens per event. Nothing
else in the system subscribes to a public event, which is what makes a route addable or removable
without touching the others.

```mermaid
flowchart TD
    ev{"One GitHub event"} --> classify
    classify["classify (rung 1)<br/>pure shell, no network<br/>one event in, one route out"] --> authorize
    authorize{"authorize (rung 1)<br/>Write permission, or<br/>read only?"}
    authorize -->|"human, trusted"| work
    authorize -->|"read only"| triageOnly
    authorize -.->|"no permission"| idle
    work{"route"} -->|refine| wRefine
    work -->|implement| wImpl
    work -->|apply-review| wReview
    work -->|merge-gate| wGate
    work -->|audit| wAudit
    work -->|release| wRelease
    triageOnly("dispatch-triage<br/>re-enters as the App, so the<br/>worker sees a trusted actor") --> wTriage
    wRefine("agent-refine")
    wImpl("agent-implement")
    wReview("agent-apply-review")
    wGate("agent-merge-gate<br/>one lock for the whole repo")
    wAudit("agent-audit")
    wRelease("agent-release")
    wTriage("agent-triage")
    classify -.->|"cron or dispatch"| plumbing
    plumbing["deterministic jobs<br/>no model runs in any of these"] --> pJobs
    pJobs("bot-approve · audit-close<br/>cleanup-artifacts · validate<br/>reconcile-bot-pr-runs · merge-train · land-stack-child<br/>check-stack-branch · dispatch-implement")
    idle(("Idle<br/>run ends, ~10s, every job skipped"))

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef idle fill:#202c40,stroke:#738198,stroke-width:2px,color:#ffffff
    class ev start
    class classify,triageOnly,plumbing,pJobs,wRefine,wImpl,wReview,wGate,wAudit,wRelease,wTriage action
    class authorize,work decision
    class idle idle
```

A run still appears for every matching event even when the router decides nothing downstream
happens; those cost about ten seconds with every job skipped. Reducing the count means generating
fewer events, not adding more guards.

### How the routes chain

```mermaid
flowchart LR
    open("Issue opened") --> triage
    triage{"triage<br/>read-only opener"} -->|pass| refine
    triage -.->|block| closed(("Closed"))
    triage -.->|needs-info| author("Author replies") --> triage
    write("Write+ user<br/>self-labels") --> refine
    refine{"refine<br/>estimate in points"} -->|"3 to 5"| implement
    refine -->|"8 or more"| split("Split into children") --> refine
    refine -.->|questions| author
    implement("implement<br/>branch, PR, closes the issue") --> ci("CI")
    person("A person opens a PR") --> ci
    ci --> train{"merge train<br/>oldest PR first,<br/>one at a time"}
    train -.->|"green, behind main"| update("Merge main in") --> ci
    train --> gate{"merge-gate"}
    gate -->|merge| merged(("Merged"))
    merged -->|"next PR"| train
    gate -.->|"CI failed or conflict"| fix("Fix, push, CI again") --> ci
    gate -.->|".github, secrets<br/>or 10000+ lines"| human(("Human review"))
    review("Someone reviews the PR") --> applyReview("apply-review") --> ci
    audit("audit, weekly") -->|"files one issue"| refine

    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef failure fill:#fff0f0,stroke:#ef2929,stroke-width:2px,color:#8b1a1a
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    class open,write,review,audit,person start
    class refine,split,implement,ci,fix,applyReview,author,update action
    class triage,gate,train decision
    class human,closed failure
    class merged success
```

Audit creates work rather than consuming it, and files into `refine` rather than straight to
`implement`, so a report of several unrelated findings becomes one properly sized issue per finding
instead of one pull request that has to fix them all.

### The merge train

One pull request moves at a time, the lowest number first, whoever opened it. Everything else waits
untouched, so a merge never invalidates work in flight. A pull request a person has to decide on is
passed by, so it never blocks the line. The train ticks on every merge, every CI completion, after
every gate, and hourly as the fallback.

```mermaid
flowchart TD
    trainTick("A merge, a CI verdict,<br/>a finished gate, or the hour") --> trainLive
    trainLive{"A gate already<br/>on the belt?"}
    trainLive -.->|yes| trainWait
    trainLive -->|no| trainNext
    trainNext{"Oldest open PR from this repo,<br/>bot or writer, not draft,<br/>no hold label"}
    trainNext -.->|"none left"| trainIdle
    trainNext --> trainPark
    trainPark{"Parked on this head?<br/>owner or human review,<br/>blocked with main unmoved,<br/>attempts spent"}
    trainPark -.->|"yes: pass it by"| trainNext
    trainPark -->|no| trainCi
    trainCi{"Its CI"}
    trainCi -.->|running| trainWait
    trainCi -->|"green, behind main"| trainUpdate
    trainCi -->|"red, conflicting,<br/>or green and current"| trainGate
    trainUpdate(("Merge main in<br/>CI reruns on what it<br/>will land on"))
    trainGate(("Dispatch the gate<br/>repair or squash-merge"))
    trainWait(("Wait<br/>the next tick looks again"))
    trainIdle(("Idle<br/>the train is empty"))

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef idle fill:#202c40,stroke:#738198,stroke-width:2px,color:#ffffff
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    class trainTick start
    class trainLive,trainNext,trainPark,trainCi decision
    class trainWait,trainIdle idle
    class trainUpdate,trainGate success
```

### How a feature stacks

When refine splits a story that carries real sequencing — a feature whose children build on each
other — the split can open a stack instead of independent work. The children stay ordinary issues
walking the normal pipeline above; only where they land changes: each child's pull request targets
the feature branch rather than the default branch, and one root pull request (spec plus the
feature's acceptance journey, open from the start) carries the whole feature to `main` at the end.

```mermaid
flowchart TD
    feat("Feature issue<br/>8+ points, ordered children") --> splitStack("refine split<br/>stamps stack-root-branch + stack-root-pr<br/>on the feature issue") --> rootPr("root pull request on feat/&lt;N&gt;<br/>spec + red journey e2e,<br/>base: main, HELD")
    splitStack --> child1("child T1: implement<br/>PR base: feat/&lt;N&gt;")
    child1 --> merge1("merge-gate<br/>auto-merge into feat/&lt;N&gt;<br/>closes T1") --> child2("child T2, T3 ...<br/>same shape, one at a time")
    child2 --> stacked{"every child landed<br/>and the root is green?"}
    stacked -.->|"no: a bug found"| fixChild("new child issue<br/>mid-stack insertion") --> child2
    stacked -->|yes| announce("stack-complete announcement<br/>on the root pull request")
    announce --> humanStack(("human merges the root<br/>feature issue closes with it"))
    flat("story with no<br/>sequencing") -.->|"no stack markers:<br/>byte-for-byte the old path"| implement

    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    classDef idle fill:#202c40,stroke:#738198,stroke-width:2px,color:#ffffff
    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    class feat,flat start
    class splitStack,rootPr,child1,merge1,child2,announce,fixChild action
    class stacked decision
    class humanStack success
```

The stack exists only in markers on the issues — `stack-root-branch` and `stack-root-pr` on the
feature issue, `stack-root-branch` stamped on each child at hand-over — so a repository with none
of them runs exactly the pipeline above and nothing else. The root is never auto-merged: a person
merges it after every child has landed and the feature branch is green, which is the point where
the feature's own acceptance journey, not one child's scope, is the thing being verified.

---

## agent-triage.md

The front door for issues opened by people with read-only access. The gate is permission level, not
membership: anybody with write skips triage and self-labels into the pipeline, org member or not, while
a read-only outside collaborator goes through it.

Four outcomes, and only one of them closes anything. `needs-maintainer` is the one worth knowing: the
request is legitimate but addressed to the wrong intake, so the issue stays open with `review` and a
maintainer takes it on by adding `refine`.

```mermaid
flowchart TD
    triStart("Work Router<br/>triage route") --> triPick
    triPick{"Opened by a read-only<br/>outside collaborator?"} -->|yes| triReserve
    triPick -.->|"no, write+ user"| triIdle
    triReserve("Reserve (rung 4)<br/>bot-working + triage") --> triFacts
    triFacts("Facts (rung 3)<br/>Issue, comments and every open<br/>issue written to disk") --> triRound
    triRound["Round N of 3<br/>counted from the markers<br/>already on the issue"] --> triAgent
    triAgent("Agent (rung 5)<br/>10 checks: template, security, size,<br/>danger, duplicates, clarity, repro,<br/>acceptance, cross-cutting, product scope") --> triValidate
    triValidate{"Outcome valid?"} -->|yes| triOutcome
    triValidate -.->|no| triIncomplete
    triOutcome{"Verdict"} -->|pass| triPass
    triOutcome -->|needs-info| triReview
    triOutcome -->|needs-maintainer| triMaintainer
    triOutcome -->|block| triBlocked
    triRound -.->|"round 3: needs-info<br/>is no longer allowed"| triAgent
    triPass(("Passed<br/>refine added, triage removed<br/>enters the pipeline, no human"))
    triReview(("Needs info<br/>questions posted, review added<br/>triage kept, so a reply re-runs it"))
    triReview -->|"author or write+ replies<br/>re-enters via the router"| triStart
    triMaintainer(("Needs a maintainer<br/>out of product-owner scope, so it stays<br/>OPEN with review; triage removed.<br/>Add refine to take it on"))
    triBlocked(("Blocked<br/>cannot be done, unsafe, or still<br/>ambiguous: closed with a reason"))
    triIdle(("Idle<br/>write+ user, skipped"))
    triIncomplete(("Incomplete<br/>review added, label kept for a retry"))

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef idle fill:#202c40,stroke:#738198,stroke-width:2px,color:#ffffff
    classDef failure fill:#fff0f0,stroke:#ef2929,stroke-width:2px,color:#8b1a1a
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    class triStart start
    class triReserve,triFacts,triAgent action
    class triPick,triRound,triValidate,triOutcome decision
    class triIdle idle
    class triIncomplete,triBlocked failure
    class triPass,triReview,triMaintainer success
```

---

## agent-refine.md

Decides the size of the work, which is the decision that determines whether it ever lands. An
estimate of 8 or more is split into children of 3 to 5 points, and each child walks the pipeline
alone. A slice smaller than 3 points is a fragment and is folded into a sibling.
The refined story is wrapped in the repository's own issue form, and when questions remain the
worker leaves a temporal draft on the issue and asks everything in one batched comment.

```mermaid
flowchart TD
    refStart("Work Router<br/>refine route") --> refReserve
    refReserve("Reserve (rung 4)<br/>bot-working") --> refFacts
    refFacts("Facts (rung 3)<br/>Issue and comments to disk") --> refExplore
    refExplore("Explore (rung 5)<br/>one work unit at a time,<br/>self-answer from the code,<br/>at most 5 questions each") --> refClassify
    refClassify{"Trivial?<br/>every TRIVIAL_CRITERIA<br/>condition holds"}
    refClassify -->|yes| refTrivial
    refClassify -->|no| refStory
    refTrivial("Trivial plan<br/>marker, summary, checklist<br/>no Gherkin, no diagram") --> refEstimate
    refStory("Story<br/>Given/When/Then per work unit,<br/>grounded in the code") --> refWrap
    refStory -.->|"cannot ground it"| refFail
    refWrap("Wrap<br/>story into the repository's<br/>own issue form") --> refProse
    refProse("Prose<br/>@humanizer over the final text") --> refEstimate
    refEstimate["Estimate<br/>Fibonacci, against ESTIMATE_BANDS"] --> refSplit
    refSplit{"8 or more?"}
    refSplit -->|no| refOutcome
    refSplit -->|"yes, and it splits"| refChildren
    refSplit -->|"yes, indivisible"| refOutcome
    refChildren(("Split<br/>2-6 children, each 3 to 5<br/>parent becomes their tracker"))
    refChildren -->|"children build on each other"| refStack
    refStack("Stamp stack-root-branch + stack-root-pr<br/>on the feature issue, and open the<br/>held root pull request on feat/&lt;N&gt;") --> refOutcome
    refOutcome{"Questions left<br/>for the author?"}
    refOutcome -->|no| refDone
    refOutcome -->|yes| refAsk
    refDone(("Refined<br/>estimate recorded, implement added"))
    refAsk(("Questions<br/>temporal draft on the issue,<br/>one batched comment,<br/>review added"))
    refAsk -->|"author replies<br/>re-enters via the router"| refStart
    refFail(("Incomplete<br/>refine label kept for a retry"))

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef failure fill:#fff0f0,stroke:#ef2929,stroke-width:2px,color:#8b1a1a
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    class refStart start
    class refReserve,refFacts,refExplore,refTrivial,refStory,refWrap,refProse,refStack action
    class refClassify,refEstimate,refSplit,refOutcome decision
    class refFail failure
    class refDone,refAsk,refChildren success
```

---

## agent-implement.md

Writes the code and opens one pull request. It stops there: the merge decision belongs to the gate,
because waiting for CI inside this run would hold a fleet machine doing nothing.

```mermaid
flowchart TD
    implStart("Work Router<br/>implement route<br/>router already confirmed<br/>no open PR for this issue") --> implEligible
    implEligible{"eligibility (rung 4)<br/>Issue still open?<br/>Not labelled future?"}
    implEligible -.->|no| implIdle
    implEligible -->|yes| implReserve
    implReserve("Reserve (rung 4)<br/>bot-working") --> implFacts
    implFacts("Facts (rung 3)<br/>Issue and comments to disk") --> implCheck
    implCheck{"Trivial marker<br/>left by refine?"}
    implCheck -->|yes| implTodos
    implCheck -->|no| implCode
    implTodos("Direct path<br/>one todo per checklist item") --> implVerify
    implCode("Standard path<br/>the pc-plan-goal pipeline:<br/>explore, propose, apply, verify,<br/>archive; skips ahead when the<br/>issue is already refined") --> implVerify
    implVerify{"Verify<br/>scoped to the changed files,<br/>because a whole-repo run<br/>gets OOM-killed"}
    implVerify -.->|fails| implCode
    implVerify -->|passes| implPr
    implPr("create_pull_request<br/>one safe output, complete first time") --> implHandoff
    implPr -.->|"run died"| implRetry
    implRetry{"Died under 6 minutes<br/>with no answer?"}
    implRetry -->|"yes: provider outage"| implAgain(("Retry<br/>attempt N of 5, label kept"))
    implRetry -.->|"no: it answered, wrongly"| implFail
    implAgain -->|"re-enters via the router"| implStart
    implHandoff(("Handed off<br/>PR open, bot-working removed,<br/>the gate decides next"))
    implIdle(("Idle<br/>closed, or held by future"))
    implFail(("Parked<br/>review added, a rerun<br/>would fail the same way"))

    implStackStart("check-stack-branch<br/>(router job, rung 1)<br/>the issue carries<br/>stack-root-branch?") -.->|"no: flat mode,<br/>nothing happens"| implIdle
    implStackStart -->|"yes: the workflow dispatches<br/>this worker with ref: feat/N<br/>so the agent never fetches"| implStart

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef idle fill:#202c40,stroke:#738198,stroke-width:2px,color:#ffffff
    classDef failure fill:#fff0f0,stroke:#ef2929,stroke-width:2px,color:#8b1a1a
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    class implStart start
    class implReserve,implFacts,implTodos,implCode,implPr,implStackStart action
    class implEligible,implCheck,implVerify,implRetry decision
    class implIdle idle
    class implFail failure
    class implHandoff,implAgain success
```

The retry belt exists because a provider outage kills a run in a couple of minutes with no answer,
and that used to burn the issue and hand it to a human. A run that worked for half an hour and then
failed produced an answer that was wrong; repeating it costs the whole fleet the same half hour to
be wrong again, so only the short deaths are retried.

A stacked child enters the same worker through a different door: the router's `check-stack-branch`
job reads the issue's markers before anything runs, and dispatches the compiled workflow with
`ref:` set to the feature branch, because the agent sandbox has no credentials to fetch or choose
a branch itself. The prompt then tells `create_pull_request` its base: the feature branch for a
stacked child, the default branch for everything else. Nothing about the standard path above
changes for an issue without the markers.

---

## agent-merge-gate.md

The only worker that merges. It runs one at a time for the whole repository, because several
overnight pull requests mean every merge moves the default branch under the rest.

```mermaid
flowchart TD
    gateStart("Work Router<br/>merge-gate route<br/>the merge train dispatched it,<br/>oldest PR first") --> gateSubject
    gateSubject{"subject (rung 4)<br/>Open PR from this repo,<br/>by the bot or a writer?"}
    gateSubject -.->|no| gateIdle
    gateSubject -->|yes| gateBranch
    gateBranch("Check out the PR branch<br/>the push is fast-forward only,<br/>so never rebase") --> gateFacts
    gateFacts("Facts (rung 3)<br/>Diff, PR shape, failing CI logs") --> gateCi
    gateCi{"What did CI conclude?"}
    gateCi -->|success| gateProtected
    gateCi -->|failure| gateFix
    gateFix("Repair<br/>read the failure, fix, verify.<br/>Empty evidence on a conflicting<br/>PR means the conflict is the fault") --> gatePush
    gatePush(("Pushed<br/>CI runs again, gate re-enters"))
    gateFix -.->|"cannot fix"| gateHuman
    gateProtected{"protected_changes (rung 4b)<br/>blast radius from paths, CODEOWNERS<br/>and the size of the code that ships"}
    gateProtected -.->|".github/ path"| gateOwner
    gateProtected -->|"measured low, medium or high"| gateAssess
    gateAssess("Agent (rung 5)<br/>find defects, verify them,<br/>rate recoverability") --> gateDisposition
    gateDisposition{"Disposition<br/>computed in shell from<br/>the facts and the report"}
    gateDisposition -->|"no verified blocker,<br/>radius low or recoverable medium"| gateRootCheck
    gateRootCheck{"PR base is a<br/>stack feature branch<br/>and this PR is the root?"}
    gateRootCheck -->|"child PR: no"| gateMerge
    gateDisposition -.->|"10000+ lines, .github/<br/>or a secret"| gateOwner
    gateDisposition -.->|"fragile, unmet criteria<br/>or low confidence"| gateHuman
    gateDisposition -.->|"CI red or a verified<br/>high finding"| gateBlocked
    gateMerge(("AUTO-MERGE<br/>squash into the PR's base<br/>(main, or the feature branch:<br/>then the child issue closes,<br/>pr-pending removed)"))
    gateRootCheck -->|"yes: the root"| gateHeld(("HELD<br/>stack root never auto-merges,<br/>a person merges it once every<br/>child has landed and it is green"))
    gateHuman(("HUMAN REVIEW<br/>review label,<br/>implement label kept"))
    gateOwner(("OWNER REVIEW<br/>review + owner-review,<br/>CODEOWNERS asked when named"))
    gateHuman --> gatePreview
    gateOwner --> gatePreview
    gatePreview("operation=evidence<br/>screenshots of the head<br/>before the person decides") --> gateApproved
    gateApproved(("Approved by a writer<br/>merge-approved merges<br/>the approved commit"))
    gateBlocked(("BLOCKED<br/>review + blocked, the train<br/>retries it when main moves"))
    gateIdle(("Idle<br/>a fork, a stranger,<br/>or not open"))
    gateFix -.->|"attempt 6 of 6"| gateBlocked

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef idle fill:#202c40,stroke:#738198,stroke-width:2px,color:#ffffff
    classDef failure fill:#fff0f0,stroke:#ef2929,stroke-width:2px,color:#8b1a1a
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    class gateStart start
    class gateBranch,gateFacts,gateFix,gateAssess,gatePreview action
    class gateSubject,gateCi,gateProtected,gateDisposition,gateRootCheck decision
    class gateIdle idle
    class gateHuman,gateOwner,gateBlocked failure
    class gateMerge,gatePush,gateApproved success
```

For a child pull request — one whose base is a stack feature branch — everything above is
unchanged: the risk assessment sees the same diff it always would, and auto-merge means squash
into the feature branch, closing exactly that child issue. The root pull request is the one
exception in the whole system: it can be as clean as any merge that ever shipped and the gate
still will not take it, because a feature is only done when the whole branch is done. AABB holds
it with an App-token comment and a person takes it from there, after the router's stack-completion
check has announced that every child landed and the branch is green.

A protected-path match holds the merge but does not stop the repair path: the agent may still fix
failed CI on those files, and `conclude` is what refuses to merge them.

The agent does not pick the disposition. It reports what it found and what it verified; the
validator computes the outcome from that report and from the blast radius measured before the
agent ran. A category the diff touches is no longer, on its own, a reason to park a pull request:
only a verified high or critical finding, a sensitive path, or a change that would be hard to undo
sends it to a person.

Size counts only code that ships: tests, docs, specs, translations and generated migration code
(`BLAST_IGNORE_PATHS`) are left out, and a new EF Core migration whose `Up()` only creates and adds
is a medium change rather than an owner one. When the gate parks a pull request for a person it
dispatches `operation=evidence`, so the screenshots arrive before the decision, and an approval
from anyone with write access merges the approved commit (`merge-approved` in the router).

---

## agent-apply-review.md

Applies a reviewer's feedback to a pull request the bot already opened, and pushes to the same
branch.

```mermaid
flowchart TD
    fbStart("Work Router<br/>apply-review route<br/>review or comment on a bot PR") --> fbSubject
    fbSubject{"subject (rung 4)<br/>Our open PR?<br/>Reviewer has write?"}
    fbSubject -.->|no| fbIdle
    fbSubject -->|yes| fbFacts
    fbFacts("Facts (rung 3)<br/>Every thread with its resolved state,<br/>every inline comment, the diff") --> fbTriage
    fbTriage{"Anything actionable<br/>and still outstanding?<br/>Account for every PRRT_ id"}
    fbTriage -.->|"nothing, or all addressed"| fbSatisfied
    fbTriage -->|yes| fbApply
    fbApply("Apply<br/>only what the feedback justifies:<br/>a comment is not licence to refactor") --> fbVerify
    fbVerify{"Verify<br/>scoped to the changed files"}
    fbVerify -.->|fails| fbApply
    fbVerify -->|passes| fbPush
    fbApply -.->|"ambiguous or unsafe"| fbHuman
    fbPush(("Implemented<br/>pushed to the same branch,<br/>CI runs, the gate re-enters"))
    fbSatisfied(("Already satisfied<br/>nothing pushed, the reviewer<br/>has to confirm"))
    fbHuman(("Needs a human<br/>review added"))
    fbIdle(("Idle<br/>not ours, or not a write reviewer"))

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef idle fill:#202c40,stroke:#738198,stroke-width:2px,color:#ffffff
    classDef failure fill:#fff0f0,stroke:#ef2929,stroke-width:2px,color:#8b1a1a
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    class fbStart start
    class fbFacts,fbApply action
    class fbSubject,fbTriage,fbVerify decision
    class fbIdle idle
    class fbHuman failure
    class fbPush,fbSatisfied success
```

A reviewer often makes one point across several comments, so the whole conversation is on disk
before anything changes. Applying them one at a time produces contradictory commits.

---

## agent-audit.md

The only worker that creates work rather than consuming it. Read-only: it files an issue and
changes nothing.

```mermaid
flowchart TD
    auStart("Work Router<br/>audit route<br/>weekly cron, or dispatch") --> auBack
    auBack{"Backpressure (rung 1)<br/>Fewer than 3 open reports?"}
    auBack -.->|no| auIdle
    auBack -->|yes| auFacts
    auFacts("Facts (rung 3)<br/>Every open issue's title<br/>and labels to disk") --> auRun
    auRun("Audit (rung 5)<br/>/repo-audit over AUDIT_FOCUS,<br/>read-only throughout") --> auFilter
    auFilter{"Each finding: specific,<br/>reproducible, real impact,<br/>fixable without more digging?"}
    auFilter -->|keeps some| auScore
    auFilter -.->|keeps none| auQuiet
    auScore("Score 1-10<br/>severity, likelihood, blast radius") --> auDedupe
    auDedupe{"Already tracked, or<br/>previously rejected?"}
    auDedupe -.->|"all of them"| auQuiet
    auDedupe -->|"some are new"| auFile
    auFile("One issue: every finding,<br/>top 3 refined into stories") --> auReport
    auReport(("Filed<br/>labelled refine, so it gets<br/>sized and split per finding"))
    auQuiet(("Nothing to file<br/>the right outcome on a<br/>clean codebase"))
    auIdle(("Idle<br/>backlog already full"))

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef idle fill:#202c40,stroke:#738198,stroke-width:2px,color:#ffffff
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    class auStart start
    class auFacts,auRun,auScore,auFile action
    class auBack,auFilter,auDedupe decision
    class auIdle idle
    class auReport,auQuiet success
```

Memory matters here: open issues only cover what is still open, so a finding reported weeks ago and
consciously not acted on would come back every single run. The audit records its dispositions and
reads them next time.

---

## agent-release.md

Manual dispatch only. The agent writes prose; deterministic jobs do everything irreversible, and
nothing reaches `main` except through a pull request.

```mermaid
flowchart TD
    relStart("Work Router<br/>release route<br/>operation=release") --> relFacts
    relFacts("Facts (rung 3)<br/>Commit log since the last tag<br/>and the current version, to disk") --> relAgent
    relAgent("Agent (rung 5)<br/>Categorise by conventional-commit<br/>prefix, write release-notes.md.<br/>The only judgement in this route") --> relNoop
    relNoop("noop<br/>the agent writes a file,<br/>not a GitHub object") --> relConclude
    relConclude["conclude (rung 6)<br/>Bump: BREAKING is major,<br/>feat is minor, else patch"] --> relPr
    relPr("App token: push release/vX.Y.Z,<br/>open chore(release) PR,<br/>enable squash auto-merge") --> relMerge
    relMerge{"CI green and<br/>auto-merge allowed?"}
    relMerge -->|yes| relTag
    relMerge -.->|auto-merge disabled| relOpen
    relTag("release-tag.yml on push to main<br/>GITHUB_TOKEN: tag vX.Y.Z,<br/>Release with the PR body as notes") --> relDone
    relConclude -.->|fails| relFail
    relOpen(("PR left open<br/>warning names the fix"))
    relDone(("Released<br/>tag and Release published,<br/>no tag-triggered workflow fired"))
    relFail(("Failed<br/>no branch, nothing partial"))

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef idle fill:#202c40,stroke:#738198,stroke-width:2px,color:#ffffff
    classDef failure fill:#fff0f0,stroke:#ef2929,stroke-width:2px,color:#8b1a1a
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    class relStart start
    class relFacts,relAgent,relNoop,relPr,relTag action
    class relConclude,relMerge decision
    class relFail failure
    class relOpen idle
    class relDone success
```

The version bump, the tag and the Release are deterministic on purpose. The agent's only output is
a file on disk, so a confused model cannot publish a release. The tag and the Release use
`GITHUB_TOKEN` so that a consumer deploying on `v*` tags does not deploy because a release was cut.


---

## housekeeping

Not a worker: a deterministic job in the router, on its own six-hourly cron, with no model. It is
the answer to a specific measured problem. Across the four consumers, 58 of 237 issues closed since
1 August were closed by the bot; autonomy ran between 6% and 50%. The gap was not bad decisions, it
was silence work that stopped and told nobody, and state that nothing ever cleaned up.

The one rule that shapes it: **retry a failure, report a decision.** A crash, a timeout or an empty
output is a machine failure, and the worker marks it `stalled`; those are worth running again. A
triage `needs-maintainer`, a refine `questions` or a merge-gate `review` is a verdict the agent
reached on purpose, and running it again just reproduces it.

```mermaid
flowchart TB
    hkCron("cron 23 */6 * * *") --> hkScan("List open issues,<br/>pull requests and branches")
    hkScan --> hkPark{"Issue carries<br/>review?"}
    hkPark -.->|no| hkStrand
    hkPark -->|yes| hkWhy{"and stalled?"}
    hkWhy -.->|"no: a decision"| hkDigest
    hkWhy -->|"yes: a machine failure"| hkBudget{"waited 6h,<br/>under 3 tries?"}
    hkBudget -.->|"budget spent"| hkDigest
    hkBudget -->|yes| hkRetry("Comment the attempt,<br/>drop review and stalled,<br/>dispatch the work route")
    hkRetry --> hkStrand

    hkStrand("Strands: drop pr-pending<br/>where no open PR closes the issue") --> hkParent("Close a split parent<br/>once every child is closed")
    hkParent --> hkStack{"stack-root-pr<br/>marker on the<br/>feature issue?"}
    hkStack -.->|"no: flat mode"| hkBranch
    hkStack -->|"root open"| hkStackWait{"children left,<br/>or the completion<br/>announcement missing?"}
    hkStackWait -->|"children open: mid-stack,<br/>the normal state"| hkBranch
    hkStackWait -->|"all landed, never told"| hkDigest
    hkStackWait -->|"told, but nobody merged for days"| hkDigest
    hkStack -->|"root merged,<br/>feature issue still open"| hkStackClose("close the feature issue,<br/>close child issues whose<br/>PR merged but stayed open")
    hkStack -->|"root closed unmerged"| hkDigest
    hkStackClose --> hkBranch
    hkBranch{"Branch whose PRs<br/>are all finished<br/>and all bot-authored?"}
    hkBranch -->|yes| hkDelete("Delete the branch")
    hkBranch -.->|"open PR, human PR,<br/>or the default branch"| hkDigest
    hkDelete --> hkDigest
    hkDigest("Rewrite one issue:<br/>Needs a human") --> hkEnd
    hkEnd(("One place to look<br/>instead of four repos"))

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    class hkCron start
    class hkScan,hkRetry,hkStrand,hkParent,hkDelete,hkDigest,hkStackClose action
    class hkPark,hkWhy,hkBudget,hkBranch,hkStack,hkStackWait decision
    class hkEnd success
```

Three things make it safe to leave running unattended. It uses the App token, because GitHub starts
no workflow run from an event raised with `GITHUB_TOKEN`, so with the default token every retry
would be a green no-op. Every write goes through one `act()` wrapper, which is the only place
`dry-run` is read, so there is no second path that forgets to check it. And it closes exactly two
kinds of issue a split parent whose children are all done, and its own digest which the route
matrix asserts by counting.

The stack section extends the same two rules to stacked features without adding a third closed
kind: a merged child whose issue stayed open is closed exactly like a flat split parent (its work
landed, the close was lost to a race), and a merged root closes the feature issue the same way
section 3 closes a split parent. Everything else about a stack is a *report*, never an action:
mid-stack is the normal state and stays silent; a root that finished but was never announced, one
held for days after its announcement, a root closed by accident with children open, and a missing
root pull request each get one line in the digest. No labels move, so nothing the router listens
for is raised by the sweep itself.

---

## agentics-app-errors

An optional template, installed only where there is an Application Insights resource to read, and
the mirror image of `agentics-error-report` below it. That one carries a *workflow* failure out of a
private consumer into the public package, so it is built to send almost nothing. This one reads the
*application's* own exceptions, and they are the private repository's own business: the issue is
filed beside the code that threw it and nothing travels anywhere.

It runs no model, for the reason that one does not: a model asked to summarise a stack trace
paraphrases it, and a paraphrased stack trace is a wrong issue that costs somebody an afternoon. The
agent work happens afterwards, on the belt, because the issue is labelled `bug` + `refine` and that
is the same handoff the audit already uses.

```mermaid
flowchart TB
    aeCron("cron 41 7 * * *") --> aeConfig{"infra/&lt;env&gt;.env<br/>present?"}
    aeConfig -.->|no| aeIdle(("Job summary only<br/>warning, not a red run"))
    aeConfig -->|yes| aeLogin("azure/login, OIDC<br/>on the matching Environment")
    aeLogin --> aeQuery("AppExceptions, one table,<br/>grouped by ProblemId,<br/>sum(ItemCount) for sampling")
    aeQuery --> aeFloor{"Above the floor,<br/>and any slot left<br/>under the ceiling?"}
    aeFloor -.->|no| aeDefer("Named in the summary,<br/>picked up tomorrow")
    aeFloor -->|yes| aeScrub("Mask GUIDs, emails,<br/>paths, query strings")
    aeScrub --> aeFields{"Every field on<br/>the allowlist?"}
    aeFields -.->|"no: the module changed"| aeStop(("Nothing filed<br/>run goes red"))
    aeFields -->|yes| aeScan{"Leak scanner:<br/>a GUID, a secret,<br/>a path, an address?"}
    aeScan -.->|"this one trips"| aeWithhold("Withheld, the others<br/>still filed, run goes red")
    aeScan -->|clean| aeSeen{"Filed before?"}
    aeSeen -.->|"closed and accepted"| aeLeave(("Left alone, for good"))
    aeSeen -->|"open"| aeNote("A dated line added")
    aeSeen -->|"closed, not accepted"| aeReopen("Reopened: it came back")
    aeSeen -->|"never"| aeFile("New issue,<br/>bug + refine + app-error")
    aeFile --> aeBelt(("On to refine"))
    aeNote --> aeBelt
    aeReopen --> aeBelt

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef failure fill:#fff0f0,stroke:#ef2929,stroke-width:2px,color:#8b1a1a
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    classDef idle fill:#f4f4f6,stroke:#5b5b66,stroke-width:2px,color:#2b2b33
    class aeCron start
    class aeLogin,aeQuery,aeScrub,aeNote,aeReopen,aeFile,aeDefer action
    class aeConfig,aeFloor,aeFields,aeScan,aeSeen decision
    class aeStop,aeWithhold failure
    class aeBelt success
    class aeIdle,aeLeave idle
```

Two failures, handled two different ways, and the difference is the point. A field nobody agreed to
publish means the module changed and the new field is probably on every finding, so nothing is filed
at all. A body that still trips the scanner after scrubbing is one unlucky row: that report is
withheld and the rest are filed, because one bad operation name must never mean the belt stops
hearing about anything. Both turn the run red.

Scrubbing comes before scanning for the same reason. Masking a GUID keeps the job alive where
refusing over one would have left it red every morning and filing nothing, which is how a workflow
gets switched off. The scanner is the backstop for whatever the masks missed, not the first line.

The route matrix asserts the query names one table and only inside the query itself, that counts are
summed rather than counted, that the reportable field set has not grown a run id, that the scrubs and
the scanner both still exist, that both `setFailed` paths are intact, and that no model has appeared.
Every one was mutation-tested. Four of the first drafts used the file's own `count()` helper inside
an `if`, and since that helper is `grep || true` those guards were true whatever they found: they
failed open, which is the exact bug this section exists to catch.

---

## agentics-error-report

An optional template, installed everywhere, and the only job in the fleet that sends anything out of
the repository it runs in. Every consumer is private, so that is the whole design constraint.

What crosses the boundary is a fixed, enumerable set of facts about workflows **this package ships**:
their file names, their job and step names, a conclusion, a runner label, a count, and the id of a
matched entry from a catalogue of sixteen known failure shapes, plus a severity. What never crosses it is free text
of any kind no log line, no branch name, no issue title, no path, no URL, no number that could be
looked up. Hence no model: a model asked to summarise a failure paraphrases whatever the log held.

```mermaid
flowchart TB
    erCron("cron 11 7 * * *") --> erRuns("List this repo's runs<br/>from the last 24h")
    erRuns --> erOwned{"Is the workflow one<br/>this package ships?"}
    erOwned -.->|"no: the name could describe<br/>a product or a customer"| erCount("Counted, never inspected")
    erOwned -->|yes| erState{"Failed, or queued<br/>past 45 minutes?"}
    erState -.->|neither| erCount
    erState -->|yes| erClassify("Read the log tail and the job annotations,<br/>match the catalogue,<br/>keep only the matched id")
    erClassify --> erNoise{"Cancelled with no failing step,<br/>log unreadable, or an<br/>infrastructure cause?"}
    erNoise -.->|yes| erCount
    erNoise -->|no| erFilter{"Seen at least twice,<br/>within the cap, and not<br/>closed in the last 30 days?"}
    erFilter -.->|no| erCount
    erFilter -->|yes| erBody("Build the report from<br/>package-owned names,<br/>a conclusion and a count")
    erBody --> erScan{"Leak scanner:<br/>repo or owner name, a URL,<br/>an email, a path, a token,<br/>an issue number, a ref?"}
    erScan -.->|"anything matches"| erWithhold(("Withheld<br/>nothing filed, run goes red"))
    erScan -->|clean| erToken{"Upstream token<br/>available?"}
    erToken -.->|no| erSummary(("Job summary only<br/>warning, not a red run"))
    erToken -->|yes| erFile("One upstream issue<br/>per signature, appended<br/>rather than repeated")
    erFile --> erDone(("Filed upstream"))

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef failure fill:#fff0f0,stroke:#ef2929,stroke-width:2px,color:#8b1a1a
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    classDef idle fill:#f4f4f6,stroke:#5b5b66,stroke-width:2px,color:#2b2b33
    class erCron start
    class erRuns,erClassify,erBody,erFile,erCount action
    class erOwned,erState,erNoise,erFilter,erScan,erToken decision
    class erWithhold failure
    class erDone success
    class erSummary idle
```

The scanner fails closed, and its failure is loud: a report it flags is not filed and the run goes
red, so the field that carried private text gets fixed rather than leaking again the next morning.
The route matrix asserts the scanner exists, that both exit paths call `setFailed`, that there are
at least as many scans as upstream writes, that each individual check is still present, and that no
model or `OPENAI_API_KEY` has appeared in the action. Every one of those was mutation-tested; three
earlier versions of them passed against a deliberately broken guard and were rewritten.

---

## evidence.yml

Archives what a merged pull request looks like. Not an agent: the plan was written by the agent that
implemented the change (`pc-repo-verify`), and this replays it. The router calls it when a pull
request merges, and `operation=evidence` runs it by hand. Nothing waits on it. The screenshots are
committed beside each plan, in an `evidence/` folder on the default branch, so the record stays with
the change it proves; the comment embeds a manifest that Project Health reads. The merge gate also
runs it when it hands a pull request to a person: that pull request is not merged, so its
screenshots go to a preview folder (`pr-<number>/`) on the `evidence-previews` branch, and the
merge replaces them with the archived ones.
The capture job runs the pull request's code with a read-only token; only the publish job writes,
and it runs no repository code.

```mermaid
flowchart TD
    evStart("router: pull request merged,<br/>the gate parked it for a person,<br/>or operation=evidence") --> evPlans
    evPlans{"verification-plan.md<br/>in the pull request?"}
    evPlans -.->|"no"| evIdle
    evPlans -->|"yes"| evInspect
    evInspect{"capture-evidence inspect<br/>a replayable journey?"}
    evInspect -.->|"not-applicable or prose"| evIdle
    evInspect -->|"yes"| evApp
    evApp["capture (read-only)<br/>check out the head,<br/>install, start the app"] --> evUp
    evUp{"app answers at<br/>the plan's url?"}
    evUp -->|"yes"| evReplay
    evUp -.->|"no, after the timeout"| evUnreached
    evReplay["replay each waypoint<br/>in headless Chromium,<br/>one JPEG per waypoint"] --> evPublish
    evUnreached["record why nothing<br/>was captured"] --> evPublish
    evPublish{"publish (GITHUB_TOKEN)<br/>merged?"}
    evPublish -->|"yes"| evDone
    evPublish -->|"not yet"| evPreview
    evDone(("Archived beside the plan<br/>on the default branch,<br/>one comment upserted"))
    evPreview(("Preview on evidence-previews<br/>pr-number folder,<br/>same comment"))
    evIdle(("Nothing to capture"))

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef idle fill:#f4f4f6,stroke:#5b5b66,stroke-width:2px,color:#2b2b33
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    class evStart start
    class evApp,evReplay,evUnreached action
    class evPlans,evInspect,evUp,evPublish decision
    class evIdle idle
    class evDone,evPreview success
```
