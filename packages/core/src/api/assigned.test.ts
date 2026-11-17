import { describe, expect, it } from "vitest";
import { ASSIGNED_USER_ROUTES, assignedUserMayUse, seesAgent } from "./assigned";
import { routes } from "./routes";

describe("ASSIGNED_USER_ROUTES (docs/plan.md §1.122)", () => {
  const byKey = new Map(Object.values(routes).map((r) => [`${r.method} ${r.path}`, r]));

  it("names only real routes a client user may call", () => {
    for (const entry of ASSIGNED_USER_ROUTES) {
      const route = byKey.get(entry);
      expect(route, entry).toBeDefined();
      expect(route?.roles, entry).toContain("client_user");
    }
  });

  it("keeps the sections that aren't about agents closed", () => {
    for (const closed of [
      "GET /api/connections",
      "GET /api/directory",
      "GET /api/records",
      "GET /api/access",
      "GET /api/threads",
      "GET /api/search",
      "POST /api/runs/ask",
      "GET /api/weekly",
      "GET /api/documents",
    ]) {
      const [method, path] = closed.split(" ") as [string, string];
      expect(assignedUserMayUse({ method, path }), closed).toBe(false);
    }
  });

  it("sees an agent only on the list, or every agent with no list", () => {
    expect(seesAgent(null, "a")).toBe(true);
    expect(seesAgent(null, null)).toBe(true);
    expect(seesAgent(["a"], "a")).toBe(true);
    expect(seesAgent(["a"], "b")).toBe(false);
    expect(seesAgent(["a"], null)).toBe(false);
    expect(seesAgent([], "a")).toBe(false);
  });
});
