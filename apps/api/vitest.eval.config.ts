// The Builder's test cases against the real model (src/evals): by hand only, never in `pnpm check`
// (they call the model and their answers vary). See src/evals/builder.eval.ts.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/evals/**/*.eval.ts"],
    testTimeout: 15 * 60_000,
    hookTimeout: 60_000,
    // One case at a time: each sends the whole catalog, and the report is written last.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
