import { describe, expect, it } from "vitest";
import { type ToolSpec, ToolSpec as ToolSpecSchema } from "../schemas/tool";
import { ctx as baseCtx, tools as baseTools } from "../testing/fixtures";
import {
  ACTION_SPECS,
  ActionInputError,
  actionFits,
  actionStepLabel,
  actionTool,
  actionToolInput,
  resolveActionConnector,
  WRITE_ACTIONS,
} from "./actions";
import { WriteStep } from "./schema";
import { type ProcessValidationContext, stepWrites, validateProcess } from "./validate";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});

function writeTool(id: string, connector: string, extra: Partial<ToolSpec> = {}): ToolSpec {
  return ToolSpecSchema.parse({
    id,
    description: id,
    input: obj({}),
    output: obj({ id: { type: "string" } }),
    sideEffect: "external",
    verb: "create",
    source: connector,
    connector,
    ...extra,
  });
}

const tools: Record<string, ToolSpec> = {
  ...baseTools,
  "qbo.bill.create": writeTool("qbo.bill.create", "qbo"),
  "billcom.bill.create": writeTool("billcom.bill.create", "billcom"),
  "qbo.vendor.create": writeTool("qbo.vendor.create", "qbo"),
  "billcom.vendor.create": writeTool("billcom.vendor.create", "billcom"),
  "email.send": writeTool("email.send", "resend"),
  "gmail.send": writeTool("gmail.send", "gmail"),
  "sms.send": writeTool("sms.send", "twilio"),
};
const ctx: ProcessValidationContext = { ...baseCtx, tools };

const BILL = {
  vendorId: "{{trigger.vendorId}}",
  invoiceNumber: "INV-1",
  date: "2026-11-10",
  dueDate: "2026-12-10",
  currency: "USD",
  total: "{{trigger.total}}",
  lines: [{ description: "Flour", amount: "{{trigger.total}}", account: "7" }],
};

function process(write: Record<string, unknown>, approval?: Record<string, unknown>) {
  return {
    schemaVersion: 4,
    triggers: [{ id: "t1", on: { type: "manual", input: {} } }],
    steps: [
      {
        id: "w1",
        name: "Create bill",
        kind: "write",
        input: BILL,
        ...write,
        ...(approval ? { checks: { approval } } : {}),
      },
    ],
  };
}

function codes(input: unknown, c: ProcessValidationContext = ctx) {
  return validateProcess(input, c).errors.map((e) => `${e.code}@${e.stepId}:${e.field}`);
}

describe("action write steps: schema", () => {
  it("names a tool or an action, never both or neither", () => {
    const base = { id: "w", name: "W", kind: "write", input: {} };
    expect(WriteStep.safeParse({ ...base, tool: "qbo.bill.create" }).success).toBe(true);
    expect(WriteStep.safeParse({ ...base, action: "create_bill" }).success).toBe(true);
    expect(WriteStep.safeParse({ ...base, action: "create_bill", via: "qbo" }).success).toBe(true);
    expect(WriteStep.safeParse({ ...base }).success).toBe(false);
    expect(
      WriteStep.safeParse({ ...base, tool: "qbo.bill.create", action: "create_bill" }).success,
    ).toBe(false);
    expect(WriteStep.safeParse({ ...base, tool: "qbo.bill.create", via: "qbo" }).success).toBe(
      false,
    );
    expect(WriteStep.safeParse({ ...base, action: "pay_bill" }).success).toBe(false);
  });

  it("every action maps to a tool on each of its connectors", () => {
    expect(actionTool("create_bill", "qbo")).toBe("qbo.bill.create");
    expect(actionTool("create_bill", "billcom")).toBe("billcom.bill.create");
    expect(actionTool("create_vendor", "billcom")).toBe("billcom.vendor.create");
    expect(actionTool("send_email", "resend")).toBe("email.send");
    expect(actionTool("send_email", "gmail")).toBe("gmail.send");
    expect(actionTool("send_email", "outlook")).toBe("outlook.send");
    expect(actionTool("send_text", "twilio")).toBe("sms.send");
    expect(actionTool("create_bill", "gmail")).toBeNull();
    for (const a of WRITE_ACTIONS) expect(ACTION_SPECS[a].label).toMatch(/^[A-Z][a-z]+ [a-z]+$/);
    expect(actionStepLabel("create_bill", "qbo")).toBe("Create bill · in QuickBooks");
    expect(actionStepLabel("send_email", "gmail")).toBe("Send email · through Gmail");
    expect(actionStepLabel("send_text", "twilio")).toBe("Send text · from your number");
  });
});

describe("resolveActionConnector", () => {
  it("accounting: the one bound, via among two, an error with none or two", () => {
    expect(resolveActionConnector("create_bill", undefined, { bound: ["qbo", "gmail"] })).toEqual({
      ok: true,
      connector: "qbo",
      tool: "qbo.bill.create",
    });
    expect(resolveActionConnector("create_bill", undefined, { bound: ["billcom"] })).toMatchObject({
      ok: true,
      tool: "billcom.bill.create",
    });
    expect(resolveActionConnector("create_bill", undefined, { bound: ["gmail"] })).toMatchObject({
      ok: false,
      code: "action_no_connection",
    });
    expect(
      resolveActionConnector("create_vendor", undefined, { bound: ["qbo", "billcom"] }),
    ).toMatchObject({ ok: false, code: "action_needs_via" });
    expect(
      resolveActionConnector("create_vendor", "billcom", { bound: ["qbo", "billcom"] }),
    ).toMatchObject({ ok: true, tool: "billcom.vendor.create" });
    expect(resolveActionConnector("create_bill", "billcom", { bound: ["qbo"] })).toMatchObject({
      ok: false,
      code: "action_via_unknown",
    });
    // Two bindings of one connector are one connector.
    expect(
      resolveActionConnector("create_bill", undefined, { bound: ["qbo", "qbo:2"] }),
    ).toMatchObject({ ok: true, connector: "qbo" });
  });

  it("channels: the agent's resolved channel; unknown when not passed", () => {
    expect(resolveActionConnector("send_email", undefined, { bound: [] })).toBeUndefined();
    expect(
      resolveActionConnector("send_email", undefined, {
        bound: [],
        channels: { email: { connector: "gmail" } },
      }),
    ).toEqual({ ok: true, connector: "gmail", tool: "gmail.send", channel: "email" });
    expect(
      resolveActionConnector("send_text", undefined, { bound: [], channels: { sms: null } }),
    ).toMatchObject({ ok: false, code: "action_no_connection" });
    expect(
      resolveActionConnector("send_text", "twilio", { bound: [], channels: { sms: null } }),
    ).toMatchObject({ ok: false, code: "action_via_not_here" });
  });
});

describe("actionToolInput", () => {
  const bill = {
    vendorId: "56",
    invoiceNumber: "INV-1",
    date: "2026-11-10",
    dueDate: "2026-12-10",
    currency: "USD",
    total: "12.5000",
    memo: "Flour",
    lines: [{ description: "Flour", amount: "12.5000", account: "7" }],
  };

  it("maps a bill to QuickBooks' and BILL's inputs, money as decimal strings", () => {
    expect(actionToolInput("create_bill", "qbo.bill.create", bill)).toEqual({
      vendorId: "56",
      docNumber: "INV-1",
      txnDate: "2026-11-10",
      dueDate: "2026-12-10",
      currency: "USD",
      expectedTotal: "12.5000",
      privateNote: "Flour",
      lines: [{ description: "Flour", amount: "12.5000", accountId: "7" }],
    });
    expect(actionToolInput("create_bill", "billcom.bill.create", bill)).toEqual({
      vendorId: "56",
      invoiceNumber: "INV-1",
      invoiceDate: "2026-11-10",
      dueDate: "2026-12-10",
      currency: "USD",
      expectedTotal: "12.5000",
      description: "Flour",
      lines: [{ amount: "12.5000", description: "Flour", chartOfAccountId: "7" }],
    });
  });

  it("refuses what a provider can't take, before anything is sent", () => {
    const { vendorId: _v, ...named } = bill;
    expect(() =>
      actionToolInput("create_bill", "qbo.bill.create", { ...named, vendorName: "Acme" }),
    ).toThrow(/look it up/);
    const { dueDate: _d, ...noDue } = bill;
    expect(() => actionToolInput("create_bill", "billcom.bill.create", noDue)).toThrow(/due date/);
    expect(actionToolInput("create_bill", "qbo.bill.create", noDue)).not.toHaveProperty("dueDate");
    expect(() =>
      actionToolInput("create_bill", "billcom.bill.create", {
        ...bill,
        lines: [{ description: "x", amount: "1", item: "9" }],
      }),
    ).toThrow(/account, not an item/);
    expect(() =>
      actionToolInput("create_bill", "qbo.bill.create", { ...bill, total: 12.5 }),
    ).toThrow(ActionInputError);
    expect(() => actionToolInput("create_bill", "email.send", bill)).toThrow(/doesn't run with/);
    const err = (() => {
      try {
        actionToolInput("send_email", "email.send", {
          to: "a@b.co",
          cc: ["c@d.co"],
          subject: "Hi",
          body: "Hello",
        });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ActionInputError);
    expect((err as ActionInputError).notWritten).toBe(true);
  });

  it("maps email, text and vendor", () => {
    expect(
      actionToolInput("send_email", "gmail.send", { to: "a@b.co", subject: "Hi", body: "Hello" }),
    ).toEqual({ to: "a@b.co", subject: "Hi", text: "Hello" });
    expect(actionToolInput("send_text", "sms.send", { to: "+15035550100", body: "Hi" })).toEqual({
      to: "+15035550100",
      text: "Hi",
    });
    const vendor = {
      name: "Acme",
      email: "ap@acme.co",
      address: { line1: "1 Main", city: "Portland", region: "OR", postalCode: "97201" },
    };
    expect(actionToolInput("create_vendor", "qbo.vendor.create", vendor)).toEqual({
      displayName: "Acme",
      email: "ap@acme.co",
      billingAddress: vendor.address,
    });
    expect(actionToolInput("create_vendor", "billcom.vendor.create", vendor)).toEqual({
      name: "Acme",
      email: "ap@acme.co",
      address: { line1: "1 Main", city: "Portland", state: "OR", zip: "97201" },
    });
  });
});

describe("validateProcess: action write steps", () => {
  it("a template checks the input shape only", () => {
    expect(codes(process({ action: "create_bill" }))).toEqual([]);
    const missing = process({ action: "create_bill" });
    (missing.steps[0] as { input: Record<string, unknown> }).input = { invoiceNumber: "1" };
    expect(codes(missing)).toContain("input_missing@w1:input.date");
    expect(codes(process({ action: "send_text", via: "twilio" }))).toContain(
      "action_via_not_here@w1:via",
    );
    expect(codes(process({ action: "create_bill", via: "xero" }))).toContain(
      "action_via_unknown@w1:via",
    );
  });

  it("at publish: no accounting connection, two without via, via naming one", () => {
    const at = (matrices: Record<string, unknown>) => ({
      ...ctx,
      publish: { matrices: matrices as never },
    });
    expect(codes(process({ action: "create_bill" }), at({ gmail: {} }))).toEqual([
      "action_no_connection@w1:action",
    ]);
    expect(codes(process({ action: "create_bill" }), at({ qbo: {}, billcom: {} }))).toEqual([
      "action_needs_via@w1:via",
    ]);
    expect(
      codes(process({ action: "create_bill", via: "billcom" }), at({ qbo: {}, billcom: {} })),
    ).toEqual([]);
    expect(codes(process({ action: "create_bill" }), at({ qbo: {} }))).toEqual([]);
  });

  it("approval stays on: a loosening is held to the resolved connection and the mode", () => {
    const off = { required: "not_required" };
    // A template may hold it; its client agent is checked at publish.
    expect(codes(process({ action: "create_bill" }, off))).toEqual([]);
    const pub = (matrix: Record<string, unknown>, extra: Partial<ProcessValidationContext> = {}) =>
      codes(process({ action: "create_bill" }, off), {
        ...ctx,
        publish: { matrices: { qbo: matrix as never } },
        ...extra,
      });
    expect(pub({ create: "approval" })).toEqual([
      "approval_required_by_connection@w1:checks.approval.required",
    ]);
    expect(pub({ create: "auto" })).toEqual([]);
    expect(pub({ create: "off" })).toEqual(["verb_off@w1:action"]);
    expect(
      pub(
        { create: "auto" },
        { agent: { skills: [], extraTools: [], permissions: { mode: "suggest_only" } } as never },
      ),
    ).toEqual(["approval_needs_act@w1:checks.approval.required"]);
  });

  it("a message's channel: resolved from the agent's channels, else refused when loosened", () => {
    const email = {
      action: "send_email",
      input: { to: "{{trigger.email}}", subject: "Hi", body: "Hello" },
    };
    const off = { required: "not_required" };
    const publish = { matrices: {} };
    // Channels not passed: approval stays on.
    expect(codes(process(email, off), { ...ctx, publish })).toEqual([
      "approval_required_by_connection@w1:checks.approval.required",
    ]);
    expect(codes(process(email), { ...ctx, publish })).toEqual([]);
    const actions = (matrix: Record<string, unknown> | undefined) => ({
      bound: [],
      channels: { email: { connector: "resend", ...(matrix ? { matrix: matrix as never } : {}) } },
    });
    expect(
      codes(process(email, off), { ...ctx, publish, actions: actions({ create: "auto" }) }),
    ).toEqual([]);
    expect(codes(process(email, off), { ...ctx, publish, actions: actions(undefined) })).toEqual([
      "approval_required_by_connection@w1:checks.approval.required",
    ]);
    expect(
      codes(process(email), { ...ctx, publish, actions: { bound: [], channels: { email: null } } }),
    ).toEqual(["action_no_connection@w1:action"]);
  });

  it("stepWrites is the resolved tool when known, unknown otherwise", () => {
    const step = validateProcess(process({ action: "create_bill" }), ctx).value?.steps[0];
    if (!step) throw new Error("no step");
    expect(stepWrites(step, ctx)).toBeUndefined();
    expect(
      stepWrites(step, { ...ctx, publish: { matrices: { billcom: {} } } })?.map((t) => t.id),
    ).toEqual(["billcom.bill.create"]);
  });
});

describe("actionFits", () => {
  it("offers the write whose input a step's output has, pre-mapped", () => {
    const out = {
      type: "object",
      properties: {
        vendorId: { type: "string" },
        invoiceNumber: { type: "string" },
        date: { type: "string" },
        currency: { type: "string" },
        total: { type: "string" },
        lines: { type: "array" },
        confidence: { type: "number" },
      },
    };
    const fits = actionFits("prep", out);
    expect(fits.map((f) => f.action)).toEqual(["create_bill"]);
    expect(fits[0]?.input).toEqual({
      vendorId: "{{steps.prep.output.vendorId}}",
      invoiceNumber: "{{steps.prep.output.invoiceNumber}}",
      date: "{{steps.prep.output.date}}",
      lines: "{{steps.prep.output.lines}}",
      total: "{{steps.prep.output.total}}",
      currency: "{{steps.prep.output.currency}}",
    });
    // A field of the wrong type doesn't fit.
    expect(
      actionFits("prep", { ...out, properties: { ...out.properties, total: { type: "number" } } }),
    ).toEqual([]);
    // Without a vendor it doesn't fit.
    const { vendorId: _v, ...rest } = out.properties;
    expect(actionFits("prep", { ...out, properties: rest })).toEqual([]);
  });

  it("a skill's hint fits with its renamed fields", () => {
    const out = {
      type: "object",
      "x-action": "send_email",
      "x-action-fields": { body: "message" },
      properties: { to: { type: "string" }, message: { type: "string" } },
    };
    expect(actionFits("draft", out)).toEqual([
      {
        action: "send_email",
        input: { to: "{{steps.draft.output.to}}", body: "{{steps.draft.output.message}}" },
      },
    ]);
  });
});
