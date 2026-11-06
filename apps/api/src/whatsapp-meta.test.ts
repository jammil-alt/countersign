// v0.14 W4-A (docs/plan.md §1.57): WhatsApp through Meta, through the running app, against a fake
// Graph API (nothing live). The client admin connects its own number with Embedded Signup (the
// state checked; the token, account, number and PIN in the vault, never in a response); a number
// another client has is refused. Meta's webhook: the handshake, the signature over the raw body
// before anything else (tampered, wrong secret, missing: 401; unconfigured: 503), routing by the
// receiving number (an unknown number ignored, never a default client), one message per `wamid`,
// status callbacks. Capture parity with M33 on Twilio: attachments off keeps only their existence;
// on, a photo comes in Meta's two steps (re-resolved once when its link expired), filed once as a
// document, read and linked; a retried delivery makes nothing twice. The same workflow's
// `whatsapp.send` goes through Twilio or Meta by the agent's binding, after approval, with consent
// and quiet hours checked. Groups only where the client turned them on. Clients stay apart.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createTwilioConnector,
  createWhatsappMetaConnector,
  type FetchLike,
  formEncode,
  generateEncryptionKey,
  parseUrl,
} from "@countersign/connectors";
import {
  FAKE_META,
  FAKE_TWILIO_MAIN,
  fakeInboundPayload,
  fakeMeta,
  fakeStatusPayload,
  fakeTwilio,
} from "@countersign/connectors/testing";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import {
  agent,
  connection,
  contact,
  conversation,
  document,
  externalAction,
  rawRecord,
  tenantChange,
} from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { DEFAULT_FIXTURE_DIR } from "@countersign/llm/node";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  forbiddenKeys,
  OPERATOR,
  user,
} from "./api.test-helper";
import { MESSAGE_MEDIA_ENTITY } from "./conversations/capture";
import { fileSafeId } from "./conversations/media";
import { credentialsFor, executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://app.mezonas.test";
const HOOK = "/api/hooks/whatsapp_meta";
const NUMBER_A = "509876543210";
const NUMBER_B = "509876549999";
const meta = fakeMeta([
  {
    wabaId: "102030405060",
    numbers: [{ id: NUMBER_A, display: "+1 512-555-0199", verifiedName: "Acme Millwork" }],
  },
  {
    wabaId: "102030409999",
    numbers: [{ id: NUMBER_B, display: "+1 737-555-0123", verifiedName: "Birch Cabinets" }],
  },
]);
const twilio = fakeTwilio();
const PAT = "+15555550100";
const SAM = "+15555550122";
const PHOTO = new Uint8Array(
  readFileSync(resolve(DEFAULT_FIXTURE_DIR, "..", "invoices", "cedar-ridge-7731.png")),
);
/** Meta's hosts to the fake Graph API, everything else to the fake Twilio. */
const fetch: FetchLike = (url, init) => {
  const origin = parseUrl(url)?.origin;
  return origin === "https://graph.facebook.com" || origin === "https://lookaside.fbsbx.com"
    ? meta.fetch(url, init)
    : twilio.fetch(url, init);
};

const h = await createApiHarness({
  connectors: () => [
    createTwilioConnector({ fetch: twilio.fetch }),
    createWhatsappMetaConnector({ ...FAKE_META, fetch: meta.fetch }),
  ],
  env: {
    ENCRYPTION_KEY,
    APP_ORIGIN: ORIGIN,
    OAUTH_STATE_SECRET: "state-secret-".repeat(4),
    META_APP_ID: FAKE_META.appId,
    META_APP_SECRET: FAKE_META.appSecret,
    META_CONFIG_ID: FAKE_META.configId,
    META_WEBHOOK_VERIFY_TOKEN: FAKE_META.verifyToken,
    TWILIO_ACCOUNT_SID: FAKE_TWILIO_MAIN.accountSid,
    TWILIO_AUTH_TOKEN: FAKE_TWILIO_MAIN.authToken,
  },
  fetch,
});
afterAll(() => h?.close());

/** One manual workflow: a WhatsApp message, behind approval (the step says nothing). */
function sendBundle(name: string, to = PAT): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name, role: "tells customers", mission: "say when orders are ready" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Only do what the workflow says.",
      skills: [],
      extraTools: ["whatsapp.send"],
      canCommand: [],
      permissions: { mode: "act" },
      budgets: { maxSteps: 4, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 3,
          trigger: { id: "trg-manual", on: { type: "manual", input: {} } },
          steps: [
            {
              id: "tell",
              name: "Tell them",
              kind: "action",
              tool: "whatsapp.send",
              input: { to, text: "Your order is ready" },
            },
          ],
        },
      },
    ],
  } as AgentBundleInput);
}

describe.skipIf(!h)("WhatsApp through Meta through the API", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const B = () => H.B.tenantId;
  const seen: string[] = [];
  /** What the portal answered (the client's admin and users): never a bundle, prompt or cost. */
  const portal: unknown[] = [];
  const call = async (...args: Parameters<ApiHarness["call"]>) => {
    const res = await H.call(...args);
    seen.push(JSON.stringify(res.json ?? null));
    if (args[0] && args[0] !== OPERATOR) portal.push(res.json);
    return res;
  };
  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
    credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
  });
  let metaA = "";
  let twilioA = "";
  let twilioNumber = "";
  let twilioSetup: ReturnType<typeof j> = null;
  let wamids = 0;
  const nextWamid = () => `wamid.HBgLTEST${String(++wamids).padStart(4, "0")}+/=`;

  async function deliver(payload: unknown, opts: { secret?: string; header?: string | null } = {}) {
    const { body, signature } = await meta.deliver(payload, opts.secret);
    const header = opts.header === undefined ? signature : opts.header;
    return call(null, "POST", HOOK, body, {
      "content-type": "application/json",
      ...(header === null ? {} : { "x-hub-signature-256": header }),
    });
  }

  async function messageIn(
    input: Omit<Parameters<typeof fakeInboundPayload>[0], "wamid"> & { wamid?: string },
  ) {
    const wamid = input.wamid ?? nextWamid();
    const res = await deliver(fakeInboundPayload({ ...input, wamid }));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await H.settle();
    return wamid;
  }

  const rawOf = (tenantId: string, wamid: string) =>
    H.t.db
      .select()
      .from(rawRecord)
      .where(and(eq(rawRecord.tenantId, tenantId), eq(rawRecord.externalId, wamid)));

  async function signUp(who: string, numberId: string) {
    const start = await call(who, "POST", "/api/connections/whatsapp_meta/authorize");
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const link = j(start.json).link;
    return call(who, "POST", "/api/connections/whatsapp_meta/callback", {
      params: {
        code: meta.issueCode(),
        state: link.state,
        waba_id: numberId === NUMBER_A ? "102030405060" : "102030409999",
        phone_number_id: numberId,
      },
    });
  }

  function approver() {
    return new FakeWorkflowStep(async (_name, type) => {
      const res = await call(admin("a"), "GET", "/api/inbox");
      const item = j(res.json).items.find(
        (i: { id: string }) => `inbox-${i.id.replace(/-/g, "")}` === type,
      );
      if (!item) throw new Error(`no open item for ${type}`);
      const done = await call(admin("a"), "POST", `/api/inbox/${item.id}/resolve`, {
        decision: "approve",
      });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      return H.instances.events.find((e) => e.event.type === type)?.event.payload;
    });
  }

  async function agentBoundTo(name: string, bindings: Record<string, string>) {
    const created = await call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug: name.toLowerCase().replace(/[^a-z]+/g, "-"),
      bundle: sendBundle(name),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = j(created.json).agent.id as string;
    const op = await call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, { bindings });
    expect(op.status, JSON.stringify(op.json)).toBe(200);
    const pub = await call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${id}/versions/${j(created.json).version.id}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    expect(j(pub.json).errors ?? []).toEqual([]);
    await H.t.db.update(agent).set({ runStatus: "active", stage: "live" }).where(eq(agent.id, id));
    return id;
  }

  async function run(agentId: string) {
    const res = await call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "main",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const params = H.instances.started.get(j(res.json).runId);
    if (!params) throw new Error("no run started");
    return params;
  }

  beforeAll(async () => {
    for (const id of [A(), B()]) {
      const offer = await call(OPERATOR, "PUT", `/api/ops/clients/${id}/connectors`, {
        offered: ["testkit", "twilio", "whatsapp_meta"],
      });
      expect(offer.status, JSON.stringify(offer.json)).toBe(200);
    }
    const ops = (path: string) => `/api/ops/clients/${A()}${path}`;
    // Quiet hours out of the way (a minute at 3 a.m.), Twilio's WhatsApp sender for the comparison.
    await call(OPERATOR, "PUT", ops("/messaging"), {
      quietHours: { start: "03:00", end: "03:01" },
    });
    await call(OPERATOR, "POST", ops("/messaging/twilio"));
    const bought = await call(OPERATOR, "POST", ops("/messaging/numbers"), {
      phoneNumber: "+15125550101",
    });
    twilioSetup = j(bought.json).setup;
    twilioNumber = twilioSetup.twilio.numbers[0].phoneNumber;
    twilioA = twilioSetup.twilio.connectionId;
    const wa = await call(
      OPERATOR,
      "PUT",
      ops(`/messaging/numbers/${twilioSetup.twilio.numbers[0].sid}/whatsapp`),
      { enabled: true },
    );
    twilioSetup = j(wa.json).setup;
    const pat = await call(OPERATOR, "POST", ops("/contacts"), {
      name: "Pat Lee",
      whatsapp: PAT,
      consent: { channels: ["whatsapp"], source: "asked for order updates" },
    });
    expect(pat.status, JSON.stringify(pat.json)).toBe(200);
  });

  it("is offered as WhatsApp on the client's own number, ready to connect", async () => {
    const res = await call(admin("a"), "GET", "/api/connections");
    const card = j(res.json).connections.find(
      (c: { connector: string }) => c.connector === "whatsapp_meta",
    );
    expect(card).toMatchObject({ name: "WhatsApp (your own number)", available: true });
    expect(card.connection).toBeNull();
  });

  it("answers Meta's handshake as text/plain, only with our verify token; 503 unconfigured", async () => {
    const q = (token: string, mode = "subscribe") =>
      `${HOOK}?hub.mode=${mode}&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=1158201444`;
    const ok = await call(null, "GET", q(FAKE_META.verifyToken));
    expect(ok.status).toBe(200);
    expect(ok.json).toBe(1158201444);
    expect(ok.headers.get("content-type")).toContain("text/plain");
    expect((await call(null, "GET", q("guess"))).status).toBe(403);
    expect((await call(null, "GET", q(FAKE_META.verifyToken, "unsubscribe"))).status).toBe(403);
    const env = H.env as unknown as Record<string, string | undefined>;
    const saved = env.META_WEBHOOK_VERIFY_TOKEN;
    env.META_WEBHOOK_VERIFY_TOKEN = undefined;
    try {
      expect((await call(null, "GET", q(FAKE_META.verifyToken))).status).toBe(503);
      const post = await deliver(
        fakeInboundPayload({ phoneNumberId: NUMBER_A, from: PAT, wamid: nextWamid(), text: "x" }),
      );
      expect(post.status).toBe(503);
    } finally {
      env.META_WEBHOOK_VERIFY_TOKEN = saved;
    }
  });

  it("Embedded Signup: the portal gets Meta's public values; the token goes to the vault only", async () => {
    // A client user can't connect it; the state must be this admin's.
    expect((await call(user("a"), "POST", "/api/connections/whatsapp_meta/authorize")).status).toBe(
      403,
    );
    const start = await call(admin("a"), "POST", "/api/connections/whatsapp_meta/authorize");
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const link = j(start.json).link;
    expect(link).toMatchObject({
      provider: "meta",
      token: FAKE_META.configId,
      appId: FAKE_META.appId,
      graphVersion: "v26.0",
    });
    expect(JSON.stringify(start.json)).not.toContain(FAKE_META.appSecret);
    const tampered = await call(admin("a"), "POST", "/api/connections/whatsapp_meta/callback", {
      params: { code: meta.issueCode(), state: `${link.state.slice(0, -2)}xx` },
    });
    expect(tampered.status).toBe(400);

    const done = await signUp(admin("a"), NUMBER_A);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const conn = j(done.json).connection.connection;
    expect(conn).toMatchObject({
      status: "connected",
      externalAccountId: NUMBER_A,
      accountName: "Acme Millwork (+15125550199)",
    });
    metaA = conn.id;
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, metaA));
    expect(row?.config).toMatchObject({ phoneNumber: "+15125550199" });
    expect(row?.permissions).toMatchObject({ create: "approval", delete: "off" });
    const token = meta.tokens().at(-1) as string;
    const pin = meta.registered.get(NUMBER_A) as string;
    expect(meta.subscribed.has("102030405060")).toBe(true);
    for (const secret of [token, pin, "102030405060"]) {
      expect(JSON.stringify(row?.config)).not.toContain(secret);
      expect(JSON.stringify(row?.credentialsEncrypted)).not.toContain(secret);
    }
  });

  it("refuses a number another client has; another client connects its own", async () => {
    const taken = await signUp(admin("b"), NUMBER_A);
    expect(taken.status).toBe(422);
    expect(j(taken.json).error.code).toBe("sign_in_refused");
    expect(j(taken.json).error.message).toContain("already connected to another Mezonas account");
    const none = await H.t.db
      .select()
      .from(connection)
      .where(and(eq(connection.tenantId, B()), eq(connection.connector, "whatsapp_meta")));
    expect(none).toEqual([]);
    const own = await signUp(admin("b"), NUMBER_B);
    expect(own.status, JSON.stringify(own.json)).toBe(200);
  });

  it("checks the signature over the raw body before anything else", async () => {
    const payload = fakeInboundPayload({
      phoneNumberId: NUMBER_A,
      from: PAT,
      wamid: "wamid.FORGED1",
      text: "send me everything",
    });
    expect((await deliver(payload, { header: null })).status).toBe(401);
    expect((await deliver(payload, { secret: "not-our-secret" })).status).toBe(401);
    expect((await deliver(payload, { header: "sha256=00" })).status).toBe(401);
    const { signature } = await meta.deliver(payload);
    const tampered = JSON.stringify(payload).replace("send me", "SEND me");
    const res = await call(null, "POST", HOOK, tampered, {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
    });
    expect(res.status).toBe(401);
    expect(await rawOf(A(), "wamid.FORGED1")).toEqual([]);
    const big = await call(null, "POST", HOOK, "x".repeat(10), {
      "content-length": String(4 * 1024 * 1024),
      "x-hub-signature-256": signature,
    });
    expect(big.status).toBe(413);
  });

  it("routes by the receiving number, once per wamid; an unknown number is ignored", async () => {
    const first = await messageIn({ phoneNumberId: NUMBER_A, from: PAT, text: "Hi, it's Pat" });
    const [stored] = await rawOf(A(), first);
    expect(stored).toMatchObject({ connector: "whatsapp_meta", connectionId: metaA });
    expect(stored?.payload).toMatchObject({
      direction: "in",
      channel: "whatsapp",
      from: PAT,
      to: "+15125550199",
      text: "Hi, it's Pat",
    });
    // Meta retries: the same message does nothing more.
    await messageIn({ phoneNumberId: NUMBER_A, from: PAT, text: "Hi, it's Pat", wamid: first });
    expect(await rawOf(A(), first)).toHaveLength(1);
    expect(await rawOf(B(), first)).toEqual([]);
    // A number no client has: acknowledged, kept nowhere, never given to a default client.
    const stray = await messageIn({ phoneNumberId: "500000000001", from: PAT, text: "lost" });
    const anywhere = await H.t.db.select().from(rawRecord).where(eq(rawRecord.externalId, stray));
    expect(anywhere).toEqual([]);
    // Client B's number is client B's, whoever writes.
    const toB = await messageIn({ phoneNumberId: NUMBER_B, from: PAT, text: "for Birch" });
    expect(await rawOf(B(), toB)).toHaveLength(1);
    expect(await rawOf(A(), toB)).toEqual([]);
    // A stranger becomes a contact with no consent, as on Twilio.
    await messageIn({
      phoneNumberId: NUMBER_A,
      from: SAM,
      text: "Who is this?",
      profileName: "Sam",
    });
    const [sam] = await H.t.db
      .select()
      .from(contact)
      .where(and(eq(contact.tenantId, A()), eq(contact.whatsapp, SAM)));
    expect(sam).toMatchObject({ name: "Sam", consent: {} });
    // Each client sees only its own conversations.
    const listA = j((await call(admin("a"), "GET", "/api/conversations")).json).items;
    const listB = j((await call(admin("b"), "GET", "/api/conversations")).json).items;
    const idsA = new Set(listA.map((c: { id: string }) => c.id));
    expect(listB.some((c: { id: string }) => idsA.has(c.id))).toBe(false);
  });

  it("captures like M33: off keeps only that an attachment existed; on files it once", async () => {
    const mediaId = meta.addMedia({ phoneNumberId: NUMBER_A, mimeType: "image/png", bytes: PHOTO });
    const off = await messageIn({
      phoneNumberId: NUMBER_A,
      from: PAT,
      media: { type: "image", id: mediaId, mime: "image/png", caption: "Here is the invoice" },
    });
    const [kept] = await rawOf(A(), off);
    expect(kept?.payload).toMatchObject({
      text: "Here is the invoice",
      media: [{ index: 0, contentType: "image/png", mediaSid: mediaId }],
      capture: { archive: true, wanted: [] },
    });
    expect(JSON.stringify(kept?.payload)).not.toContain("https://");
    expect(meta.resolved.get(mediaId)).toBeUndefined();

    // The client admin turns attachments on for Pat's conversation on this number.
    const list = j((await call(admin("a"), "GET", "/api/conversations")).json).items;
    const conv = list.find(
      (c: { id: string }) =>
        c.id ===
        (kept as unknown as { payload: { capture: { conversationId: string } } }).payload.capture
          .conversationId,
    );
    expect(conv).toMatchObject({ kind: "direct", channel: "whatsapp" });
    const on = await call(admin("a"), "PUT", `/api/conversations/${conv.id}/capture`, {
      attachments: "documents",
      updatedAt: conv.updatedAt,
    });
    expect(on.status, JSON.stringify(on.json)).toBe(200);

    // Its link has expired by the time we fetch: resolved again once, then filed.
    meta.expireNextLinks(1);
    const photoId = meta.addMedia({ phoneNumberId: NUMBER_A, mimeType: "image/png", bytes: PHOTO });
    const wamid = await messageIn({
      phoneNumberId: NUMBER_A,
      from: PAT,
      media: { type: "image", id: photoId, mime: "image/png" },
    });
    expect(meta.resolved.get(photoId)).toBe(2);
    const outcomes = await H.t.db
      .select()
      .from(rawRecord)
      .where(
        and(
          eq(rawRecord.tenantId, A()),
          eq(rawRecord.entityType, MESSAGE_MEDIA_ENTITY),
          eq(rawRecord.externalId, `${wamid}:0`),
        ),
      );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.payload).toMatchObject({ status: "filed", contentType: "image/png" });
    const docs = await H.t.db
      .select()
      .from(document)
      .where(
        and(
          eq(document.tenantId, A()),
          eq(document.filename, `whatsapp-${fileSafeId(wamid)}-0.png`),
        ),
      );
    expect(docs).toHaveLength(1);
    const [raw] = await rawOf(A(), wamid);
    expect(docs[0]).toMatchObject({ source: "message", connectionId: metaA });
    expect(docs[0]?.meta).toMatchObject({
      channel: "whatsapp",
      rawRecordId: raw?.id,
      messageSid: wamid,
      mediaIndex: 0,
    });
    const view = await call(admin("a"), "GET", `/api/documents/${docs[0]?.id}`);
    expect(j(view.json).document.status).toBe("extracted");
    // A retried delivery makes nothing twice.
    await messageIn({
      phoneNumberId: NUMBER_A,
      from: PAT,
      wamid,
      media: { type: "image", id: photoId, mime: "image/png" },
    });
    expect(meta.resolved.get(photoId)).toBe(2);
    expect(
      await H.t.db
        .select()
        .from(document)
        .where(
          and(
            eq(document.tenantId, A()),
            eq(document.filename, `whatsapp-${fileSafeId(wamid)}-0.png`),
          ),
        ),
    ).toHaveLength(1);
    // The portal's view of the message: the attachment filed, never a link.
    const msgs = await call(admin("a"), "GET", `/api/conversations/${conv.id}/messages`);
    const line = j(msgs.json).items.find((m: { sid: string }) => m.sid === wamid);
    expect(line.attachments[0]).toMatchObject({ status: "filed", documentId: docs[0]?.id });
    expect(JSON.stringify(msgs.json)).not.toContain("lookaside");
  });

  it("sends the same workflow's whatsapp.send through Twilio or Meta, by the agent's binding", async () => {
    // Pat wrote to both numbers within the day: free text may go out on either.
    const tw = await twilio.inbound({
      account: twilioSetup.twilio.subaccountSid,
      from: PAT,
      to: twilioNumber,
      body: "Hello on Twilio",
      url: twilioSetup.webhooks.messages,
      channel: "whatsapp",
    });
    const twRes = await call(
      null,
      "POST",
      twilioSetup.webhooks.messages.replace(ORIGIN, ""),
      formEncode(tw.params),
      { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": tw.signature },
    );
    expect(twRes.status).toBe(200);
    await H.settle();

    const viaTwilio = await agentBoundTo("Twilio desk", { twilio: twilioA });
    const viaMeta = await agentBoundTo("Meta desk", { whatsapp_meta: metaA });

    const twilioBefore = twilio.sends().length;
    const p1 = await run(viaTwilio);
    expect(await executeRun(deps(), p1, cloudflareStepRunner(approver()))).toEqual({
      status: "succeeded",
    });
    expect(twilio.sends()).toHaveLength(twilioBefore + 1);
    expect(meta.sent).toHaveLength(0);

    const p2 = await run(viaMeta);
    expect(await executeRun(deps(), p2, cloudflareStepRunner(approver()))).toEqual({
      status: "succeeded",
    });
    expect(twilio.sends()).toHaveLength(twilioBefore + 1);
    expect(meta.sent).toHaveLength(1);
    expect(meta.sent[0]?.body).toMatchObject({
      to: "15555550100",
      type: "text",
      text: { body: "Your order is ready" },
    });
    const [action] = await H.t.db
      .select()
      .from(externalAction)
      .where(eq(externalAction.runId, p2.runId));
    expect(action).toMatchObject({ tool: "whatsapp.send", status: "done", connectionId: metaA });
    expect(action?.approvedBy).toBe(H.A.admin);
    // A re-run (a retried Workflow) sends nothing twice.
    await executeRun(deps(), p2, cloudflareStepRunner(approver()));
    expect(meta.sent).toHaveLength(1);

    // Meta's status callback marks the message, once.
    const wamid = meta.sent[0]?.wamid as string;
    for (let i = 0; i < 2; i++) {
      const st = await deliver(
        fakeStatusPayload({ phoneNumberId: NUMBER_A, wamid, status: "delivered", to: PAT }),
      );
      expect(st.status).toBe(200);
    }
    const statuses = await H.t.db
      .select()
      .from(rawRecord)
      .where(and(eq(rawRecord.tenantId, A()), eq(rawRecord.externalId, `${wamid}:delivered`)));
    expect(statuses).toHaveLength(1);
    const contacts = j((await call(admin("a"), "GET", "/api/contacts")).json).items;
    const patId = contacts.find((c: { whatsapp: string }) => c.whatsapp === PAT).id;
    const thread = await call(admin("a"), "GET", `/api/contacts/${patId}/messages`);
    const out = j(thread.json).items.find((m: { sid: string }) => m.sid === wamid);
    expect(out).toMatchObject({ direction: "out", channel: "whatsapp", status: "delivered" });
  });

  it("checks consent before Meta is called, and asks no one to approve a refused send", async () => {
    // Sam wrote, but never agreed to messages.
    const created = await call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug: "sam-desk",
      bundle: sendBundle("Sam desk", SAM),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = j(created.json).agent.id as string;
    await call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { whatsapp_meta: metaA },
    });
    await call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${id}/versions/${j(created.json).version.id}/publish`,
    );
    await H.t.db.update(agent).set({ runStatus: "active", stage: "live" }).where(eq(agent.id, id));
    const before = meta.sent.length;
    const asked: string[] = [];
    const params = await run(id);
    const out = await executeRun(
      deps(),
      params,
      cloudflareStepRunner(
        new FakeWorkflowStep(async (_n, type) => {
          asked.push(type);
          throw new Error("nothing should wait for a person");
        }),
      ),
    );
    expect(out.status).not.toBe("succeeded");
    expect(asked).toEqual([]);
    expect(meta.sent).toHaveLength(before);
  });

  it("lets the operator bind an agent's WhatsApp channel to a Meta number, not another client's", async () => {
    const id = j(
      (
        await call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
          slug: "channel-desk",
          bundle: sendBundle("Channel desk"),
        })
      ).json,
    ).agent.id as string;
    const ok = await call(OPERATOR, "PUT", `/api/ops/agents/${id}/channels`, {
      channels: { whatsapp: metaA },
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const [bConn] = await H.t.db
      .select()
      .from(connection)
      .where(and(eq(connection.tenantId, B()), eq(connection.connector, "whatsapp_meta")));
    const other = await call(OPERATOR, "PUT", `/api/ops/agents/${id}/channels`, {
      channels: { whatsapp: bConn?.id },
    });
    expect(other.status).not.toBe(200);
  });

  it("keeps group messages only where the operator turned groups on", async () => {
    const group = "120363025246125486@g.us";
    const off = await messageIn({
      phoneNumberId: NUMBER_A,
      from: PAT,
      text: "hi all",
      groupId: group,
    });
    expect(await rawOf(A(), off)).toEqual([]);
    expect(
      (
        await call(user("a"), "PUT", `/api/ops/clients/${A()}/messaging/whatsapp-groups`, {
          enabled: true,
          reason: "x",
        })
      ).status,
    ).toBe(403);
    const turned = await call(
      OPERATOR,
      "PUT",
      `/api/ops/clients/${A()}/messaging/whatsapp-groups`,
      {
        enabled: true,
        reason: "the client runs its orders group with us",
      },
    );
    expect(turned.status, JSON.stringify(turned.json)).toBe(200);
    const logged = await H.t.db.select().from(tenantChange).where(eq(tenantChange.tenantId, A()));
    expect(
      logged.some((r) => (r.change as { setting?: string }).setting === "messaging.whatsappGroups"),
    ).toBe(true);
    const on = await messageIn({
      phoneNumberId: NUMBER_A,
      from: PAT,
      text: "STOP",
      groupId: group,
    });
    const [kept] = await rawOf(A(), on);
    const convId = (kept as unknown as { payload: { capture: { conversationId: string } } }).payload
      .capture.conversationId;
    const [conv] = await H.t.db.select().from(conversation).where(eq(conversation.id, convId));
    expect(conv).toMatchObject({ kind: "group", externalId: group, contactId: null });
    expect(conv?.capture).toMatchObject({ attachments: "off" });
    // STOP in a group is just a word: Pat is not opted out.
    const [pat] = await H.t.db
      .select()
      .from(contact)
      .where(and(eq(contact.tenantId, A()), eq(contact.whatsapp, PAT)));
    expect(pat?.optedOutAt).toBeNull();
  });

  it("disconnect unsubscribes our app and drops the token", async () => {
    const res = await call(admin("a"), "DELETE", `/api/connections/${metaA}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(meta.subscribed.has("102030405060")).toBe(false);
    const [row] = await H.t.db.select().from(connection).where(eq(connection.id, metaA));
    expect(row?.credentialsEncrypted).toBeNull();
    // Messages to the number now reach no one.
    const late = await messageIn({ phoneNumberId: NUMBER_A, from: PAT, text: "anyone?" });
    expect(await H.t.db.select().from(rawRecord).where(eq(rawRecord.externalId, late))).toEqual([]);
  });

  it("never put a token, the app secret or a PIN in a response, nor a portal-forbidden field", () => {
    const all = seen.join("\n");
    for (const t of meta.tokens()) expect(all).not.toContain(t);
    for (const pin of meta.registered.values()) expect(all).not.toContain(`"${pin}"`);
    expect(all).not.toContain(FAKE_META.appSecret);
    expect(forbiddenKeys(portal)).toEqual([]);
  });
});
