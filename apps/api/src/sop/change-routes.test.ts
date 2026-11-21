import { allRoutes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { SOP_CHANGE_ROUTES } from "./change-routes";

// docs/sop-plan.md §6: each route that records SOP revisions names a real, writing route, so a
// renamed path can't silently stop recording.
describe("the routes that change an agent's SOP", () => {
  it("each names a route the API serves, and none reads", () => {
    const served = new Set(
      Object.values(allRoutes).map(
        (r) => `${(r as { method: string }).method} ${(r as { path: string }).path}`,
      ),
    );
    for (const key of Object.keys(SOP_CHANGE_ROUTES)) {
      expect(served.has(key), key).toBe(true);
      expect(key.startsWith("GET "), key).toBe(false);
    }
  });
});
