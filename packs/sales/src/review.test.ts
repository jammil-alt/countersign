// Confirm matches against a database (docs/plan.md §1.164 "Confirm matches"): the card's rows, the
// unsure first, each with the sheet's values beside the record's and the differences marked; a
// person's Approve, pick and look-up recorded as `human` decisions that teach an alias, No match
// teaching nothing; decisions checked (a record of another client or another module refused); the
// confirmed matches the updates read; the look-up held to the batch's modules and the client.

import { withTenant } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type MatchRecordsResult, matchRecords } from "./match/match";
import type { PackToolContext } from "./pack";
import {
  compareValues,
  confidenceWord,
  confirmedMatches,
  decideMatchReview,
  lookupForReview,
  MATCH_REVIEW,
  matchReviewAnswer,
  matchReviewView,
  SALES_REVIEWS,
} from "./review";
import { crmAlias, crmMatch, crmRecordKey } from "./schema";
import { refreshRecordKeys } from "./store";
import { insertSalesClient, type SalesFixture } from "./testing.test-helper";
import { confirmedMatchesTool } from "./tools";

for (const level of ["warn", "error"] as const) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const online = await databaseAvailable();

describe("the card's words", () => {
  it("says the confidence in words by the step's threshold", () => {
    expect(confidenceWord(0.95)).toBe("high");
    expect(confidenceWord(0.9)).toBe("high");
    expect(confidenceWord(0.85)).toBe("medium");
    expect(confidenceWord(0.7)).toBe("medium");
    expect(confidenceWord(0.69)).toBe("low");
    expect(confidenceWord(0.85, 0.8)).toBe("high");
  });

  it("marks a difference only where both have a value and they differ once normalised", () => {
    const out = compareValues(
      { firstName: "Jane", lastName: "Doe", email: "JANE.DOE@acme.com", company: "Acme Inc." },
      { name: "Jane Doe", email: "jane.doe@acme.com", company: "Acme Supply", phone: "+15551234" },
    );
    expect(out).toEqual([
      { field: "name", sheet: "Jane Doe", record: "Jane Doe", differs: false },
      { field: "company", sheet: "Acme Inc.", record: "Acme Supply", differs: true },
      { field: "email", sheet: "JANE.DOE@acme.com", record: "jane.doe@acme.com", differs: false },
      { field: "phone", sheet: null, record: "+15551234", differs: false },
    ]);
  });
});

describe.skipIf(!online)("Confirm matches", () => {
  let t: TestDatabase;
  let A: SalesFixture;
  let B: SalesFixture;
  let result: MatchRecordsResult;
  let payload: Record<string, unknown>;

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
  const view = () => withTenant(t.db, A.tenantId, (tx) => matchReviewView(tx, A.tenantId, payload));
  const decide = (decision: unknown, over: Partial<{ payload: Record<string, unknown> }> = {}) =>
    decideMatchReview(t.db, {
      tenantId: A.tenantId,
      userId: A.userId,
      payload: over.payload ?? payload,
      decision,
      testRun: false,
    });
  const aliases = async () =>
    (
      await t.db
        .select({ n: sql<number>`count(*)::int` })
        .from(crmAlias)
        .where(eq(crmAlias.tenantId, A.tenantId))
    )[0]?.n ?? 0;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertSalesClient(t.db, "Blue Ridge Sales");
    B = await insertSalesClient(t.db, "Other Client");
    await A.record("Leads", "L1", {
      First_Name: "Jane",
      Last_Name: "Doe",
      Company: "Blue Ridge Millwork",
      Email: "jane.doe@blueridgemillwork.com",
    });
    await A.record("Leads", "L2", {
      First_Name: "Sam",
      Last_Name: "Okafor",
      Company: "Harbor Supply Co",
      Email: "sam@harborsupply.com",
    });
    await A.record("Leads", "L3", {
      First_Name: "Samuel",
      Last_Name: "Okafor",
      Company: "Harbor Supply Company",
      Email: "s.okafor@harbor-supply.net",
    });
    await A.record("Deals", "D1", {
      Deal_Name: "Harbor Supply renewal",
      Account_Name: "Harbor Supply Co",
      Stage: "Negotiation",
      Amount: 12000,
    });
    // B holds a Sam Okafor too: never A's to see or pick.
    await B.record("Leads", "B1", {
      First_Name: "Sam",
      Last_Name: "Okafor",
      Company: "Harbor Supply Co",
      Email: "sam.okafor@elsewhere.com",
    });
    // Every module's keys, both clients' (sync builds them; here, as the match would).
    for (const c of [A, B]) {
      await withTenant(t.db, c.tenantId, (tx) => refreshRecordKeys(tx, c.tenantId, {}));
    }
    result = await matchRecords(ctx(A), {
      rows: [
        { Email: "jane.doe@blueridgemillwork.com", First_Name: "Jane", Last_Name: "Doe" },
        { First_Name: "Sam", Last_Name: "Okafor", Company: "Harbor Supply" },
        { First_Name: "Nobody", Last_Name: "Known", Company: "Nowhere Ltd" },
      ],
      keys: { email: "Email", firstName: "First_Name", lastName: "Last_Name", company: "Company" },
      modules: ["Leads"],
    });
    payload = {
      review: MATCH_REVIEW,
      batchId: result.batchId,
      modules: result.modules,
      threshold: result.threshold,
      sheet: result.sheet,
    };
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("shows the unsure rows first, each beside its record, and how it was found", async () => {
    expect(result.counts.matched).toBe(1);
    expect(result.anyNeedsReview).toBe(true);
    const v = await view();
    expect(v.rows.map((r) => [r.index, r.agent.decision])).toEqual([
      [1, "unsure"],
      [2, "unsure"],
      [0, "matched"],
    ]);
    const [sam, nobody, jane] = v.rows;
    expect(jane).toMatchObject({
      decision: "matched",
      decidedBy: "agent",
      agent: { method: "key", confidence: "high", found: "email" },
      record: { values: { name: "Jane Doe", company: "Blue Ridge Millwork" } },
    });
    // Sam: two Okafors at Harbor Supply, suggested, with the company written differently.
    expect(sam?.suggested).toBe(true);
    expect(sam?.candidates.map((c) => c.externalId).sort()).toEqual(["L2", "L3"]);
    expect(sam?.sheet).toEqual({ firstName: "Sam", lastName: "Okafor", company: "Harbor Supply" });
    expect(sam?.compare.find((c) => c.field === "name")).toMatchObject({ sheet: "Sam Okafor" });
    expect(nobody).toMatchObject({ record: null, candidates: [] });
    expect(v.counts).toMatchObject({ unsure: 2, matched: 1, waiting: 2, decided: 0 });
  });

  it("refuses a decision outside the card, the client or its modules", async () => {
    const theirs = await keyId(B, "B1");
    const deal = await keyId(A, "D1");
    await expect(
      decide({ action: "lookup", input: { index: 1, recordKeyId: theirs } }),
    ).rejects.toThrow(/isn't one of yours/);
    await expect(
      decide({ action: "lookup", input: { index: 1, recordKeyId: deal } }),
    ).rejects.toThrow(/pick a record from Leads/);
    await expect(
      decide({ action: "pick", input: { index: 1, recordKeyId: await keyId(A, "L1") } }),
    ).rejects.toThrow(/isn't one of this row's candidates/);
    await expect(decide({ action: "approve", input: { index: 9 } })).rejects.toThrow(
      /isn't part of this review/,
    );
    await expect(decide({ action: "approve", input: { index: 2 } })).rejects.toThrow(
      /no suggestion/,
    );
    await expect(decide({ action: "delete", input: {} })).rejects.toThrow(/decide a row/);
    expect(await aliases()).toBe(0);
  });

  it("refuses to finish while a row waits, and looks up only the batch's modules", async () => {
    await expect(
      withTenant(t.db, A.tenantId, (tx) => matchReviewAnswer(tx, A.tenantId, payload)),
    ).rejects.toThrow(/2 rows are still waiting on you/);
    const found = await withTenant(t.db, A.tenantId, (tx) =>
      lookupForReview(tx, A.tenantId, payload, { q: "Okafor" }),
    );
    expect(found.map((r) => r.externalId).sort()).toEqual(["L2", "L3"]);
    await expect(
      withTenant(t.db, A.tenantId, (tx) =>
        lookupForReview(tx, A.tenantId, payload, { module: "Deals", q: "Harbor" }),
      ),
    ).rejects.toThrow(/look up in Leads/);
    // With Deals in the batch, a deal's stage and amount come back.
    const deals = await withTenant(t.db, A.tenantId, (tx) =>
      lookupForReview(
        tx,
        A.tenantId,
        { ...payload, modules: ["Leads", "Deals"] },
        { module: "Deals", q: "Harbor Supply renewal" },
      ),
    );
    expect(deals[0]).toMatchObject({ externalId: "D1", stage: "Negotiation", amount: "12000" });
  });

  it("records a pick and a look-up as a person's, teaching aliases; No match teaches nothing", async () => {
    const l3 = await keyId(A, "L3");
    await decide({ action: "pick", input: { index: 1, recordKeyId: l3 } });
    await decide({ action: "no_match", input: { index: 2 } });
    expect(await aliases()).toBe(1);
    // A look-up's record remaps the row again: a new decision, the alias moved.
    const l2 = await keyId(A, "L2");
    await decide({ action: "lookup", input: { index: 1, recordKeyId: l2 } });
    expect(await aliases()).toBe(1);
    const [alias] = await t.db.select().from(crmAlias).where(eq(crmAlias.tenantId, A.tenantId));
    expect(alias?.externalId).toBe("L2");
    // Approve all High: Jane's key match, confirmed by a person.
    await decide({ action: "approve_high", input: {} });
    const v = await view();
    expect(
      v.rows.map((r) => [r.index, r.decision, r.decidedBy, r.record?.externalId ?? null]),
    ).toEqual([
      [1, "matched", "person", "L2"],
      [2, "none", "person", null],
      [0, "matched", "person", "L1"],
    ]);
    // History is kept: the agent's three, then four of a person's.
    const all = await t.db
      .select({ method: crmMatch.method })
      .from(crmMatch)
      .where(eq(crmMatch.batchId, result.batchId));
    expect(all.filter((m) => m.method === "human")).toHaveLength(4);
  });

  it("finishes with the confirmed matches, which the update step reads with the rows' fields", async () => {
    const answer = await withTenant(t.db, A.tenantId, (tx) =>
      matchReviewAnswer(tx, A.tenantId, payload),
    );
    expect(answer).toMatchObject({
      batchId: result.batchId,
      none: [2],
      unsure: [],
      matches: [
        { index: 0, externalId: "L1", decidedBy: "person", modifiedTime: expect.any(String) },
        { index: 1, externalId: "L2", decidedBy: "person", method: "human" },
      ],
    });
    const out = (await confirmedMatchesTool.run(
      {
        batchId: result.batchId,
        rows: [
          { Email: "jane.doe@blueridgemillwork.com", Lead_Status: "Contacted", id: "x" },
          { Company: "Harbor Supply", Region: "", Lead_Status: "Qualified" },
          { Company: "Nowhere Ltd" },
        ],
        omit: ["Email"],
      },
      ctx(A),
    )) as { updates: unknown[]; count: number; none: number[]; empty: number[] };
    expect(out).toMatchObject({
      count: 2,
      none: [2],
      empty: [],
      updates: [
        {
          index: 0,
          module: "Leads",
          id: "L1",
          fields: { Lead_Status: "Contacted" },
          expectedModifiedTime: "2026-11-01T10:00:00+00:00",
        },
        { index: 1, id: "L2", fields: { Company: "Harbor Supply", Lead_Status: "Qualified" } },
      ],
    });
    // Another client reads none of A's batch.
    const theirs = await withTenant(t.db, B.tenantId, (tx) =>
      confirmedMatches(tx, B.tenantId, result.batchId),
    );
    expect(theirs.matches).toEqual([]);
  });

  it("is registered under its review key with a look-up and an answer", () => {
    const h = SALES_REVIEWS[MATCH_REVIEW];
    expect(typeof h?.lookup).toBe("function");
    expect(typeof h?.answer).toBe("function");
  });
});
