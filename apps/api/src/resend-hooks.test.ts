// Resend's webhook (docs/plan.md §1.220, C7): an onboarding email carries its client and outbox
// row as Resend tags; a signed `email.delivered` or `email.bounced` about it is logged on the intake
// once, and a bounce leaves the lead a to-do to send it again. Unsigned, stale or foreign deliveries
// are refused before anything is read; events about anything else (another row, another client, an
// email that isn't an onboarding one, a kind we don't act on) are acknowledged and change nothing.

import { resendWebhookHeaders } from "@countersign/connectors";
import { FAKE_RESEND_MAIN, fakeResend } from "@countersign/connectors/testing";
import { intake, intakeEvent, intakePerson, notification, todo, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness } from "./api.test-helper";
import { type Mailer, type MailMessage, resendMailer } from "./notify/mailer";
import type { NotifyDeps } from "./notify/outbox";
import { sendNow } from "./notify/tick";
import { sendOnboardingEmail } from "./onboarding/emails";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const KEY = "resend-hooks-test-key-0123456789ab";
const ORIGIN = "https://app.mezonas.test";
const SECRET = `whsec_${Buffer.from("resend hooks test signing key 32b").toString("base64")}`;
const FOREIGN = `whsec_${Buffer.from("not our endpoint's signing key!!").toString("base64")}`;
const PATH = "/api/hooks/resend";

const h = await createApiHarness({
  env: {
    ENCRYPTION_KEY: KEY,
    APP_ORIGIN: ORIGIN,
    RESEND_API_KEY: "re_test",
    RESEND_FALLBACK_DOMAIN: "mezonas.test",
    RESEND_WEBHOOK_SECRET: SECRET,
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
      return `re_hook_${sent.length}`;
    },
  };
}

const deps = (mailer: Mailer): NotifyDeps => ({
  mailer,
  texter: {
    from: async () => null,
    send: async () => {
      throw new Error("no texts here");
    },
  },
  origin: ORIGIN,
  links: { ENCRYPTION_KEY: KEY, ENVIRONMENT: "development" },
});

let n = 0;
async function post(
  H: ApiHarness,
  body: unknown,
  opts: { secret?: string; at?: number; env?: Record<string, unknown> } = {},
) {
  const payload = JSON.stringify(body);
  const headers = await resendWebhookHeaders(opts.secret ?? SECRET, payload, {
    id: `msg_${++n}`,
    timestamp: opts.at ?? Math.floor(Date.now() / 1000),
  });
  const res = await H.app.request(
    PATH,
    { method: "POST", body: payload, headers: { "content-type": "application/json", ...headers } },
    { ...H.env, ...opts.env },
  );
  return { status: res.status, body: j(await res.json()) };
}

describe.skipIf(!h)("Resend's webhook (§1.220)", () => {
  const H = h as ApiHarness;
  let intakeId: string;
  let dana: string;
  let notificationId: string;
  let emailId: string;
  let tags: Record<string, string>;

  const event = (type: string, over: Record<string, unknown> = {}) => ({
    type,
    created_at: new Date().toISOString(),
    data: { email_id: emailId, to: ["dana@a.example.com"], tags, ...over },
  });

  const events = async (kind: string) =>
    (
      await H.t.db
        .select()
        .from(intakeEvent)
        .where(and(eq(intakeEvent.personId, dana), eq(intakeEvent.tenantId, H.A.tenantId)))
    ).filter((e) => e.kind === kind);

  beforeAll(async () => {
    const [it] = await H.t.db
      .insert(intake)
      .values({
        tenantId: H.A.tenantId,
        covers: { general: true, areas: [], templateIds: [] },
        guide: {
          version: 1,
          sections: [],
          totals: { known: 0, toConfirm: 0, toAsk: 1, later: 0, tools: 0, minutes: 5 },
        },
        leadUserId: H.operator,
      })
      .returning();
    intakeId = (it as typeof intake.$inferSelect).id;
    const [p] = await H.t.db
      .insert(intakePerson)
      .values({ tenantId: H.A.tenantId, intakeId, email: "dana@a.example.com", name: "Dana Ruiz" })
      .returning();
    dana = (p as typeof intakePerson.$inferSelect).id;
    const queued = await withTenant(H.db, H.A.tenantId, (tx) =>
      sendOnboardingEmail(
        { tx, env: H.env },
        { kind: "invite", tenantId: H.A.tenantId, intakeId, personId: dana },
      ),
    );
    notificationId = queued.notificationId as string;
    const mailer = fakeMailer();
    await sendNow(H.db, deps(mailer), H.A.tenantId, new Date());
    const mail = mailer.sent.find((m) => m.to === "dana@a.example.com");
    tags = mail?.tags ?? {};
    emailId = "re_hook_1";
  });

  it("tags an onboarding email with its client and outbox row, and Resend gets them", async () => {
    expect(tags).toEqual({ mz_tenant: H.A.tenantId, mz_notification: notificationId });
    const fake = fakeResend();
    await resendMailer({
      apiKey: FAKE_RESEND_MAIN.apiKey,
      domain: "mezonas.test",
      fetch: fake.fetch,
    }).send({ to: "x@example.com", subject: "s", text: "t", idempotencyKey: "k", tags });
    expect(fake.emails[0]?.tags).toEqual([
      { name: "mz_tenant", value: H.A.tenantId },
      { name: "mz_notification", value: notificationId },
    ]);
  });

  it("refuses an unsigned, foreign-signed or stale delivery, and answers 503 without a secret", async () => {
    const res = await H.app.request(
      PATH,
      { method: "POST", body: JSON.stringify(event("email.delivered")) },
      H.env,
    );
    expect(res.status).toBe(400);
    expect((await post(H, event("email.delivered"), { secret: FOREIGN })).status).toBe(400);
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect((await post(H, event("email.delivered"), { at: stale })).status).toBe(400);
    const off = await post(H, event("email.delivered"), {
      env: { RESEND_WEBHOOK_SECRET: undefined },
    });
    expect(off.status).toBe(503);
    expect(await events("delivered")).toHaveLength(0);
  });

  it("logs delivered on the intake once", async () => {
    const first = await post(H, event("email.delivered"));
    expect(first).toEqual({
      status: 200,
      body: { received: true, handled: true, duplicate: false },
    });
    const again = await post(H, event("email.delivered"));
    expect(again.body).toEqual({ received: true, handled: true, duplicate: true });
    expect((await events("delivered")).map((e) => e.meta)).toEqual([
      { email: "invite", notificationId },
    ]);
  });

  it("logs a bounce once and leaves the lead a to-do to send it again", async () => {
    const res = await post(
      H,
      event("email.bounced", {
        bounce: { type: "Permanent", subType: "General", message: "550 no such user dana" },
      }),
    );
    expect(res.body).toEqual({ received: true, handled: true, duplicate: false });
    await post(H, event("email.bounced"));
    expect((await events("bounced")).map((e) => e.meta)).toEqual([
      { email: "invite", notificationId, bounceType: "Permanent", bounceSubType: "General" },
    ]);
    const todos = await H.t.db
      .select()
      .from(todo)
      .where(eq(todo.dedupeKey, `intake-unsent:${notificationId}`));
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({
      title: "The invite to Dana Ruiz at Client A didn't go out",
      ownerUserId: H.operator,
      clientId: H.A.tenantId,
    });
    expect(todos[0]?.why).toContain("bounced");
  });

  it("acknowledges and drops events about anything else", async () => {
    const dropped = { received: true, handled: false, duplicate: false };
    // A kind we don't act on.
    expect((await post(H, event("email.opened"))).body).toEqual(dropped);
    // No tags (an agent's email, a setup nudge).
    expect((await post(H, event("email.delivered", { tags: undefined }))).body).toEqual(dropped);
    // Another email than the one Resend sent for this row.
    expect((await post(H, event("email.delivered", { email_id: "re_other" }))).body).toEqual(
      dropped,
    );
    // The row named under another client: that client has no such row.
    const crossed = { ...tags, mz_tenant: H.B.tenantId };
    expect((await post(H, event("email.delivered", { tags: crossed }))).body).toEqual(dropped);
    // A tag that isn't an id.
    const junk = { ...tags, mz_notification: "not-an-id" };
    expect((await post(H, event("email.delivered", { tags: junk }))).body).toEqual(dropped);
    // An outbox row that isn't an onboarding email.
    const [other] = await H.t.db
      .insert(notification)
      .values({
        tenantId: H.A.tenantId,
        userId: H.A.admin,
        channel: "email",
        kind: "weekly_table",
        dedupeKey: `hooks-test:${crypto.randomUUID()}`,
        link: ORIGIN,
        counts: {},
        status: "sent",
        providerId: "re_weekly",
      })
      .returning({ id: notification.id });
    const weekly = { mz_tenant: H.A.tenantId, mz_notification: other?.id as string };
    expect(
      (await post(H, event("email.bounced", { email_id: "re_weekly", tags: weekly }))).body,
    ).toEqual(dropped);
    expect(await events("delivered")).toHaveLength(1);
  });
});
