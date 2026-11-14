// Memberships carried in the sealed cookie (docs/plan.md §1.93, audit plan 5.2): within the window a
// session request builds its scope from the cookie and does not read the account; after it, the
// request reads the account in its one transaction and the cookie is sealed again. Tested with the
// dev sign-in, whose carried account is its own sealed cookie; the WorkOS session cookie's is
// tested in packages/auth.

import {
  ACCOUNT_WINDOW_SEC,
  DEV_ACCOUNT_COOKIE,
  DEV_USER_COOKIE,
  DEV_USER_HEADER,
} from "@countersign/auth";
import { type RouteSpec, routes } from "@countersign/core";
import { appUser, membership, type Tx, tenant } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { admin, createApiHarness, OPERATOR } from "./api.test-helper";
import type { Bindings } from "./env";
import { type AppDeps, type AppEnv, mount, mountLong, requestState } from "./http";
import { sessionRoutes } from "./routes/session";

const h = await createApiHarness();
afterAll(() => h?.close());

const Seen = z.object({ ids: z.string(), user: z.string() });

const portalSpec = {
  method: "GET",
  path: "/api/test/account",
  auth: "session",
  roles: ["client_admin", "client_user"],
  summary: "test: the portal scope a request ran with",
  response: Seen,
} as const satisfies RouteSpec;

const opsSpec = { ...portalSpec, path: "/api/ops/test/account", roles: ["operator"] } as const;
const opsLong = { ...opsSpec, path: "/api/ops/test/account-long" } as const;
const opsChange = {
  ...opsSpec,
  method: "POST",
  path: "/api/ops/test/account-changed",
} as const satisfies RouteSpec;

async function seen(tx: Tx) {
  const [row] = [
    ...(await tx.execute<{ ids: string; user: string }>(
      sql`select current_setting('app.tenant_ids', true) as ids,
        current_setting('app.user_id', true) as user`,
    )),
  ];
  if (!row) throw new Error("no settings");
  return row;
}

/** The `name=value` of a Set-Cookie for `name` in a response, or undefined. */
function cookieOf(headers: Headers, name: string): string | undefined {
  return headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .find((c) => c.startsWith(`${name}=`));
}

describe.skipIf(!h)("memberships carried in the cookie", () => {
  const harness = h as NonNullable<typeof h>;
  const app = new Hono<AppEnv>();
  const deps = {
    platform: () => harness.platform,
    openDb: () => ({ db: harness.db, close: async () => {} }),
    instances: () => harness.instances,
    objects: () => harness.objects,
    extractionTransport: () => null,
  } as AppDeps;
  app.use("/api/*", requestState(deps));
  sessionRoutes(app);
  mount(app, portalSpec, async ({ tx }) => seen(tx));
  mount(app, opsSpec, async ({ tx }) => seen(tx));
  mountLong(app, opsLong, async ({ inTx }) => inTx(({ tx }) => seen(tx)));
  mount(app, opsChange, async ({ tx, accountChanged }) => {
    accountChanged();
    return seen(tx);
  });
  const env = { ENVIRONMENT: "development", AUTH_PROVIDER: "dev" } as unknown as Bindings;

  /** A request as `email`, with `carried` as the account cookie when given. */
  const request = async (
    email: string,
    path: string,
    carried?: string,
    method: "GET" | "POST" = "GET",
  ) => {
    const headers: Record<string, string> = { [DEV_USER_HEADER]: email };
    if (carried) headers.cookie = carried;
    const res = await app.request(path, { method, headers }, env);
    const json = (await res.json()) as unknown;
    return { status: res.status, json, carried: cookieOf(res.headers, DEV_ACCOUNT_COOKIE) };
  };

  const at = (sec: number) => vi.setSystemTime(new Date(Date.UTC(2026, 10, 11, 12, 0, sec)));
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fresh client served by OPERATOR, created behind the app's back (as another person would). */
  async function newClientServedBy(userEmail: string, name: string) {
    const [t] = await harness.t.db.insert(tenant).values({ name, settings: {} }).returning();
    const [u] = await harness.t.db
      .select({ id: appUser.id })
      .from(appUser)
      .where(eq(appUser.email, userEmail));
    if (!t || !u) throw new Error("setup");
    await harness.t.db
      .insert(membership)
      .values({ tenantId: t.id, userId: u.id, role: "operator" });
    return t.id;
  }

  it("fresh: the scope comes from the cookie, without reading the account", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    const first = await request(OPERATOR, opsSpec.path);
    expect(first.status).toBe(200);
    // The first request read the account in its transaction and carries it from now on.
    expect(first.carried).toBeDefined();
    const served = `{${[harness.A.tenantId, harness.B.tenantId].sort().join(",")}}`;
    const ids = (s: unknown) => `{${Seen.parse(s).ids.slice(1, -1).split(",").sort().join(",")}}`;
    expect(ids(first.json)).toBe(served);

    // Someone else adds this operator to another client: the cookie does not know yet.
    const added = await newClientServedBy(OPERATOR, "Client D");
    at(ACCOUNT_WINDOW_SEC - 1);
    const fresh = await request(OPERATOR, opsSpec.path, first.carried);
    expect(fresh.status).toBe(200);
    expect(ids(fresh.json)).toBe(served);
    expect(Seen.parse(fresh.json).user).toBe("");
    // A request that used the carried account leaves the cookie as it is.
    expect(fresh.carried).toBeUndefined();
    // The slow-route path uses it too.
    const long = await request(OPERATOR, opsLong.path, first.carried);
    expect(ids(long.json)).toBe(served);
    expect(long.carried).toBeUndefined();

    // Asking for the new client is never refused on the carried account: it is read again.
    const asked = await request(OPERATOR, `${opsSpec.path}?client=${added}`, first.carried);
    expect(asked.status).toBe(200);
    expect(Seen.parse(asked.json).ids).toBe(`{${added}}`);
    expect(asked.carried).toBeDefined();

    // Stale: read again in the request's transaction, and the cookie is sealed again.
    at(ACCOUNT_WINDOW_SEC);
    const stale = await request(OPERATOR, opsSpec.path, first.carried);
    expect(stale.status).toBe(200);
    expect(Seen.parse(stale.json).ids.split(",")).toHaveLength(3);
    expect(stale.carried).toBeDefined();
    expect(stale.carried).not.toBe(first.carried);
    // And the resealed cookie is fresh again, with the new client in it.
    at(ACCOUNT_WINDOW_SEC + 10);
    const again = await request(OPERATOR, opsSpec.path, stale.carried);
    expect(Seen.parse(again.json).ids.split(",")).toHaveLength(3);
    expect(again.carried).toBeUndefined();
  });

  it("a removed member keeps the carried scope only until the window ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    const first = await request(admin("a"), portalSpec.path);
    expect(first.status).toBe(200);
    const where = and(
      eq(membership.tenantId, harness.A.tenantId),
      eq(membership.userId, harness.A.admin),
    );
    await harness.t.db.delete(membership).where(where);
    try {
      at(60);
      // The owner's D2: the carried membership stands for the rest of the window.
      expect((await request(admin("a"), portalSpec.path, first.carried)).status).toBe(200);
      at(ACCOUNT_WINDOW_SEC);
      // After it the account is read: no longer a member of any client, so it is refused.
      expect((await request(admin("a"), portalSpec.path, first.carried)).status).toBe(403);
    } finally {
      await harness.t.db
        .insert(membership)
        .values({ tenantId: harness.A.tenantId, userId: harness.A.admin, role: "client_admin" });
    }
  });

  it("another user's cookie never carries the first's memberships", async () => {
    const operator = await request(OPERATOR, opsSpec.path);
    expect(operator.carried).toBeDefined();
    // Client A's admin with the operator's account cookie: read again, A only.
    const res = await request(admin("a"), portalSpec.path, operator.carried);
    expect(res.status).toBe(200);
    expect(Seen.parse(res.json).ids).toBe(`{${harness.A.tenantId}}`);
    expect(res.carried).toBeDefined();
    expect(res.carried).not.toBe(operator.carried);
    // And the admin with it still has no back office.
    expect((await request(admin("a"), opsSpec.path, operator.carried)).status).toBe(403);
  });

  it("a tampered cookie is never used: the account is read", async () => {
    const first = await request(admin("a"), portalSpec.path);
    const value = first.carried?.split("=")[1] ?? "";
    const flipped = `${value.slice(0, -2)}${value.endsWith("AA") ? "AB" : "AA"}`;
    const res = await request(admin("a"), portalSpec.path, `${DEV_ACCOUNT_COOKIE}=${flipped}`);
    expect(res.status).toBe(200);
    // It did not open, so the account was read and a good cookie sealed in its place.
    expect(res.carried).toBeDefined();
    expect(res.carried).not.toBe(`${DEV_ACCOUNT_COOKIE}=${flipped}`);
  });

  it("the person's own membership change drops the carried account at once", async () => {
    const first = await request(OPERATOR, opsSpec.path);
    const res = await request(OPERATOR, opsChange.path, first.carried, "POST");
    expect(res.status).toBe(200);
    expect(res.carried).toBe(`${DEV_ACCOUNT_COOKIE}=`);
  });

  it("a client the operator creates is in scope on the very next request", async () => {
    const carriedFrom = (headers: Headers) => cookieOf(headers, DEV_ACCOUNT_COOKIE);
    const list = await harness.call(OPERATOR, "GET", "/api/ops/clients");
    const carried = carriedFrom(list.headers);
    expect(carried).toBeDefined();
    const created = await harness.call(
      OPERATOR,
      "POST",
      "/api/ops/clients",
      { name: "Created through the app" },
      { cookie: carried ?? "" },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    // The response drops the carried account; the browser then sends none.
    expect(carriedFrom(created.headers)).toBe(`${DEV_ACCOUNT_COOKIE}=`);
    const id = (created.json as { client: { id: string } }).client.id;
    const next = await harness.call(OPERATOR, "GET", `/api/ops/clients/${id}`);
    expect(next.status).toBe(200);
  });

  it("sign-out and a sign-in drop the carried account", async () => {
    const first = await request(OPERATOR, opsSpec.path);
    const out = await app.request(
      routes.signOut.path,
      { method: "POST", headers: { [DEV_USER_HEADER]: OPERATOR, cookie: first.carried ?? "" } },
      env,
    );
    expect(out.status).toBe(200);
    expect(cookieOf(out.headers, DEV_ACCOUNT_COOKIE)).toBe(`${DEV_ACCOUNT_COOKIE}=`);
    expect(cookieOf(out.headers, DEV_USER_COOKIE)).toBe(`${DEV_USER_COOKIE}=`);
    const signIn = await app.request(
      routes.devSignIn.path,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: first.carried ?? "" },
        body: JSON.stringify({ email: admin("a") }),
      },
      env,
    );
    expect(signIn.status).toBe(200);
    expect(cookieOf(signIn.headers, DEV_ACCOUNT_COOKIE)).toBe(`${DEV_ACCOUNT_COOKIE}=`);
  });

  it("an account too big for a cookie is not carried; each request reads it", async () => {
    const big = "big-operator@example.com";
    const [u] = await harness.t.db.insert(appUser).values({ email: big, name: "Big" }).returning();
    if (!u) throw new Error("setup");
    const tenants = await harness.t.db
      .insert(tenant)
      .values(
        Array.from({ length: 60 }, (_, i) => ({
          name: `A client with a long enough name to fill a cookie ${i}`,
          settings: {},
        })),
      )
      .returning({ id: tenant.id });
    await harness.t.db
      .insert(membership)
      .values(tenants.map((t) => ({ tenantId: t.id, userId: u.id, role: "operator" as const })));
    const res = await request(big, opsSpec.path);
    expect(res.status).toBe(200);
    expect(Seen.parse(res.json).ids.split(",")).toHaveLength(60);
    expect(res.carried).toBeUndefined();
  });
});
