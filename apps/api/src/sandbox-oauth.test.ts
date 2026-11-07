// The operator's own OAuth sign-in in the Sandbox client (docs/plan.md §1.5), through the API against
// the fake QuickBooks and the fake Google: the back office starts the sign-in, the provider returns
// to the same registered API path, the forwarder sends a signed back-office state to the back
// office's page, and the ops callback stores the connection in the Sandbox, by the operator, and
// starts QuickBooks' first sync. Refused: any other client, client roles, a state another operator
// started, a tampered or expired state, a portal state. The portal's own sign-in is unchanged.

import {
  createGmailConnector,
  createOAuthState,
  createQboConnector,
  generateEncryptionKey,
} from "@countersign/connectors";
import {
  FAKE_GOOGLE,
  FAKE_QBO_CLIENT,
  FAKE_QBO_REALM,
  fakeGoogle,
  fakeQbo,
} from "@countersign/connectors/testing";
import { connection, connectionChange, membership, tenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  user,
} from "./api.test-helper";
import { MemoryQboSyncInstances } from "./qbo/instances";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const STATE_SECRET = "state-secret-".repeat(4);
const ORIGIN = "https://staging.mezonas.test";
const MAILBOX = "operator@gmail.test";
const qbo = fakeQbo({ codes: ["fixture-code", "portal-code"] });
const google = fakeGoogle();
const syncs = new MemoryQboSyncInstances();

const h = await createApiHarness({
  connectors: () => [
    createQboConnector({
      ...FAKE_QBO_CLIENT,
      environment: "sandbox",
      fetch: qbo.fetch,
      sleep: async () => {},
    }),
    createGmailConnector({ ...FAKE_GOOGLE, fetch: google.fetch }),
  ],
  env: { ENCRYPTION_KEY, OAUTH_STATE_SECRET: STATE_SECRET, APP_ORIGIN: ORIGIN },
  qboSync: syncs,
});
afterAll(() => h?.close());

describe.skipIf(!h)("the operator's sign-in in the Sandbox client", () => {
  const H = h as ApiHarness;
  let sandbox = "";

  const stateOf = (redirectUrl: string) => new URL(redirectUrl).searchParams.get("state") ?? "";
  const authorize = (who: string, clientId: string, connector: string) =>
    H.call(who, "POST", `/api/ops/clients/${clientId}/connections/${connector}/authorize`);
  const opsCallback = (who: string, connector: string, params: Record<string, string>) =>
    H.call(who, "POST", `/api/ops/connections/${connector}/callback`, { params });
  /** A state signed with the deployment's secret, as a back-office sign-in would carry. */
  const signed = async (binding: { tenantId: string; userId: string }, now?: Date) =>
    (
      await createOAuthState(
        { ...binding, connector: "qbo", origin: "ops" },
        { secret: STATE_SECRET, ...(now ? { now } : {}) },
      )
    ).state;

  beforeAll(async () => {
    const [row] = await H.t.db
      .insert(tenant)
      .values({
        name: "Sandbox",
        settings: { sandbox: true, connectors_offered: ["qbo", "gmail"] },
      })
      .returning();
    if (!row) throw new Error("no sandbox");
    sandbox = row.id;
    // Both operators serve the Sandbox: one can't finish the other's sign-in.
    await H.t.db.insert(membership).values([
      { tenantId: sandbox, userId: H.operator, role: "operator" },
      { tenantId: sandbox, userId: H.otherOperator, role: "operator" },
    ]);
    const offer = await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.A.tenantId}/connectors`, {
      offered: ["testkit", "qbo"],
    });
    expect(offer.status, JSON.stringify(offer.json)).toBe(200);
  });

  it("connects QuickBooks: authorize, the registered path, the back office's page, first sync", async () => {
    const view = await H.call(OPERATOR, "GET", `/api/ops/clients/${sandbox}/connections`);
    expect(
      j(view.json).connectors.filter((c: { id: string }) => ["qbo", "testkit"].includes(c.id)),
    ).toEqual([
      expect.objectContaining({ id: "testkit", auth: "none", available: true }),
      expect.objectContaining({ id: "qbo", auth: "oauth2", available: true }),
    ]);

    const start = await authorize(OPERATOR, sandbox, "qbo");
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const redirect = new URL(j(start.json).redirectUrl);
    expect(redirect.origin + redirect.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    // The same redirect URI the Intuit app registers: no new one.
    expect(redirect.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/api/connections/qbo/callback`,
    );
    const state = stateOf(j(start.json).redirectUrl);

    // Intuit returns to the API path; a signed back-office state goes to the back office's page.
    const query = `code=fixture-code&state=${encodeURIComponent(state)}&realmId=${FAKE_QBO_REALM}`;
    const bounce = await H.call(null, "GET", `/api/connections/qbo/callback?${query}`);
    expect(bounce.status).toBe(302);
    expect(bounce.headers.get("location")).toBe(`/ops/connections/qbo/callback?${query}`);
    expect(bounce.headers.get("cache-control")).toBe("no-store");

    const params = { code: "fixture-code", state, realmId: FAKE_QBO_REALM };
    // The portal can't land a back-office state, even for a client offered QuickBooks.
    const portal = await H.call(admin("a"), "POST", "/api/connections/qbo/callback", { params });
    expect(portal.status).toBe(400);
    expect(j(portal.json).error.code).toBe("mismatch");

    const done = await opsCallback(OPERATOR, "qbo", params);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(j(done.json).clientId).toBe(sandbox);
    const conn = j(done.json).connection;
    expect(conn).toMatchObject({
      tenantId: sandbox,
      connector: "qbo",
      status: "connected",
      externalAccountId: FAKE_QBO_REALM,
      connectedBy: H.operator,
    });
    expect(conn.permissions).toMatchObject({
      create: "approval",
      update: "approval",
      delete: "off",
    });
    expect(JSON.stringify(done.json)).not.toContain("access_token");

    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, conn.id));
    expect(row).toMatchObject({ tenantId: sandbox, connectedBy: H.operator });
    const changes = await H.t.db
      .select()
      .from(connectionChange)
      .where(eq(connectionChange.connectionId, conn.id));
    expect(changes.map((c) => c.change)).toEqual([
      { kind: "status", by: "operator", before: null, after: "connected", account: FAKE_QBO_REALM },
    ]);
    expect(changes[0]?.actorId).toBe(H.operator);

    // The first sync starts as after a portal sign-in.
    await H.settle();
    expect([...syncs.started.values()]).toContainEqual({
      tenantId: sandbox,
      connectionId: conn.id,
      reason: "connected",
    });

    const after = j(
      (await H.call(OPERATOR, "GET", `/api/ops/clients/${sandbox}/connections`)).json,
    );
    expect(after.connections.map((c: { id: string }) => c.id)).toContain(conn.id);
  });

  it("connects the operator's own Gmail in the Sandbox", async () => {
    const start = await authorize(OPERATOR, sandbox, "gmail");
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    expect(new URL(j(start.json).redirectUrl).searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/api/connections/gmail/callback`,
    );
    const state = stateOf(j(start.json).redirectUrl);
    const code = google.issueCode({ address: MAILBOX });
    const query = `state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`;
    const bounce = await H.call(null, "GET", `/api/connections/gmail/callback?${query}`);
    expect(bounce.headers.get("location")).toBe(`/ops/connections/gmail/callback?${query}`);
    const done = await opsCallback(OPERATOR, "gmail", { state, code });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(j(done.json).connection).toMatchObject({
      tenantId: sandbox,
      connector: "gmail",
      status: "connected",
      externalAccountId: MAILBOX,
      connectedBy: H.operator,
    });
  });

  it("refuses any other client, client roles, and states it didn't sign for this operator", async () => {
    // A real client: 403 not_sandbox, at the start and at the callback.
    const real = await authorize(OPERATOR, H.A.tenantId, "qbo");
    expect(real.status).toBe(403);
    expect(j(real.json).error.code).toBe("not_sandbox");
    const realCallback = await opsCallback(OPERATOR, "qbo", {
      code: "fixture-code",
      state: await signed({ tenantId: H.A.tenantId, userId: H.operator }),
    });
    expect(realCallback.status).toBe(403);
    expect(j(realCallback.json).error.code).toBe("not_sandbox");
    // A client the operator doesn't serve: not found.
    const unserved = await opsCallback(OPERATOR, "qbo", {
      code: "fixture-code",
      state: await signed({ tenantId: H.C.tenantId, userId: H.operator }),
    });
    expect(unserved.status).toBe(404);

    // Client roles never reach the back office's routes.
    const mine = await signed({ tenantId: sandbox, userId: H.operator });
    for (const who of [admin("a"), user("a")]) {
      expect((await authorize(who, sandbox, "qbo")).status).toBe(403);
      expect((await opsCallback(who, "qbo", { code: "fixture-code", state: mine })).status).toBe(
        403,
      );
    }

    // Another operator who serves the Sandbox can't finish this operator's sign-in.
    const swapped = await opsCallback(OTHER_OPERATOR, "qbo", { code: "fixture-code", state: mine });
    expect(swapped.status).toBe(400);
    expect(j(swapped.json).error.code).toBe("mismatch");

    // A tampered state: the signature fails, and the forwarder doesn't believe its "ops".
    const [payload, sig] = mine.split(".") as [string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const forged = Buffer.from(JSON.stringify({ ...claims, u: H.otherOperator })).toString(
      "base64url",
    );
    const tampered = await opsCallback(OTHER_OPERATOR, "qbo", {
      code: "fixture-code",
      state: `${forged}.${sig}`,
    });
    expect(tampered.status).toBe(400);
    expect(j(tampered.json).error.code).toBe("signature");
    const portalState = (
      await createOAuthState(
        { tenantId: sandbox, connector: "qbo", userId: H.operator },
        { secret: STATE_SECRET },
      )
    ).state;
    const [portalPayload, portalSig] = portalState.split(".") as [string, string];
    const raised = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(portalPayload, "base64url").toString("utf8")),
        o: "ops",
      }),
    ).toString("base64url");
    const forward = await H.call(
      null,
      "GET",
      `/api/connections/qbo/callback?code=x&state=${raised}.${portalSig}`,
    );
    expect(forward.headers.get("location")).toBe(
      `/connections/qbo/callback?code=x&state=${raised}.${portalSig}`,
    );

    // An expired state.
    const stale = await signed(
      { tenantId: sandbox, userId: H.operator },
      new Date(Date.now() - 20 * 60_000),
    );
    const expired = await opsCallback(OPERATOR, "qbo", { code: "fixture-code", state: stale });
    expect(expired.status).toBe(400);
    expect(j(expired.json).error.code).toBe("expired");

    // A portal state, a state for another connector, and none at all.
    const fromPortal = await opsCallback(OPERATOR, "qbo", {
      code: "fixture-code",
      state: portalState,
    });
    expect(j(fromPortal.json).error.code).toBe("mismatch");
    const otherConnector = await opsCallback(OPERATOR, "gmail", {
      code: "fixture-code",
      state: mine,
    });
    expect(j(otherConnector.json).error.code).toBe("mismatch");
    const none = await opsCallback(OPERATOR, "qbo", { code: "fixture-code" });
    expect(j(none.json).error.code).toBe("missing_state");

    // Only a connector offered to the Sandbox.
    expect((await authorize(OPERATOR, sandbox, "testkit")).status).toBe(404);
  });

  it("leaves the portal's sign-in as it was", async () => {
    const start = await H.call(admin("a"), "POST", "/api/connections/qbo/authorize");
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const state = stateOf(j(start.json).redirectUrl);
    const query = `code=portal-code&state=${encodeURIComponent(state)}&realmId=${FAKE_QBO_REALM}`;
    const bounce = await H.call(null, "GET", `/api/connections/qbo/callback?${query}`);
    expect(bounce.headers.get("location")).toBe(`/connections/qbo/callback?${query}`);
    const params = { code: "portal-code", state, realmId: FAKE_QBO_REALM };
    // The back office can't land a portal state.
    const asOps = await opsCallback(OPERATOR, "qbo", params);
    expect(j(asOps.json).error.code).toBe("mismatch");
    const done = await H.call(admin("a"), "POST", "/api/connections/qbo/callback", { params });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const id = j(done.json).connection.connection.id;
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, id));
    expect(row).toMatchObject({ tenantId: H.A.tenantId, connectedBy: H.A.admin });
    const changes = await H.t.db
      .select()
      .from(connectionChange)
      .where(eq(connectionChange.connectionId, id));
    expect(changes.map((c) => (c.change as { by: string }).by)).toEqual(["client"]);
  });

  // docs/plan.md §1.31: the operator disconnects what they connected in the Sandbox, as the portal
  // does (revoked at the provider, credentials dropped), recorded `by: operator`.
  it("disconnects the Sandbox's Gmail and QuickBooks, revoking at the provider; nowhere else", async () => {
    const rows = await H.t.db.select().from(connection).where(eq(connection.tenantId, sandbox));
    const gmail = rows.find((r) => r.connector === "gmail");
    const quickbooks = rows.find((r) => r.connector === "qbo");
    if (!gmail || !quickbooks) throw new Error("the Sandbox's connections are missing");
    const disconnect = (who: string, clientId: string, id: string) =>
      H.call(who, "DELETE", `/api/ops/clients/${clientId}/connections/${id}`);

    // Client A's own QuickBooks (connected from the portal above): not the operator's to drop.
    const [real] = await H.t.db
      .select()
      .from(connection)
      .where(and(eq(connection.tenantId, H.A.tenantId), eq(connection.connector, "qbo")));
    if (!real) throw new Error("client A has no QuickBooks");
    const refused = await disconnect(OPERATOR, H.A.tenantId, real.id);
    expect(refused.status).toBe(403);
    expect(j(refused.json).error.code).toBe("not_sandbox");
    // Client roles, and another client's connection under the Sandbox's path.
    for (const who of [admin("a"), user("a")]) {
      expect((await disconnect(who, sandbox, gmail.id)).status, who).toBe(403);
    }
    expect((await disconnect(OPERATOR, sandbox, real.id)).status).toBe(404);
    const [stillThere] = await H.t.db.select().from(connection).where(eq(connection.id, real.id));
    expect(stillThere?.status).toBe("connected");
    expect(stillThere?.credentialsEncrypted).not.toBeNull();

    const googleRevoked = google.revoked().length;
    const offGmail = await disconnect(OPERATOR, sandbox, gmail.id);
    expect(offGmail.status, JSON.stringify(offGmail.json)).toBe(200);
    expect(j(offGmail.json).connection).toMatchObject({ id: gmail.id, status: "disconnected" });
    expect(google.revoked()).toHaveLength(googleRevoked + 1);

    const qboRevoked = qbo.revoked.length;
    const offQbo = await disconnect(OPERATOR, sandbox, quickbooks.id);
    expect(offQbo.status, JSON.stringify(offQbo.json)).toBe(200);
    expect(qbo.revoked.length).toBe(qboRevoked + 1);

    for (const id of [gmail.id, quickbooks.id]) {
      const [row] = await H.t.db.select().from(connection).where(eq(connection.id, id));
      expect(row).toMatchObject({ status: "disconnected", credentialsEncrypted: null });
      const changes = await H.t.db
        .select()
        .from(connectionChange)
        .where(eq(connectionChange.connectionId, id))
        .orderBy(connectionChange.createdAt);
      expect(changes.at(-1)?.actorId).toBe(H.operator);
      expect(changes.at(-1)?.change).toEqual({
        kind: "status",
        by: "operator",
        before: "connected",
        after: "disconnected",
      });
    }
    // Again: nothing more to do, and nothing more recorded.
    const count = (
      await H.t.db
        .select()
        .from(connectionChange)
        .where(eq(connectionChange.connectionId, gmail.id))
    ).length;
    expect((await disconnect(OPERATOR, sandbox, gmail.id)).status).toBe(200);
    expect(
      await H.t.db
        .select()
        .from(connectionChange)
        .where(eq(connectionChange.connectionId, gmail.id)),
    ).toHaveLength(count);
    // A disconnected Gmail sends no test email.
    const test = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${sandbox}/connections/gmail/test-send`,
      {},
    );
    expect(test.status).toBe(409);
  });
});
