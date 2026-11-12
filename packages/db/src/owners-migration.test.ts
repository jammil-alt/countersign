// Migration 0048 (ARCHITECTURE v0.17 §10.15, docs/plan.md §1.96, O1): `area_owner`,
// `area_owner_version`, `agent.area`, `run.owner_version_id`, and memory notes for an owner and a
// person. It applies on a database the previous Worker used (its memory notes still hold), both
// tables have forced row-level security, the Worker's role reaches only its own client's owners,
// versions are never changed, and the checks hold a note to one subject and a person note to its
// person.

import { OWNER_AREAS as CORE_AREAS } from "@countersign/core";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { agent, areaOwner, areaOwnerVersion, memoryNote, OWNER_AREAS, run } from "./schema";
import {
  asWorker,
  createTestDatabase,
  databaseAvailable,
  migrateAsOwner,
  type TestDatabase,
} from "./testing";

const online = await databaseAvailable();

it("keeps the database's list of areas in step with core's", () => {
  expect([...OWNER_AREAS]).toEqual([...CORE_AREAS]);
});

describe.skipIf(!online)("0048 on a database the previous Worker used", () => {
  let t: TestDatabase;
  let noteId = "";

  beforeAll(async () => {
    const created = await createTestDatabase({ migrate: false });
    if (!created) throw new Error("database vanished");
    t = created;
    await migrateAsOwner(t.url, { upTo: "0047_vendor_catalog" });
    // Plain SQL: the schema in code already has 0048's columns, which this database doesn't yet.
    const [tn] = await t.db.$client<{ id: string }[]>`
      insert into tenant (name) values ('Earlier') returning id`;
    const [ag] = await t.db.$client<{ id: string }[]>`
      insert into agent (tenant_id, kind, slug, name, stage)
      values (${tn?.id ?? ""}, 'client', 'bill-clerk', 'Bill clerk', 'bench') returning id`;
    const [n] = await t.db.$client<{ id: string }[]>`
      insert into memory_note (tenant_id, agent_id, note)
      values (${tn?.id ?? ""}, ${ag?.id ?? ""}, 'Acme puts the PO number in the footer')
      returning id`;
    noteId = n?.id ?? "";
    await migrateAsOwner(t.url);
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("adds both owner tables, empty, with forced row-level security", async () => {
    const rows = await t.db.$client<{ relname: string; rls: boolean; forced: boolean }[]>`
      select relname, relrowsecurity as rls, relforcerowsecurity as forced
      from pg_class where relname in ('area_owner', 'area_owner_version') order by relname`;
    expect(rows).toEqual([
      { relname: "area_owner", rls: true, forced: true },
      { relname: "area_owner_version", rls: true, forced: true },
    ]);
  });

  it("keeps the previous Worker's memory notes as they were", async () => {
    const [row] = await t.db.$client<{ note: string; scope: string; person_id: string | null }[]>`
      select note, scope, person_id from memory_note where id = ${noteId}`;
    expect(row).toEqual({
      note: "Acme puts the PO number in the footer",
      scope: "agent",
      person_id: null,
    });
  });
});

describe.skipIf(!online)("area owners under the Worker's role (0048)", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;
  let ownerA = "";
  let versionA = "";

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
    ownerA = A.ownerId;
    versionA = A.ownerVersionId;
  });
  afterAll(async () => {
    await t?.drop();
  });

  it("a client sees only its own owners and versions", async () => {
    const seen = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return {
        owners: await tx.select({ tenantId: areaOwner.tenantId }).from(areaOwner),
        versions: await tx.select({ tenantId: areaOwnerVersion.tenantId }).from(areaOwnerVersion),
      };
    });
    expect(seen.owners).toEqual([{ tenantId: A.tenantId }]);
    expect(seen.versions).toEqual([{ tenantId: A.tenantId }]);
  });

  it("allows one owner per area per client", async () => {
    await expect(
      withTenant(t.db, A.tenantId, async (tx) => {
        await asWorker(tx);
        await tx
          .insert(areaOwner)
          .values({ tenantId: A.tenantId, area: "purchasing", name: "Teo" });
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("refuses an area that isn't one", async () => {
    await expect(
      withTenant(t.db, A.tenantId, async (tx) => {
        await asWorker(tx);
        await tx.execute(sql`update agent set area = 'astrology' where id = ${A.agentId}`);
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx.update(agent).set({ area: "purchasing" }).where(eq(agent.id, A.agentId));
    });
  });

  it("never changes or deletes an owner's version, while the owner itself may be renamed", async () => {
    await expect(
      withTenant(t.db, A.tenantId, async (tx) => {
        await asWorker(tx);
        await tx
          .update(areaOwnerVersion)
          .set({ changeNote: "edited" })
          .where(eq(areaOwnerVersion.id, versionA));
      }),
    ).rejects.toMatchObject({ cause: { code: "23001" } });
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx.update(areaOwner).set({ name: "Pip" }).where(eq(areaOwner.id, ownerA));
    });
  });

  it("pins a run to its own client's owner version only", async () => {
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx.update(run).set({ ownerVersionId: versionA }).where(eq(run.id, A.runId));
    });
    await expect(
      withTenant(t.db, B.tenantId, async (tx) => {
        await asWorker(tx);
        await tx.update(run).set({ ownerVersionId: versionA }).where(eq(run.id, B.runId));
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("holds a note to one subject, and a person's summary to its person", async () => {
    // The fixture already saved one of each; these are refused.
    const both = withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx
        .insert(memoryNote)
        .values({ tenantId: A.tenantId, agentId: A.agentId, ownerId: ownerA, note: "x" });
    });
    await expect(both).rejects.toMatchObject({ cause: { code: "23514" } });
    const noPerson = withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      await tx
        .insert(memoryNote)
        .values({ tenantId: A.tenantId, agentId: A.agentId, scope: "person", note: "x" });
    });
    await expect(noPerson).rejects.toMatchObject({ cause: { code: "23514" } });
    const saved = await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      return tx
        .insert(memoryNote)
        .values([
          { tenantId: A.tenantId, ownerId: ownerA, note: "Freight under $20 needs no question" },
          {
            tenantId: A.tenantId,
            agentId: A.agentId,
            scope: "person",
            personId: A.userId,
            note: "Asked about the Ferguson bill; it is signed.",
          },
        ])
        .returning({ id: memoryNote.id });
    });
    expect(saved).toHaveLength(2);
  });
});
