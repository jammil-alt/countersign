// Back office work (migrations 0061–0064, docs/plan.md §1.123) as the Worker's role sees it. A
// client's issues, their events and its asks are its own: forced row-level security, and one
// client's session never reads another's. Enhancements, to-dos, deals (with their people and
// activity) and the Autopilot tables are the operator's: a client's session reads none of them,
// and an operator sees only rows about the clients it serves, or about no client. History tables
// are insert only; nothing is deleted.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator, withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import {
  BACKOFFICE_WORK_OPERATOR_TABLES,
  clientAsk,
  deal,
  dealActivity,
  dealPerson,
  enhancement,
  issue,
  playLog,
  playSetting,
  thread,
  todo,
} from "./schema";
import { asWorker, createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

const TENANT_WORK_TABLES = ["issue", "issue_event", "client_ask"] as const;

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

describe.skipIf(!online)("the back office work tables", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;
  let C: ClientFixture;
  let operator = "";

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    // Each client gets an issue (with its event) and an ask from the shared fixture.
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
    C = await insertClient(t.db, "C");
    operator = A.userId;
    // An enhancement and a play setting (global); a to-do, a deal (with a person and an activity)
    // and a play log row about A, about B, and about no client (a lead's deal).
    await t.db
      .insert(enhancement)
      .values({ title: "Weekly summary by email", createdBy: operator });
    await t.db.insert(playSetting).values({
      flow: "issues",
      stage: "reported",
      play: "tell_client",
      level: "draft",
      updatedBy: operator,
    });
    for (const clientId of [A.tenantId, B.tenantId, null]) {
      await t.db.insert(todo).values({
        clientId,
        owner: "operator",
        title: "Tell the client we have it",
        ...(clientId ? { aboutKind: "client" as const, aboutId: clientId } : {}),
      });
      const [d] = await t.db
        .insert(deal)
        .values(
          clientId
            ? { kind: "expansion", clientId, title: "Receivables agent", stage: "spotted" }
            : { kind: "new", company: "Lakeside Builders", title: "Invoice review", stage: "lead" },
        )
        .returning({ id: deal.id });
      await t.db
        .insert(dealPerson)
        .values({ dealId: d?.id ?? "", name: "Pat Lee", isPrimary: true });
      await t.db
        .insert(dealActivity)
        .values({ dealId: d?.id ?? "", kind: "note", actor: "operator", body: "Met at the expo" });
      await t.db.insert(playLog).values({
        clientId,
        flow: clientId ? "grow" : "new",
        stage: clientId ? "spotted" : "lead",
        play: "first_reply",
        level: "draft",
        outcome: "drafted",
        summary: "Drafted a first reply",
      });
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

  it("force row-level security with a policy on every table", async () => {
    const all = [...TENANT_WORK_TABLES, ...BACKOFFICE_WORK_OPERATOR_TABLES];
    const rows = await t.db.$client<
      { relname: string; rls: boolean; forced: boolean; policies: number }[]
    >`
      select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      where c.relname in ${t.db.$client(all)}`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...all].sort());
    for (const r of rows) {
      expect(r.rls && r.forced, r.relname).toBe(true);
      expect(r.policies, r.relname).toBe(1);
    }
  });

  it("show a client's session its own issues, events and asks, never another client's", async () => {
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      for (const table of TENANT_WORK_TABLES) {
        const rows = [
          ...(await tx.execute<{ t: string }>(
            sql.raw(`select tenant_id::text as t from ${table}`),
          )),
        ];
        expect(rows.length, table).toBe(1);
        expect(rows[0]?.t, table).toBe(A.tenantId);
      }
      // Asking for B's issue by its id finds nothing.
      const [bIssue] = await t.db
        .select({ id: issue.id })
        .from(issue)
        .where(sql`${issue.tenantId} = ${B.tenantId}`);
      const seen = [...(await tx.execute(sql`select 1 from issue where id = ${bIssue?.id ?? ""}`))];
      expect(seen).toHaveLength(0);
    });
  });

  it("refuse a client's session an issue, event or ask for another client", async () => {
    const [th] = await t.db
      .insert(thread)
      .values({ tenantId: B.tenantId, subjectType: "issue", title: "Request #2" })
      .returning({ id: thread.id });
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.insert(issue).values({
            tenantId: B.tenantId,
            number: 2,
            title: "x",
            source: "portal",
            threadId: th?.id ?? "",
          });
        }),
      ),
    ).toBe("42501");
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.insert(clientAsk).values({
            tenantId: B.tenantId,
            title: "x",
            text: "x",
            source: "portal",
            threadId: th?.id ?? "",
          });
        }),
      ),
    ).toBe("42501");
  });

  it("show a client's session none of the operator's tables, and let it write none", async () => {
    await withTenant(t.db, A.tenantId, async (tx) => {
      await asWorker(tx);
      for (const table of BACKOFFICE_WORK_OPERATOR_TABLES) {
        expect(await count(tx, table), table).toBe(0);
      }
    });
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.insert(todo).values({ clientId: A.tenantId, owner: "client", title: "x" });
        }),
      ),
    ).toBe("42501");
    expect(
      await errorCode(
        withTenant(t.db, A.tenantId, async (tx) => {
          await asWorker(tx);
          await tx.insert(enhancement).values({ title: "x" });
        }),
      ),
    ).toBe("42501");
  });

  it("show an operator only rows about the clients it serves, or about no client", async () => {
    await withOperator(t.db, [A.tenantId], async (tx) => {
      await asWorker(tx);
      // A's and the one about no client; not B's.
      for (const table of ["todo", "deal", "deal_person", "deal_activity", "play_log"]) {
        expect(await count(tx, table), table).toBe(2);
      }
      expect(await count(tx, "enhancement")).toBe(1);
      expect(await count(tx, "play_setting")).toBe(1);
      // The client tables: A's only.
      for (const table of TENANT_WORK_TABLES) expect(await count(tx, table), table).toBe(1);
    });
    await withOperator(t.db, [A.tenantId, B.tenantId, C.tenantId], async (tx) => {
      await asWorker(tx);
      for (const table of ["todo", "deal", "deal_person", "deal_activity", "play_log"]) {
        expect(await count(tx, table), table).toBe(3);
      }
    });
  });

  it("refuse an operator a to-do or deal about a client it doesn't serve", async () => {
    expect(
      await errorCode(
        withOperator(t.db, [A.tenantId], async (tx) => {
          await asWorker(tx);
          await tx.insert(todo).values({ clientId: B.tenantId, owner: "operator", title: "x" });
        }),
      ),
    ).toBe("42501");
    expect(
      await errorCode(
        withOperator(t.db, [A.tenantId], async (tx) => {
          await asWorker(tx);
          await tx
            .insert(deal)
            .values({ kind: "expansion", clientId: B.tenantId, title: "x", stage: "spotted" });
        }),
      ),
    ).toBe("42501");
    const [bDeal] = await t.db
      .select({ id: deal.id })
      .from(deal)
      .where(sql`${deal.clientId} = ${B.tenantId}`);
    expect(
      await errorCode(
        withOperator(t.db, [A.tenantId], async (tx) => {
          await asWorker(tx);
          await tx.insert(dealPerson).values({ dealId: bDeal?.id ?? "", name: "x" });
        }),
      ),
    ).toBe("42501");
  });

  it("keep history as written and delete nothing", async () => {
    for (const table of ["issue_event", "deal_activity"]) {
      expect(await can(table, "INSERT"), table).toBe(true);
      expect(await can(table, "UPDATE"), table).toBe(false);
    }
    for (const table of [
      "issue",
      "client_ask",
      "enhancement",
      "todo",
      "deal",
      "deal_person",
      "play_setting",
      "play_log",
    ]) {
      expect(await can(table, "UPDATE"), table).toBe(true);
    }
    for (const table of [...TENANT_WORK_TABLES, ...BACKOFFICE_WORK_OPERATOR_TABLES]) {
      expect(await can(table, "SELECT"), table).toBe(true);
      expect(await can(table, "DELETE"), table).toBe(false);
      expect(await can(table, "TRUNCATE"), table).toBe(false);
    }
  });

  it("number issues once per client, and hold a deal's stage to its kind", async () => {
    const [th] = await t.db
      .insert(thread)
      .values({ tenantId: A.tenantId, subjectType: "issue", title: "Request #1" })
      .returning({ id: thread.id });
    // A already has issue #1 from the fixture.
    expect(
      await errorCode(
        t.db.insert(issue).values({
          tenantId: A.tenantId,
          number: 1,
          title: "Again",
          source: "ops",
          threadId: th?.id ?? "",
        }),
      ),
    ).toBe("23505");
    // B may have its own #2.
    const [thB] = await t.db
      .insert(thread)
      .values({ tenantId: B.tenantId, subjectType: "issue", title: "Request #2" })
      .returning({ id: thread.id });
    await t.db.insert(issue).values({
      tenantId: B.tenantId,
      number: 2,
      title: "Second",
      source: "ops",
      threadId: thB?.id ?? "",
    });
    // A new account's deal never sits at an expansion stage; an expansion always names a client.
    expect(
      await errorCode(
        t.db.insert(deal).values({ kind: "new", company: "x", title: "x", stage: "spotted" }),
      ),
    ).toBe("23514");
    expect(
      await errorCode(
        t.db.insert(deal).values({ kind: "expansion", company: "x", title: "x", stage: "pitch" }),
      ),
    ).toBe("23514");
    // A to-do's subject is both or neither.
    expect(
      await errorCode(
        t.db.insert(todo).values({ owner: "operator", title: "x", aboutKind: "issue" }),
      ),
    ).toBe("23514");
  });

  it("widen the notification kinds with issue_update, and give agents and builds their columns", async () => {
    const cols = await t.db.$client<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'
        and ((table_name = 'agent' and column_name = 'hold')
          or (table_name = 'build' and column_name in ('promised_on', 'path', 'template_id',
              'origin_kind', 'origin_id', 'requirements', 'waiting_on', 'status_line', 'stuck',
              'manual_rank')))`;
    expect(cols).toHaveLength(11);
    await t.db.$client`
      insert into notification (tenant_id, user_id, channel, kind, dedupe_key, link)
      values (${A.tenantId}, ${A.userId}, 'email', 'issue_update', 'issue:m1:u1', '/requests/x')`;
  });
});
