# Workflow skills

This directory contains three self-contained skills for the Agentic Workflows package.

| Skill | Use when |
|---|---|
| `workflow-author` | Authoring or reviewing loops under `loops/`. Covers the router, determinism ladder, frontmatter, safe outputs, OpenCode engine, diagrams, and verification. |
| `workflow-consumer` | Installing, configuring, compiling, or updating managed workflows in a consumer repository. Covers CLI usage, templates, standalone worker customization, and compilation. |
| `cli` | Maintaining the package installer (`cli/`). Covers commands, catalog installation, ownership headers, templates, and build and release. |

Each skill is fully self-contained: all reference files are in `references/` within the skill folder. No skill references files outside its own folder.

Consumer setup requires `PlainConceptsPlatform/agent-harness`. Loop workers invoke its skills and commands. Verify they are available before compiling workflows.

The package bin name is `workflows` (defined in `cli/package.json`). Consumer commands use `workflows <init|add|update>` with `npx` or `pnpm exec`. Package-managed loop files include ownership headers identifying `@plainconceptsplatform/workflows`, their `loops/` source path, and `workflows update --force` behavior.
