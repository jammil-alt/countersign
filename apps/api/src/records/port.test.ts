// Step model §10f (stream N): the records port on a real database, as the Worker's role. One
// client's records only; custom fields (the client's own and shared, never hidden ones) read and
// written in `ext.custom` beside the area's own keys; every write checked by the record type's
// rules, logged once in record_write with its agent version, before state and evidence, and found
// again by its key on a retry; a test run saves nothing; Find follows a link across record types.

import type { RecordWriteMeta } from "@countersign/agents";
import { runFind } from "@countersign/agents";
import { FindQuery, steps, TRANSACTION_RECORD_TYPE } from "@countersign/core";
import {
  agent,
  agentVersion,
  customField,
  type Db,
  recordWrite,
  run,
  stepRun,
  tenant,
  transaction,
  vendor,
} from "@countersign/db";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from "@countersign/db/testing";
import { packToolContext } from "@countersign/pack-materials";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEPLOYMENT_PACKS, matchPort } from "../packs";
import { dbRecordsPort } from "./port";
import { recordCatalog } from "./registry";

const online = await databaseAvailable();

/** The test database as the Worker reaches it: every transaction as cs_worker, under RLS. */
function asWorkerDb(db: Db): Db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        return <T>(fn: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<T>) =>
          target.transaction(async (tx) => {
            await asWorker(tx);
            return fn(tx);
          });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

interface Client {
  tenantId: string;
  vendorId: string;
  meta: Omit<RecordWriteMeta, "key" | "sources" | "mode">;
}

async function client(db: Db, name: string): Promise<Client> {
  const [t] = await db.insert(tenant).values({ name }).returning();
  if (!t) throw new Error("no tenant");
  const [v] = await db
    .insert(vendor)
    .values({
      tenantId: t.id,
      name: `${name} Lumber`,
      normalizedName: `${name.toLowerCase()} lumber`,
      ext: { senderDomains: [`${name.toLowerCase()}.test`] },
    })
    .returning();
  if (!v) throw new Error("no vendor");
  await db.insert(transaction).values([
    {
      tenantId: t.id,
      kind: "bill",
      connector: "qbo",
      vendorId: v.id,
      txnDate: "2026-11-01",
      total: "1200.0000",
      externalId: `${name}-1`,
    },
    {
      tenantId: t.id,
      kind: "bill",
      connector: "qbo",
      vendorId: v.id,
      txnDate: "2026-11-02",
      total: "300.5000",
      externalId: `${name}-2`,
    },
  ]);
  const [a] = await db
    .insert(agent)
    .values({ tenantId: t.id, kind: "client", slug: "margins", name: "Margins" })
    .returning();
  if (!a) throw new Error("no agent");
  const [av] = await db
    .insert(agentVersion)
    .values({
      tenantId: t.id,
      agentId: a.id,
      version: 1,
      bundle: {} as never,
      bundleHash: `hash-${name}`,
      status: "live",
      authorType: "operator",
    })
    .returning();
  if (!av) throw new Error("no version");
  const [r] = await db
    .insert(run)
    .values({
      tenantId: t.id,
      agentId: a.id,
      agentVersionId: av.id,
      workflowSlug: "work",
      mode: "live",
      status: "running",
      trigger: { type: "manual" },
    })
    .returning();
  if (!r) throw new Error("no run");
  const [sr] = await db
    .insert(stepRun)
    .values({ tenantId: t.id, runId: r.id, nodeId: "tag", nodeType: "tool", status: "running" })
    .returning();
  if (!sr) throw new Error("no step run");
  return {
    tenantId: t.id,
    vendorId: v.id,
    meta: { agentVersionId: av.id, runId: r.id, stepRunId: sr.id },
  };
}

describe.skipIf(!online)("the records port", () => {
  let t: TestDatabase;
  let A: Client;
  let B: Client;
  const catalog = recordCatalog(DEPLOYMENT_PACKS);
  let port: ReturnType<typeof dbRecordsPort>;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await client(t.db, "A");
    B = await client(t.db, "B");
    await t.db.insert(customField).values([
      { tenantId: A.tenantId, recordType: "vendor", name: "region", label: "Region", type: "text" },
      {
        tenantId: A.tenantId,
        recordType: "vendor",
        name: "creditLimit",
        label: "Credit limit",
        type: "money",
      },
      {
        tenantId: A.tenantId,
        recordType: "vendor",
        name: "old",
        label: "Old",
        type: "text",
        hiddenAt: new Date(),
      },
      { tenantId: B.tenantId, recordType: "vendor", name: "bOnly", label: "B only", type: "text" },
      { recordType: "vendor", name: "terms", label: "Terms", type: "text" },
    ]);
    port = dbRecordsPort(asWorkerDb(t.db), catalog);
  });
  afterAll(async () => {
    await t?.drop();
  });

  const meta = (c: Client, key: string, mode: "live" | "test" = "live"): RecordWriteMeta => ({
    ...c.meta,
    key,
    sources: [c.vendorId],
    mode,
  });

  it("registers the shared and the areas' record types, each with its store", () => {
    expect(catalog.types.map((x) => x.id)).toEqual(
      expect.arrayContaining([
        "vendor",
        "transaction",
        "master_item",
        "vendor_item",
        "bank_transaction",
      ]),
    );
  });

  it("shows a client its own and the shared custom fields, never hidden ones or another's", async () => {
    const [v] = await port.get(A.tenantId, "vendor", [A.vendorId]);
    expect(Object.keys(v ?? {})).toEqual([
      "id",
      "name",
      "createdAt",
      "externalRefs",
      "region",
      "creditLimit",
      "terms",
    ]);
    const [vb] = await port.get(B.tenantId, "vendor", [B.vendorId]);
    expect(Object.keys(vb ?? {})).toEqual([
      "id",
      "name",
      "createdAt",
      "externalRefs",
      "bOnly",
      "terms",
    ]);
  });

  it("gives a Vendors match's record its accounting id by Get by id (the Bill clerk)", async () => {
    await t.db
      .update(vendor)
      .set({ externalRefs: { qbo: "56", other: "x" } })
      .where(eq(vendor.id, A.vendorId));
    const matched = await matchPort().match({
      ctx: packToolContext({
        tenantId: A.tenantId,
        agentVersionId: A.meta.agentVersionId,
        mode: "live",
        db: asWorkerDb(t.db),
      }),
      settings: steps.MatchSettings.parse({ to: "vendors", type: "exact", keys: ["name"] }),
      items: [{ name: "A Lumber" }],
    });
    const id = matched.output.items[0]?.matched;
    expect(id).toBe(A.vendorId);
    const [v] = await port.get(A.tenantId, "vendor", [id as string]);
    // Typed as declared: each connector's id or null, nothing else from the column.
    expect(v?.externalRefs).toEqual({ qbo: "56", billcom: null, odoo: null });
    // B's vendor has none, and A's id is never B's.
    const [vb] = await port.get(B.tenantId, "vendor", [B.vendorId]);
    expect(vb?.externalRefs).toEqual({ qbo: null, billcom: null, odoo: null });
  });

  it("never reaches another client's record", async () => {
    expect(await port.get(B.tenantId, "vendor", [A.vendorId])).toEqual([]);
    await expect(
      port.update(B.tenantId, "vendor", A.vendorId, { terms: "x" }, meta(B, "b-reach")),
    ).rejects.toThrow(/there is no vendor/);
    const listed = await port.list(B.tenantId, "vendor", { limit: 10 });
    expect(listed.records.map((r) => r.id)).toEqual([B.vendorId]);
  });

  it("writes custom fields beside the area's own ext keys, logged once with its evidence", async () => {
    const after = await port.update(
      A.tenantId,
      "vendor",
      A.vendorId,
      { region: "West", creditLimit: "2500.00", terms: "Net 30" },
      meta(A, "k1"),
    );
    expect(after).toMatchObject({ region: "West", creditLimit: "2500.00", terms: "Net 30" });
    const [row] = await t.db.select().from(vendor).where(eq(vendor.id, A.vendorId));
    expect(row?.ext).toEqual({
      senderDomains: ["a.test"],
      custom: { region: "West", creditLimit: "2500.00", terms: "Net 30" },
    });
    // A retried step: the same key gives the same record and no second write.
    await port.update(A.tenantId, "vendor", A.vendorId, { region: "East" }, meta(A, "k1"));
    const writes = await t.db.select().from(recordWrite).where(eq(recordWrite.key, "k1"));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      tenantId: A.tenantId,
      recordType: "vendor",
      recordId: A.vendorId,
      op: "update",
      agentVersionId: A.meta.agentVersionId,
      runId: A.meta.runId,
      stepRunId: A.meta.stepRunId,
      before: { name: "A Lumber", custom: {} },
      sources: [A.vendorId],
    });
    const [still] = await port.get(A.tenantId, "vendor", [A.vendorId]);
    expect(still?.region).toBe("West");
  });

  it("keeps both of two updates made at once to the same record", async () => {
    // Each write locks its record: the second waits for the first and adds to what it wrote.
    await Promise.all([
      port.update(A.tenantId, "vendor", A.vendorId, { region: "South" }, meta(A, "c1")),
      port.update(A.tenantId, "vendor", A.vendorId, { terms: "Net 45" }, meta(A, "c2")),
      port.update(A.tenantId, "vendor", A.vendorId, { creditLimit: "900.00" }, meta(A, "c3")),
    ]);
    const [v] = await port.get(A.tenantId, "vendor", [A.vendorId]);
    expect(v).toMatchObject({ region: "South", terms: "Net 45", creditLimit: "900.00" });
    // Put back what later tests read.
    await port.update(
      A.tenantId,
      "vendor",
      A.vendorId,
      { region: "West", terms: "Net 30", creditLimit: "2500.00" },
      meta(A, "c4"),
    );
  });

  it("refuses what the rules refuse: built-in fields, wrong types, card numbers, unknown fields", async () => {
    await expect(
      port.update(A.tenantId, "vendor", A.vendorId, { name: "Renamed" }, meta(A, "k2")),
    ).rejects.toThrow(/name can't be changed on a vendor/);
    await expect(
      port.update(A.tenantId, "vendor", A.vendorId, { creditLimit: 99.5 }, meta(A, "k3")),
    ).rejects.toThrow(/Credit limit is money/);
    await expect(
      port.update(
        A.tenantId,
        "vendor",
        A.vendorId,
        { region: "4111-1111-1111-1111" },
        meta(A, "k4"),
      ),
    ).rejects.toThrow(/card numbers are never stored/);
    // Hidden and another client's fields aren't fields here.
    for (const name of ["old", "bOnly"]) {
      await expect(
        port.update(A.tenantId, "vendor", A.vendorId, { [name]: "x" }, meta(A, `k-${name}`)),
      ).rejects.toThrow(`there is no field ${name}`);
    }
    expect(await t.db.select().from(recordWrite).where(eq(recordWrite.key, "k2"))).toEqual([]);
  });

  it("checks a test run's write and saves nothing", async () => {
    const out = await port.update(
      A.tenantId,
      "vendor",
      A.vendorId,
      { region: "North" },
      meta(A, "k-test", "test"),
    );
    expect(out).toMatchObject({ region: "North", saved: false });
    const [v] = await port.get(A.tenantId, "vendor", [A.vendorId]);
    expect(v?.region).toBe("West");
    expect(await t.db.select().from(recordWrite).where(eq(recordWrite.key, "k-test"))).toEqual([]);
  });

  it("finds a client's transactions through their vendor's custom field, with decimal totals", async () => {
    const out = await runFind(
      port,
      A.tenantId,
      TRANSACTION_RECORD_TYPE,
      FindQuery.parse({
        follow: ["vendor"],
        where: [{ field: "vendor.region", op: "equals", value: "West" }],
        groupBy: "vendor.name",
        totals: [{ field: "total", as: "spend" }],
      }),
    );
    expect(out).toMatchObject({
      count: 2,
      groups: [{ key: "A Lumber", count: 2, totals: { spend: "1500.5" } }],
      truncated: false,
    });
    const none = await runFind(
      port,
      B.tenantId,
      TRANSACTION_RECORD_TYPE,
      FindQuery.parse({ follow: ["vendor"], where: [{ field: "vendor.region", op: "isSet" }] }),
    );
    expect(none.count).toBe(0);
  });
});
