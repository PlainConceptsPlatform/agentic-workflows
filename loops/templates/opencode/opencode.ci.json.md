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
  `FORGE_API_URL` and its key from `FORGE_API_KEY` at runtime.
- Each consumer configures its own router endpoint, credential, model IDs, and
  capabilities. The workflow package does not assume a particular gateway
  host, authentication system, or model vendor.
- Model entries are fallback metadata. Consumers should set `attachment: true`
  only for models whose router supports image input.
- Default model: `forge/glm-5-3`.

### Agent

- **ci-workflow-agent** in `primary` mode with the output discipline directive:
  no narration, no prose between tool calls, stop immediately after the final
  Safe Outputs command.

### LSP

- `csharp`, `fsharp`, and `razor` LSP servers are disabled. Consumers not
  working with .NET can remove the `lsp` block entirely.

### Consumer edits

After copying, edit the file directly for repository-specific needs:

- Change the model or add providers.
- Adjust agent prompt rules or permissions.
- Remove the `lsp` block if LSP is not needed or add other language servers.
- Add MCP servers or plugins as required.
