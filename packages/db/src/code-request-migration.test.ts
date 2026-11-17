// The Dev queue (migration 0065, docs/plan.md §1.125) as the Worker's role sees it. Requests and
// their events are the operator's and global: a client's session reads and writes none of them. A
// request's link to a build is visible only with its build, so an operator never sees a link to
// a build of a client it doesn't serve. Events and links are insert only; nothing is deleted.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator, withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import {
  build,
  CODE_REQUEST_TABLES,
  codeRequest,
  codeRequestEvent,
  codeRequestLink,
} from "./schema";
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

describe.skipIf(!online)("the Dev queue tables", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;
  let requestId = "";

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
    const [r] = await t.db
      .insert(codeRequest)
      .values({
        title: "Add date offsets to Reshape data",
        kind: "extend_existing",
        createdBy: "builder",
      })
      .returning({ id: codeRequest.id });
    requestId = r?.id ?? "";
    await t.db
      .insert(codeRequestEvent)
      .values({ requestId, actor: "builder", kind: "status", body: { to: "triage" } });
    // One build for A, one for B and a template build (no client), each linked to the request.
    for (const clientId of [A.tenantId, B.tenantId, null]) {
      const [b] = await t.db
        .insert(build)
        .values({ kind: "agent", title: "Monthly report", clientId })
        .returning({ id: build.id });
      await t.db
        .insert(codeRequestLink)
        .values({ requestId, buildId: b?.id ?? "", workflowId: "monthly", stepId: "offset" });
    }
  });
  afterAll(async () => {
    await t?.drop();
  });

  const count = async (tx: Parameters<Parameters<typeof withOperator>[2]>[0], table: string) =>
    Number(
      [...(await tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`)))][0]
        ?.n ?? 0,
    );

  const can = async (table: string, privilege: string) =>
    (
      await t.db.$client<{ ok: boolean }[]>`
        select has_table_privilege('cs_runtime', ${table}, ${privilege}) as ok`
    )[0]?.ok;

  it("force row-level security with one policy on each table", async () => {
    const rows = await t.db.$client<
      { relname: string; rls: boolean; forced: boolean; policies: number }[]
    >`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relname in ${t.db.$client([...CODE_REQUEST_TABLES])}`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...CODE_REQUEST_TABLES].sort());
    for (const r of rows) {
      expect(r.rls && r.forced, r.relname).toBe(true);
      expect(r.policies, r.relname).toBe(1);
    }
  });

  it("show a client's session nothing, and let it write nothing", async () => {
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      for (const table of CODE_REQUEST_TABLES) expect(await count(tx, table), table).toBe(0);
    });
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx
            .insert(codeRequest)
            .values({ title: "x", kind: "new_tool", createdBy: "session" });
        }),
      ),
    ).toBe("42501");
  });

  it("show an operator every request, and links only for builds it may see", async () => {
    await withOperator(t.db, [A.tenantId], async (tx) => {
      await asWorker(tx);
      expect(await count(tx, "code_request")).toBe(1);
      expect(await count(tx, "code_request_event")).toBe(1);
      // A's build and the template build; not B's.
      expect(await count(tx, "code_request_link")).toBe(2);
    });
    await withOperator(t.db, [A.tenantId, B.tenantId], async (tx) => {
      await asWorker(tx);
      expect(await count(tx, "code_request_link")).toBe(3);
    });
  });

  it("number requests once, in order, as the Worker inserts them", async () => {
    const [second] = await withOperator(t.db, [A.tenantId], async (tx) => {
      await asWorker(tx);
      return tx
        .insert(codeRequest)
        .values({
          title: "Add division to Reshape data",
          kind: "extend_existing",
          createdBy: "operator",
        })
        .returning({ number: codeRequest.number });
    });
    const [first] = await t.db
      .select({ number: codeRequest.number })
      .from(codeRequest)
      .where(eq(codeRequest.id, requestId));
    // A refused insert (the client's, above) still takes a number: numbers may skip, never repeat.
    expect(first?.number).toBe(1);
    expect(second?.number).toBeGreaterThan(1);
  });

  it("hold a closed request to a reason, and a merged one to what it merged into", async () => {
    const base = { title: "x", kind: "new_tool" as const, createdBy: "operator" as const };
    expect(await errorCode(t.db.insert(codeRequest).values({ ...base, status: "closed" }))).toBe(
      "23514",
    );
    expect(
      await errorCode(
        t.db.insert(codeRequest).values({ ...base, status: "closed", closeReason: "merged" }),
      ),
    ).toBe("23514");
    expect(
      await errorCode(
        t.db.insert(codeRequest).values({
          ...base,
          status: "closed",
          closeReason: "merged",
          mergedIntoId: requestId,
        }),
      ),
    ).toBeUndefined();
    // One link per build and step.
    const [link] = await t.db.select().from(codeRequestLink).limit(1);
    expect(
      await errorCode(
        t.db.insert(codeRequestLink).values({
          requestId,
          buildId: link?.buildId ?? "",
          workflowId: link?.workflowId ?? null,
          stepId: link?.stepId ?? null,
        }),
      ),
    ).toBe("23505");
  });

  it("keep events and links as written and delete nothing", async () => {
    expect(await can("code_request", "UPDATE")).toBe(true);
    for (const table of ["code_request_event", "code_request_link"]) {
      expect(await can(table, "INSERT"), table).toBe(true);
      expect(await can(table, "UPDATE"), table).toBe(false);
    }
    for (const table of CODE_REQUEST_TABLES) {
      expect(await can(table, "SELECT"), table).toBe(true);
      expect(await can(table, "DELETE"), table).toBe(false);
      expect(await can(table, "TRUNCATE"), table).toBe(false);
    }
    // Even the owner can't rewrite an event.
    expect(await errorCode(t.db.update(codeRequestEvent).set({ kind: "note" }))).toBe("23001");
  });
});
