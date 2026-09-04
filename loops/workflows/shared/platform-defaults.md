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
    # centralised AgentMemory (App Service); the MCP shim needs it through the egress proxy
    - agentmemory-pro-01.azurewebsites.net

safe-outputs:
  threat-detection: false
---
