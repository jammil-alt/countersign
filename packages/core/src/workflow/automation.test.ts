// v0.12 W2-B: automations in core (ARCHITECTURE §10.7; docs/plan.md §1.45, M22).
import { describe, expect, it } from "vitest";
import { mergeBundles } from "../bundle/merge";
import { cloneJson } from "../json";
import { type AgentBundle, AgentBundle as AgentBundleSchema } from "../schemas/agent";
import type { AutomationDefinition } from "../schemas/automation";
import type { Step, UseAutomationStep, Workflow } from "../schemas/workflow";
import { automationOutputSchema } from "../template/typer";
import { ctx as baseCtx, bundle, edit } from "../testing/fixtures";
import { automationRequires, stepsToAutomation } from "./automation";
import { type ValidationContext, validateAutomation, validateBundle } from "./validate";

/** "Polite follow-up": summarize a note, then attach the document (a write, approval on). */
function followUp(): AutomationDefinition {
  return {
    schemaVersion: 1,
    slug: "polite-follow-up",
    name: "Polite follow-up",
    description: "Write a short note and attach the document",
    input: {
      type: "object",
      properties: { customer: { type: "string" }, documentId: { type: "string" } },
      required: ["customer", "documentId"],
    },
    output: {
      summary: "{{steps.d1.output.summary}}",
      attached: "{{steps.a1.output.attachableId}}",
      note: "Sent to {{input.customer}}",
    },
    steps: [
      {
        id: "d1",
        name: "Draft the note",
        kind: "skill",
        skill: "test.summarize",
        input: { text: "Follow up with {{input.customer}}" },
      },
      {
        id: "a1",
        name: "Attach",
        kind: "action",
        tool: "qbo.attachable.upload",
        input: { documentId: "{{input.documentId}}" },
        approval: { required: "required", onReject: "stop" },
      },
    ],
    requires: { skills: [], tools: [], connectors: [] },
  };
}

const ctx: ValidationContext = {
  ...baseCtx,
  automations: { "polite-follow-up@1": followUp() },
};

function useStep(over: Partial<UseAutomationStep> = {}): UseAutomationStep {
  return {
    id: "u1",
    name: "Follow up",
    kind: "use_automation",
    automation: "polite-follow-up@1",
    input: { customer: "{{trigger.vendor}}", documentId: "{{trigger.documentId}}" },
    ...over,
  };
}

function withUse(over: Partial<UseAutomationStep> = {}, after: Step[] = []): AgentBundle {
  const b = bundle();
  const wf: Workflow = {
    schemaVersion: 3,
    trigger: { id: "tu", on: { type: "event", event: "document.received" } },
    steps: [useStep(over), ...after],
  };
  b.workflows = [{ slug: "follow", name: "Follow up", enabled: true, workflow: wf }];
  return AgentBundleSchema.parse(b);
}

const codes = (r: { errors: { code: string; stepId: string | null; field: string }[] }) =>
  r.errors.map((e) => `${e.code}@${e.stepId ?? ""}:${e.field}`);

describe("an automation on its own", () => {
  it("validates as a workflow with input in place of the trigger", () => {
    const r = validateAutomation(followUp(), baseCtx);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("refuses the trigger, nesting, named people, another agent and duplicate ids", () => {
    const bad = followUp();
    bad.steps.push(
      { id: "n1", name: "Note", kind: "notify", channel: "thread", message: "{{trigger.vendor}}" },
      useStep({ id: "u9" }),
      {
        id: "p1",
        name: "Ask",
        kind: "person",
        mode: "ask",
        assignee: "0190a3c4-1111-7000-8000-000000000001",
        title: "Ok?",
        payload: {},
        timeout: "1 day",
        channel: "inbox",
        onReject: "stop",
        onTimeout: "stop",
      },
      { id: "s9", name: "Other", kind: "skill", skill: "test.summarize", agent: "pia", input: {} },
      { id: "d1", name: "Again", kind: "wait", for: "1 hour" },
    );
    expect(codes(validateAutomation(bad, baseCtx))).toEqual(
      expect.arrayContaining([
        "template_scope@n1:message",
        "automation_nested@u9:",
        "automation_named_person@p1:assignee",
        "automation_agent@s9:agent",
        "duplicate_id@d1:id",
      ]),
    );
  });

  // v0.13 W2-H: an inner skill step may name a model, one the platform prices.
  it("checks an inner step's model like any step's", () => {
    const withModel = (id: string) =>
      edit(followUp(), (d) => {
        const step = d.steps.find((x) => x.id === "d1");
        if (step?.kind === "skill") step.model = { id };
      });
    const models = ["claude-haiku-5-5"];
    expect(
      validateAutomation(withModel("claude-haiku-5-5"), { ...baseCtx, models }).errors,
    ).toEqual([]);
    expect(codes(validateAutomation(withModel("claude-nonesuch"), { ...baseCtx, models }))).toEqual(
      ["unknown_model@d1:model.id"],
    );
  });

  it("types its output against its own steps and input", () => {
    const bad = followUp();
    bad.output = { x: "{{steps.d1.output.nope}}", y: "{{steps.zz.output}}" };
    expect(codes(validateAutomation(bad, baseCtx))).toEqual([
      "template_path@:output.x",
      "template_scope@:output.y",
    ]);
    expect(automationOutputSchema(followUp(), baseCtx)).toMatchObject({
      properties: {
        summary: { type: "string" },
        attached: { type: "string" },
        note: { type: "string" },
      },
    });
  });

  it("computes what it requires", () => {
    expect(automationRequires(followUp(), baseCtx)).toEqual({
      skills: ["test.summarize"],
      tools: ["qbo.attachable.upload"],
      connectors: ["qbo"],
    });
  });
});

describe("a use step", () => {
  it("validates its input against the automation's input schema", () => {
    expect(validateBundle(withUse(), ctx).errors).toEqual([]);
    const missing = withUse({ input: { customer: "{{trigger.vendor}}" } });
    expect(codes(validateBundle(missing, ctx))).toEqual(["input_missing@u1:input.documentId"]);
    const typed = withUse({ input: { customer: "{{trigger.total}}", documentId: "d" } });
    expect(codes(validateBundle(typed, ctx))).toEqual(["input_type@u1:input.customer"]);
    expect(codes(validateBundle(withUse(), { ...ctx, automations: {} }))).toEqual([
      "unknown_automation@u1:automation",
    ]);
  });

  it("types its output for later steps, and inner steps are invisible outside", () => {
    const later = (message: string): Step => ({
      id: "n2",
      name: "Tell",
      kind: "notify",
      channel: "thread",
      message,
    });
    expect(validateBundle(withUse({}, [later("{{steps.u1.output.summary}}")]), ctx).errors).toEqual(
      [],
    );
    expect(codes(validateBundle(withUse({}, [later("{{steps.u1.output.nope}}")]), ctx))).toEqual([
      "template_path@n2:message",
    ]);
    expect(codes(validateBundle(withUse({}, [later("{{steps.d1.output.summary}}")]), ctx))).toEqual(
      ["template_scope@n2:message"],
    );
  });

  it("keeps approvals for client agents and inner write steps", () => {
    const loosen = { a1: { required: "not_required" as const, onReject: "stop" as const } };
    const template = withUse({ approvals: loosen });
    expect(codes(validateBundle(template, { ...ctx, clientAgent: false }))).toEqual([
      "approvals_not_client@u1:approvals",
    ]);
    expect(validateBundle(template, { ...ctx, clientAgent: true }).errors).toEqual([]);
    const notWrite = withUse({ approvals: { d1: loosen.a1 } });
    expect(codes(validateBundle(notWrite, { ...ctx, clientAgent: true }))).toEqual([
      "approval_not_write@u1:approvals.d1.required",
    ]);
    const unknown = withUse({ approvals: { zz: loosen.a1 } });
    expect(codes(validateBundle(unknown, { ...ctx, clientAgent: true }))).toEqual([
      "approval_unknown_step@u1:approvals.zz",
    ]);
  });

  it("at publish, needs the automation's connectors bound and the matrix to allow auto", () => {
    const loosen = { a1: { required: "not_required" as const, onReject: "stop" as const } };
    const withRequires: ValidationContext = {
      ...ctx,
      automations: {
        "polite-follow-up@1": { ...followUp(), requires: automationRequires(followUp(), ctx) },
      },
      clientAgent: true,
    };
    expect(
      codes(validateBundle(withUse(), { ...withRequires, publish: { matrices: {} } })),
    ).toEqual(["connection_missing@u1:automation"]);
    const approvalOnly = { qbo: { create: "approval" as const } };
    expect(
      validateBundle(withUse(), { ...withRequires, publish: { matrices: approvalOnly } }).errors,
    ).toEqual([]);
    expect(
      codes(
        validateBundle(withUse({ approvals: loosen }), {
          ...withRequires,
          publish: { matrices: approvalOnly },
        }),
      ),
    ).toEqual(["approval_required_by_connection@u1:approvals.a1.required"]);
    expect(
      codes(
        validateBundle(withUse(), {
          ...withRequires,
          publish: { matrices: { qbo: { create: "off" } } },
        }),
      ),
    ).toEqual(["verb_off@u1:automation"]);
  });
});

describe("merges", () => {
  it("merge a template change and a client change to the same use step field by field", () => {
    const base = withUse();
    const template = edit(base, (b) => {
      const s = b.workflows[0]?.workflow.steps[0] as UseAutomationStep;
      s.automation = "polite-follow-up@2";
    });
    const client = edit(base, (b) => {
      const s = b.workflows[0]?.workflow.steps[0] as UseAutomationStep;
      s.input = { ...s.input, customer: "Dear {{trigger.vendor}}" };
    });
    const r = mergeBundles(base, client, template);
    expect(r.conflicts).toEqual([]);
    const merged = r.bundle.workflows[0]?.workflow.steps[0] as UseAutomationStep;
    expect(merged.automation).toBe("polite-follow-up@2");
    expect(merged.input.customer).toBe("Dear {{trigger.vendor}}");
    expect(merged.id).toBe("u1");
  });

  it("report a conflict only when both sides move the version", () => {
    const base = withUse();
    const to = (v: string) =>
      edit(base, (b) => {
        (b.workflows[0]?.workflow.steps[0] as UseAutomationStep).automation = v;
      });
    const r = mergeBundles(base, to("polite-follow-up@2"), to("polite-follow-up@3"));
    expect(r.conflicts.map((c) => c.path)).toEqual(["step:u1#/automation"]);
  });
});

describe("save as automation", () => {
  let n = 0;
  const newId = () => `n${++n}`;
  const wf = (): Workflow => ({
    schemaVersion: 3,
    trigger: { id: "t1", on: { type: "event", event: "document.received" } },
    steps: [
      {
        id: "s1",
        name: "Extract",
        kind: "skill",
        skill: "docs.extract",
        input: { documentId: "{{trigger.documentId}}" },
      },
      {
        id: "s2",
        name: "Summarize",
        kind: "skill",
        skill: "test.summarize",
        input: { text: "Total {{steps.s1.output.total}} from {{trigger.vendor}}" },
      },
      {
        id: "s3",
        name: "Attach",
        kind: "action",
        tool: "qbo.attachable.upload",
        input: { documentId: "{{steps.s1.output.documentId}}" },
        approval: { required: "not_required", onReject: "stop" },
      },
      {
        id: "s4",
        name: "Tell",
        kind: "notify",
        channel: "thread",
        message: "{{steps.s2.output.summary}} ({{steps.s3.output.attachableId}})",
      },
    ],
  });

  it("copies the steps with new ids, infers input and output, and keeps other ids", () => {
    n = 0;
    const r = stepsToAutomation({
      workflow: wf(),
      stepIds: ["s3", "s2"],
      slug: "note-and-attach",
      name: "Note and attach",
      newId,
      ctx: baseCtx,
      clientAgent: true,
    });
    if (!r.ok) throw new Error(r.message);
    const { automation, useStep, workflow } = r;
    expect(automation.steps.map((s) => s.id)).toEqual(["n1", "n2"]);
    expect(automation.input).toEqual({
      type: "object",
      properties: {
        extract_total: { type: "string" },
        vendor: { type: "string" },
        extract_documentid: { type: "string" },
      },
      required: ["extract_total", "vendor", "extract_documentid"],
    });
    expect(automation.steps[0]).toMatchObject({
      input: { text: "Total {{input.extract_total}} from {{input.vendor}}" },
    });
    // New steps start with approval on; the client agent keeps its loosened one on the use step.
    expect(automation.steps[1]).toMatchObject({ approval: { required: "required" } });
    expect(useStep).toMatchObject({
      id: "n3",
      kind: "use_automation",
      automation: "note-and-attach@1",
      input: {
        extract_total: "{{steps.s1.output.total}}",
        vendor: "{{trigger.vendor}}",
        extract_documentid: "{{steps.s1.output.documentId}}",
      },
      approvals: { n2: { required: "not_required", onReject: "stop" } },
    });
    expect(automation.output).toEqual({
      summarize: "{{steps.n1.output}}",
      attach: "{{steps.n2.output}}",
    });
    expect(workflow.steps.map((s) => s.id)).toEqual(["s1", "n3", "s4"]);
    expect(workflow.steps[2]).toMatchObject({
      message: "{{steps.n3.output.summarize.summary}} ({{steps.n3.output.attach.attachableId}})",
    });

    // Both sides validate: the automation alone, the workflow with the automation in context.
    const saved = { ...automation, requires: automationRequires(automation, baseCtx) };
    expect(validateAutomation(saved, baseCtx).errors).toEqual([]);
    const b = edit(bundle(), (d) => {
      d.workflows = [{ slug: "main", name: "Main", enabled: true, workflow: cloneJson(workflow) }];
    });
    expect(
      validateBundle(b, {
        ...baseCtx,
        automations: { "note-and-attach@1": saved },
        clientAgent: true,
      }).errors,
    ).toEqual([]);
  });

  it("refuses a selection that isn't contiguous, nested, or holds a named person", () => {
    const base = { slug: "x", name: "X", newId, ctx: baseCtx };
    expect(stepsToAutomation({ ...base, workflow: wf(), stepIds: ["s1", "s3"] })).toMatchObject({
      ok: false,
      code: "not_contiguous",
    });
    expect(stepsToAutomation({ ...base, workflow: wf(), stepIds: [] })).toMatchObject({
      ok: false,
      code: "empty",
    });
    const named = edit(wf(), (w) => {
      w.steps.splice(1, 0, {
        id: "p1",
        name: "Ask Dana",
        kind: "person",
        mode: "approve",
        assignee: "0190a3c4-1111-7000-8000-000000000001",
        title: "Ok?",
        payload: {},
        timeout: "1 day",
        channel: "inbox",
        onReject: "stop",
        onTimeout: "stop",
      });
    });
    expect(stepsToAutomation({ ...base, workflow: named, stepIds: ["p1"] })).toMatchObject({
      ok: false,
      code: "named_person",
    });
    expect(
      stepsToAutomation({ ...base, workflow: { ...wf(), steps: [useStep()] }, stepIds: ["u1"] }),
    ).toMatchObject({ ok: false, code: "nested" });
  });
});
