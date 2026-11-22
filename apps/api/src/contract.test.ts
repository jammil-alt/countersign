// The route contract (docs/plan.md §1.2 "Role checks"), checked statically and against the running
// app: every /api/ops route is operator-only and refuses client roles; no portal response schema
// has bundle, instruction, prompt or cost fields; every contract route is mounted; the operator's
// own sign-in to a tool works only in the Sandbox client.

import { createOAuthState } from "@countersign/connectors";
import {
  accountReportRoutes,
  adjustRoutes,
  agentReportRoutes,
  allRoutes,
  buildPath,
  checkRouteContract,
  forbiddenPortalFields,
  manualRoutes,
  portalViewRoutes,
  type RouteSpec,
  routeFamily,
  routes,
  sopRoutes,
} from "@countersign/core";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { admin, createApiHarness, OPERATOR, user } from "./api.test-helper";

const ROUTES = Object.entries(allRoutes) as [string, RouteSpec][];

function filled(path: string): string {
  return buildPath(path, new Proxy({}, { get: () => crypto.randomUUID() }));
}

describe("route contract (static)", () => {
  it("holds for every route the API serves", () => {
    expect(checkRouteContract(allRoutes)).toEqual([]);
  });

  it("lets only a person's own authenticator setup show a secret, once (§1.100)", () => {
    // The step's own setup, and the emailed setup link's (owner, 2026-11-19).
    expect(ROUTES.filter(([, r]) => r.secretShownOnce?.length).map(([name]) => name)).toEqual([
      "secondFactorSetup",
      "setupLinkSetup",
    ]);
  });

  it("declares no portal response with forbidden fields", () => {
    for (const [, r] of ROUTES) {
      if (routeFamily(r) === "portal") expect(forbiddenPortalFields(r.response)).toEqual([]);
    }
  });

  // B6 (docs/builder-plan.md §8): the client's charter and policies reach the portal as the
  // client's own words, with their tags and confirmation; never an agent's prompt or our guardrails'
  // text, which the portal shows only as its own plain-words summary.
  it("keeps the charter's portal routes to the client admin, with no forbidden fields", () => {
    for (const r of [routes.portalKnowledge, routes.portalKnowledgeConfirm]) {
      expect(routeFamily(r)).toBe("portal");
      expect(r.roles).toEqual(["client_admin"]);
      expect(forbiddenPortalFields(r.response)).toEqual([]);
    }
    expect(routes.opsKnowledgeCharterDraft.roles).toEqual(["operator"]);
  });

  // B3 (docs/builder-plan.md §5): the agent manual reaches the portal as a view made by code,
  // never the bundle, its definition, instructions, prompts or cost (agent bundles stay on
  // /api/ops). The running route is checked in agent-manual.test.ts.
  it("keeps the agent manual's portal route to a view with no forbidden fields", () => {
    expect(routeFamily(manualRoutes.portalAgentManual)).toBe("portal");
    expect(manualRoutes.portalAgentManual.roles).toEqual(["client_admin", "client_user"]);
    expect(forbiddenPortalFields(manualRoutes.portalAgentManual.response)).toEqual([]);
    expect(manualRoutes.opsAgentManual.roles).toEqual(["operator"]);
  });

  // docs/sop-plan.md S1: the agent's SOP reaches the portal as a view made by code, never the
  // bundle, its definition, instructions, prompts or cost. The running route is checked in
  // sop.test.ts.
  it("keeps the agent SOP's portal route to a view with no forbidden fields", () => {
    expect(routeFamily(sopRoutes.portalAgentSop)).toBe("portal");
    expect(sopRoutes.portalAgentSop.roles).toEqual(["client_admin", "client_user"]);
    expect(forbiddenPortalFields(sopRoutes.portalAgentSop.response)).toEqual([]);
    expect(sopRoutes.opsAgentSop.roles).toEqual(["operator"]);
  });

  // §1.163: what a client sees for one agent, opened in the back office: operator-only, and the
  // portal page's own answer, so it carries nothing the portal may not. The running route is
  // checked in ops-client-agent-view.test.ts.
  // R4 (docs/plan.md §1.214): the report per agent.
  it("keeps the agent report's portal routes to clients, with no cost, tokens or errors", () => {
    for (const r of [
      agentReportRoutes.portalServiceReport,
      agentReportRoutes.portalServiceReportCsv,
    ]) {
      expect(routeFamily(r)).toBe("portal");
      expect(r.roles).toEqual(["client_admin", "client_user"]);
      expect(forbiddenPortalFields(r.response)).toEqual([]);
    }
    const json = JSON.stringify(
      z.toJSONSchema(agentReportRoutes.portalServiceReport.response, { unrepresentable: "any" }),
    );
    for (const key of ['"errors"', '"spend"', '"errorKey"', '"costOver"', '"mode"', '"clients"']) {
      expect(json).not.toContain(key);
    }
    expect(agentReportRoutes.opsAgentReport.roles).toEqual(["operator"]);
    expect(agentReportRoutes.opsAgentReportCsv.roles).toEqual(["operator"]);
  });

  // R5 (docs/plan.md §1.235): the report per account.
  it("keeps the account report's portal routes to clients, with no cost, errors or Needs us", () => {
    for (const r of [
      accountReportRoutes.portalAccountReport,
      accountReportRoutes.portalAccountReportCsv,
    ]) {
      expect(routeFamily(r)).toBe("portal");
      expect(r.roles).toEqual(["client_admin", "client_user"]);
      expect(forbiddenPortalFields(r.response)).toEqual([]);
    }
    const json = JSON.stringify(
      z.toJSONSchema(accountReportRoutes.portalAccountReport.response, { unrepresentable: "any" }),
    );
    for (const key of ['"needsUs"', '"errorKey"', '"costOver"', '"mode"', '"clients"']) {
      expect(json).not.toContain(key);
    }
    for (const r of [
      accountReportRoutes.opsClientReport,
      accountReportRoutes.opsClientReportCsv,
      accountReportRoutes.opsAccounts,
    ]) {
      expect(routeFamily(r)).toBe("ops");
      expect(r.roles).toEqual(["operator"]);
    }
  });

  // R6 (docs/plan.md §1.236): the portal's saved views carry the portal's filter only.
  it("keeps the portal's saved views to clients, with no back-office filter keys", () => {
    for (const r of Object.values(portalViewRoutes)) {
      expect(routeFamily(r)).toBe("portal");
      expect(r.roles).toEqual(["client_admin", "client_user"]);
      expect(forbiddenPortalFields(r.response)).toEqual([]);
      const json = JSON.stringify(z.toJSONSchema(r.response, { unrepresentable: "any" }));
      for (const key of ['"errorKey"', '"costOver"', '"mode"', '"clients"', '"tenantId"']) {
        expect(json).not.toContain(key);
      }
    }
  });

  it("keeps the back office's client view of an agent to operators, as the portal's answer", () => {
    expect(routeFamily(routes.opsClientAgentView)).toBe("ops");
    expect(routes.opsClientAgentView.roles).toEqual(["operator"]);
    expect(routes.opsClientAgentView.response).toBe(routes.portalService.response);
    expect(forbiddenPortalFields(routes.opsClientAgentView.response)).toEqual([]);
  });

  // B5 (docs/builder-plan.md §7): what the client may adjust reaches the portal as words, bounds
  // and values, never which skill, parameter or step they set; only the client admin changes one.
  // The running routes are checked in client-adjust.test.ts.
  it("keeps client adjustments and manual feedback to views with no forbidden fields", () => {
    for (const r of Object.values(adjustRoutes)) {
      expect(routeFamily(r)).toBe("portal");
      expect(forbiddenPortalFields(r.response)).toEqual([]);
    }
    expect(adjustRoutes.portalAgentAdjust.roles).toEqual(["client_admin"]);
  });
});

const STATE_SECRET = "contract-state-secret-".repeat(2);
const h = await createApiHarness({ env: { OAUTH_STATE_SECRET: STATE_SECRET } });
afterAll(() => h?.close());

describe.skipIf(!h)("route contract (running app)", () => {
  const harness = h as NonNullable<typeof h>;

  it("mounts every contract route", async () => {
    for (const [name, r] of ROUTES) {
      const res = await harness.call(null, r.method, filled(r.path), r.body ? {} : undefined);
      expect(
        (res.json as { error?: { message?: string } } | null)?.error?.message,
        `${name} ${r.method} ${r.path}`,
      ).not.toBe("no such route");
    }
  });

  // Five calls per /api/ops route, one after another: well past the 5 s default on a busy machine.
  it("refuses every /api/ops route to client roles and to no session", async () => {
    const ops = ROUTES.filter(([, r]) => routeFamily(r) === "ops");
    expect(ops.length).toBeGreaterThan(20);
    for (const [name, r] of ops) {
      const path = filled(r.path);
      const body = r.body ? {} : undefined;
      for (const who of [admin("a"), user("a")]) {
        const res = await harness.call(who, r.method, path, body);
        expect(res.status, `${who} → ${name}`).toBe(403);
        const asClient = await harness.call(who, r.method, path, body, {
          "x-countersign-client": harness.A.tenantId,
        });
        expect(asClient.status, `${who} (client A) → ${name}`).toBe(403);
      }
      const anon = await harness.call(null, r.method, path, body);
      expect(anon.status, `anonymous → ${name}`).toBe(401);
    }
  }, 30_000);

  it("refuses client portal routes to an operator acting as one", async () => {
    for (const [name, r] of ROUTES) {
      // /api/session is shared by every role.
      if (routeFamily(r) !== "portal" || r.auth !== "session" || r.roles.includes("operator")) {
        continue;
      }
      const res = await harness.call(
        "operator@example.com",
        r.method,
        filled(r.path),
        r.body ? {} : undefined,
        { "x-countersign-client": harness.A.tenantId },
      );
      expect(res.status, name).toBe(403);
    }
  });

  // docs/plan.md §1.5: the operator connects tools only in the Sandbox client, their own test client.
  it("refuses the operator's own tool sign-in outside the Sandbox, and to client roles", async () => {
    const start = buildPath(routes.opsSandboxAuthorize.path, {
      id: harness.A.tenantId,
      connector: "testkit",
    });
    const finish = buildPath(routes.opsSandboxAuthorizeCallback.path, { connector: "testkit" });
    const state = (
      await createOAuthState(
        {
          tenantId: harness.A.tenantId,
          connector: "testkit",
          userId: harness.operator,
          origin: "ops",
        },
        { secret: STATE_SECRET },
      )
    ).state;
    const body = { params: { code: "c", state } };
    for (const [res, what] of [
      [await harness.call(OPERATOR, "POST", start), "authorize"],
      [await harness.call(OPERATOR, "POST", finish, body), "callback"],
    ] as const) {
      expect(res.status, what).toBe(403);
      expect((res.json as { error: { code: string } }).error.code, what).toBe("not_sandbox");
    }
    for (const who of [admin("a"), user("a")]) {
      expect((await harness.call(who, "POST", start)).status, who).toBe(403);
      expect((await harness.call(who, "POST", finish, body)).status, who).toBe(403);
    }
  });

  // docs/plan.md §1.31: the operator disconnects tools in the Sandbox client only.
  it("refuses the back office's disconnect outside the Sandbox, and to client roles", async () => {
    const path = buildPath(routes.opsSandboxDisconnect.path, {
      id: harness.A.tenantId,
      connectionId: harness.A.connectionId,
    });
    const real = await harness.call(OPERATOR, "DELETE", path);
    expect(real.status).toBe(403);
    expect((real.json as { error: { code: string } }).error.code).toBe("not_sandbox");
    for (const who of [admin("a"), user("a")]) {
      expect((await harness.call(who, "DELETE", path)).status, who).toBe(403);
    }
    expect((await harness.call(null, "DELETE", path)).status).toBe(401);
  });

  // docs/plan.md §1.16 "The Sandbox's uploads": the back office uploads to the Sandbox only.
  it("refuses the back office's upload outside the Sandbox, and to client roles", async () => {
    const path = buildPath(routes.opsSandboxUploads.path, { id: harness.A.tenantId });
    const real = await harness.call(OPERATOR, "POST", path);
    expect(real.status).toBe(403);
    expect((real.json as { error: { code: string } }).error.code).toBe("not_sandbox");
    for (const who of [admin("a"), user("a")]) {
      expect((await harness.call(who, "POST", path)).status, who).toBe(403);
    }
    expect((await harness.call(null, "POST", path)).status).toBe(401);
    // The portal's own upload is the client's: the operator acting as client A is refused.
    const portal = await harness.call(OPERATOR, "POST", routes.portalUploads.path, undefined, {
      "x-countersign-client": harness.A.tenantId,
    });
    expect(portal.status).toBe(403);
  });

  // The test-run payload picker reads one served client's events, operator-only.
  it("refuses a client's recent events to client roles and outside the clients served", async () => {
    const path = `${buildPath(routes.opsClientEvents.path, { id: harness.A.tenantId })}?type=document.extracted`;
    expect((await harness.call(OPERATOR, "GET", path)).status).toBe(200);
    for (const who of [admin("a"), user("a")]) {
      expect((await harness.call(who, "GET", path)).status, who).toBe(403);
    }
    const other = `${buildPath(routes.opsClientEvents.path, { id: harness.C.tenantId })}?type=document.extracted`;
    expect((await harness.call(OPERATOR, "GET", other)).status).toBe(404);
  });

  // docs/plan.md §1.31: the back office's Gmail test email is for the Sandbox client only.
  it("refuses the back office's Gmail test email outside the Sandbox, and to client roles", async () => {
    const path = buildPath(routes.opsSandboxGmailTestSend.path, { id: harness.A.tenantId });
    const real = await harness.call(OPERATOR, "POST", path, {});
    expect(real.status).toBe(403);
    expect((real.json as { error: { code: string } }).error.code).toBe("not_sandbox");
    for (const who of [admin("a"), user("a")]) {
      expect((await harness.call(who, "POST", path, {})).status, who).toBe(403);
    }
    expect((await harness.call(null, "POST", path, {})).status).toBe(401);
    // The portal's own route is the client's: the operator acting as client A is refused.
    const portal = await harness.call(
      OPERATOR,
      "POST",
      routes.portalGmailTestSend.path,
      {},
      {
        "x-countersign-client": harness.A.tenantId,
      },
    );
    expect(portal.status).toBe(403);
  });
});
