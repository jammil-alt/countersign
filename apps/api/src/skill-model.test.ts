// The skill model (owner, 2026-11-10; docs/plan.md §1.86 "Skill model"). Without a database: every
// built-in's kind is derived (never stored), and a pack tool is handed the model only when it
// declares `usesModel`. With one: the builder's catalog leaves the tool wrappers out and lists the
// tools a step may call instead, and "what moves if this step goes to v2" answers the breaks and
// every reference downstream to remap.

import { TESTKIT_QUERY_TOOL } from "@countersign/connectors";
import { isToolWrapper, skillKind, toolLookup } from "@countersign/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";
import { packToolTransport } from "./packs";
import { createPlatform, deploymentConnectors } from "./platform";
import { stepModelFacts, timelineWrite } from "./skill-facts";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const platform = createPlatform({ connectors: deploymentConnectors({}, false) });

describe("kinds of the built-in skills", () => {
  it("derives each one's kind from its mode and the tools it calls, never storing one", () => {
    const lookup = toolLookup(platform.tools.specs());
    const ai = platform.catalog
      .list()
      .filter((d) => d.mode === "tool" && skillKind(d, lookup) === "ai")
      .map((d) => d.id)
      .sort();
    // The hidden AI: code skills whose tool calls a model inside. Each is labelled AI.
    expect(ai).toEqual(
      expect.arrayContaining(["comms.converse", "comms.translate", "docs.extract", "docs.read"]),
    );
    for (const id of ai) expect(platform.catalog.get(id)).not.toHaveProperty("kind");
    // Code that calls no model stays deterministic (a connector read, the testkit's query).
    const plain = platform.catalog.get(TESTKIT_QUERY_TOOL);
    expect(plain && skillKind(plain, lookup)).toBe("deterministic");
  });

  it("hands the model only to a pack tool that declares it", () => {
    const transport = { create: async () => Promise.reject(new Error("no model")) };
    const packIds = new Set(["materials", "marketing", "bookkeeping"]);
    const packTools = platform.tools.list().filter((t) => packIds.has(t.spec.source));
    expect(packTools.length).toBeGreaterThan(0);
    const declared: string[] = [];
    for (const t of packTools) {
      const given = packToolTransport(t.spec, { transport });
      if (t.spec.usesModel !== undefined) {
        declared.push(t.spec.id);
        expect(given).toBe(transport);
      } else expect(given, t.spec.id).toBeNull();
    }
    // DECISION: Materials' create-item (reading a name its rules can't parse) and line matching
    // (the attribute fallback and the close-match adjudication) are the packs' hidden AI.
    // Splits (2026-11-10): `match_lines` matches each line as `match_line` does, so it says so too.
    expect(declared.sort()).toEqual([
      "materials.catalog.create_item",
      "materials.match_line",
      "materials.match_lines",
    ]);
  });
});

describe("what the run views say of a step (wave A)", () => {
  it("labels skill steps by kind and writes by where they write", async () => {
    const definition = {
      schemaVersion: 4,
      triggers: [{ id: "t1", on: { type: "manual", input: { type: "object" } } }],
      steps: [
        { id: "read-doc", name: "Read", kind: "skill", skill: "docs.extract", input: {} },
        { id: "look", name: "Look", kind: "skill", skill: TESTKIT_QUERY_TOOL, input: {} },
        { id: "save", name: "Draft", kind: "write", tool: "account.draft_change", input: {} },
        { id: "change", name: "Fix", kind: "write", tool: "testkit.record.update", input: {} },
      ],
    };
    // Built-ins only: no operator skill to read, so no transaction is needed.
    const facts = await stepModelFacts(null as never, "tenant", definition, platform);
    expect(facts).toEqual({
      "read-doc": { skillKind: "ai" },
      look: { skillKind: "deterministic" },
      save: { write: { kind: "save_to_records", text: "Save to records" } },
      change: { write: { kind: "change_in", text: "Change in Testkit" } },
    });
    // The client's timeline: saved, or changed in their tool by its name (never a tool id).
    expect(timelineWrite(platform, "account.draft_change")).toEqual({
      kind: "save_to_records",
      connector: null,
    });
    expect(timelineWrite(platform, "testkit.record.update")).toEqual({
      kind: "change_in",
      connector: "Testkit",
    });
    // A tool nobody knows reads as a client's tool: the safe side (invariant 8).
    expect(timelineWrite(platform, "nobody.knows")).toEqual({ kind: "change_in", connector: null });
  });
});

const h = await createApiHarness();
afterAll(() => h?.close());

const v1 = {
  schemaVersion: 1,
  id: "custom:match-line",
  name: "Match a line",
  description: "The catalog item a line is",
  category: "purchasing",
  mode: "task",
  model: { id: "claude-haiku-5-5" },
  instructions: "Match the line to an item.",
  tools: [],
  input: { type: "object", properties: { line: { type: "string" } }, required: ["line"] },
  output: {
    type: "object",
    properties: { itemId: { type: "string" }, confidence: { type: "number" } },
    required: ["itemId", "confidence"],
  },
  parameters: [{ name: "floor", label: "Lowest confidence", type: "number", default: 0.8 }],
};

const process = {
  schemaVersion: 4,
  triggers: [
    {
      id: "t1",
      on: { type: "manual", input: { type: "object", properties: { line: { type: "string" } } } },
    },
  ],
  steps: [
    {
      id: "match",
      name: "Match",
      kind: "skill",
      skill: "custom:match-line@1",
      input: { line: "{{trigger.line}}" },
    },
    {
      id: "tell",
      name: "Tell",
      kind: "notify",
      notify: { to: ["lead"], message: "Matched {{steps.match.output.itemId}}" },
    },
  ],
};

describe.skipIf(!h)("the builder and the skill model", () => {
  const H = h as ApiHarness;
  let agentId = "";

  beforeAll(async () => {
    const template = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "line-matcher",
      bundle: testBundle("Line matcher"),
      releaseNote: "First",
    });
    expect(template.status, JSON.stringify(template.json)).toBe(200);
    agentId = j(template.json).agent.id;
    const created = await H.call(OPERATOR, "POST", "/api/ops/skills", { definition: v1 });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const skillId = j(created.json).skill.id;
    // v2 renames the item's id and adds a parameter with no default: a breaking move.
    const v2 = {
      ...v1,
      output: {
        type: "object",
        properties: { catalogItemId: { type: "string" }, confidence: { type: "number" } },
        required: ["catalogItemId", "confidence"],
      },
      parameters: [...v1.parameters, { name: "vendor_hint", label: "Vendor hint", type: "text" }],
    };
    const saved = await H.call(OPERATOR, "POST", `/api/ops/skills/${skillId}/versions`, {
      definition: v2,
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  });

  it("leaves tool wrappers out of the catalog and lists the tools a step may call instead", async () => {
    const res = await H.call(OPERATOR, "GET", `/api/ops/agents/${agentId}/builder-catalog`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const body = j(res.json);
    const wrappers = body.skills.filter((s: { definition: never }) => isToolWrapper(s.definition));
    expect(wrappers).toEqual([]);
    expect(body.stepTools).toContain(TESTKIT_QUERY_TOOL);
    expect(body.stepTools).not.toContain("comms.converse");
    for (const s of body.skills) {
      expect(["deterministic", "ai"]).toContain(s.kind);
      expect(typeof s.palette).toBe("boolean");
    }
  });

  it("says what moves if a step goes to another version, and every reference to remap", async () => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/skill-move`, {
      process,
      stepId: "match",
      to: "custom:match-line@2",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const body = j(res.json);
    expect(body).toMatchObject({ from: "custom:match-line@1", to: "custom:match-line@2" });
    expect(body.compatible).toBe(false);
    expect(body.breaks.map((b: { kind: string; field: string }) => [b.kind, b.field])).toEqual([
      ["removed", "itemId"],
      ["parameter_required_added", "vendor_hint"],
    ]);
    expect(body.breaks[0].renamedTo).toBe("catalogItemId");
    expect(body.references).toEqual([
      {
        stepId: "tell",
        at: "notify.message",
        expr: "steps.match.output.itemId",
        field: "itemId",
      },
    ]);
    expect(body.errors.map((e: { stepId: string; code: string }) => [e.stepId, e.code])).toEqual([
      ["tell", "template_path"],
    ]);
    expect(body.facts).toMatchObject({
      kind: "ai",
      kindLabel: "AI",
      recommendedModel: { id: "claude-haiku-5-5" },
    });
    expect(body.definition).not.toHaveProperty("instructions");

    // The same version moves in one click.
    const same = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/skill-move`, {
      process,
      stepId: "match",
      to: "custom:match-line@1",
    });
    expect(j(same.json)).toMatchObject({ compatible: true, breaks: [], references: [] });
  });

  it("lists each skill the agent may use with its kind, parameters and recommended model", async () => {
    const res = await H.call(OPERATOR, "GET", `/api/ops/agents/${agentId}/skills`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const skills = j(res.json).skills as { id: string; kind: string }[];
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills) {
      expect(s).toMatchObject({ parameters: expect.any(Array) });
      expect(["deterministic", "ai"]).toContain(s.kind);
      expect(s).toHaveProperty("recommendedModel");
    }
    // Each kind matches the platform's own derivation of it.
    const lookup = toolLookup(h?.platform.tools.specs() ?? {});
    for (const s of skills) {
      const def = h?.platform.catalog.get(s.id);
      if (def) expect(s.kind, s.id).toBe(skillKind(def, lookup));
    }
  });

  it("refuses a step that isn't a skill step, or another skill", async () => {
    const notSkill = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/skill-move`, {
      process,
      stepId: "tell",
      to: "custom:match-line@2",
    });
    expect(notSkill.status).toBe(422);
    const other = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/skill-move`, {
      process,
      stepId: "match",
      to: "custom:other@1",
    });
    expect(other.status).toBe(422);
  });

  it("refuses an agent-mode skill as a new version, in plain words", async () => {
    const res = await H.call(OPERATOR, "POST", "/api/ops/skills", {
      definition: { ...v1, id: "custom:old-style", mode: "agent", model: undefined },
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.json)).toContain("write step");
  });
});
