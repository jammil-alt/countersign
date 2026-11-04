// The Node project: everything in this app except `*.runtime.test.ts`, which runs inside workerd
// (vitest.workers.config.ts). Plain logic (routes with fake bindings, mappers) is faster here.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.runtime.test.ts"],
    // Most tests here drive the API against a throwaway Postgres database. Locally each takes well
    // under a second, but on a shared CI runner, with every file creating its database at once,
    // one can pass 5 s (Vitest's unit-test default) and then leak its late writes into the next
    // test. 30 s still catches a real hang.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
