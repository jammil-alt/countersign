// Migration 0048 (ARCHITECTURE v0.17 §10.14; docs/plan.md §1.97, M60): `oversight_decision` also
// keeps the agent's choices: an `if` it chooses (cause `choose`, the path in `choice`) and a
// repeat it says is done or not (cause `until`). It applies on a database the previous Worker
// used, every decision kept as it was; the previous Worker's insert (which never names `choice`)
// still works; a choice needs its path and nothing else carries one; row-level security holds.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import {
  createTestDatabase,
  databaseAvailable,
  migrateAsOwner,
  type TestDatabase,
} from "./testing";

const online = await databaseAvailable();

describe.skipIf(!online)("0048 on a database the previous Worker used", () => {
  let t: TestDatabase;
  let A: ClientFixture;

  beforeAll(async () => {
    const created = await createTestDatabase({ migrate: false });
    if (!created) throw new Error("database vanished");
    t = created;
    await migrateAsOwner(t.url, { upTo: "0047_vendor_catalog" });
    A = await insertClient(t.db, "A");
    await migrateAsOwner(t.url);
  });
  afterAll(async () => {
    await t?.drop();
  });

  /** One decision row; `seq` keeps each test's row apart. */
  const insert = (seq: number, cause: string, action: string, choice: string | null) =>
    t.db.$client`
      insert into oversight_decision
        (tenant_id, run_id, step_run_id, node_id, seq, cause, action, choice, note, model,
         agent_version_id)
      values (${A.tenantId}, ${A.runId}, ${A.stepRunId}, 'f', ${seq}, ${cause}, ${action},
        ${choice}, 'Two quotes: the item is new.', 'claude-opus-5-5', ${A.agentVersionId})`;

  const code = async (p: Promise<unknown>): Promise<string | null> => {
    try {
      await p;
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? "unknown";
    }
  };

  it("keeps every decision as it was, with no choice", async () => {
    const rows = await t.db.$client<{ cause: string; action: string; choice: string | null }[]>`
      select cause, action, choice from oversight_decision where id = ${A.oversightDecisionId}`;
    expect(rows).toEqual([{ cause: "failed", action: "retry", choice: null }]);
  });

  it("still takes the previous Worker's insert, which never names the choice", async () => {
    await t.db.$client`
      insert into oversight_decision
        (tenant_id, run_id, step_run_id, node_id, seq, cause, action, note, model, agent_version_id)
      values (${A.tenantId}, ${A.runId}, ${A.stepRunId}, 's1', 2, 'checkpoint', 'continue',
        'Looks right.', 'claude-opus-5-5', ${A.agentVersionId})`;
    const [row] = await t.db.$client<{ choice: string | null }[]>`
      select choice from oversight_decision where node_id = 's1' and seq = 2`;
    expect(row?.choice).toBeNull();
  });

  it("takes the agent's choices: a path chosen, unsure, a repeat done or not", async () => {
    expect(await code(insert(1, "choose", "choose", "0192f7a0-0000-7000-8000-000000000001"))).toBe(
      null,
    );
    expect(await code(insert(2, "choose", "unsure", null))).toBe(null);
    expect(await code(insert(3, "until", "again", null))).toBe(null);
    expect(await code(insert(4, "until", "done", null))).toBe(null);
  });

  it("refuses a choice without its path, a path on anything else, and an unknown word", async () => {
    expect(await code(insert(5, "choose", "choose", null))).toBe("23514");
    expect(await code(insert(6, "until", "done", "some-path"))).toBe("23514");
    expect(await code(insert(7, "chose", "choose", "p"))).toBe("23514");
    expect(await code(insert(8, "choose", "picked", null))).toBe("23514");
  });

  it("keeps the table's forced row-level security", async () => {
    const [row] = await t.db.$client<{ rls: boolean; forced: boolean }[]>`
      select relrowsecurity as rls, relforcerowsecurity as forced
      from pg_class where relname = 'oversight_decision'`;
    expect(row).toEqual({ rls: true, forced: true });
  });
});
