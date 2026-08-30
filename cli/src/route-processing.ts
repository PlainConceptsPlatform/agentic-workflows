import { routeNames, workflowRoutes, type RouteName } from "./workflow-catalog.js";

const routeCrons: Partial<Record<RouteName, string>> = {
  audit: "17 1 * * 1",
  mutation: "41 2 * * 2",
};

export function stripRouteFromRouter(yaml: string, route: RouteName): string {
  let result = yaml;

  const cron = routeCrons[route];
  if (cron !== undefined) {
    result = result.replace(
      new RegExp(`^    - cron: "${escapeRegex(cron)}"\\n`, "gm"),
      "",
    );
  }

  result = removeJobBlock(result, `call-${route}`);

  result = result.replace(
    new RegExp(`^          - ${escapeRegex(route)}\\n`, "gm"),
    "",
  );

  return result;
}

export function stripRouteFromClassifier(shell: string, route: RouteName): string {
  const constName = route.replace(/-/g, "_").toUpperCase() + "_CRON";
  let result = shell;

  result = result.replace(
    new RegExp(`^readonly ${constName}="[^"]*"\\n`, "gm"),
    "",
  );

  const cron = routeCrons[route];
  if (cron !== undefined) {
    result = result.replace(
      new RegExp(`\\s*"\\$${constName}"\\) route="${escapeRegex(route)}" ;;\\n`, "g"),
      "",
    );
  }

  result = result.replace(
    new RegExp(` \\| ${escapeRegex(route)}\\)`, "g"),
    ")",
  );

  result = result.replace(
    new RegExp(`^(\\s+)${escapeRegex(route)} \\| `, "gm"),
    "$1",
  );

  if (!result.includes(`| ${route}`) && !result.includes(`${route} |`)) {
    result = removeAloneDispatchCase(result, route);
  }

  return result;
}

function removeAloneDispatchCase(shell: string, route: RouteName): string {
  const lines = shell.split("\n");
  const pattern = new RegExp(`^(\\s+)${escapeRegex(route)}\\)\\s*$`);
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const match = lines[i]!.match(pattern);
    if (match) {
      const indent = match[1]!;
      i++;
      while (i < lines.length) {
        if (new RegExp(`^${escapeRegex(indent)};;\\s*$`).test(lines[i]!)) {
          i++;
          break;
        }
        i++;
      }
    } else {
      result.push(lines[i]!);
      i++;
    }
  }

  return result.join("\n");
}

export function addRouteExclusion(matrix: string, route: RouteName): string {
  if (matrix.includes(`excluded route '${route}'`)) return matrix;

  let result = matrix;

  result = result.replace(
    new RegExp(` ${escapeRegex(route)} `, "g"),
    " ",
  );

  const exclusionBlock = `\necho "── Excluded routes ──────────────────────────────────────────────────────"\nif ! grep -q "route == '${route}'" "$ROUTER_YML"; then\n  PASS=$((PASS + 1))\n  echo "  ${route} correctly excluded from work-router.yml"\nelse\n  FAIL=$((FAIL + 1))\n  echo "FAIL: excluded route '${route}' is still in work-router.yml" >&2\nfi\n`;

  result = result.replace(
    /(\necho\nif \[ "\$FAIL" -eq 0 \])/,
    `${exclusionBlock}$1`,
  );

  return result;
}

export function processRoutes(
  files: Map<string, string>,
  selectedRoutes: readonly RouteName[],
): Map<string, string> {
  const excludedRoutes = routeNames.filter((r) => !selectedRoutes.includes(r));
  if (excludedRoutes.length === 0) return files;

  const result = new Map(files);

  for (const route of excludedRoutes) {
    const routerKey = findFileKey(result, "work-router.yml");
    if (routerKey !== undefined) {
      result.set(routerKey, stripRouteFromRouter(result.get(routerKey)!, route));
    }

    const matrixKey = findFileKey(result, "verify-route-matrix.sh");
    if (matrixKey !== undefined) {
      result.set(matrixKey, addRouteExclusion(result.get(matrixKey)!, route));
    }
  }

  const matrixKey = findFileKey(result, "verify-route-matrix.sh");
  if (matrixKey !== undefined) {
    result.set(matrixKey, createRouteMatrix(selectedRoutes));
  }

  return result;
}

function createRouteMatrix(selectedRoutes: readonly RouteName[]): string {
  const selected = selectedRoutes.join(" ");
  const excluded = routeNames.filter((route) => !selectedRoutes.includes(route)).join(" ");

  return `#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
ROUTER_YML="\${HERE}/../../workflows/work-router.yml"
CLASSIFIER="\${HERE}/../classify-route/classify-route.sh"

bash -n "$CLASSIFIER"

for route in ${selected}; do
  grep -q "route == '$route'" "$ROUTER_YML" || {
    echo "FAIL: selected route '$route' has no router job" >&2
    exit 1
  }
done

for route in ${excluded}; do
  if grep -q "route == '$route'" "$ROUTER_YML"; then
    echo "FAIL: excluded route '$route' remains in router" >&2
    exit 1
  fi
done

echo "Route matrix: selected routes valid"
`;
}

export function excludedWorkerFiles(selectedRoutes: readonly RouteName[]): Set<string> {
  return new Set(
    workflowRoutes
      .filter((route) => !selectedRoutes.includes(route.name))
      .map((route) => route.worker),
  );
}

function removeJobBlock(yaml: string, jobName: string): string {
  const lines = yaml.split("\n");
  const startPattern = new RegExp(`^  ${escapeRegex(jobName)}:`);
  const result: string[] = [];
  let skipping = false;

  for (const line of lines) {
    if (skipping) {
      if (/^  \S/.test(line) || /^[^\s]/.test(line)) {
        skipping = false;
        result.push(line);
      }
    } else if (startPattern.test(line)) {
      skipping = true;
    } else {
      result.push(line);
    }
  }

  return result.join("\n");
}

function findFileKey(files: Map<string, string>, endsWith: string): string | undefined {
  for (const key of files.keys()) {
    if (key.endsWith(endsWith)) return key;
  }
  return undefined;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
