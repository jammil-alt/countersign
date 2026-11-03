// The Workers-runtime project: `*.runtime.test.ts`, run inside workerd by
// @cloudflare/vitest-pool-workers against the bindings in wrangler.jsonc. The pool depends on
// Vitest 4 internals, so apps/api pins vitest@4 for both of its projects (as Plenary Labs does)
// while the rest of the repo is on Vitest 5.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Hyperdrive refuses to start without a local connection string. These tests never reach the
// database, so an unreachable placeholder stands in when none is set (it needs a password:
// miniflare refuses a Hyperdrive string without one).
const HYPERDRIVE_LOCAL = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE";
process.env[HYPERDRIVE_LOCAL] ||= "postgres://absent:absent@127.0.0.1:1/none";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // The real Worker plus a Workflow class that exists only for the tests: it drives the
      // executor through the StepRunner adapter with in-memory ports (src/runtime-harness.ts).
      // wrangler.jsonc's `main` is untouched, so the probe is never deployed.
      main: "./src/runtime-harness.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        workflows: {
          PROBE_WORKFLOW: { name: "countersign-test-probe", className: "ProbeWorkflow" },
        },
      },
    }),
  ],
  test: {
    include: ["src/**/*.runtime.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
