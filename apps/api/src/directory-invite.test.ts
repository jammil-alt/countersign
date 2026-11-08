// Inviting from the directory (2026-11-08): only the client's own people with an email are invited,
// through the same invite as the email form (a member and an invite in that client, the email
// after the commit); vendors, customers and partners are refused, another client's contact is not
// found, the body never sets the address; and the directory's list says who can sign in, for the
// client admin and the operator only. WorkOS is a fake behind the adapter for "invited".

import { newSession, SESSION_COOKIE, sealSession, type WorkOSClient } from "@countersign/auth";
import { appUser, membership } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  user,
} from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;
const code = (v: unknown) => j(v)?.error?.code as string | undefined;

async function membershipsOf(H: ApiHarness, email: string) {
  const [u] = await H.t.db.select().from(appUser).where(eq(appUser.email, email));
  if (!u) return [];
  return H.t.db
    .select({ tenantId: membership.tenantId, role: membership.role, canSign: membership.canSign })
    .from(membership)
    .where(eq(membership.userId, u.id));
}

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("invite from the directory", () => {
  const H = h as ApiHarness;
  const ids: Record<string, string> = {};

  async function person(who: string, body: Record<string, unknown>): Promise<string> {
    const res = await H.call(who, "POST", "/api/contacts", body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return j(res.json).contact.id as string;
  }

  beforeAll(async () => {
    const org = await H.call(admin("a"), "POST", "/api/directory/organizations", {
      name: "Shop A",
      kinds: ["own"],
    });
    expect(org.status).toBe(200);
    const own = j(org.json).organization.id as string;
    ids.employee = await person(admin("a"), {
      name: "Sam Employee",
      email: "Sam@A.example.com",
      relationship: "employee",
    });
    ids.ownOther = await person(admin("a"), {
      name: "Ola Own",
      email: "ola@a.example.com",
      relationship: "other",
      organizationId: own,
    });
    ids.contractor = await person(admin("a"), {
      name: "Cy Contractor",
      email: "cy@a.example.com",
      relationship: "contractor",
    });
    ids.noEmail = await person(admin("a"), {
      name: "Phone Only",
      phone: "+15555550101",
      relationship: "employee",
    });
    for (const relationship of ["vendor", "customer", "partner"] as const) {
      ids[relationship] = await person(admin("a"), {
        name: `A ${relationship}`,
        email: `${relationship}@outside.example.com`,
        relationship,
      });
    }
    ids.b = await person(admin("b"), {
      name: "B Employee",
      email: "emp@b.example.com",
      relationship: "employee",
    });
  });

  it("invites an employee from the portal: a member and an invite, as the email form does", async () => {
    const res = await H.call(admin("a"), "POST", `/api/contacts/${ids.employee}/invite`, {
      role: "client_user",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json)).toEqual({
      member: {
        userId: expect.any(String),
        email: "sam@a.example.com",
        name: "Sam Employee",
        role: "client_user",
        signedIn: null,
        canSign: true,
      },
      email: { status: "not_sent", reason: "dev_sign_in" },
    });
    expect(await membershipsOf(H, "sam@a.example.com")).toEqual([
      { tenantId: H.A.tenantId, role: "client_user", canSign: true },
    ]);
    // Inviting them again is the same refusal as the email form's.
    const again = await H.call(admin("a"), "POST", `/api/contacts/${ids.employee}/invite`, {
      role: "client_user",
    });
    expect([again.status, code(again.json)]).toEqual([409, "already_member"]);
  });

  it("invites from the back office, a viewer or an admin, for the clients it serves", async () => {
    const path = (id: string) => `/api/ops/clients/${H.A.tenantId}/contacts/${id}/invite`;
    const viewer = await H.call(OPERATOR, "POST", path(ids.contractor as string), {
      role: "client_user",
      canSign: false,
    });
    expect(viewer.status, JSON.stringify(viewer.json)).toBe(200);
    expect(await membershipsOf(H, "cy@a.example.com")).toEqual([
      { tenantId: H.A.tenantId, role: "client_user", canSign: false },
    ]);
    // Someone of the client's own organization, whatever their relationship.
    const ownAdmin = await H.call(OPERATOR, "POST", path(ids.ownOther as string), {
      role: "client_admin",
    });
    expect(ownAdmin.status, JSON.stringify(ownAdmin.json)).toBe(200);
    expect(await membershipsOf(H, "ola@a.example.com")).toEqual([
      { tenantId: H.A.tenantId, role: "client_admin", canSign: true },
    ]);
    // An operator who doesn't serve A: not found, nothing written.
    const other = await H.call(OTHER_OPERATOR, "POST", path(ids.vendor as string), {
      role: "client_user",
    });
    expect(other.status).toBe(404);
  });

  it("refuses vendors, customers, partners and people with no email", async () => {
    for (const r of ["vendor", "customer", "partner"]) {
      const res = await H.call(admin("a"), "POST", `/api/contacts/${ids[r]}/invite`, {
        role: "client_user",
      });
      expect([res.status, code(res.json)]).toEqual([422, "not_invitable"]);
      expect(await membershipsOf(H, `${r}@outside.example.com`)).toEqual([]);
      const ops = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/clients/${H.A.tenantId}/contacts/${ids[r]}/invite`,
        { role: "client_user" },
      );
      expect([ops.status, code(ops.json)]).toEqual([422, "not_invitable"]);
    }
    const none = await H.call(admin("a"), "POST", `/api/contacts/${ids.noEmail}/invite`, {
      role: "client_user",
    });
    expect([none.status, code(none.json)]).toEqual([422, "no_email"]);
  });

  it("finds no other client's contact, on either surface", async () => {
    const portal = await H.call(admin("a"), "POST", `/api/contacts/${ids.b}/invite`, {
      role: "client_user",
    });
    expect(portal.status).toBe(404);
    const ops = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/contacts/${ids.b}/invite`,
      { role: "client_user" },
    );
    expect(ops.status).toBe(404);
    expect(await membershipsOf(H, "emp@b.example.com")).toEqual([]);
  });

  it("is the client admin's: a client user can't invite", async () => {
    const res = await H.call(user("a"), "POST", `/api/contacts/${ids.noEmail}/invite`, {
      role: "client_user",
    });
    expect(res.status).toBe(403);
  });

  it("never takes the address or the name from the body", async () => {
    const res = await H.call(admin("a"), "POST", `/api/contacts/${ids.vendor}/invite`, {
      role: "client_user",
      email: "sneaky@a.example.com",
    });
    expect(res.status).toBe(400);
    const named = await H.call(admin("a"), "POST", `/api/contacts/${ids.vendor}/invite`, {
      role: "client_user",
      name: "Someone else",
    });
    expect(named.status).toBe(400);
    expect(await membershipsOf(H, "sneaky@a.example.com")).toEqual([]);
  });

  it("says who can sign in, to the client admin and the operator only", async () => {
    const access = (people: { id: string; access?: unknown }[]) =>
      Object.fromEntries(people.map((p) => [p.id, p.access]));
    const portal = await H.call(admin("a"), "GET", "/api/directory");
    expect(portal.status).toBe(200);
    const a = access(j(portal.json).people);
    // The dev sign-in can't tell who has signed in: members can sign in.
    expect(a[ids.employee as string]).toBe("member");
    expect(a[ids.contractor as string]).toBe("member");
    expect(a[ids.vendor as string]).toBeNull();
    expect(a[ids.noEmail as string]).toBeNull();
    // The organization's kinds come along, so the screens can tell the client's own people.
    const ola = j(portal.json).people.find((p: { id: string }) => p.id === ids.ownOther);
    expect(ola.organization.kinds).toEqual(["own"]);

    const ops = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/directory`);
    expect(access(j(ops.json).people)[ids.ownOther as string]).toBe("member");

    const reader = await H.call(user("a"), "GET", "/api/directory");
    expect(reader.status).toBe(200);
    for (const p of j(reader.json).people) expect(p).not.toHaveProperty("access");
  });
});

describe.skipIf(!h)("invite from the directory through WorkOS", () => {
  const PASSWORD = "p".repeat(64);
  const sent: string[] = [];
  const workos: WorkOSClient = {
    authorizationUrl: () => "https://workos.test/authorize",
    authenticateWithCode: vi.fn(),
    refresh: vi.fn(),
    logoutUrl: () => "https://workos.test/logout",
    revokeSession: vi.fn(async () => undefined),
    organizationName: vi.fn(async () => null),
    async sendInvitation(email) {
      sent.push(email);
      return { id: `inv_${sent.length}`, acceptUrl: null };
    },
    revokeInvitation: vi.fn(async () => "revoked" as const),
  };
  let H: ApiHarness | null = null;
  let cookie = "";

  beforeAll(async () => {
    H = await createApiHarness({
      env: {
        ENVIRONMENT: "staging",
        AUTH_PROVIDER: "workos",
        WORKOS_CLIENT_ID: "client_test",
        WORKOS_API_KEY: "sk_test",
        WORKOS_COOKIE_PASSWORD: PASSWORD,
        APP_ORIGIN: "https://staging.mezonas.test",
      },
      workos,
    });
    if (!H) return;
    const session = newSession(
      {
        userId: H.operator,
        workosUserId: "wu_operator",
        email: OPERATOR,
        workosOrganizationId: null,
        sessionId: "sess_op",
        refreshToken: "rt_op",
      },
      Math.floor(Date.now() / 1000),
    );
    cookie = `${SESSION_COOKIE}=${await sealSession(session, PASSWORD)}`;
  });
  afterAll(() => H?.close());

  it("reads none, invited, then member once they sign in", async () => {
    const X = H as ApiHarness;
    const base = `/api/ops/clients/${X.A.tenantId}`;
    const made = await X.call(
      null,
      "POST",
      `${base}/contacts`,
      { name: "Wren Worker", email: "wren@a.example.com", relationship: "employee" },
      { cookie },
    );
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const id = j(made.json).contact.id as string;
    const accessOf = async () => {
      const res = await X.call(null, "GET", `${base}/directory`, undefined, { cookie });
      return j(res.json).people.find((p: { id: string }) => p.id === id)?.access;
    };
    expect(await accessOf()).toBeNull();

    const res = await X.call(
      null,
      "POST",
      `${base}/contacts/${id}/invite`,
      { role: "client_user" },
      { cookie },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json)).toMatchObject({
      member: { email: "wren@a.example.com", name: "Wren Worker", signedIn: false },
      email: { status: "sent", reason: null },
    });
    expect(sent).toEqual(["wren@a.example.com"]);
    expect(await accessOf()).toBe("invited");

    await X.t.db
      .update(appUser)
      .set({ workosUserId: "wu_wren" })
      .where(eq(appUser.email, "wren@a.example.com"));
    expect(await accessOf()).toBe("member");
  });
});
