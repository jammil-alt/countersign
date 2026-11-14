// The Workers-runtime project: `*.runtime.test.ts`, run inside workerd by
// @cloudflare/vitest-pool-workers through the real entry point. There is no Browser Run here (it
// is bound in the deployed environments only), so `open` answers null, as in local development.
// The pool depends on Vitest 4 internals, so this app pins vitest@4 as apps/api does.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({ main: "./src/index.ts", wrangler: { configPath: "./wrangler.jsonc" } }),
  ],
  test: {
    include: ["src/**/*.runtime.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
