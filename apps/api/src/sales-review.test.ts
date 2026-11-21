// Confirm matches through the API (docs/plan.md §1.164 "Confirm matches", "The look-up"): the Sales
// pack's card `sales.match` on the client's Desk and the back office's Escalations, through the
// platform's generic pack-review routes. The look-up searches the item's client's synced records
// only (invariant 1), at most 20, for someone who decides the card, and is audited through
// `mount()`. Finishing hands the run what was recorded, never what the browser sent. No portal
// answer carries a bundle, prompt or cost (invariant 11).

import { allRoutes, forbiddenPortalFields, routeFamily } from "@countersign/core";
import {
  agent,
  agentVersion,
  auditEvent,
  connection,
  inboxItem,
  rawRecord,
  tenantPack,
  withTenant,
} from "@countersign/db";
import {
  crmAlias,
  crmRecordKey,
  MATCH_REVIEW,
  type MatchRecordsResult,
  matchRecords,
  refreshRecordKeys,
} from "@countersign/pack-sales";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type J = any;
const j = (v: unknown) => v as J;

const h = await createApiHarness();
afterAll(() => h?.close());

describe("the look-up's contract", () => {
  it("is a client route and its back-office twin, neither returning bundles, prompts or cost", () => {
    const portal = allRoutes.portalPackReviewLookup;
    const ops = allRoutes.opsPackReviewLookup;
    expect(portal.path).toBe("/api/inbox/:id/pack-review/lookup");
    expect(routeFamily(portal)).not.toBe("ops");
    expect(ops.roles).toEqual(["operator"]);
    expect(forbiddenPortalFields(portal.response)).toEqual([]);
  });
});

describe.skipIf(!h)("Confirm matches through the API", () => {
  const H = h as ApiHarness;
  const zoho: Record<string, string> = {};
  let result: MatchRecordsResult;
  let itemId = "";
  const path = () => `/api/inbox/${itemId}/pack-review`;

  async function client(tenantId: string, records: [string, string, Record<string, unknown>][]) {
    await H.t.db.insert(tenantPack).values({ tenantId, pack: "sales", version: "0.2.0" });
    const [conn] = await H.t.db
      .insert(connection)
      .values({ tenantId, connector: "zoho_crm", status: "connected", externalAccountId: "org" })
      .returning();
    for (const [module, id, payload] of records) {
      await H.t.db.insert(rawRecord).values({
        tenantId,
        connectionId: conn?.id as string,
        connector: "zoho_crm",
        entityType: module,
        externalId: id,
        externalVersion: "2026-11-01T10:00:00+00:00",
        payload: { id, Modified_Time: "2026-11-01T10:00:00+00:00", ...payload },
      });
    }
    await withTenant(H.t.db, tenantId, (tx) => refreshRecordKeys(tx, tenantId, {}));
    const keys = await H.t.db
      .select()
      .from(crmRecordKey)
      .where(eq(crmRecordKey.tenantId, tenantId));
    for (const k of keys) zoho[`${tenantId}:${k.externalId}`] = k.id;
  }
  const key = (tenantId: string, id: string) => zoho[`${tenantId}:${id}`] as string;

  beforeAll(async () => {
    const A = H.A.tenantId;
    await client(A, [
      [
        "Leads",
        "L1",
        {
          First_Name: "Jane",
          Last_Name: "Doe",
          Company: "Blue Ridge Millwork",
          Email: "jane.doe@blueridgemillwork.com",
        },
      ],
      [
        "Leads",
        "L2",
        {
          First_Name: "Sam",
          Last_Name: "Okafor",
          Company: "Harbor Supply Co",
          Email: "sam@harborsupply.com",
        },
      ],
      [
        "Leads",
        "L3",
        {
          First_Name: "Samuel",
          Last_Name: "Okafor",
          Company: "Harbor Supply Company",
          Email: "s.okafor@harbor-supply.net",
        },
      ],
      [
        "Deals",
        "D1",
        {
          Deal_Name: "Harbor Supply renewal",
          Account_Name: "Harbor Supply Co",
          Stage: "Negotiation",
          Amount: 12000,
        },
      ],
    ]);
    // Client B has its own Sam Okafor at Harbor Supply.
    await client(H.B.tenantId, [
      [
        "Leads",
        "B1",
        {
          First_Name: "Sam",
          Last_Name: "Okafor",
          Company: "Harbor Supply Co",
          Email: "sam.okafor@elsewhere.com",
        },
      ],
    ]);
    const [a] = await H.t.db
      .insert(agent)
      .values({ tenantId: A, kind: "client", slug: "sheet-to-zoho", name: "Spreadsheet to Zoho" })
      .returning();
    const [v] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId: A,
        agentId: a?.id as string,
        version: 1,
        bundle: testBundle("Spreadsheet to Zoho"),
        bundleHash: "sheet",
        status: "live",
        authorType: "operator",
      })
      .returning();
    result = await matchRecords(
      {
        tenantId: A,
        agentVersionId: v?.id as string,
        runId: null,
        stepId: "match",
        mode: "live",
        settings: {},
        db: H.t.db,
        llm: null,
      },
      {
        rows: [
          { Email: "jane.doe@blueridgemillwork.com", First_Name: "Jane", Last_Name: "Doe" },
          { First_Name: "Sam", Last_Name: "Okafor", Company: "Harbor Supply" },
          { First_Name: "Nobody", Last_Name: "Known", Company: "Nowhere Ltd" },
        ],
        keys: {
          email: "Email",
          firstName: "First_Name",
          lastName: "Last_Name",
          company: "Company",
        },
        modules: ["Leads", "Deals"],
      },
    );
    const [item] = await H.t.db
      .insert(inboxItem)
      .values({
        tenantId: A,
        kind: "request",
        agentId: a?.id,
        title: "2 rows of your spreadsheet need you",
        assigneeRole: "client_admin",
        payload: {
          review: MATCH_REVIEW,
          batchId: result.batchId,
          modules: result.modules,
          threshold: result.threshold,
          sheet: result.sheet,
          nodeId: "confirm",
          mode: "ask",
        },
      })
      .returning();
    itemId = item?.id as string;
  });

  it("shows the client admin the unsure rows first, with nothing of ours", async () => {
    const res = await H.call(admin("a"), "GET", path());
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ review: MATCH_REVIEW, status: "open", canDecide: true });
    expect(forbiddenKeys(res.json, /cost|token|prompt|instruction|bundle/i)).toEqual([]);
    const rows = j(res.json).data.rows as J[];
    expect(rows.map((r) => [r.index, r.agent.decision])).toEqual([
      [1, "unsure"],
      [2, "unsure"],
      [0, "matched"],
    ]);
    expect(rows[2].agent).toMatchObject({ confidence: "high", found: "email" });
    // Another client and a client user it isn't assigned to see nothing.
    expect((await H.call(admin("b"), "GET", path())).status).toBe(404);
    expect((await H.call(user("a"), "GET", path())).status).toBe(404);
  });

  it("looks up this client's records only, at most 20, and audits each search", async () => {
    const res = await H.call(admin("a"), "GET", `${path()}/lookup?q=Okafor`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const records = j(res.json).records as J[];
    expect(records.map((r) => r.externalId).sort()).toEqual(["L2", "L3"]);
    expect(records.length).toBeLessThanOrEqual(20);
    expect(records[0]).toMatchObject({
      recordKeyId: expect.any(String),
      name: expect.stringContaining("Okafor"),
      company: expect.stringContaining("Harbor Supply"),
      email: expect.any(String),
    });
    expect(forbiddenKeys(res.json, /cost|token|prompt|instruction|bundle/i)).toEqual([]);
    // A deal comes with its stage and amount.
    const deals = await H.call(
      admin("a"),
      "GET",
      `${path()}/lookup?module=Deals&q=Harbor%20renewal`,
    );
    expect(j(deals.json).records[0]).toMatchObject({
      externalId: "D1",
      stage: "Negotiation",
      amount: "12000",
    });
    // A module the match didn't search, an empty search, another client, a user not assigned.
    expect(
      (await H.call(admin("a"), "GET", `${path()}/lookup?module=Accounts&q=Harbor`)).status,
    ).toBe(422);
    expect((await H.call(admin("a"), "GET", `${path()}/lookup?q=`)).status).toBe(400);
    expect((await H.call(admin("b"), "GET", `${path()}/lookup?q=Okafor`)).status).toBe(404);
    expect((await H.call(user("a"), "GET", `${path()}/lookup?q=Okafor`)).status).toBe(404);
    // The back office reads the card, but the item is the client admin's: no search from it.
    expect((await H.call(OPERATOR, "GET", `/api/ops/inbox/${itemId}/pack-review`)).status).toBe(
      200,
    );
    expect(
      (await H.call(OPERATOR, "GET", `/api/ops/inbox/${itemId}/pack-review/lookup?q=Okafor`))
        .status,
    ).toBe(403);
    const audited = await H.t.db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.tenantId, H.A.tenantId),
          eq(auditEvent.action, "GET /api/inbox/:id/pack-review/lookup"),
        ),
      );
    expect(audited.length).toBeGreaterThanOrEqual(1);
  });

  it("refuses another client's record, and won't finish while a row waits", async () => {
    const theirs = key(H.B.tenantId, "B1");
    const refused = await H.call(admin("a"), "POST", path(), {
      action: "lookup",
      input: { index: 1, recordKeyId: theirs },
    });
    expect(refused.status).toBe(422);
    expect(j(refused.json).error.message).toMatch(/isn't one of yours/);
    const early = await H.call(admin("a"), "POST", `/api/inbox/${itemId}/resolve`, {
      decision: "approve",
      answer: { matches: "anything" },
    });
    expect(early.status).toBe(422);
    expect(JSON.stringify(early.json)).toMatch(/still waiting on you/);
  });

  it("remaps through the look-up and approves, teaching aliases; the run gets what was recorded", async () => {
    const A = H.A.tenantId;
    const looked = j(
      (await H.call(admin("a"), "GET", `${path()}/lookup?q=sam@harborsupply.com`)).json,
    ).records as J[];
    // The exact email first, then names like it.
    expect(looked[0]).toMatchObject({ externalId: "L2", similarity: 1 });
    const remap = await H.call(admin("a"), "POST", path(), {
      action: "lookup",
      input: { index: 1, recordKeyId: looked[0].recordKeyId },
    });
    expect(remap.status, JSON.stringify(remap.json)).toBe(200);
    const no = await H.call(admin("a"), "POST", path(), {
      action: "no_match",
      input: { index: 2 },
    });
    expect(no.status).toBe(200);
    const rows = j(no.json).data.rows as J[];
    expect(rows.find((r) => r.index === 1)).toMatchObject({
      decision: "matched",
      decidedBy: "person",
      record: { externalId: "L2" },
    });
    const taught = await H.t.db.select().from(crmAlias).where(eq(crmAlias.tenantId, A));
    expect(taught.map((t) => t.externalId)).toEqual(["L2"]);

    const done = await H.call(admin("a"), "POST", `/api/inbox/${itemId}/resolve`, {
      decision: "approve",
      answer: { matches: "anything" },
    });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const [item] = await H.t.db.select().from(inboxItem).where(eq(inboxItem.id, itemId));
    const answer = j(item?.resolution).answer;
    expect(answer).toMatchObject({
      batchId: result.batchId,
      none: [2],
      unsure: [],
      matches: [
        { index: 0, externalId: "L1", decidedBy: "agent" },
        { index: 1, externalId: "L2", decidedBy: "person" },
      ],
    });
    expect(JSON.stringify(answer)).not.toContain("anything");
    // A closed card: no more searches from it.
    expect((await H.call(admin("a"), "GET", `${path()}/lookup?q=Okafor`)).status).toBe(409);
  });
});
