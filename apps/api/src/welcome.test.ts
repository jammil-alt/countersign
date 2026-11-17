// Onboarding's emails and the welcome page (docs/plan.md §1.126; docs/cases-plan.md §4.4), stream
// EMAIL: the invite, a colleague asked and a few more questions queued in the caller's
// transaction and sent by the notification pass from `<Lead> at Mezonas <hello@…>` with Reply-To
// the lead, once per person (no Resend: skipped, and logged); an invite sent later waits. The
// welcome page opens from the signed link only, logs `opened` once, shows names and what's in it;
// after sign-in only the invited address goes on, any other is told whose invite it is (masked);
// an expired link asks the lead for a new one (a to-do), and the token never signs anyone in.

import { readFileSync } from "node:fs";
import { EMAIL_THEME } from "@countersign/core";
import {
  auditEvent,
  intake,
  intakeEvent,
  intakePerson,
  notification,
  tenant,
  todo,
  withTenant,
} from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, user } from "./api.test-helper";
import { type Mailer, type MailMessage, resendMailer } from "./notify/mailer";
import type { NotifyDeps } from "./notify/outbox";
import { sendNow } from "./notify/tick";
import { sendOnboardingEmail } from "./onboarding/emails";
import { signWelcomeLink } from "./onboarding/link";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const KEY = "welcome-test-key-0123456789abcdef";
const ORIGIN = "https://app.mezonas.test";
const GUIDE = {
  version: 1,
  sections: [],
  totals: { known: 2, toConfirm: 3, toAsk: 5, later: 0, tools: 1, minutes: 15 },
};

const h = await createApiHarness({
  env: {
    ENCRYPTION_KEY: KEY,
    APP_ORIGIN: ORIGIN,
    RESEND_API_KEY: "re_test",
    RESEND_FALLBACK_DOMAIN: "mezonas.test",
  },
});
afterAll(() => h?.close());

function fakeMailer(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    isConfigured: true,
    sent,
    async send(m) {
      sent.push(m);
      return `re_${sent.length}`;
    },
  };
}

const unusedTexter = {
  from: async () => null,
  send: async () => {
    throw new Error("no texts here");
  },
};

function depsWith(mailer: Mailer): NotifyDeps {
  return {
    mailer,
    texter: unusedTexter,
    origin: ORIGIN,
    links: { ENCRYPTION_KEY: KEY, ENVIRONMENT: "development" },
  };
}

describe.skipIf(!h)("onboarding emails and the welcome page (§1.126)", () => {
  const H = h as ApiHarness;
  let intakeId: string;
  /** The client admin, invited by their own address. */
  let dana: string;
  /** Someone with no account yet. */
  let mark: string;

  async function addIntake(over: Partial<typeof intake.$inferInsert> = {}) {
    const [row] = await H.t.db
      .insert(intake)
      .values({
        tenantId: H.A.tenantId,
        covers: { general: true, areas: ["purchasing"], templateIds: [crypto.randomUUID()] },
        guide: GUIDE,
        leadUserId: H.operator,
        leadNote: "Dana, good to talk today.\nThis is the short list we spoke about.",
        ...over,
      })
      .returning();
    return row as typeof intake.$inferSelect;
  }

  async function addPerson(intake: string, email: string, name: string, language?: string) {
    const [row] = await H.t.db
      .insert(intakePerson)
      .values({
        tenantId: H.A.tenantId,
        intakeId: intake,
        email,
        name,
        ...(language ? { language } : {}),
      })
      .returning();
    return (row as typeof intakePerson.$inferSelect).id;
  }

  async function token(person: string, opts: { intake?: string; expiresIn?: number } = {}) {
    return signWelcomeLink(
      { ENCRYPTION_KEY: KEY, ENVIRONMENT: "development" },
      {
        t: H.A.tenantId,
        i: opts.intake ?? intakeId,
        p: person,
        e: Math.floor(Date.now() / 1000) + (opts.expiresIn ?? 3600),
      },
    );
  }

  const events = async (person: string, kind?: string) =>
    (
      await H.t.db
        .select()
        .from(intakeEvent)
        .where(and(eq(intakeEvent.personId, person), eq(intakeEvent.tenantId, H.A.tenantId)))
    ).filter((e) => !kind || e.kind === kind);

  beforeAll(async () => {
    await H.t.db.update(tenant).set({ name: "Acme Supply" }).where(eq(tenant.id, H.A.tenantId));
    intakeId = (await addIntake()).id;
    dana = await addPerson(intakeId, admin("a"), "Dana Ruiz");
    mark = await addPerson(intakeId, "mark@a.example.com", "Mark Lee", "es");
  });

  it("uses the design system's colours (tokens.json) in the layout", () => {
    const tokens = JSON.parse(
      readFileSync(
        new URL("../../../packages/design-system/tokens.json", import.meta.url).pathname,
        "utf8",
      ),
    ) as { color: { tokens: { name: string; value: { light: string; dark: string } }[] } };
    for (const [name, value] of Object.entries(EMAIL_THEME)) {
      expect(tokens.color.tokens.find((t) => t.name === name)?.value, name).toEqual(value);
    }
    // The logo the layout links to is hosted with the app.
    expect(
      readFileSync(new URL("../../web/public/email/mezonas-icon.png", import.meta.url).pathname)
        .length,
    ).toBeGreaterThan(1000);
  });

  describe("the emails", () => {
    it("queues the invite once and sends it from the lead at hello@, Reply-To the lead", async () => {
      const queue = () =>
        withTenant(H.db, H.A.tenantId, (tx) =>
          sendOnboardingEmail(
            { tx, env: H.env },
            { kind: "invite", tenantId: H.A.tenantId, intakeId, personId: dana },
          ),
        );
      const first = await queue();
      expect(first.status).toBe("queued");
      expect(first.notificationId).toBeTruthy();
      expect((await queue()).notificationId).toBeNull();

      const mailer = fakeMailer();
      await sendNow(H.db, depsWith(mailer), H.A.tenantId, new Date());
      const mail = mailer.sent.find((m) => m.to === admin("a"));
      expect(mail).toBeDefined();
      expect(mail?.from).toEqual({ name: "Operator", localPart: "hello" });
      expect(mail?.replyTo).toBe("operator@example.com");
      expect(mail?.idempotencyKey).toBe(first.notificationId);
      expect(mail?.subject).toBe("Getting Acme Supply started with Mezonas");
      expect(mail?.text).toContain("> Dana, good to talk today.");
      expect(mail?.text).toContain("about 15 minutes");
      expect(mail?.text).toMatch(new RegExp(`Get started: ${ORIGIN}/start/[\\w-]+\\.[\\w-]+`));
      expect(mail?.html).toContain(`${ORIGIN}/email/mezonas-icon.png`);
      const [row] = await H.t.db
        .select()
        .from(notification)
        .where(eq(notification.id, first.notificationId as string));
      expect(row).toMatchObject({ status: "sent", kind: "intake_invite", providerId: "re_1" });
      expect((await events(dana, "sent")).map((e) => e.meta)).toEqual([
        { email: "invite", notificationId: first.notificationId, status: "sent" },
      ]);
      // A second pass sends nothing more.
      await sendNow(H.db, depsWith(mailer), H.A.tenantId, new Date());
      expect(mailer.sent.filter((m) => m.to === admin("a"))).toHaveLength(1);
    });

    it("sends the colleague's email in their language, naming who asked", async () => {
      await withTenant(H.db, H.A.tenantId, (tx) =>
        sendOnboardingEmail(
          { tx, env: H.env },
          {
            kind: "colleague",
            tenantId: H.A.tenantId,
            intakeId,
            personId: mark,
            askedByUserId: H.A.admin,
            about: ["Bills"],
          },
        ),
      );
      const mailer = fakeMailer();
      await sendNow(H.db, depsWith(mailer), H.A.tenantId, new Date());
      const mail = mailer.sent.find((m) => m.to === "mark@a.example.com");
      expect(mail?.subject).toBe(
        "Client A admin le pidió ayuda para configurar Acme Supply en Mezonas",
      );
      expect(mail?.text).toContain("Hola, Mark:");
      expect(mail?.text).toContain("Bills");
      expect((await events(mark, "colleague_invited"))[0]?.meta).toEqual({
        askedByUserId: H.A.admin,
        about: ["Bills"],
      });
    });

    it("sends a few more questions once per set of cards", async () => {
      const queue = (added: string[]) =>
        withTenant(H.db, H.A.tenantId, (tx) =>
          sendOnboardingEmail(
            { tx, env: H.env },
            { kind: "more_questions", tenantId: H.A.tenantId, intakeId, personId: dana, added },
          ),
        );
      const a = await queue(["Vendor contracts and invoice review"]);
      const b = await queue(["Bookkeeper"]);
      expect(a.notificationId).not.toBe(b.notificationId);
      const mailer = fakeMailer();
      await sendNow(H.db, depsWith(mailer), H.A.tenantId, new Date());
      const subjects = mailer.sent.filter((m) => m.to === admin("a")).map((m) => m.text);
      expect(subjects.some((t) => t.includes("Vendor contracts and invoice review"))).toBe(true);
      expect(subjects.some((t) => t.includes("Bookkeeper"))).toBe(true);
    });

    it("holds an invite sent later until its time", async () => {
      const later = await addIntake({ sendAt: new Date(Date.now() + 60 * 60 * 1000) });
      const ana = await addPerson(later.id, "ana@a.example.com", "Ana");
      const queued = await withTenant(H.db, H.A.tenantId, (tx) =>
        sendOnboardingEmail(
          { tx, env: H.env },
          { kind: "invite", tenantId: H.A.tenantId, intakeId: later.id, personId: ana },
        ),
      );
      expect(queued.status).toBe("scheduled");
      const mailer = fakeMailer();
      await sendNow(H.db, depsWith(mailer), H.A.tenantId, new Date());
      expect(mailer.sent.find((m) => m.to === "ana@a.example.com")).toBeUndefined();
      await sendNow(H.db, depsWith(mailer), H.A.tenantId, new Date(Date.now() + 2 * 3600_000));
      expect(mailer.sent.find((m) => m.to === "ana@a.example.com")).toBeDefined();
      expect((await events(ana)).map((e) => e.kind).sort()).toEqual(["scheduled", "sent"]);
    });

    it("writes the email skipped, and says so on the intake, without Resend", async () => {
      const other = await addIntake();
      const lee = await addPerson(other.id, "lee@a.example.com", "Lee");
      const out = await withTenant(H.db, H.A.tenantId, (tx) =>
        sendOnboardingEmail(
          { tx, env: { ...H.env, RESEND_API_KEY: "" } },
          { kind: "invite", tenantId: H.A.tenantId, intakeId: other.id, personId: lee },
        ),
      );
      expect(out.status).toBe("skipped");
      expect((await events(lee, "sent"))[0]?.meta).toMatchObject({
        status: "skipped",
        reason: "not_configured",
      });
    });

    it("sends from `<Lead> at Mezonas <hello@…>` through Resend", async () => {
      const bodies: Record<string, unknown>[] = [];
      const mailer = resendMailer({
        apiKey: "re_test",
        domain: "mezonas.test",
        fetch: async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            text: async () => JSON.stringify({ id: "re_1" }),
            json: async () => ({ id: "re_1" }),
          } as never;
        },
      });
      await mailer.send({
        to: "dana@acme.test",
        subject: "x",
        text: "x",
        idempotencyKey: "n1",
        from: { name: 'Jammil "J" <Ade>', localPart: "hello" },
        replyTo: "jammil@mezonas.test",
      });
      expect(bodies[0]).toMatchObject({
        from: '"Jammil J Ade at Mezonas" <hello@mezonas.test>',
        reply_to: "jammil@mezonas.test",
      });
    });
  });

  describe("the welcome page", () => {
    it("opens from the signed link only, with names and what's in it, and logs `opened` once", async () => {
      const t = await token(dana);
      const res = await H.call(null, "GET", `/api/start/${t}`);
      expect(res.status).toBe(200);
      expect(j(res.json)).toMatchObject({
        state: "open",
        client: "Acme Supply",
        lead: { name: "Operator", photoUrl: null },
        note: "Dana, good to talk today.\nThis is the short list we spoke about.",
        summary: { general: true, areas: ["purchasing"], agents: 1, minutes: 15 },
        email: admin("a"),
        language: "en",
      });
      await H.call(null, "GET", `/api/start/${t}`);
      expect(await events(dana, "opened")).toHaveLength(1);
      // Nothing of ours: no answers, no facts, no ids beyond the page's own.
      expect(JSON.stringify(res.json)).not.toMatch(/fact|guide|deal|file/i);
      // Its language is the person's.
      expect(j((await H.call(null, "GET", `/api/start/${await token(mark)}`)).json).language).toBe(
        "es",
      );
    });

    it("answers a forged or foreign link with not found", async () => {
      const t = await token(dana);
      const forged = `${t.split(".")[0]}.${"A".repeat(43)}`;
      expect((await H.call(null, "GET", `/api/start/${forged}`)).status).toBe(404);
      // A person of another intake under this intake's id.
      const other = await addIntake();
      const stranger = await addPerson(other.id, "s@a.example.com", "S");
      expect((await H.call(null, "GET", `/api/start/${await token(stranger)}`)).status).toBe(404);
    });

    it("shows an expired link the lead's name only", async () => {
      const t = await token(dana, { expiresIn: -60 });
      const res = await H.call(null, "GET", `/api/start/${t}`);
      expect(j(res.json)).toMatchObject({
        state: "expired",
        lead: { name: "Operator" },
        note: null,
        summary: null,
        email: null,
      });
    });

    it("never signs anyone in: the token alone opens no session", async () => {
      const t = await token(dana);
      const res = await H.call(null, "POST", `/api/start/${t}/signed-in`);
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect((await H.call(null, "GET", "/api/session")).status).toBe(401);
    });

    it("lets the invited address go on to Getting started, and logs `signed_in` once", async () => {
      const t = await token(dana);
      const res = await H.call(admin("a"), "POST", `/api/start/${t}/signed-in`);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ state: "ok", next: "/start" });
      await H.call(admin("a"), "POST", `/api/start/${t}/signed-in`);
      expect(await events(dana, "signed_in")).toHaveLength(1);
      const [p] = await H.t.db.select().from(intakePerson).where(eq(intakePerson.id, dana));
      expect(p?.userId).toBe(H.A.admin);
      const audit = await H.t.db
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.action, "intake.welcome_signed_in"));
      expect(audit.some((a) => a.actorUserId === H.A.admin && a.outcome === "ok")).toBe(true);
    });

    it("tells any other account whose invite it is, masked, and nothing more", async () => {
      const t = await token(dana);
      for (const who of [user("a"), admin("b"), "operator@example.com"]) {
        const res = await H.call(who, "POST", `/api/start/${t}/signed-in`);
        expect(res.status, who).toBe(200);
        expect(res.json, who).toEqual({
          state: "wrong_account",
          invitedEmail: "a•••@a.example.com",
        });
      }
      const wrong = await events(dana, "wrong_account");
      expect(wrong.length).toBeGreaterThanOrEqual(3);
      // Nothing of the other account is kept on the client's record.
      expect(JSON.stringify(wrong.map((e) => e.meta))).not.toContain("example.com");
    });

    it("lets an expired link ask the lead for a new one, once a day", async () => {
      const t = await token(dana, { expiresIn: -60 });
      for (let n = 0; n < 2; n++) {
        const res = await H.call(null, "POST", `/api/start/${t}/ask-new`);
        expect(res.status).toBe(200);
      }
      const todos = await H.t.db
        .select()
        .from(todo)
        .where(and(eq(todo.clientId, H.A.tenantId), eq(todo.ownerUserId, H.operator)));
      const mine = todos.filter(
        (x) => x.title === "Send Dana Ruiz at Acme Supply a new invite link",
      );
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ owner: "operator", source: "system", state: "open" });
      // A link that still works asks nothing.
      const open = await H.call(null, "POST", `/api/start/${await token(dana)}/ask-new`);
      expect(open.status).toBe(409);
      // After sign-in, an expired link goes nowhere either.
      const after = await H.call(admin("a"), "POST", `/api/start/${t}/signed-in`);
      expect(after.json).toEqual({ state: "expired" });
    });
  });
});
