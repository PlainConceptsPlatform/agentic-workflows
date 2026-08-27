---
# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/shared/platform-defaults.md. Update with `workflows update --force`; consumer edits may be overwritten.
description: Shared network and safe-output defaults for catalog agent workflows.

network:
  allowed:
    - defaults
    - forge.plainconcepts.com
    - node
    - github
    - dotnet
    - fonts
    - login.microsoftonline.com
    # In-cluster AgentMemory service: the agentmemory MCP shim proxies to it when
    # AGENTMEMORY_URL is set, which the compile wrapper injects on ARC runners.
    - agentmemory.mcp.svc.cluster.local

safe-outputs:
  threat-detection: false
---
