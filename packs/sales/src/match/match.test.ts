// The match against a database (docs/plan.md §1.164 "The match", "Confirm matches"): keys built
// from a client's synced Zoho records, rows decided by keys and text, by meaning and the model,
// each decision recorded with its agent version; a person's answer teaching an alias; a test run
// recording nothing; HIPAA mode refusing embeddings with matching going on; and one client never
// reaching another's records (invariant 1). Embeddings and the model are fakes.

import { readFileSync } from "node:fs";
import { ComplianceRefusal } from "@countersign/core";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import {
  createLlmClient,
  type EmbedRequest,
  FakeModel,
  type LlmClient,
  type LlmRequest,
} from "@countersign/llm";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PackToolContext } from "../pack";
import { crmAlias, crmMatch, crmRecordKey } from "../schema";
import { embedDueKeys, keysAfterSync, lookupRecords } from "../store";
import { insertSalesClient, type SalesFixture } from "../testing.test-helper";
import { decideRow, latestDecisions } from "./decide";
import { type KeyMapping, type MatchRecordsResult, matchRecords } from "./match";

for (const level of ["warn", "error"] as const) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const online = await databaseAvailable();

interface GoldenSet {
  keys: KeyMapping;
  records: { id: string; module: string; payload: Record<string, unknown> }[];
  rows: {
    values: Record<string, string>;
    modules: string[];
    expect: string[] | null;
    note: string;
  }[];
}
const golden = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/matching/crm/leads-and-deals.json", import.meta.url),
    "utf8",
  ),
) as GoldenSet;

/** Embeddings by "concept": texts a test names share a direction; any other text its own. */
function conceptTransport(concepts: Record<string, number>, seen: string[][] = []) {
  // Any other text: a direction of its own, the same in every transport (a hash of the text).
  const own = (text: string) => {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 1000;
    return 20 + h;
  };
  return {
    create: (_: LlmRequest) => Promise.reject(new Error("no message here")),
    embed: async (request: EmbedRequest) => {
      seen.push([...request.input]);
      return {
        model: "text-embedding-3-large",
        embeddings: request.input.map((text) => {
          const dim = concepts[text] ?? own(text);
          return Array.from({ length: request.dimensions }, (_, j) => (j === dim ? 1 : 0));
        }),
        usage: { inputTokens: 5 * request.input.length },
      };
    },
  };
}

describe.skipIf(!online)("matching rows to a client's synced CRM records", () => {
  let t: TestDatabase;
  let A: SalesFixture;
  let B: SalesFixture;
  let off: SalesFixture;
  const ids = new Map<string, string>();

  const ctx = (c: SalesFixture, over: Partial<PackToolContext> = {}): PackToolContext => ({
    tenantId: c.tenantId,
    agentVersionId: c.agentVersionId,
    runId: null,
    stepId: "match",
    mode: "live",
    settings: {},
    db: t.db,
    llm: null,
    ...over,
  });

  const keyId = async (c: SalesFixture, externalId: string) => {
    const [k] = await t.db
      .select({ id: crmRecordKey.id })
      .from(crmRecordKey)
      .where(and(eq(crmRecordKey.tenantId, c.tenantId), eq(crmRecordKey.externalId, externalId)));
    return k?.id ?? "";
  };
  const matches = async (c: SalesFixture) =>
    (
      await t.db
        .select({ n: sql<number>`count(*)::int` })
        .from(crmMatch)
        .where(eq(crmMatch.tenantId, c.tenantId))
    )[0]?.n ?? 0;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertSalesClient(t.db, "Blue Ridge Sales");
    B = await insertSalesClient(t.db, "Other Client");
    off = await insertSalesClient(t.db, "Sales off", { salesOn: false });
    for (const r of golden.records) ids.set(r.id, await A.record(r.module, r.id, r.payload));
    // B holds Jane Doe too, under the same email: never A's to match.
    await B.record("Leads", "B1", {
      First_Name: "Jane",
      Last_Name: "Doe",
      Company: "Blue Ridge Millwork",
      Email: "jane.doe@blueridgemillwork.com",
    });
    await off.record("Leads", "X1", { First_Name: "Off", Last_Name: "Client" });
  });
  afterAll(async () => {
    await t?.drop();
  });

  describe("by keys and text, without a model", () => {
    const results: { module: string; result: MatchRecordsResult }[] = [];

    beforeAll(async () => {
      for (const module of ["Leads", "Contacts", "Accounts", "Deals"]) {
        const rows = golden.rows.filter((r) => r.modules[0] === module);
        results.push({
          module,
          result: await matchRecords(ctx(A), {
            rows: rows.map((r) => r.values),
            keys: golden.keys,
            modules: [module],
          }),
        });
      }
    });

    it("builds the keys of the client's synced records first, and only its own", async () => {
      expect(results.reduce((n, r) => n + r.result.keys.built, 0)).toBe(golden.records.length);
      const [jane] = await t.db
        .select()
        .from(crmRecordKey)
        .where(and(eq(crmRecordKey.tenantId, A.tenantId), eq(crmRecordKey.externalId, "L01")));
      expect(jane).toMatchObject({
        connector: "zoho_crm",
        module: "Leads",
        email: "jane.doe@blueridgemillwork.com",
        phone: "+18285550101",
        domain: "blueridgemillwork.com",
        companyName: "blue ridge millwork",
        personName: "jane doe",
        matchText: "jane doe | blue ridge millwork",
        rawRecordId: ids.get("L01"),
        embedding: null,
      });
      expect(jane?.display).toMatchObject({ name: "Jane Doe", company: "Blue Ridge Millwork" });
      // B's keys aren't built by A's match.
      const bKeys = await t.db
        .select()
        .from(crmRecordKey)
        .where(eq(crmRecordKey.tenantId, B.tenantId));
      expect(bKeys).toHaveLength(0);
    });

    it("decides the golden rows at 95% precision or better on 'same'", () => {
      let right = 0;
      let wrong = 0;
      const wrongs: string[] = [];
      for (const { module, result } of results) {
        const rows = golden.rows.filter((r) => r.modules[0] === module);
        for (const r of result.rows) {
          if (r.decision !== "matched") continue;
          const label = rows[r.index];
          if (label?.expect?.includes(r.record?.externalId ?? "")) right += 1;
          else {
            wrong += 1;
            wrongs.push(`${JSON.stringify(label?.values)} → ${r.record?.externalId}`);
          }
        }
      }
      const same = golden.rows.filter((r) => r.expect && r.expect.length > 0).length;
      console.info(
        `crm golden through the database (no model, no meaning): ${right} matched right, ${wrong} wrong, recall ${((right / same) * 100).toFixed(1)}%`,
      );
      expect(wrongs).toEqual([]);
      expect(right / (right + wrong)).toBeGreaterThanOrEqual(0.95);
      expect(right).toBeGreaterThan(30);
    });

    it("says how each was found, with sources, and leaves the rest to a person with candidates", () => {
      const leads = results.find((r) => r.module === "Leads")?.result as MatchRecordsResult;
      const [first] = leads.rows;
      expect(first).toMatchObject({
        decision: "matched",
        method: "key",
        score: 1,
        record: { module: "Leads", externalId: "L01" },
        needsReview: false,
      });
      expect(first?.sources).toContain(ids.get("L01"));
      const luis = leads.rows[8];
      expect(luis).toMatchObject({
        decision: "matched",
        method: "text",
        record: { externalId: "L06" },
      });
      // Two John Smiths and nothing else: a person picks, shown both.
      const smith = leads.rows[3];
      expect(smith).toMatchObject({ decision: "unsure", needsReview: true });
      expect(smith?.candidates.map((c) => c.externalId).sort()).toEqual(["L02", "L03"]);
      expect(smith?.suggestion?.values.name).toBe("John Smith");
      // A colleague one letter from Maria: her record is shown, ruled out by the other email.
      const mario = leads.rows[9];
      expect(mario?.decision).not.toBe("matched");
      expect(mario?.candidates.find((c) => c.externalId === "L05")?.vetoed).toBe("email");
      expect(leads.anyNeedsReview).toBe(true);
      expect(leads.counts.matched + leads.counts.none + leads.counts.unsure).toBe(
        leads.rows.length,
      );
      // Without a transport nothing was searched by meaning, so no row is called new.
      expect(leads.meaning).toBeNull();
      expect(leads.counts.none).toBe(0);
    });

    it("records each row's decision, attributed to the agent version and the step", async () => {
      const leads = results.find((r) => r.module === "Leads")?.result as MatchRecordsResult;
      const rows = await t.db.select().from(crmMatch).where(eq(crmMatch.batchId, leads.batchId));
      expect(rows).toHaveLength(leads.rows.length);
      for (const r of rows) {
        expect(r).toMatchObject({
          tenantId: A.tenantId,
          agentVersionId: A.agentVersionId,
          decidedByUserId: null,
          step: "match",
        });
      }
      const first = rows.find((r) => r.rowIndex === 0);
      expect(first).toMatchObject({
        decision: "matched",
        method: "key",
        externalId: "L01",
        score: "1.000",
        recordKeyId: await keyId(A, "L01"),
      });
      expect(first?.keys).toMatchObject({ email: "jane.doe@blueridgemillwork.com" });
    });
  });

  it("never reaches another client's records, by key, text or look-up", async () => {
    const res = await matchRecords(ctx(B), {
      rows: [
        { Email: "jane.doe@blueridgemillwork.com" },
        { Name: "Robert Chen", Company: "Harbor Logistics" },
      ],
      keys: golden.keys,
      modules: ["Leads"],
    });
    expect(res.rows[0]?.record?.externalId).toBe("B1");
    expect(res.rows[1]?.candidates).toEqual([]);
    const aIds = new Set(
      (
        await t.db
          .select({ id: crmRecordKey.id })
          .from(crmRecordKey)
          .where(eq(crmRecordKey.tenantId, A.tenantId))
      ).map((r) => r.id),
    );
    for (const r of res.rows)
      for (const c of r.candidates) expect(aIds.has(c.recordKeyId)).toBe(false);
    const { withTenant } = await import("@countersign/db");
    const seen = await withTenant(t.db, B.tenantId, (tx) =>
      lookupRecords(tx, B.tenantId, { module: "Leads", q: "Robert Chen" }),
    );
    expect(seen).toEqual([]);
  });

  it("refuses a client with the Sales area off, and keeps no keys for it after a sync", async () => {
    await expect(
      matchRecords(ctx(off), {
        rows: [{ Name: "Off Client" }],
        keys: golden.keys,
        modules: ["Leads"],
      }),
    ).rejects.toThrow(/Sales area is off/);
    const raw = await off.record("Leads", "X2", { First_Name: "Still", Last_Name: "Off" });
    expect(
      await keysAfterSync(t.db, {
        tenantId: off.tenantId,
        connectionId: off.connectionId,
        rawRecordIds: [raw],
      }),
    ).toBeNull();
  });

  it("records nothing in a test run, and still answers", async () => {
    const before = await matches(A);
    const res = await matchRecords(ctx(A, { mode: "test" }), {
      rows: [{ Email: "rachel.green@northwindtraders.com" }],
      keys: golden.keys,
      modules: ["Contacts"],
    });
    expect(res.testRun).toBe(true);
    expect(res.rows[0]).toMatchObject({
      decision: "matched",
      matchId: null,
      record: { externalId: "C01" },
    });
    expect(await matches(A)).toBe(before);
  });

  describe("a person's answer", () => {
    const dough = { Name: "Jane Dough", Company: "Blue Ridge Millwork" };

    it("is a new decision after the agent's and teaches an alias, so the row matches by itself next time", async () => {
      const first = await matchRecords(ctx(A), {
        rows: [dough],
        keys: golden.keys,
        modules: ["Leads"],
      });
      const row = first.rows[0];
      expect(row?.decision).toBe("unsure");
      const l01 = await keyId(A, "L01");
      // A test run's card records nothing.
      const tried = await decideRow(t.db, {
        tenantId: A.tenantId,
        userId: A.userId,
        matchId: row?.matchId ?? "",
        recordKeyId: l01,
        testRun: true,
      });
      expect(tried).toMatchObject({ matchId: null, aliasId: null, decision: "matched" });
      const decided = await decideRow(t.db, {
        tenantId: A.tenantId,
        userId: A.userId,
        matchId: row?.matchId ?? "",
        recordKeyId: l01,
      });
      expect(decided).toMatchObject({ decision: "matched", rowIndex: 0, batchId: first.batchId });
      expect(decided.aliasId).toBeTruthy();
      const latest = await latestDecisions(t.db, { tenantId: A.tenantId, batchId: first.batchId });
      expect(latest).toHaveLength(1);
      expect(latest[0]).toMatchObject({
        method: "human",
        decidedByUserId: A.userId,
        externalId: "L01",
      });
      // The agent's decision is still there, unchanged.
      const all = await t.db.select().from(crmMatch).where(eq(crmMatch.batchId, first.batchId));
      expect(all.map((m) => m.method).sort()).toEqual(["human", "text"].sort());

      const again = await matchRecords(ctx(A), {
        rows: [dough],
        keys: golden.keys,
        modules: ["Leads"],
      });
      expect(again.rows[0]).toMatchObject({
        decision: "matched",
        method: "alias",
        score: 1,
        record: { externalId: "L01" },
      });
      expect(again.rows[0]?.sources).toContain(decided.aliasId);
    });

    it("No match is recorded and teaches nothing", async () => {
      const first = await matchRecords(ctx(A), {
        rows: [{ Name: "John Smith" }],
        keys: golden.keys,
        modules: ["Leads"],
      });
      const aliases = async () =>
        (await t.db.select().from(crmAlias).where(eq(crmAlias.tenantId, A.tenantId))).length;
      const before = await aliases();
      const decided = await decideRow(t.db, {
        tenantId: A.tenantId,
        userId: A.userId,
        matchId: first.rows[0]?.matchId ?? "",
        recordKeyId: null,
      });
      expect(decided).toMatchObject({ decision: "none", record: null, aliasId: null });
      expect(await aliases()).toBe(before);
    });

    it("never takes another client's decision or record", async () => {
      const res = await matchRecords(ctx(B), {
        rows: [{ Name: "Somebody" }],
        keys: golden.keys,
        modules: ["Leads"],
      });
      await expect(
        decideRow(t.db, {
          tenantId: A.tenantId,
          userId: A.userId,
          matchId: res.rows[0]?.matchId ?? "",
          recordKeyId: null,
        }),
      ).rejects.toThrow(/not found/);
      const aRow = (
        await matchRecords(ctx(A), { rows: [dough], keys: golden.keys, modules: ["Leads"] })
      ).rows[0];
      await expect(
        decideRow(t.db, {
          tenantId: A.tenantId,
          userId: A.userId,
          matchId: aRow?.matchId ?? "",
          recordKeyId: await keyId(B, "B1"),
        }),
      ).rejects.toThrow(/not found/);
    });
  });

  it("rebuilds a record's keys when a newer version syncs, and its embedding falls due", async () => {
    const raw = await A.record(
      "Leads",
      "L22",
      {
        First_Name: "Jennifer",
        Last_Name: "Walsh-Ortiz",
        Company: "Walsh Studio",
        Email: "jen.walsh@outlook.com",
      },
      "2026-11-10T10:00:00+00:00",
    );
    const built = await keysAfterSync(t.db, {
      tenantId: A.tenantId,
      connectionId: A.connectionId,
      rawRecordIds: [raw],
    });
    expect(built).toEqual({ built: 1, more: false });
    const [key] = await t.db
      .select()
      .from(crmRecordKey)
      .where(and(eq(crmRecordKey.tenantId, A.tenantId), eq(crmRecordKey.externalId, "L22")));
    expect(key).toMatchObject({
      rawRecordId: raw,
      matchText: "jennifer walsh ortiz | walsh studio",
    });
    // The same page again builds nothing.
    expect(
      await keysAfterSync(t.db, {
        tenantId: A.tenantId,
        connectionId: A.connectionId,
        rawRecordIds: [raw],
      }),
    ).toEqual({ built: 0, more: false });
  });

  it("finds records for the look-up by a typed name, an email or a phone, at most 20, one module", async () => {
    const { withTenant } = await import("@countersign/db");
    const look = (module: string, q: string, limit?: number) =>
      withTenant(t.db, A.tenantId, (tx) => lookupRecords(tx, A.tenantId, { module, q, limit }));
    const byName = await look("Leads", "Robert Chen");
    expect(byName[0]).toMatchObject({
      externalId: "L04",
      name: "Robert Chen",
      company: "Harbor Logistics LLC",
      email: "robert.chen@harborlogistics.com",
    });
    expect((await look("Leads", "Jane.Doe@BlueRidgeMillwork.com"))[0]).toMatchObject({
      externalId: "L01",
      similarity: 1,
    });
    expect((await look("Contacts", "(206) 555-0131"))[0]?.externalId).toBe("C01");
    const deal = (await look("Deals", "northwind renewal")).map((r) => r.externalId).sort();
    expect(deal).toEqual(["D03", "D04"]);
    expect((await look("Deals", "Northwind Q3 Renewal"))[0]).toMatchObject({
      externalId: "D03",
      stage: "Negotiation/Review",
      amount: "42000",
    });
    // A contact isn't in the leads.
    for (const r of await look("Leads", "Rachel Green")) expect(r.module).toBe("Leads");
    expect((await look("Leads", "Rachel Green")).map((r) => r.externalId)).not.toContain("C01");
    expect((await look("Leads", "a", 3)).length).toBeLessThanOrEqual(3);
  });

  it("reads the client's own match fields from the payload by name, custom fields included", async () => {
    const R = await insertSalesClient(t.db, "Regions", {
      settings: { sales: { matchFields: { Leads: ["Region", "Tags"] } } },
    });
    // A re-read after the connection's extra sync fields changed: the same Modified_Time with a
    // suffix, stored later. The newest stored version is the one keyed.
    await R.record("Leads", "R1", { First_Name: "Ann", Last_Name: "Lee", Company: "Fjord Fish" });
    await R.record(
      "Leads",
      "R1",
      {
        First_Name: "Ann",
        Last_Name: "Lee",
        Company: "Fjord Fish",
        Region: "Pacific Northwest",
        Tags: ["Wholesale", "Seafood"],
      },
      "2026-11-01T10:00:00+00:00~a1b2",
    );
    const res = await matchRecords(ctx(R), {
      rows: [{ Name: "Ann Lee", Territory: "Pacific Northwest" }],
      keys: { name: "Name", extra: { Region: "Territory" } },
      modules: ["Leads"],
    });
    const [key] = await t.db
      .select()
      .from(crmRecordKey)
      .where(eq(crmRecordKey.tenantId, R.tenantId));
    expect(key?.matchText).toBe("ann lee | fjord fish | pacific northwest | wholesale seafood");
    expect(key?.display).toMatchObject({ Region: "Pacific Northwest", name: "Ann Lee" });
    // The row's text holds its territory too, so the record comes up by text.
    expect(res.rows[0]?.candidates[0]).toMatchObject({ externalId: "R1", foundBy: ["text"] });
  });

  describe("by meaning and the model", () => {
    let M: SalesFixture;
    const keys: KeyMapping = { name: "Name", company: "Company", email: "Email" };
    const concepts = {
      "olivia brown | golden gate bakery": 1,
      "liv b | sf sourdough": 1,
    };
    const calls: { tokensIn: number; cost: string | null }[] = [];

    const llm = (model: FakeModel, transport = conceptTransport(concepts)): LlmClient =>
      createLlmClient({
        transport: { create: (r) => model.create(r), embed: transport.embed },
        onCall: async (r) => {
          calls.push({ tokensIn: r.usage.inputTokens, cost: r.costUsd });
        },
        onEmbed: async (r) => {
          calls.push({ tokensIn: r.usage.inputTokens, cost: r.costUsd });
        },
      });

    beforeAll(async () => {
      M = await insertSalesClient(t.db, "Bakeries");
      await M.record("Leads", "M1", {
        First_Name: "Olivia",
        Last_Name: "Brown",
        Company: "Golden Gate Bakery",
        Email: "olivia@ggbakery.com",
      });
      await M.record("Leads", "M2", {
        First_Name: "Oliver",
        Last_Name: "Browning",
        Company: "Golden Gate Bakers Supply",
        Email: "oliver@ggbsupply.com",
      });
    });

    it("finds a row by meaning, embeds the records once, and has the model choose", async () => {
      const model = new FakeModel([
        (request) => {
          const text = JSON.stringify(request.messages);
          const id = /\\"id\\":\\"([0-9a-f-]{36})\\"/.exec(text)?.[1] ?? null;
          return {
            toolUse: {
              name: "record_choice",
              input: {
                decision: "matched",
                record_id: id,
                confidence: 0.93,
                reason: "Liv is Olivia.",
              },
            },
          };
        },
      ]);
      const res = await matchRecords(ctx(M, { llm: llm(model) }), {
        rows: [{ Name: "Liv B", Company: "SF Sourdough" }],
        keys,
        modules: ["Leads"],
      });
      expect(res.meaning).toBe("searched");
      expect(res.keys.embedded).toMatchObject({ embedded: 2, left: 0, refused: false });
      expect(res.rows[0]).toMatchObject({
        decision: "matched",
        method: "model",
        score: 0.93,
        reason: "Liv is Olivia.",
        record: { externalId: "M1" },
      });
      expect(res.rows[0]?.candidates[0]?.foundBy).toEqual(["meaning"]);
      // The row and the candidates go to the model as data inside their tags.
      const sent = JSON.stringify(model.requests[0]?.messages);
      expect(sent).toContain("<row>");
      expect(sent).toContain("<candidates>");
      // The embedding calls and the model call were costed (onEmbed, onCall).
      expect(calls.length).toBeGreaterThanOrEqual(3);
      const keyRows = await t.db
        .select()
        .from(crmRecordKey)
        .where(eq(crmRecordKey.tenantId, M.tenantId));
      for (const k of keyRows) {
        expect(k.embedding).toHaveLength(1024);
        expect(k.embeddedHash).toBe(k.matchHash);
        expect(k.embeddingModel).toBe("openai:text-embedding-3-large");
      }
      // Embedded once: nothing is due now.
      expect(
        await embedDueKeys({ db: t.db, tenantId: M.tenantId, llm: llm(new FakeModel()) }),
      ).toEqual({
        embedded: 0,
        left: 0,
        refused: false,
      });
    });

    it("never matches what the hard rules veto, whatever the model says", async () => {
      const m1 = await keyId(M, "M1");
      const model = new FakeModel([
        {
          toolUse: {
            name: "record_choice",
            input: { decision: "matched", record_id: m1, confidence: 0.99, reason: "Same name." },
          },
        },
      ]);
      const res = await matchRecords(ctx(M, { llm: llm(model) }), {
        rows: [
          { Name: "Olivia Brown", Company: "Golden Gate Bakery", Email: "o.brown@elsewhere.com" },
        ],
        keys,
        modules: ["Leads"],
      });
      const row = res.rows[0];
      expect(row?.decision).toBe("unsure");
      expect(row?.candidates.find((c) => c.externalId === "M1")?.vetoed).toBe("email");
      // The vetoed record wasn't offered to the model.
      expect(JSON.stringify(model.requests[0]?.messages ?? "")).not.toContain(m1);
    });

    it("takes the model's none, and an unusable answer as unsure", async () => {
      const none = await matchRecords(
        ctx(M, {
          llm: llm(
            new FakeModel([
              {
                toolUse: {
                  name: "record_choice",
                  input: {
                    decision: "none",
                    record_id: null,
                    confidence: 0.95,
                    reason: "Another bakery.",
                  },
                },
              },
            ]),
          ),
        }),
        {
          rows: [{ Name: "Olive Brownstone", Company: "Golden Gate Bagels" }],
          keys,
          modules: ["Leads"],
        },
      );
      expect(none.rows[0]).toMatchObject({ decision: "none", method: "model" });
      const broken = await matchRecords(
        ctx(M, { llm: llm(new FakeModel([{ text: "I think it is Olivia." }])) }),
        {
          rows: [{ Name: "Olive Brownstone", Company: "Golden Gate Bagels" }],
          keys,
          modules: ["Leads"],
        },
      );
      expect(broken.rows[0]).toMatchObject({ decision: "unsure", needsReview: true });
    });

    it("calls a row nobody's when no record is near it by keys, text or meaning", async () => {
      const res = await matchRecords(ctx(M, { llm: llm(new FakeModel()) }), {
        rows: [{ Name: "Zed Quill", Company: "Northern Lights Optics" }],
        keys,
        modules: ["Leads"],
      });
      expect(res.rows[0]).toMatchObject({
        decision: "none",
        method: "meaning",
        score: 0.9,
        candidates: [],
      });
    });

    it("goes on without meaning when HIPAA mode refuses the embeddings", async () => {
      const refusing = {
        create: (_: LlmRequest) => Promise.reject(new Error("no message here")),
        embed: async () => {
          throw new ComplianceRefusal(
            "The search by meaning sends data to OpenAI, which has no signed BAA",
          );
        },
      };
      const N = await insertSalesClient(t.db, "HIPAA clinic");
      await N.record("Leads", "N1", {
        First_Name: "Olivia",
        Last_Name: "Brown",
        Company: "Golden Gate Bakery",
        Email: "olivia@ggbakery.com",
      });
      const res = await matchRecords(ctx(N, { llm: createLlmClient({ transport: refusing }) }), {
        rows: [{ Email: "olivia@ggbakery.com" }, { Name: "Liv B", Company: "SF Sourdough" }],
        keys,
        modules: ["Leads"],
      });
      expect(res.keys.embedded).toMatchObject({ embedded: 0, refused: true });
      expect(res.meaning).toBe("refused");
      expect(res.rows[0]).toMatchObject({ decision: "matched", method: "key" });
      // Nothing searched by meaning: a row with no candidate waits for a person.
      expect(res.rows[1]).toMatchObject({ decision: "unsure", score: 0.8 });
      const [k] = await t.db
        .select()
        .from(crmRecordKey)
        .where(eq(crmRecordKey.tenantId, N.tenantId));
      expect(k?.embedding).toBeNull();
    });
  });
});
