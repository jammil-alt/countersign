// Notifications, the Table and the Weekly Table through the API (docs/plan.md §1.37, M14), against
// fake Resend and Twilio: one items-waiting email an hour per person (a second pass sends nothing),
// viewers get none for their role's items, quiet hours hold texts and items-waiting emails, a
// connection in error asks once a day (and the operator's reminder too), the Weekly Table drafts
// Friday 17:00, takes the lead's note and decisions (with sources of this client only), sends
// Monday 7:00 in two time zones, can't be edited once sent and downloads as a PDF that holds the
// stats; with no key rows are skipped; no message carries a record field; portal responses carry
// no bundle, prompt or cost.

import { inflateSync } from "node:zlib";
import { DEV_USER_HEADER } from "@countersign/auth";
import {
  createResendConnector,
  createTwilioConnector,
  type FetchLike,
  generateEncryptionKey,
  RESEND_API,
  TESTKIT_UPDATE_TOOL,
} from "@countersign/connectors";
import {
  FAKE_RESEND_MAIN,
  FAKE_TWILIO_MAIN,
  fakeResend,
  fakeTwilio,
} from "@countersign/connectors/testing";
import { addDays, uuidv7, weeklySchedule, weekStartOf } from "@countersign/core";
import {
  agent,
  connection,
  connectionChange,
  docExtraction,
  document,
  event,
  externalAction,
  inboxItem,
  membership,
  message,
  notification,
  run,
  stepRun,
  tenant,
  thread,
  weeklyTable,
} from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { notifyDepsFromEnv, notifyPass, notifyTick } from "./notify/tick";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ORIGIN = "https://app.mezonas.test";
const ADMIN_PHONE = "+15555550142";
const twilio = fakeTwilio();
const resend = fakeResend();
/** Every body sent to Resend (the fake keeps no HTML part). */
const resendBodies: Record<string, unknown>[] = [];
const fetch: FetchLike = (url, init) => {
  if (url.startsWith(RESEND_API)) {
    if (init?.body && url.endsWith("/emails")) resendBodies.push(JSON.parse(init.body));
    return resend.fetch(url, init);
  }
  return twilio.fetch(url, init);
};

// Record fields that must never reach a notification.
const VENDOR = "Acme Lumber Supply";
const AMOUNT = "1,234.56";
const SUBJECT = "Invoice 4471 for walnut veneer";
const NOTE = "Your margins on veneer improved this week";

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

/** A Monday two weeks out: every test's clock is after the clients were made. */
const W = addDays(weekStartOf(new Date(), "UTC"), 14);
const at = (day: number, hhmm: string) => new Date(`${addDays(W, day)}T${hhmm}:00Z`);

/** All visible text of a PDF: its content streams inflated, `<hex> Tj` and `(text) Tj` decoded. */
function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    let body = m[1] ?? "";
    try {
      body = inflateSync(Buffer.from(body, "latin1")).toString("latin1");
    } catch {
      // not compressed
    }
    for (const t of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      out.push(Buffer.from(t[1] ?? "", "hex").toString("latin1"));
    }
    for (const t of body.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(t[1] ?? "");
  }
  return out.join("\n");
}

describe.skipIf(!h)("notifications, the Table and the Weekly Table", () => {
  const H = h as ApiHarness;
  const deps = () => notifyDepsFromEnv(H.env, fetch);
  const pass = (tenantId: string, when: Date) => notifyPass(H.db, deps(), tenantId, when);

  const rows = (tenantId: string) =>
    H.t.db.select().from(notification).where(eq(notification.tenantId, tenantId));
  const emailsTo = (email: string) => resend.emails.filter((e) => e.to.includes(email));

  async function addItem(
    tenantId: string,
    input: { role?: "client_admin" | "client_user"; userId?: string; createdAt: Date },
  ) {
    const [row] = await H.t.db
      .insert(inboxItem)
      .values({
        tenantId,
        kind: "approval",
        title: `Approve ${SUBJECT} from ${VENDOR} for $${AMOUNT}`,
        payload: { vendor: VENDOR, amount: AMOUNT },
        ...(input.role ? { assigneeRole: input.role } : {}),
        ...(input.userId ? { assigneeUserId: input.userId } : {}),
        createdAt: input.createdAt,
      })
      .returning();
    return row?.id as string;
  }

  describe("items waiting", () => {
    it("one email an hour per person, only for new items; a second pass sends nothing", async () => {
      const B = H.B.tenantId;
      await addItem(B, { role: "client_admin", createdAt: at(0, "09:50") });
      await pass(B, at(0, "10:00"));
      const first = emailsTo(admin("b"));
      expect(first).toHaveLength(1);
      expect(first[0]?.subject).toBe("1 item waits for you in Mezonas");
      expect(first[0]?.from).toBe("Mezonas <notify@mail.mezonas.test>");
      expect(first[0]?.text).toContain(`${ORIGIN}/inbox`);
      // The client user has nothing assigned to them or their role.
      expect(emailsTo(user("b"))).toHaveLength(0);

      await pass(B, at(0, "10:05"));
      expect(emailsTo(admin("b"))).toHaveLength(1);
      // A new item inside the hour waits for the hour to pass.
      await addItem(B, { role: "client_admin", createdAt: at(0, "10:20") });
      await pass(B, at(0, "10:30"));
      expect(emailsTo(admin("b"))).toHaveLength(1);
      await pass(B, at(0, "11:05"));
      expect(emailsTo(admin("b"))).toHaveLength(2);
      expect(emailsTo(admin("b"))[1]?.subject).toBe("2 items wait for you in Mezonas");
      // Nothing new: nothing more, however long it waits.
      await pass(B, at(0, "13:05"));
      expect(emailsTo(admin("b"))).toHaveLength(2);
      const mine = (await rows(B)).filter((r) => r.kind === "items_waiting");
      expect(mine.map((r) => r.dedupeKey)).toEqual([
        `items:${H.B.admin}:${addDays(W, 0)}T10`,
        `items:${H.B.admin}:${addDays(W, 0)}T11`,
      ]);
      expect(mine.every((r) => r.status === "sent" && r.providerId)).toBe(true);
    });

    it("a viewer gets no items-waiting for their role's items; a signer does", async () => {
      const B = H.B.tenantId;
      await H.t.db
        .update(membership)
        .set({ canSign: false })
        .where(and(eq(membership.tenantId, B), eq(membership.userId, H.B.user)));
      await addItem(B, { role: "client_user", createdAt: at(1, "09:00") });
      await pass(B, at(1, "09:30"));
      expect(emailsTo(user("b"))).toHaveLength(0);
      await H.t.db
        .update(membership)
        .set({ canSign: true })
        .where(and(eq(membership.tenantId, B), eq(membership.userId, H.B.user)));
      await pass(B, at(1, "09:35"));
      expect(emailsTo(user("b"))).toHaveLength(1);
    });

    it("snoozed items are skipped", async () => {
      const B = H.B.tenantId;
      // Every open item of the admin snoozed: nothing waits.
      await H.t.db
        .update(inboxItem)
        .set({ snoozedUntil: at(2, "12:00") })
        .where(eq(inboxItem.tenantId, B));
      await addItem(B, { role: "client_admin", createdAt: at(2, "08:00") });
      await H.t.db
        .update(inboxItem)
        .set({ snoozedUntil: at(2, "12:00") })
        .where(eq(inboxItem.tenantId, B));
      const before = emailsTo(admin("b")).length;
      await pass(B, at(2, "09:00"));
      expect(emailsTo(admin("b"))).toHaveLength(before);
      await pass(B, at(2, "12:05"));
      expect(emailsTo(admin("b"))).toHaveLength(before + 1);
    });
  });

  describe("texts and quiet hours", () => {
    const A = () => H.A.tenantId;
    const msg = (path = "") => `/api/ops/clients/${A()}/messaging${path}`;

    beforeAll(async () => {
      // The client's number: a subaccount, a number, A2P approved; quiet 21:00–08:00 UTC.
      await H.call(OPERATOR, "PUT", msg(), { quietHours: { start: "21:00", end: "08:00" } });
      await H.call(OPERATOR, "POST", msg("/twilio"));
      await H.call(OPERATOR, "POST", msg("/numbers"), { phoneNumber: "+15125550101" });
      const brandSid = `BN${"1".repeat(32)}`;
      const serviceSid = `MG${"2".repeat(32)}`;
      await H.call(OPERATOR, "PUT", msg("/a2p"), { brandSid, messagingServiceSid: serviceSid });
      twilio.setBrand(brandSid, "APPROVED");
      twilio.setCampaign(serviceSid, "VERIFIED");
      await H.call(OPERATOR, "POST", msg("/a2p/refresh"));
    });

    it("texts are off until the person turns them on, and only when one can reach them", async () => {
      const mine = await H.call(admin("a"), "GET", "/api/settings/my-notifications");
      expect(j(mine.json)).toEqual({ email: true, sms: false, canText: false, emailsOn: true });
      const refused = await H.call(admin("a"), "PUT", "/api/settings/my-notifications", {
        email: true,
        sms: true,
      });
      expect(refused.status).toBe(422);
      expect(j(refused.json).error.code).toBe("cannot_text");
      const made = await H.call(admin("a"), "POST", "/api/contacts", {
        name: "Client A admin",
        phone: ADMIN_PHONE,
        email: admin("a"),
        consent: { channels: ["sms", "email"], source: "signed the service agreement" },
      });
      expect(made.status, JSON.stringify(made.json)).toBe(200);
      const on = await H.call(admin("a"), "PUT", "/api/settings/my-notifications", {
        email: true,
        sms: true,
      });
      expect(on.status, JSON.stringify(on.json)).toBe(200);
      expect(j(on.json)).toEqual({ email: true, sms: true, canText: true, emailsOn: true });
      // Someone else's choice is theirs.
      const theirs = await H.call(user("a"), "GET", "/api/settings/my-notifications");
      expect(j(theirs.json)).toMatchObject({ email: true, sms: false });
    });

    it("quiet hours hold texts and items-waiting emails; they go once the hours end", async () => {
      await addItem(A(), { role: "client_admin", createdAt: at(0, "22:00") });
      const textsBefore = [...twilio.messages.values()].filter((m) => m.to === ADMIN_PHONE).length;
      await pass(A(), at(0, "23:00"));
      const held = (await rows(A())).filter((r) => r.kind === "items_waiting");
      expect(held.map((r) => [r.channel, r.status, r.reason]).sort()).toEqual([
        ["email", "queued", "quiet_hours"],
        ["sms", "queued", "quiet_hours"],
      ]);
      expect(emailsTo(admin("a"))).toHaveLength(0);
      // Still held at 07:55; no second row is made meanwhile.
      await pass(A(), at(1, "07:55"));
      expect((await rows(A())).filter((r) => r.kind === "items_waiting")).toHaveLength(2);
      await pass(A(), at(1, "08:05"));
      const sent = (await rows(A())).filter((r) => r.kind === "items_waiting");
      expect(sent.every((r) => r.status === "sent")).toBe(true);
      const texts = [...twilio.messages.values()].filter((m) => m.to === ADMIN_PHONE);
      expect(texts).toHaveLength(textsBefore + 1);
      expect(texts.at(-1)?.body).toBe(`Mezonas: 1 item waits for you in Mezonas. ${ORIGIN}/inbox`);
      expect(texts.at(-1)?.from).toBe("+15125550101");
      expect(emailsTo(admin("a"))).toHaveLength(1);
    });
  });

  describe("reconnect", () => {
    it("a connection in error asks the client admin once, then again only after 24 hours", async () => {
      const C = H.C.tenantId;
      await H.t.db
        .update(connection)
        .set({ status: "error" })
        .where(eq(connection.id, H.C.connectionId));
      await pass(C, at(3, "10:00"));
      expect(emailsTo(admin("c")).map((e) => e.subject)).toEqual([
        "A connection needs you to sign in again",
      ]);
      expect(emailsTo(admin("c"))[0]?.text).toContain(`${ORIGIN}/connections`);
      await pass(C, at(3, "10:05"));
      await pass(C, at(4, "09:55"));
      expect(emailsTo(admin("c"))).toHaveLength(1);
      await pass(C, at(4, "10:05"));
      expect(emailsTo(admin("c"))).toHaveLength(2);
      // Client users aren't asked (they didn't connect it).
      expect(emailsTo(user("c"))).toHaveLength(0);
    });

    it("the operator's reminder: once a day per connection, logged, only for clients they serve", async () => {
      const [conn] = await H.t.db
        .insert(connection)
        .values({ tenantId: H.A.tenantId, connector: "testkit", status: "disconnected" })
        .returning();
      const id = conn?.id as string;
      const path = `/api/ops/connections/${id}/remind`;
      expect((await H.call(admin("a"), "POST", path)).status).toBe(403);
      expect((await H.call(OTHER_OPERATOR, "POST", path)).status).toBe(404);
      const before = emailsTo(admin("a")).length;
      const sent = await H.call(OPERATOR, "POST", path);
      expect(sent.status, JSON.stringify(sent.json)).toBe(200);
      expect(
        j(sent.json)
          .notifications.map((n: { channel: string }) => n.channel)
          .sort(),
      ).toEqual(["email", "sms"]);
      await H.settle();
      expect(emailsTo(admin("a"))).toHaveLength(before + 1);
      const again = await H.call(OPERATOR, "POST", path);
      expect(again.status).toBe(409);
      expect(j(again.json).error.code).toBe("already_sent");
      const log = await H.t.db
        .select()
        .from(connectionChange)
        .where(eq(connectionChange.connectionId, id));
      expect(log.map((l) => j(l.change).kind)).toEqual(["remind"]);
      // A working connection needs no reminder.
      await H.t.db.update(connection).set({ status: "connected" }).where(eq(connection.id, id));
      expect((await H.call(OPERATOR, "POST", path)).status).toBe(409);
    });
  });

  describe("lead messages and sign-off", () => {
    it("a lead message unread for 10 minutes tells the client's people; the lead hears of theirs", async () => {
      const B = H.B.tenantId;
      const [t] = await H.t.db.select().from(tenant).where(eq(tenant.id, B));
      await H.t.db
        .update(tenant)
        .set({ settings: { ...(t?.settings ?? {}), lead: { userId: H.operator } } })
        .where(eq(tenant.id, B));
      const [th] = await H.t.db
        .insert(thread)
        .values({ tenantId: B, subjectType: "lead", subjectId: B, title: "Your lead" })
        .returning();
      await H.t.db.insert(message).values({
        tenantId: B,
        threadId: th?.id as string,
        senderType: "user",
        senderId: H.operator,
        audience: "client",
        body: { text: `About ${VENDOR}: the price went up ${AMOUNT}` },
        createdAt: at(5, "10:00"),
      });
      const before = emailsTo(user("b")).length;
      await pass(B, at(5, "10:05"));
      expect(emailsTo(user("b"))).toHaveLength(before);
      await pass(B, at(5, "10:10"));
      const told = emailsTo(user("b")).at(-1);
      expect(told?.subject).toBe("You have a new message from your Mezonas lead");
      expect(emailsTo(user("b"))).toHaveLength(before + 1);

      // The client answers; the lead hears of it after 10 minutes, with the back office's link.
      await H.t.db.insert(message).values({
        tenantId: B,
        threadId: th?.id as string,
        senderType: "user",
        senderId: H.B.admin,
        audience: "client",
        body: { text: "Thanks" },
        createdAt: at(5, "11:00"),
      });
      await pass(B, at(5, "11:15"));
      const lead = emailsTo("operator@example.com").at(-1);
      expect(lead?.subject).toBe("A client sent you a new message");
      expect(lead?.text).toContain(`${ORIGIN}/ops/clients/${B}`);
      await pass(B, at(5, "11:20"));
      expect(emailsTo("operator@example.com")).toHaveLength(1);
    });

    it("an agent waiting for its go-live sign-off tells the client admins once", async () => {
      const B = H.B.tenantId;
      const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${B}/agents`, {
        slug: "signoff-clerk",
        bundle: testBundle("Signoff clerk"),
      });
      expect(created.status, JSON.stringify(created.json)).toBe(200);
      const item = await addItem(B, { role: "client_admin", createdAt: at(6, "09:00") });
      await H.t.db
        .update(agent)
        .set({ stage: "signoff", stageState: { signoff: { inboxItemId: item, askedAt: "x" } } })
        .where(eq(agent.id, j(created.json).agent.id));
      await pass(B, at(6, "09:05"));
      await pass(B, at(6, "09:10"));
      const signoffs = (await rows(B)).filter((r) => r.kind === "signoff");
      expect(signoffs.map((r) => r.dedupeKey)).toEqual([`signoff:${item}:${H.B.admin}`]);
      expect(emailsTo(admin("b")).at(-1)?.subject).toBe(
        "An agent waits for your sign-off to go live",
      );
    });
  });

  describe("the Weekly Table and the Table", () => {
    const B = () => H.B.tenantId;
    let agentId = "";
    let versionId = "";
    const runIds: string[] = [];

    async function addRun(finishedAt: Date, status: "succeeded" | "waiting" = "succeeded") {
      const [r] = await H.t.db
        .insert(run)
        .values({
          tenantId: B(),
          agentId,
          agentVersionId: versionId,
          workflowSlug: "fix-record",
          mode: "live",
          status,
          startedAt: new Date(finishedAt.getTime() - 60_000),
          ...(status === "succeeded" ? { finishedAt } : {}),
        })
        .returning();
      return r?.id as string;
    }

    beforeAll(async () => {
      await H.t.db.update(tenant).set({ timezone: "Asia/Tokyo" }).where(eq(tenant.id, B()));
      await H.t.db
        .update(tenant)
        .set({ timezone: "America/Chicago" })
        .where(eq(tenant.id, H.A.tenantId));
      const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${B()}/agents`, {
        slug: "clerk",
        bundle: testBundle(),
      });
      agentId = j(created.json).agent.id;
      versionId = j(created.json).version.id;
      await H.t.db
        .update(agent)
        .set({ runStatus: "active", serviceName: "Records clerk", stage: "live" })
        .where(eq(agent.id, agentId));
      // The week W in Tokyo: two runs done (one the week before), two writes (one signed), one
      // signature, one document read.
      runIds.push(await addRun(at(1, "03:00")), await addRun(at(2, "03:00")));
      await addRun(at(-3, "03:00"));
      const [ea1, ea2] = await H.t.db
        .insert(externalAction)
        .values([
          {
            tenantId: B(),
            connectionId: H.B.connectionId,
            tool: TESTKIT_UPDATE_TOOL,
            runId: runIds[0],
            idempotencyKey: `${runIds[0]}:update:0`,
            status: "done",
            approvedBy: H.B.admin,
            approvedAt: at(1, "03:00"),
            executedAt: at(1, "03:01"),
          },
          {
            tenantId: B(),
            connectionId: H.B.connectionId,
            tool: TESTKIT_UPDATE_TOOL,
            runId: runIds[1],
            idempotencyKey: `${runIds[1]}:update:0`,
            status: "done",
            executedAt: at(2, "03:01"),
          },
        ])
        .returning();
      expect(ea1 && ea2).toBeTruthy();
      await H.t.db.insert(inboxItem).values({
        tenantId: B(),
        kind: "approval",
        title: "Approve",
        status: "resolved",
        resolution: { approved: true },
        resolvedBy: H.B.admin,
        resolvedAt: at(1, "03:00"),
        createdAt: at(1, "02:00"),
      });
      const [doc] = await H.t.db
        .insert(document)
        .values({
          tenantId: B(),
          source: "upload",
          storageKey: "k",
          mimeType: "application/pdf",
          filename: `${SUBJECT}.pdf`,
          sizeBytes: 10,
          sha256: "a".repeat(64),
        })
        .returning();
      await H.t.db.insert(docExtraction).values({
        tenantId: B(),
        documentId: doc?.id as string,
        model: "test",
        header: { vendor: VENDOR },
        subtotal: "1234.5600",
        total: "1234.5600",
        linesSum: "1234.5600",
        totalsMatch: true,
        createdAt: at(1, "04:00"),
      });
    });

    it("drafts Friday 17:00 local, takes the lead's note and decisions, sends Monday 7:00 in two time zones", async () => {
      const tokyo = weeklySchedule(W, "Asia/Tokyo");
      const chicago = weeklySchedule(W, "America/Chicago");
      const weekly = (tenantId: string) =>
        H.t.db
          .select()
          .from(weeklyTable)
          .where(and(eq(weeklyTable.tenantId, tenantId), eq(weeklyTable.weekStart, W)));

      await notifyTick(H.db, deps(), H.platform, new Date(tokyo.draftAt.getTime() - 60_000));
      expect(await weekly(B())).toHaveLength(0);
      await notifyTick(H.db, deps(), H.platform, tokyo.draftAt);
      const [draft] = await weekly(B());
      expect(draft?.status).toBe("draft");
      // Chicago's Friday 17:00 is later: no draft there yet.
      expect(await weekly(H.A.tenantId)).toHaveLength(0);

      // The lead writes; a decision's sources must be this client's records.
      const put = (body: unknown, client = B()) =>
        H.call(OPERATOR, "PUT", `/api/ops/clients/${client}/weekly/${W}`, body);
      const foreign = await put({
        decisions: [{ title: "Switch supplier?", sources: [H.C.connectionId] }],
      });
      expect(foreign.status).toBe(422);
      expect(j(foreign.json).error.code).toBe("unknown_sources");
      const edited = await put({
        note: NOTE,
        nextWeek: "We will look at freight.",
        decisions: [
          {
            title: "Switch supplier?",
            body: "Two quotes came in.",
            options: ["Switch", "Stay"],
            sources: [runIds[0]],
          },
        ],
      });
      expect(edited.status, JSON.stringify(edited.json)).toBe(200);
      const decisionId = j(edited.json).table.decisions[0].id;
      expect(j(edited.json).table).toMatchObject({
        status: "draft",
        note: NOTE,
        noteBy: { id: H.operator, name: "Operator" },
      });
      // Keeping the decision's id keeps it.
      const kept = await put({
        decisions: [{ id: decisionId, title: "Switch supplier now?", sources: [runIds[0]] }],
      });
      expect(j(kept.json).table.decisions[0].id).toBe(decisionId);
      // Client people and operators of other clients can't.
      expect(
        (await H.call(admin("b"), "PUT", `/api/ops/clients/${B()}/weekly/${W}`, {})).status,
      ).toBe(403);
      expect(
        (await H.call(OTHER_OPERATOR, "PUT", `/api/ops/clients/${B()}/weekly/${W}`, {})).status,
      ).toBe(404);

      // Monday 6:59 in Tokyo: nothing; 7:00: sent, and the members told.
      await notifyTick(H.db, deps(), H.platform, new Date(tokyo.sendAt.getTime() - 60_000));
      expect((await weekly(B()))[0]?.status).toBe("draft");
      await notifyTick(H.db, deps(), H.platform, tokyo.sendAt);
      const [sent] = await weekly(B());
      expect(sent?.status).toBe("sent");
      expect(sent?.note).toBe(NOTE);
      expect(sent?.stats).toMatchObject({
        weekStart: W,
        runs: { done: 2, lastWeek: 1, change: 1 },
        changes: { automatic: 1, signed: 1 },
        signatures: { given: 1 },
        documents: { read: 1 },
        agents: [{ id: agentId, name: "Records clerk", runsDone: 2, kpis: [] }],
      });
      expect(j(sent?.stats).runs.sources.sort()).toEqual([...runIds].sort());
      expect(j(sent?.stats).changes.sources).toHaveLength(2);
      const weeklyRows = (await rows(B())).filter(
        (r) => r.kind === "weekly_table" && r.dedupeKey.startsWith(`weekly:${W}:`),
      );
      expect(weeklyRows.map((r) => r.dedupeKey).sort()).toEqual(
        [`weekly:${W}:${H.B.admin}`, `weekly:${W}:${H.B.user}`].sort(),
      );
      expect(weeklyRows.every((r) => r.status === "sent")).toBe(true);
      const mail = emailsTo(user("b")).at(-1);
      expect(mail?.text).toContain("Last week: 2 runs done, 2 changes to your tools.");
      expect(mail?.text).toContain(`${ORIGIN}/weekly?week=${W}`);
      // Chicago is still on Sunday evening: its table isn't sent.
      expect((await weekly(H.A.tenantId))[0]?.status ?? "none").not.toBe("sent");
      await notifyTick(H.db, deps(), H.platform, new Date(chicago.sendAt.getTime() - 60_000));
      expect((await weekly(H.A.tenantId))[0]?.status).toBe("draft");
      await notifyTick(H.db, deps(), H.platform, chicago.sendAt);
      expect((await weekly(H.A.tenantId))[0]?.status).toBe("sent");
      // A second tick sends nothing more.
      const count = resend.emails.length;
      await notifyTick(H.db, deps(), H.platform, new Date(chicago.sendAt.getTime() + 60_000));
      expect(resend.emails.length).toBe(count);

      // A sent table can't be edited.
      const late = await put({ note: "too late" });
      expect(late.status).toBe(409);
      expect(j(late.json).error.code).toBe("sent");
      // v0.12 W1-C: the client answers a decision with a message in the lead thread, linked
      // from the decision's reply.
      const replyTo = (who: string, id: string, text = "Switch") =>
        H.call(who, "POST", `/api/weekly/${W}/decisions/${id}/reply`, { text });
      const reply = await replyTo(user("b"), decisionId);
      expect(reply.status, JSON.stringify(reply.json)).toBe(200);
      const messageId = j(reply.json).messageId as string;
      const [msg] = await H.t.db.select().from(message).where(eq(message.id, messageId));
      expect(msg).toMatchObject({
        tenantId: B(),
        senderType: "user",
        senderId: H.B.user,
        kind: "text",
        audience: "client",
        sources: [runIds[0]],
        body: { text: "Switch", weeklyDecision: { weekStart: W, decisionId } },
      });
      const [leadRow] = await H.t.db
        .select()
        .from(thread)
        .where(eq(thread.id, msg?.threadId ?? ""));
      expect(leadRow).toMatchObject({ tenantId: B(), subjectType: "lead" });
      const posted = await H.t.db
        .select()
        .from(event)
        .where(and(eq(event.tenantId, B()), eq(event.type, "thread.message_posted")));
      expect(posted.map((e) => j(e.payload).messageId)).toContain(messageId);
      const [answered] = await weekly(B());
      expect(answered?.decisions[0]?.reply).toMatchObject({ by: H.B.user, messageId });
      // One answer per decision; another decision, week or client is not found.
      const again = await replyTo(admin("b"), decisionId, "Wait");
      expect([again.status, j(again.json).error.code]).toEqual([409, "replied"]);
      expect((await replyTo(user("b"), uuidv7())).status).toBe(404);
      expect((await replyTo(user("c"), decisionId)).status).toBe(404);
      expect((await replyTo(OPERATOR, decisionId)).status).toBe(403);
    });

    it("the portal reads sent tables and downloads the PDF; nothing carries cost or prompts", async () => {
      const got = await H.call(user("b"), "GET", "/api/weekly");
      expect(got.status, JSON.stringify(got.json)).toBe(200);
      expect(j(got.json).table.weekStart).toBe(W);
      // The week before went out too (the clients were made before it ended); W is the latest.
      expect(j(got.json).weeks[0]).toBe(W);
      expect(forbiddenKeys(got.json, /cost|token|prompt|instruction|bundle/i)).toEqual([]);
      expect((await H.call(user("b"), "GET", `/api/weekly?week=${addDays(W, 7)}`)).status).toBe(
        404,
      );
      // Another client sees only its own.
      const other = await H.call(user("c"), "GET", "/api/weekly");
      expect(j(other.json).table?.id).not.toBe(j(got.json).table.id);
      expect(JSON.stringify(j(other.json))).not.toContain(agentId);

      const pdf = await H.app.request(
        `/api/weekly/${W}/pdf`,
        { headers: { [DEV_USER_HEADER]: admin("b") } },
        H.env,
      );
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get("content-type")).toBe("application/pdf");
      expect(pdf.headers.get("cache-control")).toContain("no-store");
      const bytes = new Uint8Array(await pdf.arrayBuffer());
      const parsed = await PDFDocument.load(bytes);
      // Tokyo, English: A4.
      expect(Math.round(parsed.getPage(0).getWidth())).toBe(595);
      const text = pdfText(bytes);
      expect(text).toContain("Weekly summary");
      expect(text).toContain("Runs done: 2 (+1 on last week)");
      expect(text).toContain("Changes to your tools: 2 (1 automatic, 1 signed)");
      expect(text).toContain("Signatures given: 1");
      expect(text).toContain("Documents read: 1");
      expect(text).toContain(NOTE);
      expect(text).toContain("Switch supplier now?");
      // A draft or a week not sent is not there; other clients' can't be read.
      expect(
        (
          await H.app.request(
            `/api/weekly/${addDays(W, 7)}/pdf`,
            { headers: { [DEV_USER_HEADER]: admin("b") } },
            H.env,
          )
        ).status,
      ).toBe(404);
      // Another client's download of the same week is its own table.
      const theirs = await H.app.request(
        `/api/weekly/${W}/pdf`,
        { headers: { [DEV_USER_HEADER]: admin("c") } },
        H.env,
      );
      expect(theirs.status).toBe(200);
      const theirText = pdfText(new Uint8Array(await theirs.arrayBuffer()));
      expect(theirText).toContain("Client C");
      expect(theirText).not.toContain(NOTE);
    });

    it("the Table: services now, this week's figures, the Desk's top three and the lead", async () => {
      // A run waiting on the client at its second step.
      const waiting = await addRun(new Date(), "waiting");
      await H.t.db.insert(stepRun).values({
        tenantId: B(),
        runId: waiting,
        nodeId: "confirm",
        nodeType: "person",
        status: "waiting",
        startedAt: new Date(Date.now() - 120_000),
      });
      await H.t.db.insert(inboxItem).values({
        tenantId: B(),
        kind: "approval",
        title: "Is the record right now?",
        runId: waiting,
        agentId,
        assigneeRole: "client_admin",
      });
      const res = await H.call(admin("b"), "GET", "/api/table");
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const table = j(res.json);
      expect(forbiddenKeys(table, /cost|token|prompt|instruction|bundle/i)).toEqual([]);
      const clerk = table.services.find((s: { id: string }) => s.id === agentId);
      expect(clerk).toMatchObject({
        name: "Records clerk",
        stage: "live",
        now: {
          runId: waiting,
          status: "waiting",
          step: { index: 2, total: 3, label: "Confirm" },
          waitingOnYou: true,
        },
      });
      expect(table.desk.top.length).toBeLessThanOrEqual(3);
      expect(table.desk.open).toBeGreaterThan(0);
      expect(table.lead).toMatchObject({ id: H.operator, name: "Operator" });
      expect(table.lead.message.text).toContain("price went up");
      // A client user sees only their own items at the Desk's top.
      const theirs = await H.call(user("b"), "GET", "/api/table");
      expect(j(theirs.json).desk.open).toBeLessThan(table.desk.open);
      // Operators don't read the portal's Table.
      expect((await H.call(OPERATOR, "GET", "/api/table")).status).toBe(403);
    });
  });

  describe("with no key", () => {
    it("rows are written skipped, not_configured", async () => {
      const C = H.C.tenantId;
      await addItem(C, { role: "client_admin", createdAt: at(9, "09:00") });
      const none = notifyDepsFromEnv({ ...H.env, RESEND_API_KEY: "" }, fetch);
      expect(none.mailer.isConfigured).toBe(false);
      const before = resend.emails.length;
      await notifyPass(H.db, none, C, at(9, "10:00"));
      const row = (await rows(C)).find((r) => r.kind === "items_waiting");
      expect(row).toMatchObject({ status: "skipped", reason: "not_configured", channel: "email" });
      expect(resend.emails.length).toBe(before);
      const settings = await H.call(admin("c"), "GET", "/api/settings");
      expect(j(settings.json).emailsOn).toBe(true);
    });
  });

  describe("content", () => {
    it("no message carries a record field: vendors, amounts, subjects, notes", () => {
      const sent = [
        ...resendBodies.map((b) => `${b.subject}\n${b.text}\n${b.html ?? ""}`),
        ...[...twilio.messages.values()]
          .filter((m) => m.direction === "outbound-api")
          .map((m) => m.body),
      ];
      expect(sent.length).toBeGreaterThan(10);
      for (const body of sent) {
        for (const field of [
          VENDOR,
          "Acme",
          AMOUNT,
          "1234.56",
          SUBJECT,
          "4471",
          NOTE,
          "Switch supplier",
        ]) {
          expect(body, body).not.toContain(field);
        }
        // One link, to this app.
        const links = body.match(/https?:\/\/[^\s"<]+/g) ?? [];
        expect(new Set(links).size, body).toBe(1);
        expect(new URL(links[0] as string).origin).toBe(new URL(ORIGIN).origin);
        expect(body).not.toMatch(/<img|<script/i);
      }
    });
  });
});
