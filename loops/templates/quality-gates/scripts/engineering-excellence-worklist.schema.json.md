# Ownership: scripts/engineering-excellence-worklist.schema.json

Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/engineering-excellence-worklist.schema.json. Update with `workflows update --force`; consumer edits may be overwritten.

JSON (RFC 8259) does not permit comments, so the ownership header of `engineering-excellence-worklist.schema.json` is documented here. The schema is the contract of `ee/worklist.json`, the `engineering-excellence-worklist` artifact the weekly audit reads: per check, the worst items with where they are. It is a file of its own because `engineering-excellence.schema.json` is the facet contract vendored verbatim from project-health, and the worklist is not a facet Project-Health collects. `scripts/engineering-excellence.mjs worklist` validates the worklist against it before writing.
