// R2 (docs/plan.md §1.86, §9): the registries answer the v3 converter (which skills only wrap a
// tool, and each tool's side effect), and a skill's declared reads are tools that only read.

import {
  ConnectorRegistry,
  createTestkitConnector,
  TESTKIT_QUERY_TOOL,
  TESTKIT_UPDATE_TOOL,
} from "@countersign/connectors";
import { processes, SkillDefinition, Workflow } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { AgentsError } from "../errors";
import { DOCS_SKILLS } from "../tools/docs";
import { PLATFORM_TOOLS } from "../tools/platform";
import { convertLookup, parseOperatorSkill, readProblems, SkillCatalog } from "./skills";
import { ToolRegistry } from "./tools";

const tools = new ToolRegistry({
  platform: PLATFORM_TOOLS,
  connectors: new ConnectorRegistry([createTestkitConnector()]),
});

const task = (extra: Record<string, unknown> = {}) =>
  SkillDefinition.parse({
    schemaVersion: 1,
    id: "test.price-check",
    name: "Price check",
    description: "Compare a record's price",
    category: "general",
    mode: "task",
    model: { id: "claude-haiku-5-5" },
    instructions: "Compare the price.",
    tools: [],
    input: { type: "object", properties: { id: { type: "string" } } },
    output: { type: "object", properties: { ok: { type: "boolean" } } },
    ...extra,
  });

// A tool-mode skill that computes with more than its handler: not a wrapper.
const computes = SkillDefinition.parse({
  ...task(),
  id: "test.computes",
  mode: "tool",
  model: undefined,
  instructions: undefined,
  handler: "docs.extract",
  tools: [TESTKIT_QUERY_TOOL],
});

describe("convertLookup", () => {
  const catalog = new SkillCatalog([...DOCS_SKILLS, task(), computes], tools);
  const lookup = convertLookup(catalog, tools);

  it("names the tool a wrapper skill wraps, and nothing for skills that think or compute", () => {
    expect(lookup.wrappedTool("docs.extract")).toBe("docs.extract");
    expect(lookup.wrappedTool("test.price-check")).toBeNull();
    expect(lookup.wrappedTool("test.computes")).toBeNull();
    expect(lookup.wrappedTool("custom:anything")).toBeNull();
  });

  it("answers each tool's side effect, null when unknown", () => {
    expect(lookup.sideEffect(TESTKIT_QUERY_TOOL)).toBe("none");
    expect(lookup.sideEffect(TESTKIT_UPDATE_TOOL)).toBe("external");
    expect(lookup.sideEffect("docs.extract")).toBe(tools.get("docs.extract")?.spec.sideEffect);
    expect(lookup.sideEffect("nope.nothing")).toBeNull();
  });

  it("reads a v3 workflow as v4 with the real registries", () => {
    const p = processes.fromWorkflowV3(
      Workflow.parse({
        schemaVersion: 3,
        trigger: { id: "t", on: { type: "manual", input: {} } },
        steps: [
          { id: "x", name: "Extract", kind: "skill", skill: "docs.extract" },
          { id: "c", name: "Check", kind: "skill", skill: "test.price-check" },
        ],
      }),
      lookup,
    );
    expect(p.steps.map((s) => [s.id, s.kind])).toEqual([
      ["x", tools.get("docs.extract")?.spec.sideEffect === "none" ? "read" : "write"],
      ["c", "skill"],
    ]);
  });
});

describe("declared reads", () => {
  it("must be registered read tools", () => {
    expect(readProblems(task({ reads: [TESTKIT_QUERY_TOOL] }), tools)).toEqual([]);
    expect(readProblems(task({ reads: [TESTKIT_UPDATE_TOOL, "nope.nothing"] }), tools)).toEqual([
      `${TESTKIT_UPDATE_TOOL} is not a read tool (external); a skill never writes`,
      "unknown read tool nope.nothing",
    ]);
  });

  it("are checked in the catalog and on operator skills", () => {
    expect(() => new SkillCatalog([task({ reads: [TESTKIT_UPDATE_TOOL] })], tools)).toThrow(
      /a skill never writes/,
    );
    expect(
      parseOperatorSkill(
        { ...task({ reads: [TESTKIT_QUERY_TOOL] }), id: "custom:price-check" },
        tools,
      ).reads,
    ).toEqual([TESTKIT_QUERY_TOOL]);
    expect(() =>
      parseOperatorSkill({ ...task({ reads: [TESTKIT_UPDATE_TOOL] }), id: "custom:x" }, tools),
    ).toThrow(AgentsError);
  });
});
