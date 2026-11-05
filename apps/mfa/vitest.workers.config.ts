// The Workers-runtime project: `*.runtime.test.ts`, run inside workerd by
// @cloudflare/vitest-pool-workers against wrangler.jsonc's Durable Objects, through the real entry
// point. The pool depends on Vitest 4 internals, so this app pins vitest@4 as apps/api does.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // A test key and Twilio subaccount: never real values.
        bindings: {
          MFA_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
          MFA_TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
          MFA_TWILIO_AUTH_TOKEN: "test-auth-token",
          MFA_DAILY_CAP: "3",
          // wrangler.jsonc keeps email codes off everywhere; most tests here exercise them on, and
          // codes.runtime.test.ts switches one identity's object back to off for the off state.
          EMAIL_CODES: "on",
        },
      },
    }),
  ],
  test: {
    include: ["src/**/*.runtime.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
