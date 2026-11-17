import { defineConfig } from "vitest/config";

// Coverage floors for the CI gate (`vitest run --coverage` in .github/workflows/ci.yml). They sit
// just under what the suite measured when the gate was added (lines 83.4%, statements 82.7%,
// branches 78.9%, functions 87.3%) and only ever move up: raise them when coverage rises, never
// lower one to go green.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { lines: 81, statements: 80, branches: 76, functions: 85 },
    },
  },
});
