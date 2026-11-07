import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildPath,
  checkRouteContract,
  defineRoute,
  forbiddenPortalFields,
  routeFamily,
} from "./contract";
import { GmailTestSendBody, OpsInboxItem, routes } from "./routes";

describe("route contract", () => {
  it("holds for the declared routes", () => {
    expect(checkRouteContract(routes)).toEqual([]);
  });

  it("refuses an /api/ops route open to client roles", () => {
    const bad = defineRoute({
      method: "GET",
      path: "/api/ops/clients",
      auth: "session",
      roles: ["operator", "client_admin"],
      summary: "",
      response: z.object({}),
    });
    expect(checkRouteContract({ bad })).toEqual([
      "bad (GET /api/ops/clients): /api/ops routes are operator-only",
    ]);
  });

  it("refuses a portal response carrying bundles, instructions, prompts or cost", () => {
    const leaky = defineRoute({
      method: "GET",
      path: "/api/runs/:id",
      auth: "session",
      roles: ["client_admin", "client_user"],
      summary: "",
      response: z.object({
        id: z.string(),
        steps: z.array(z.object({ summary: z.string(), costUsd: z.string() })),
        agent: z.object({ bundle: z.unknown(), instructions: z.string() }),
      }),
    });
    expect(forbiddenPortalFields(leaky.response).sort()).toEqual([
      "bundle",
      "costUsd",
      "instructions",
    ]);
    expect(checkRouteContract({ leaky })).toHaveLength(1);
    // Business figures such as a landed cost are not model cost.
    expect(forbiddenPortalFields(z.object({ landedCost: z.string() }))).toEqual([]);
  });

  it("says on every back-office inbox item whether the operator may resolve it", () => {
    expect(OpsInboxItem.shape.resolvableByOperator).toBeInstanceOf(z.ZodBoolean);
    // The inbox list, the run view and the resolve answer all carry that item.
    expect(routes.opsInbox.response.shape.items.element).toBe(OpsInboxItem);
    expect(routes.opsRun.response.shape.inbox.element).toBe(OpsInboxItem);
    expect(routes.opsResolveInbox.response.shape.item).toBe(OpsInboxItem);
    const base = {
      id: "i",
      tenantId: "t",
      kind: "approval",
      agentId: null,
      runId: null,
      subjectType: null,
      subjectId: null,
      assigneeRole: "client_admin",
      assigneeUserId: null,
      title: "Is the record right now?",
      payload: {},
      status: "open",
      resolution: null,
      resolvedBy: null,
      dueAt: null,
      createdAt: "2026-11-05T10:00:00.000Z",
      resolvedAt: null,
    };
    // A response without the flag breaks the contract; the server always sets it.
    expect(OpsInboxItem.safeParse(base).success).toBe(false);
    expect(OpsInboxItem.safeParse({ ...base, resolvableByOperator: true }).success).toBe(true);
  });

  it("lets the Gmail test email name no recipient: a client route with a strictly empty body", () => {
    const r = routes.portalGmailTestSend;
    expect(r).toMatchObject({
      method: "POST",
      path: "/api/connections/gmail/test-send",
      auth: "session",
      roles: ["client_admin", "client_user"],
    });
    expect(routeFamily(r)).toBe("portal");
    expect(forbiddenPortalFields(r.response)).toEqual([]);
    expect(r.body).toBe(GmailTestSendBody);
    expect(GmailTestSendBody.safeParse({}).success).toBe(true);
    for (const body of [{ to: "x@y.test" }, { cc: "x@y.test" }, { subject: "Hi" }, null, []]) {
      expect(GmailTestSendBody.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
    expect(
      r.response.safeParse({ to: "pat.lee@gmail.test", sentAt: "2026-11-05T10:00:00.000Z" })
        .success,
    ).toBe(true);
  });

  it("keeps the back office's Gmail test email to operators, with the same strictly empty body", () => {
    const r = routes.opsSandboxGmailTestSend;
    expect(r).toMatchObject({
      method: "POST",
      path: "/api/ops/clients/:id/connections/gmail/test-send",
      roles: ["operator"],
    });
    expect(routeFamily(r)).toBe("ops");
    expect(r.body).toBe(GmailTestSendBody);
    expect(r.summary).toMatch(/not_sandbox/);
    expect(
      checkRouteContract({ leaky: { ...r, roles: ["operator", "client_admin"] as const } }),
    ).toHaveLength(1);
  });

  it("keeps the back office's disconnect to operators, for the Sandbox client", () => {
    const r = routes.opsSandboxDisconnect;
    expect(r).toMatchObject({
      method: "DELETE",
      path: "/api/ops/clients/:id/connections/:connectionId",
      roles: ["operator"],
    });
    expect(routeFamily(r)).toBe("ops");
    expect(r.summary).toMatch(/not_sandbox/);
    expect(r.params?.safeParse({ id: "x", connectionId: "y" }).success).toBe(false);
  });

  it("knows the families and fills path parameters", () => {
    expect(routeFamily({ path: "/api/ops/runs" })).toBe("ops");
    expect(routeFamily({ path: "/api/runs" })).toBe("portal");
    expect(buildPath("/api/ops/agents/:id/versions/:vid", { id: "a b", vid: 3 })).toBe(
      "/api/ops/agents/a%20b/versions/3",
    );
    expect(() => buildPath("/api/x/:id")).toThrow(/:id/);
  });
});
