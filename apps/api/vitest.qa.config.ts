// Platform QA repros (PLATFORM_QA.md). Run with:
//   COUNTERSIGN_REQUIRE_DB=1 pnpm --filter @countersign/api exec vitest run --config vitest.qa.config.ts
// Kept out of `pnpm test` and CI: each test asserts the expected behaviour and fails while its
// defect exists.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/qa-platform/**/*.qa.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
