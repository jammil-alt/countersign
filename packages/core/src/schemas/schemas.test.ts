import { describe, expect, it } from "vitest";
import { bundle, skills, tools } from "../testing/fixtures";
import { AgentDefinition } from "./agent";
import { parseSkillRef } from "./common";
import { ConnectorManifest } from "./connector";
import { SCHEMA_NAMES, toJsonSchema } from "./json-schemas";
import { PackManifest } from "./pack";
import { PermissionMatrix } from "./permissions";
import { resolveSkillSettings, SkillDefinition, skillTools } from "./skill";
import { ToolSpec } from "./tool";
import { ActionStep, clientLabel, isClientVisible, SkillStep, Step } from "./workflow";

describe("defaults", () => {
  it("starts every action with approval required", () => {
    const a = ActionStep.parse({
      id: "a",
      name: "A",
      kind: "action",
      tool: "qbo.bill.update_lines",
    });
    expect(a.approval).toEqual({ required: "required", onReject: "stop" });
    expect(a.input).toEqual({});
    const s = SkillStep.parse({ id: "s", name: "S", kind: "skill", skill: "docs.extract" });
    expect(s.approval).toBeUndefined();
  });

  it("starts agents in suggest_only with default budgets", () => {
    const d = AgentDefinition.parse({
      schemaVersion: 2,
      identity: { name: "N", role: "R", mission: "M" },
      kind: "functional",
      model: { id: "m" },
      instructions: "",
      skills: [{ skill: "docs.extract" }],
    });
    expect(d.permissions).toEqual({ mode: "suggest_only" });
    expect(d.budgets).toEqual({ maxSteps: 12, maxCostUsd: "0.50" });
    expect(d.skills[0]?.settings).toEqual({});
    expect(d.model.maxTokens).toBe(4096);
    expect(d.memory.enabled).toBe(true);
  });

  it("gives connections read auto, create/update approval, delete off", () => {
    expect(PermissionMatrix.parse({})).toEqual({
      read: "auto",
      create: "approval",
      update: "approval",
      delete: "off",
    });
  });
});

describe("refinements", () => {
  it("requires external tools to name their connector, and side-effect-free tools to read", () => {
    const t = { ...tools["qbo.bill.update_lines"] };
    delete t.connector;
    expect(ToolSpec.safeParse(t).success).toBe(false);
    expect(ToolSpec.safeParse({ ...tools["qbo.bill.query"], verb: "update" }).success).toBe(false);
  });

  it("requires a handler for tool-mode skills and none for agent-mode", () => {
    const s = skills["docs.extract"];
    expect(SkillDefinition.safeParse({ ...s, handler: undefined }).success).toBe(false);
    expect(
      SkillDefinition.safeParse({ ...skills["test.summarize"], handler: "docs.extract" }).success,
    ).toBe(false);
    expect(
      SkillDefinition.safeParse({
        ...skills["test.summarize"],
        settings: [{ key: "k", label: "K", type: "enum", default: "a" }],
      }).success,
    ).toBe(false);
  });

  it("checks a connector's tools belong to it", () => {
    const m = {
      id: "qbo",
      name: "QuickBooks",
      description: "",
      icon: "qbo",
      auth: "oauth2",
      entities: ["Bill"],
      tools: [tools["qbo.bill.query"], tools["docs.extract"]],
    };
    const r = ConnectorManifest.safeParse(m);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["tools", 1, "source"]);
  });

  it("checks a pack's tools and events are named for it", () => {
    const p = {
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      description: "",
      events: [{ type: "demo.thing.happened", description: "", payload: {}, sample: {} }],
      tools: [],
      skills: [],
      templates: [{ slug: "demo-agent", bundle: bundle() }],
      screens: [{ route: "/reports/demo", title: "Demo", roles: ["client_admin"] }],
    };
    expect(PackManifest.safeParse(p).success).toBe(true);
    const bad = { ...p, events: [{ ...p.events[0], type: "other.thing" }] };
    expect(PackManifest.safeParse(bad).success).toBe(false);
  });
});

describe("helpers", () => {
  it("parses skill refs", () => {
    expect(parseSkillRef("docs.extract")).toEqual({ id: "docs.extract", version: null });
    expect(parseSkillRef("custom:weekly-summary@3")).toEqual({
      id: "custom:weekly-summary",
      version: 3,
    });
  });

  it("lists a skill's tools and resolves its settings", () => {
    expect(skillTools(skills["docs.extract"] as SkillDefinition)).toEqual(["docs.extract"]);
    expect(
      resolveSkillSettings(skills["test.itemize"] as SkillDefinition, { threshold: 9 }),
    ).toEqual({
      vendors: "",
      threshold: 9,
    });
  });

  it("shows work steps to clients and hides logic by default", () => {
    const wait = Step.parse({ id: "w", name: "Wait", kind: "wait", for: "1 day" });
    const act = Step.parse({
      id: "a",
      name: "Attach",
      kind: "action",
      tool: "qbo.attachable.upload",
    });
    expect(isClientVisible(wait)).toBe(false);
    expect(isClientVisible(act)).toBe(true);
    const hidden = Step.parse({ ...act, client: { visible: false, label: "Filed" } });
    expect(isClientVisible(hidden)).toBe(false);
    expect(clientLabel(hidden)).toBe("Filed");
  });
});

describe("JSON Schema export", () => {
  it.each(SCHEMA_NAMES)("exports %s", (name) => {
    const s = toJsonSchema(name);
    expect(s.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(JSON.stringify(s).length).toBeGreaterThan(50);
  });

  it("treats defaults as optional in the input form", () => {
    const s = toJsonSchema("PermissionMatrix") as { required?: string[] };
    expect(s.required ?? []).toEqual([]);
  });
});
