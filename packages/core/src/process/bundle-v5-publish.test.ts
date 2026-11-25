// The step model's publish checks (stream A): a client agent's v5 workflow is held to its
// connections at publish as a v4 process is (`process/validate.test.ts`, "at publish"): a write
// needs a bound connection with its verb on and its action switched on, and a loosened approval
// needs the connection to allow `auto` and the agent to act (invariant 8).
import { describe, expect, it } from "vitest";
import type { PermissionMatrix } from "../schemas/permissions";
import type { ToolSpec } from "../schemas/tool";
import { validateAnyBundle } from "./bundle";

const tool = (
  id: string,
  sideEffect: ToolSpec["sideEffect"],
  connector: string,
  extra: Partial<ToolSpec> = {},
): ToolSpec => ({
  id,
  description: id,
  input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  output: { type: "object" },
  sideEffect,
  verb: sideEffect === "none" ? "read" : "create",
  source: connector,
  connector,
  ...extra,
});
const READ = tool("testkit.record.read", "none", "testkit");
const NOTE = tool("testkit.note.create", "external", "testkit");
const SIGNED = tool("testkit.payment.create", "external", "testkit", { approval: "always" });
const SAVE = tool("purchasing.item.save", "internal", "purchasing");
const QBO_BILL = tool("qbo.bill.create", "external", "qbo", { entity: "bill" });
const QBO_BILL_UPDATE = tool("qbo.bill.update", "external", "qbo", {
  verb: "update",
  entity: "bill",
});
const BILL_BILL = tool("billcom.bill.create", "external", "billcom");
const SLACK = tool("slack.message.post", "external", "slack");
const TEAMS = tool("teams.message.post", "external", "teams");
const TOOLS = Object.fromEntries(
  [READ, NOTE, SIGNED, SAVE, QBO_BILL, QBO_BILL_UPDATE, BILL_BILL, SLACK, TEAMS].map((t) => [t.id, t]),
);

const definition = (mode: "act" | "suggest_only" = "act") => ({
  schemaVersion: 2 as const,
  identity: { name: "Clerk", role: "Records", mission: "Keep records right" },
  kind: "functional" as const,
  model: { id: "m" },
  instructions: "Work carefully.",
  skills: [],
  extraTools: [],
  permissions: { mode },
});

const NOT_REQUIRED = { approval: { required: "not_required" } };

/** One Do step using `action`, and one output delivered by the End. */
const workflow = (
  action: string,
  opts: { checks?: unknown; output?: Record<string, unknown> } = {},
) => ({
  schemaVersion: 5,
  triggers: [{ id: "t5", on: { type: "manual", input: {} } }],
  outputs: [
    opts.output ?? {
      id: "o_done",
      name: "Done",
      kind: "report",
      report: { to: ["approver"], message: "Done." },
    },
  ],
  steps: [
    {
      id: "s_do",
      kind: "do",
      name: "Do it",
      doneBy: "rules",
      uses: { type: "action", action },
      input: { id: "{{trigger.id}}" },
      ...(opts.checks ? { checks: opts.checks } : {}),
    },
    { id: "s_end", kind: "end", name: "Done", outputs: [opts.output?.id ?? "o_done"] },
  ],
});

const validate = (
  wf: unknown,
  publish?: {
    matrices: Record<string, Partial<PermissionMatrix> | undefined>;
    actionsOff?: ReadonlySet<string>;
  },
  mode: "act" | "suggest_only" = "act",
  actions?: NonNullable<Parameters<typeof validateAnyBundle>[1]>["actions"],
) =>
  validateAnyBundle(
    {
      schemaVersion: 1,
      definition: definition(mode),
      workflows: [{ slug: "w", name: "W", workflow: wf }],
    },
    { tools: TOOLS, ...(publish ? { publish } : {}), ...(actions ? { actions } : {}) },
  );

const codes = (r: ReturnType<typeof validate>) =>
  r.errors.filter((e) => e.code !== "step_model").map((e) => [e.code, e.stepId, e.field]);

describe("a v5 workflow at publish", () => {
  it("isn't held to connections outside publish (a template or a draft)", () => {
    const r = validate(workflow(NOTE.id, { checks: NOT_REQUIRED }));
    expect(codes(r)).toEqual([]);
  });

  it("is valid when its write's connection is bound and allows it", () => {
    const r = validate(workflow(NOTE.id), { matrices: { testkit: {} } });
    expect(r.errors).toEqual([]);
  });

  it("refuses a Do step's write with no connection bound", () => {
    const r = validate(workflow(NOTE.id), { matrices: {} });
    expect(codes(r)).toEqual([["connection_missing", "s_do", "uses.action"]]);
  });

  it("refuses a write the connection's matrix turns off", () => {
    const r = validate(workflow(NOTE.id), { matrices: { testkit: { create: "off" } } });
    expect(codes(r)).toEqual([["verb_off", "s_do", "uses.action"]]);
    expect(r.errors[0]?.message).toContain('("testkit.note.create")');
  });

  it("reads a binding key's connector (`qbo:2` is qbo)", () => {
    const r = validate(workflow(QBO_BILL.id), { matrices: { "qbo:2": { create: "off" } } });
    expect(codes(r)).toEqual([["verb_off", "s_do", "uses.action"]]);
  });

  it("refuses a write to a record type the connection turns off (bill updates)", () => {
    const r = validate(workflow(QBO_BILL_UPDATE.id), {
      matrices: { qbo: { update: "auto", entities: { bill: { update: "off" } } } },
    });
    expect(codes(r)).toEqual([["entity_off", "s_do", "uses.action"]]);
    expect(r.errors[0]?.message).toContain("bill records");
    // Other record types' updates stay on.
    const vendors = validate(workflow(QBO_BILL_UPDATE.id), {
      matrices: { qbo: { entities: { vendor: { update: "off" } } } },
    });
    expect(vendors.errors).toEqual([]);
  });

  it("holds an approval set to not_required to the connection allowing auto", () => {
    const loose = workflow(NOTE.id, { checks: NOT_REQUIRED });
    expect(codes(validate(loose, { matrices: { testkit: { create: "approval" } } }))).toEqual([
      ["approval_required_by_connection", "s_do", "checks.approval.required"],
    ]);
    expect(validate(loose, { matrices: { testkit: { create: "auto" } } }).errors).toEqual([]);
  });

  it("refuses a loosened write when the agent only suggests", () => {
    const r = validate(
      workflow(NOTE.id, { checks: NOT_REQUIRED }),
      { matrices: { testkit: { create: "auto" } } },
      "suggest_only",
    );
    expect(codes(r)).toEqual([["approval_needs_act", "s_do", "checks.approval.required"]]);
  });

  it("never loosens a tool a person always signs", () => {
    const r = validate(workflow(SIGNED.id, { checks: NOT_REQUIRED }), {
      matrices: { testkit: { create: "auto" } },
    });
    expect(codes(r)).toEqual([["approval_always", "s_do", "checks.approval.required"]]);
  });

  it("refuses an action switched off on its connector", () => {
    const r = validate(workflow(NOTE.id), {
      matrices: { testkit: {} },
      actionsOff: new Set([NOTE.id]),
    });
    expect(codes(r)).toEqual([["action_off", "s_do", "uses.action"]]);
  });

  it("doesn't hold a Get or a Save on an area to a connection", () => {
    const save = workflow(READ.id, {
      output: {
        id: "o_save",
        name: "Saved",
        kind: "save",
        action: { action: SAVE.id, input: { id: "1" } },
      },
    });
    expect(codes(validate(save, { matrices: {} }))).toEqual([]);
  });

  describe("an output that writes", () => {
    const bill = (checks?: unknown) =>
      workflow(READ.id, {
        output: {
          id: "o_bill",
          name: "Bill",
          kind: "write",
          action: { action: "accounting.bill.create", input: { id: "{{steps.s_do.output.id}}" } },
          ...(checks ? { checks } : {}),
        },
      });

    it("resolves a merged accounting action from the agent's binding", () => {
      expect(validate(bill(), { matrices: { qbo: {} } }).errors).toEqual([]);
      expect(codes(validate(bill(), { matrices: { qbo: { create: "off" } } }))).toEqual([
        ["verb_off", "o_bill", "action.action"],
      ]);
    });

    it("refuses one with no accounting connection bound", () => {
      expect(codes(validate(bill(), { matrices: { testkit: {} } }))).toEqual([
        ["connection_missing", "o_bill", "action.action"],
      ]);
    });

    it("passes over a connector with the action off, as the run does", () => {
      const r = validate(bill(), {
        matrices: { qbo: {}, billcom: { create: "off" } },
        actionsOff: new Set([QBO_BILL.id]),
      });
      // QuickBooks' is off, so BILL runs it, and BILL's matrix turns creating off.
      expect(codes(r)).toEqual([["verb_off", "o_bill", "action.action"]]);
      expect(r.errors[0]?.message).toContain("billcom.bill.create");
    });

    it("refuses it when every bound connector has it off", () => {
      const r = validate(bill(), { matrices: { qbo: {} }, actionsOff: new Set([QBO_BILL.id]) });
      expect(codes(r)).toEqual([["action_off", "o_bill", "action.action"]]);
    });

    it("holds its loosened approval to the matrix too", () => {
      const r = validate(bill(NOT_REQUIRED), { matrices: { qbo: { create: "approval" } } });
      expect(codes(r)).toEqual([
        ["approval_required_by_connection", "o_bill", "checks.approval.required"],
      ]);
      expect(
        validate(bill(NOT_REQUIRED), { matrices: { qbo: { create: "auto" } } }).errors,
      ).toEqual([]);
    });
  });

  describe("a merged Send (Team chat)", () => {
    const post = workflow("teamchat.message.post");

    it("runs on the first of its connectors that's bound, with it on", () => {
      const r = validate(post, {
        matrices: { slack: {}, teams: { create: "off" } },
        actionsOff: new Set([SLACK.id]),
      });
      expect(codes(r)).toEqual([["verb_off", "s_do", "uses.action"]]);
      expect(r.errors[0]?.message).toContain("teams.message.post");
    });

    it("needs one of them bound, and on", () => {
      expect(codes(validate(post, { matrices: {} }))).toEqual([
        ["connection_missing", "s_do", "uses.action"],
      ]);
      expect(
        codes(validate(post, { matrices: { slack: {} }, actionsOff: new Set([SLACK.id]) })),
      ).toEqual([["action_off", "s_do", "uses.action"]]);
    });
  });

  it("keeps a loosened email's approval on when its channel is known only at the call", () => {
    const r = validate(workflow("email.send", { checks: NOT_REQUIRED }), { matrices: {} });
    expect(codes(r)).toEqual([
      ["approval_required_by_connection", "s_do", "checks.approval.required"],
    ]);
  });

  it("holds an email to its channel's matrix when the channel is known", () => {
    const r = validate(workflow("email.send", { checks: NOT_REQUIRED }), { matrices: {} }, "act", {
      bound: [],
      channels: { email: { connector: "resend", matrix: { create: "auto" } } },
    });
    expect(codes(r)).toEqual([]);
  });
});
