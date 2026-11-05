// The route contract (docs/plan.md §1.2 "Role checks"), checked statically and against the running
// app: every /api/ops route is operator-only and refuses client roles; no portal response schema
// has bundle, instruction, prompt or cost fields; every contract route is mounted; the operator's
// own sign-in to a tool works only in the Sandbox client.

import { createOAuthState } from "@countersign/connectors";
import {
  buildPath,
  checkRouteContract,
  forbiddenPortalFields,
  type RouteSpec,
  routeFamily,
  routes,
} from "@countersign/core";
import { afterAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR, user } from "./api.test-helper";

const ROUTES = Object.entries(routes) as [string, RouteSpec][];

function filled(path: string): string {
  return buildPath(path, new Proxy({}, { get: () => crypto.randomUUID() }));
}

describe("route contract (static)", () => {
  it("holds for every route the API serves", () => {
    expect(checkRouteContract(routes)).toEqual([]);
  });

  it("declares no portal response with forbidden fields", () => {
    for (const [, r] of ROUTES) {
      if (routeFamily(r) === "portal") expect(forbiddenPortalFields(r.response)).toEqual([]);
    }
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
