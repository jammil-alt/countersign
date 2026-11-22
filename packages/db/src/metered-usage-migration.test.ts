// Migration 0081 (docs/plan.md §1.210): `metered_usage`, what we pay vendors for outside a run's
// model calls. A client's session sees and writes only its own rows and never the back office's;
// an operator sees the back office's and the platform's; any session may write a row with no
// client, which must be ours; rows are counted once and never changed; the rollups have the new
// measure columns and the unit costs their placeholders.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOperator, withTenant } from "./client";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
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

describe.skipIf(!online)("0081: metered_usage", () => {
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

  const as = <T>(
    scope: "A" | "operator" | "none",
    fn: (run: (q: string) => Promise<unknown>) => Promise<T>,
  ) => {
    const go = async (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => {
      await asWorker(tx);
      return fn((q) => tx.execute(sql.raw(q)));
    };
    if (scope === "A") return withTenant(t.db, A.tenantId, go);
    if (scope === "operator") return withOperator(t.db, [A.tenantId, B.tenantId], go);
    return withOperator(t.db, [], async (tx) => {
      await tx.execute(sql`select set_config('app.operator', 'off', true)`);
      return go(tx);
    });
  };
  const rows = async (scope: "A" | "operator") =>
    (await as(scope, (run) =>
      run("select key from metered_usage where key not like 'fixture:%' order by key"),
    )) as unknown as {
      key: string;
    }[];

  it("forces row-level security", async () => {
    const [r] = await t.db.execute<{ rls: boolean; forced: boolean }>(sql`
      select relrowsecurity as rls, relforcerowsecurity as forced from pg_class
      where relname = 'metered_usage'`);
    expect(r).toEqual({ rls: true, forced: true });
  });

  it("keeps each client's rows, the back office's and the platform's apart", async () => {
    await as("A", (run) =>
      run(`insert into metered_usage (tenant_id, agent_id, run_id, measure, quantity, source, key)
           values ('${A.tenantId}', '${A.agentId}', '${A.runId}', 'emails', 1, 'run', 'a:email'),
                  ('${A.tenantId}', null, null, 'messages', 2, 'notification', 'a:text')`),
    );
    await as("operator", (run) =>
      run(`insert into metered_usage (tenant_id, measure, source, ours, model, tokens_in,
             tokens_out, cost_usd, key)
           values ('${A.tenantId}', 'model', 'reggie_read', true, 'claude-haiku', 10, 5, 0.0010,
                   'a:read'),
                  ('${B.tenantId}', 'emails', 'notification', false, null, 0, 0, null, 'b:email'),
                  (null, 'model', 'dev_queue', true, 'claude-haiku', 10, 5, 0.0010, 'dq')`),
    );
    // A sign-in code: no client in scope yet, so no client and ours.
    await as("none", (run) =>
      run(`insert into metered_usage (measure, source, ours, key)
           values ('verifications', 'sign_in_code', true, 'verify')`),
    );
    expect((await rows("A")).map((r) => r.key)).toEqual(["a:email", "a:text"]);
    expect((await rows("operator")).map((r) => r.key)).toEqual([
      "a:email",
      "a:read",
      "a:text",
      "b:email",
      "dq",
      "verify",
    ]);
    // Another client's row, or one with no client that isn't ours: refused.
    expect(
      await errorCode(
        as("A", (run) =>
          run(`insert into metered_usage (tenant_id, measure, source, key)
               values ('${B.tenantId}', 'emails', 'run', 'x1')`),
        ),
      ),
    ).toBe("42501");
    expect(
      await errorCode(
        as("none", (run) =>
          run(`insert into metered_usage (measure, source, key)
               values ('verifications', 'sign_in_code', 'x2')`),
        ),
      ),
    ).toBeDefined();
  });

  it("counts once, never changes a row, and checks what a row says", async () => {
    expect(
      await errorCode(
        as("A", (run) =>
          run(`insert into metered_usage (tenant_id, measure, source, key)
               values ('${A.tenantId}', 'emails', 'run', 'a:email')`),
        ),
      ),
    ).toBe("23505");
    expect(
      await errorCode(as("A", (run) => run("update metered_usage set quantity = 9"))),
    ).toBeDefined();
    expect(await errorCode(as("A", (run) => run("delete from metered_usage")))).toBeDefined();
    const bad = [
      // A model call without its cost, and a text with one.
      `('${A.tenantId}', 'model', 1, 'run', null, 'y1')`,
      `('${A.tenantId}', 'messages', 1, 'run', 0.01, 'y2')`,
      `('${A.tenantId}', 'faxes', 1, 'run', null, 'y3')`,
      `('${A.tenantId}', 'emails', 0, 'run', null, 'y4')`,
      `('${A.tenantId}', 'emails', 1, 'Not A Source', null, 'y5')`,
    ];
    // Cache reads and writes are kept apart from fresh input, never negative.
    expect(
      await errorCode(
        as("operator", (run) =>
          run(`insert into metered_usage (tenant_id, measure, source, ours, model, cost_usd,
                 cache_read_tokens, key)
               values ('${A.tenantId}', 'model', 'builder', true, 'm', 0.0010, -1, 'y6')`),
        ),
      ),
    ).toBe("23514");
    for (const v of bad) {
      expect(
        await errorCode(
          as("A", (run) =>
            run(`insert into metered_usage (tenant_id, measure, quantity, source, cost_usd, key)
                 values ${v}`),
          ),
        ),
        v,
      ).toBe("23514");
    }
  });

  it("adds the rollups' measure columns and the placeholder unit costs", async () => {
    const cols = await t.db.execute<{ table_name: string; column_name: string }>(sql`
      select table_name, column_name from information_schema.columns
      where table_name in ('usage_daily', 'usage_platform_daily')
        and column_name in ('emails', 'browser_seconds', 'messages', 'bank_item_months')
      order by table_name, column_name`);
    expect([...cols].map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      "usage_daily.browser_seconds",
      "usage_daily.emails",
      "usage_daily.messages",
      "usage_platform_daily.bank_item_months",
      "usage_platform_daily.browser_seconds",
      "usage_platform_daily.emails",
      "usage_platform_daily.messages",
    ]);
    const costs = await t.db.execute<{ measure: string; unit_cost: string; per_units: number }>(sql`
      select measure, unit_cost::text, per_units from billing_unit_cost
      where measure in ('emails', 'browser_seconds', 'verifications', 'bank_item_months')
      order by measure`);
    expect([...costs]).toEqual([
      { measure: "bank_item_months", unit_cost: "0.3000", per_units: 1 },
      { measure: "browser_seconds", unit_cost: "0.0900", per_units: 3600 },
      { measure: "emails", unit_cost: "0.0009", per_units: 1 },
      { measure: "verifications", unit_cost: "0.0500", per_units: 1 },
    ]);
  });
});
