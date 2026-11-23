import { describe, expect, it } from "vitest";
import { auditActionWords, auditTargetSubjects, isAuditRefresh } from "./audit-words";

describe("an audit row in words", () => {
  it("says a route's action from its summary, never as a path", () => {
    expect(auditActionWords("GET /api/runs/:id")).toBe("Viewed a run's client timeline");
    expect(auditActionWords("POST /api/ops/builds/:id/items")).toBe(
      "Added an open item to a build",
    );
    expect(auditActionWords("POST /api/ops/issues/:id/reopen")).toBe("Reopened a closed issue");
    expect(auditActionWords("PATCH /api/settings/notifications")).toBe(
      "Chose which notifications we send their people",
    );
    expect(auditActionWords("GET /api/directory")).toBe("Viewed their directory");
    expect(auditActionWords("session.sign_in")).toBe("Signed in");
    expect(auditActionWords("client.retire")).toBe("Client retire");
    // A route no contract names still reads as words.
    expect(auditActionWords("GET /api/nowhere/:id")).toBe("Viewed nowhere");
    for (const a of ["GET /api/ops/runs/:id", "mcp GET /api/ops/runs/:id", "GET /api/ops/agents"]) {
      expect(auditActionWords(a)).not.toMatch(/\/api|:id/);
    }
    expect(auditActionWords("mcp GET /api/ops/runs/:id")).toMatch(/through Claude\)$/);
  });

  it("knows what each id of a target names", () => {
    expect(auditTargetSubjects("GET /api/runs/:id")).toEqual({ client: "client", id: "run" });
    expect(
      auditTargetSubjects("PUT /api/ops/clients/:clientId/connections/:connectionId/release"),
    ).toEqual({ client: "client", clientId: "client" });
    expect(auditTargetSubjects("GET /api/ops/clients/:id/setup")).toEqual({
      client: "client",
      id: "client",
    });
    expect(auditTargetSubjects("session.sign_in")).toEqual({ client: "client" });
  });

  it("reads the refresh tag", () => {
    expect(isAuditRefresh({ id: "x", refresh: "1" })).toBe(true);
    expect(isAuditRefresh({ id: "x" })).toBe(false);
    expect(isAuditRefresh(null)).toBe(false);
  });
});
