// P-9 (docs/plan.md §1.71): the Purchasing area's pieces for a buyer that works by email, against a
// throwaway database as the Worker's role: a request read from a message opens with nulls for what
// wasn't said and lines without a quantity; a person fixes a line; who to email at each vendor;
// the RFQ's words and PDF; an RFQ marked sent from its reach-out's outcome, expired when nobody
// answered; and client B never reaching client A's rows (invariant 1).

import { inflateSync } from "node:zlib";
import { ContentStore, MemoryObjectStore } from "@countersign/connectors";
import {
  agent,
  closeDb,
  contact,
  createDb,
  type Db,
  document,
  event,
  organization,
  reachOut,
  run,
} from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchLine } from "../catalog/match";
import { recordPrices } from "../pricing/record";
import { quoteRequest } from "../schema";
import { insertShop, type ShopFixture } from "../testing.test-helper";
import { type PackTool, packToolContext } from "../tools";
import { RFQ_TEXT_MAX } from "./rfq";
import {
  quoteCreate,
  quoteDocument,
  quoteExpire,
  quoteMarkSent,
  quoteRecord,
  requestCreate,
  requestUpdateLines,
  vendorContactsTool,
} from "./tools";

const online = await databaseAvailable();

// biome-ignore lint/suspicious/noExplicitAny: tool outputs are read loosely in tests.
type J = any;

function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const start = raw.indexOf("stream", at);
    if (start < 0) break;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    let body = start + "stream".length;
    if (raw[body] === "\r") body++;
    if (raw[body] === "\n") body++;
    at = end + "endstream".length;
    if (raw.slice(start - 3, start) === "end") continue;
    try {
      const text = inflateSync(Buffer.from(raw.slice(body, end), "latin1")).toString("latin1");
      for (const m of text.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) {
        out.push(Buffer.from(m[1] ?? "", "hex").toString("latin1"));
      }
    } catch {}
  }
  return out.join("\n");
}

describe.skipIf(!online)("the Purchasing area by email (database)", () => {
  let t: TestDatabase;
  let db: Db;
  let A: ShopFixture;
  let B: ShopFixture;
  const content = new ContentStore(new MemoryObjectStore());
  const ctx = (shop: ShopFixture) =>
    packToolContext({
      tenantId: shop.tenantId,
      agentVersionId: shop.agentVersionId,
      mode: "live",
      db,
      content,
    });
  const call = async (tool: PackTool, input: unknown, shop: ShopFixture = A): Promise<J> =>
    tool.output.parse(await tool.run(input, ctx(shop)));
  const fails = async (tool: PackTool, input: unknown, shop: ShopFixture = A) => {
    try {
      await tool.run(input, ctx(shop));
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return null;
  };

  const BB = "3/4 BB/BB BALTIC BIRCH 5X5";
  const vendors: Record<string, string> = {};
  const people: Record<string, string> = {};

  /** A vendor's organization in the directory and one person at it. */
  async function person(
    shop: ShopFixture,
    vendorId: string | null,
    name: string,
    values: Partial<typeof contact.$inferInsert>,
  ) {
    let orgId: string | null = null;
    if (vendorId) {
      const [existing] = await t.db
        .select()
        .from(organization)
        .where(eq(organization.vendorId, vendorId));
      orgId =
        existing?.id ??
        (
          await t.db
            .insert(organization)
            .values({ tenantId: shop.tenantId, name: `${name} Co`, kinds: ["vendor"], vendorId })
            .returning()
        )[0]?.id ??
        null;
    }
    const [c] = await t.db
      .insert(contact)
      .values({ tenantId: shop.tenantId, name, organizationId: orgId, ...values })
      .returning();
    return c?.id as string;
  }

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const url = new URL(t.url);
    url.searchParams.set("options", "-c role=cs_worker");
    db = createDb(url.toString(), { max: 2 });
    A = await insertShop(t.db, "Millwork A");
    B = await insertShop(t.db, "Millwork B");
    vendors.keystone = await A.vendor("Keystone Lumber");
    vendors.northline = await A.vendor("Northline Plywood");
    vendors.cedar = await A.vendor("Cedar Ridge Supply");
    vendors.b = await B.vendor("Keystone Lumber");
    // What Keystone printed for the plywood: its own words, which the RFQ uses.
    const doc = await A.invoiceDoc(vendors.keystone, [
      { description: BB, qty: "10", uom: "SHT", unitPrice: "60" },
    ]);
    for (const docLineId of doc.lineIds) {
      await matchLine(
        { db },
        { tenantId: A.tenantId, agentVersionId: A.agentVersionId, docLineId },
      );
    }
    await recordPrices(
      db,
      { tenantId: A.tenantId, agentVersionId: A.agentVersionId, runId: null, testRun: false },
      { documentId: doc.documentId },
    );
    const consent = { email: { grantedAt: "2026-11-01T00:00:00Z", source: "operator" } };
    people.dana = await person(A, vendors.keystone, "Dana Keys", {
      email: "dana@keystone.example",
      title: "Sales",
      consent,
    });
    people.al = await person(A, vendors.keystone, "Al Accounts", {
      email: "al@keystone.example",
      consent,
    });
    // Northline's only person never agreed to email; Cedar Ridge is in no organization.
    people.nora = await person(A, vendors.northline, "Nora North", {
      email: "nora@northline.example",
    });
    people.bDana = await person(B, vendors.b, "Dana B", { email: "dana@b.example", consent });
  });
  afterAll(async () => {
    if (db) await closeDb(db);
    await t?.drop();
  });

  let requestId: string;
  let lines: J[];

  it("opens a request from a reading's output: null is not stated, a line may wait for its quantity", async () => {
    const r = await call(requestCreate, {
      channel: "email",
      requestedByContactId: null,
      requestedByUserId: null,
      rawRecordId: null,
      neededBy: "2026-11-20",
      fulfillment: null,
      deliverTo: null,
      notes: "",
      lines: [
        {
          description: BB,
          qty: "12",
          unit: "sheets",
          notes: null,
          neededBy: null,
          catalogItemId: null,
          catalogItemName: null,
          candidates: [],
        },
        { description: "some edge banding", qty: null, unit: null, notes: null },
      ],
    });
    requestId = r.request.id;
    lines = r.request.lines;
    expect(r.request).toMatchObject({ channel: "email", fulfillment: null, notes: null });
    expect(lines.map((l: J) => [l.qty, l.matchMethod])).toEqual([
      ["12.0000", "alias"],
      [null, null],
    ]);
    // A /command or a request Sloan passed comes from the portal.
    const portal = await call(requestCreate, { channel: "command", lines: [] });
    expect(portal.request.channel).toBe("portal");
    // The area's news: a request opened, one line waiting for its quantity.
    const [news] = await t.db
      .select()
      .from(event)
      .where(and(eq(event.type, "materials.request.created"), eq(event.subjectId, requestId)));
    expect(news?.payload).toMatchObject({ lines: 2, unmatched: 1, withoutQuantity: 1 });
  });

  it("asks no vendor while a line has no quantity, and lets a person fix the line", async () => {
    expect(await fails(quoteCreate, { requestId, vendorIds: [vendors.keystone] })).toMatch(
      /line 2 has no quantity yet/,
    );
    const r = await call(requestUpdateLines, {
      requestId,
      lines: [{ lineId: lines[1].id, qty: "3", unit: "rolls", notes: "white" }],
    });
    expect(r.changed).toEqual([{ lineId: lines[1].id, fields: ["qty", "unit", "notes"] }]);
    expect(r.request.lines[1]).toMatchObject({ qty: "3.0000", unit: "rolls", notes: "white" });
    // Only what's on the request, never another client's, and never a guess of 0.
    expect(
      await fails(requestUpdateLines, { requestId, lines: [{ lineId: lines[0].id, qty: "0" }] }),
    ).toMatch(/more than 0/);
    expect(
      await fails(requestUpdateLines, { requestId, lines: [{ lineId: lines[1].id, qty: "1" }] }, B),
    ).toMatch(/not found/);
  });

  it("finds who to email at each vendor: an address, consent, not opted out, sales first", async () => {
    const r = await call(vendorContactsTool, {
      vendorIds: [vendors.keystone, vendors.northline, vendors.cedar],
    });
    expect(r.vendorIds).toEqual([vendors.keystone]);
    expect(r.vendors[0]).toMatchObject({ contactId: people.dana, contactName: "Dana Keys" });
    expect(r.vendors[0].contacts).toHaveLength(2);
    expect(r.missing.map((m: J) => [m.vendorName, m.reason])).toEqual([
      ["Northline Plywood", "nobody at the vendor has agreed to email from us"],
      ["Cedar Ridge Supply", "not linked to an organization in the directory"],
    ]);
    expect(r.sources).toEqual(expect.arrayContaining([vendors.keystone, people.dana]));
    // Client B's vendor and people are not A's to read.
    expect((await call(vendorContactsTool, { vendorIds: [vendors.b] })).vendors).toEqual([]);
  });

  let quoteId: string;

  it("writes each RFQ's email in the vendor's own words, and its PDF", async () => {
    const r = await call(quoteCreate, {
      requestId,
      vendorIds: [vendors.keystone],
      dueAt: "2026-11-12T17:00:00Z",
      withDocument: true,
    });
    const q = r.quotes[0];
    quoteId = q.id;
    expect(q).toMatchObject({ contactId: people.dana, contactName: "Dana Keys" });
    expect(q.subject).toBe("Request for quote from Millwork A: 2 items");
    expect(q.rfqText).toContain("Hello Dana Keys,");
    expect(q.rfqText).toContain(`1. ${BB}: 12 sheets`);
    expect(q.rfqText).toContain("2. some edge banding: 3 rolls");
    expect(q.rfqText).toContain("Needed by 2026-11-20.");
    expect(q.rfqText).toContain("by 2026-11-12");
    expect(q.rfqText.length).toBeLessThanOrEqual(RFQ_TEXT_MAX);

    const pdf = await call(quoteDocument, { quoteRequestId: quoteId });
    expect(pdf).toMatchObject({ vendorName: "Keystone Lumber", lines: 2, created: true });
    const [doc] = await t.db.select().from(document).where(eq(document.id, pdf.documentId));
    expect(doc).toMatchObject({ tenantId: A.tenantId, source: "generated" });
    expect(doc?.meta).toMatchObject({ kind: "rfq", quoteRequestId: quoteId });
    const text = pdfText(
      ((await content.get(A.tenantId, doc?.sha256 as string)) as { bytes: Uint8Array }).bytes,
    );
    for (const s of ["Request for quote", "Keystone Lumber", `1. ${BB}`, "Your unit price"]) {
      expect(text, s).toContain(s);
    }
    expect(text).not.toContain("Total");
    expect((await call(quoteDocument, { quoteRequestId: quoteId })).documentId).toBe(
      pdf.documentId,
    );
    expect(await fails(quoteDocument, { quoteRequestId: quoteId }, B)).toMatch(/not found/);
  });

  /** A reach-out of client A's that sent one email, as reach out records it. */
  async function sentReachOut(contactId: string, node: string) {
    const [a] = await t.db.select().from(agent).where(eq(agent.tenantId, A.tenantId));
    const [r] = await t.db
      .insert(run)
      .values({
        tenantId: A.tenantId,
        agentId: a?.id as string,
        agentVersionId: A.agentVersionId,
        workflowSlug: "buy",
      })
      .returning();
    const [ro] = await t.db
      .insert(reachOut)
      .values({
        tenantId: A.tenantId,
        agentId: a?.id as string,
        agentVersionId: A.agentVersionId,
        runId: r?.id as string,
        nodeId: node,
        contactId,
        subject: `about:${node}`,
        purpose: "Ask for a quote",
        urgency: "normal",
        plan: {},
        status: "ended",
        outcome: "replied",
        attempts: [{ channel: "email", status: "sent", at: "2026-11-08T15:00:00.000Z" }],
        endedAt: new Date(),
      })
      .returning();
    return ro?.id as string;
  }

  it("marks an RFQ sent from its reach-out, tied to it, with the reply's words and PDF to read", async () => {
    const reachOutId = await sentReachOut(people.dana as string, "ask:0");
    const r = await call(quoteMarkSent, {
      quoteRequestId: quoteId,
      reachOut: {
        outcome: "replied",
        channel: "email",
        reachOutId,
        attempts: 1,
        reason: null,
        reply: {
          text: "See attached.",
          rawRecordId: null,
          documents: ["0190a1b2-0000-7000-8000-00000000000d"],
        },
      },
    });
    expect(r).toMatchObject({
      sent: true,
      replied: true,
      expired: false,
      requestStatus: "quoting",
    });
    expect(r.quote).toMatchObject({ status: "sent", sentVia: "email" });
    expect(r.quote.sentAt).toBe("2026-11-08T15:00:00.000Z");
    expect(r.reply).toMatchObject({
      text: "See attached.",
      documentId: "0190a1b2-0000-7000-8000-00000000000d",
    });
    expect(r.sources).toContain(reachOutId);
    const [row] = await t.db.select().from(quoteRequest).where(eq(quoteRequest.id, quoteId));
    expect(row?.reachOutId).toBe(reachOutId);
    // Another client's reach-out, or none, can't be tied to it.
    expect(
      await fails(
        quoteMarkSent,
        {
          quoteRequestId: quoteId,
          reachOut: { outcome: "replied", channel: "email", reachOutId, attempts: 1 },
        },
        B,
      ),
    ).toMatch(/not found/);
  });

  it("expires a silent vendor's RFQ and moves the request on; leaves one never sent a draft", async () => {
    const more = await call(quoteCreate, {
      requestId,
      vendorIds: [vendors.northline, vendors.cedar],
    });
    const [cedar, northline] = more.quotes;
    // Nothing went out to Cedar Ridge (refused before sending): still a draft.
    const never = await call(quoteMarkSent, {
      quoteRequestId: cedar.id,
      reachOut: {
        outcome: "not_allowed",
        channel: null,
        reachOutId: null,
        attempts: 0,
        reason: "no consent",
      },
    });
    expect(never).toMatchObject({ sent: false, expired: false, reason: "no consent" });
    expect(never.quote.status).toBe("draft");
    // Northline got the email and said nothing by the reach-out's timeout.
    const silent = await call(quoteMarkSent, {
      quoteRequestId: northline.id,
      reachOut: {
        outcome: "no_reply",
        channel: "email",
        reachOutId: await sentReachOut(people.nora as string, "ask:1"),
        attempts: 1,
      },
    });
    expect(silent).toMatchObject({ sent: true, replied: false, expired: true, reply: null });
    expect(silent.quote).toMatchObject({ status: "expired", notes: "no reply in time" });
    // Keystone's quote comes in: nothing is waiting any more, so the request is quoted.
    const view = await call(quoteRecord, {
      quoteRequestId: quoteId,
      notes: null,
      answerDocumentId: null,
      lines: [
        { requestLineId: lines[0].id, unitPrice: "58", unit: "SHT", notes: "" },
        { requestLineId: lines[1].id, unitPrice: "12.5", unit: "roll" },
      ],
    });
    expect(view.requestStatus).toBe("quoted");
  });

  it("expires what is still waiting on an answer when asked, and only that", async () => {
    const other = await call(requestCreate, {
      channel: "email",
      lines: [{ description: BB, qty: "2" }],
    });
    const asked = await call(quoteCreate, {
      requestId: other.request.id,
      vendorIds: [vendors.keystone],
      dueAt: "2026-11-09T17:00:00Z",
    });
    await call(quoteMarkSent, { quoteRequestId: asked.quotes[0].id, sentVia: "email" });
    expect(
      (await call(quoteExpire, { requestId: other.request.id, asOf: "2026-11-09T12:00:00Z" }))
        .expired,
    ).toEqual([]);
    const r = await call(quoteExpire, {
      requestId: other.request.id,
      asOf: "2026-11-09T18:00:00Z",
    });
    expect(r.expired.map((q: J) => q.status)).toEqual(["expired"]);
    expect(r.requestStatus).toBe("quoting");
    expect(await fails(quoteExpire, { requestId: other.request.id, all: true }, B)).toMatch(
      /not found/,
    );
  });
});
