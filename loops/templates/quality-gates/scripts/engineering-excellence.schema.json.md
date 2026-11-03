# Ownership: scripts/engineering-excellence.schema.json

Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/scripts/engineering-excellence.schema.json. Update with `workflows update --force`; consumer edits may be overwritten.

JSON (RFC 8259) does not permit comments, so the ownership header of `engineering-excellence.schema.json` is documented here. The schema is the facet contract the Project-Health collector reads, vendored verbatim from PlainConceptsPlatform/Atlas. `scripts/engineering-excellence.mjs` validates every facet against it before writing, so an app never uploads a facet the collector would reject.
