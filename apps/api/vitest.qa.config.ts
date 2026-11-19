// BUILDER_QA.md: the Agent Builder's QA repros (`src/qa-builder/*.qa.ts`). Each one fails while its
// defect is there. Kept out of `pnpm test` on purpose: run them with
//   pnpm --filter @countersign/api exec vitest run --config vitest.qa.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/qa-builder/**/*.qa.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
