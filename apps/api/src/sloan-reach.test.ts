// Sloan by email and text (docs/plan.md §1.150): a client's people email Sloan's own address and
// text the account's number; their words land in their own conversation with Sloan ("By email",
// "By text") and start Sloan's chat as a portal message does; Sloan's answer goes back the way they
// wrote. Strangers get the polite fixed reply and nothing is kept.

import {
  createTwilioConnector,
  type FetchLike,
  formEncode,
  generateEncryptionKey,
} from "@countersign/connectors";
import { FAKE_TWILIO_MAIN, fakeTwilio } from "@countersign/connectors/testing";
import { SLOAN_TEXT_MAX, SUPERVISOR_SLUG } from "@countersign/core";
import { agent, appUser, auditEvent, contact, message, run, tenant, thread } from "@countersign/db";
import { postMessage } from "@countersign/threads";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deliveringThreads, deliverSloanAnswer, type SloanAnswerDeps } from "./account/answer";
import { SLOAN_SWEEP_MINUTE, sloanTick } from "./account/sloan";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  user,
} from "./api.test-helper";
import { handleEmail } from "./email";
import { defaultDeps } from "./http";
import { mailerFromEnv, twilioTexter } from "./notify/mailer";
import { quietNever } from "./quiet-hours.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const DOMAIN = "in.mezonas.test";
const ORIGIN = "https://app.mezonas.test";
const ENCRYPTION_KEY = generateEncryptionKey();
const twilio = fakeTwilio();
/** Mail sent through Resend. */
const mail: Record<string, unknown>[] = [];
const fetch: FetchLike = async (url, init) => {
  if (String(url).includes("resend.com")) {
    mail.push(JSON.parse(String((init as { body?: unknown })?.body ?? "{}")));
    return new Response(JSON.stringify({ id: `re_${mail.length}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as never;
  }
  return twilio.fetch(url, init);
};

const h = await createApiHarness({
  connectors: () => [createTwilioConnector({ fetch: twilio.fetch })],
  fetch,
  env: {
    ENCRYPTION_KEY,
    APP_ORIGIN: ORIGIN,
    EMAIL_FORWARDING_DOMAIN: DOMAIN,
    RESEND_API_KEY: "re_test_key",
    RESEND_FALLBACK_DOMAIN: "mail.mezonas.test",
    TWILIO_ACCOUNT_SID: FAKE_TWILIO_MAIN.accountSid,
    TWILIO_AUTH_TOKEN: FAKE_TWILIO_MAIN.authToken,
    BAA_PROCESSORS: "twilio",
  },
});
afterAll(() => h?.close());

describe.skipIf(!h)("Sloan by email and text", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  let address = "";
  let sloanId = "";
  let number = "";
  let setup: ReturnType<typeof j> = null;
  const PHONE = "+15125550199";

  const deps = () => ({
    ...defaultDeps,
    openDb: () => ({ db: H.db, close: async () => {} }),
    instances: () => H.instances,
    objects: () => H.objects,
    platform: () => H.platform,
    extractionTransport: () => null,
    fetch: () => fetch as never,
  });

  const answerDeps = (): SloanAnswerDeps => ({
    db: H.db,
    mailer: mailerFromEnv(H.env, fetch),
    texter: twilioTexter({ fetch, secrets: { ENCRYPTION_KEY } }),
    origin: ORIGIN,
    domain: DOMAIN,
    covered: new Set(["twilio"]),
  });

  function email(input: {
    from: string;
    to: string;
    id: string;
    dmarc: boolean;
    body: string;
    subject?: string;
  }) {
    const domain = input.from.slice(input.from.indexOf("@") + 1);
    const text = [
      ...(input.dmarc
        ? [`Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=${domain}`]
        : []),
      `From: ${input.from}`,
      `To: ${input.to}`,
      `Subject: ${input.subject ?? "A question"}`,
      `Message-ID: <${input.id}@mail.example>`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      input.body,
    ].join("\r\n");
    const raw = new TextEncoder().encode(text);
    return {
      from: input.from,
      to: input.to,
      raw: new Response(raw).body as ReadableStream<Uint8Array>,
      rawSize: raw.length,
    };
  }

  async function receive(m: ReturnType<typeof email>) {
    const pending: Promise<unknown>[] = [];
    const out = await handleEmail(m, H.env, (p) => pending.push(p), deps());
    await Promise.all(pending);
    return out;
  }

  const sloanRuns = () =>
    H.t.db
      .select()
      .from(run)
      .where(and(eq(run.tenantId, A()), eq(run.agentId, sloanId)));

  async function channelThread(email: string, title: string) {
    const rows = await H.t.db
      .select({ t: thread })
      .from(thread)
      .where(and(eq(thread.tenantId, A()), eq(thread.title, title)));
    const [u] = await H.t.db.select().from(appUser).where(eq(appUser.email, email));
    return rows.map((r) => r.t).find((t) => t.createdBy === u?.id);
  }

  const messagesIn = (threadId: string) =>
    H.t.db.select().from(message).where(eq(message.threadId, threadId)).orderBy(message.createdAt);

  /** Sloan's answer in a thread, as its run would post it. */
  async function answer(threadId: string, text: string) {
    const [t] = await H.t.db.select().from(thread).where(eq(thread.id, threadId));
    if (!t) throw new Error("no thread");
    const posted = await H.t.db.transaction((tx) =>
      postMessage(tx as never, {
        tenantId: A(),
        thread: t,
        senderType: "agent",
        senderId: sloanId,
        kind: "text",
        body: { text },
        sources: [],
        audience: "client",
      }),
    );
    return { threadId, messageId: posted.id };
  }

  beforeAll(async () => {
    await sloanTick(H.db, H.platform, new Date(Date.UTC(2026, 10, 17, 9, SLOAN_SWEEP_MINUTE)));
    const [s] = await H.t.db
      .select()
      .from(agent)
      .where(
        and(eq(agent.tenantId, A()), eq(agent.slug, SUPERVISOR_SLUG), eq(agent.kind, "client")),
      );
    sloanId = s?.id as string;
    expect(s?.runStatus).toBe("active");
  });

  it("tells the client's people and their operators where to reach Sloan", async () => {
    const res = await H.call(user("a"), "GET", "/api/sloan/reach");
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    address = j(res.json).email;
    expect(address).toMatch(/^sloan\.client-a-[a-z2-7]{26}@in\.mezonas\.test$/);
    // No number that can text yet.
    expect(j(res.json).phone).toBeNull();
    const ops = await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/sloan/reach`);
    expect(j(ops.json).email).toBe(address);
    // An operator who doesn't serve the client learns nothing of it.
    const other = await H.call(OTHER_OPERATOR, "GET", `/api/ops/clients/${A()}/sloan/reach`);
    expect(other.status).not.toBe(200);
    // Another client's Sloan has its own address.
    const b = await H.call(user("b"), "GET", "/api/sloan/reach");
    expect(j(b.json).email).not.toBe(address);
  });

  it("puts a person's email in their own conversation with Sloan, once, and starts Sloan", async () => {
    const m = () =>
      email({
        from: admin("a"),
        to: address,
        id: "ask-1",
        dmarc: true,
        body: "What is waiting on me?\n\nOn Mon, Sloan wrote:\n> earlier",
      });
    expect((await receive(m()))?.status).toBe("accepted");
    const t = await channelThread(admin("a"), "By email");
    expect(t).toMatchObject({ subjectType: "account", subjectId: null });
    const rows = await messagesIn(t?.id as string);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ senderType: "user", audience: "client" });
    expect(rows[0]?.body).toMatchObject({
      text: "What is waiting on me?",
      via: "email",
      email: { subject: "A question", messageId: "<ask-1@mail.example>" },
    });
    // Sloan's chat starts on it, as on a portal message.
    expect(await sloanRuns()).toHaveLength(1);
    // The same mail again: nothing new.
    await receive(m());
    expect(await messagesIn(t?.id as string)).toHaveLength(1);
    expect(await sloanRuns()).toHaveLength(1);
    // A second email continues the same conversation.
    await receive(
      email({ from: admin("a"), to: address, id: "ask-2", dmarc: true, body: "And tomorrow?" }),
    );
    expect(await messagesIn(t?.id as string)).toHaveLength(2);
    // Audited on the person's behalf.
    const audits = await H.t.db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, A()), eq(auditEvent.action, "sloan.email_received")));
    expect(audits.length).toBe(2);
  });

  it("keeps nothing from a stranger or an unproven sender: a polite reply only with DMARC", async () => {
    mail.length = 0;
    const before = (await sloanRuns()).length;
    // Another client's person is a stranger here.
    await receive(
      email({ from: admin("b"), to: address, id: "s-1", dmarc: true, body: "Pay me." }),
    );
    expect(mail.map((m) => m.to)).toEqual([[admin("b")]]);
    expect(await channelThread(admin("b"), "By email")).toBeUndefined();
    // This client's person without DMARC pass: anyone could have written it.
    mail.length = 0;
    await receive(
      email({ from: user("a"), to: address, id: "s-2", dmarc: false, body: "Pause everything." }),
    );
    expect(mail).toEqual([]);
    expect(await channelThread(user("a"), "By email")).toBeUndefined();
    expect(await sloanRuns()).toHaveLength(before);
  });

  it("refuses a forged address: another client's id with this label", async () => {
    const forged = address.replace(/-[a-z2-7]{26}@/, `-${"a".repeat(26)}@`);
    const out = await receive(
      email({ from: admin("a"), to: forged, id: "f-1", dmarc: true, body: "Hi" }),
    );
    expect(out?.status).toBe("dropped");
  });

  it("emails Sloan's answer back to the person, threaded, with Sloan's address to reply to", async () => {
    mail.length = 0;
    const t = await channelThread(admin("a"), "By email");
    const out = await deliverSloanAnswer(
      answerDeps(),
      A(),
      await answer(t?.id as string, "Two approvals wait on you."),
    );
    expect(out.status, JSON.stringify(out)).toBe("sent");
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      to: [admin("a")],
      subject: "Re: A question",
      reply_to: address,
      headers: { "In-Reply-To": "<ask-2@mail.example>" },
    });
    expect(String(mail[0]?.from)).toContain("Sloan via Mezonas");
    expect(String(mail[0]?.text)).toContain("Two approvals wait on you.");
    expect(String(mail[0]?.text)).toContain(`${ORIGIN}/sloan/${t?.id}`);
  });

  it("sends nothing more for a portal conversation, or by email in HIPAA mode", async () => {
    mail.length = 0;
    const started = await H.call(admin("a"), "POST", "/api/threads", { subject: "account" });
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    const portalThread = j(started.json).thread.id as string;
    const posted = await H.call(admin("a"), "POST", `/api/threads/${portalThread}/messages`, {
      text: "Hello",
    });
    expect(posted.status, JSON.stringify(posted.json)).toBe(200);
    const out = await deliverSloanAnswer(answerDeps(), A(), await answer(portalThread, "Hi."));
    expect(out).toMatchObject({ status: "skipped", reason: "asked_in_the_portal" });
    const [row] = await H.t.db.select().from(tenant).where(eq(tenant.id, A()));
    const settings = (row?.settings ?? {}) as Record<string, unknown>;
    await H.t.db
      .update(tenant)
      .set({ settings: { ...settings, compliance: { hipaa: true } } })
      .where(eq(tenant.id, A()));
    try {
      const t = await channelThread(admin("a"), "By email");
      const out = await deliverSloanAnswer(answerDeps(), A(), await answer(t?.id as string, "Ok."));
      expect(out).toMatchObject({ status: "skipped", reason: "hipaa" });
    } finally {
      await H.t.db.update(tenant).set({ settings }).where(eq(tenant.id, A()));
    }
    expect(mail).toEqual([]);
  });

  it("delivers only a live answer for the client through the runtime's threads port", async () => {
    const t = await channelThread(admin("a"), "By email");
    const posts: string[] = [];
    const inner = {
      read: async () => ({ threadId: "", subjectType: null, messages: [] }),
      post: async (_tenantId: string, input: { text: string }) => {
        const a = await answer(t?.id as string, input.text);
        posts.push(a.messageId);
        return a;
      },
    };
    mail.length = 0;
    const port = deliveringThreads(inner as never, answerDeps());
    const base = {
      agentId: sloanId,
      agentVersionId: sloanId,
      runId: sloanId,
      stepId: "answer",
      threadId: t?.id as string,
      sources: [],
    };
    await port.post(A(), {
      ...base,
      mode: "live",
      text: "For the operator.",
      audience: "operator",
    });
    await port.post(A(), { ...base, mode: "test", text: "A test.", audience: "client" });
    expect(mail).toEqual([]);
    await port.post(A(), { ...base, mode: "live", text: "Done.", audience: "client" });
    expect(mail).toHaveLength(1);
    expect(posts).toHaveLength(3);
  });

  describe("by text", () => {
    const msg = (path = "") => `/api/ops/clients/${A()}/messaging${path}`;

    async function textIn(from: string, body: string) {
      const m = await twilio.inbound({
        account: setup.twilio.subaccountSid,
        from,
        to: number,
        body,
        url: setup.webhooks.messages,
        channel: "sms",
      });
      const res = await H.call(
        null,
        "POST",
        setup.webhooks.messages.replace(ORIGIN, ""),
        formEncode(m.params),
        { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": m.signature },
      );
      expect(res.status).toBe(200);
      await H.settle();
    }

    beforeAll(async () => {
      expect((await H.call(OPERATOR, "PUT", msg(), { quietHours: quietNever() })).status).toBe(200);
      setup = j((await H.call(OPERATOR, "POST", msg("/twilio"))).json).setup;
      setup = j(
        (await H.call(OPERATOR, "POST", msg("/numbers"), { phoneNumber: "+15125550101" })).json,
      ).setup;
      number = setup.twilio.numbers[0].phoneNumber;
      const brandSid = `BN${"1".repeat(32)}`;
      const serviceSid = `MG${"2".repeat(32)}`;
      await H.call(OPERATOR, "PUT", msg("/a2p"), { brandSid, messagingServiceSid: serviceSid });
      twilio.setBrand(brandSid, "APPROVED");
      twilio.setCampaign(serviceSid, "VERIFIED");
      await H.call(OPERATOR, "POST", msg("/a2p/refresh"));
      // The client admin's directory entry, signed up for texts.
      await H.t.db.insert(contact).values({
        tenantId: A(),
        name: "Client A admin",
        email: admin("a"),
        phone: PHONE,
        consent: {
          sms: {
            grantedAt: new Date().toISOString(),
            source: "signed up on the texting page",
          },
        },
      });
    });

    it("shows the account's number once it can text", async () => {
      const res = await H.call(user("a"), "GET", "/api/sloan/reach");
      expect(j(res.json).phone).toBe(number);
    });

    it("puts a signed-up person's text in their conversation with Sloan and texts the answer back", async () => {
      const before = (await sloanRuns()).length;
      await textIn(PHONE, "Is the Acme invoice paid? Card 4111 1111 1111 1111");
      const t = await channelThread(admin("a"), "By text");
      expect(t).toBeDefined();
      const [m] = await messagesIn(t?.id as string);
      expect(m?.body).toMatchObject({ via: "sms", sms: { to: number } });
      expect(JSON.stringify(m?.body)).not.toContain("4111 1111 1111 1111");
      expect(await sloanRuns()).toHaveLength(before + 1);

      const sentBefore = twilio.messages.size;
      const long = `${"Yes, it was paid on Friday. ".repeat(40)}`;
      const out = await deliverSloanAnswer(answerDeps(), A(), await answer(t?.id as string, long));
      expect(out.status, JSON.stringify(out)).toBe("sent");
      expect(twilio.messages.size).toBe(sentBefore + 1);
      const last = [...twilio.messages.values()].at(-1);
      expect(last).toMatchObject({ to: PHONE });
      expect(String(last?.body).length).toBeLessThanOrEqual(SLOAN_TEXT_MAX);
      expect(String(last?.body)).toContain(`${ORIGIN}/sloan/${t?.id}`);
    });

    it("leaves a stranger's text where it was: no conversation with Sloan", async () => {
      const before = (await sloanRuns()).length;
      await textIn("+15125550177", "Who is this?");
      expect(await sloanRuns()).toHaveLength(before);
      const threads = await H.t.db
        .select()
        .from(thread)
        .where(and(eq(thread.tenantId, A()), eq(thread.title, "By text")));
      expect(threads).toHaveLength(1);
    });
  });
});
