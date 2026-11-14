// Skill model (2026-11-10), Wave B item 9: action write steps in the builder's model and palette.
import { type BuilderCatalog, processes, type ToolSpec } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { type BuilderData, paletteSections } from "./catalog";
import {
  type ApprovalEnv,
  actionItem,
  actionTarget,
  addActionAfter,
  approvalOption,
  createStep,
  type Process,
} from "./model";

const billTool: ToolSpec = {
  id: "qbo.bill.create",
  description: "Creates a bill",
  input: { type: "object" },
  output: { type: "object" },
  sideEffect: "external",
  verb: "create",
  source: "qbo",
  connector: "qbo",
};

const env = (over: Partial<ApprovalEnv> = {}): ApprovalEnv => ({
  ctx: { tools: { [billTool.id]: billTool } },
  agentKind: "client",
  mode: "act",
  matrices: { qbo: { create: "auto" } },
  connectorName: (id) => (id === "qbo" ? "QuickBooks" : id),
  ...over,
});

let n = 0;
const newId = () => `id-${++n}`;

describe("action steps in the builder's model", () => {
  it("a new action is a write step naming its action, approval on", () => {
    const step = createStep(actionItem("create_bill"), {}, newId);
    expect(step).toMatchObject({
      kind: "write",
      name: "Create bill",
      action: "create_bill",
      input: {},
      checks: { approval: { required: "required" } },
    });
    expect(step).not.toHaveProperty("tool");
  });

  it("says which tool it will use for this agent", () => {
    const step = { action: "create_bill" as const };
    expect(actionTarget(step, env())).toEqual({
      tool: "qbo.bill.create",
      text: "Create bill · in QuickBooks",
      problem: false,
    });
    expect(actionTarget(step, env({ matrices: { qbo: {}, billcom: {} } }))).toMatchObject({
      tool: null,
      problem: true,
      text: expect.stringContaining("say which one"),
    });
    expect(
      actionTarget({ ...step, via: "billcom" }, env({ matrices: { qbo: {}, billcom: {} } })),
    ).toMatchObject({ tool: "billcom.bill.create", text: "Create bill · in BILL" });
    expect(actionTarget(step, env({ agentKind: "template", matrices: {} }))).toMatchObject({
      text: "Uses each client's accounting connection: QuickBooks or BILL.",
      problem: false,
    });
    expect(actionTarget({ action: "send_text" }, env())?.text).toBe(
      "Sends from the agent's own number, else the account's, when it runs.",
    );
  });

  it("its approval may be loosened only where its resolved connection allows it", () => {
    const step = createStep(actionItem("create_bill"), {}, newId);
    expect(approvalOption(step, env())).toMatchObject({ canSkip: true, required: true });
    expect(approvalOption(step, env({ matrices: { qbo: { create: "approval" } } }))).toMatchObject({
      canSkip: false,
      reason: "The QuickBooks connection requires approval for creating records.",
    });
    expect(approvalOption(step, env({ agentKind: "template" }))?.canSkip).toBe(false);
    const email = createStep(actionItem("send_email"), {}, newId);
    expect(approvalOption(email, env())).toMatchObject({
      canSkip: false,
      reason: "Which connection it uses is known only when it runs, so it waits for a person.",
    });
  });

  it("adds the offered write right after the skill, its input pre-mapped", () => {
    const process = {
      schemaVersion: 4,
      triggers: [{ id: "t", on: { type: "manual", input: {} } }],
      steps: [
        { id: "prep", kind: "skill", name: "Prepare bill", skill: "ap.prepare-bill", input: {} },
        { id: "after", kind: "stop", name: "Stop", status: "succeeded" },
      ],
    } as unknown as Process;
    const fit = { action: "create_bill" as const, input: { total: "{{steps.prep.output.total}}" } };
    const r = addActionAfter(process, "prep", fit, {}, newId);
    expect(r?.process.steps.map((s) => s.id)).toEqual(["prep", r?.stepId, "after"]);
    expect(r?.process.steps[1]).toMatchObject({
      kind: "write",
      action: "create_bill",
      input: { total: "{{steps.prep.output.total}}" },
      checks: { approval: { required: "required" } },
    });
    expect(addActionAfter(process, "nope", fit, {}, newId)).toBeNull();
  });
});

describe("the palette's Actions group", () => {
  it("lists the four actions after the skills", () => {
    const catalog: BuilderCatalog = {
      skills: [],
      tools: [],
      connectors: [],
      automations: [],
    } as unknown as BuilderCatalog;
    const data: BuilderData = { catalog, events: [] };
    const bundle = {
      schemaVersion: 1,
      definition: { skills: [], extraTools: [] },
      workflows: [],
    } as never;
    const sections = paletteSections(bundle, data);
    const keys = sections.map((s) => s.key);
    expect(keys.indexOf("actions")).toBe(keys.indexOf("skills") + 1);
    const actions = sections.find((s) => s.key === "actions");
    expect(actions?.items.map((i) => [i.key, i.title])).toEqual(
      processes.WRITE_ACTIONS.map((a) => [`action:${a}`, processes.ACTION_SPECS[a].label]),
    );
  });
});
