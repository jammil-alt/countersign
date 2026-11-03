import { defineConfig } from "vitest/config";

// The outbox tests create a throwaway database on TEST_ADMIN_DATABASE_URL and skip when it is
// unreachable, unless COUNTERSIGN_REQUIRE_DB=1.
export default defineConfig({
  test: { environment: "node", testTimeout: 30_000, hookTimeout: 60_000 },
});
