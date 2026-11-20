// SEC lens (security and isolation): client isolation, operator vs portal, audit and card numbers,
// driven through the API harness (cs_worker, so RLS applies) with clients a/b/c, OPERATOR (A and
// B) and OTHER_OPERATOR (C only). Each test asserts the expected behaviour and fails while its
// defect exists.
import { appUser, connection, message } from "@countersign/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { admin, createApiHarness, OPERATOR } from "../api.test-helper";
import { handleEmail } from "../email";
import { defaultDeps } from "../http";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const DOMAIN = "in.example.test";
const h = await createApiHarness({ env: { EMAIL_FORWARDING_DOMAIN: DOMAIN } });
afterAll(() => h?.close());

const CARD = "4111 1111 1111 1111";

describe.skipIf(!h)("SEC: isolation, access and stores", () => {
  const H = h as NonNullable<typeof h>;

  const userId = async (email: string) => {
    const [row] = await H.t.db.select().from(appUser).where(eq(appUser.email, email));
    return row?.id as string;
  };

  it("SEC-1: an unauthenticated email to support@ claiming a client admin is not filed as them", async () => {
    const raw = new TextEncoder().encode(
      [
        "From: Client A admin <admin@a.example.com>",
        `To: support@${DOMAIN}`,
        "Subject: Please change our bank details",
        "Message-ID: <spoof-1@attacker.example>",
        // No Authentication-Results: neither SPF nor DMARC vouches for this sender.
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Our bank account changed; pay vendors to the new one from today.",
      ].join("\r\n"),
    );
    const pending: Promise<unknown>[] = [];
    await handleEmail(
      {
        // The envelope sender is whatever the sending server says: nothing proves it.
        from: "admin@a.example.com",
        to: `support@${DOMAIN}`,
        raw: new Response(raw).body as ReadableStream<Uint8Array>,
        rawSize: raw.length,
      },
      H.env,
      (p) => pending.push(p),
      {
        ...defaultDeps,
        openDb: () => ({ db: H.db, close: async () => {} }),
        instances: () => H.instances,
        objects: () => H.objects,
        extractionTransport: () => null,
      },
    );
    await Promise.all(pending);
    const adminA = await userId(admin("a"));
    // Expected: like every other inbound mail path (authenticatedSenders), an unproven sender is
    // not a client member, so nothing is raised and posted in the client admin's name.
    const rows = await H.t.db.execute<{ raised_by: string | null; sender_id: string | null }>(
      sql`select i.raised_by, m.sender_id from issue i
          left join message m on m.thread_id = i.thread_id and m.sender_type = 'user'
          where i.tenant_id = ${H.A.tenantId} and i.source = 'email'`,
    );
    const asAdmin = [...rows].filter((r) => r.raised_by === adminA || r.sender_id === adminA);
    expect(asAdmin).toEqual([]);
  });

  it("SEC-3: a card number posted in the portal chat is not stored", async () => {
    const list = await H.call(admin("a"), "GET", "/api/threads?subject=lead");
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    const threadId = j(list.json).threads[0].id as string;
    const posted = await H.call(admin("a"), "POST", `/api/threads/${threadId}/messages`, {
      text: `Please pay the supplier on card ${CARD}, exp 12/29`,
    });
    expect(posted.status, JSON.stringify(posted.json)).toBe(200);
    const rows = await H.t.db.select().from(message).where(eq(message.threadId, threadId));
    const stored = JSON.stringify(rows.map((r) => r.body));
    expect(stored).toContain("exp 12/29");
    expect(stored).not.toContain(CARD);
    expect(stored).toContain("[card ending 1111]");
  });

  it("SEC-5: the operator can't repoint a client's browser login at another site through config", async () => {
    const [conn] = await H.t.db
      .insert(connection)
      .values({
        tenantId: H.A.tenantId,
        connector: "browser",
        status: "connected",
        config: {
          site: "supplier",
          siteVersionId: "0190f5e8-8a3c-7d6e-8f00-00000000eeee",
          identity: null,
          stricter: { noWrites: true, personSignIn: true },
        },
      })
      .returning();
    // The client's vault login for "supplier" would then be typed into whatever site the operator
    // names (its login origins are the operator's own), and the client's own tightening is gone.
    const res = await H.call(OPERATOR, "PATCH", `/api/ops/connections/${conn?.id}`, {
      config: { site: "operator-site", siteVersionId: "0190f5e8-8a3c-7d6e-8f00-00000000ffff" },
    });
    const [after] = await H.t.db
      .select()
      .from(connection)
      .where(eq(connection.id, conn?.id ?? ""));
    expect(after?.config).toMatchObject({
      site: "supplier",
      stricter: { noWrites: true, personSignIn: true },
    });
    expect(res.status).toBe(422);
  });
});
