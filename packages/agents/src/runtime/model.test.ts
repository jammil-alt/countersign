// v0.13 W2-H (docs/plan.md §1.53): which model a skill step runs on.

import { describe, expect, it } from "vitest";
import { parseOperatorSkill } from "../registry/skills";
import { resolveModel } from "./model";

const agentModel = { id: "claude-sonnet-5-5", maxTokens: 4096 };
const task = { mode: "task" as const, model: { id: "claude-haiku-5-5", maxTokens: 512 } };

describe("resolveModel", () => {
  it("runs a task skill on its own model and an agent skill on the agent's", () => {
    expect(resolveModel(agentModel, task)).toEqual({ id: "claude-haiku-5-5", maxTokens: 512 });
    expect(resolveModel(agentModel, { mode: "agent" })).toEqual(agentModel);
  });

  it("lets the step override either, with maxTokens falling back step, skill, agent", () => {
    expect(resolveModel(agentModel, task, { id: "claude-opus-5-5" })).toEqual({
      id: "claude-opus-5-5",
      maxTokens: 512,
    });
    expect(resolveModel(agentModel, { mode: "agent" }, { id: "claude-opus-5-5" })).toEqual({
      id: "claude-opus-5-5",
      maxTokens: 4096,
    });
    expect(
      resolveModel(agentModel, { mode: "agent" }, { id: "claude-haiku-5-5", maxTokens: 300 }),
    ).toEqual({ id: "claude-haiku-5-5", maxTokens: 300 });
  });

  it("falls back to the agent's maxTokens when the task skill names none", () => {
    expect(resolveModel(agentModel, { mode: "task", model: { id: "claude-haiku-5-5" } })).toEqual({
      id: "claude-haiku-5-5",
      maxTokens: 4096,
    });
  });
});

describe("operator skills", () => {
  const base = {
    schemaVersion: 1,
    id: "custom:read-receipt",
    name: "Read a receipt",
    description: "Turn a receipt into its vendor and total",
    category: "custom",
    instructions: "Read the receipt.",
    tools: [],
    input: { type: "object" },
    output: { type: "object" },
  };

  it("may be task skills on a model the platform prices, or agent skills", () => {
    expect(
      parseOperatorSkill({ ...base, mode: "task", model: { id: "claude-haiku-5-5" } }).mode,
    ).toBe("task");
    expect(parseOperatorSkill({ ...base, mode: "agent" }).mode).toBe("agent");
  });

  it("refuses a task skill on an unknown model, and tool mode", () => {
    expect(() =>
      parseOperatorSkill({ ...base, mode: "task", model: { id: "claude-nonesuch" } }),
    ).toThrow(/unknown model claude-nonesuch/);
    expect(() => parseOperatorSkill({ ...base, mode: "tool", handler: "docs.extract" })).toThrow(
      /task or agent mode/,
    );
  });
});
