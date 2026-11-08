// Onboarding and settings (docs/plan.md §1.14): creating a client with its admin invited and
// approvals delegated, invites from the back office and the portal (each lands only in its own
// client, and never makes a second client's person or an operator a member), the client settings
// page's route, the portal's users and notification settings, and the overview of what needs
// attention across the clients an operator serves. WorkOS is a fake behind the adapter.

import {
  newSession,
  SESSION_COOKIE,
  sealSession,
  type WorkOSClient,
  WorkOSError,
} from "@countersign/auth";
import { cloneJson } from "@countersign/core";
import {
  appUser,
  connection,
  inboxItem,
  membership,
  run,
  tenant,
  tenantChange,
} from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;
const code = (v: unknown) => j(v)?.error?.code as string | undefined;

const h = await createApiHarness();
afterAll(() => h?.close());

async function membershipsOf(H: ApiHarness, email: string) {
  const [u] = await H.t.db.select().from(appUser).where(eq(appUser.email, email));
  if (!u) return [];
  return H.t.db
    .select({ tenantId: membership.tenantId, role: membership.role })
    .from(membership)
    .where(eq(membership.userId, u.id));
}

describe.skipIf(!h)("onboarding", () => {
  const H = h as ApiHarness;

  describe("new client", () => {
    it("creates the client, invites its admin, and delegates approvals in one step", async () => {
      const res = await H.call(OPERATOR, "POST", "/api/ops/clients", {
        name: "Cabinet shop",
        timezone: "America/Chicago",
        connectorsOffered: ["upload"],
        approvals: "operator",
        admin: { email: "Owner@Cabinets.example.com", name: "Cab owner" },
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const id = j(res.json).client.id as string;
      expect(j(res.json).admin).toEqual({
        member: {
          userId: expect.any(String),
          email: "owner@cabinets.example.com",
          name: "Cab owner",
          role: "client_admin",
          signedIn: null,
          canSign: true,
        },
        // The dev sign-in sends nothing: the user is in its list at once.
        email: { status: "not_sent", reason: "dev_sign_in" },
      });
      expect(await membershipsOf(H, "owner@cabinets.example.com")).toEqual([
        { tenantId: id, role: "client_admin" },
      ]);

      const settings = await H.call(OPERATOR, "GET", `/api/ops/clients/${id}/settings`);
      expect(settings.status).toBe(200);
      expect(j(settings.json)).toMatchObject({
        client: {
          id,
          name: "Cabinet shop",
          timezone: "America/Chicago",
          sandbox: false,
          internal: false,
        },
        approvals: { externalActions: "operator", changes: [] },
        notifications: { itemsWaiting: true, weeklyDigest: true },
      });
      expect(
        j(settings.json)
          .members.map((m: { role: string }) => m.role)
          .sort(),
      ).toEqual(["client_admin", "operator"]);

      // The admin signs in to the portal of that client, sees the offering and the delegation.
      const session = await H.call("owner@cabinets.example.com", "GET", "/api/session");
      expect(j(session.json).tenants).toEqual([{ id, name: "Cabinet shop", role: "client_admin" }]);
      const portal = await H.call("owner@cabinets.example.com", "GET", "/api/settings");
      expect(j(portal.json)).toMatchObject({ approvals: "operator", emailsOn: false });
      const conns = await H.call("owner@cabinets.example.com", "GET", "/api/connections");
      expect(conns.status).toBe(200);
      expect(j(conns.json).connections.map((c: { connector: string }) => c.connector)).toEqual([
        "upload",
      ]);
    });

    it("creates nothing when the admin can't be invited", async () => {
      const before = await H.t.db.select().from(tenant);
      const res = await H.call(OPERATOR, "POST", "/api/ops/clients", {
        name: "Second home",
        admin: { email: admin("b") },
      });
      expect(res.status).toBe(409);
      expect(code(res.json)).toBe("other_client");
      expect(await H.t.db.select().from(tenant)).toHaveLength(before.length);
      const bad = await H.call(OPERATOR, "POST", "/api/ops/clients", {
        name: "x",
        admin: { email: "not an email" },
      });
      expect(bad.status).toBe(400);
    });
  });

  describe("invites from the back office", () => {
    it("lands only in the client named, served by this operator", async () => {
      const path = `/api/ops/clients/${H.A.tenantId}/invites`;
      const res = await H.call(OPERATOR, "POST", path, {
        email: "clerk@a.example.com",
        name: "Clerk",
        role: "client_user",
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(j(res.json).member).toMatchObject({
        email: "clerk@a.example.com",
        role: "client_user",
      });
      expect(await membershipsOf(H, "clerk@a.example.com")).toEqual([
        { tenantId: H.A.tenantId, role: "client_user" },
      ]);
      // An operator who doesn't serve A can't invite into it, and nothing is written.
      const other = await H.call(OTHER_OPERATOR, "POST", path, {
        email: "sneaky@c.example.com",
        role: "client_admin",
      });
      expect(other.status).toBe(404);
      expect(await membershipsOf(H, "sneaky@c.example.com")).toEqual([]);
    });

    it("refuses a member, another client's person and an operator, saying why", async () => {
      const path = `/api/ops/clients/${H.A.tenantId}/invites`;
      const again = await H.call(OPERATOR, "POST", path, { email: user("a"), role: "client_user" });
      expect([again.status, code(again.json)]).toEqual([409, "already_member"]);
      const other = await H.call(OPERATOR, "POST", path, { email: user("b"), role: "client_user" });
      expect([other.status, code(other.json)]).toEqual([409, "other_client"]);
      const op = await H.call(OPERATOR, "POST", path, {
        email: OTHER_OPERATOR,
        role: "client_admin",
      });
      expect([op.status, code(op.json)]).toEqual([409, "is_operator"]);
      // The Sandbox is the operator's own: it has no client people.
      const [sandbox] = await H.t.db
        .insert(tenant)
        .values({ name: "Sandbox", settings: { sandbox: true } })
        .returning();
      await H.t.db
        .insert(membership)
        .values({ tenantId: sandbox?.id as string, userId: H.operator, role: "operator" });
      const inSandbox = await H.call(OPERATOR, "POST", `/api/ops/clients/${sandbox?.id}/invites`, {
        email: "tester@sandbox.example.com",
        role: "client_admin",
      });
      expect([inSandbox.status, code(inSandbox.json)]).toEqual([409, "sandbox"]);
      expect(await membershipsOf(H, user("b"))).toEqual([
        { tenantId: H.B.tenantId, role: "client_user" },
      ]);
    });
  });

  describe("client settings", () => {
    it("delegates approval with a logged reason, and refuses no-ops and bad timezones", async () => {
      const path = `/api/ops/clients/${H.B.tenantId}/settings`;
      const res = await H.call(OPERATOR, "PATCH", path, {
        approvals: "operator",
        reason: "Owner is away in December",
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(j(res.json).approvals).toMatchObject({
        externalActions: "operator",
        changes: [
          {
            from: "client_admin",
            to: "operator",
            reason: "Owner is away in December",
            by: { email: OPERATOR },
          },
        ],
      });
      // The runtime reads the same setting.
      const [b] = await H.t.db.select().from(tenant).where(eq(tenant.id, H.B.tenantId));
      expect(b?.settings).toMatchObject({ approvals: { external_actions: "operator" } });

      const same = await H.call(OPERATOR, "PATCH", path, { approvals: "operator" });
      expect([same.status, code(same.json)]).toEqual([409, "no_op"]);
      const tz = await H.call(OPERATOR, "PATCH", path, { timezone: "Mars/Olympus" });
      expect([tz.status, code(tz.json)]).toEqual([422, "invalid_timezone"]);
      const renamed = await H.call(OPERATOR, "PATCH", path, {
        name: "Client B, Inc.",
        timezone: "Europe/London",
      });
      expect(j(renamed.json).client).toMatchObject({
        name: "Client B, Inc.",
        timezone: "Europe/London",
      });
      const back = await H.call(OPERATOR, "PATCH", path, { approvals: "client_admin" });
      expect(j(back.json).approvals.changes).toHaveLength(2);
      expect(j(back.json).approvals.changes[0]).toMatchObject({ to: "client_admin", reason: "" });
    });

    it("marks a client as one of our own (M43), logged, without touching its approvals", async () => {
      // Client C, which the other operator serves.
      const path = `/api/ops/clients/${H.C.tenantId}/settings`;
      const res = await H.call(OTHER_OPERATOR, "PATCH", path, {
        internal: true,
        reason: "Mezonas, our own first client",
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(j(res.json).client.internal).toBe(true);
      expect(j(res.json).approvals.changes).toEqual([]);
      const [c] = await H.t.db.select().from(tenant).where(eq(tenant.id, H.C.tenantId));
      expect(c?.settings).toMatchObject({ internal: true, approvals: { undoSeconds: 0 } });
      const changes = await H.t.db
        .select()
        .from(tenantChange)
        .where(eq(tenantChange.tenantId, H.C.tenantId));
      expect(changes.map((x) => x.change)).toEqual([
        { setting: "internal", from: false, to: true },
      ]);
      const same = await H.call(OTHER_OPERATOR, "PATCH", path, { internal: true });
      expect([same.status, code(same.json)]).toEqual([409, "no_op"]);
      const back = await H.call(OTHER_OPERATOR, "PATCH", path, { internal: false });
      expect(j(back.json).client.internal).toBe(false);
    });

    it("is only for the clients an operator serves", async () => {
      const path = `/api/ops/clients/${H.A.tenantId}/settings`;
      expect((await H.call(OTHER_OPERATOR, "GET", path)).status).toBe(404);
      expect((await H.call(OTHER_OPERATOR, "PATCH", path, { approvals: "operator" })).status).toBe(
        404,
      );
      const [a] = await H.t.db.select().from(tenant).where(eq(tenant.id, H.A.tenantId));
      // The shared clients carry only the undo window (v0.12 W1-D); no approver was set.
      expect(a?.settings.approvals).toEqual({ undoSeconds: 0 });
    });
  });

  describe("portal settings", () => {
    it("lists the client's people (never Mezonas staff) to its admin only", async () => {
      const res = await H.call(admin("a"), "GET", "/api/users");
      expect(res.status).toBe(200);
      const emails = j(res.json).users.map((u: { email: string }) => u.email);
      expect(emails).toContain(admin("a"));
      expect(emails).toContain(user("a"));
      expect(emails).not.toContain(OPERATOR);
      expect(emails.some((e: string) => e.endsWith("b.example.com"))).toBe(false);
      expect((await H.call(user("a"), "GET", "/api/users")).status).toBe(403);
    });

    it("lets a client admin invite into their own client only; a client user can't", async () => {
      const refused = await H.call(user("a"), "POST", "/api/users", {
        email: "nope@a.example.com",
        role: "client_user",
      });
      expect(refused.status).toBe(403);
      expect(await membershipsOf(H, "nope@a.example.com")).toEqual([]);

      // Naming another client is refused before anything runs.
      const elsewhere = await H.call(
        admin("a"),
        "POST",
        "/api/users",
        { email: "elsewhere@a.example.com", role: "client_user" },
        { "x-countersign-client": H.B.tenantId },
      );
      expect(elsewhere.status).toBe(403);
      expect(await membershipsOf(H, "elsewhere@a.example.com")).toEqual([]);

      const ok = await H.call(admin("a"), "POST", "/api/users", {
        email: "Buyer@A.example.com",
        role: "client_admin",
      });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      expect(await membershipsOf(H, "buyer@a.example.com")).toEqual([
        { tenantId: H.A.tenantId, role: "client_admin" },
      ]);
      const listed = await H.call(admin("a"), "GET", "/api/users");
      expect(j(listed.json).users.map((u: { email: string }) => u.email)).toContain(
        "buyer@a.example.com",
      );
    });

    it("never tells one client about another's people or about operators", async () => {
      for (const email of [user("b"), OPERATOR]) {
        const res = await H.call(admin("a"), "POST", "/api/users", { email, role: "client_user" });
        expect([res.status, code(res.json)]).toEqual([409, "unavailable"]);
      }
      const member = await H.call(admin("a"), "POST", "/api/users", {
        email: user("a"),
        role: "client_user",
      });
      expect(code(member.json)).toBe("already_member");
    });

    it("stores notification settings for the client admin's own client", async () => {
      const first = await H.call(admin("a"), "GET", "/api/settings");
      expect(j(first.json)).toEqual({
        client: { id: H.A.tenantId, name: "Client A", timezone: "UTC" },
        approvals: "client_admin",
        notifications: { itemsWaiting: true, weeklyDigest: true },
        emailsOn: false,
      });
      const patched = await H.call(admin("a"), "PATCH", "/api/settings/notifications", {
        weeklyDigest: false,
      });
      expect(j(patched.json)).toEqual({
        notifications: { itemsWaiting: true, weeklyDigest: false },
      });
      expect(j((await H.call(admin("a"), "GET", "/api/settings")).json).notifications).toEqual({
        itemsWaiting: true,
        weeklyDigest: false,
      });
      // Client C's settings are untouched (B's admin reads B's).
      expect(j((await H.call(admin("c"), "GET", "/api/settings")).json).notifications).toEqual({
        itemsWaiting: true,
        weeklyDigest: true,
      });
      expect(
        (await H.call(user("a"), "PATCH", "/api/settings/notifications", { itemsWaiting: false }))
          .status,
      ).toBe(403);
      expect(
        (await H.call(admin("a"), "PATCH", "/api/settings/notifications", { email: "x" })).status,
      ).toBe(400);
    });
  });

  describe("overview", () => {
    let agentA = "";
    let agentC = "";

    beforeAll(async () => {
      const ok = async (who: string, method: string, path: string, body?: unknown) => {
        const res = await H.call(who, method, path, body);
        expect(res.status, `${method} ${path}: ${JSON.stringify(res.json)}`).toBe(200);
        return j(res.json);
      };
      const created = await ok(OPERATOR, "POST", "/api/ops/templates", {
        slug: "overview-clerk",
        bundle: testBundle("Overview clerk"),
      });
      const templateId = created.agent.id as string;
      await ok(
        OPERATOR,
        "POST",
        `/api/ops/agents/${templateId}/versions/${created.version.id}/publish`,
      );
      for (const [client, who] of [
        [H.A, OPERATOR],
        [H.C, OTHER_OPERATOR],
      ] as const) {
        const forked = await ok(who, "POST", `/api/ops/templates/${templateId}/fork`, {
          clientId: client.tenantId,
          serviceName: "Record keeping",
        });
        await ok(who, "PATCH", `/api/ops/agents/${forked.agent.id}/operation`, {
          bindings: { testkit: client.connectionId },
        });
        await ok(
          who,
          "POST",
          `/api/ops/agents/${forked.agent.id}/versions/${forked.version.id}/publish`,
        );
        if (client === H.A) agentA = forked.agent.id;
        else agentC = forked.agent.id;
      }
      const bundle = cloneJson(testBundle("Overview clerk"));
      bundle.definition.instructions = "v2 instructions";
      const v2 = await ok(OPERATOR, "POST", `/api/ops/agents/${templateId}/versions`, {
        bundle,
        releaseNote: "Clearer instructions",
      });
      await ok(OPERATOR, "POST", `/api/ops/agents/${templateId}/versions/${v2.version.id}/publish`);

      const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      for (const [client, agentId, who] of [
        [H.A, agentA, OPERATOR],
        [H.C, agentC, OTHER_OPERATOR],
      ] as const) {
        const detail = await ok(who, "GET", `/api/ops/agents/${agentId}`);
        const agentVersionId = detail.agent.liveVersionId as string;
        await H.t.db.insert(run).values([
          {
            tenantId: client.tenantId,
            agentId,
            agentVersionId,
            workflowSlug: "fix-record",
            mode: "live",
            status: "failed",
            error: { message: "Testkit refused the change\nstack…" },
            finishedAt: new Date(),
          },
          // Too old to need attention, a test run, and a run that went fine.
          {
            tenantId: client.tenantId,
            agentId,
            agentVersionId,
            workflowSlug: "fix-record",
            mode: "live",
            status: "failed",
            createdAt: old,
            finishedAt: old,
          },
          {
            tenantId: client.tenantId,
            agentId,
            agentVersionId,
            workflowSlug: "fix-record",
            mode: "test",
            status: "failed",
          },
          {
            tenantId: client.tenantId,
            agentId,
            agentVersionId,
            workflowSlug: "fix-record",
            mode: "live",
            status: "succeeded",
          },
        ]);
        await H.t.db.insert(inboxItem).values([
          {
            tenantId: client.tenantId,
            kind: "approval",
            title: "Approve the change (delegated)",
            assigneeRole: "operator",
          },
          // The client's own item is not the operator's.
          {
            tenantId: client.tenantId,
            kind: "approval",
            title: "Yours",
            assigneeRole: "client_admin",
          },
        ]);
      }
      // A's testkit connection is in error; B has one disconnected that nobody uses.
      await H.t.db
        .update(connection)
        .set({ status: "error" })
        .where(eq(connection.id, H.A.connectionId));
      await H.t.db
        .update(connection)
        .set({ status: "disconnected" })
        .where(eq(connection.id, H.B.connectionId));
      await H.t.db
        .update(connection)
        .set({ status: "disconnected" })
        .where(eq(connection.id, H.C.connectionId));
    });

    it("shows what needs attention in the clients this operator serves, and nothing else", async () => {
      const res = await H.call(OPERATOR, "GET", "/api/ops/overview");
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const o = j(res.json);
      expect(o.failedRuns).toEqual([
        expect.objectContaining({
          client: { id: H.A.tenantId, name: "Client A" },
          agent: expect.objectContaining({ id: agentA, name: "Record keeping" }),
          error: "Testkit refused the change",
        }),
      ]);
      expect(o.inbox).toEqual([
        expect.objectContaining({
          client: { id: H.A.tenantId, name: "Client A" },
          title: "Approve the change (delegated)",
        }),
      ]);
      expect(o.connections).toEqual([
        expect.objectContaining({
          id: H.A.connectionId,
          status: "error",
          connector: "testkit",
          usedBy: ["Record keeping"],
        }),
      ]);
      expect(o.updates).toEqual([
        expect.objectContaining({
          agent: expect.objectContaining({ id: agentA }),
          client: { id: H.A.tenantId, name: "Client A" },
          template: expect.objectContaining({ name: "Overview clerk" }),
          behind: 1,
          releaseNote: "Clearer instructions",
        }),
      ]);
      expect(o.counts).toEqual({ failedRuns: 1, inbox: 1, connections: 1, updates: 1 });

      const other = j((await H.call(OTHER_OPERATOR, "GET", "/api/ops/overview")).json);
      expect(other.clients).toBe(1);
      expect(other.failedRuns.map((r: { client: { id: string } }) => r.client.id)).toEqual([
        H.C.tenantId,
      ]);
      expect(other.inbox.map((i: { client: { id: string } }) => i.client.id)).toEqual([
        H.C.tenantId,
      ]);
      // C's disconnected testkit is used by its agent, so it needs the client too.
      expect(other.connections).toEqual([
        expect.objectContaining({ id: H.C.connectionId, status: "disconnected" }),
      ]);
      expect(other.updates).toEqual([
        expect.objectContaining({ agent: expect.objectContaining({ id: agentC }) }),
      ]);
    });

    it("narrows to one client with ?client=", async () => {
      const res = await H.call(OPERATOR, "GET", `/api/ops/overview?client=${H.B.tenantId}`);
      expect(res.status).toBe(200);
      expect(j(res.json)).toMatchObject({
        clients: 1,
        failedRuns: [],
        inbox: [],
        connections: [],
        updates: [],
      });
    });
  });
});

describe.skipIf(!h)("invites through WorkOS", () => {
  const PASSWORD = "p".repeat(64);
  const sent: string[] = [];
  let fail = false;
  const workos: WorkOSClient = {
    authorizationUrl: () => "https://workos.test/authorize",
    authenticateWithCode: vi.fn(),
    refresh: vi.fn(),
    logoutUrl: () => "https://workos.test/logout",
    revokeSession: vi.fn(async () => undefined),
    organizationName: vi.fn(async () => null),
    async sendInvitation(email) {
      if (fail) throw new WorkOSError("WorkOS answered 400", 400, "invitation_invalid");
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

  const invite = (email: string) =>
    (H as ApiHarness).call(
      null,
      "POST",
      `/api/ops/clients/${(H as ApiHarness).A.tenantId}/invites`,
      { email, role: "client_admin" },
      { cookie },
    );

  it("emails the invitation once the invite is saved, and says if it didn't go", async () => {
    const res = await invite("new.admin@a.example.com");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json)).toMatchObject({
      member: { email: "new.admin@a.example.com", signedIn: false },
      email: { status: "sent", reason: null },
    });
    expect(sent).toEqual(["new.admin@a.example.com"]);

    fail = true;
    const failed = await invite("second.admin@a.example.com");
    expect(j(failed.json).email).toEqual({ status: "failed", reason: "invitation_invalid" });
    // The invite stands: they can still sign in with that address.
    expect(await membershipsOf(H as ApiHarness, "second.admin@a.example.com")).toEqual([
      { tenantId: (H as ApiHarness).A.tenantId, role: "client_admin" },
    ]);
    fail = false;

    // A refused invite rolls back and emails nobody.
    const again = await invite("new.admin@a.example.com");
    expect(again.status).toBe(409);
    expect(sent).toEqual(["new.admin@a.example.com"]);
  });
});
