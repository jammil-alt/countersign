import { describe, expect, it } from "vitest";
import { checkRouteContract, forbiddenPortalFields, routeFamily } from "./contract";
import { routes } from "./routes";
import {
  CARRIED_APPROVAL_MAX_AGE_MS,
  carryDecision,
  errorGroupKey,
  OpsModelCall,
  runControlRoutes,
  runErrorCode,
  runErrorKey,
  shortRunId,
  shortRunIdTail,
  wentOnPast,
} from "./run-controls";

describe("short ids", () => {
  it("shows a run as R- and the last 6 hex characters of its id", () => {
    expect(shortRunId("0190f0a0-1234-7abc-8def-00000A1B2C3D")).toBe("R-1b2c3d");
    expect(shortRunIdTail("R-1B2C3D")).toBe("1b2c3d");
    expect(shortRunIdTail("1b2c3d")).toBe("1b2c3d");
    expect(shortRunIdTail("R-1b2c3")).toBeNull();
  });
});

describe("error keys", () => {
  it("names the tool or step kind and a code", () => {
    expect(runErrorKey({ tool: "gmail.send", kind: "action" }, "HTTP 401 Unauthorized")).toBe(
      "gmail.send:unauthorized",
    );
    expect(runErrorKey({ kind: "skill" }, "escalated: cost budget")).toBe("skill:escalated");
    expect(runErrorKey({ kind: "person" }, "timeout")).toBe("person:timeout");
    expect(runErrorKey({ kind: "run" }, "no workflow invoices in that version")).toBe(
      "run:no_workflow",
    );
    expect(runErrorCode("refused: create is off on the qbo connection")).toBe("refused");
    expect(runErrorCode("ProviderNotConfiguredError: no openai model")).toBe(
      "provider_not_configured",
    );
    expect(runErrorCode("something odd")).toBe("failed");
    expect(runErrorCode(null)).toBe("failed");
  });

  it("groups older runs by error.code", () => {
    expect(errorGroupKey({ key: "qbo.bill.update_lines:refused", code: "x" })).toBe(
      "qbo.bill.update_lines:refused",
    );
    expect(errorGroupKey({ code: "budget" })).toBe("budget");
    expect(errorGroupKey({ reason: "x" })).toBe("unknown");
    expect(errorGroupKey(null)).toBe("unknown");
  });
});

describe("carried approvals", () => {
  const now = new Date("2026-11-06T12:00:00Z");
  const signed = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000);

  it("executes an approved write not yet done, signed under 72 hours ago", () => {
    for (const status of ["approved", "executing", "failed"]) {
      expect(carryDecision({ status, approvedAt: signed(2), error: null }, now)).toBe("execute");
    }
  });

  it("never redoes a done write", () => {
    expect(carryDecision({ status: "done", approvedAt: signed(500), error: null }, now)).toBe(
      "done",
    );
  });

  it("asks again when the approval is 72 hours old, missing, or the write may have happened", () => {
    const old = new Date(now.getTime() - CARRIED_APPROVAL_MAX_AGE_MS);
    expect(carryDecision({ status: "approved", approvedAt: old, error: null }, now)).toBe(
      "propose",
    );
    expect(carryDecision({ status: "failed", approvedAt: null, error: null }, now)).toBe("propose");
    expect(
      carryDecision({ status: "failed", approvedAt: signed(1), error: { unconfirmed: true } }, now),
    ).toBe("propose");
    for (const status of ["proposed", "rejected"]) {
      expect(carryDecision({ status, approvedAt: signed(1), error: null }, now)).toBe("propose");
    }
  });

  it("asks again for a failed write its run went on past (onError: continue)", () => {
    expect(
      carryDecision({ status: "failed", approvedAt: signed(1), error: null, carriedOn: true }, now),
    ).toBe("propose");
    // A write that never failed is carried as before.
    expect(
      carryDecision(
        { status: "approved", approvedAt: signed(1), error: null, carriedOn: false },
        now,
      ),
    ).toBe("execute");
    // Where the run ended says whether it went on past the write.
    expect(wentOnPast("save", { nodeId: "save", reason: "x" })).toBe(false);
    expect(wentOnPast("save:o1", { nodeId: "save" })).toBe(false);
    expect(wentOnPast("save", { nodeId: "save:signoff" })).toBe(false);
    expect(wentOnPast("save", { nodeId: "boom" })).toBe(true);
    expect(wentOnPast("each:0:save", { nodeId: "each:1:save" })).toBe(true);
    expect(wentOnPast("save", null)).toBe(true);
  });
});

describe("the routes", () => {
  it("are the back office's only, and model calls never reach the portal", () => {
    expect(checkRouteContract(runControlRoutes)).toEqual([]);
    for (const r of Object.values(runControlRoutes)) expect(routeFamily(r)).toBe("ops");
    // A portal route that carried model calls would break the contract.
    expect(forbiddenPortalFields(OpsModelCall).sort()).toEqual([
      "costUsd",
      "stopReason",
      "tokensIn",
      "tokensOut",
    ]);
    for (const [name, r] of Object.entries(routes)) {
      if (routeFamily(r) === "portal") expect(forbiddenPortalFields(r.response), name).toEqual([]);
    }
    expect(routes.opsRetryRun).toBe(runControlRoutes.opsRetryRun);
  });
});
