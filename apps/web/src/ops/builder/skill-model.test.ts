// The skill model (owner, 2026-11-10; ARCHITECTURE §10.14) in the builder's palette and steps:
// every skill says its kind, retired kinds and tool wrappers are never offered for a new step, the
// tools a step may call come from the server's `stepTools`, and a write reads "Save to records"
// (approval off to start with) or "Change in <connector>" (approval on).
import {
  type BuilderCatalog,
  type ProcessAgentBundle,
  type SkillDefinition,
  uuidv7,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import {
  type BuilderData,
  catalogSkillKind,
  paletteSections,
  typingContext,
  writeLabelOf,
} from "./catalog";
import { createStep, type PaletteItem } from "./model";

const io = { type: "object", properties: {} };

function skill(over: Partial<SkillDefinition> & { id: string }): SkillDefinition {
  return {
    schemaVersion: 1,
    name: over.id,
    description: "",
    category: "data",
    mode: "task",
    model: { id: "claude-haiku-5-5" },
    instructions: "Do it.",
    tools: [],
    input: io,
    output: io,
    settings: [],
    requiresConnectors: [],
    requiresPacks: [],
    producesAlerts: false,
    ...over,
  } as SkillDefinition;
}

const CATALOG: BuilderCatalog = {
  skills: [
    {
      ref: "custom:classify",
      source: "client",
      version: 1,
      definition: skill({ id: "custom:classify", name: "Classify" }),
      kind: "ai",
      palette: true,
    },
    {
      ref: "custom:age",
      source: "client",
      version: 2,
      definition: skill({
        id: "custom:age",
        name: "Age receivables",
        mode: "tool",
        model: undefined,
        instructions: undefined,
        rules: [{ id: "r1", when: { match: "all", rules: [] }, set: { bucket: "Current" } }],
      }),
      kind: "deterministic",
      palette: true,
    },
    {
      ref: "custom:old",
      source: "client",
      version: 1,
      definition: skill({ id: "custom:old", name: "Old style", mode: "agent", model: undefined }),
      kind: "ai",
      palette: false,
    },
  ],
  tools: [
    {
      id: "testkit.record.update",
      description: "Updates a record",
      input: io,
      output: io,
      sideEffect: "external",
      verb: "update",
      source: "testkit",
      connector: "testkit",
    },
    {
      id: "alerts.raise",
      description: "Raises an alert",
      input: io,
      output: io,
      sideEffect: "internal",
      verb: "create",
      source: "platform",
    },
  ],
  connectors: [{ id: "testkit", name: "Testkit", icon: null }],
  stepTools: ["alerts.raise"],
  automations: [],
};
const data: BuilderData = { catalog: CATALOG, events: [] };
const ctx = typingContext(data);

const bundle = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Clerk", role: "keeps records", mission: "keep records right" },
    kind: "functional",
    model: { id: "claude-opus-5-5", maxTokens: 1024 },
    instructions: "",
    skills: [],
    extraTools: [],
    canCommand: [],
    permissions: { mode: "suggest_only" },
    budgets: { maxSteps: 4, maxCostUsd: "0.10" },
    memory: { enabled: false },
  },
  workflows: [],
} as unknown as ProcessAgentBundle;

function items(): PaletteItem[] {
  return paletteSections(bundle, data).flatMap((s) => s.items);
}

describe("the palette under the skill model", () => {
  it("says each skill's kind and never offers a retired kind for a new step", () => {
    const skills = items().filter((i) => i.type === "skill");
    expect(skills.map((i) => [i.title, i.type === "skill" ? i.kind : null]).sort()).toEqual([
      ["Age receivables", "deterministic"],
      ["Classify", "ai"],
    ]);
    expect(catalogSkillKind(data, "custom:age@2")).toBe("deterministic");
    expect(catalogSkillKind(data, "custom:nothing")).toBeUndefined();
  });

  it("offers the server's step tools, each write by where it writes", () => {
    const writes = items().filter((i) => i.type === "write");
    expect(writes.map((i) => [i.key, i.detail])).toEqual([
      ["write:alerts.raise", "Save to records"],
      ["write:testkit.record.update", "Change in Testkit"],
    ]);
    expect(writeLabelOf(data, "nobody.knows")).toBe("Change in the client's tool");
  });

  it("starts Change in with approval on and Save to records with it off", () => {
    const [save, change] = items().filter((i) => i.type === "write") as PaletteItem[];
    const saved = createStep(save as PaletteItem, ctx, uuidv7);
    expect(saved.checks?.approval).toBeUndefined();
    const changed = createStep(change as PaletteItem, ctx, uuidv7);
    expect(changed.checks?.approval?.required).toBe("required");
  });
});
