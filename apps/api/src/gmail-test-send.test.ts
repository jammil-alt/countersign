// "Send a test email" on the portal's Gmail card (plan §1.31), through the API against a fake
// Google (nothing live): one plain email from the connected mailbox to that same mailbox, in the
// reader's language, recorded in the connection's history with Gmail's message id. Only the client
// admin and the person who connected it may send; the body can't name a recipient; another
// client's mailbox is out of reach; at most one a minute per connection; a disconnected connection
// or one with no stored address sends nothing. The back office offers the same for the Sandbox
// client only, as the operator, in English.

import { createGmailConnector, generateEncryptionKey } from "@countersign/connectors";
import { FAKE_GOOGLE, fakeGoogle, readSentEmail } from "@countersign/connectors/testing";
import { GMAIL_TEST_WORDS } from "@countersign/core";
import { appUser, connection, connectionChange, membership, tenant } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  user,
} from "./api.test-helper";
import { GMAIL_TEST_CHANGE } from "./routes/connections";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const MAILBOX = "pat.lee@gmail.test";
const B_MAILBOX = "orders@b-mill.test";
const COLLEAGUE = "colleague@a.example.com";
const PATH = "/api/connections/gmail/test-send";
const google = fakeGoogle();

const h = await createApiHarness({
  connectors: () => [createGmailConnector({ ...FAKE_GOOGLE, fetch: google.fetch })],
  env: {
    ENCRYPTION_KEY: generateEncryptionKey(),
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    APP_ORIGIN: "https://app.mezonas.test",
  },
});
afterAll(() => h?.close());

describe.skipIf(!h)("Send a test email from the connected Gmail", () => {
  const H = h as ApiHarness;
  let aConn = "";
  let bConn = "";

  async function signIn(who: string, address: string) {
    const start = await H.call(who, "POST", "/api/connections/gmail/authorize");
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const state = new URL(j(start.json).redirectUrl).searchParams.get("state") ?? "";
    const done = await H.call(who, "POST", "/api/connections/gmail/callback", {
      params: { code: google.issueCode({ address }), state },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    return j(done.json).connection.connection.id as string;
  }

  const testsOf = (connectionId: string) =>
    H.t.db
      .select()
      .from(connectionChange)
      .where(
        and(
          eq(connectionChange.connectionId, connectionId),
          sql`${connectionChange.change}->>'kind' = ${GMAIL_TEST_CHANGE}`,
        ),
      )
      .orderBy(connectionChange.createdAt);

  /**
   * The last minute's tests are moved back, so the rate limit lets the next one through. History
   * is immutable (a trigger), so the test's superuser skips triggers for this one transaction.
   */
  const waitAMinute = (connectionId: string) =>
    H.t.db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx
        .update(connectionChange)
        .set({ createdAt: sql`${connectionChange.createdAt} - interval '2 minutes'` })
        .where(eq(connectionChange.connectionId, connectionId));
    });

  beforeAll(async () => {
    for (const client of [H.A, H.B]) {
      const offer = await H.call(
        OPERATOR,
        "PUT",
        `/api/ops/clients/${client.tenantId}/connectors`,
        {
          offered: ["testkit", "gmail"],
        },
      );
      expect(offer.status, JSON.stringify(offer.json)).toBe(200);
    }
    // A second client user in client A, who didn't connect the mailbox.
    const [colleague] = await H.t.db
      .insert(appUser)
      .values({ email: COLLEAGUE, name: "A colleague" })
      .returning();
    await H.t.db
      .insert(membership)
      .values({ tenantId: H.A.tenantId, userId: colleague?.id as string, role: "client_user" });
    aConn = await signIn(user("a"), MAILBOX);
    bConn = await signIn(admin("b"), B_MAILBOX);
  });

  it("sends one email from the mailbox to itself, in the reader's language, and records it", async () => {
    const before = google.sent.length;
    const res = await H.call(user("a"), "POST", PATH, {}, { "accept-language": "es-MX,es;q=0.9" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json).to).toBe(MAILBOX);
    expect(google.sent).toHaveLength(before + 1);
    const sent = google.sent.at(-1);
    expect(sent?.account).toBe(MAILBOX);
    const email = await readSentEmail(sent?.message ?? "");
    expect(email.from).toBe(MAILBOX);
    expect(email.to).toEqual([MAILBOX]);
    expect(email.replyTo).toEqual([]);
    expect(email.subject).toBe(GMAIL_TEST_WORDS.es.subject);
    expect(email.text?.trim()).toBe(GMAIL_TEST_WORDS.es.text);
    expect(`${email.subject} ${email.text}`).not.toContain("!");

    const changes = await testsOf(aConn);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.actorId).toBe(H.A.user);
    expect(changes[0]?.tenantId).toBe(H.A.tenantId);
    expect(changes[0]?.change).toMatchObject({
      kind: GMAIL_TEST_CHANGE,
      by: "client",
      to: MAILBOX,
      gmailMessageId: sent?.id,
      language: "es",
    });
  });

  it("allows one a minute per connection (429 with plain words)", async () => {
    const before = google.sent.length;
    const again = await H.call(admin("a"), "POST", PATH, {});
    expect(again.status).toBe(429);
    expect(j(again.json).error).toMatchObject({ code: "rate_limited" });
    expect(j(again.json).error.message).toMatch(/wait a minute/);
    expect(google.sent).toHaveLength(before);
    expect(await testsOf(aConn)).toHaveLength(1);

    // A minute later the client admin may send one too, in English by default.
    await waitAMinute(aConn);
    const later = await H.call(admin("a"), "POST", PATH, {});
    expect(later.status, JSON.stringify(later.json)).toBe(200);
    expect(google.sent).toHaveLength(before + 1);
    const email = await readSentEmail(google.sent.at(-1)?.message ?? "");
    expect(email.to).toEqual([MAILBOX]);
    expect(email.subject).toBe("Mezonas test email");
    expect(email.text?.trim()).toBe(
      "This is a test from Mezonas. Your Gmail account works: agents can send email from this address, and each email waits for your approval before it is sent. You can disconnect Gmail at any time from Accounts.",
    );
    expect((await testsOf(aConn)).at(-1)?.actorId).toBe(H.A.admin);
  });

  it("refuses a client user who didn't connect it, and the operator", async () => {
    await waitAMinute(aConn);
    const before = google.sent.length;
    const colleague = await H.call(COLLEAGUE, "POST", PATH, {});
    expect(colleague.status).toBe(403);
    expect(j(colleague.json).error.message).toMatch(/person who connected this mailbox/);
    // The same colleague still reads the connection: the session itself is fine.
    expect((await H.call(COLLEAGUE, "GET", "/api/connections")).status).toBe(200);
    const operator = await H.call(
      OPERATOR,
      "POST",
      PATH,
      {},
      {
        "x-countersign-client": H.A.tenantId,
      },
    );
    expect(operator.status).toBe(403);
    expect(google.sent).toHaveLength(before);
  });

  it("never takes a recipient, or anything else, from the body", async () => {
    await waitAMinute(aConn);
    const before = google.sent.length;
    for (const body of [
      { to: "someone@else.test" },
      { cc: "someone@else.test" },
      { address: "someone@else.test" },
    ]) {
      const res = await H.call(user("a"), "POST", PATH, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await H.call(user("a"), "POST", PATH, "not json")).status).toBe(400);
    expect(google.sent).toHaveLength(before);
    expect(google.sent.every((m) => m.message.includes("someone@else.test") === false)).toBe(true);
  });

  it("keeps each client to its own mailbox", async () => {
    const before = google.sent.length;
    // Client B's admin sends to B's mailbox, not A's; A's minute doesn't hold B back.
    const own = await H.call(admin("b"), "POST", PATH, {});
    expect(own.status, JSON.stringify(own.json)).toBe(200);
    expect(j(own.json).to).toBe(B_MAILBOX);
    const sent = google.sent.at(-1);
    expect(sent?.account).toBe(B_MAILBOX);
    expect((await readSentEmail(sent?.message ?? "")).to).toEqual([B_MAILBOX]);
    expect(await testsOf(bConn)).toHaveLength(1);
    // B's admin can't act in client A.
    const intoA = await H.call(
      admin("b"),
      "POST",
      PATH,
      {},
      {
        "x-countersign-client": H.A.tenantId,
      },
    );
    expect(intoA.status).toBe(403);
    // Client C has no Gmail: nothing to send from.
    const c = await H.call(admin("c"), "POST", PATH, {});
    expect(c.status).toBe(404);
    expect(google.sent).toHaveLength(before + 1);
  });

  it("refreshes an expired access token, and records nothing when Gmail refuses", async () => {
    await waitAMinute(aConn);
    google.expireAccessTokens();
    const refreshed = await H.call(user("a"), "POST", PATH, {});
    expect(refreshed.status, JSON.stringify(refreshed.json)).toBe(200);

    await waitAMinute(aConn);
    const recorded = (await testsOf(aConn)).length;
    google.failSends(1, 500);
    const failed = await H.call(user("a"), "POST", PATH, {});
    expect(failed.status).toBe(502);
    expect(j(failed.json).error.code).toBe("connector_failed");
    expect(await testsOf(aConn)).toHaveLength(recorded);
    // Nothing was sent, so trying again right away is allowed.
    expect((await H.call(user("a"), "POST", PATH, {})).status).toBe(200);
  });

  it("refuses a connection with no stored address", async () => {
    await waitAMinute(aConn);
    const before = google.sent.length;
    await H.t.db
      .update(connection)
      .set({ externalAccountId: null })
      .where(eq(connection.id, aConn));
    const res = await H.call(user("a"), "POST", PATH, {});
    expect(res.status).toBe(409);
    expect(j(res.json).error.code).toBe("no_address");
    expect(google.sent).toHaveLength(before);
    await H.t.db
      .update(connection)
      .set({ externalAccountId: MAILBOX })
      .where(eq(connection.id, aConn));
  });

  it("sends nothing from a disconnected Gmail (409)", async () => {
    await waitAMinute(aConn);
    const off = await H.call(user("a"), "DELETE", `/api/connections/${aConn}`);
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    const before = google.sent.length;
    const res = await H.call(user("a"), "POST", PATH, {});
    expect(res.status).toBe(409);
    expect(j(res.json).error.code).toBe("not_connected");
    expect((await H.call(admin("a"), "POST", PATH, {})).status).toBe(409);
    expect(google.sent).toHaveLength(before);
  });
});

// The same button in the back office, for the Sandbox client only (the operator's own test client,
// whose Gmail they connected themselves; Google's verification video is recorded there).
describe.skipIf(!h)("Send a test email from the Sandbox client's Gmail (back office)", () => {
  const H = h as ApiHarness;
  const SANDBOX_MAILBOX = "operator@gmail.test";
  let sandbox = "";
  let sandboxConn = "";
  const opsPath = (clientId: string) => `/api/ops/clients/${clientId}/connections/gmail/test-send`;

  beforeAll(async () => {
    const [row] = await H.t.db
      .insert(tenant)
      .values({ name: "Sandbox", settings: { sandbox: true, connectors_offered: ["gmail"] } })
      .returning();
    sandbox = row?.id as string;
    await H.t.db
      .insert(membership)
      .values({ tenantId: sandbox, userId: H.operator, role: "operator" });
    const start = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${sandbox}/connections/gmail/authorize`,
    );
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const state = new URL(j(start.json).redirectUrl).searchParams.get("state") ?? "";
    const done = await H.call(OPERATOR, "POST", "/api/ops/connections/gmail/callback", {
      params: { code: google.issueCode({ address: SANDBOX_MAILBOX }), state },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    sandboxConn = j(done.json).connection.id;
  });

  it("sends from the Sandbox's mailbox to itself, in English, recorded as the operator's", async () => {
    const before = google.sent.length;
    const res = await H.call(OPERATOR, "POST", opsPath(sandbox), {}, { "accept-language": "de" });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json).to).toBe(SANDBOX_MAILBOX);
    expect(google.sent).toHaveLength(before + 1);
    const sent = google.sent.at(-1);
    expect(sent?.account).toBe(SANDBOX_MAILBOX);
    const email = await readSentEmail(sent?.message ?? "");
    expect(email.from).toBe(SANDBOX_MAILBOX);
    expect(email.to).toEqual([SANDBOX_MAILBOX]);
    expect(email.subject).toBe(GMAIL_TEST_WORDS.en.subject);
    expect(email.text?.trim()).toBe(GMAIL_TEST_WORDS.en.text);
    const changes = await H.t.db
      .select()
      .from(connectionChange)
      .where(
        and(
          eq(connectionChange.connectionId, sandboxConn),
          sql`${connectionChange.change}->>'kind' = ${GMAIL_TEST_CHANGE}`,
        ),
      );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.actorId).toBe(H.operator);
    expect(changes[0]?.change).toMatchObject({
      by: "operator",
      to: SANDBOX_MAILBOX,
      gmailMessageId: sent?.id,
      language: "en",
    });
  });

  it("allows one a minute, and takes nothing from the body", async () => {
    const before = google.sent.length;
    const again = await H.call(OPERATOR, "POST", opsPath(sandbox), {});
    expect(again.status).toBe(429);
    expect(j(again.json).error.code).toBe("rate_limited");
    const named = await H.call(OPERATOR, "POST", opsPath(sandbox), { to: "someone@else.test" });
    expect(named.status).toBe(400);
    expect(google.sent).toHaveLength(before);
  });

  it("refuses any other client (403 not_sandbox) and client roles", async () => {
    const before = google.sent.length;
    const real = await H.call(OPERATOR, "POST", opsPath(H.A.tenantId), {});
    expect(real.status).toBe(403);
    expect(j(real.json).error.code).toBe("not_sandbox");
    for (const who of [admin("a"), user("a")]) {
      expect((await H.call(who, "POST", opsPath(sandbox), {})).status, who).toBe(403);
      expect((await H.call(who, "POST", opsPath(H.A.tenantId), {})).status, who).toBe(403);
    }
    // An operator who doesn't serve the Sandbox doesn't see it.
    expect((await H.call(OTHER_OPERATOR, "POST", opsPath(sandbox), {})).status).toBe(404);
    expect(google.sent).toHaveLength(before);
  });
});
