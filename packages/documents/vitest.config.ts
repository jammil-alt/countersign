import { defineConfig } from "vitest/config";

// Database tests create throwaway databases on TEST_ADMIN_DATABASE_URL and skip when it is
// unreachable, unless COUNTERSIGN_REQUIRE_DB=1. Models are FakeModels: no test calls the API.
export default defineConfig({
  test: { environment: "node", testTimeout: 60_000, hookTimeout: 60_000 },
});
