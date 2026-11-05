// The Node project: the code service's pure logic (TOTP, encryption, Twilio signatures, email
// authentication, matching). `*.runtime.test.ts` runs inside workerd (vitest.workers.config.ts).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.runtime.test.ts"],
  },
});
