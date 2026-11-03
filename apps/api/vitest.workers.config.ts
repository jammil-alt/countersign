// The Workers-runtime project: `*.runtime.test.ts`, run inside workerd by
// @cloudflare/vitest-pool-workers against the bindings in wrangler.jsonc. The pool depends on
// Vitest 4 internals, so apps/api pins vitest@4 for both of its projects (as Plenary Labs does)
// while the rest of the repo is on Vitest 5.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["src/**/*.runtime.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
