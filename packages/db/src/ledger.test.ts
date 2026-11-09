// The ledger per accounting connection (docs/plan.md §1.79): an account is unique by connection and
// the tool's id, so a second company's chart sits beside the first with the same ids; the read
// helper lists accounts with the people's notes first, and classes and locations; another client
// sees none of it. Its kinds are core's.

import { LEDGER_KIND_VALUES } from "@countersign/core";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { ledgerChart, ledgerDimensions } from "./ledger";
import {
  connection,
  LEDGER_KINDS,
  ledgerAccount,
  ledgerAccountNote,
  ledgerDimension,
} from "./schema";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

describe("the ledger's kinds", () => {
  it("are core's, so the mappers and the check agree", () => {
    expect([...LEDGER_KINDS]).toEqual([...LEDGER_KIND_VALUES]);
  });
});

describe.skipIf(!online)("the ledger, per accounting connection", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;
  let second = "";

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "Ledger A");
    B = await insertClient(t.db, "Ledger B");
    // A second company of client A (another entity): its account 7 is another account.
    const [c] = await t.db
      .insert(connection)
      .values({ tenantId: A.tenantId, connector: "qbo" })
      .returning();
    second = c?.id ?? "";
    await t.db.insert(ledgerAccount).values({
      tenantId: A.tenantId,
      connectionId: second,
      connector: "qbo",
      externalId: "7",
      name: "Materials (East)",
      fullName: "Materials (East)",
      classification: "expense",
      kind: "cost_of_goods",
      accountType: "Cost of Goods Sold",
    });
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("keeps each connection's accounts apart, even with the same ids", async () => {
    const rows = await t.db
      .select()
      .from(ledgerAccount)
      .where(and(eq(ledgerAccount.tenantId, A.tenantId), eq(ledgerAccount.externalId, "7")));
    expect(rows.map((r) => r.name).sort()).toEqual(["Job materials", "Materials (East)"]);
  });

  it("lists the chart with the people's notes first, filtered by connection or kind", async () => {
    const [job] = await t.db
      .select()
      .from(ledgerAccount)
      .where(
        and(eq(ledgerAccount.tenantId, A.tenantId), eq(ledgerAccount.connectionId, A.connectionId)),
      );
    await t.db.insert(ledgerAccountNote).values({
      tenantId: A.tenantId,
      ledgerAccountId: job?.id ?? "",
      note: "Mostly sheet goods from Keystone.",
      source: "agent",
      agentVersionId: A.agentVersionId,
      sources: [A.rawRecordId],
    });
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      const all = await ledgerChart(tx, A.tenantId);
      expect(all.map((a) => a.fullName)).toEqual(["Job materials", "Materials (East)"]);
      const first = await ledgerChart(tx, A.tenantId, { connectionId: A.connectionId });
      expect(first.map((a) => [a.fullName, a.kind, a.type])).toEqual([
        ["Job materials", "cost_of_goods", "Cost of Goods Sold"],
      ]);
      // The newer agent note comes after the client's own words.
      expect(first[0]?.notes.map((n) => n.source)).toEqual(["client", "agent"]);
      expect(await ledgerChart(tx, A.tenantId, { kinds: ["bank", "card"] })).toEqual([]);
      const classes = await ledgerDimensions(tx, A.tenantId, { kind: "class" });
      expect(classes.map((d) => [d.name, d.connectionId])).toEqual([["Shop", A.connectionId]]);
    });
  });

  it("shows another client none of it", async () => {
    await withTenant(t.db, B.tenantId, async (tx) => {
      await asWorker(tx);
      const chart = await ledgerChart(tx, B.tenantId);
      expect(chart.every((a) => a.connectionId === B.connectionId)).toBe(true);
      const dims = await tx
        .select()
        .from(ledgerDimension)
        .where(eq(ledgerDimension.tenantId, A.tenantId));
      expect(dims).toEqual([]);
    });
  });
});
