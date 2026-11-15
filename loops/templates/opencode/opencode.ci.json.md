# Ownership: opencode.ci.json

Managed by @plainconceptsplatform/workflows. Source:
`loops/templates/opencode/opencode.ci.json`. Update with
`workflows update --force --template opencode.ci.json`; consumer edits may be
overwritten.

JSON (RFC 8259) does not permit comments, so the ownership header is documented
here instead of inline in `opencode.ci.json`.

## Template contents

This template provides a standalone OpenCode CI configuration for consumer
repositories running agentic workflows in GitHub Actions. It is copied to the
repository root as `opencode.ci.json`.

### Models

- The engine harness (shared/opencode.md) declares the `awf-proxy` provider at runtime and
  populates it with the workflow's `GH_AW_OPENCODE_MODELS` roster; its policies deny every
  other provider. This file therefore declares no providers of its own: a provider here
  would be denied by the policy and would lack credentials inside the sandbox anyway.
- Default model: `awf-proxy/glm-5-2`. The CI setup merge writes each worker's
  `AGENT_LEAD_MODEL` onto `ci-workflow-agent`, and per-agent model values are
  `awf-proxy/<model>` so they resolve against the harness declaration.
- A consumer adding a model to its roster does it in the workers' env
  (`GH_AW_OPENCODE_MODELS`, `AGENT_LEAD_MODEL`), not here.

### Agents

- **ci-workflow-agent** in `primary` mode with the output discipline directive:
  no narration, no prose between tool calls, stop immediately after the final
  Safe Outputs command.
- **finding-verifier** in `subagent` mode, at temperature 0. It takes one claim
  about a code change and tries to disprove it against the code, with no sight
  of the reasoning that produced it. Only a finding it returns `verified: true`
  for can block a merge. It exists so that the agent that found a problem is not
  also the only one who judges it, which is the check self-review cannot provide.
  It reads and runs; it never writes, pushes, or calls a safe output.

  The merge-gate prompt asks for independent verification without naming this
  agent or the tool that reaches it: opencode routes on the agent's
  `description`, so the mechanism stays opencode's to change.

### LSP

- `csharp`, `fsharp`, and `razor` LSP servers are disabled. Consumers not
  working with .NET can remove the `lsp` block entirely.

### Consumer edits

After copying, edit the file directly for repository-specific needs:

- Change the model or add providers.
- Adjust agent prompt rules or permissions.
- Remove the `lsp` block if LSP is not needed or add other language servers.
- Add MCP servers or plugins as required.
