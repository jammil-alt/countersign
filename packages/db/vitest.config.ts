import { defineConfig } from "vitest/config";

// Database tests create throwaway databases on TEST_ADMIN_DATABASE_URL and skip when it is
// unreachable, unless COUNTERSIGN_REQUIRE_DB=1. Creating and migrating one in `beforeAll` can take
// longer than vitest's 10-second hook default on a busy CI runner, so hooks get the tests' 30 seconds.
export default defineConfig({
  test: { environment: "node", testTimeout: 30_000, hookTimeout: 30_000 },
});
