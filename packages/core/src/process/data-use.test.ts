// v0.18 (docs/plan.md §1.103): what a step reads, saves and changes, from its tools' metadata.

import { describe, expect, it } from "vitest";
import type { SkillDefinition } from "../schemas/skill";
import type { ToolSpec } from "../schemas/tool";
import { keepsNothing, processDataUse, stepDataUse } from "./data-use";
import type { Step } from "./schema";

const spec = (t: Partial<ToolSpec> & Pick<ToolSpec, "id" | "sideEffect" | "source">): ToolSpec =>
  ({
    description: "",
    input: { type: "object" },
    output: { type: "object" },
    verb: t.sideEffect === "none" ? "read" : "create",
    ...t,
  }) as ToolSpec;

const tools: Record<string, ToolSpec> = {
  "materials.vendor.match": spec({
    id: "materials.vendor.match",
    sideEffect: "none",
    source: "materials",
    area: "shared",
    entity: "vendor",
  }),
  "materials.catalog.create_item": spec({
    id: "materials.catalog.create_item",
    sideEffect: "internal",
    source: "materials",
    area: "purchasing",
    entity: "catalog_item",
  }),
  "qbo.bill.query": spec({
    id: "qbo.bill.query",
    sideEffect: "none",
    source: "qbo",
    entity: "bill",
  }),
  "qbo.bill.create": spec({
    id: "qbo.bill.create",
    sideEffect: "external",
    source: "qbo",
    connector: "qbo",
    entity: "bill",
  }),
  "billcom.bill.create": spec({
    id: "billcom.bill.create",
    sideEffect: "external",
    source: "billcom",
    connector: "billcom",
    entity: "bill",
  }),
  "web.search": spec({ id: "web.search", sideEffect: "none", source: "platform" }),
};

const skill = (s: Partial<SkillDefinition>): SkillDefinition =>
  ({
    schemaVersion: 1,
    id: "custom:intake",
    name: "Intake",
    description: "",
    category: "documents",
    mode: "task",
    instructions: "",
    tools: [],
    input: { type: "object" },
    output: { type: "object" },
    settings: [],
    requiresConnectors: [],
    requiresPacks: [],
    producesAlerts: false,
    ...s,
  }) as SkillDefinition;

const ctx = {
  tools,
  skills: {
    "custom:intake": skill({
      tools: ["materials.vendor.match", "materials.catalog.create_item"],
      requiresPacks: ["materials"],
      requiresConnectors: ["gmail"],
    }),
    "custom:think": skill({ id: "custom:think", tools: [] }),
  },
  connectors: new Set(["qbo", "billcom", "gmail"]),
};

const read = (tool: string): Step => ({ id: "r", name: "Read", kind: "read", tool, input: {} });

describe("stepDataUse", () => {
  it("a read from a client's tool reads that tool's records and needs its connection", () => {
    const use = stepDataUse(read("qbo.bill.query"), ctx);
    expect(use.touches).toEqual([
      { verb: "reads", tool: "qbo.bill.query", entity: "bill", connector: "qbo" },
    ]);
    expect(use.connectors).toEqual(["qbo"]);
    expect(keepsNothing(use)).toBe(true);
  });

  it("a write to a client's tool changes it; one to our records saves", () => {
    const write = (tool: string): Step => ({ id: "w", name: "W", kind: "write", tool, input: {} });
    expect(stepDataUse(write("qbo.bill.create"), ctx).touches[0]).toMatchObject({
      verb: "changes",
      entity: "bill",
      connector: "qbo",
    });
    const saves = stepDataUse(write("materials.catalog.create_item"), ctx);
    expect(saves.touches[0]).toMatchObject({
      verb: "saves",
      entity: "catalog_item",
      area: "purchasing",
      pack: "materials",
    });
    expect(saves.packs).toEqual(["materials"]);
    expect(keepsNothing(saves)).toBe(false);
  });

  it("a write action changes whichever tool it resolves to; with via, that one only", () => {
    const action: Step = {
      id: "a",
      name: "Create bill",
      kind: "write",
      action: "create_bill",
      input: {},
    };
    const any = stepDataUse(action, ctx);
    expect(any.touches.map((t) => t.connector)).toEqual(["qbo", "billcom"]);
    expect(any.connectors).toEqual([]);
    const via = stepDataUse({ ...action, via: "billcom" } as Step, ctx);
    expect(via.touches.map((t) => t.connector)).toEqual(["billcom"]);
    expect(via.connectors).toEqual(["billcom"]);
  });

  it("a skill step rolls up its skill's tools and what the skill requires", () => {
    const step: Step = {
      id: "s",
      name: "Intake",
      kind: "skill",
      skill: "custom:intake",
      input: {},
    };
    const use = stepDataUse(step, ctx);
    expect(use.touches.map((t) => [t.verb, t.entity])).toEqual([
      ["reads", "vendor"],
      ["saves", "catalog_item"],
    ]);
    expect(use.packs).toEqual(["materials"]);
    expect(use.connectors).toEqual(["gmail"]);
  });

  it("a skill with no tools keeps nothing; an unknown one is unknown", () => {
    const think: Step = { id: "s", name: "Think", kind: "skill", skill: "custom:think", input: {} };
    expect(keepsNothing(stepDataUse(think, ctx))).toBe(true);
    const unknown = stepDataUse({ ...think, skill: "custom:nope" } as Step, ctx);
    expect(unknown.unknown).toBe("custom:nope");
    expect(keepsNothing(unknown)).toBe(false);
  });

  it("people, notices, logic and missing steps keep no data of their own", () => {
    const steps: Step[] = [
      { id: "w", name: "Wait", kind: "wait", for: "1 day" },
      { id: "m", name: "Missing", kind: "missing", need: "No card feed." },
    ];
    for (const s of steps) expect(stepDataUse(s, ctx).applies).toBe(false);
  });

  it("walks a whole process in run order", () => {
    const out = processDataUse(
      { steps: [read("qbo.bill.query"), read("web.search")] },
      { ...ctx, connectors: new Set(["qbo"]) },
    );
    expect(out.map((o) => o.use.touches[0]?.connector)).toEqual(["qbo", undefined]);
  });
});
