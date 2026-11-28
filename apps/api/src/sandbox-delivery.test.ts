// Messages to made-up people in the Sandbox (owner, 2026-11-27), against fake Resend (nothing
// live): the operator sets where they go (the Sandbox only, one of its own contacts, never a
// made-up address); a Sandbox reach-out to an example.com address goes there instead, with
// "[For Dana Whitfield]" on its subject and the place recorded on its attempt; unset, it is
// refused in words and nothing is sent; the operator's email reply by the tag answers as Dana; a
// text from the delivery phone answers the redirected reach-out as Dana; any other client sends
// as addressed, whatever its settings say.

import { createResendConnector, generateEncryptionKey, newReplyTag } from "@countersign/connectors";
import { FAKE_RESEND_MAIN, fakeResend } from "@countersign/connectors/testing";
import { AgentBundle, type AgentBundleInput, uuidv7 } from "@countersign/core";
import {
  agent,
  appUser,
  connection,
  contact,
  membership,
  message,
  reachOut,
  run,
  stepRun,
  tenant,
  withTenant,
} from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  MANUAL_TRIGGER,
  OPERATOR,
  unsigned,
  v5Workflow,
} from "./api.test-helper";
import { handleEmail } from "./email";
import { defaultDeps } from "./http";
import { matchRepliesIn } from "./reach/replies";
import { attemptFrom } from "./reach/service";
import { credentialsFor, reachDepsFor } from "./runs/execute";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://app.mezonas.test";
const FORWARDING = "in.mezonas.test";
const resend = fakeResend();

const h = await createApiHarness({
  connectors: () => [createResendConnector({ fetch: resend.fetch })],
  env: {
    ENCRYPTION_KEY,
    APP_ORIGIN: ORIGIN,
    RESEND_API_KEY: FAKE_RESEND_MAIN.apiKey,
    RESEND_FALLBACK_DOMAIN: "mail.mezonas.test",
    EMAIL_FORWARDING_DOMAIN: FORWARDING,
  },
  fetch: resend.fetch,
});
afterAll(() => h?.close());

const ME = "me@realmail.co";
const MY_PHONE = "+15125551234";
const DANA = "dana@ridgeline.example.com";
const DANA_PHONE = "+15125550102";
const SUBJECT = "Friday's delivery";
const TEXT = "Can you confirm Friday's delivery?";
const consent = (channels: string[]) =>
  Object.fromEntries(
    channels.map((ch) => [
      ch,
      { grantedAt: new Date().toISOString(), source: "test", basis: "express" },
    ]),
  );

function ordersBundle(): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Orders", role: "orders desk", mission: "Keep deliveries on time." },
      kind: "functional",
      model: { id: "test-model", maxTokens: 1024 },
      instructions: "Be brief.",
      skills: [{ skill: "comms.reach-out" }],
      extraTools: [],
      canCommand: [],
      permissions: { mode: "act" },
      budgets: { maxSteps: 4, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [
      { slug: "main", name: "Main", workflow: v5Workflow([], { triggers: [MANUAL_TRIGGER] }) },
    ],
  } as AgentBundleInput);
}

describe.skipIf(!h)("messages to made-up people in the Sandbox", () => {
  const H = h as ApiHarness;
  let sandbox = "";
  const setups = new Map<
    string,
    { agentId: string; versionId: string; dana: string; me: string }
  >();

  const deps = () =>
    reachDepsFor({
      db: H.db,
      platform: H.platform,
      transport: new FakeModel(),
      instances: H.instances,
      credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
    });
  const delivery = (id: string, body?: unknown) =>
    H.call(
      OPERATOR,
      body === undefined ? "GET" : "PUT",
      `/api/ops/clients/${id}/sandbox-delivery`,
      body,
    );

  /** A client with an email connection, Dana (made up), the operator, and an agent sending email. */
  async function setUp(tenantId: string, clientAdmin: string) {
    // A forwarding address, so replies come back to the client's reply addresses.
    const fwd = await H.call(clientAdmin, "GET", "/api/connections/upload/forwarding");
    expect(fwd.status, JSON.stringify(fwd.json)).toBe(200);
    const made = await H.call(OPERATOR, "POST", `/api/ops/clients/${tenantId}/email`, {
      domain: "ridgeline.example",
      localPart: "orders",
      fromName: "Ridgeline orders",
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const emailConn = j(made.json).setup.connection.connectionId as string;
    const people = await H.t.db
      .insert(contact)
      .values([
        {
          tenantId,
          name: "Dana Whitfield",
          email: DANA,
          phone: DANA_PHONE,
          relationship: "employee",
          consent: consent(["email", "sms"]),
        },
        {
          tenantId,
          name: "Operator (you)",
          email: ME,
          phone: MY_PHONE,
          relationship: "employee",
          consent: consent(["email", "sms"]),
        },
      ])
      .returning();
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${tenantId}/agents`, {
      slug: `orders-${tenantId.slice(0, 8)}`,
      bundle: ordersBundle(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const agentId = j(created.json).agent.id as string;
    const versionId = j(created.json).version.id as string;
    const pub = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${versionId}/publish`,
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, agentId));
    const ch = await H.call(OPERATOR, "PUT", `/api/ops/agents/${agentId}/channels`, {
      channels: { email: emailConn },
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(200);
    setups.set(tenantId, {
      agentId,
      versionId,
      dana: people[0]?.id as string,
      me: people[1]?.id as string,
    });
  }

  /** An approved reach-out to Dana on `channel`, as a live run's step plans it. */
  async function reachDana(tenantId: string, nodeId: string, channel: "email" | "sms" = "email") {
    const s = setups.get(tenantId);
    if (!s) throw new Error("not set up");
    const [r] = await H.t.db
      .insert(run)
      .values({
        tenantId,
        agentId: s.agentId,
        agentVersionId: s.versionId,
        workflowSlug: "main",
        mode: "live",
        trigger: { type: "manual", payload: {} },
        status: "running",
      })
      .returning();
    const [sr] = await H.t.db
      .insert(stepRun)
      .values({ tenantId, runId: r?.id as string, nodeId, nodeType: "skill", status: "running" })
      .returning();
    const id = uuidv7();
    await H.t.db.insert(reachOut).values({
      id,
      tenantId,
      agentId: s.agentId,
      agentVersionId: s.versionId,
      runId: r?.id as string,
      stepRunId: sr?.id as string,
      nodeId,
      contactId: s.dana,
      subject: `purpose:${nodeId}`,
      purpose: "Confirm Friday's delivery",
      urgency: "normal",
      plan: {
        channels: [channel],
        escalateAfter: "1 hour",
        language: "en",
        message: { template: { en: TEXT } },
        emailSubject: SUBJECT,
        expectReply: true,
        timeout: "2 days",
        urgentOutsideHours: true,
        automatic: true,
        approvedBy: null,
        replyTag: newReplyTag(id),
        data: {},
        checks: [],
      },
      status: "open",
    });
    return id;
  }

  const rowOf = async (id: string) =>
    (await H.t.db.select().from(reachOut).where(eq(reachOut.id, id)))[0];

  beforeAll(async () => {
    const [row] = await H.t.db
      .insert(tenant)
      .values({ name: "Sandbox", settings: { sandbox: true, approvals: { undoSeconds: 0 } } })
      .returning();
    sandbox = row?.id as string;
    const [you] = await H.t.db
      .insert(appUser)
      .values({ email: "admin@sandbox.example.com", name: "Sandbox admin" })
      .returning();
    await H.t.db.insert(membership).values([
      { tenantId: sandbox, userId: H.operator, role: "operator" },
      { tenantId: sandbox, userId: you?.id as string, role: "client_admin" },
    ]);
    await setUp(sandbox, "admin@sandbox.example.com");
    await setUp(H.A.tenantId, admin("a"));
  });

  it("refuses in words when nothing is set, and sends nothing", async () => {
    expect(j((await delivery(sandbox)).json)).toEqual({ email: null, phone: null });
    const sent = resend.emails.length;
    const id = await reachDana(sandbox, "unset");
    expect(await attemptFrom(deps(), sandbox, id, () => new Date())).toBe(0);
    expect(resend.emails.length).toBe(sent);
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: "ended", outcome: "not_allowed" });
    expect(row?.reason).toContain(
      "Dana Whitfield's address is made up: set where the Sandbox's messages to made-up people go",
    );
  });

  it("is set in the Sandbox only, to one of its own real contacts", async () => {
    expect((await delivery(H.A.tenantId)).status).toBe(422);
    expect((await delivery(H.A.tenantId, { email: ME, phone: null })).status).toBe(422);
    const madeUp = await delivery(sandbox, { email: DANA, phone: null });
    expect(madeUp.status).toBe(422);
    expect(j(madeUp.json).error.code).toBe("made_up");
    const stranger = await delivery(sandbox, { email: "nobody@realmail.co", phone: null });
    expect(j(stranger.json).error.code).toBe("not_a_contact");
    expect((await delivery(sandbox, { email: ME, phone: "not a phone" })).status).toBe(422);
    const set = await delivery(sandbox, { email: "Me@RealMail.co", phone: "(512) 555-1234" });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(j(set.json)).toEqual({ email: ME, phone: MY_PHONE });
    expect(j((await delivery(sandbox)).json)).toEqual({ email: ME, phone: MY_PHONE });
  });

  it("sends a Sandbox message to a made-up person to the operator, and their reply answers as Dana", async () => {
    const id = await reachDana(sandbox, "redirected");
    expect(await attemptFrom(deps(), sandbox, id, () => new Date())).toBe(1);
    const sent = resend.emails.at(-1);
    expect(sent).toMatchObject({ to: [ME], subject: `[For Dana Whitfield] ${SUBJECT}` });
    expect(unsigned(sent?.text as string) ?? sent?.text).toContain(TEXT);
    const row = await rowOf(id);
    expect(row?.status).toBe("open");
    expect(row?.attempts).toMatchObject([{ channel: "email", status: "sent", redirectedTo: ME }]);

    // The operator answers from their own mailbox, to the reply address with the tag.
    const replyTo = sent?.reply_to as string;
    expect(replyTo).toMatch(/\+[a-z2-7]{34}@/);
    const raw = new TextEncoder().encode(
      [
        `Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=${ME}`,
        `From: Me <${ME}>`,
        `To: ${replyTo}`,
        `Subject: Re: [For Dana Whitfield] ${SUBJECT}`,
        "Message-ID: <reply-dana-1@realmail.co>",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Friday works.",
      ].join("\r\n"),
    );
    const pending: Promise<unknown>[] = [];
    await handleEmail(
      {
        from: ME,
        to: replyTo,
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
    const answered = await rowOf(id);
    expect(answered).toMatchObject({ status: "ended", outcome: "replied" });
    expect(j(answered?.reply).text).toContain("Friday works.");
    // Written in Dana's thread, as Dana's.
    const lines = await H.t.db
      .select()
      .from(message)
      .where(and(eq(message.tenantId, sandbox), eq(message.senderType, "contact")));
    expect(lines.some((m) => m.senderId === setups.get(sandbox)?.dana)).toBe(true);
  });

  it("matches a text from the delivery phone to the redirected reach-out, as Dana", async () => {
    const s = setups.get(sandbox);
    const id = await reachDana(sandbox, "texted", "sms");
    // As a text redirected to the operator's phone leaves it (the Twilio send is reach.test.ts's).
    await H.t.db
      .update(reachOut)
      .set({
        attempts: [
          {
            index: 0,
            channel: "sms",
            at: new Date().toISOString(),
            status: "sent",
            redirectedTo: MY_PHONE,
          },
        ],
      })
      .where(eq(reachOut.id, id));
    const event = (from: string) => ({
      type: "message.received",
      tenantId: sandbox,
      payload: { contactId: s?.me, channel: "sms", from, keyword: null, rawRecordId: null },
    });
    // Another number answers nothing of Dana's.
    await withTenant(H.db, sandbox, (tx) =>
      matchRepliesIn(tx, sandbox, [event("+15125559999")], new Date()),
    );
    expect((await rowOf(id))?.status).toBe("open");
    const woken = await withTenant(H.db, sandbox, (tx) =>
      matchRepliesIn(tx, sandbox, [event(MY_PHONE)], new Date()),
    );
    expect(woken.map((w) => w.id)).toEqual([id]);
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: "ended", outcome: "replied", contactId: s?.dana });
  });

  it("never redirects in any other client, whatever its settings say", async () => {
    const a = H.A.tenantId;
    const [t] = await H.t.db.select().from(tenant).where(eq(tenant.id, a));
    await H.t.db
      .update(tenant)
      .set({ settings: { ...t?.settings, sandboxDelivery: { email: ME, phone: MY_PHONE } } })
      .where(eq(tenant.id, a));
    const id = await reachDana(a, "elsewhere");
    expect(await attemptFrom(deps(), a, id, () => new Date())).toBe(1);
    expect(resend.emails.at(-1)).toMatchObject({ to: [DANA], subject: SUBJECT });
    expect((await rowOf(id))?.attempts).toMatchObject([{ channel: "email", status: "sent" }]);
    expect(j((await rowOf(id))?.attempts)[0].redirectedTo).toBeUndefined();
    // The connection is the client's own.
    const [conn] = await H.t.db
      .select()
      .from(connection)
      .where(and(eq(connection.tenantId, a), eq(connection.connector, "resend")));
    expect(conn).toBeDefined();
  });
});
