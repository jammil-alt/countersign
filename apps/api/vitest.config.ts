// The Node project: everything in this app except `*.runtime.test.ts`, which runs inside workerd
// (vitest.workers.config.ts). Plain logic (routes with fake bindings, mappers) is faster here.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.runtime.test.ts"],
  },
});
