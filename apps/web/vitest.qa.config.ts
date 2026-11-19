// BUILDER_QA.md: the Agent Builder's screen repros (`src/qa-builder/*.qa.tsx`). Each one fails while
// its defect is there. Kept out of `pnpm test` on purpose: run them with
//   pnpm --filter @countersign/web exec vitest run --config vitest.qa.config.ts
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vite.config";

export default mergeConfig(
  base,
  defineConfig({ test: { include: ["src/qa-builder/**/*.qa.{ts,tsx}"] } }),
);
