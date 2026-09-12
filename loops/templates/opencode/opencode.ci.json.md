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

### Provider

- The `forge` provider is OpenAI-compatible and reads its endpoint from
  `OPENAI_BASE_URL` and its key from `OPENAI_API_KEY` at runtime. Those are the
  two variables every worker's agent job sets (`engine.env` in the worker and
  the `OPENAI_API_KEY` secret), so the file works with no consumer wiring. An
  earlier template read `FORGE_API_URL`/`FORGE_API_KEY`, which nothing set.
- Each consumer configures its own router endpoint, credential, model IDs, and
  capabilities. The workflow package does not assume a particular gateway
  host, authentication system, or model vendor.
- Model entries are fallback metadata. Consumers should set `attachment: true`
  only for models whose router supports image input.
- Default model: `forge/glm-5-3`.

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
