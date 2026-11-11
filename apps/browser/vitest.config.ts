// The Node project: the Playwright adapter, the tab the service serves, the Browser Run launch
// options, and the browser connector end to end in real Chromium (chromium.test.ts).
// `*.runtime.test.ts` runs inside workerd (vitest.workers.config.ts).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.runtime.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
