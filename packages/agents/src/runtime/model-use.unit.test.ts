// Skill model (2026-11-10): code that calls a model inside a tool (the "hidden AI") is declared on
// the tool (`usesModel`), so a skill that calls it is labelled AI, never deterministic. A tool
// that records a model call without declaring it is caught: the runtime's `onUndeclaredModelCall`
// (tests throw there, so the step fails), while its cost is still recorded. No database.

import { skillKind, toolLookup } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { undeclaredModelCall } from "../log/harness.test-helper";
import { SkillCatalog } from "../registry/skills";
import { ToolRegistry } from "../registry/tools";
import { PLATFORM_TOOLS } from "../tools/platform";
import { defineInternalTool } from "../tools/types";
import { callTool } from "./call-tool";
import type { RuntimeDeps, StepContext } from "./context";
import type { RuntimePorts } from "./ports";

const usage = { costUsd: "0.0100", tokensIn: 10, tokensOut: 5 };

const quiet = defineInternalTool({
  id: "test.quiet_model",
  description: "Calls a model without saying so",
  sideEffect: "none",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  async run(_input, ctx) {
    await ctx.recordUsage?.(usage);
    return { ok: true };
  },
});

const declared = defineInternalTool({
  id: "test.declared_model",
  description: "Calls a model and says so",
  sideEffect: "none",
  usesModel: "reads the text with a model",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  async run(_input, ctx) {
    await ctx.recordUsage?.(usage);
    return { ok: true };
  },
});

function harness(onUndeclared?: RuntimeDeps["onUndeclaredModelCall"]) {
  const recorded: unknown[] = [];
  const ports = {
    log: {
      startToolCall: async () => "tc-1",
      finishToolCall: async () => {},
      addUsage: async (_t: string, _at: unknown, u: unknown) => {
        recorded.push(u);
      },
    },
  } as unknown as RuntimePorts;
  const tools = new ToolRegistry({ platform: [quiet, declared] });
  const deps: RuntimeDeps = {
    ports,
    tools,
    catalog: new SkillCatalog([], tools),
    transport: { create: async () => Promise.reject(new Error("no model here")) },
    ...(onUndeclared ? { onUndeclaredModelCall: onUndeclared } : {}),
  };
  const step: StepContext = {
    tenantId: "t1",
    agent: {
      agentId: "a1",
      agentVersionId: "v1",
      tenantId: "t1",
      slug: "a",
      version: 1,
      bundle: {} as never,
      bindings: {},
      approver: null,
    },
    runId: "r1",
    stepRunId: "sr1",
    stepId: "s1",
    mode: "live",
    externalIndex: { next: 0 },
  };
  return { deps, step, recorded };
}

describe("a tool that calls a model says so", () => {
  it("fails the step in tests when it doesn't, and keeps the cost", async () => {
    const { deps, step, recorded } = harness(undeclaredModelCall);
    const out = await callTool(deps, step, { toolId: "test.quiet_model", input: {} });
    expect(out).toEqual({
      status: "failed",
      error: "test.quiet_model called a model without declaring usesModel",
    });
    expect(await callTool(deps, step, { toolId: "test.declared_model", input: {} })).toMatchObject({
      status: "done",
    });
    // The undeclared call's cost was recorded before it was caught: no cost is lost.
    expect(recorded).toEqual([usage, usage]);
  });

  it("only reports it outside tests: the step goes on", async () => {
    const seen: string[] = [];
    const { deps, step } = harness((id) => seen.push(id));
    expect(await callTool(deps, step, { toolId: "test.quiet_model", input: {} })).toMatchObject({
      status: "done",
    });
    expect(seen).toEqual(["test.quiet_model"]);
  });

  it("declares every platform tool that calls a model, so its skills read as AI", () => {
    const declaredIds = PLATFORM_TOOLS.filter((t) => t.spec.usesModel !== undefined)
      .map((t) => t.spec.id)
      .sort();
    // DECISION: the hidden AI among the platform's tools: document reading, translation, web
    // research on the vendor's server tools, and the conversation engine's turns.
    expect(declaredIds).toEqual([
      "comms.converse",
      "comms.translate",
      "docs.extract",
      "docs.read",
      "web.fetch",
      "web.search",
    ]);
    const lookup = toolLookup(PLATFORM_TOOLS.map((t) => t.spec));
    const wrapper = (handler: string) => ({ mode: "tool" as const, handler, tools: [] });
    expect(skillKind(wrapper("docs.extract"), lookup)).toBe("ai");
    expect(skillKind(wrapper("docs.get"), lookup)).toBe("deterministic");
  });
});
