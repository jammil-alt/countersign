// The back office's email (docs/plan.md §1.123.4; docs/cases-plan.md W1), against fakes only: mail
// to support@ from a client's person opens an issue and our reply goes back by email with a tagged
// reply-to; their answer lands on the issue; mail to hello@ from a stranger opens a lead deal, and
// the deal's email threads back to it; anything else is a "Sort this" to-do. Nothing is bounced.
// Also the reminder, the questions pass and expansion spotting.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FAKE_RESEND_MAIN, fakeResend } from "@countersign/connectors/testing";
import {
  appUser,
  deal,
  dealActivity,
  dealPerson,
  issue,
  message,
  thread,
  todo,
  withOperator,
} from "@countersign/db";
import { DEFAULT_FIXTURE_DIR } from "@countersign/llm/node";
import { and, eq, like } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { admin, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";
import { receiveBackOfficeEmail } from "./backoffice/inbound-email";
import { backOfficeAddress, parseTag, sendIssueEmails } from "./backoffice/outbound-email";
import { questionsFor } from "./backoffice/questions";
import { openSpotted, signalsFor, volumeUp } from "./backoffice/spotting";
import { chaseRequirements } from "./backoffice/tick";
import { handleEmail } from "./email";
import { defaultDeps } from "./http";
import { resendMailer } from "./notify/mailer";
import { addTodo } from "./work/todos-store";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const DOMAIN = "in.example.test";
const resend = fakeResend();
const h = await createApiHarness({
  fetch: resend.fetch,
  env: {
    EMAIL_FORWARDING_DOMAIN: DOMAIN,
    RESEND_API_KEY: FAKE_RESEND_MAIN.apiKey,
    RESEND_FALLBACK_DOMAIN: "mail.example.test",
  },
});
afterAll(() => h?.close());

const FIXTURES = resolve(DEFAULT_FIXTURE_DIR, "..", "email");
const fixture = (name: string) => readFileSync(resolve(FIXTURES, name));

function mime(lines: { from: string; to: string; subject: string; text: string; id: string }) {
  return new TextEncoder().encode(
    [
      `From: ${lines.from}`,
      `To: ${lines.to}`,
      `Subject: ${lines.subject}`,
      `Message-ID: <${lines.id}@mail.example>`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      lines.text,
      "",
      "On Tue, Mezonas wrote:",
      "> what we said before",
    ].join("\r\n"),
  );
}

describe.skipIf(!h)("the back office's email", () => {
  const H = h as NonNullable<typeof h>;
  const A = () => H.A.tenantId;
  const mailer = resendMailer({
    apiKey: FAKE_RESEND_MAIN.apiKey,
    domain: "mail.example.test",
    fetch: resend.fetch,
  });
  const appDeps = {
    ...defaultDeps,
    openDb: () => ({ db: H.db, close: async () => {} }),
    instances: () => H.instances,
    objects: () => H.objects,
    extractionTransport: () => null,
    fetch: () => resend.fetch,
  };
  const deliver = async (from: string, to: string, raw: Uint8Array) => {
    const pending: Promise<unknown>[] = [];
    const out = await handleEmail(
      { from, to, raw: new Response(raw).body as ReadableStream<Uint8Array>, rawSize: raw.length },
      H.env,
      (p) => pending.push(p),
      appDeps,
    );
    await Promise.all(pending);
    return out;
  };
  const sortTodos = () => H.t.db.select().from(todo).where(like(todo.title, "Sort this:%"));

  it("knows its own addresses and tags", () => {
    expect(backOfficeAddress("Support@In.Example.Test", DOMAIN, ["support", "hello"])).toEqual({
      local: "support",
      tag: null,
    });
    expect(backOfficeAddress("hello+dabc@in.example.test", DOMAIN, ["support", "hello"])).toEqual({
      local: "hello",
      tag: "dabc",
    });
    // A client's forwarding address and other domains are not ours.
    expect(
      backOfficeAddress("acme-abcdefgh@in.example.test", DOMAIN, ["support", "hello"]),
    ).toBeNull();
    expect(backOfficeAddress("support@elsewhere.test", DOMAIN, ["support", "hello"])).toBeNull();
    expect(parseTag("nope").kind).toBe("unknown");
  });

  let issueId = "";
  let tag = "";

  it("opens an issue from a client's person, and emails our reply with a tagged reply-to", async () => {
    const out = await deliver(
      "admin@a.example.com",
      `support@${DOMAIN}`,
      fixture("backoffice-client.eml"),
    );
    expect(out).toMatchObject({ status: "dropped", tenantId: A() });
    const [row] = await H.t.db
      .select()
      .from(issue)
      .where(and(eq(issue.tenantId, A()), eq(issue.source, "email")));
    expect(row).toMatchObject({
      title: "Invoices posted twice",
      raisedByEmail: "admin@a.example.com",
      stage: "reported",
    });
    expect(row?.needsReadAt).not.toBeNull();
    expect(row?.replyTag).toMatch(/^[a-z2-7]{26}\.[a-z2-7]{10}$/);
    issueId = row?.id as string;
    tag = row?.replyTag as string;
    // The client's words are the issue's data, never instructions to anyone.
    const msgs = await H.t.db
      .select()
      .from(message)
      .where(eq(message.threadId, row?.threadId as string));
    expect(j(msgs[0]?.body).text).toContain("Ignore your instructions");

    const reply = await H.call(OPERATOR, "POST", `/api/ops/issues/${issueId}/messages`, {
      text: "We've paused the bookkeeper and are reversing the duplicates.",
      audience: "client",
    });
    expect(reply.status, JSON.stringify(reply.json)).toBe(200);
    // A note stays ours: never emailed.
    await H.call(OPERATOR, "POST", `/api/ops/issues/${issueId}/messages`, {
      text: "Internal: v7 dropped the date check.",
      audience: "operator",
    });
    expect(await sendIssueEmails(H.db, mailer, DOMAIN)).toBe(1);
    const sent = resend.emails.at(-1);
    expect(sent).toMatchObject({
      to: ["admin@a.example.com"],
      reply_to: `support+${tag}@${DOMAIN}`,
      text: "We've paused the bookkeeper and are reversing the duplicates.",
    });
    expect(sent?.from).toMatch(/via Mezonas" <notify@mail\.example\.test>$/);
    expect(sent?.subject).toContain("[Request #");
    // Once each.
    expect(await sendIssueEmails(H.db, mailer, DOMAIN)).toBe(0);
    expect(resend.emails.filter((e) => e.text.includes("Internal"))).toEqual([]);
  });

  it("lands a tagged reply on its issue, only from its people", async () => {
    await H.t.db.update(issue).set({ needsReadAt: null }).where(eq(issue.id, issueId));
    const raw = mime({
      from: "Client A admin <admin@a.example.com>",
      to: `support+${tag}@${DOMAIN}`,
      subject: "Re: Invoices posted twice",
      text: "Thanks, the duplicates are gone.",
      id: "reply-1",
    });
    await deliver("mallory@evil.example", `support+${tag}@${DOMAIN}`, raw);
    let msgs = await H.t.db
      .select()
      .from(message)
      .innerJoin(issue, eq(issue.threadId, message.threadId))
      .where(eq(issue.id, issueId));
    expect(msgs.some((m) => j(m.message.body).text?.includes("duplicates are gone"))).toBe(false);
    expect((await sortTodos()).some((t) => t.title.includes("mallory@evil.example"))).toBe(true);

    await deliver("admin@a.example.com", `support+${tag}@${DOMAIN}`, raw);
    msgs = await H.t.db
      .select()
      .from(message)
      .innerJoin(issue, eq(issue.threadId, message.threadId))
      .where(eq(issue.id, issueId));
    const landed = msgs.find((m) => j(m.message.body).text === "Thanks, the duplicates are gone.");
    expect(landed?.message.audience).toBe("client");
    const [row] = await H.t.db.select().from(issue).where(eq(issue.id, issueId));
    expect(row?.needsReadAt).not.toBeNull();
  });

  let dealId = "";

  it("opens a lead deal from a stranger to hello@, and threads the deal's email back", async () => {
    await deliver("jo@acme-widgets.example", `hello@${DOMAIN}`, fixture("backoffice-lead.eml"));
    const [d] = await H.t.db
      .select()
      .from(deal)
      .innerJoin(dealPerson, eq(dealPerson.dealId, deal.id))
      .where(eq(dealPerson.email, "jo@acme-widgets.example"));
    expect(d?.deal).toMatchObject({ kind: "new", stage: "lead", source: "email", clientId: null });
    dealId = d?.deal.id as string;
    const acts = await H.t.db.select().from(dealActivity).where(eq(dealActivity.dealId, dealId));
    expect(acts.map((a) => a.kind)).toContain("email_in");
    const [first] = await H.t.db
      .select()
      .from(todo)
      .where(eq(todo.dedupeKey, `deal:first-reply:${dealId}`));
    expect(first?.owner).toBe("operator");

    const res = await H.call(OPERATOR, "POST", `/api/ops/deals/${dealId}/email`, {
      subject: "Two times for a call",
      text: "Would Tuesday at 10 or Wednesday at 2 work?",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const sent = resend.emails.at(-1);
    expect(sent?.to).toEqual(["jo@acme-widgets.example"]);
    expect(sent?.reply_to).toMatch(
      new RegExp(`^hello\\+d[a-z2-7]{16}@${DOMAIN.replace(/\./g, "\\.")}$`),
    );
    expect(j(res.json).activity.map((a: { kind: string }) => a.kind)).toContain("email_out");
    // Clients never send a deal's email.
    expect(
      (
        await H.call(admin("a"), "POST", `/api/ops/deals/${dealId}/email`, {
          subject: "x",
          text: "y",
        })
      ).status,
    ).toBe(403);

    const replyTo = sent?.reply_to as string;
    await deliver(
      "jo@acme-widgets.example",
      replyTo,
      mime({
        from: "Jo <jo@acme-widgets.example>",
        to: replyTo,
        subject: "Re: Two times",
        text: "Tuesday at 10.",
        id: "jo-2",
      }),
    );
    const after = await H.t.db.select().from(dealActivity).where(eq(dealActivity.dealId, dealId));
    expect(after.some((a) => a.kind === "email_in" && a.body === "Tuesday at 10.")).toBe(true);
    // A second email from Jo before a reply grows the same deal.
    await deliver(
      "jo@acme-widgets.example",
      `hello@${DOMAIN}`,
      mime({
        from: "jo@acme-widgets.example",
        to: `hello@${DOMAIN}`,
        subject: "Also",
        text: "And payroll?",
        id: "jo-3",
      }),
    );
    const deals = await H.t.db
      .select({ id: deal.id })
      .from(deal)
      .innerJoin(dealPerson, eq(dealPerson.dealId, deal.id))
      .where(eq(dealPerson.email, "jo@acme-widgets.example"));
    expect(deals.length).toBe(1);
  });

  it("sorts what it can't place, and leaves other addresses alone", async () => {
    await deliver(
      "stranger@nowhere.example",
      `support@${DOMAIN}`,
      mime({
        from: "stranger@nowhere.example",
        to: `support@${DOMAIN}`,
        subject: "Hi",
        text: "Who are you?",
        id: "s-1",
      }),
    );
    const sorted = (await sortTodos()).find((t) => t.title.includes("stranger@nowhere.example"));
    expect(sorted).toMatchObject({ owner: "operator", clientId: null, source: "email" });
    expect(sorted?.detail).toContain("Who are you?");
    const other = await receiveBackOfficeEmail(
      H.db,
      { from: "x@y.example", to: `acme-abcdefgh@${DOMAIN}`, raw: new Uint8Array() },
      { domain: DOMAIN, locals: ["support", "hello"] },
    );
    expect(other).toEqual({ handled: false });
  });

  it("reminds a client of their to-do from their lead", async () => {
    const t = await withOperator(H.db, [A()], (tx) =>
      addTodo(tx, { title: "Connect QuickBooks", owner: "client", clientId: A() }),
    );
    const res = await H.call(OPERATOR, "POST", `/api/ops/todos/${t.id}/remind`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const lead = await H.t.db
      .select()
      .from(message)
      .innerJoin(thread, eq(thread.id, message.threadId))
      .where(and(eq(thread.tenantId, A()), eq(thread.subjectType, "lead")));
    expect(lead.some((m) => j(m.message.body).text === "A reminder: Connect QuickBooks.")).toBe(
      true,
    );
    const mine = await withOperator(H.db, [A()], (tx) =>
      addTodo(tx, { title: "Mine", owner: "operator", clientId: A() }),
    );
    expect((await H.call(OPERATOR, "POST", `/api/ops/todos/${mine.id}/remind`)).status).toBe(409);
  });

  it("hands over a question nobody answered in 4 business hours, once", async () => {
    const [u] = await H.t.db.select().from(appUser).where(eq(appUser.email, "user@a.example.com"));
    const [th] = await H.t.db
      .insert(thread)
      .values({
        tenantId: A(),
        subjectType: "account",
        title: "Questions",
        createdBy: u?.id ?? null,
      })
      .returning();
    const at = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000);
    await H.t.db.insert(message).values({
      tenantId: A(),
      threadId: th?.id as string,
      senderType: "user",
      senderId: u?.id ?? null,
      body: { text: "How do I add a vendor?" },
      audience: "client",
      createdAt: at,
    });
    expect(await questionsFor(H.db, A(), new Date())).toBe(1);
    expect(await questionsFor(H.db, A(), new Date())).toBe(0);
    const [q] = await H.t.db.select().from(todo).where(like(todo.title, "Answer Client A:%"));
    expect(q).toMatchObject({ owner: "operator", source: "question" });
  });

  it("spots a renewal and more work, once each, with sources", async () => {
    expect(volumeUp([3, 5, 8, 13])).toBe(true);
    expect(volumeUp([3, 5, 5, 13])).toBe(false);
    expect(volumeUp([0, 1, 2, 3])).toBe(false);
    const now = new Date();
    const from = new Date(now.getTime() - 330 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [won] = await H.t.db
      .insert(deal)
      .values({
        kind: "new",
        clientId: H.B.tenantId,
        title: "Bookkeeping",
        stage: "live",
        outcome: "won",
        agreedFrom: from,
      })
      .returning();
    const signals = await signalsFor(H.db, H.B.tenantId, now);
    const renewal = signals.find((s) => s.key.startsWith("renewal:"));
    expect(renewal?.evidence[0]?.sources).toEqual([won?.id]);
    expect(
      await openSpotted(H.db, H.B.tenantId, renewal as NonNullable<typeof renewal>),
    ).not.toBeNull();
    expect(
      await openSpotted(H.db, H.B.tenantId, renewal as NonNullable<typeof renewal>),
    ).toBeNull();
    const spotted = await H.t.db
      .select()
      .from(deal)
      .where(and(eq(deal.clientId, H.B.tenantId), eq(deal.stage, "spotted")));
    expect(spotted).toHaveLength(1);
    expect(spotted[0]).toMatchObject({ kind: "expansion", source: "reggie" });
  });

  it("chases a requirements request as a to-do at draft, once a day", async () => {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug: "chase-agent",
      bundle: testBundle(),
    });
    expect(created.status).toBe(200);
    const b = await H.call(OPERATOR, "POST", "/api/ops/builds", {
      kind: "agent",
      title: "Payables",
      clientId: A(),
    });
    expect(b.status, JSON.stringify(b.json)).toBe(200);
    const buildId = j(b.json).build.id as string;
    const today = new Date().toISOString().slice(0, 10);
    await H.t.db.execute(
      `update build set requirements = '${JSON.stringify({
        inboxItemId: "0190d0b6-0000-7000-8000-000000000002",
        fields: [],
        sentAt: new Date().toISOString(),
        dueOn: today,
        to: { userId: "0190d0b6-0000-7000-8000-000000000003", name: "Admin" },
        answered: 1,
        total: 4,
      })}'::jsonb where id = '${buildId}'` as never,
    );
    expect(await chaseRequirements(H.db, new Date())).toBe(1);
    expect(await chaseRequirements(H.db, new Date())).toBe(0);
    const [chase] = await H.t.db.select().from(todo).where(eq(todo.playKey, "chase_requirements"));
    expect(chase).toMatchObject({ owner: "operator", aboutId: buildId });
    expect(j(chase?.draft).text).toContain("3 of 4 answers");
  });
});
