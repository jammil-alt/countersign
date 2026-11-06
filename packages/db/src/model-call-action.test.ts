// Migration 0032 (token counts by action, docs/plan.md §1.62): `model_call.action`. The previous
// Worker inserts model calls without naming it, and those still succeed and read `agent_turn`; an
// action outside the list is refused; the column changes nothing about the row being insert only.

import { MODEL_CALL_ACTIONS as CORE_ACTIONS } from "@countersign/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ClientFixture, insertClient } from "./fixtures.test-helper";
import { MODEL_CALL_ACTIONS } from "./schema";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();
const CHECK = "23514";

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.code ?? e.cause?.code ?? "unknown";
  }
  return undefined;
}

describe("model call actions", () => {
  it("are core's list", () => {
    expect([...MODEL_CALL_ACTIONS]).toEqual([...CORE_ACTIONS]);
  });
});

describe.skipIf(!online)("model_call.action (0032)", () => {
  let t: TestDatabase;
  let c: ClientFixture;

  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    c = await insertClient(t.db, "Actions");
  });
  afterAll(async () => {
    await t?.drop();
  });

  const insert = (action: string | null) => {
    const key = `tenants/${c.tenantId}/model-calls/${crypto.randomUUID()}.json`;
    return action === null
      ? t.db.$client`
          insert into model_call (tenant_id, run_id, step_run_id, provider, model, tokens_in,
                                  tokens_out, cost_usd, duration_ms, stop_reason, body_key)
          values (${c.tenantId}, ${c.runId}, ${c.stepRunId}, 'anthropic', 'claude-sonnet-5-5',
                  10, 5, 0.0001, 100, 'end_turn', ${key})
          returning action`
      : t.db.$client`
          insert into model_call (tenant_id, run_id, step_run_id, provider, model, action,
                                  tokens_in, tokens_out, cost_usd, duration_ms, stop_reason, body_key)
          values (${c.tenantId}, ${c.runId}, ${c.stepRunId}, 'google', 'gemini:gemini-3.1-pro',
                  ${action}, 10, 5, 0.0001, 100, 'end_turn', ${key})
          returning action`;
  };

  it("reads agent_turn when an insert doesn't name it, as the previous Worker's don't", async () => {
    const rows = (await insert(null)) as unknown as { action: string }[];
    expect(rows[0]?.action).toBe("agent_turn");
  });

  it("takes each action on the list and refuses any other", async () => {
    for (const action of MODEL_CALL_ACTIONS) {
      const rows = (await insert(action)) as unknown as { action: string }[];
      expect(rows[0]?.action).toBe(action);
    }
    expect(await errorCode(insert("chat"))).toBe(CHECK);
  });
});
