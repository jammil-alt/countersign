// R4 channels (docs/plan.md §1.86; ARCHITECTURE §10.14 "Communications"): every account has a number
// and an email, an agent may have its own, and its own is used first. The resolver without a
// database (bindings, defaults, a binding that is down), then through the API over a throwaway
// database: the portal reads, the operator binds the account's, an agent's own stays the existing
// route's, and which agents listen on a number.

import type { ChannelBindings } from "@countersign/core";
import { agent, connection, withTenant } from "@countersign/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR, user } from "./api.test-helper";
import {
  agentsListeningOn,
  type ChannelConnection,
  channelFor,
  pickChannel,
} from "./channels/resolve";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type J = any;

const SID = `AC${"0".repeat(32)}`;

function twilioConfig(numbers: { phone: string; sms?: boolean; whatsapp?: boolean }[]) {
  return {
    subaccountSid: SID,
    numbers: numbers.map((n, i) => ({
      sid: `PN${i}`,
      phoneNumber: n.phone,
      friendlyName: null,
      capabilities: { sms: n.sms ?? true, mms: false, voice: true },
      whatsapp: n.whatsapp ?? false,
      purchasedAt: "2026-11-01T00:00:00.000Z",
    })),
    webhooks: { messages: "https://x.test/m", status: "https://x.test/s" },
    provisionedAt: "2026-11-01T00:00:00.000Z",
  };
}

const RESEND = { sendingDomain: "mail.mezonas.test", localPart: "office" };

function conn(
  id: string,
  connector: string,
  config: unknown,
  extra: Partial<ChannelConnection> = {},
): ChannelConnection {
  return {
    id,
    connector,
    status: "connected",
    config,
    externalAccountId: null,
    createdAt: new Date(`2026-11-0${id.length % 9 || 1}T00:00:00Z`),
    ...extra,
  };
}

describe("pickChannel (no database)", () => {
  const twilio = conn("t1", "twilio", twilioConfig([{ phone: "+15550000001" }]));
  const twilio2 = conn("t22", "twilio", twilioConfig([{ phone: "+15550000002", whatsapp: true }]));
  const resend = conn("r1", "resend", RESEND);
  const gmail = conn("g1", "gmail", {}, { externalAccountId: "pat@client.example.com" });
  const connections = [twilio, twilio2, resend, gmail];
  const none: ChannelBindings = {};

  it("gives the account its default number and email when nothing is bound", () => {
    expect(pickChannel({ kind: "sms", account: none, connections })).toEqual({
      kind: "sms",
      connectionId: "t1",
      connector: "twilio",
      address: "+15550000001",
      source: "default",
    });
    expect(pickChannel({ kind: "email", account: none, connections })).toMatchObject({
      connectionId: "r1",
      address: "office@mail.mezonas.test",
      source: "default",
    });
    // The first Twilio connection has no WhatsApp sender: the one that has carries WhatsApp.
    expect(pickChannel({ kind: "whatsapp", account: none, connections })).toMatchObject({
      connectionId: "t22",
      address: "+15550000002",
    });
  });

  it("uses the account's binding, and the agent's own before it", () => {
    const account: ChannelBindings = { sms: "t22", email: "g1" };
    expect(pickChannel({ kind: "sms", account, connections })).toMatchObject({
      connectionId: "t22",
      source: "account",
    });
    expect(pickChannel({ kind: "email", account, connections })).toMatchObject({
      address: "pat@client.example.com",
      source: "account",
    });
    expect(pickChannel({ kind: "sms", agent: { sms: "t1" }, account, connections })).toMatchObject({
      connectionId: "t1",
      source: "agent",
    });
    // An agent without its own for a kind takes the account's.
    expect(
      pickChannel({ kind: "email", agent: { sms: "t1" }, account, connections }),
    ).toMatchObject({ connectionId: "g1", source: "account" });
  });

  it("never falls through from a binding that is down, and gives nothing when nothing carries it", () => {
    const down = [{ ...twilio, status: "disconnected" }, twilio2, resend];
    expect(
      pickChannel({ kind: "sms", agent: { sms: "t1" }, account: none, connections: down }),
    ).toBeNull();
    expect(pickChannel({ kind: "sms", account: { sms: "gone" }, connections })).toBeNull();
    // A Gmail mailbox is never the account's email by default.
    expect(pickChannel({ kind: "email", account: none, connections: [gmail] })).toBeNull();
  });
});

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("channels through the API", () => {
  const H = h as NonNullable<typeof h>;
  const call = H.call.bind(H);
  const A = () => H.A.tenantId;
  let main = "";
  let second = "";
  let mail = "";
  let otherClients = "";
  let pia = "";
  let remy = "";

  async function addConnection(tenantId: string, connector: string, config: object) {
    const [row] = await H.t.db
      .insert(connection)
      .values({
        tenantId,
        connector,
        status: "connected",
        config: config as Record<string, unknown>,
      })
      .returning();
    if (!row) throw new Error("no connection");
    return row.id;
  }

  async function addAgent(slug: string, channels: Record<string, string>) {
    const [a] = await H.t.db
      .insert(agent)
      .values({
        tenantId: A(),
        kind: "client",
        slug,
        name: `${slug} agent`,
        serviceName: `${slug} service`,
        channels,
        runStatus: "active",
      })
      .returning();
    if (!a) throw new Error("no agent");
    return a.id;
  }

  beforeAll(async () => {
    main = await addConnection(A(), "twilio", twilioConfig([{ phone: "+15550000101" }]));
    mail = await addConnection(A(), "resend", RESEND);
    second = await addConnection(A(), "twilio", twilioConfig([{ phone: "+15550000102" }]));
    otherClients = await addConnection(
      H.B.tenantId,
      "twilio",
      twilioConfig([{ phone: "+15550000201" }]),
    );
    pia = await addAgent("pia", { sms: second });
    remy = await addAgent("remy", {});
  });

  it("the portal reads the account's number and email and each service's", async () => {
    const res = await call(user("a"), "GET", "/api/settings/channels");
    expect(res.status).toBe(200);
    const body = res.json as J;
    expect(body.account.map((l: J) => [l.kind, l.address, l.source])).toEqual([
      ["email", "office@mail.mezonas.test", "default"],
      ["sms", "+15550000101", "default"],
      ["voice", "+15550000101", "default"],
    ]);
    const piaLines = body.agents.find((a: J) => a.agentId === pia);
    expect(piaLines.name).toBe("pia service");
    expect(piaLines.channels.find((l: J) => l.kind === "sms")).toMatchObject({
      address: "+15550000102",
      source: "agent",
    });
    // Client B sees none of client A's.
    const b = await call(admin("b"), "GET", "/api/settings/channels");
    expect((b.json as J).account.map((l: J) => l.address)).toEqual([
      "+15550000201",
      "+15550000201",
    ]);
  });

  it("the operator binds the account's channels; a bad binding is refused", async () => {
    const set = await call(OPERATOR, "PUT", `/api/ops/clients/${A()}/channels`, {
      channels: { sms: second },
    });
    expect(set.status).toBe(200);
    const body = set.json as J;
    expect(body.bindings).toEqual({ sms: second });
    expect(body.account.find((l: J) => l.kind === "sms")).toMatchObject({
      connectionId: second,
      source: "account",
    });
    expect(body.options.map((o: J) => o.connectionId).sort()).toEqual([main, mail, second].sort());

    for (const channels of [{ sms: otherClients }, { sms: mail }, { email: H.A.connectionId }]) {
      const bad = await call(OPERATOR, "PUT", `/api/ops/clients/${A()}/channels`, { channels });
      expect(bad.status, JSON.stringify(channels)).toBe(422);
    }
    expect(
      (await call(admin("a"), "PUT", `/api/ops/clients/${A()}/channels`, { channels: {} })).status,
    ).toBe(403);
    expect((await call(OPERATOR, "GET", `/api/ops/clients/${H.C.tenantId}/channels`)).status).toBe(
      404,
    );
  });

  it("channelFor and the listeners: an agent's own first, else the account's", async () => {
    await call(OPERATOR, "PUT", `/api/ops/clients/${A()}/channels`, {
      channels: { sms: main },
    });
    const [piaSms, remySms, accountSms, remyEmail] = await withTenant(H.db, A(), async (tx) => [
      await channelFor(tx, A(), pia, "sms"),
      await channelFor(tx, A(), remy, "sms"),
      await channelFor(tx, A(), null, "sms"),
      await channelFor(tx, A(), remy, "email"),
    ]);
    expect(piaSms).toMatchObject({ connectionId: second, source: "agent" });
    expect(remySms).toMatchObject({ connectionId: main, source: "account" });
    expect(accountSms).toMatchObject({ connectionId: main, source: "account" });
    expect(remyEmail).toMatchObject({ connectionId: mail, source: "default" });

    const [onMain, onSecond] = await withTenant(H.db, A(), async (tx) => [
      await agentsListeningOn(tx, A(), "sms", main),
      await agentsListeningOn(tx, A(), "sms", second),
    ]);
    expect(onMain).toEqual([remy]);
    expect(onSecond).toEqual([pia]);
  });
});
