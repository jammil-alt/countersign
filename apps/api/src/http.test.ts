// One transaction per session request (docs/plan.md §1.90, audit plan 5.1): the user and their
// memberships are read under `app.user_id`, then the handler runs in the same transaction with
// `app.tenant_ids` and `app.operator` set to the request's scope and `app.user_id` cleared. Tested
// through `mount` and `invokeRoute` with routes of their own, so only the plumbing is under test.

import { DEV_USER_HEADER, type Session } from "@countersign/auth";
import type { RouteSpec } from "@countersign/core";
import { auditEvent, type Tx } from "@countersign/db";
import { desc, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { admin, createApiHarness, OPERATOR, user } from "./api.test-helper";
import type { Bindings } from "./env";
import { type AppDeps, type AppEnv, invokeRoute, mount, requestState } from "./http";

const h = await createApiHarness();
afterAll(() => h?.close());

const Seen = z.object({
  ids: z.string(),
  operator: z.string(),
  user: z.string(),
  visible: z.array(z.string()),
  xid: z.string(),
});
type Seen = z.infer<typeof Seen>;

const portalSpec = {
  method: "GET",
  path: "/api/test/scope",
  auth: "session",
  roles: ["client_admin", "client_user"],
  summary: "test: what a portal handler's transaction sees",
  response: Seen,
} as const satisfies RouteSpec;

const Echo = z.object({ n: z.number() });

const portalPost = {
  method: "POST",
  path: "/api/test/echo",
  auth: "session",
  roles: ["client_admin", "client_user"],
  summary: "test: a body read before the transaction, parsed inside it",
  body: Echo,
  response: Echo.extend({ user: z.string() }),
} as const satisfies RouteSpec;

const opsPost = { ...portalPost, path: "/api/ops/test/echo", roles: ["operator"] } as const;

const opsSpec = {
  method: "GET",
  path: "/api/ops/test/scope",
  auth: "session",
  roles: ["operator"],
  summary: "test: what a back-office handler's transaction sees",
  response: Seen,
} as const satisfies RouteSpec;

/** The scope settings and the clients whose memberships the handler's statements can see. */
async function seen(tx: Tx): Promise<Seen> {
  const [settings, visible] = await Promise.all([
    tx
      .execute<{ ids: string; operator: string; uid: string; xid: string }>(
        sql`select current_setting('app.tenant_ids', true) as ids,
          current_setting('app.operator', true) as operator,
          current_setting('app.user_id', true) as uid,
          txid_current()::text as xid`,
      )
      .then((rows) => [...rows][0]),
    tx
      .execute<{ t: string }>(sql`select distinct tenant_id::text as t from membership order by 1`)
      .then((rows) => [...rows].map((r) => r.t)),
  ]);
  if (!settings) throw new Error("no settings");
  const { uid, ...rest } = settings;
  return { ...rest, user: uid, visible };
}

describe.skipIf(!h)("a session request's one transaction", () => {
  const harness = h as NonNullable<typeof h>;
  const committed: string[] = [];
  const app = new Hono<AppEnv>();
  const deps = {
    platform: () => harness.platform,
    openDb: () => ({ db: harness.db, close: async () => {} }),
    instances: () => harness.instances,
    objects: () => harness.objects,
    extractionTransport: () => null,
  } as AppDeps;
  app.use("/api/*", requestState(deps));
  for (const spec of [portalSpec, opsSpec]) {
    mount(app, spec, async ({ tx, afterCommit }) => {
      const out = await seen(tx);
      afterCommit(async () => {
        committed.push(out.xid);
      });
      return out;
    });
  }
  for (const spec of [portalPost, opsPost]) {
    mount(app, spec, async ({ tx, body }) => ({ n: body.n, user: (await seen(tx)).user }));
  }
  let invoked: Seen | undefined;
  // The MCP server's path: a session already built, the route's handler without HTTP.
  app.get("/api/test/invoke", async (c) => {
    const session: Session = {
      user: { id: harness.A.admin, email: admin("a"), name: null },
      memberships: [{ tenantId: harness.A.tenantId, tenantName: "Client A", role: "client_admin" }],
      isOperator: false,
      servedTenantIds: [],
      activeTenantId: harness.A.tenantId,
      activeRole: "client_admin",
      adapter: "dev",
    };
    invoked = await invokeRoute(app, c, session, portalSpec);
    return c.json({ ok: true });
  });
  const env = { ENVIRONMENT: "development", AUTH_PROVIDER: "dev" } as unknown as Bindings;
  const get = async (email: string, path: string) => {
    const res = await app.request(path, { headers: { [DEV_USER_HEADER]: email } }, env);
    return { status: res.status, json: (await res.json()) as unknown };
  };
  const post = async (email: string, path: string, body: string) => {
    const res = await app.request(
      path,
      {
        method: "POST",
        headers: { [DEV_USER_HEADER]: email, "content-type": "application/json" },
        body,
      },
      env,
    );
    return { status: res.status, json: (await res.json()) as unknown };
  };
  const lastAudit = async () => {
    const [row] = await harness.t.db
      .select()
      .from(auditEvent)
      .orderBy(desc(auditEvent.createdAt))
      .limit(1);
    return row;
  };

  it("a portal handler sees its one client, with app.user_id cleared", async () => {
    const res = await get(admin("a"), portalSpec.path);
    expect(res.status).toBe(200);
    const body = Seen.parse(res.json);
    expect(body.ids).toBe(`{${harness.A.tenantId}}`);
    expect(body.operator).toBe("off");
    expect(body.user).toBe("");
    expect(body.visible).toEqual([harness.A.tenantId]);
    // After-commit work runs once the request's one transaction has committed.
    expect(committed).toContain(body.xid);
    const audit = await lastAudit();
    expect(audit?.outcome).toBe("ok");
    expect(audit?.tenantId).toBe(harness.A.tenantId);
  });

  it("a back-office handler sees the clients served, never another operator's", async () => {
    const res = await get(OPERATOR, opsSpec.path);
    expect(res.status).toBe(200);
    const body = Seen.parse(res.json);
    expect(body.operator).toBe("on");
    expect(body.user).toBe("");
    expect(new Set(body.visible)).toEqual(new Set([harness.A.tenantId, harness.B.tenantId]));
    expect(body.visible).not.toContain(harness.C.tenantId);
    const narrowed = Seen.parse(
      (await get(OPERATOR, `${opsSpec.path}?client=${harness.B.tenantId}`)).json,
    );
    expect(narrowed.ids).toBe(`{${harness.B.tenantId}}`);
    expect(narrowed.visible).toEqual([harness.B.tenantId]);
  });

  it("a refusal never runs the handler and writes its audit row alone", async () => {
    const before = committed.length;
    const ops = await get(user("a"), opsSpec.path);
    expect(ops.status).toBe(403);
    expect((await lastAudit())?.outcome).toBe("refused");
    const other = await get(OPERATOR, `${opsSpec.path}?client=${harness.C.tenantId}`);
    expect(other.status).toBe(403);
    expect((await lastAudit())?.outcome).toBe("refused");
    const unknown = await get("nobody@example.com", portalSpec.path);
    expect(unknown.status).toBe(401);
    expect(committed.length).toBe(before);
  });

  it("invokeRoute (the MCP path) runs the handler in the same scope, user cleared", async () => {
    const res = await app.request("/api/test/invoke", {}, env);
    expect(res.status).toBe(200);
    expect(invoked?.ids).toBe(`{${harness.A.tenantId}}`);
    expect(invoked?.user).toBe("");
    expect(invoked?.visible).toEqual([harness.A.tenantId]);
  });

  it("a body is read before the transaction and parsed inside it, after the scope check", async () => {
    const ok = await post(admin("a"), portalPost.path, JSON.stringify({ n: 7 }));
    expect(ok).toEqual({ status: 200, json: { n: 7, user: "" } });
    const bad = await post(admin("a"), portalPost.path, "{not json");
    expect(bad.status).toBe(400);
    expect((await lastAudit())?.outcome).toBe("refused");
    const invalid = await post(admin("a"), portalPost.path, JSON.stringify({ n: "seven" }));
    expect(invalid.status).toBe(400);
    // A refusal still comes before a bad body, as it did.
    const outsider = await post(user("a"), opsPost.path, "{not json");
    expect(outsider.status).toBe(403);
  });
});
