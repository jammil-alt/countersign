// A pack tool's model call (docs/plan.md §1.115): its cost goes on the step, and the call itself
// goes to the step's `model_call` writer, so its tokens count by model and action like a platform
// tool's. Without a database: the context only hands the call on.

import type { Db } from "@countersign/db";
import { FakeModel, type LlmCallRecord, type LlmExchange } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import { packToolContext } from "./tools";

describe("packToolContext", () => {
  it("hands each model call to the step's usage and its model call writer", async () => {
    const usage: unknown[] = [];
    const calls: { record: LlmCallRecord; exchange: LlmExchange }[] = [];
    const ctx = packToolContext({
      tenantId: "t1",
      agentVersionId: "v1",
      runId: "r1",
      mode: "live",
      settings: {},
      db: {} as Db,
      transport: new FakeModel([{ text: "Walnut veneer, 4x8" }]),
      recordUsage: async (u) => void usage.push(u),
      recordModelCall: async (record, exchange) => void calls.push({ record, exchange }),
    });
    await ctx.llm?.message({ messages: [{ role: "user", content: "Read this name." }] });
    expect(usage).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.record.ok).toBe(true);
    expect(JSON.stringify(calls[0]?.exchange.request)).toContain("Read this name.");
  });
});
