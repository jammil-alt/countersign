import { describe, expect, it } from "vitest";
import { routes } from "./routes";
import {
  OpsRunsQuery,
  PortalRunsQuery,
  portalRunFilter,
  RunFilter,
  runFilterQuery,
  runStartedBy,
  startedByEventTypes,
} from "./runs-filter";

const A = "0190f0a0-0000-7000-8000-000000000001";
const B = "0190f0a0-0000-7000-8000-000000000002";

describe("RunFilter query parameters", () => {
  it("reads lists, the older single names and the flags on the back office's list", () => {
    const q = OpsRunsQuery.parse({
      clients: `${A},${B}`,
      client: A,
      status: "failed",
      statuses: "cancelled",
      startedBy: "schedule,webhook",
      attemptsOver: "1",
      costOver: "0.25",
      errorKey: "gmail.send:unauthorized",
      perDay: "1",
      groupBy: "error",
      limit: "20",
    });
    expect(q).toEqual({
      filter: {
        clients: [A, B],
        statuses: ["cancelled", "failed"],
        startedBy: ["schedule", "webhook"],
        attemptsOver: 1,
        costOver: "0.25",
        errorKey: "gmail.send:unauthorized",
      },
      limit: 20,
      perDay: true,
      groupBy: "error",
    });
  });

  it("keeps the Ops MCP server's and the old screens' parameters working", () => {
    const q = OpsRunsQuery.parse({ agent: A, mode: "test", since: "2026-11-01T00:00:00Z" });
    expect(q.filter).toEqual({ agents: [A], mode: "test", since: "2026-11-01T00:00:00Z" });
    expect(q.limit).toBe(50);
    expect(q.perDay).toBe(false);
  });

  it("refuses values that are not what they say", () => {
    expect(OpsRunsQuery.safeParse({ statuses: "failed,exploded" }).success).toBe(false);
    expect(OpsRunsQuery.safeParse({ clients: "not-an-id" }).success).toBe(false);
    expect(OpsRunsQuery.safeParse({ costOver: "1e3" }).success).toBe(false);
    expect(OpsRunsQuery.safeParse({ startedBy: "telepathy" }).success).toBe(false);
  });

  it("refuses the back office's keys on the portal, cost first among them", () => {
    for (const key of [
      "costOver",
      "clients",
      "client",
      "mode",
      "templates",
      "versions",
      "errorKey",
    ]) {
      const value = key === "costOver" ? "1" : key === "mode" ? "test" : A;
      const r = PortalRunsQuery.safeParse({ [key]: value });
      expect(r.success, key).toBe(false);
    }
    expect(PortalRunsQuery.parse({ service: A, status: "failed", perDay: "1" })).toEqual({
      filter: { agents: [A], statuses: ["failed"] },
      limit: 50,
      perDay: true,
    });
  });

  it("round-trips a saved filter through query parameters", () => {
    const filter = RunFilter.parse({
      clients: [A],
      statuses: ["failed", "waiting"],
      startedBy: ["event"],
      attemptsOver: 2,
      text: "R-1a2b3c",
    });
    expect(OpsRunsQuery.parse(runFilterQuery(filter)).filter).toEqual(filter);
    expect(portalRunFilter({ ...filter, costOver: "1", mode: "live" })).toEqual({
      statuses: ["failed", "waiting"],
      startedBy: ["event"],
      attemptsOver: 2,
      text: "R-1a2b3c",
    });
  });

  it("is what both runs lists take", () => {
    expect(routes.opsRuns.query).toBe(OpsRunsQuery);
    expect(routes.portalRuns.query).toBe(PortalRunsQuery);
    expect(RunFilter.safeParse({ unknownKey: 1 }).success).toBe(false);
  });
});

describe("how a run started", () => {
  it("names each trigger kind in people's terms", () => {
    expect(runStartedBy({ type: "schedule" })).toBe("schedule");
    expect(runStartedBy({ type: "event", eventType: "document.extracted" })).toBe("event");
    expect(runStartedBy({ type: "event", eventType: "webhook.received" })).toBe("webhook");
    expect(runStartedBy({ type: "event", eventType: "inbound.message" })).toBe("message");
    expect(runStartedBy({ type: "event", eventType: "run.succeeded" })).toBe("handoff");
    expect(runStartedBy({ type: "command" })).toBe("message");
    expect(runStartedBy({ type: "manual" })).toBe("manual");
    expect(runStartedBy({ type: "manual", client: true })).toBe("person");
    expect(runStartedBy({ type: "ask" })).toBeNull();
    expect(startedByEventTypes("message")).toContain("inbound.message");
  });
});
