// Managed by @plainconceptsplatform/workflows. Source: loops/actions/agent-output.cjs. Update with `workflows update --force`; consumer edits may be overwritten.
const fs = require('node:fs');

// Every apply-agent-* action reads the same artifact the same way: a missing file means the
// agent produced nothing, which is a normal outcome rather than a failure.
function readAgentItems(outputFile, type) {
  if (!outputFile || !fs.existsSync(outputFile)) {
    return [];
  }

  const parsed = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  const items = Array.isArray(parsed.items) ? parsed.items : [];

  return type ? items.filter((item) => item.type === type) : items;
}

module.exports = { readAgentItems };
