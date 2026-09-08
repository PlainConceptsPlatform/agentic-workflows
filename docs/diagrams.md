# Diagrams

One picture per route, plus the router that chooses between them.

These used to live at the bottom of each worker's markdown file. Everything below a worker's
frontmatter is the prompt, so each diagram was sent to the model on every run and then explicitly
skipped by a closing instruction telling it to ignore the section. They were about 240 lines across
the seven workers, and in the release worker's case 21 of its 48 prompt lines. They are documentation
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
    authorize{"authorize (rung 1)<br/>Write permission, and is the<br/>actor one of the org's own?"}
    authorize -->|"human, trusted"| work
    authorize -->|"outside collaborator"| triageOnly
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
    pJobs("bot-approve · audit-close<br/>cleanup-artifacts · validate<br/>reconcile-bot-pr-runs · detect-pr-conflicts")
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
    triage{"triage<br/>outside collaborator"} -->|pass| refine
    triage -.->|block| closed(("Closed"))
    triage -.->|needs-info| author("Author replies") --> triage
    write("Write+ user<br/>self-labels") --> refine
    refine{"refine<br/>estimate in points"} -->|"5 or less"| implement
    refine -->|"8 or more"| split("Split into children") --> refine
    refine -.->|questions| author
    implement("implement<br/>branch, PR, closes the issue") --> ci("CI")
    ci --> gate{"merge-gate"}
    gate -->|merge| merged(("Merged"))
    gate -.->|"CI failed"| fix("Fix, push, CI again") --> gate
    gate -.->|"risk or protected"| human(("Human review"))
    review("Someone reviews the PR") --> applyReview("apply-review") --> ci
    audit("audit, weekly") -->|"files one issue"| refine

    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef failure fill:#fff0f0,stroke:#ef2929,stroke-width:2px,color:#8b1a1a
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    class open,write,review,audit start
    class refine,split,implement,ci,fix,applyReview,author action
    class triage,gate decision
    class human,closed failure
    class merged success
```

Audit creates work rather than consuming it, and files into `refine` rather than straight to
`implement`, so a report of several unrelated findings becomes one properly sized issue per finding
instead of one pull request that has to fix them all.

---

## agent-triage.md

The front door for issues opened from outside the organisation. The gate is membership, not permission
level: an org member with write skips triage and self-labels into the pipeline, while an outside
collaborator goes through it even when they hold write.

Four outcomes, and only one of them closes anything. `needs-maintainer` is the one worth knowing: the
request is legitimate but addressed to the wrong intake, so the issue stays open with `review` and a
maintainer takes it on by adding `refine`.

```mermaid
flowchart TD
    triStart("Work Router<br/>triage route") --> triPick
    triPick{"Opened by an<br/>outside collaborator?"} -->|yes| triReserve
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
estimate of 8 or more is split into children of 5 or less, and each child walks the pipeline alone.

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
    refStory("Story<br/>Given/When/Then per work unit,<br/>grounded in the code") --> refProse
    refStory -.->|"cannot ground it"| refFail
    refProse("Prose<br/>@humanizer over the final text") --> refEstimate
    refEstimate["Estimate<br/>Fibonacci, against ESTIMATE_BANDS"] --> refSplit
    refSplit{"8 or more?"}
    refSplit -->|no| refOutcome
    refSplit -->|"yes, and it splits"| refChildren
    refSplit -->|"yes, indivisible"| refOutcome
    refChildren(("Split<br/>2-6 children, each 5 or less<br/>parent becomes their tracker"))
    refOutcome{"Questions left<br/>for the author?"}
    refOutcome -->|no| refDone
    refOutcome -->|yes| refAsk
    refDone(("Refined<br/>estimate recorded, implement added"))
    refAsk(("Questions<br/>asked in business language,<br/>review added"))
    refAsk -->|"author replies<br/>re-enters via the router"| refStart
    refFail(("Incomplete<br/>refine label kept for a retry"))

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef failure fill:#fff0f0,stroke:#ef2929,stroke-width:2px,color:#8b1a1a
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    class refStart start
    class refReserve,refFacts,refExplore,refTrivial,refStory,refProse action
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

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef idle fill:#202c40,stroke:#738198,stroke-width:2px,color:#ffffff
    classDef failure fill:#fff0f0,stroke:#ef2929,stroke-width:2px,color:#8b1a1a
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    class implStart start
    class implReserve,implFacts,implTodos,implCode,implPr action
    class implEligible,implCheck,implVerify,implRetry decision
    class implIdle idle
    class implFail failure
    class implHandoff,implAgain success
```

The retry belt exists because a provider outage kills a run in a couple of minutes with no answer,
and that used to burn the issue and hand it to a human. A run that worked for half an hour and then
failed produced an answer that was wrong; repeating it costs the whole fleet the same half hour to
be wrong again, so only the short deaths are retried.

---

## agent-merge-gate.md

The only worker that merges. It runs one at a time for the whole repository, because several
overnight pull requests mean every merge moves the default branch under the rest.

```mermaid
flowchart TD
    gateStart("Work Router<br/>merge-gate route<br/>CI reported, or the hourly<br/>reconcile belt dispatched it") --> gateSubject
    gateSubject{"subject (rung 4)<br/>Our open PR?<br/>Closes an implement issue?"}
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
    gateProtected{"protected_changes<br/>PROTECTED_PATHS matched?"}
    gateProtected -.->|yes| gateHuman
    gateProtected -->|no| gateAssess
    gateAssess("Agent (rung 5)<br/>10 checks, including<br/>RISK_INDICATORS") --> gateVerdict
    gateVerdict{"Verdict"}
    gateVerdict -->|"all clear"| gateMerge
    gateVerdict -.->|"any concern"| gateHuman
    gateMerge(("Merged<br/>squash, issue closed,<br/>pr-pending removed"))
    gateHuman(("Review<br/>verdict posted on the PR,<br/>implement label kept"))
    gateIdle(("Idle<br/>not ours, or not open"))
    gateFix -.->|"attempt 6 of 6"| gateHuman

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef idle fill:#202c40,stroke:#738198,stroke-width:2px,color:#ffffff
    classDef failure fill:#fff0f0,stroke:#ef2929,stroke-width:2px,color:#8b1a1a
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    class gateStart start
    class gateBranch,gateFacts,gateFix,gateAssess action
    class gateSubject,gateCi,gateProtected,gateVerdict decision
    class gateIdle idle
    class gateHuman failure
    class gateMerge,gatePush success
```

A protected-path match holds the merge but does not stop the repair path: the agent may still fix
failed CI on those files, and `conclude` is what refuses to merge them.

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

Manual dispatch only. The agent writes prose; a deterministic job does everything irreversible.

```mermaid
flowchart TD
    relStart("Work Router<br/>release route<br/>operation=release") --> relFacts
    relFacts("Facts (rung 3)<br/>Commit log since the last tag<br/>and the current version, to disk") --> relAgent
    relAgent("Agent (rung 5)<br/>Categorise by conventional-commit<br/>prefix, write release-notes.md.<br/>The only judgement in this route") --> relNoop
    relNoop("noop<br/>the agent writes a file,<br/>not a GitHub object") --> relConclude
    relConclude["conclude (rung 6)<br/>Bump: BREAKING is major,<br/>feat is minor, else patch"] --> relPush
    relPush("Commit, tag, push,<br/>create the GitHub Release") --> relDone
    relConclude -.->|fails| relFail
    relDone(("Released<br/>tag and Release published"))
    relFail(("Failed<br/>no tag created, nothing partial"))

    classDef start fill:#ffffff,stroke:#172033,stroke-width:2px,color:#172033
    classDef action fill:#eef0ff,stroke:#554cff,stroke-width:2px,color:#172033
    classDef decision fill:#fff8e8,stroke:#c75b00,stroke-width:2px,color:#172033
    classDef failure fill:#fff0f0,stroke:#ef2929,stroke-width:2px,color:#8b1a1a
    classDef success fill:#e8f8ec,stroke:#18883c,stroke-width:2px,color:#145a32
    class relStart start
    class relFacts,relAgent,relNoop,relPush action
    class relConclude decision
    class relFail failure
    class relDone success
```

The version bump, the tag and the Release are deterministic on purpose. The agent's only output is
a file on disk, so a confused model cannot publish a release.
