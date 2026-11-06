// The bench's skill runner on the FakeModel: fixtures answer reads, every write is refused, no
// connector is reached and nothing is stored.

import {
  ConnectorRegistry,
  createTestkitConnector,
  TESTKIT_QUERY_TOOL,
  TESTKIT_UPDATE_TOOL,
} from "@countersign/connectors";
import type { SkillDefinition } from "@countersign/core";
import { FakeModel } from "@countersign/llm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../registry/tools";
import { PLATFORM_TOOLS } from "../tools/platform";
import { defineInternalTool } from "../tools/types";
import { BENCH_REFUSED_WRITE, runSkillCase } from "./run-skill";

const skill: SkillDefinition = {
  schemaVersion: 1,
  id: "custom:price-check",
  name: "Price check",
  description: "Finds a record's price",
  category: "test",
  mode: "agent",
  instructions: "Look the record up and report its amount.",
  tools: [TESTKIT_QUERY_TOOL, TESTKIT_UPDATE_TOOL, "memory.write"],
  input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  output: {
    type: "object",
    properties: {
      amount: { type: "string" },
      sources: { type: "array", items: { type: "string" } },
    },
    required: ["amount"],
  },
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
};

function registry() {
  const testkit = createTestkitConnector();
  const query = vi.spyOn(testkit.backend, "query");
  const update = vi.spyOn(testkit.backend, "update");
  const tools = new ToolRegistry({
    platform: PLATFORM_TOOLS,
    connectors: new ConnectorRegistry([testkit]),
  });
  return { tools, query, update };
}

describe("runSkillCase", () => {
  it("answers reads from fixtures and refuses every write, touching no connector", async () => {
    const { tools, query, update } = registry();
    const model = new FakeModel([
      { toolUse: { name: "testkit__record__query", input: { ids: ["r1"] } } },
      { toolUse: { name: "testkit__record__query", input: { ids: ["r2"] } } },
      { toolUse: { name: "testkit__record__update", input: { id: "r1", amount: "1.00" } } },
      { toolUse: { name: "memory__write", input: { note: "remember", scope: "x" } } },
      { toolUse: { name: "finish", input: { amount: "12.50", sources: ["r1"] } } },
    ]);
    const run = await runSkillCase(
      { tools, transport: model },
      {
        definition: skill,
        tenantId: null,
        input: { id: "r1" },
        fixtures: [
          {
            tool: TESTKIT_QUERY_TOOL,
            input: { ids: ["r1"] },
            output: { records: [{ id: "r1", amount: "12.50" }] },
          },
          // A fixture can't make a write happen.
          { tool: TESTKIT_UPDATE_TOOL, output: { record: { id: "r1" } } },
        ],
      },
    );
    expect(run.status).toBe("succeeded");
    expect(run.output).toEqual({ amount: "12.50", sources: ["r1"] });
    expect(run.toolCalls.map((c) => [c.tool, c.status])).toEqual([
      [TESTKIT_QUERY_TOOL, "succeeded"],
      [TESTKIT_QUERY_TOOL, "failed"],
      [TESTKIT_UPDATE_TOOL, "refused"],
      ["memory.write", "refused"],
    ]);
    expect(run.toolCalls[1]?.reason).toMatch(/no fixture answers/);
    expect(run.toolCalls[2]?.reason).toBe(BENCH_REFUSED_WRITE);
    expect(query).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    // The model saw the fixture's answer as a tool result, and the write's refusal.
    const results = JSON.stringify(model.requests.at(-1)?.messages);
    expect(results).toContain("12.50");
    expect(results).toContain(BENCH_REFUSED_WRITE);
    expect(run.modelCalls).toBe(5);
    expect(Number(run.costUsd)).toBeGreaterThan(0);
  });

  it("reports an invalid output as a failure, not a throw", async () => {
    const { tools } = registry();
    const model = new FakeModel([{ toolUse: { name: "finish", input: {} } }, { refusal: true }]);
    const run = await runSkillCase(
      { tools, transport: model },
      { definition: skill, tenantId: null, input: { id: "r1" }, fixtures: [] },
    );
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/declined/);
  });

  it("runs a tool-mode skill only when its handler is pure", async () => {
    const pure = defineInternalTool({
      id: "bench.double",
      description: "Doubles a number",
      sideEffect: "none",
      source: "bench",
      pure: true,
      input: z.object({ n: z.number() }),
      output: z.object({ n: z.number() }),
      run: async ({ n }) => ({ n: n * 2 }),
    });
    const tools = new ToolRegistry({
      platform: PLATFORM_TOOLS,
      packs: [
        { manifest: { id: "bench", tools: [pure.spec] }, handlers: { "bench.double": pure } },
      ],
    });
    const toolSkill = (handler: string): SkillDefinition => ({
      ...skill,
      id: "bench.double-it",
      mode: "tool",
      handler,
      tools: [],
      instructions: undefined,
      input: { type: "object" },
      output: { type: "object" },
    });
    const ok = await runSkillCase(
      { tools, transport: new FakeModel() },
      { definition: toolSkill("bench.double"), tenantId: null, input: { n: 4 }, fixtures: [] },
    );
    expect(ok).toMatchObject({ status: "succeeded", output: { n: 8 }, modelCalls: 0 });
    const notPure = await runSkillCase(
      { tools, transport: new FakeModel() },
      { definition: toolSkill("docs.get"), tenantId: null, input: {}, fixtures: [] },
    );
    expect(notPure.status).toBe("failed");
    expect(notPure.error).toMatch(/pure handler/);
  });
});
