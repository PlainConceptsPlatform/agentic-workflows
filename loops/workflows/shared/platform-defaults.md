---
# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/shared/platform-defaults.md. Update with `workflows update --force`; consumer edits may be overwritten.
description: Shared network and safe-output defaults for catalog agent workflows, plus the verification rules every worker that builds or pushes has to follow. The body below is runtime-imported into each worker's prompt ahead of its own steps.

network:
  allowed:
    - defaults
    - forge.plainconcepts.com
    - node
    - github
    - dotnet
    - fonts
    - login.microsoftonline.com
    # centralised AgentMemory (App Service); the MCP shim needs it through the egress proxy
    - agentmemory-pro-01.azurewebsites.net

safe-outputs:
  threat-detection: false
---

## Verification, for every worker that builds or pushes

- Scope every check to the files you changed. This is the runner, not a preference: a
  whole-repository lint, build or test run exhausts its memory and gets killed mid-run, which
  fails the job with no useful output. Pass the changed paths to the linter (`pnpm exec biome
  check <files>`), build only the projects containing them, and run only the test project that
  covers them. Escalate to the full suite only after the scoped run passes and only when the
  change crosses a project boundary.
- Run nothing at all for a change that touches only documentation. A cold Release build on a
  shared runner is minutes the run does not get back.
- Never make a check pass by weakening it: not a deleted test, not a lowered threshold, not a
  skipped step. Fix the cause and run it again.
- Once the checks pass, run the project's lint fix command over the files you changed
  (`pnpm lint:fix`, `pnpm exec biome check --write <changed-files>`, or its equivalent), or
  correct what lint reports where no fix command exists. A branch that arrives with lint errors
  gets sent back for them.
