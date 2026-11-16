# Ownership: scripts/engineering-excellence.schema.json

Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/engineering-excellence.schema.json. Update with `workflows update --force`; consumer edits may be overwritten.

JSON (RFC 8259) does not permit comments, so the ownership header of `engineering-excellence.schema.json` is documented here. The schema is the facet contract the Project-Health collector reads; the canonical copy is `schema/engineering-excellence-facets.schema.json` in PlainConceptsPlatform/project-health, and a new facet or field lands there first. `scripts/engineering-excellence.mjs` validates every facet against it before writing, so an app never uploads a facet the collector would reject.
