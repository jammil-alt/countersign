// Security and isolation through the API harness (cs_worker, so RLS applies): a card number posted
// in a thread is not stored (invariant 14), and the operator can't repoint a client's browser
// login at another site, or drop the client's own tightening, through a connection's config
// (invariants 8 and 13). From the platform QA audit (PLATFORM_QA SEC-3, SEC-5).
import { connection, message } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { admin, createApiHarness, OPERATOR } from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

const CARD = "4111 1111 1111 1111";

describe.skipIf(!h)("security: thread text and connection config", () => {
  const H = h as NonNullable<typeof h>;

  it("(PLATFORM_QA SEC-3) a card number posted in the portal chat is stored as its last four only", async () => {
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

  async function browserConnection() {
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
    return conn?.id as string;
  }

  const configOf = async (id: string) =>
    (await H.t.db.select().from(connection).where(eq(connection.id, id)))[0]?.config;

  it("(PLATFORM_QA SEC-5) the operator can't repoint a client's browser login at another site through config (422)", async () => {
    const id = await browserConnection();
    // The client's vault login for "supplier" would then be typed into whatever site the operator
    // names, and the client's own tightening would be gone.
    const res = await H.call(OPERATOR, "PATCH", `/api/ops/connections/${id}`, {
      config: { site: "operator-site", siteVersionId: "0190f5e8-8a3c-7d6e-8f00-00000000ffff" },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(422);
    expect(await configOf(id)).toMatchObject({
      site: "supplier",
      stricter: { noWrites: true, personSignIn: true },
    });
    // Undoing the client's tightening is refused too.
    const loosen = await H.call(OPERATOR, "PATCH", `/api/ops/connections/${id}`, {
      config: {
        site: "supplier",
        siteVersionId: "0190f5e8-8a3c-7d6e-8f00-00000000eeee",
        identity: null,
        stricter: { noWrites: false, personSignIn: false },
      },
    });
    expect(loosen.status, JSON.stringify(loosen.json)).toBe(422);
    expect(await configOf(id)).toMatchObject({ stricter: { noWrites: true, personSignIn: true } });
  });

  it("(PLATFORM_QA SEC-5) other config on a browser connection still changes, keeping the login's fields", async () => {
    const id = await browserConnection();
    const res = await H.call(OPERATOR, "PATCH", `/api/ops/connections/${id}`, {
      config: { caps: { signInsPerDay: 4, hours: null } },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await configOf(id)).toMatchObject({
      site: "supplier",
      siteVersionId: "0190f5e8-8a3c-7d6e-8f00-00000000eeee",
      identity: null,
      stricter: { noWrites: true, personSignIn: true },
      caps: { signInsPerDay: 4, hours: null },
    });
    // The whole must still be a website login's configuration.
    const bad = await H.call(OPERATOR, "PATCH", `/api/ops/connections/${id}`, {
      config: { caps: { signInsPerDay: 5000 } },
    });
    expect(bad.status, JSON.stringify(bad.json)).toBe(422);
  });
});
