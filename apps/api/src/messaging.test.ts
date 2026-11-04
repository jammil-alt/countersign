// Texts and WhatsApp through the API, against a fake Twilio (no live call): only the operator makes
// a client's subaccount and buys or releases its numbers; contacts and consent from both sides;
// Twilio's signed webhooks stored once, STOP and START acted on at once, `message.received`
// starting a workflow that reads the message and texts back once after approval; consent, opt-out
// and quiet hours stopping a send in code; usage counted; nothing crosses clients. An automatic text
// retried after a crash resumes; one Twilio took but we never recorded is found, not sent again.

import {
  createTwilioConnector,
  type FetchLike,
  formEncode,
  generateEncryptionKey,
  MESSAGE_GET_TOOL,
  SMS_SEND_TOOL,
} from "@countersign/connectors";
import { FAKE_TWILIO_MAIN, fakeTwilio } from "@countersign/connectors/testing";
import { AgentBundle, type AgentBundleInput, TWIML_EMPTY } from "@countersign/core";
import {
  agent,
  connection,
  contact,
  contactChange,
  event,
  externalAction,
  inboxItem,
  message,
  rawRecord,
  run,
  tenant,
  usageDaily,
} from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  OTHER_OPERATOR,
  user,
} from "./api.test-helper";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://app.mezonas.test";
const twilio = fakeTwilio();
const PAT = "+15555550100";
const SAM = "+15555550111";

/** What the connector's sends reach: the fake Twilio, unless a test stands in front of it. */
let connectorFetch: FetchLike = twilio.fetch;
const h = await createApiHarness({
  connectors: () => [createTwilioConnector({ fetch: (url, init) => connectorFetch(url, init) })],
  env: {
    ENCRYPTION_KEY,
    APP_ORIGIN: ORIGIN,
    TWILIO_ACCOUNT_SID: FAKE_TWILIO_MAIN.accountSid,
    TWILIO_AUTH_TOKEN: FAKE_TWILIO_MAIN.authToken,
  },
  fetch: twilio.fetch,
});
afterAll(() => h?.close());

function bundle(workflow: unknown, mode: "suggest_only" | "act" = "suggest_only"): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Front desk", role: "answers texts", mission: "reply to customers" },
      kind: "functional",
      model: { id: "test-model", maxTokens: 1024 },
      instructions: "Only do what the workflow says.",
      skills: [{ skill: MESSAGE_GET_TOOL, settings: {} }],
      extraTools: [SMS_SEND_TOOL],
      canCommand: [],
      permissions: { mode },
      budgets: { maxSteps: 4, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [{ slug: "main", name: "Main", workflow }],
  } as AgentBundleInput);
}

/** Texts the number it is given, without approval (the connection allows `create` on auto). */
const NOTIFY_WORKFLOW = {
  schemaVersion: 3,
  trigger: {
    id: "trg-manual",
    on: {
      type: "manual",
      input: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
    },
  },
  steps: [
    {
      id: "notify",
      name: "Text the customer",
      kind: "action",
      tool: SMS_SEND_TOOL,
      input: { to: "{{trigger.to}}", text: "Your order has shipped." },
      approval: { required: "not_required" },
      client: { visible: true, label: "Texted the customer" },
    },
  ],
};

const REPLY_WORKFLOW = {
  schemaVersion: 3,
  trigger: {
    id: "trg-text",
    on: {
      type: "event",
      event: "message.received",
      filter: { match: "all", rules: [{ field: "{{trigger.keyword}}", op: "is", value: null }] },
    },
  },
  steps: [
    {
      id: "read",
      name: "Read the text",
      kind: "skill",
      skill: MESSAGE_GET_TOOL,
      input: { sid: "{{trigger.messageSid}}" },
      client: { visible: true, label: "Read the text" },
    },
    {
      id: "reply",
      name: "Text back",
      kind: "action",
      tool: SMS_SEND_TOOL,
      input: { to: "{{trigger.from}}", text: "Thanks, we got your message." },
      approval: { required: "required" },
      client: { visible: true, label: "Texted back" },
    },
  ],
};

describe.skipIf(!h)("texts and WhatsApp through the API", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const ops = (path = "") => `/api/ops/clients/${A()}/messaging${path}`;
  let setup: ReturnType<typeof j> = null;
  let number = "";

  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
    credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
  });

  function approver(c: "a" | "b") {
    return new FakeWorkflowStep(async (_name, type) => {
      const res = await H.call(admin(c), "GET", "/api/inbox");
      const item = j(res.json).items.find(
        (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no open item for ${type}`);
      const done = await H.call(admin(c), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });
  }

  /** POSTs a form as Twilio would, with its signature. */
  function twilioPost(path: string, params: Record<string, string>, signature: string) {
    return H.call(null, "POST", path, formEncode(params), {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    });
  }

  async function textIn(from: string, body: string, opts: { sid?: string } = {}) {
    const msg = await twilio.inbound({
      account: setup.twilio.subaccountSid,
      from,
      to: number,
      body,
      url: setup.webhooks.messages,
      ...opts,
    });
    const res = await twilioPost(
      setup.webhooks.messages.replace(ORIGIN, ""),
      msg.params,
      msg.signature,
    );
    return { ...msg, res };
  }

  beforeAll(async () => {
    // Quiet hours off the clock for most tests: 03:00–03:01 UTC (the client is on UTC).
    const q = await H.call(OPERATOR, "PUT", ops(), {
      quietHours: { start: "03:00", end: "03:01" },
    });
    expect(q.status, JSON.stringify(q.json)).toBe(200);
  });

  it("lets only the operator make the subaccount and buy, flag and release numbers", async () => {
    for (const who of [admin("a"), user("a")]) {
      expect((await H.call(who, "POST", ops("/twilio"))).status).toBe(403);
      expect((await H.call(who, "GET", ops("/numbers/available"))).status).toBe(403);
      expect(
        (await H.call(who, "POST", ops("/numbers"), { phoneNumber: "+15125550101" })).status,
      ).toBe(403);
    }
    // An operator who doesn't serve the client can't see or touch it.
    expect((await H.call(OTHER_OPERATOR, "POST", ops("/twilio"))).status).toBe(404);
    // Before a subaccount exists there is nothing to buy with.
    expect((await H.call(OPERATOR, "GET", ops("/numbers/available"))).status).toBe(409);

    const made = await H.call(OPERATOR, "POST", ops("/twilio"));
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    setup = j(made.json).setup;
    expect(setup.twilio.subaccountSid).toMatch(/^AC/);
    expect(setup.webhooks.messages).toBe(`${ORIGIN}/api/twilio/${A()}/messages`);
    // The subaccount's auth token is stored encrypted and never answered.
    const token = twilio.accounts.get(setup.twilio.subaccountSid)?.token ?? "";
    expect(JSON.stringify(made.json)).not.toContain(token);
    const conns = await H.call(admin("a"), "GET", "/api/connections");
    expect(JSON.stringify(conns.json)).not.toContain(token);
    expect((await H.call(OPERATOR, "POST", ops("/twilio"))).status).toBe(409);

    const avail = await H.call(OPERATOR, "GET", `${ops("/numbers/available")}?areaCode=512`);
    expect(avail.status, JSON.stringify(avail.json)).toBe(200);
    expect(j(avail.json).items.map((n: { phoneNumber: string }) => n.phoneNumber)).toContain(
      "+15125550101",
    );
    const bought = await H.call(OPERATOR, "POST", ops("/numbers"), { phoneNumber: "+15125550101" });
    expect(bought.status, JSON.stringify(bought.json)).toBe(200);
    setup = j(bought.json).setup;
    number = setup.twilio.numbers[0].phoneNumber;
    const pn = setup.twilio.numbers[0].sid;
    // Bought in the client's own subaccount, its texts pointed at our webhook.
    expect(twilio.numbers.get(pn)).toMatchObject({
      account_sid: setup.twilio.subaccountSid,
      sms_url: setup.webhooks.messages,
    });

    const extra = await H.call(OPERATOR, "POST", ops("/numbers"), { phoneNumber: "+15125550102" });
    const extraSid = j(extra.json).setup.twilio.numbers[1].sid;
    const released = await H.call(OPERATOR, "DELETE", ops(`/numbers/${extraSid}`));
    expect(released.status, JSON.stringify(released.json)).toBe(200);
    expect(j(released.json).setup.twilio.numbers).toHaveLength(1);
    expect(twilio.numbers.has(extraSid)).toBe(false);

    const wa = await H.call(OPERATOR, "PUT", ops(`/numbers/${pn}/whatsapp`), { enabled: true });
    expect(j(wa.json).setup.twilio.numbers[0].whatsapp).toBe(true);
  });

  it("tracks A2P 10DLC: US texts wait until the brand is approved and the campaign verified", async () => {
    const brandSid = `BN${"1".repeat(32)}`;
    const serviceSid = `MG${"2".repeat(32)}`;
    const set = await H.call(OPERATOR, "PUT", ops("/a2p"), {
      brandSid,
      messagingServiceSid: serviceSid,
    });
    expect(j(set.json).setup.twilio.a2p.status).toBe("pending");
    twilio.setBrand(brandSid, "APPROVED");
    twilio.setCampaign(serviceSid, "IN_PROGRESS");
    let r = await H.call(OPERATOR, "POST", ops("/a2p/refresh"));
    expect(j(r.json).setup.twilio.a2p).toMatchObject({
      status: "pending",
      brandStatus: "APPROVED",
    });
    twilio.setCampaign(serviceSid, "VERIFIED");
    r = await H.call(OPERATOR, "POST", ops("/a2p/refresh"));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(j(r.json).setup.twilio.a2p.status).toBe("approved");
    expect((await H.call(admin("a"), "POST", ops("/a2p/refresh"))).status).toBe(403);
  });

  it("keeps contacts per client: the client admin and the operator edit them, others can't", async () => {
    const made = await H.call(admin("a"), "POST", "/api/contacts", {
      name: "Pat Lee",
      phone: "+1 (555) 555-0100",
      consent: { channels: ["sms"], source: "signed the service agreement" },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    expect(j(made.json).contact).toMatchObject({
      phone: PAT,
      canMessage: { sms: true, whatsapp: false },
      consent: { sms: { source: "signed the service agreement" } },
    });
    expect(
      (await H.call(admin("a"), "POST", "/api/contacts", { name: "x", phone: "555-0100" })).status,
    ).toBe(422);
    expect(
      (await H.call(admin("a"), "POST", "/api/contacts", { name: "Dup", phone: PAT })).status,
    ).toBe(409);
    expect((await H.call(user("a"), "GET", "/api/contacts")).status).toBe(403);
    expect(j((await H.call(admin("b"), "GET", "/api/contacts")).json).items).toHaveLength(0);
    const seen = await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/contacts`);
    expect(j(seen.json).items.map((c: { name: string }) => c.name)).toEqual(["Pat Lee"]);
    expect((await H.call(OTHER_OPERATOR, "GET", `/api/ops/clients/${A()}/contacts`)).status).toBe(
      404,
    );

    const id = j(made.json).contact.id;
    // Another client's admin can't reach it by id.
    expect(
      (await H.call(admin("b"), "PATCH", `/api/contacts/${id}`, { name: "Mine" })).status,
    ).toBe(404);
    // A person's opt-out can be lifted by a person; consent can't be given while opted out.
    const out = await H.call(admin("a"), "POST", `/api/contacts/${id}/consent`, {
      action: "opt_out",
    });
    expect(j(out.json).contact).toMatchObject({
      optedOut: { source: "client" },
      canMessage: { sms: false },
    });
    const grant = await H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/contacts/${id}/consent`, {
      action: "grant",
      channel: "sms",
      source: "phone call",
    });
    expect(grant.status).toBe(409);
    const lifted = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${A()}/contacts/${id}/consent`,
      {
        action: "lift_opt_out",
      },
    );
    expect(j(lifted.json).contact.canMessage.sms).toBe(true);
    // A new number needs consent again.
    const moved = await H.call(admin("a"), "PATCH", `/api/contacts/${id}`, { whatsapp: PAT });
    expect(j(moved.json).contact.canMessage).toEqual({ sms: true, whatsapp: false });
    const log = await H.t.db.select().from(contactChange).where(eq(contactChange.contactId, id));
    expect(log.map((l) => (l.change as { kind: string }).kind)).toEqual([
      "created",
      "opt_out",
      "lift_opt_out",
      "edited",
    ]);
  });

  it("checks Twilio's signature, stores a message once, and refuses other clients' paths", async () => {
    const msg = await twilio.inbound({
      account: setup.twilio.subaccountSid,
      from: SAM,
      to: number,
      body: "Is my order ready?",
      url: setup.webhooks.messages,
    });
    const path = setup.webhooks.messages.replace(ORIGIN, "");
    expect((await twilioPost(path, msg.params, "bm90IGl0")).status).toBe(403);
    expect((await twilioPost(path, { ...msg.params, Body: "changed" }, msg.signature)).status).toBe(
      403,
    );
    // Client B's path with A's (correctly signed) message: B has no such subaccount.
    expect(
      (await twilioPost(`/api/twilio/${H.B.tenantId}/messages`, msg.params, msg.signature)).status,
    ).toBe(403);
    const good = await twilioPost(path, msg.params, msg.signature);
    expect(good.status, JSON.stringify(good.json)).toBe(200);
    expect(good.json).toBe(TWIML_EMPTY);
    // A replay of the same signed request: acknowledged, nothing stored or started again.
    const before = H.instances.started.size;
    expect((await twilioPost(path, msg.params, msg.signature)).status).toBe(200);
    await H.settle();
    expect(H.instances.started.size).toBe(before);
    const raws = await H.t.db
      .select()
      .from(rawRecord)
      .where(and(eq(rawRecord.tenantId, A()), eq(rawRecord.externalId, msg.sid)));
    expect(raws).toHaveLength(1);
    // Someone new becomes a contact, without consent; the event carries no text.
    const [sam] = await H.t.db.select().from(contact).where(eq(contact.phone, SAM));
    expect(sam).toMatchObject({ tenantId: A(), consent: {}, optedOutAt: null });
    const evs = await H.t.db
      .select()
      .from(event)
      .where(and(eq(event.tenantId, A()), eq(event.type, "message.received")));
    expect(evs).toHaveLength(1);
    expect(evs[0]?.payload).toMatchObject({ from: SAM, knownContact: false, keyword: null });
    expect(JSON.stringify(evs[0]?.payload)).not.toContain("order ready");
    // The operator sees the thread; client B sees nothing of it.
    const thread = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${A()}/contacts/${sam?.id}/messages`,
    );
    expect(j(thread.json).items[0]).toMatchObject({ direction: "in", text: "Is my order ready?" });
    expect((await H.call(admin("b"), "GET", `/api/contacts/${sam?.id}/messages`)).status).toBe(404);
  });

  it("opts a contact out on STOP and back in on START, at once", async () => {
    const stop = await textIn(PAT, "Stop.");
    expect(stop.res.status).toBe(200);
    let [pat] = await H.t.db.select().from(contact).where(eq(contact.phone, PAT));
    expect(pat).toMatchObject({ optOutSource: "keyword:STOP" });
    // Only the contact lifts a STOP.
    const lift = await H.call(admin("a"), "POST", `/api/contacts/${pat?.id}/consent`, {
      action: "lift_opt_out",
    });
    expect(lift.status).toBe(409);
    expect(j(lift.json).error.code).toBe("contact_opted_out");
    await textIn(PAT, "START");
    [pat] = await H.t.db.select().from(contact).where(eq(contact.phone, PAT));
    expect(pat).toMatchObject({ optedOutAt: null, optOutSource: null });
    expect((pat?.consent as { sms?: { source: string } } | undefined)?.sms?.source).toBe(
      "texted START",
    );
    const kinds = (
      await H.t.db
        .select()
        .from(contactChange)
        .where(eq(contactChange.contactId, pat?.id ?? ""))
    ).map((l) => (l.change as { kind: string; by?: string }).kind);
    expect(kinds.slice(-2)).toEqual(["opt_out", "opt_in"]);
  });

  describe("a workflow that texts back", () => {
    let agentId = "";

    beforeAll(async () => {
      const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
        slug: "front-desk",
        bundle: bundle(REPLY_WORKFLOW),
      });
      expect(created.status, JSON.stringify(created.json)).toBe(200);
      expect(j(created.json).errors ?? [], JSON.stringify(created.json)).toEqual([]);
      agentId = j(created.json).agent.id;
      const op = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
        bindings: { twilio: setup.twilio.connectionId },
      });
      expect(op.status, JSON.stringify(op.json)).toBe(200);
      const pub = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/agents/${agentId}/versions/${j(created.json).version.id}/publish`,
      );
      expect(pub.status, JSON.stringify(pub.json)).toBe(200);
      await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, agentId));
    });

    async function startedBy(from: string, body: string) {
      const before = [...H.instances.started.keys()];
      await textIn(from, body);
      await H.settle();
      const fresh = [...H.instances.started.entries()].filter(([k]) => !before.includes(k));
      expect(fresh).toHaveLength(1);
      return fresh[0]?.[1];
    }

    it("starts on a text, reads it as a tool result, and texts back once after approval", async () => {
      const params = await startedBy(PAT, "Can I move my delivery to Friday?");
      if (!params) throw new Error("no run");
      expect(params.agentId).toBe(agentId);
      // Waiting on approval: nothing sent yet.
      const sendsBefore = twilio.sends().length;
      const result = await executeRun(deps(), params, cloudflareStepRunner(approver("a")));
      expect(result).toEqual({ status: "succeeded" });
      expect(twilio.sends()).toHaveLength(sendsBefore + 1);
      expect(twilio.sends().at(-1)?.form).toMatchObject({
        To: PAT,
        From: number,
        Body: "Thanks, we got your message.",
        StatusCallback: setup.webhooks.status,
      });
      const [action] = await H.t.db
        .select()
        .from(externalAction)
        .where(eq(externalAction.runId, params.runId));
      expect(action).toMatchObject({ status: "done", tool: SMS_SEND_TOOL, approvedBy: H.A.admin });
      expect(action?.before).toMatchObject({ contact: { name: "Pat Lee" }, channel: "sms" });
      // Replaying the run sends nothing more.
      await executeRun(deps(), params, cloudflareStepRunner(approver("a")));
      expect(twilio.sends()).toHaveLength(sendsBefore + 1);
      const usage = await H.t.db.select().from(usageDaily).where(eq(usageDaily.agentId, agentId));
      expect(usage.reduce((n, u) => n + u.messages, 0)).toBe(1);
      // The reply is in Pat's thread, then its delivery status arrives (signed, once).
      const sid = (action?.result as { sid?: string } | undefined)?.sid ?? "";
      const st = await twilio.status({ sid, status: "delivered", url: setup.webhooks.status });
      const path = setup.webhooks.status.replace(ORIGIN, "");
      expect((await twilioPost(path, st.params, "bad")).status).toBe(403);
      expect((await twilioPost(path, st.params, st.signature)).status).toBe(200);
      expect((await twilioPost(path, st.params, st.signature)).status).toBe(200);
      const statusEvents = await H.t.db
        .select()
        .from(event)
        .where(and(eq(event.tenantId, A()), eq(event.type, "message.status")));
      expect(statusEvents).toHaveLength(1);
      const [pat] = await H.t.db.select().from(contact).where(eq(contact.phone, PAT));
      const thread = await H.call(admin("a"), "GET", `/api/contacts/${pat?.id}/messages`);
      expect(j(thread.json).items[0]).toMatchObject({ direction: "out", sid, status: "delivered" });
      const [r] = await H.t.db.select().from(run).where(eq(run.id, params.runId));
      expect(r?.status).toBe("succeeded");
    });

    it("sends nothing to someone who hasn't agreed, or in quiet hours", async () => {
      // Sam texted in but never agreed to texts: the reply is refused before any approval.
      const sendsBefore = twilio.sends().length;
      const params = await startedBy(SAM, "Hello?");
      if (!params) throw new Error("no run");
      const refused = await executeRun(deps(), params, cloudflareStepRunner(approver("a")));
      expect(refused.status).toBe("failed");
      expect(JSON.stringify(refused)).toContain("agreed");
      expect(twilio.sends()).toHaveLength(sendsBefore);

      // Quiet hours all day: approved, then refused at the send.
      await H.call(OPERATOR, "PUT", ops(), { quietHours: { start: "00:00", end: "23:59" } });
      const quiet = await startedBy(PAT, "Are you open now?");
      if (!quiet) throw new Error("no run");
      const result = await executeRun(deps(), quiet, cloudflareStepRunner(approver("a")));
      expect(result.status).toBe("failed");
      const [action] = await H.t.db
        .select()
        .from(externalAction)
        .where(eq(externalAction.runId, quiet.runId));
      expect(action?.status).toBe("failed");
      expect(JSON.stringify(action?.error)).toContain("quiet hours");
      expect(twilio.sends()).toHaveLength(sendsBefore);
      await H.call(OPERATOR, "PUT", ops(), { quietHours: { start: "03:00", end: "03:01" } });
    });

    it("never starts the reply workflow for STOP, and keeps every message inside its client", async () => {
      const before = H.instances.started.size;
      await textIn(PAT, "STOP");
      await H.settle();
      expect(H.instances.started.size).toBe(before);
      await textIn(PAT, "START");
      // Client B's admin and data see none of A's messages, contacts or events.
      const bMsgs = await H.t.db.select().from(message).where(eq(message.tenantId, H.B.tenantId));
      expect(bMsgs.filter((m) => JSON.stringify(m.body).includes("delivery"))).toHaveLength(0);
      const [b] = await H.t.db.select().from(tenant).where(eq(tenant.id, H.B.tenantId));
      expect(b).toBeDefined();
      expect(j((await H.call(admin("b"), "GET", "/api/contacts")).json).items).toHaveLength(0);
    });
  });
  describe("an automatic text after a crash", () => {
    let agentId = "";
    let patId = "";

    beforeAll(async () => {
      // Texts go out without approval on this connection.
      await H.t.db
        .update(connection)
        .set({
          permissions: { read: "auto", create: "auto", update: "approval", delete: "off" },
        })
        .where(eq(connection.id, setup.twilio.connectionId));
      const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
        slug: "shipping-notices",
        bundle: bundle(NOTIFY_WORKFLOW, "act"),
      });
      expect(created.status, JSON.stringify(created.json)).toBe(200);
      agentId = j(created.json).agent.id;
      const op = await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
        bindings: { twilio: setup.twilio.connectionId },
      });
      expect(op.status, JSON.stringify(op.json)).toBe(200);
      const pub = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/agents/${agentId}/versions/${j(created.json).version.id}/publish`,
      );
      expect(pub.status, JSON.stringify(pub.json)).toBe(200);
      await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, agentId));
      const [pat] = await H.t.db.select().from(contact).where(eq(contact.phone, PAT));
      patId = pat?.id ?? "";
    });

    afterAll(() => {
      connectorFetch = twilio.fetch;
    });

    async function started() {
      const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
        workflow: "main",
        input: { to: PAT },
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const params = H.instances.started.get(j(res.json).runId);
      if (!params) throw new Error("not started");
      return params;
    }
    const runIt = (params: Parameters<typeof executeRun>[1]) =>
      executeRun(deps(), params, cloudflareStepRunner(new FakeWorkflowStep()));
    const actionOf = async (runId: string) =>
      (await H.t.db.select().from(externalAction).where(eq(externalAction.runId, runId)))[0];
    /** The Worker stopped while the action was executing (the first try's failure is undone). */
    const leftExecuting = (id: string) =>
      H.t.db
        .update(externalAction)
        .set({ status: "executing", error: null, result: null })
        .where(eq(externalAction.id, id));
    const optOut = async (out: boolean) => {
      const res = out
        ? await H.call(admin("a"), "POST", `/api/contacts/${patId}/consent`, { action: "opt_out" })
        : await H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/contacts/${patId}/consent`, {
            action: "lift_opt_out",
          });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
    };
    /** Sends reach Twilio (or not), then the connection is lost: Twilio's answer never arrives. */
    const lostAnswer =
      (reachTwilio: boolean): FetchLike =>
      async (url, init) => {
        if (init?.method === "POST" && url.endsWith("/Messages.json")) {
          if (reachTwilio) await twilio.fetch(url, init);
          throw new Error("the Worker stopped");
        }
        return twilio.fetch(url, init);
      };

    it("resumes when retried: an opt-out since the send doesn't fail it, and nothing is sent twice", async () => {
      const params = await started();
      const sends = twilio.sends().length;
      expect(await runIt(params)).toEqual({ status: "succeeded" });
      expect(twilio.sends()).toHaveLength(sends + 1);
      const action = await actionOf(params.runId);
      expect(action).toMatchObject({ status: "done", approvedBy: null });
      const sid = (action?.result as { sid?: string } | undefined)?.sid;

      // The Worker stopped before the action was marked done; Pat opts out; the step is retried.
      await leftExecuting(action?.id ?? "");
      await optOut(true);
      expect(await runIt(params)).toEqual({ status: "succeeded" });
      expect(twilio.sends()).toHaveLength(sends + 1);
      const again = await actionOf(params.runId);
      expect(again).toMatchObject({ status: "done", error: null });
      expect((again?.result as { sid?: string } | undefined)?.sid).toBe(sid);

      // A new text to Pat is refused before anything is proposed or sent.
      const refused = await started();
      const r = await runIt(refused);
      expect(r.status).toBe("failed");
      expect(JSON.stringify(r)).toContain("opted out");
      expect(await actionOf(refused.runId)).toBeUndefined();
      expect(twilio.sends()).toHaveLength(sends + 1);
      await optOut(false);
    });

    it("adopts the one message Twilio took before a crash instead of sending again", async () => {
      const params = await started();
      const sends = twilio.sends().length;
      connectorFetch = lostAnswer(true);
      expect((await runIt(params)).status).toBe("failed");
      connectorFetch = twilio.fetch;
      expect(twilio.sends()).toHaveLength(sends + 1);
      const sid = [...twilio.messages.values()].at(-1)?.sid;
      const action = await actionOf(params.runId);
      const attempts = await H.t.db
        .select()
        .from(rawRecord)
        .where(
          and(
            eq(rawRecord.entityType, "MessageAttempt"),
            eq(rawRecord.externalId, action?.idempotencyKey ?? ""),
          ),
        );
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.payload).toMatchObject({ to: PAT, from: number, channel: "sms" });

      await leftExecuting(action?.id ?? "");
      await optOut(true);
      expect(await runIt(params)).toEqual({ status: "succeeded" });
      expect(twilio.sends()).toHaveLength(sends + 1);
      const done = await actionOf(params.runId);
      expect(done).toMatchObject({ status: "done" });
      expect(done?.result).toMatchObject({ sid, to: PAT, contactName: "Pat Lee" });
      // Recorded once in Pat's thread and counted once.
      const stored = await H.t.db
        .select()
        .from(rawRecord)
        .where(and(eq(rawRecord.entityType, "Message"), eq(rawRecord.externalId, sid ?? "")));
      expect(stored).toHaveLength(1);
      expect(stored[0]?.payload).toMatchObject({ idempotencyKey: action?.idempotencyKey });
      const thread = await H.call(admin("a"), "GET", `/api/contacts/${patId}/messages`);
      expect(j(thread.json).items.filter((m: { sid?: string }) => m.sid === sid)).toHaveLength(1);
      await optOut(false);
    });

    it("never sends again when it can't tell: none or several matches fail for the operator to check", async () => {
      for (const reachTwilio of [false, true]) {
        const params = await started();
        const sends = twilio.sends().length;
        connectorFetch = lostAnswer(reachTwilio);
        expect((await runIt(params)).status).toBe("failed");
        connectorFetch = twilio.fetch;
        if (reachTwilio) {
          // Someone also texted Pat from the console: two messages nobody recorded.
          const twin = `SM${"7".repeat(32)}`;
          const first = [...twilio.messages.values()].at(-1);
          if (!first) throw new Error("no message");
          twilio.messages.set(twin, { ...first, sid: twin, body: "From the console" });
        }
        const action = await actionOf(params.runId);
        await leftExecuting(action?.id ?? "");

        const r = await runIt(params);
        expect(r.status).toBe("failed");
        expect(JSON.stringify(r)).toContain("may have been sent; check before trying again");
        expect(twilio.sends()).toHaveLength(sends + (reachTwilio ? 1 : 0));
        const failed = await actionOf(params.runId);
        expect(failed?.status).toBe("failed");
        expect(JSON.stringify(failed?.error)).toContain(
          "The text to Pat Lee may have been sent; check before trying again",
        );
        const items = await H.t.db
          .select()
          .from(inboxItem)
          .where(and(eq(inboxItem.runId, params.runId), eq(inboxItem.kind, "review")));
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          assigneeRole: "operator",
          subjectType: "external_action",
          subjectId: failed?.id,
          agentId,
          title: "The text to Pat Lee may have been sent",
        });
        expect(items[0]?.payload).toMatchObject({
          to: PAT,
          candidates: reachTwilio ? [expect.any(String), expect.any(String)] : [],
        });
        // The client never sees it; a replay changes nothing.
        const portal = await H.call(admin("a"), "GET", "/api/inbox");
        expect(JSON.stringify(portal.json)).not.toContain(items[0]?.id ?? "-");
        expect((await runIt(params)).status).toBe("failed");
        expect(twilio.sends()).toHaveLength(sends + (reachTwilio ? 1 : 0));
        expect(
          await H.t.db
            .select()
            .from(inboxItem)
            .where(and(eq(inboxItem.runId, params.runId), eq(inboxItem.kind, "review"))),
        ).toHaveLength(1);
      }
    });
  });
});
