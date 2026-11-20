// Platform QA repros (PLATFORM_QA.md). Run with:
//   pnpm --filter @countersign/web exec vitest run --config vitest.qa.config.ts
// Kept out of `pnpm test` and CI: each test asserts the expected behaviour and fails while its
// defect exists.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/qa-platform/**/*.qa.tsx"],
    testTimeout: 20_000,
  },
});
