// Migration 0096 (docs/plan.md §1.218): `access_review`, a quarterly access review an operator
// recorded, and `access_review_item`, each person's access to each client as the review found it.
// Only operator sessions see a review; each client's items are that client's own; neither is ever
// updated or deleted by the Worker; a purge takes a retired client's items with it.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator, withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { purgeClient } from "./purge";
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

describe.skipIf(!online)("0096: access_review and access_review_item", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
  });
  afterAll(async () => {
    await t?.drop();
  });

  type Run = (q: string) => Promise<unknown>;
  const asOperator = <T>(ids: string[], fn: (run: Run) => Promise<T>) =>
    withOperator(t.db, ids, async (tx) => {
      await asWorker(tx);
      return fn((q) => tx.execute(sql.raw(q)));
    });
  const asClient = <T>(id: string, fn: (run: Run) => Promise<T>) =>
    withTenant(t.db, id, async (tx) => {
      await asWorker(tx);
      return fn((q) => tx.execute(sql.raw(q)));
    });
  const rows = (r: unknown) => [...(r as Iterable<Record<string, unknown>>)];

  it("forces row-level security on both tables", async () => {
    const found = await t.db.execute<{ relname: string; rls: boolean; forced: boolean }>(sql`
      select relname, relrowsecurity as rls, relforcerowsecurity as forced from pg_class
      where relname in ('access_review', 'access_review_item') order by relname`);
    expect([...found]).toEqual([
      { relname: "access_review", rls: true, forced: true },
      { relname: "access_review_item", rls: true, forced: true },
    ]);
  });

  it("records a review for the clients an operator serves, and shows each client only its own", async () => {
    const id = await asOperator([A.tenantId], async (run) => {
      const [review] = rows(
        await run(`insert into access_review (period, reviewed_by, reviewer_email, clients, people,
                     removals) values ('2026-Q4', '${A.userId}', 'op@example.com', 1, 1, 1)
                   returning id`),
      );
      await run(`insert into access_review_item (review_id, tenant_id, user_id, email, role,
                   decision, note) values ('${review?.id}', '${A.tenantId}', '${A.userId}',
                   'a@example.com', 'client_user', 'remove', 'Left in October')`);
      return String(review?.id);
    });
    // Not a client this operator serves.
    expect(
      await errorCode(
        asOperator([A.tenantId], (run) =>
          run(`insert into access_review_item (review_id, tenant_id, user_id, email, role,
                 decision) values ('${id}', '${B.tenantId}', '${B.userId}', 'b@example.com',
                 'client_user', 'keep')`),
        ),
      ),
    ).toBe("42501");
    const seen = await asOperator([B.tenantId], async (run) =>
      rows(await run(`select tenant_id from access_review_item where review_id = '${id}'`)),
    );
    expect(seen).toEqual([]);
    const own = await asClient(A.tenantId, async (run) =>
      rows(await run(`select decision from access_review_item where review_id = '${id}'`)),
    );
    expect(own).toEqual([{ decision: "remove" }]);
  });

  it("shows a review only to operator sessions", async () => {
    const asA = await asClient(A.tenantId, async (run) =>
      rows(await run("select id from access_review")),
    );
    expect(asA).toEqual([]);
    expect(
      await errorCode(
        asClient(A.tenantId, (run) =>
          run(`insert into access_review (period, reviewed_by, reviewer_email, clients, people,
                 removals) values ('2026-Q4', '${A.userId}', 'x@example.com', 0, 0, 0)`),
        ),
      ),
    ).toBe("42501");
    const asOp = await asOperator([A.tenantId], async (run) =>
      rows(await run("select id from access_review")),
    );
    expect(asOp.length).toBeGreaterThan(0);
  });

  it("never updates or deletes a review or its people, and checks the quarter and counts", async () => {
    // cs_runtime has no UPDATE on either, and the guard refuses even the owner.
    for (const table of ["access_review", "access_review_item"]) {
      expect(
        await errorCode(asOperator([A.tenantId], (run) => run(`update ${table} set note = 'x'`))),
        table,
      ).toBe("42501");
      expect(await errorCode(t.db.execute(sql.raw(`update ${table} set note = 'x'`))), table).toBe(
        "23001",
      );
      expect(await errorCode(t.db.execute(sql.raw(`delete from ${table}`))), table).toBe("23001");
    }
    // cs_runtime has no DELETE on either.
    expect(
      await errorCode(asOperator([A.tenantId], (run) => run("delete from access_review"))),
    ).toBe("42501");
    expect(
      await errorCode(asOperator([A.tenantId], (run) => run("delete from access_review_item"))),
    ).toBe("42501");
    for (const [period, people, removals] of [
      ["2026-Q5", 1, 0],
      ["Q4-2026", 1, 0],
      ["2026-Q4", 1, 2],
    ] as const) {
      expect(
        await errorCode(
          asOperator([A.tenantId], (run) =>
            run(`insert into access_review (period, reviewed_by, reviewer_email, clients, people,
                   removals) values ('${period}', '${A.userId}', 'x@example.com', 1, ${people},
                   ${removals})`),
          ),
        ),
        `${period} ${people} ${removals}`,
      ).toBe("23514");
    }
  });

  it("goes with its client when the client is purged, and the review stays", async () => {
    await t.db.execute(sql`update tenant set retired_at = now() where id = ${A.tenantId}`);
    await purgeClient(t.db, A.tenantId, { force: true });
    const [left] = [
      ...(await t.db.execute<{ items: number; reviews: number }>(sql`
        select (select count(*) from access_review_item where tenant_id = ${A.tenantId})::int
          as items, (select count(*) from access_review)::int as reviews`)),
    ];
    expect(left?.items).toBe(0);
    expect(left?.reviews).toBeGreaterThan(0);
    // B's own items are untouched.
    const [b] = [
      ...(await t.db.execute<{ n: number }>(
        sql`select count(*)::int as n from access_review_item where tenant_id = ${B.tenantId}`,
      )),
    ];
    expect(b?.n).toBeGreaterThan(0);
  });
});
