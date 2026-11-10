// R4 channels (docs/plan.md §1.86; ARCHITECTURE §10.14 "Communications"): every account has a number
// and an email, an agent may have its own, and its own is used first. The resolver without a
// database (bindings, defaults, a binding that is down), then through the API over a throwaway
// database: the portal reads, the operator binds the account's, an agent's own stays the existing
// route's, and which agents listen on a number.

import { agentAddress, type ChannelBindings, INBOUND_MESSAGE_EVENT } from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  contact,
  rawRecord,
  tenant,
  tenantChange,
  withTenant,
} from "@countersign/db";
import type { EventRow } from "@countersign/senses";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR, testBundle, user } from "./api.test-helper";
import {
  agentsListeningOn,
  type ChannelConnection,
  channelFor,
  pickChannel,
  sendingChannels,
} from "./channels/resolve";
import { routeInboundText } from "./triggers/inbound-text";

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

  it("sends an agent's reach-outs on its own channel, else the account's, at that connection's level", () => {
    const automatic = { ...twilio2, permissions: { create: "auto" } };
    const sending = sendingChannels({ sms: "t1" }, { whatsapp: "t22" }, [
      twilio,
      automatic,
      resend,
    ]);
    expect(Object.fromEntries(sending)).toEqual({
      email: { id: "r1", connector: "resend", create: "approval" },
      sms: { id: "t1", connector: "twilio", create: "approval" },
      whatsapp: { id: "t22", connector: "twilio", create: "auto" },
      voice: { id: "t1", connector: "twilio", create: "approval" },
    });
    // An agent with none of its own sends on the account's.
    expect(sendingChannels(null, none, [twilio]).get("sms")).toMatchObject({ id: "t1" });
  });

  it("names an agent's own email address on Mezonas' sending, never on a bound mailbox", () => {
    const emails = { agentEmail: "remy.acme-x@in.test", accountEmail: "acme-y@in.test" };
    expect(pickChannel({ kind: "email", account: none, connections, ...emails })).toMatchObject({
      connectionId: "r1",
      address: "remy.acme-x@in.test",
      source: "agent",
    });
    expect(
      pickChannel({ kind: "email", account: none, connections, accountEmail: emails.accountEmail }),
    ).toMatchObject({ connectionId: "r1", address: "acme-y@in.test", source: "default" });
    expect(
      pickChannel({ kind: "email", account: { email: "g1" }, connections, ...emails }),
    ).toMatchObject({ connectionId: "g1", address: "pat@client.example.com", source: "account" });
    // Texts are untouched by email addresses.
    expect(pickChannel({ kind: "sms", account: none, connections, ...emails })).toMatchObject({
      address: "+15550000001",
    });
  });
});

const DOMAIN = "in.mezonas.test";
const h = await createApiHarness({ env: { EMAIL_FORWARDING_DOMAIN: DOMAIN } });
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
  let dana = "";

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
    const [c] = await H.t.db
      .insert(contact)
      .values({ tenantId: A(), name: "Dana", phone: "+15557770001" })
      .returning();
    dana = c?.id as string;
    // Remy starts on a text from Dana.
    const remyBundle = testBundle("Remy Records");
    const [wf] = remyBundle.workflows;
    if (!wf) throw new Error("no workflow");
    remyBundle.workflows = [
      {
        ...wf,
        workflow: {
          ...wf.workflow,
          trigger: {
            id: "msg",
            on: { type: "message", channels: ["sms"], from: { contactIds: [dana] } },
          },
        },
      },
    ];
    // Remy is live, so it has its own email address (§10.8); Pia isn't yet.
    const [v] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId: A(),
        agentId: remy,
        version: 1,
        bundle: remyBundle,
        bundleHash: "h",
        status: "live",
        authorType: "operator",
      })
      .returning();
    await H.t.db.update(agent).set({ liveVersionId: v?.id }).where(eq(agent.id, remy));
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
    // An agent's email is its own address (§10.8), sent through the account's connection; an
    // agent without one (not live) shows the account's.
    const [t] = await H.t.db.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, A()));
    const remyLines = body.agents.find((a: J) => a.agentId === remy);
    expect(remyLines.channels.find((l: J) => l.kind === "email")).toEqual({
      kind: "email",
      connectionId: mail,
      connector: "resend",
      address: agentAddress({
        commandName: "remy",
        clientName: t?.name ?? "",
        tenantId: A(),
        domain: DOMAIN,
      }),
      source: "agent",
    });
    expect(piaLines.channels.find((l: J) => l.kind === "email")).toMatchObject({
      connectionId: mail,
      address: "office@mail.mezonas.test",
      source: "default",
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
    // The change is recorded with what it was and what it is, as an agent's channels are.
    const changes = await H.t.db.select().from(tenantChange).where(eq(tenantChange.tenantId, A()));
    expect(changes.map((c) => c.change)).toEqual([
      { setting: "channels", from: {}, to: { sms: second } },
    ]);
    expect(changes[0]?.actorId).toBe(H.operator);

    for (const channels of [{ sms: otherClients }, { sms: mail }, { email: H.A.connectionId }]) {
      const bad = await call(OPERATOR, "PUT", `/api/ops/clients/${A()}/channels`, { channels });
      expect(bad.status, JSON.stringify(channels)).toBe(422);
    }
    // A refused change records nothing.
    expect(
      await H.t.db.select().from(tenantChange).where(eq(tenantChange.tenantId, A())),
    ).toHaveLength(1);
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

  it("a text to the account's number starts the agents listening on it, not those with their own", async () => {
    await call(OPERATOR, "PUT", `/api/ops/clients/${A()}/channels`, { channels: { sms: main } });
    const [who] = await H.t.db.select().from(contact).where(eq(contact.id, dana));
    const textOn = async (connectionId: string, sid: string) => {
      const collect: EventRow[] = [];
      await withTenant(H.db, A(), async (tx) => {
        const [raw] = await tx
          .insert(rawRecord)
          .values({
            tenantId: A(),
            connectionId,
            connector: "twilio",
            entityType: "Message",
            externalId: sid,
            externalVersion: null,
            payload: {},
          })
          .returning();
        await routeInboundText(tx, {
          tenantId: A(),
          connectionId,
          channel: "sms",
          sid,
          contact: who as NonNullable<typeof who>,
          knownContact: true,
          rawRecordId: raw?.id as string,
          from: "+15557770001",
          to: "+15550000101",
          now: new Date(),
          registry: H.platform.events,
          collect,
        });
      });
      return collect.filter((e) => e.type === INBOUND_MESSAGE_EVENT).map((e) => e.payload);
    };
    // Remy has no number of its own: it listens on the account's.
    expect(await textOn(main, "SM-main")).toEqual([
      expect.objectContaining({ agentId: remy, channel: "sms", contactId: dana }),
    ]);
    // Pia's own number isn't the account's: Remy doesn't hear what comes in there.
    expect(await textOn(second, "SM-second")).toEqual([]);
  });
});
