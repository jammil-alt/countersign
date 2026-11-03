// The route contract (docs/plan.md §1.2 "Role checks"), checked statically and against the running
// app: every /api/ops route is operator-only and refuses client roles; no portal response schema
// has bundle, instruction, prompt or cost fields; every contract route is mounted.

import {
  buildPath,
  checkRouteContract,
  forbiddenPortalFields,
  type RouteSpec,
  routeFamily,
  routes,
} from "@countersign/core";
import { afterAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, user } from "./api.test-helper";

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

const h = await createApiHarness();
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
  });

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
});
