// Purging a retired client (docs/plan.md §1.35): every row of it goes, in every table, and nothing
// of any other client; the audit log stays.

import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "./client";
import { type ClientFixture, insertClient, insertOperatorRows } from "./fixtures.test-helper";
import { deleteOrder, PurgeRefused, purgeClient, purgePlan } from "./purge";
import {
  clientFact,
  clientFile,
  deal,
  dealActivity,
  dealPerson,
  playLog,
  TENANT_TABLES,
  todo,
} from "./schema";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

describe("deleteOrder", () => {
  it("puts children before parents, and refuses a cycle", () => {
    const order = deleteOrder(
      new Map([
        ["run", new Set(["agent"])],
        ["agent", new Set<string>()],
        ["step_run", new Set(["run"])],
      ]),
    );
    expect(order.indexOf("step_run")).toBeLessThan(order.indexOf("run"));
    expect(order.indexOf("run")).toBeLessThan(order.indexOf("agent"));
    expect(() =>
      deleteOrder(
        new Map([
          ["a", new Set(["b"])],
          ["b", new Set(["a"])],
        ]),
      ),
    ).toThrow(/cycle/);
  });
});

describe.skipIf(!online)("purgeClient", () => {
  let t: TestDatabase;
  let A: ClientFixture;
  let B: ClientFixture;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    A = await insertClient(t.db, "A");
    B = await insertClient(t.db, "B");
    await insertOperatorRows(t.db);
    // §1.124: the operator's deal, to-do and play log about A go with A; a deal's people and
    // activity with their deal.
    const [d] = await t.db
      .insert(deal)
      .values({ kind: "expansion", clientId: A.tenantId, title: "More", stage: "spotted" })
      .returning({ id: deal.id });
    await t.db.insert(dealPerson).values({ dealId: d?.id ?? "", name: "Pat Lee" });
    // §1.149: A's client file and its facts go with A, and the deal that points at it.
    const [f] = await t.db
      .insert(clientFile)
      .values({ name: "A", clientId: A.tenantId, status: "client" })
      .returning({ id: clientFile.id });
    await t.db.insert(clientFact).values({
      fileId: f?.id ?? "",
      section: "notes",
      text: "Price sensitive",
      sourceKind: "note",
      actor: "operator",
    });
    await t.db
      .update(deal)
      .set({ clientFileId: f?.id ?? "" })
      .where(sql`${deal.id} = ${d?.id ?? ""}`);
    await t.db.insert(dealActivity).values({ dealId: d?.id ?? "", kind: "note", actor: "system" });
    await t.db.insert(todo).values({ clientId: A.tenantId, owner: "operator", title: "Call" });
    await t.db.insert(playLog).values({
      clientId: A.tenantId,
      flow: "grow",
      stage: "spotted",
      play: "pursue",
      level: "draft",
      outcome: "drafted",
    });
  });
  afterAll(async () => {
    await t?.drop();
  });

  const count = async (table: string, tenantId: string) =>
    Number(
      [
        ...(await t.db.execute<{ n: string }>(
          sql.raw(`select count(*) as n from ${table} where tenant_id = '${tenantId}'`),
        )),
      ][0]?.n ?? 0,
    );

  it("refuses when the name typed again isn't the client's, without saying the real one", async () => {
    const refused = purgeClient(t.db, A.tenantId, { confirmName: "B", force: true });
    await expect(refused).rejects.toBeInstanceOf(PurgeRefused);
    await expect(refused).rejects.toThrow(/^the name typed doesn't match this client's name$/);
    const [still] = [
      ...(await t.db.execute<{ n: string }>(
        sql`select count(*) as n from tenant where id = ${A.tenantId}`,
      )),
    ];
    expect(Number(still?.n)).toBe(1);
  });

  it("refuses a client that isn't retired, retired too recently, or whose files remain", async () => {
    await expect(purgeClient(t.db, A.tenantId)).rejects.toBeInstanceOf(PurgeRefused);
    await t.db.execute(sql`update tenant set retired_at = now() where id = ${A.tenantId}`);
    await expect(purgeClient(t.db, A.tenantId)).rejects.toThrow(/can be purged from/);
    await t.db.execute(
      sql`update tenant set retired_at = now() - interval '31 days' where id = ${A.tenantId}`,
    );
    await expect(purgeClient(t.db, A.tenantId)).rejects.toThrow(/files are not deleted/);
  });

  it("deletes every row of the client in every table but the audit log, and nothing of another", async () => {
    await t.db.execute(sql`update tenant set settings = settings || '{"purge":{"files_deleted_at":"2026-01-01T00:00:00Z"}}'::jsonb
      where id = ${A.tenantId}`);
    const beforeB = Object.fromEntries(
      await Promise.all(TENANT_TABLES.map(async (tb) => [tb, await count(tb, B.tenantId)])),
    );
    const report = await purgeClient(t.db, A.tenantId, { confirmName: " a " });
    expect(report.name).toBe("A");
    for (const table of TENANT_TABLES) {
      const left = await count(table, A.tenantId);
      if (table === "audit_event") expect(left, table).toBeGreaterThan(0);
      else expect(left, table).toBe(0);
      expect(await count(table, B.tenantId), `${table} of B`).toBe(beforeB[table]);
    }
    for (const table of ["deal", "todo", "play_log", "client_file"]) {
      const [left] = [
        ...(await t.db.execute<{ n: number }>(
          sql.raw(`select count(*)::int as n from ${table} where client_id = '${A.tenantId}'`),
        )),
      ];
      expect(left?.n, table).toBe(0);
    }
    const [people] = [
      ...(await t.db.execute<{ n: number }>(
        sql`select (select count(*) from deal_person)::int + (select count(*) from deal_activity)::int as n`,
      )),
    ];
    expect(people?.n).toBe(0);
    const [facts] = [
      ...(await t.db.execute<{ n: number }>(sql`select count(*)::int as n from client_fact`)),
    ];
    expect(facts?.n).toBe(0);
    const [tenantRow] = [
      ...(await t.db.execute(sql`select 1 from tenant where id = ${A.tenantId}`)),
    ];
    expect(tenantRow).toBeUndefined();
    expect(report.usersDeleted).toBeGreaterThan(0);
    // The purge itself is in the audit log.
    expect([
      ...(await t.db.execute(
        sql`select 1 from audit_event where tenant_id = ${A.tenantId} and action = 'client.purge'`,
      )),
    ]).toHaveLength(1);
    // The history triggers are back on.
    await expect(
      t.db.execute(sql`delete from agent_version where tenant_id = ${B.tenantId}`),
    ).rejects.toThrow();
  });

  it("covers every table that names a client, so a new one can't be left behind", async () => {
    const plan = await purgePlan(t.db);
    // A column naming a client with no foreign key to it would be missed: the audit log alone
    // has one, on purpose (it outlives the client).
    const naming = [
      ...(await t.db.execute<{ table_name: string; column_name: string }>(sql`
        select table_name, column_name from information_schema.columns
        where table_schema = 'public' and column_name in ('tenant_id', 'client_id')
          and table_name <> 'audit_event'`)),
    ];
    for (const { table_name: table, column_name: column } of naming) {
      expect(plan.rowsOf.has(table), `${table}.${column} is purged`).toBe(true);
    }
    for (const table of TENANT_TABLES.filter((tb) => tb !== "audit_event")) {
      expect(plan.order, table).toContain(table);
    }
    // A build's rows go with the client's build; a template's build tested there only loses it.
    expect(plan.order).toEqual(expect.arrayContaining(["build", "build_item", "build_event"]));
    expect(plan.owner.get("build")).toBe("client_id");
    expect(plan.mentions).toEqual([{ table: "build", column: "test_client_id" }]);
  });

  it("clears links on the client's own rows where rows name their client by tenant_id", async () => {
    const plan = await purgePlan(t.db);
    const dialect = new PgDialect();
    const id = "00000000-0000-0000-0000-000000000001";
    const text = (table: string) =>
      plan.clear
        .filter((c) => c.key.child === table)
        .map((c) => dialect.sqlToQuery(c.where(id)).sql);
    // The largest tables: each clear is limited to the client's rows (and its index).
    for (const table of ["step_run", "model_call", "message", "external_action", "alert"]) {
      expect(text(table).length, table).toBeGreaterThan(0);
      for (const q of text(table)) expect(q, table).toContain(`"${table}"."tenant_id" = $`);
    }
    // A template's row may point at the client's (operator tables allow tenant_id null).
    for (const q of text("builder_session")) {
      expect(q).toContain(`"builder_session"."tenant_id" is null`);
    }
    // A build may be another client's or a template's, tested at this one: not limited.
    expect(text("build").length).toBeGreaterThan(0);
    for (const q of text("build")) expect(q).not.toContain(`"build"."client_id"`);
  });

  it("purges a client with builds and Reggie's records about it, keeping the operator's own", async () => {
    const X = await insertClient(t.db, "X");
    const Y = await insertClient(t.db, "Y");
    const one = async <T>(q: ReturnType<typeof sql>) =>
      [...(await t.db.execute<T & Record<string, unknown>>(q))][0] as T;
    const op = await one<{ id: string }>(sql`
      insert into app_user (email, name) values (${`op-${X.tenantId}@example.com`}, 'Op')
      returning id`);
    // A build for X (its agent, Builder conversation and test copy), with its items, messages
    // and events; a template build tested at X; and Y's build.
    const build = async (
      client: string | null,
      testClient: string | null,
      testAgent: string | null,
      agentId: string | null,
      session: string | null,
    ) =>
      (
        await one<{ id: string }>(sql`
          insert into build (client_id, kind, title, agent_id, session_id, test_client_id,
            test_agent_id, created_by)
          values (${client}, 'agent', 'A build', ${agentId}, ${session}, ${testClient},
            ${testAgent}, ${op.id})
          returning id`)
      ).id;
    const xBuild = await build(X.tenantId, X.tenantId, X.agentId, X.agentId, X.builderSessionId);
    const templateBuild = await build(null, X.tenantId, X.agentId, null, null);
    const yBuild = await build(Y.tenantId, Y.tenantId, Y.agentId, Y.agentId, Y.builderSessionId);
    for (const id of [xBuild, templateBuild, yBuild]) {
      await t.db.execute(sql`
        insert into build_item (build_id, phase, kind, title) values (${id}, 'intake', 'note', 'n')`);
      await t.db.execute(sql`
        insert into build_message (build_id, phase, role, text) values (${id}, 'intake', 'operator', 'hi')`);
      await t.db.execute(sql`insert into build_event (build_id, kind) values (${id}, 'phase')`);
    }
    // Reggie: a conversation about X, and a proposal for X in one about everything.
    const aboutX = await one<{ id: string }>(sql`
      insert into reggie_conversation (user_id, client_id) values (${op.id}, ${X.tenantId})
      returning id`);
    await t.db.execute(sql`
      insert into reggie_message (conversation_id, role, text) values (${aboutX.id}, 'operator', 'x')`);
    const aboutAll = await one<{ id: string }>(sql`
      insert into reggie_conversation (user_id) values (${op.id}) returning id`);
    await t.db.execute(sql`
      insert into reggie_message (conversation_id, role, text) values (${aboutAll.id}, 'operator', 'all')`);
    await t.db.execute(sql`
      insert into reggie_action (conversation_id, user_id, client_id, tool, args, preview)
      values (${aboutAll.id}, ${op.id}, ${X.tenantId}, 'clients_get', '{}', '{}')`);

    await t.db.execute(
      sql`update tenant set retired_at = now() - interval '31 days' where id = ${X.tenantId}`,
    );
    // Through one connection, as the owner's script runs it.
    const script = createDb(t.url, { max: 1 });
    const report = await purgeClient(script, X.tenantId, { force: true }).finally(() =>
      closeDb(script),
    );
    expect(report.cleared).toContainEqual({ table: "build", column: "test_client_id", rows: 2 });

    const rows = async (q: ReturnType<typeof sql>) => [...(await t.db.execute(q))].length;
    expect(await rows(sql`select 1 from tenant where id = ${X.tenantId}`)).toBe(0);
    // X's build and everything on it are gone.
    for (const table of ["build_item", "build_message", "build_event"]) {
      expect(
        await rows(sql`select 1 from ${sql.raw(table)} where build_id = ${xBuild}`),
        table,
      ).toBe(0);
      expect(
        await rows(
          sql`select 1 from ${sql.raw(table)} where build_id in (${templateBuild}, ${yBuild})`,
        ),
        `${table} of the others`,
      ).toBe(2);
    }
    expect(await rows(sql`select 1 from build where id = ${xBuild}`)).toBe(0);
    // The template's build stays, no longer tested at X.
    expect([
      ...(await t.db.execute(
        sql`select test_client_id, test_agent_id from build where id = ${templateBuild}`,
      )),
    ]).toEqual([{ test_client_id: null, test_agent_id: null }]);
    expect(
      await rows(sql`select 1 from build where id = ${yBuild} and client_id = ${Y.tenantId}`),
    ).toBe(1);
    // Reggie's records about X go; the conversation about everything stays.
    expect(await rows(sql`select 1 from reggie_conversation where id = ${aboutX.id}`)).toBe(0);
    expect(await rows(sql`select 1 from reggie_action where client_id = ${X.tenantId}`)).toBe(0);
    expect(
      await rows(sql`select 1 from reggie_message where conversation_id = ${aboutAll.id}`),
    ).toBe(1);
  });
});
