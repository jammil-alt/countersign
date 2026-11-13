// Unit tests for the app's pure modules (no React Native at runtime): the API client, PKCE, the
// signing, the Desk's rules, the lock. Screens are checked by typecheck and on a phone.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
