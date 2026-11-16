# Ownership: knip.json

Managed by @plainconceptsplatform/workflows. Source: loops/templates/quality-gates/knip.json. Update with `workflows update --force`; consumer edits may be overwritten.

JSON (RFC 8259) does not permit comments, so the ownership header of `knip.json` is documented here. The file scopes [Knip](https://github.com/webpro-nl/knip), the web dead-code check (`scripts/check-dead-code.mjs`), to the family's web workspace, `apps/web`. The CI runs `knip --workspace <web package> --reporter json` with it.

Knip's own plugins supply the entry points, so the file lists only what no plugin knows:

- `next`: `app/**/{layout,page,route,…}`, `pages/**`, `next.config.*`, `middleware`, `instrumentation`.
- `vitest`: the test files and `setupFiles` that `vitest.config.*` names.
- `playwright`: the specs under `playwright.config.*`'s `testDir`.
- `biome`: `biome.json`, so Biome itself is not an unused dependency.
- `steiger.config.ts`: Steiger has no Knip plugin, and the config imports the FSD rules.

The i18n JSON files (`src/shared/i18n/*.json`) are not source files to Knip, so they are never reported unused; a JSON import still counts as a use of whatever imports it.

Take the file over as soon as your app needs its own entries or ignores (a `vitest.setup.ts` outside the config, a generated client, JavaScript under `public/`): remove the header paragraph above, and `workflows update` then leaves both files alone. Never add an `ignore` to make a finding disappear: delete the dead code, or record it in the baseline with `node scripts/check-dead-code.mjs --report apps/web/knip-report.json --write-baseline` in a reviewed pull request.
