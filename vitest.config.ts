import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pick up tests from the tests/ folder structure.
    //   tests/unit/        — fast, isolated tests with mocks
    //   tests/integration/ — multi-module or network tests
    //
    // By default `vitest run` executes all tests.
    // Use path filters to run a subset:
    //   npx vitest run tests/unit
    //   npx vitest run tests/integration
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
