import { describe, expect, it } from "vitest";
import { createDevAdapter, DEV_USER_HEADER, DevAdapterRefusedError, isProduction } from "./dev";
import {
  buildSession,
  getSession,
  requireRole,
  type SessionResult,
  tenantScope,
  toSessionResponse,
} from "./session";
import type { AuthUser, Membership, Session } from "./types";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

const users: Record<string, { user: AuthUser; memberships: Membership[] }> = {
  "owner@ops.test": {
    user: { id: "u-op", email: "owner@ops.test", name: "Owner" },
    memberships: [
      { tenantId: A, tenantName: "Millwork", role: "operator" },
      { tenantId: B, tenantName: "Sandbox", role: "operator" },
    ],
  },
  "admin@millwork.test": {
    user: { id: "u-admin", email: "admin@millwork.test", name: null },
    memberships: [{ tenantId: A, tenantName: "Millwork", role: "client_admin" }],
  },
  "staff@millwork.test": {
    user: { id: "u-staff", email: "staff@millwork.test", name: null },
    memberships: [{ tenantId: A, tenantName: "Millwork", role: "client_user" }],
  },
  "nobody@x.test": { user: { id: "u-none", email: "nobody@x.test", name: null }, memberships: [] },
};

const byId = new Map(Object.values(users).map((u) => [u.user.id, u]));
const directory = {
  async user(id: string) {
    return byId.get(id)?.user ?? null;
  },
  async memberships(id: string) {
    return byId.get(id)?.memberships ?? [];
  },
  async userByEmail(email: string) {
    return users[email]?.user ?? null;
  },
};

const adapter = createDevAdapter({ directory, env: { NODE_ENV: "test" } });
const req = (email?: string) =>
  new Request("http://localhost/api/session", {
    headers: email ? { [DEV_USER_HEADER]: email } : {},
  });

function ok(result: SessionResult): Session {
  if (!result.ok) throw new Error(`refused: ${result.code}`);
  return result.session;
}

describe("dev adapter", () => {
  it("is refused in production, by NODE_ENV or ENVIRONMENT", () => {
    expect(() => createDevAdapter({ directory, env: { NODE_ENV: "production" } })).toThrow(
      DevAdapterRefusedError,
    );
    expect(() => createDevAdapter({ directory, env: { ENVIRONMENT: "Production" } })).toThrow(
      DevAdapterRefusedError,
    );
    expect(isProduction({ ENVIRONMENT: "staging" })).toBe(false);
  });

  it("signs in a seeded user by email, from the header or the cookie", async () => {
    const s = ok(await getSession(req("Admin@Millwork.test"), { adapter, directory }));
    expect(s.user.id).toBe("u-admin");
    expect(s.adapter).toBe("dev");

    const cookie = adapter.signIn("staff@millwork.test").split(";")[0] ?? "";
    const viaCookie = new Request("http://localhost/api/session", { headers: { cookie } });
    expect(ok(await getSession(viaCookie, { adapter, directory })).user.id).toBe("u-staff");
  });

  it("sends no invitation email: the dev sign-in lists invited users at once", async () => {
    expect(await adapter.invite("new@millwork.test")).toEqual({
      status: "not_sent",
      reason: "dev_sign_in",
    });
  });

  it("refuses no credentials and an unknown email", async () => {
    expect(await getSession(req(), { adapter, directory })).toMatchObject({
      ok: false,
      status: 401,
      code: "unauthenticated",
    });
    expect(await getSession(req("who@x.test"), { adapter, directory })).toMatchObject({
      ok: false,
      code: "session_invalid",
    });
  });
});

describe("sessions and roles", () => {
  it("gives an operator the clients they serve and no active client by default", async () => {
    const s = ok(await getSession(req("owner@ops.test"), { adapter, directory }));
    expect(s.isOperator).toBe(true);
    expect(s.servedTenantIds).toEqual([A, B]);
    expect(s.activeTenantId).toBeNull();
    expect(tenantScope(s, "ops")).toEqual({ ok: true, tenantIds: [A, B], operator: true });
    expect(tenantScope(s, "portal")).toMatchObject({ ok: false, code: "tenant_forbidden" });
    expect(requireRole(s, ["operator"])).toEqual({ ok: true, role: "operator" });
    expect(requireRole(s, ["client_admin"])).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("narrows an operator to the selected client", async () => {
    const s = ok(await getSession(req("owner@ops.test"), { adapter, directory, tenantId: B }));
    expect(s.activeTenantId).toBe(B);
    expect(tenantScope(s, "ops")).toEqual({ ok: true, tenantIds: [B], operator: true });
  });

  it("puts a client user in their one client and keeps them out of the back office", async () => {
    const s = ok(await getSession(req("admin@millwork.test"), { adapter, directory }));
    expect(s.isOperator).toBe(false);
    expect(s.activeTenantId).toBe(A);
    expect(s.activeRole).toBe("client_admin");
    expect(tenantScope(s, "portal")).toEqual({ ok: true, tenantIds: [A], operator: false });
    expect(tenantScope(s, "ops")).toMatchObject({ ok: false, status: 403, code: "forbidden" });
    expect(requireRole(s, ["operator"])).toMatchObject({ ok: false, code: "forbidden" });
    expect(requireRole(s, ["client_admin", "operator"])).toEqual({
      ok: true,
      role: "client_admin",
    });

    const staff = ok(await getSession(req("staff@millwork.test"), { adapter, directory }));
    expect(requireRole(staff, ["client_admin"])).toMatchObject({ ok: false });
    expect(requireRole(staff, ["client_admin", "client_user"])).toMatchObject({ ok: true });
  });

  it("refuses a client that is not the user's, and a user with no memberships", async () => {
    expect(
      await getSession(req("admin@millwork.test"), { adapter, directory, tenantId: B }),
    ).toMatchObject({ ok: false, status: 403, code: "tenant_forbidden" });
    expect(await getSession(req("nobody@x.test"), { adapter, directory })).toMatchObject({
      ok: false,
      code: "no_access",
    });
  });

  it("reads the user and memberships in one call when the directory offers it", async () => {
    const calls: string[] = [];
    const together = {
      ...directory,
      async user(id: string) {
        calls.push("user");
        return directory.user(id);
      },
      async memberships(id: string) {
        calls.push("memberships");
        return directory.memberships(id);
      },
      async account(id: string) {
        calls.push("account");
        return { user: byId.get(id)?.user ?? null, memberships: byId.get(id)?.memberships ?? [] };
      },
    };
    const s = ok(await getSession(req("owner@ops.test"), { adapter, directory: together }));
    expect(s.servedTenantIds).toEqual([A, B]);
    // The dev adapter finds the user by email first; the session itself is one call.
    expect(calls).toEqual(["account"]);
    // A user gone since sign-in is refused, as before.
    const gone = { ...together, account: async () => ({ user: null, memberships: [] }) };
    expect(await getSession(req("owner@ops.test"), { adapter, directory: gone })).toMatchObject({
      ok: false,
      code: "session_invalid",
    });
  });

  it("maps to the /api/session response", () => {
    const built = buildSession(
      users["admin@millwork.test"]?.user as AuthUser,
      users["admin@millwork.test"]?.memberships ?? [],
      "dev",
    );
    if (!built.ok) throw new Error("refused");
    expect(toSessionResponse(built.session)).toEqual({
      user: { id: "u-admin", email: "admin@millwork.test", name: null },
      operator: false,
      tenants: [{ id: A, name: "Millwork", role: "client_admin" }],
      activeTenantId: A,
    });
  });
});
