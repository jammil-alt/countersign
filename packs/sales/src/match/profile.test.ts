// The CRM records profile on a throwaway database (step model §7, §10e): rows matched to a client's
// synced Zoho records by email, phone and website through the one Match port, names and meaning
// left to a model, two different emails never the same, a person's answer learned (a crm_match row
// of theirs and an alias) so it is an exact hit next time, a test run learning nothing, and one
// client never reaching another's records (invariant 1).

import { readFileSync } from "node:fs";
import { ComplianceRefusal, createMatchPort, type ProfileChooser, steps } from "@countersign/core";
import { withTenant } from "@countersign/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "@countersign/db/testing";
import { createLlmClient, type EmbedRequest, type LlmRequest } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PackToolContext } from "../pack";
import { crmAlias, crmMatch, crmRecordKey } from "../schema";
import { refreshRecordKeys } from "../store";
import { insertSalesClient, type SalesFixture } from "../testing.test-helper";
import { CRM_RECORDS_MATCHER } from "./profile";

const online = await databaseAvailable();

const golden = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/matching/crm/leads-and-deals.json", import.meta.url),
    "utf8",
  ),
) as { records: { id: string; module: string; payload: Record<string, unknown> }[] };

describe.skipIf(!online)("the CRM records profile", () => {
  let t: TestDatabase;
  let A: SalesFixture;
  let B: SalesFixture;
  const port = createMatchPort([CRM_RECORDS_MATCHER]);
  const ctx = (c: SalesFixture, mode: "live" | "test" = "live"): PackToolContext => ({
    tenantId: c.tenantId,
    agentVersionId: c.agentVersionId,
    runId: null,
    stepId: "match",
    mode,
    settings: {},
    db: t.db,
    llm: null,
  });
  const keyId = async (c: SalesFixture, externalId: string) => {
    const [k] = await t.db
      .select({ id: crmRecordKey.id })
      .from(crmRecordKey)
      .where(and(eq(crmRecordKey.tenantId, c.tenantId), eq(crmRecordKey.externalId, externalId)));
    return k?.id ?? "";
  };
  const one = async (
    c: SalesFixture,
    s: Record<string, unknown>,
    item: Record<string, unknown>,
    choose?: ProfileChooser,
  ) => {
    const r = await port.match({
      ctx: ctx(c),
      settings: steps.MatchSettings.parse({ to: "crm-records", ...s }),
      items: [item],
      choose,
    });
    return { ...r.output.items[0], note: r.notes[0] };
  };

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertSalesClient(t.db, "Blue Ridge Sales");
    B = await insertSalesClient(t.db, "Other Client");
    for (const r of golden.records) await A.record(r.module, r.id, r.payload);
    await B.record("Leads", "B1", {
      First_Name: "Jane",
      Last_Name: "Doe",
      Company: "Blue Ridge Millwork",
      Email: "jane.doe@blueridgemillwork.com",
    });
    // The sync keeps the keys (`SALES_SYNCED`); here, as it would have.
    for (const c of [A, B]) {
      await withTenant(t.db, c.tenantId, (tx) => refreshRecordKeys(tx, c.tenantId, {}));
    }
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("matches by email, the client's own record only", async () => {
    const jane = await keyId(A, "L01");
    const r = await one(A, { type: "exact" }, { email: "Jane.Doe@BlueRidgeMillwork.com" });
    expect(r).toMatchObject({ matched: jane, how: "exact", confidence: 100 });
    expect(r.note?.rule).toBe("key:email");
    const b = await one(B, { type: "exact" }, { email: "jane.doe@blueridgemillwork.com" });
    expect(b.matched).toBe(await keyId(B, "B1"));
    // Narrowed to a module the record isn't in: nothing.
    expect(
      await one(A, { type: "exact" }, { email: "jane.doe@blueridgemillwork.com", module: "Deals" }),
    ).toMatchObject({ matched: null });
  });

  it("leaves names to the model, which never sees a record with another email", async () => {
    const jane = await keyId(A, "L01");
    let shown: string[] = [];
    const choose: ProfileChooser = async (q) => {
      shown = q.candidates.map((c) => c.id);
      return { record_id: shown[0] ?? null, confidence: 0.95, reason: "same person" };
    };
    const byName = await one(
      A,
      { type: "hybrid" },
      { name: "Jane Doe", company: "Blue Ridge Millwork", module: "Leads" },
      choose,
    );
    expect(byName).toMatchObject({ matched: jane, how: "semantic" });
    shown = [];
    const other = await one(
      A,
      { type: "hybrid" },
      { name: "Jane Doe", email: "jane@elsewhere.example", module: "Leads" },
      choose,
    );
    expect(shown).not.toContain(jane);
    expect(other.note?.vetoed).toContainEqual({ record: jane, rule: "email" });
  });

  it("learns a person's answer as theirs, an exact hit next time; a test run learns nothing", async () => {
    const jane = await keyId(A, "L01");
    const item = { name: "J. Doe (BRM)", company: "BRM", module: "Leads" };
    expect(await one(A, { type: "exact" }, item)).toMatchObject({ matched: null });
    const by = { personId: A.userId, stepId: "confirm" };
    expect(
      await port.learn({ ctx: ctx(A, "test"), profile: "crm-records", item, recordId: jane, by }),
    ).toBe(true);
    expect(await one(A, { type: "exact" }, item)).toMatchObject({ matched: null });
    expect(
      await port.learn({ ctx: ctx(A), profile: "crm-records", item, recordId: jane, by }),
    ).toBe(true);
    expect(await one(A, { type: "exact" }, item)).toMatchObject({ matched: jane, how: "learned" });
    const [decision] = await t.db
      .select()
      .from(crmMatch)
      .where(and(eq(crmMatch.tenantId, A.tenantId), eq(crmMatch.method, "human")));
    expect(decision).toMatchObject({
      decidedByUserId: A.userId,
      recordKeyId: jane,
      step: "confirm",
    });
    const aliases = await t.db.select().from(crmAlias).where(eq(crmAlias.tenantId, A.tenantId));
    expect(aliases).toHaveLength(1);
    // Never another client's record, and never one a hard rule rules out.
    await expect(
      port.learn({ ctx: ctx(B), profile: "crm-records", item, recordId: jane, by }),
    ).rejects.toThrow(/no crm records record/);
    await expect(
      port.learn({
        ctx: ctx(A),
        profile: "crm-records",
        item: { email: "someone@else.example", module: "Leads" },
        recordId: jane,
        by,
      }),
    ).rejects.toThrow(/email/);
  });

  it("matches by name when the client's compliance refuses embeddings: nothing fails", async () => {
    const jane = await keyId(A, "L01");
    const calls: string[][] = [];
    const llm = createLlmClient({
      transport: {
        create: (_: LlmRequest) => Promise.reject(new Error("no messages here")),
        embed: async (request: EmbedRequest) => {
          calls.push([...request.input]);
          throw new ComplianceRefusal("Embedding with openai isn't covered for this client");
        },
      },
    });
    const r = await port.match({
      ctx: { ...ctx(A), llm },
      settings: steps.MatchSettings.parse({ to: "crm-records", type: "hybrid" }),
      items: [{ name: "Jane Doe", company: "Blue Ridge Millwork", module: "Leads" }],
      choose: async (q) => ({
        record_id: q.candidates[0]?.id ?? null,
        confidence: 0.95,
        reason: "same",
      }),
    });
    expect(calls).toHaveLength(1);
    expect(r.output.items[0]).toMatchObject({ matched: jane, how: "semantic" });
  });
});
