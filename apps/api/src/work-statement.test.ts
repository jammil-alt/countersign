// Y5 (docs/plan.md §1.234): the work-delivered statement, against a real database as cs_worker.
// A Sandbox client's October 2026, seeded by hand, with every count worked out by hand below. The
// portal's statement, its PDF, the PDF emailed with the Stripe invoice and the back office's view
// must all show exactly those numbers. The portal's answer carries no cost, bundle, instructions
// or prompts (invariant 11) and only its own client (invariant 1).

import { inflateSync } from "node:zlib";
import { DEV_USER_HEADER } from "@countersign/auth";
import { createStripeClient } from "@countersign/connectors";
import {
  FAKE_RESEND_MAIN,
  FAKE_STRIPE_KEY,
  fakeResend,
  fakeStripe,
} from "@countersign/connectors/testing";
import { WORK_COUNTER_IDS, type WorkCounts } from "@countersign/core";
import {
  agent,
  agentVersion,
  alert,
  appUser,
  billingStatement,
  billingStatementLine,
  connection,
  externalAction,
  inboxItem,
  membership,
  meteredUsage,
  run,
  runSubject,
  stepRun,
  tenant,
} from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  type ApiHarness,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  testBundle,
} from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const resend = fakeResend();
const stripeFake = fakeStripe();
const h = await createApiHarness({
  stripe: createStripeClient({ secretKey: FAKE_STRIPE_KEY, fetch: stripeFake.fetch }),
  fetch: resend.fetch,
  env: {
    RESEND_API_KEY: FAKE_RESEND_MAIN.apiKey,
    RESEND_FALLBACK_DOMAIN: "mail.mezonas.test",
    APP_ORIGIN: "https://app.mezonas.test",
  },
});
afterAll(() => h?.close());

/** Keys a portal statement may never carry. */
const PORTAL_EXTRA =
  /^(template|templateId|templates|tenantId|bundle|instructions?|prompts?|model|margin|.*[cC]ost.*|spend|tokens.*|vendor.*)$/;

const SANDBOX_ADMIN = "admin@sandbox.example.com";
const SANDBOX_USER = "user@sandbox.example.com";
const MONTH = "2026-10";
const oct = (day: number, hour = 12, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute));
const nov = (day: number, hour = 12, minute = 0) => new Date(Date.UTC(2026, 10, day, hour, minute));

/**
 * The hand count for October (UTC), from the rows seeded below.
 *
 * Invoice review (purchasing), live runs p1 (Oct 3), p2 (Oct 10), p3 (Oct 12) and p6 (Oct 31,
 * 23:30): 4 runs. Not counted: p4 (a test run), p5 (November 2), and client A's run.
 * - Items processed: p1's trigger document D1, p1's changed bill (qbo B-1), p2's trigger document
 *   D2, p2's decided vendor V1 = 4. Not counted: p1's vendor V1 only *read*; p3's trigger document
 *   D1 again (the same record, once); a subject recorded after the month ended.
 * - Posted automatically: p1's done write with no approval, p6's done write at 23:45 = 2. Not
 *   counted: p2's write (it waited for approval), p6's write executed on November 1, p1's failed
 *   write.
 * - Sent for approval: p2's change card for the client admin = 1. Not counted: p2's card the
 *   verifier sent to us (assignee operator), p2's extraction review.
 * - Exceptions caught: p1's alert ($125.50, open), p2's alert dismissed on November 5 ($40.25),
 *   p2's alert in euros (€10.00) and p2's card the verifier disagreed with = 4. Not counted: p2's
 *   alert dismissed on October 20 ($999.00), p6's alert raised on November 1.
 * - Dollars identified: USD 125.50 + 40.25 = 165.75; EUR 10.00.
 *
 * Bookkeeper (bookkeeping), live run k1 (Oct 15): 1 run.
 * - Items processed: transactions T1 and T2 decided = 2 (T3 only read).
 * - Posted automatically: 2. Sent for approval: its approval item for the client = 1 (its review
 *   item is not an approval). Exceptions caught: 0. Dollars identified: none.
 */
const INVOICE_REVIEW: WorkCounts = {
  itemsProcessed: 4,
  autoPosted: 2,
  sentForApproval: 1,
  exceptionsCaught: 4,
  dollarsIdentified: [
    { currency: "USD", total: "165.75" },
    { currency: "EUR", total: "10.00" },
  ],
};
const BOOKKEEPER: WorkCounts = {
  itemsProcessed: 2,
  autoPosted: 2,
  sentForApproval: 1,
  exceptionsCaught: 0,
  dollarsIdentified: [],
};
const TOTALS: WorkCounts = {
  itemsProcessed: 6,
  autoPosted: 4,
  sentForApproval: 2,
  exceptionsCaught: 4,
  dollarsIdentified: [
    { currency: "USD", total: "165.75" },
    { currency: "EUR", total: "10.00" },
  ],
};

/** The text a pdf-lib PDF draws (Helvetica, hex strings), one string per line drawn. */
function pdfText(bytes: Uint8Array): string[] {
  const raw = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    let body = m[1] as string;
    try {
      body = inflateSync(Buffer.from(body, "latin1")).toString("latin1");
    } catch {
      // Not compressed.
    }
    for (const t of body.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) {
      // WinAnsi is Latin-1 but for 0x80-0x9f; the euro sign is the one these PDFs draw there.
      out.push(
        Buffer.from(t[1] as string, "hex")
          .toString("latin1")
          .replaceAll("\x80", "€"),
      );
    }
  }
  return out;
}

/** The counts as the English PDF writes them, in order. */
const LINES = (c: WorkCounts) => [
  `Items processed: ${c.itemsProcessed}`,
  `Posted automatically: ${c.autoPosted}`,
  `Sent for approval: ${c.sentForApproval}`,
  `Exceptions caught: ${c.exceptionsCaught}`,
  `Dollars identified: ${
    c.dollarsIdentified.length === 0
      ? "0"
      : c.dollarsIdentified
          .map((a) =>
            new Intl.NumberFormat("en", { style: "currency", currency: a.currency }).format(
              Number(a.total),
            ),
          )
          .join(", ")
  }`,
];

/** The PDF's lines hold `lines` in order, one after another. */
function expectLinesInOrder(text: string[], lines: string[]) {
  const start = text.indexOf(lines[0] as string);
  expect(start, `"${lines[0]}" in ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
  expect(text.slice(start, start + lines.length)).toEqual(lines);
}

describe.skipIf(!h)("the work statement", () => {
  const H = h as ApiHarness;
  const owner = H.t.db;
  let sandbox = "";
  let connectionId = "";
  const agents = {} as Record<"review" | "books", { id: string; version: string }>;
  let keys = 0;
  let statementId = "";

  async function addAgent(name: string, slug: string, area: "purchasing" | "bookkeeping") {
    const [a] = await owner
      .insert(agent)
      .values({
        tenantId: sandbox,
        kind: "client",
        slug,
        name,
        serviceName: name,
        runStatus: "active",
        stage: "live",
        area,
      })
      .returning();
    if (!a) throw new Error("no agent");
    const [v] = await owner
      .insert(agentVersion)
      .values({
        tenantId: sandbox,
        agentId: a.id,
        version: 1,
        bundle: testBundle(name),
        bundleHash: `hash-${slug}`,
        status: "live",
        authorType: "operator",
      })
      .returning();
    if (!v) throw new Error("no version");
    await owner.update(agent).set({ liveVersionId: v.id }).where(eq(agent.id, a.id));
    return { id: a.id, version: v.id };
  }

  async function addRun(
    a: { id: string; version: string },
    createdAt: Date,
    values: Partial<typeof run.$inferInsert> = {},
    tenantId = sandbox,
  ) {
    const [r] = await owner
      .insert(run)
      .values({
        tenantId,
        agentId: a.id,
        agentVersionId: a.version,
        workflowSlug: "work",
        mode: "live",
        status: "succeeded",
        trigger: { type: "manual" },
        startedAt: createdAt,
        createdAt,
        ...values,
      })
      .returning();
    if (!r) throw new Error("no run");
    return r.id;
  }

  async function addStep(runId: string, at: Date, tenantId = sandbox) {
    keys += 1;
    const [s] = await owner
      .insert(stepRun)
      .values({
        tenantId,
        runId,
        nodeId: `step-${keys}`,
        nodeType: "tool",
        status: "succeeded",
        startedAt: at,
        finishedAt: at,
      })
      .returning();
    if (!s) throw new Error("no step");
    return s.id;
  }

  async function subject(
    runId: string,
    values: Partial<typeof runSubject.$inferInsert> & {
      kind: (typeof runSubject.$inferInsert)["kind"];
      role: (typeof runSubject.$inferInsert)["role"];
      createdAt: Date;
    },
    tenantId = sandbox,
  ) {
    await owner.insert(runSubject).values({ tenantId, runId, ...values });
  }

  async function write(
    runId: string,
    values: Partial<typeof externalAction.$inferInsert>,
    tenantId = sandbox,
    conn = connectionId,
  ) {
    keys += 1;
    await owner.insert(externalAction).values({
      tenantId,
      connectionId: conn,
      tool: "testkit.update",
      runId,
      idempotencyKey: `${runId}:w:${keys}`,
      status: "done",
      ...values,
    });
  }

  async function item(
    runId: string,
    values: Partial<typeof inboxItem.$inferInsert> & { createdAt: Date },
    tenantId = sandbox,
  ) {
    const [i] = await owner
      .insert(inboxItem)
      .values({ tenantId, kind: "external_action", runId, title: "A change", ...values })
      .returning();
    if (!i) throw new Error("no item");
    return i.id;
  }

  async function raise(
    runId: string,
    values: Partial<typeof alert.$inferInsert> & { createdAt: Date },
    tenantId = sandbox,
  ) {
    keys += 1;
    await owner.insert(alert).values({
      tenantId,
      pack: "materials",
      kind: "price_increase",
      subjectType: "vendor",
      subjectId: "0190f0a0-0000-7000-8000-0000000000aa",
      severity: "warning",
      title: "Price went up",
      body: "Oak board went up.",
      evidence: ["0190f0a0-0000-7000-8000-0000000000bb"],
      raisedByRunId: runId,
      dedupeKey: `alert-${keys}`,
      ...values,
    });
  }

  it("seeds the Sandbox client's October", async () => {
    const [t] = await owner
      .insert(tenant)
      .values({
        name: "Sandbox",
        settings: { sandbox: true },
      })
      .returning();
    if (!t) throw new Error("no tenant");
    sandbox = t.id;
    const [adminUser] = await owner
      .insert(appUser)
      .values({ email: SANDBOX_ADMIN, name: "Sandbox admin" })
      .returning();
    const [plainUser] = await owner
      .insert(appUser)
      .values({ email: SANDBOX_USER, name: "Sandbox user" })
      .returning();
    const [op] = await owner.select().from(appUser).where(eq(appUser.email, OPERATOR));
    await owner.insert(membership).values([
      { tenantId: sandbox, userId: adminUser?.id as string, role: "client_admin" },
      { tenantId: sandbox, userId: plainUser?.id as string, role: "client_user" },
      { tenantId: sandbox, userId: op?.id as string, role: "operator" },
    ]);
    const [conn] = await owner
      .insert(connection)
      .values({ tenantId: sandbox, connector: "testkit", status: "connected" })
      .returning();
    connectionId = conn?.id as string;

    agents.review = await addAgent("Invoice review", "invoice-review", "purchasing");
    agents.books = await addAgent("Bookkeeper", "bookkeeper", "bookkeeping");
    const doc1 = "0190f0a0-0000-7000-8000-000000000d01";
    const doc2 = "0190f0a0-0000-7000-8000-000000000d02";
    const vendor1 = "0190f0a0-0000-7000-8000-000000000e01";

    // p1, October 3.
    const p1 = await addRun(agents.review, oct(3));
    const p1s = await addStep(p1, oct(3));
    await subject(p1, { kind: "document", role: "read", recordId: doc1, createdAt: oct(3) });
    await subject(p1, {
      stepRunId: p1s,
      kind: "vendor",
      role: "read",
      recordId: vendor1,
      createdAt: oct(3),
    });
    await subject(p1, {
      stepRunId: p1s,
      kind: "record",
      role: "changed",
      connector: "qbo",
      externalId: "B-1",
      amount: "1250.0000",
      currency: "USD",
      createdAt: oct(3),
    });
    await write(p1, { executedAt: oct(3, 12, 5) });
    await write(p1, { status: "failed" });
    await raise(p1, { dollarImpact: "125.5000", currency: "USD", createdAt: oct(3) });

    // p2, October 10.
    const p2 = await addRun(agents.review, oct(10));
    const p2s = await addStep(p2, oct(10));
    await subject(p2, { kind: "document", role: "read", recordId: doc2, createdAt: oct(10) });
    await subject(p2, {
      stepRunId: p2s,
      kind: "vendor",
      role: "decided",
      recordId: vendor1,
      createdAt: oct(10),
    });
    const card = await item(p2, {
      assigneeRole: "client_admin",
      status: "resolved",
      resolvedAt: oct(11),
      createdAt: oct(10),
    });
    await write(p2, { inboxItemId: card, executedAt: oct(11) });
    await item(p2, {
      assigneeRole: "operator",
      payload: { verification: { outcome: "disagreed", checked: ["amount"] } },
      createdAt: oct(10),
    });
    await item(p2, { kind: "extraction_review", createdAt: oct(10) });
    await raise(p2, {
      dollarImpact: "999.0000",
      currency: "USD",
      status: "dismissed",
      resolvedAt: oct(20),
      createdAt: oct(10),
    });
    await raise(p2, {
      dollarImpact: "40.2500",
      currency: "USD",
      status: "dismissed",
      resolvedAt: nov(5),
      createdAt: oct(10),
    });
    await raise(p2, { dollarImpact: "10.0000", currency: "EUR", createdAt: oct(10) });

    // p3, October 12: the same document again.
    const p3 = await addRun(agents.review, oct(12));
    await subject(p3, { kind: "document", role: "read", recordId: doc1, createdAt: oct(12) });

    // p4, a test run on October 12: never counted.
    const p4 = await addRun(agents.review, oct(12), { mode: "test" });
    await subject(p4, { kind: "document", role: "read", recordId: doc2, createdAt: oct(12) });
    await write(p4, { executedAt: oct(12) });
    await raise(p4, { dollarImpact: "5.0000", currency: "USD", createdAt: oct(12) });

    // p5, November 2: another month.
    const p5 = await addRun(agents.review, nov(2));
    await subject(p5, {
      kind: "document",
      role: "read",
      recordId: "0190f0a0-0000-7000-8000-000000000d05",
      createdAt: nov(2),
    });
    await write(p5, { executedAt: nov(2) });

    // p6, October 31 at 23:30: what it did before midnight counts, what came after doesn't.
    const p6 = await addRun(agents.review, oct(31, 23, 30));
    await write(p6, { executedAt: oct(31, 23, 45) });
    await write(p6, { executedAt: nov(1, 0, 10) });
    await subject(p6, {
      kind: "document",
      role: "read",
      recordId: "0190f0a0-0000-7000-8000-000000000d06",
      createdAt: nov(1, 0, 5),
    });
    await raise(p6, { dollarImpact: "77.0000", currency: "USD", createdAt: nov(1, 0, 20) });

    // k1, October 15.
    const k1 = await addRun(agents.books, oct(15));
    const k1s = await addStep(k1, oct(15));
    for (const [ref, role] of [
      ["T1", "decided"],
      ["T2", "decided"],
      ["T3", "read"],
    ] as const) {
      await subject(k1, {
        stepRunId: k1s,
        kind: "transaction",
        role,
        connector: "qbo",
        externalId: ref,
        createdAt: oct(15),
      });
    }
    await write(k1, { executedAt: oct(15) });
    await write(k1, { executedAt: oct(15) });
    await item(k1, { kind: "approval", createdAt: oct(15) });
    await item(k1, { kind: "review", createdAt: oct(15) });

    // Client A's October: never on the Sandbox's statement.
    const [aAgent] = await owner
      .insert(agent)
      .values({
        tenantId: H.A.tenantId,
        kind: "client",
        slug: "a-review",
        name: "A review",
        runStatus: "active",
        stage: "live",
      })
      .returning();
    const [aVersion] = await owner
      .insert(agentVersion)
      .values({
        tenantId: H.A.tenantId,
        agentId: aAgent?.id as string,
        version: 1,
        bundle: testBundle("A review"),
        bundleHash: "hash-a-review",
        status: "live",
        authorType: "operator",
      })
      .returning();
    const aRun = await addRun(
      { id: aAgent?.id as string, version: aVersion?.id as string },
      oct(5),
      {},
      H.A.tenantId,
    );
    await write(aRun, { executedAt: oct(5) }, H.A.tenantId, H.A.connectionId);
    await raise(
      aRun,
      { dollarImpact: "500.0000", currency: "USD", createdAt: oct(5) },
      H.A.tenantId,
    );

    // October's bill, a draft for $250.00, as the build would leave it.
    const [s] = await owner
      .insert(billingStatement)
      .values({
        tenantId: sandbox,
        period: "2026-10-01",
        periodEnd: "2026-10-31",
        daysInMonth: 31,
        status: "draft",
        total: "250.0000",
        creditsUsed: 0,
        creditsIncluded: 0,
        extraCredits: 0,
        creditPrice: "0.0200",
      })
      .returning();
    statementId = s?.id as string;
    await owner.insert(billingStatementLine).values({
      tenantId: sandbox,
      statementId,
      position: 1,
      kind: "agent",
      agentId: agents.review.id,
      description: "Invoice review",
      amount: "250.0000",
    });
  });

  /** The statement's numbers, wherever it came from. */
  function expectHandCount(s: ReturnType<typeof j>) {
    expect(s.month).toBe(MONTH);
    expect(s.from).toBe("2026-10-01");
    expect(s.to).toBe("2026-10-31");
    expect(s.partial).toBe(false);
    expect(s.totals).toEqual(TOTALS);
    expect(s.agents).toEqual([
      { id: agents.books.id, name: "Bookkeeper", area: "bookkeeping", runs: 1, counts: BOOKKEEPER },
      {
        id: agents.review.id,
        name: "Invoice review",
        area: "purchasing",
        runs: 4,
        counts: INVOICE_REVIEW,
      },
    ]);
    expect(s.areas).toEqual([
      { area: "purchasing", agents: 1, counts: INVOICE_REVIEW },
      { area: "bookkeeping", agents: 1, counts: BOOKKEEPER },
    ]);
  }

  it("the portal's statement matches the hand count, with nothing of ours", async () => {
    const res = await H.call(SANDBOX_ADMIN, "GET", `/api/billing/work?month=${MONTH}`);
    expect(res.status).toBe(200);
    const s = j(res.json);
    expectHandCount(s);
    expect(s.client).toEqual({ name: "Sandbox" });
    expect(s.invoiceNumber).toBeNull();
    expect(forbiddenKeys(s, PORTAL_EXTRA)).toEqual([]);
    // Only Sandbox's: client A's write and $500.00 alert are nowhere.
    expect(JSON.stringify(s)).not.toContain("500.00");
    expect(JSON.stringify(s)).not.toContain(H.A.tenantId);
  });

  it("is the client admin's, and never a month that hasn't started", async () => {
    expect((await H.call(SANDBOX_USER, "GET", `/api/billing/work?month=${MONTH}`)).status).toBe(
      403,
    );
    expect((await H.call(SANDBOX_ADMIN, "GET", "/api/billing/work?month=2099-01")).status).toBe(
      422,
    );
    expect((await H.call(SANDBOX_ADMIN, "GET", "/api/billing/work?month=2026-13")).status).toBe(
      400,
    );
    // Another month is its own: November has p5 and what p6 did after midnight.
    const novRes = j((await H.call(SANDBOX_ADMIN, "GET", "/api/billing/work?month=2026-11")).json);
    expect(novRes.partial).toBe(true);
    expect(novRes.agents.map((a: { runs: number }) => a.runs)).toEqual([1]);
  });

  it("the back office's view shows the same numbers", async () => {
    const res = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/billing/clients/${sandbox}/work?month=${MONTH}`,
    );
    expect(res.status).toBe(200);
    const s = j(res.json);
    expectHandCount(s);
    expect(s.client).toEqual({ id: sandbox, name: "Sandbox" });
    // A client the operator doesn't serve is not found.
    const other = await H.call(
      "other-operator@example.com",
      "GET",
      `/api/ops/billing/clients/${sandbox}/work?month=${MONTH}`,
    );
    expect([403, 404]).toContain(other.status);
  });

  it("the portal's PDF shows the same numbers", async () => {
    const res = await H.app.request(
      `/api/billing/work.pdf?month=${MONTH}`,
      { headers: { [DEV_USER_HEADER]: SANDBOX_ADMIN } },
      H.env,
    );
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expectPdfHandCount(bytes);
  });

  function expectPdfHandCount(bytes: Uint8Array) {
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    const text = pdfText(bytes);
    expect(text).toContain("Work statement");
    expect(text.some((l) => l.startsWith("October 2026"))).toBe(true);
    expectLinesInOrder(text, LINES(TOTALS));
    expectLinesInOrder(text, ["Invoice review (Purchasing, 4 runs)", ...LINES(INVOICE_REVIEW)]);
    expectLinesInOrder(text, ["Bookkeeper (Bookkeeping, 1 runs)", ...LINES(BOOKKEEPER)]);
    expect(text.join("\n")).not.toMatch(/\$500\.00|cost|margin|model/i);
  }

  it("the invoice's email carries the same PDF, once, as an email of ours", async () => {
    const setup = await H.call(OPERATOR, "POST", `/api/ops/billing/clients/${sandbox}/setup`, {
      email: "billing@sandbox.example.com",
    });
    expect(setup.status).toBe(200);
    const sent = await H.call(OPERATOR, "POST", `/api/ops/billing/statements/${statementId}/send`);
    expect(sent.status).toBe(200);
    expect(j(sent.json).status).toBe("sent");
    await H.settle();

    const emails = resend.emails.filter((e) => e.to.includes("billing@sandbox.example.com"));
    expect(emails).toHaveLength(1);
    const email = emails[0] as (typeof emails)[number];
    expect(email.subject).toBe("Your work statement for October 2026");
    expect(email.text).toContain("https://app.mezonas.test/billing/work?month=2026-10");
    expect(email.attachments).toHaveLength(1);
    const pdf = email.attachments?.[0];
    expect(pdf?.filename).toBe("mezonas-work-2026-10.pdf");
    expect(pdf?.content_type).toBe("application/pdf");
    const bytes = new Uint8Array(Buffer.from(pdf?.content as string, "base64"));
    expectPdfHandCount(bytes);
    // With the invoice: the statement names Stripe's number.
    expect(pdfText(bytes).join("\n")).toMatch(/With invoice \S+/);

    // Metered as one email of ours, never billed to the client.
    const metered = await owner
      .select()
      .from(meteredUsage)
      .where(eq(meteredUsage.tenantId, sandbox));
    expect(metered.filter((m) => m.measure === "emails")).toEqual([
      expect.objectContaining({ ours: true, source: "notification", quantity: 1 }),
    ]);

    // The portal now names the invoice, and its numbers haven't moved.
    const after = j((await H.call(SANDBOX_ADMIN, "GET", `/api/billing/work?month=${MONTH}`)).json);
    expectHandCount(after);
    expect(after.invoiceNumber).toEqual(expect.any(String));
  });

  it("every counter in core's definitions is on the statement", () => {
    expect(Object.keys(TOTALS).sort()).toEqual([...WORK_COUNTER_IDS].sort());
  });
});
