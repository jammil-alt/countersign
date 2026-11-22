// Lost prospects' files (migration 0097; docs/plan.md §1.149 q14, §1.220): the Worker still can't
// delete a client file itself; `app_purge_lost_prospect_files()` deletes only files of prospects
// whose every deal closed without a sale more than 12 months ago, their facts with them, leaves
// the deals (unlinked), and writes one audit row naming the files' ids. Anything younger, a file
// with an open, won or "not now" deal, a file with no deal, or a client's file is kept.

import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator } from "./client";
import { insertClient } from "./fixtures.test-helper";
import { auditEvent, clientFact, clientFile, deal } from "./schema";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

const monthsAgo = (n: number) => new Date(Date.now() - n * 31 * 86_400_000);

describe.skipIf(!online)("purging lost prospects' files (0097)", () => {
  let t: TestDatabase;
  const files: Record<string, string> = {};
  const deals: Record<string, string> = {};

  async function addFile(key: string, clientId: string | null = null) {
    const [f] = await t.db
      .insert(clientFile)
      .values({ name: `Company ${key}`, clientId })
      .returning({ id: clientFile.id });
    files[key] = f?.id as string;
    await t.db.insert(clientFact).values({
      fileId: files[key] as string,
      section: "notes",
      text: `A fact about ${key}`,
      sourceKind: "note",
      actor: "operator",
    });
    return files[key] as string;
  }

  async function addDeal(
    key: string,
    file: string,
    outcome: "open" | "won" | "lost" | "not_now" | "no",
    closedAt: Date | null,
  ) {
    const [d] = await t.db
      .insert(deal)
      .values({
        kind: "new",
        company: `Company ${key}`,
        title: "Invoice review",
        stage: "lead",
        clientFileId: file,
        outcome,
        closedAt,
      })
      .returning({ id: deal.id });
    deals[key] = d?.id as string;
  }

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const A = await insertClient(t.db, "A");
    // Purged: lost 13 months ago; and lost then "no" long ago.
    await addDeal("old", await addFile("old"), "lost", monthsAgo(13));
    const twice = await addFile("twice");
    await addDeal("twice1", twice, "lost", monthsAgo(20));
    await addDeal("twice2", twice, "no", monthsAgo(14));
    // Kept: lost 11 months ago; one old lost deal and a newer one; an open deal; not now; no deal;
    // a client's file whose deal was lost long ago.
    await addDeal("young", await addFile("young"), "lost", monthsAgo(11));
    const mixed = await addFile("mixed");
    await addDeal("mixed1", mixed, "lost", monthsAgo(20));
    await addDeal("mixed2", mixed, "lost", monthsAgo(2));
    const open = await addFile("open");
    await addDeal("open1", open, "lost", monthsAgo(20));
    await addDeal("open2", open, "open", null);
    await addDeal("later", await addFile("later"), "not_now", monthsAgo(20));
    await addFile("nodeal");
    await addDeal("client", await addFile("client", A.tenantId), "lost", monthsAgo(20));
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("leaves the Worker no DELETE on client_file", async () => {
    expect(
      await errorCode(
        withOperator(t.db, [], async (tx) => {
          await asWorker(tx);
          await tx.delete(clientFile).where(eq(clientFile.id, files.old as string));
        }),
      ),
    ).toBe("42501");
  });

  it("deletes only the lost prospects' files past 12 months, their facts with them, once", async () => {
    const purged = await withOperator(t.db, [], async (tx) => {
      await asWorker(tx);
      const r = await tx.execute<{ ids: string[] }>(
        sql`select app_purge_lost_prospect_files() as ids`,
      );
      return (r as unknown as { ids: string[] }[])[0]?.ids ?? [];
    });
    expect([...purged].sort()).toEqual([files.old, files.twice].sort());

    const left = await t.db.select({ id: clientFile.id }).from(clientFile);
    const leftIds = new Set(left.map((r) => r.id));
    for (const k of ["young", "mixed", "open", "later", "nodeal", "client"]) {
      expect(leftIds.has(files[k] as string), k).toBe(true);
    }
    expect(leftIds.has(files.old as string)).toBe(false);
    const facts = await t.db
      .select({ id: clientFact.id })
      .from(clientFact)
      .where(inArray(clientFact.fileId, [files.old as string, files.twice as string]));
    expect(facts).toEqual([]);
    // The deals stay, no longer naming a file.
    const kept = await t.db
      .select({ id: deal.id, file: deal.clientFileId })
      .from(deal)
      .where(inArray(deal.id, [deals.old as string, deals.twice1 as string]));
    expect(kept.map((d) => d.file)).toEqual([null, null]);

    // One audit row, by the system, naming ids only.
    const audits = await t.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, "client_file.purge_lost"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ tenantId: null, actorKind: "system", outcome: "ok" });
    expect(audits[0]?.target).toEqual({ fileIds: [...purged].sort(), count: 2 });

    // Again: nothing more to purge, and no audit row for nothing.
    const again = await withOperator(t.db, [], async (tx) => {
      await asWorker(tx);
      const r = await tx.execute<{ ids: string[] }>(
        sql`select app_purge_lost_prospect_files() as ids`,
      );
      return (r as unknown as { ids: string[] }[])[0]?.ids ?? [];
    });
    expect(again).toEqual([]);
    expect(
      await t.db.select().from(auditEvent).where(eq(auditEvent.action, "client_file.purge_lost")),
    ).toHaveLength(1);
  });
});
