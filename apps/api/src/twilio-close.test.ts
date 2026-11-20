// §1.160: retiring a client gives up its Twilio. The hourly pass releases every number in its
// subaccount and closes the subaccount with Mezonas' main account, records each step as a
// connection change, tries again after a refusal, and never reopens it.

import { generateEncryptionKey } from "@countersign/connectors";
import { FAKE_TWILIO_MAIN, fakeTwilio } from "@countersign/connectors/testing";
import { connection, connectionChange, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiHarness, OPERATOR } from "./api.test-helper";
import { closeRetiredTwilio } from "./messaging/close";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type J = any;

const twilio = fakeTwilio();
const env = {
  ENCRYPTION_KEY: generateEncryptionKey(),
  APP_ORIGIN: "https://app.mezonas.test",
  TWILIO_ACCOUNT_SID: FAKE_TWILIO_MAIN.accountSid,
  TWILIO_AUTH_TOKEN: FAKE_TWILIO_MAIN.authToken,
};
const h = await createApiHarness({ env, fetch: twilio.fetch });
afterAll(() => h?.close());

describe.skipIf(!h)("a retired client's Twilio", () => {
  const H = h as NonNullable<typeof h>;
  const B = () => H.B.tenantId;
  const ops = (path = "") => `/api/ops/clients/${B()}/messaging${path}`;
  let subaccount = "";
  const deps = () => ({ env: H.env, fetch: twilio.fetch });

  async function stored(): Promise<J> {
    return withTenant(H.t.db, B(), async (tx) => {
      const [row] = await tx
        .select()
        .from(connection)
        .where(and(eq(connection.tenantId, B()), eq(connection.connector, "twilio")));
      return row;
    });
  }

  beforeAll(async () => {
    const p = await H.call(OPERATOR, "POST", ops("/twilio"));
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    subaccount = (p.json as J).setup.twilio.subaccountSid;
    for (const phoneNumber of ["+15125550101", "+15125550102"]) {
      const b = await H.call(OPERATOR, "POST", ops("/numbers"), { phoneNumber });
      expect(b.status, JSON.stringify(b.json)).toBe(200);
    }
  });

  it("does nothing for a client that isn't retired", async () => {
    expect(await closeRetiredTwilio(H.t.db, deps(), new Date())).toEqual([]);
    expect([...twilio.numbers.values()].filter((n) => n.account_sid === subaccount)).toHaveLength(
      2,
    );
  });

  it("releases its numbers and closes the subaccount once it is retired", async () => {
    const r = await H.call(OPERATOR, "POST", `/api/ops/clients/${B()}/retire`, {
      confirmName: "Client B",
      reason: "test",
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // Nothing is released inside the retirement itself.
    expect([...twilio.numbers.values()].filter((n) => n.account_sid === subaccount)).toHaveLength(
      2,
    );

    // The first try is refused part way: one number goes, the other waits for the next hour.
    const realFetch = twilio.fetch;
    let deletes = 0;
    const flaky: typeof realFetch = async (url, init) => {
      if (init?.method === "DELETE" && ++deletes === 2) {
        return {
          status: 503,
          ok: false,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify({ code: 20500, message: "try later" }),
        };
      }
      return realFetch(url, init);
    };
    const first = await closeRetiredTwilio(H.t.db, { ...deps(), fetch: flaky }, new Date());
    expect(first).toEqual([{ tenantId: B(), released: 1, closed: false }]);
    let row = await stored();
    expect(row.config.numbers).toHaveLength(1);
    expect(row.config.closeError.message).toBe("Twilio: try later");
    expect(row.config.closedAt).toBeUndefined();

    const now = new Date("2026-11-20T12:07:00Z");
    const second = await closeRetiredTwilio(H.t.db, deps(), now);
    expect(second).toEqual([{ tenantId: B(), released: 1, closed: true }]);
    expect([...twilio.numbers.values()].filter((n) => n.account_sid === subaccount)).toHaveLength(
      0,
    );
    expect(twilio.accounts.get(subaccount)?.status).toBe("closed");
    row = await stored();
    expect(row.config.numbers).toEqual([]);
    expect(row.config.closedAt).toBe(now.toISOString());
    expect(row.config.closeError).toBeUndefined();

    const changes = await withTenant(H.t.db, B(), (tx) =>
      tx.select().from(connectionChange).where(eq(connectionChange.connectionId, row.id)),
    );
    const kinds = changes.map((c) => (c.change as J).kind);
    expect(kinds.filter((k) => k === "number_released")).toHaveLength(2);
    expect(kinds).toContain("subaccount_closed");
    expect(changes.find((c) => (c.change as J).kind === "subaccount_closed")?.actorId).toBeNull();

    // Done once: the next hour leaves it alone.
    expect(await closeRetiredTwilio(H.t.db, deps(), new Date())).toEqual([]);
  });

  it("never reconnects a retired client's subaccount", async () => {
    const p = await H.call(OPERATOR, "POST", ops("/twilio"));
    expect(p.status).toBe(409);
    expect((p.json as J).error?.code ?? (p.json as J).code).toBe("closed");
  });
});
