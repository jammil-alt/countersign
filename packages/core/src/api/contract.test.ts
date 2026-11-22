import { describe, expect, it } from "vitest";
import { z } from "zod";
import { itemFingerprint } from "../mobile/mobile";
import {
  buildPath,
  checkRouteContract,
  defineRoute,
  forbiddenPortalFields,
  routeFamily,
} from "./contract";
import { GmailTestSendBody, OpsInboxItem, ResolveBody, routes } from "./routes";
import { StepInBody } from "./step-in";

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

  it("lets the back office's resolve and step-in name the card as the operator saw it", async () => {
    // Audit 3.4 (docs/plan.md §1.191): the fingerprint of the item as `OpsInboxItem` sends it.
    const item = {
      id: "i",
      tenantId: "t",
      kind: "approval" as const,
      agentId: null,
      runId: null,
      subjectType: null,
      subjectId: null,
      assigneeRole: "operator",
      assigneeUserId: null,
      title: "Approve the Ridge order",
      payload: { total: "120.00" },
      status: "open" as const,
      resolution: null,
      resolvedBy: null,
      dueAt: null,
      createdAt: "2026-11-05T10:00:00.000Z",
      resolvedAt: null,
      resolvableByOperator: true,
    };
    const seen = await itemFingerprint(OpsInboxItem.parse(item));
    // Which operator asks is not part of it; what the card says is.
    expect(
      await itemFingerprint(OpsInboxItem.parse({ ...item, resolvableByOperator: false })),
    ).toBe(seen);
    expect(
      await itemFingerprint(OpsInboxItem.parse({ ...item, payload: { total: "1200.00" } })),
    ).not.toBe(seen);
    const resolve = ResolveBody;
    expect(resolve.safeParse({ decision: "approve", fingerprint: seen }).success).toBe(true);
    expect(resolve.safeParse({ decision: "approve", fingerprint: "seen" }).success).toBe(false);
    const stepIn = StepInBody;
    for (const body of [
      { action: "approve", reason: "They asked us to.", message: "Hi", fingerprint: seen },
      { action: "reject", reason: "They asked us to.", fingerprint: seen },
      { action: "answer", reason: "They asked us to.", answer: "Northline", fingerprint: seen },
      {
        action: "reassign",
        reason: "x",
        to: { kind: "role", role: "client_user" },
        fingerprint: seen,
      },
    ]) {
      expect(stepIn.safeParse(body).success, JSON.stringify(body)).toBe(true);
      expect(stepIn.safeParse({ ...body, fingerprint: "seen" }).success).toBe(false);
    }
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

  // §1.163: what a client sees for one agent, opened in the back office: operator-only, and the
  // portal's own answer (the same schema), so it never carries what the portal may not.
  it("keeps the back office's client view of an agent to operators, as the portal's answer", () => {
    const r = routes.opsClientAgentView;
    expect(r).toMatchObject({
      method: "GET",
      path: "/api/ops/clients/:id/agents/:agentId/client-view",
      roles: ["operator"],
    });
    expect(routeFamily(r)).toBe("ops");
    expect(r.response).toBe(routes.portalService.response);
    expect(forbiddenPortalFields(r.response)).toEqual([]);
    expect(
      checkRouteContract({ leaky: { ...r, roles: ["operator", "client_admin"] as const } }),
    ).toHaveLength(1);
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
