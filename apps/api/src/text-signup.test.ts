// Signing up for texts (docs/plan.md §1.98): the client's sign-up link, invitations by email, the
// public page, the consent and its evidence, the confirmation text, and what is left out.
import {
  createResendConnector,
  createTwilioConnector,
  type FetchLike,
  generateEncryptionKey,
  RESEND_API,
} from "@countersign/connectors";
import {
  FAKE_RESEND_MAIN,
  FAKE_TWILIO_MAIN,
  fakeResend,
  fakeTwilio,
} from "@countersign/connectors/testing";
import { a2pKeywordsOf, TEXT_SIGNUP_LINK_HOURLY_MAX, textSignupTerms } from "@countersign/core";
import { contact, contactChange, tenant, withTenant } from "@countersign/db";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR, user } from "./api.test-helper";
import { sendTextInvitations, signTextSignup } from "./messaging/signup";
import { mailerFromEnv } from "./notify/mailer";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ORIGIN = "https://app.mezonas.test";
const twilio = fakeTwilio();
const resend = fakeResend();
const emails: { from: string; to: string[]; subject: string; text: string; html?: string }[] = [];
/** Holds or fails outgoing texts, for when the confirmation goes. */
const sending: { hold: Promise<void> | null; fail: boolean } = { hold: null, fail: false };
const fetch: FetchLike = async (url, init) => {
  if (url.startsWith(RESEND_API)) {
    if (init?.body && url.endsWith("/emails")) emails.push(JSON.parse(init.body));
    return resend.fetch(url, init);
  }
  if (init?.method === "POST" && url.endsWith("/Messages.json")) {
    if (sending.hold) await sending.hold;
    if (sending.fail) {
      return {
        status: 500,
        ok: false,
        headers: { get: () => null },
        text: async () => JSON.stringify({ code: 20500, message: "failed" }),
      };
    }
  }
  return twilio.fetch(url, init);
};

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness({
  connectors: () => [
    createTwilioConnector({ fetch: twilio.fetch }),
    createResendConnector({ fetch: resend.fetch }),
  ],
  env: {
    ENCRYPTION_KEY: generateEncryptionKey(),
    APP_ORIGIN: ORIGIN,
    TWILIO_ACCOUNT_SID: FAKE_TWILIO_MAIN.accountSid,
    TWILIO_AUTH_TOKEN: FAKE_TWILIO_MAIN.authToken,
    RESEND_API_KEY: FAKE_RESEND_MAIN.apiKey,
    RESEND_FALLBACK_DOMAIN: "mail.mezonas.test",
  },
  fetch,
});
afterAll(() => h?.close());

const tokenIn = (url: string) => url.slice(url.indexOf("/texts/") + "/texts/".length);
/** The texts sent to a number, once the work after each response is done. */
const textsTo = async (to: string) => {
  await h?.settle();
  return [...twilio.messages.values()].filter((m) => m.to === to);
};

describe.skipIf(!h)("signing up for texts", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const B = () => H.B.tenantId;
  const msg = (path = "") => `/api/ops/clients/${A()}/messaging${path}`;
  const view = (token: string) => H.call(null, "GET", `/api/text-signup/${token}`);
  const submit = (token: string, body: Record<string, unknown>) =>
    H.call(null, "POST", `/api/text-signup/${token}`, { agree: true, wordingVersion: 1, ...body });
  const newContact = async (who: string, body: Record<string, unknown>) => {
    const res = await H.call(who, "POST", "/api/contacts", body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return j(res.json).contact.id as string;
  };
  const logOf = (id: string) =>
    H.t.db
      .select()
      .from(contactChange)
      .where(eq(contactChange.contactId, id))
      .orderBy(contactChange.createdAt);
  const invite = (who: string, contactIds: string[]) =>
    H.call(who, "POST", "/api/contacts/text-invitations", { contactIds });
  const lastEmailTo = (to: string) => emails.filter((e) => e.to.includes(to)).at(-1);

  beforeAll(async () => {
    // Client A's number: a subaccount, a number, A2P approved.
    await H.call(OPERATOR, "POST", msg("/twilio"));
    await H.call(OPERATOR, "POST", msg("/numbers"), { phoneNumber: "+15125550101" });
    const brandSid = `BN${"1".repeat(32)}`;
    const serviceSid = `MG${"2".repeat(32)}`;
    await H.call(OPERATOR, "PUT", msg("/a2p"), { brandSid, messagingServiceSid: serviceSid });
    twilio.setBrand(brandSid, "APPROVED");
    twilio.setCampaign(serviceSid, "VERIFIED");
    await H.call(OPERATOR, "POST", msg("/a2p/refresh"));
  });

  describe("the client's sign-up link", () => {
    it("is the client admin's to share, and the operator's to see", async () => {
      expect((await H.call(user("a"), "GET", "/api/texting/signup-link")).status).toBe(403);
      const mine = await H.call(admin("a"), "GET", "/api/texting/signup-link");
      expect(mine.status).toBe(200);
      const url = j(mine.json).url as string;
      expect(url.startsWith(`${ORIGIN}/texts/`)).toBe(true);
      // The same link until a new one is made.
      expect(j((await H.call(admin("a"), "GET", "/api/texting/signup-link")).json).url).toBe(url);
      const ops = await H.call(OPERATOR, "GET", `/api/ops/clients/${A()}/texting/signup-link`);
      expect(j(ops.json).url).toBe(url);
    });

    it("shows the client's page with the exact words, and records a sign-up with its evidence", async () => {
      const url = j((await H.call(admin("a"), "GET", "/api/texting/signup-link")).json).url;
      const token = tokenIn(url);
      const page = await view(token);
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toBe("no-store");
      const terms = textSignupTerms("Client A");
      expect(j(page.json)).toEqual({
        client: "Client A",
        kind: "link",
        name: null,
        phone: null,
        number: "+15125550101",
        terms,
        wordingVersion: 1,
        state: "open",
      });
      for (const part of ["Msg frequency varies", "Msg & data rates may apply", "STOP", "HELP"]) {
        expect(terms).toContain(part);
      }

      // The box must be ticked, and the name given.
      const PHONE = "+15125550177";
      expect((await submit(token, { name: "Dana Kim", phone: PHONE, agree: false })).status).toBe(
        400,
      );
      expect((await submit(token, { phone: PHONE })).status).toBe(422);
      // US and Canadian numbers only on a client's link.
      expect((await submit(token, { name: "Dana Kim", phone: "+442071838750" })).status).toBe(422);
      // Words from another version of the page.
      expect(
        (await submit(token, { name: "Dana Kim", phone: PHONE, wordingVersion: 0 })).status,
      ).toBe(409);

      const done = await H.call(
        null,
        "POST",
        `/api/text-signup/${token}`,
        { name: "Dana Kim", phone: "(512) 555-0177", agree: true, wordingVersion: 1 },
        { "user-agent": "TestBrowser/1.0", "cf-connecting-ip": "203.0.113.9" },
      );
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      expect(j(done.json)).toEqual({ confirmation: "sent" });

      const [row] = await H.t.db
        .select()
        .from(contact)
        .where(and(eq(contact.tenantId, A()), eq(contact.phone, PHONE)));
      expect(row?.name).toBe("Dana Kim");
      expect(row?.consent).toMatchObject({
        sms: { basis: "express", source: "signed up on the texting page" },
      });
      const optIn = (await logOf(row?.id as string)).find(
        (l) => (l.change as { kind?: string }).kind === "opt_in",
      );
      expect(optIn?.actorId).toBeNull();
      expect(optIn?.change).toMatchObject({
        by: "contact",
        channel: "sms",
        basis: "express",
        via: "link",
        wording: terms,
        wordingVersion: 1,
        phone: PHONE,
        userAgent: "TestBrowser/1.0",
      });

      // The confirmation, from the client's number, in the registered words.
      const sent = await textsTo(PHONE);
      expect(sent.map((m) => m.body)).toEqual([a2pKeywordsOf("Client A").optInMessage]);
      expect(sent[0]?.from).toBe("+15125550101");

      // The person can now be texted; a second sign-up with the same number finds them.
      const list = j((await H.call(admin("a"), "GET", "/api/contacts")).json).items;
      expect(list.find((c: { id: string }) => c.id === row?.id).canMessage.sms).toBe(true);
      expect((await submit(token, { name: "Dana K.", phone: PHONE })).status).toBe(200);
      const same = await H.t.db
        .select()
        .from(contact)
        .where(and(eq(contact.tenantId, A()), eq(contact.phone, PHONE)));
      expect(same).toHaveLength(1);
    });

    it("stops working when the admin makes a new one", async () => {
      const old = tokenIn(
        j((await H.call(admin("a"), "GET", "/api/texting/signup-link")).json).url,
      );
      expect((await H.call(user("a"), "POST", "/api/texting/signup-link")).status).toBe(403);
      const fresh = await H.call(admin("a"), "POST", "/api/texting/signup-link");
      const token = tokenIn(j(fresh.json).url);
      expect(token).not.toBe(old);
      expect((await view(old)).status).toBe(404);
      expect((await submit(old, { name: "Late", phone: "+15125550178" })).status).toBe(404);
      expect((await view(token)).status).toBe(200);
    });

    it("refuses a forged or altered link, and never shows another client", async () => {
      expect((await view("not-a-token")).status).toBe(404);
      const good = tokenIn(
        j((await H.call(admin("a"), "GET", "/api/texting/signup-link")).json).url,
      );
      const [body, sig] = good.split(".");
      const forged = `${Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(body as string, "base64url").toString()),
          t: B(),
        }),
      ).toString("base64url")}.${sig}`;
      expect((await view(forged)).status).toBe(404);
      // A link signed for client B with A's key is no link for B.
      const signed = await signTextSignup(H.env, { k: "l", t: B(), n: "x".repeat(22) });
      expect((await view(signed)).status).toBe(404);
    });

    it("texts a number that signed up once, and answers a repeat the same way", async () => {
      const token = tokenIn(
        j((await H.call(admin("a"), "GET", "/api/texting/signup-link")).json).url,
      );
      const PHONE = "+15125550191";
      for (let i = 0; i < 4; i++) {
        const res = await submit(token, { name: "Repeat Person", phone: PHONE });
        expect(res.status).toBe(200);
        expect(j(res.json)).toEqual({ confirmation: "sent" });
      }
      expect(await textsTo(PHONE)).toHaveLength(1);
      const [row] = await H.t.db
        .select()
        .from(contact)
        .where(and(eq(contact.tenantId, A()), eq(contact.phone, PHONE)));
      const kinds = (await logOf(row?.id as string)).map(
        (l) => (l.change as { kind: string }).kind,
      );
      // One sign-up; each repeat is only counted toward the link's hourly limit.
      expect(kinds.filter((k) => k === "opt_in")).toHaveLength(1);
      expect(kinds.filter((k) => k === "text_signup_skipped")).toHaveLength(3);
    });

    it("never lifts an opt-out, and answers as a sign-up does: only a START from that number lifts it", async () => {
      const token = tokenIn(
        j((await H.call(admin("a"), "GET", "/api/texting/signup-link")).json).url,
      );
      // The page tells everyone how to start texts again.
      expect(j((await view(token)).json).number).toBe("+15125550101");
      const PHONE = "+15125550187";
      const OUT = await newContact(admin("a"), { name: "Opted Out", phone: PHONE });
      await H.call(admin("a"), "POST", `/api/contacts/${OUT}/consent`, { action: "opt_out" });
      const res = await submit(token, { name: "Someone", phone: PHONE });
      // The same answer as a sign-up: the link doesn't say who opted out.
      expect(res.status).toBe(200);
      expect(j(res.json)).toEqual({ confirmation: "sent" });
      const [row] = await H.t.db.select().from(contact).where(eq(contact.id, OUT));
      expect(row?.optedOutAt).not.toBeNull();
      expect(row?.consent ?? {}).not.toHaveProperty("sms");
      expect(row?.name).toBe("Opted Out");
      expect(await textsTo(PHONE)).toHaveLength(0);
      // Counted toward the link's hourly limit, and nothing else.
      const changes = (await logOf(OUT)).map((l) => l.change as Record<string, unknown>);
      expect(changes.at(-1)).toEqual({
        kind: "text_signup_skipped",
        via: "link",
        reason: "opted_out",
      });
      expect(changes.some((c) => c.kind === "opt_in")).toBe(false);
    });

    it("treats a number that opted out on WhatsApp as opted out", async () => {
      const token = tokenIn(
        j((await H.call(admin("a"), "GET", "/api/texting/signup-link")).json).url,
      );
      const NUM = "+15125550166";
      const [wa] = await H.t.db
        .insert(contact)
        .values({
          tenantId: A(),
          name: "WhatsApp Person",
          whatsapp: NUM,
          optedOutAt: new Date(),
          optOutSource: "keyword:STOP",
        })
        .returning();
      const res = await submit(token, { name: "Someone Else", phone: NUM });
      expect(res.status).toBe(200);
      expect(j(res.json)).toEqual({ confirmation: "sent" });
      expect(await textsTo(NUM)).toHaveLength(0);
      const same = await H.t.db
        .select()
        .from(contact)
        .where(and(eq(contact.tenantId, A()), eq(contact.phone, NUM)));
      expect(same).toEqual([]);
      const changes = (await logOf(wa?.id as string)).map((l) => l.change);
      expect(changes).toEqual([{ kind: "text_signup_skipped", via: "link", reason: "opted_out" }]);
    });

    it("answers before the confirmation goes, and the same when it fails", async () => {
      const token = tokenIn(
        j((await H.call(admin("a"), "GET", "/api/texting/signup-link")).json).url,
      );
      let release = () => {};
      sending.hold = new Promise<void>((r) => {
        release = r;
      });
      const HELD = "+15125550192";
      const res = await Promise.race([
        submit(token, { name: "Held Text", phone: HELD }),
        new Promise<null>((r) => setTimeout(() => r(null), 3000)),
      ]);
      release();
      sending.hold = null;
      expect(res?.status).toBe(200);
      expect(j(res?.json)).toEqual({ confirmation: "sent" });
      await H.settle();
      expect(await textsTo(HELD)).toHaveLength(1);

      // A confirmation that fails to send answers the same.
      sending.fail = true;
      const FAILS = "+15125550193";
      const failed = await submit(token, { name: "Failed Text", phone: FAILS });
      await H.settle();
      sending.fail = false;
      expect(failed.status).toBe(200);
      expect(j(failed.json)).toEqual({ confirmation: "sent" });
      expect(await textsTo(FAILS)).toHaveLength(0);
    });

    it("holds the hourly limit when many submit at once", async () => {
      const token = tokenIn(
        j((await H.call(admin("a"), "GET", "/api/texting/signup-link")).json).url,
      );
      // Three left in this hour.
      const counted = () =>
        H.t.db
          .select({ n: sql<number>`count(*)::int` })
          .from(contactChange)
          .where(
            and(
              eq(contactChange.tenantId, A()),
              gt(contactChange.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
              sql`${contactChange.change}->>'via' = 'link'`,
              inArray(sql`${contactChange.change}->>'kind'`, ["opt_in", "text_signup_skipped"]),
            ),
          )
          .then((r) => r[0]?.n ?? 0);
      const [anyone] = await H.t.db
        .select()
        .from(contact)
        .where(eq(contact.tenantId, A()))
        .limit(1);
      const fill = TEXT_SIGNUP_LINK_HOURLY_MAX - 3 - (await counted());
      expect(fill).toBeGreaterThan(0);
      await H.t.db.insert(contactChange).values(
        Array.from({ length: fill }, () => ({
          tenantId: A(),
          contactId: anyone?.id as string,
          actorId: null,
          change: { kind: "opt_in", via: "link" },
        })),
      );
      const numbers = Array.from({ length: 12 }, (_, i) => `+1512556${String(i).padStart(4, "0")}`);
      const res = await Promise.all(
        numbers.map((phone) => submit(token, { name: "Burst", phone })),
      );
      expect(res.filter((r) => r.status === 200)).toHaveLength(3);
      expect(res.filter((r) => r.status === 429)).toHaveLength(9);
      let texts = 0;
      for (const n of numbers) texts += (await textsTo(n)).length;
      expect(texts).toBe(3);
    });

    it("waits after too many sign-ups in an hour", async () => {
      const token = tokenIn(
        j((await H.call(admin("a"), "GET", "/api/texting/signup-link")).json).url,
      );
      // Twenty in the last hour already.
      const [anyone] = await H.t.db
        .select()
        .from(contact)
        .where(eq(contact.tenantId, A()))
        .limit(1);
      await H.t.db.insert(contactChange).values(
        Array.from({ length: 20 }, () => ({
          tenantId: A(),
          contactId: anyone?.id as string,
          actorId: null,
          change: { kind: "opt_in", via: "link" },
        })),
      );
      expect((await submit(token, { name: "Busy", phone: "+15125550179" })).status).toBe(429);
      // (contact_change is append-only: these rows stay, and no later test signs up by link.)
    });
  });

  describe("invitations", () => {
    it("emails an invitation in the client's name, once, and the person signs up from it", async () => {
      const PAT = await newContact(admin("a"), {
        name: "Pat Rivera",
        email: "pat@vendor.example",
        phone: "+15125550180",
      });
      const NOMAIL = await newContact(admin("a"), { name: "No Mail", phone: "+15125550181" });
      const theirs = await newContact(admin("b"), { name: "B's", email: "b@vendor.example" });

      expect((await invite(user("a"), [PAT])).status).toBe(403);
      const res = await invite(admin("a"), [PAT, NOMAIL, theirs]);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(j(res.json)).toEqual({
        sent: [{ id: PAT, reminder: false }],
        skipped: [
          { id: NOMAIL, reason: "no_email" },
          { id: theirs, reason: "not_found" },
        ],
      });
      const mail = lastEmailTo("pat@vendor.example");
      expect(mail?.from).toBe('"Client A via Mezonas" <notify@mail.mezonas.test>');
      expect(mail?.subject).toBe("Client A would like to text you");
      expect(mail?.text).toContain("Texting is your choice. Email keeps working either way.");
      expect(mail?.text).toContain("Msg frequency varies. Msg & data rates may apply.");
      expect(mail?.html).toContain("Choose to get texts");
      const link = /Choose to get texts: (\S+)/.exec(mail?.text ?? "")?.[1] as string;
      expect(link.startsWith(`${ORIGIN}/texts/`)).toBe(true);
      expect(mail?.text).toContain(`Don't ask me again: ${link}?decline=1`);

      // Not again so soon.
      expect(j((await invite(admin("a"), [PAT])).json).skipped).toEqual([
        { id: PAT, reason: "too_soon" },
      ]);

      const token = tokenIn(link);
      expect(j((await view(token)).json)).toMatchObject({
        client: "Client A",
        kind: "invitation",
        name: "Pat Rivera",
        phone: "+15125550180",
        state: "open",
      });
      // Pat gives a different mobile number: it becomes Pat's.
      const done = await submit(token, { phone: "+15125550182" });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      const [row] = await H.t.db.select().from(contact).where(eq(contact.id, PAT));
      expect(row?.phone).toBe("+15125550182");
      expect(row?.consent).toMatchObject({
        sms: { basis: "express", source: "accepted the texting invitation" },
      });
      expect(await textsTo("+15125550182")).toHaveLength(1);
      expect(j((await view(token)).json).state).toBe("signed_up");
      expect(j((await invite(admin("a"), [PAT])).json).skipped).toEqual([
        { id: PAT, reason: "signed_up" },
      ]);
      const kinds = (await logOf(PAT)).map((l) => (l.change as { kind: string }).kind);
      expect(kinds).toEqual(expect.arrayContaining(["text_invite", "edited", "opt_in"]));
    });

    it("takes US and Canadian numbers only, and signs up once per invitation", async () => {
      const SAM = await newContact(admin("a"), { name: "Sam Diaz", email: "sam@vendor.example" });
      expect(j((await invite(admin("a"), [SAM])).json).sent).toEqual([
        { id: SAM, reminder: false },
      ]);
      const link = /Choose to get texts: (\S+)/.exec(
        lastEmailTo("sam@vendor.example")?.text ?? "",
      )?.[1];
      const token = tokenIn(link as string);
      // The same number rules as the client's link.
      const abroad = await submit(token, { phone: "+442071838750" });
      expect(abroad.status).toBe(422);
      expect(j(abroad.json).error.code).toBe("invalid_phone");
      expect(await textsTo("+442071838750")).toHaveLength(0);

      // Two presses at once: one sign-up and one text.
      const both = await Promise.all([
        submit(token, { phone: "+15125550184" }),
        submit(token, { phone: "+15125550185" }),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await textsTo("+15125550184")).length + (await textsTo("+15125550185")).length).toBe(
        1,
      );

      // Used: the link signs up no one else and sends nothing more.
      const again = await submit(token, { phone: "+15125550186" });
      expect(again.status).toBe(409);
      expect(j(again.json).error.code).toBe("used");
      expect(await textsTo("+15125550186")).toHaveLength(0);
      const optIns = (await logOf(SAM)).filter(
        (l) => (l.change as { kind: string }).kind === "opt_in",
      );
      expect(optIns).toHaveLength(1);
    });

    it("never lifts an opt-out made after the invitation", async () => {
      const PHONE = "+15125550188";
      const ROB = await newContact(admin("a"), {
        name: "Rob Lane",
        email: "rob@vendor.example",
        phone: PHONE,
      });
      await invite(admin("a"), [ROB]);
      const link = /Choose to get texts: (\S+)/.exec(
        lastEmailTo("rob@vendor.example")?.text ?? "",
      )?.[1];
      await H.call(admin("a"), "POST", `/api/contacts/${ROB}/consent`, { action: "opt_out" });
      for (const phone of [PHONE, "+15125550189"]) {
        const res = await submit(tokenIn(link as string), { phone });
        expect(res.status, phone).toBe(409);
        expect(j(res.json).error.code).toBe("opted_out");
        expect(await textsTo(phone)).toHaveLength(0);
      }
      const [row] = await H.t.db.select().from(contact).where(eq(contact.id, ROB));
      expect(row?.optedOutAt).not.toBeNull();
      expect(row?.phone).toBe(PHONE);
    });

    it("answers another contact's opted-out number as a sign-up, and that uses the invitation", async () => {
      const NUM = "+15125550167";
      await H.t.db.insert(contact).values({
        tenantId: A(),
        name: "WhatsApp Only",
        whatsapp: NUM,
        optedOutAt: new Date(),
        optOutSource: "keyword:STOP",
      });
      const KAI = await newContact(admin("a"), { name: "Kai Moss", email: "kai@vendor.example" });
      await invite(admin("a"), [KAI]);
      const link = /Choose to get texts: (\S+)/.exec(
        lastEmailTo("kai@vendor.example")?.text ?? "",
      )?.[1];
      const token = tokenIn(link as string);
      // The same answer as a sign-up: the invitation doesn't say who opted out.
      const res = await submit(token, { phone: NUM });
      expect(res.status).toBe(200);
      expect(j(res.json)).toEqual({ confirmation: "sent" });
      expect(await textsTo(NUM)).toHaveLength(0);
      const [row] = await H.t.db.select().from(contact).where(eq(contact.id, KAI));
      expect(row?.phone).toBeNull();
      expect(row?.consent ?? {}).not.toHaveProperty("sms");
      // It used the invitation: no more answers from it, whatever number is typed.
      for (const phone of [NUM, "+15125550168"]) {
        const again = await submit(token, { phone });
        expect(again.status, phone).toBe(409);
        expect(j(again.json).error.code).toBe("used");
      }
      expect(await textsTo("+15125550168")).toHaveLength(0);
    });

    it("sends one reminder after three days, then no more", async () => {
      const LEE = await newContact(admin("a"), { name: "Lee Park", email: "lee@vendor.example" });
      expect(j((await invite(admin("a"), [LEE])).json).sent).toEqual([
        { id: LEE, reminder: false },
      ]);
      // The log is append-only, so the clock moves instead: four days, then eight.
      const later = (days: number) =>
        withTenant(H.db, A(), (tx) =>
          sendTextInvitations(
            {
              tx,
              env: H.env,
              origin: ORIGIN,
              tenantId: A(),
              actorId: null,
              via: "portal",
              mailer: mailerFromEnv(H.env, fetch),
              now: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
            },
            [LEE],
          ),
        );
      expect((await later(4)).sent).toEqual([{ id: LEE, reminder: true }]);
      expect(lastEmailTo("lee@vendor.example")?.subject).toBe(
        "Reminder: Client A would like to text you",
      );
      expect((await later(8)).skipped).toEqual([{ id: LEE, reason: "asked_twice" }]);
    });

    it("takes no for an answer, and asks no one who opted out", async () => {
      const KIM = await newContact(admin("a"), {
        name: "Kim Ortiz",
        email: "kim@vendor.example",
        phone: "+15125550183",
      });
      await invite(admin("a"), [KIM]);
      const link = /Choose to get texts: (\S+)/.exec(
        lastEmailTo("kim@vendor.example")?.text ?? "",
      )?.[1];
      const token = tokenIn(link as string);
      const no = await H.call(null, "POST", `/api/text-signup/${token}/decline`);
      expect(no.status).toBe(200);
      expect((await H.call(null, "POST", `/api/text-signup/${token}/decline`)).status).toBe(200);
      expect(j((await view(token)).json).state).toBe("declined");
      expect(j((await invite(admin("a"), [KIM])).json).skipped).toEqual([
        { id: KIM, reason: "declined" },
      ]);
      expect(
        (await logOf(KIM)).filter(
          (l) => (l.change as { kind: string }).kind === "text_invite_declined",
        ),
      ).toHaveLength(1);
      // The client's link can't be declined: it names no one.
      const shared = tokenIn(
        j((await H.call(admin("a"), "GET", "/api/texting/signup-link")).json).url,
      );
      expect((await H.call(null, "POST", `/api/text-signup/${shared}/decline`)).status).toBe(404);

      // Someone who said STOP isn't invited.
      const ROY = await newContact(admin("a"), { name: "Roy", email: "roy@vendor.example" });
      await H.call(admin("a"), "POST", `/api/contacts/${ROY}/consent`, { action: "opt_out" });
      expect(j((await invite(admin("a"), [ROY])).json).skipped).toEqual([
        { id: ROY, reason: "opted_out" },
      ]);
    });

    it("expires, and the operator invites for a client it serves", async () => {
      const MO = await newContact(admin("a"), { name: "Mo", email: "mo@vendor.example" });
      const expired = await signTextSignup(H.env, {
        k: "i",
        t: A(),
        c: MO,
        e: Math.floor(Date.now() / 1000) - 60,
      });
      expect((await view(expired)).status).toBe(404);
      const ops = await H.call(
        OPERATOR,
        "POST",
        `/api/ops/clients/${A()}/contacts/text-invitations`,
        {
          contactIds: [MO],
        },
      );
      expect(ops.status, JSON.stringify(ops.json)).toBe(200);
      expect(j(ops.json).sent).toEqual([{ id: MO, reminder: false }]);
      const [sentLog] = (await logOf(MO)).filter(
        (l) => (l.change as { kind: string }).kind === "text_invite",
      );
      expect(sentLog?.change).toMatchObject({ via: "ops", n: 1 });
    });
  });

  it("refuses invitations for a client in HIPAA mode until Resend's BAA is signed", async () => {
    const id = await newContact(admin("b"), { name: "Hipaa", email: "h@vendor.example" });
    const [t] = await H.t.db.select().from(tenant).where(eq(tenant.id, B()));
    await H.t.db
      .update(tenant)
      .set({ settings: { ...(t?.settings ?? {}), compliance: { hipaa: true } } })
      .where(eq(tenant.id, B()));
    const res = await invite(admin("b"), [id]);
    expect(res.status).toBe(409);
    expect(j(res.json).error.code).toBe("hipaa");
    await H.t.db
      .update(tenant)
      .set({ settings: t?.settings ?? {} })
      .where(eq(tenant.id, B()));
  });

  it("calls and email stay on the relationship basis, texts don't (§1.98)", async () => {
    const res = await H.call(admin("a"), "POST", "/api/contacts", {
      name: "Rel Basis",
      phone: "+15125550190",
      email: "rel@vendor.example",
      consent: { basis: "relationship", source: "number on their invoices" },
    });
    const c = j(res.json).contact;
    expect(c).toMatchObject({ canMessage: { sms: false }, canCall: true, canEmail: true });
  });
});
