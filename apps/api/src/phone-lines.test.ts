// Agent phone lines (docs/plan.md §1.160, owner 2026-11-20): a number in the client's Twilio
// subaccount can be one agent's own line. Only the operator makes it so (the client asks); the
// agent then shows, sends from and listens on that number alone, the account keeps its own, Sloan
// never answers on an agent's line, and each active day is billed at the line price.

import { generateEncryptionKey } from "@countersign/connectors";
import { FAKE_TWILIO_MAIN, fakeTwilio } from "@countersign/connectors/testing";
import { agent, billingPhoneLineDay, connection, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAccountTextLine } from "./account/reach";
import { admin, createApiHarness, OPERATOR, user } from "./api.test-helper";
import { loadBillingConfig, monthFor, recordLineDays } from "./billing/ledger";
import { agentsListeningOn, type ChannelConnection, pickChannel } from "./channels/resolve";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type J = any;

const SID = `AC${"0".repeat(32)}`;

function twilioConn(numbers: { phone: string; agentId?: string }[]): ChannelConnection {
  return {
    id: "t1",
    connector: "twilio",
    status: "connected",
    config: {
      subaccountSid: SID,
      numbers: numbers.map((n, i) => ({
        sid: `PN${i}`,
        phoneNumber: n.phone,
        friendlyName: null,
        capabilities: { sms: true, mms: false, voice: true },
        whatsapp: false,
        purchasedAt: "2026-11-01T00:00:00.000Z",
        ...(n.agentId ? { agentId: n.agentId } : {}),
      })),
      webhooks: { messages: "https://x.test/m", status: "https://x.test/s" },
      provisionedAt: "2026-11-01T00:00:00.000Z",
    },
    externalAccountId: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
  };
}

describe("an agent's own line, resolved (no database)", () => {
  const ORDERS = "11111111-1111-4111-8111-111111111111";
  // The agent's line is bought first: the account still gets the number nobody owns.
  const conns = [
    twilioConn([{ phone: "+15550000002", agentId: ORDERS }, { phone: "+15550000001" }]),
  ];

  it("gives the agent its own number, and the account and other agents the account's", () => {
    expect(
      pickChannel({ kind: "sms", agentId: ORDERS, account: {}, connections: conns }),
    ).toMatchObject({ address: "+15550000002", source: "agent" });
    expect(
      pickChannel({ kind: "voice", agentId: ORDERS, account: {}, connections: conns }),
    ).toMatchObject({ address: "+15550000002", source: "agent" });
    expect(pickChannel({ kind: "sms", account: {}, connections: conns })).toMatchObject({
      address: "+15550000001",
      source: "default",
    });
    expect(
      pickChannel({
        kind: "sms",
        agentId: "22222222-2222-4222-8222-222222222222",
        account: {},
        connections: conns,
      }),
    ).toMatchObject({ address: "+15550000001", source: "default" });
  });

  it("names the agent's own number when it is bound to the account's connection", () => {
    expect(
      pickChannel({
        kind: "sms",
        agent: { sms: "t1" },
        agentId: ORDERS,
        account: {},
        connections: conns,
      }),
    ).toMatchObject({ address: "+15550000002", source: "agent" });
  });
});

const ENCRYPTION_KEY = generateEncryptionKey();
const twilio = fakeTwilio();
const h = await createApiHarness({
  env: {
    ENCRYPTION_KEY,
    APP_ORIGIN: "https://app.mezonas.test",
    TWILIO_ACCOUNT_SID: FAKE_TWILIO_MAIN.accountSid,
    TWILIO_AUTH_TOKEN: FAKE_TWILIO_MAIN.authToken,
  },
  fetch: twilio.fetch,
});
afterAll(() => h?.close());

describe.skipIf(!h)("agent phone lines through the API", () => {
  const H = h as NonNullable<typeof h>;
  const A = () => H.A.tenantId;
  const ops = (path = "") => `/api/ops/clients/${A()}/messaging${path}`;
  let orders = "";
  let invoices = "";
  let accountSid = "";
  let lineSid = "";
  let connectionId = "";
  const ACCOUNT = "+15125550101";
  const LINE = "+15125550102";

  async function addAgent(slug: string) {
    const [a] = await H.t.db
      .insert(agent)
      .values({
        tenantId: A(),
        kind: "client",
        slug,
        name: `${slug} agent`,
        serviceName: `${slug} service`,
        status: "active",
        runStatus: "active",
      })
      .returning();
    if (!a) throw new Error("no agent");
    return a.id;
  }

  beforeAll(async () => {
    orders = await addAgent("orders");
    invoices = await addAgent("invoices");
    expect((await H.call(OPERATOR, "POST", ops("/twilio"))).status).toBe(200);
    const a = await H.call(OPERATOR, "POST", ops("/numbers"), { phoneNumber: ACCOUNT });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    const b = await H.call(OPERATOR, "POST", ops("/numbers"), { phoneNumber: LINE });
    const numbers = (b.json as J).setup.twilio.numbers;
    accountSid = numbers.find((n: J) => n.phoneNumber === ACCOUNT).sid;
    lineSid = numbers.find((n: J) => n.phoneNumber === LINE).sid;
    connectionId = (b.json as J).setup.twilio.connectionId;
  });

  it("lets only the operator make a number an agent's own line", async () => {
    for (const who of [admin("a"), user("a")]) {
      const res = await H.call(who, "PUT", ops(`/numbers/${lineSid}/agent`), { agentId: orders });
      expect(res.status).toBe(403);
    }
    const setup = await H.call(OPERATOR, "GET", ops());
    expect((setup.json as J).setup.agents.map((x: J) => x.name).sort()).toEqual([
      "invoices service",
      "orders service",
    ]);
    expect((setup.json as J).setup.phoneLinePrice).toBe("10.0000");

    const set = await H.call(OPERATOR, "PUT", ops(`/numbers/${lineSid}/agent`), {
      agentId: orders,
    });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    const line = (set.json as J).setup.twilio.numbers.find((n: J) => n.sid === lineSid);
    expect(line.agentId).toBe(orders);
  });

  it("keeps a number for the account and one line per agent", async () => {
    // The account's last number can't become an agent's.
    const last = await H.call(OPERATOR, "PUT", ops(`/numbers/${accountSid}/agent`), {
      agentId: invoices,
    });
    expect(last.status).toBe(409);
    expect((last.json as J).error.code).toBe("account_needs_number");
    // An agent that isn't one of this client's (another client's, or none at all) is refused.
    const stranger = await H.call(OPERATOR, "PUT", ops(`/numbers/${lineSid}/agent`), {
      agentId: crypto.randomUUID(),
    });
    expect(stranger.status).toBe(404);
    const same = await H.call(OPERATOR, "PUT", ops(`/numbers/${lineSid}/agent`), {
      agentId: orders,
    });
    expect(same.status).toBe(409);
  });

  it("shows the agent's own number in the portal, with the line price", async () => {
    const res = await H.call(user("a"), "GET", "/api/settings/channels");
    expect(res.status).toBe(200);
    const body = res.json as J;
    expect(body.phoneLinePrice).toEqual({ amount: "10.0000", currency: "USD" });
    expect(body.account.find((l: J) => l.kind === "sms")).toMatchObject({
      address: ACCOUNT,
      source: "default",
    });
    const own = body.agents.find((x: J) => x.agentId === orders);
    expect(own.channels.find((l: J) => l.kind === "sms")).toMatchObject({
      address: LINE,
      source: "agent",
    });
    const shared = body.agents.find((x: J) => x.agentId === invoices);
    expect(shared.channels.find((l: J) => l.kind === "sms")).toMatchObject({
      address: ACCOUNT,
      source: "default",
    });
  });

  it("routes a text to the agent's line to that agent alone, and never to Sloan", async () => {
    await withTenant(H.t.db, A(), async (tx) => {
      expect(await agentsListeningOn(tx, A(), "sms", connectionId, LINE)).toEqual([orders]);
      const onAccount = await agentsListeningOn(tx, A(), "sms", connectionId, ACCOUNT);
      expect(onAccount).toContain(invoices);
      expect(onAccount).not.toContain(orders);
      expect(await isAccountTextLine(tx, A(), connectionId, LINE)).toBe(false);
      expect(await isAccountTextLine(tx, A(), connectionId, ACCOUNT)).toBe(true);
    });
  });

  it("bills each day the agent is active at the line price, once a day", async () => {
    await withTenant(H.t.db, A(), async (tx) => {
      expect(await recordLineDays(tx, { tenantId: A(), day: "2026-11-01", price: "10.0000" })).toBe(
        1,
      );
      // The first price seen in a day sticks.
      expect(await recordLineDays(tx, { tenantId: A(), day: "2026-11-01", price: "12.0000" })).toBe(
        0,
      );
    });
    // A paused agent's line costs nothing that day.
    await H.t.db.update(agent).set({ runStatus: "paused" }).where(eq(agent.id, orders));
    await withTenant(H.t.db, A(), async (tx) => {
      expect(await recordLineDays(tx, { tenantId: A(), day: "2026-11-02", price: "10.0000" })).toBe(
        0,
      );
    });
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, orders));
    const rows = await H.t.db
      .select()
      .from(billingPhoneLineDay)
      .where(and(eq(billingPhoneLineDay.tenantId, A()), eq(billingPhoneLineDay.agentId, orders)));
    expect(rows.map((r) => [r.day, r.phoneNumber, r.monthlyPrice, r.agentName])).toEqual([
      ["2026-11-01", LINE, "10.0000", "orders service"],
    ]);
    const month = await withTenant(H.t.db, A(), async (tx) =>
      monthFor(tx, {
        tenantId: A(),
        period: "2026-11-01",
        through: "2026-11-30",
        config: await loadBillingConfig(tx),
        billing: null,
      }),
    );
    // One day of 30 at $10: $0.33.
    expect(month.built.lines.find((l) => l.kind === "phone_line")).toMatchObject({
      agentId: orders,
      description: "Phone line +1 512-555-0102 (orders service)",
      amount: "0.3300",
    });
  });

  it("gives the number back to the account", async () => {
    const back = await H.call(OPERATOR, "PUT", ops(`/numbers/${lineSid}/agent`), {
      agentId: null,
    });
    expect(back.status).toBe(200);
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, connectionId));
    const numbers = (row?.config as J | undefined)?.numbers ?? [];
    expect(numbers.every((n: J) => !n.agentId)).toBe(true);
  });
});
