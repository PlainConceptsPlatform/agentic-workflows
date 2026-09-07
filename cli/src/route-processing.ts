import { routeNames, workflowRoutes, type RouteName } from "./workflow-catalog.js";

// The router is the one derived file: its content is a function of the installed route set.
// The classifier stays the complete pure function (a route with no job is a no-op run), and the
// route matrix reads the installed worker files, so neither is rewritten here.

const routeCrons: Partial<Record<RouteName, string>> = {
  audit: "17 1 * * 1",
};

// Deterministic router jobs that exist only to serve one worker route. They leave with it, or
// the route matrix finds a `route == 'implement'` guard in a router with no implement worker.
const routeHelperJobs: Partial<Record<RouteName, readonly string[]>> = {
  implement: ["check-implement-pr"],
  triage: ["dispatch-triage"],
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

  for (const job of [`call-${route}`, ...(routeHelperJobs[route] ?? [])]) {
    result = removeJobBlock(result, job);
  }

  result = result.replace(
    new RegExp(`^          - ${escapeRegex(route)}\\n`, "gm"),
    "",
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
  const routerKey = findFileKey(result, "work-router.yml");
  if (routerKey === undefined) return result;

  let router = result.get(routerKey)!;
  for (const route of excludedRoutes) {
    router = stripRouteFromRouter(router, route);
  }
  result.set(routerKey, router);

  return result;
}

export function excludedWorkerFiles(selectedRoutes: readonly RouteName[]): Set<string> {
  return new Set(
    workflowRoutes
      .filter((route) => !selectedRoutes.includes(route.name))
      .map((route) => route.worker),
  );
}

// Remove a top-level job (two-space indent) together with the comment lines that introduce it.
// A job's comment describes that job; left behind it describes nothing.
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
      while (result.length > 0 && /^  #/.test(result[result.length - 1]!)) result.pop();
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
