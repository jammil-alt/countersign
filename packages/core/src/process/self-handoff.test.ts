// Ways in, ways out (owner, 2026-11-23): a hand-off step that starts the agent's OWN workflow
// (`to.agent: "@self"`, `to.workflow`). The scan of QuickBooks bills is a second way in that ends
// with a fork out per unread invoice into step 1 of "Check an invoice", instead of a copy of it.
import { describe, expect, it } from "vitest";
import type { SkillDefinition } from "../schemas/skill";
import { handoffWorkflows, isSelfHandoff, selfHandoffLoops, selfHandoffSteps } from "./handoff";
import { Process as ProcessSchema, SELF_AGENT } from "./schema";
import { validateProcess } from "./validate";

const readInvoice: SkillDefinition = {
  schemaVersion: 1,
  id: "custom:read-invoice",
  name: "Read the invoice",
  description: "Read an invoice",
  mode: "agent",
  instructions: "Read it.",
  tools: [],
  input: {
    type: "object",
    properties: { documentId: { type: "string" } },
    required: ["documentId"],
    additionalProperties: false,
  },
  output: { type: "object" },
} as unknown as SkillDefinition;

const typing = { skills: { "custom:read-invoice": readInvoice } };

/** "Check an invoice": a document arrives; read it, then save it. */
const check = {
  schemaVersion: 4,
  triggers: [{ id: "chk-t", on: { type: "manual", input: { type: "object" } } }],
  steps: [
    {
      id: "chk-read",
      name: "Read the invoice",
      kind: "skill",
      skill: "custom:read-invoice",
      input: { documentId: "{{trigger.documentId}}" },
    },
    { id: "chk-stop", name: "Stop", kind: "stop", status: "succeeded" },
  ],
};

/** "Scan QuickBooks bills": for each bill, hand the invoice to "Check an invoice" at step 1. */
function scan(to: Record<string, unknown>, input: Record<string, unknown> = {}) {
  return {
    schemaVersion: 4,
    triggers: [{ id: "scan-t", on: { type: "manual", input: { type: "object" } } }],
    steps: [
      {
        id: "scan-each",
        name: "For each bill",
        kind: "for_each",
        over: "{{trigger.bills}}",
        steps: [
          {
            id: "scan-hand",
            name: "Hand off",
            kind: "handoff",
            to,
            input: { documentId: "{{item.id}}", ...input },
          },
        ],
      },
    ],
  };
}

/** This agent's workflows, as the hand-off check reads them (a version-4 process each). */
function bundle(
  ...workflows: { slug: string; name?: string; enabled?: boolean; workflow: unknown }[]
) {
  return workflows.map((w) => ({ name: w.slug, enabled: true, ...w }));
}

const self = (workflow?: string, step = "chk-read") => ({
  agent: SELF_AGENT,
  step,
  ...(workflow !== undefined ? { workflow } : {}),
});

/** What each workflow's hand-offs are told: the validator of one workflow, given its siblings. */
function problems(b: ReturnType<typeof bundle>) {
  const workflows = handoffWorkflows(
    b.map((w) => ({ ...w, workflow: ProcessSchema.parse(w.workflow) })),
    typing,
  );
  return b.map((w) => ({
    slug: w.slug,
    errors: validateProcess(w.workflow, {
      ...typing,
      ownWorkflows: { workflow: w.slug, workflows },
    }).errors,
  }));
}

const codes = (b: ReturnType<typeof bundle>) =>
  problems(b).flatMap((p) =>
    p.errors.filter((e) => e.code.startsWith("handoff")).map((e) => [p.slug, e.stepId, e.code]),
  );

describe("a hand-off to this agent's own workflow", () => {
  it("parses with @self and a workflow; @self never collides with a slug", () => {
    const ok = ProcessSchema.safeParse(scan(self("check")));
    expect(ok.success).toBe(true);
    const step = ok.success ? selfHandoffSteps(ok.data)[0] : undefined;
    expect(step && isSelfHandoff(step)).toBe(true);
    expect(ProcessSchema.safeParse(scan({ agent: "@other", step: "x" })).success).toBe(false);
  });

  it("is valid into another enabled workflow's top-level work step, in a template", () => {
    const b = bundle(
      { slug: "check", name: "Check an invoice", workflow: check },
      { slug: "scan", name: "Scan QuickBooks bills", workflow: scan(self("check")) },
    );
    expect(codes(b)).toEqual([]);
  });

  it("asks for the workflow, then the step", () => {
    expect(validateProcess(scan(self(undefined))).errors.map((e) => [e.field, e.code])).toEqual([
      ["to.workflow", "handoff_unknown_workflow"],
    ]);
    const b = bundle(
      { slug: "check", workflow: check },
      { slug: "scan", workflow: scan(self("check", "")) },
    );
    expect(codes(b)).toEqual([["scan", "scan-hand", "handoff_unknown_step"]]);
  });

  it("refuses its own workflow, a workflow that isn't there, and one turned off", () => {
    expect(
      codes(
        bundle(
          { slug: "check", workflow: check },
          { slug: "scan", workflow: scan(self("scan", "scan-each")) },
        ),
      ),
    ).toEqual([["scan", "scan-hand", "handoff_same_workflow"]]);
    expect(
      codes(
        bundle({ slug: "check", workflow: check }, { slug: "scan", workflow: scan(self("gone")) }),
      ),
    ).toEqual([["scan", "scan-hand", "handoff_unknown_workflow"]]);
    const off = problems(
      bundle(
        { slug: "check", name: "Check an invoice", enabled: false, workflow: check },
        { slug: "scan", workflow: scan(self("check")) },
      ),
    )
      .flatMap((p) => p.errors)
      .find((e) => e.code === "handoff_workflow_off");
    expect(off?.message).toBe(
      '"Check an invoice" is turned off, so nothing can be handed off to it',
    );
  });

  it("starts only at a top-level read, skill or write step there", () => {
    expect(
      codes(
        bundle(
          { slug: "check", workflow: check },
          { slug: "scan", workflow: scan(self("check", "chk-stop")) },
        ),
      ),
    ).toEqual([["scan", "scan-hand", "handoff_entry_kind"]]);
    // A step inside the scan's loop is not a top-level step of the scan.
    const back = bundle(
      { slug: "scan", workflow: scan(self("check")) },
      {
        slug: "check",
        workflow: {
          ...check,
          steps: [
            ...check.steps.slice(0, 1),
            {
              id: "chk-hand",
              name: "Hand off",
              kind: "handoff",
              to: self("scan", "scan-hand"),
              input: {},
            },
          ],
        },
      },
    );
    expect(codes(back)).toContainEqual(["check", "chk-hand", "handoff_unknown_step"]);
  });

  it("checks the input against the entry step's input schema", () => {
    const b = bundle(
      { slug: "check", workflow: check },
      { slug: "scan", workflow: scan(self("check"), { extra: "x" }) },
    );
    const errors = problems(b)
      .flatMap((p) => p.errors)
      .filter((e) => e.stepId === "scan-hand");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.field.startsWith("input"))).toBe(true);
  });

  it("finds longer loops once, and none in a chain", () => {
    const hop = (to: string) => ({
      schemaVersion: 4,
      triggers: [],
      steps: [{ id: `h-${to}`, name: "Hand off", kind: "handoff", to: self(to, "x"), input: {} }],
    });
    expect(
      selfHandoffLoops([
        { slug: "a", workflow: hop("b") },
        { slug: "b", workflow: hop("c") },
        { slug: "c", workflow: hop("a") },
      ]),
    ).toEqual([["a", "b", "c", "a"]]);
    expect(
      selfHandoffLoops([
        { slug: "a", workflow: hop("b") },
        { slug: "b", workflow: hop("c") },
        { slug: "c", workflow: { schemaVersion: 4, triggers: [], steps: [] } },
      ]),
    ).toEqual([]);
  });

  it("lists a bundle's v4 workflows with their top-level steps", () => {
    const list = handoffWorkflows(
      [
        { slug: "check", name: "Check an invoice", workflow: ProcessSchema.parse(check) },
        {
          slug: "scan",
          name: "Scan",
          enabled: false,
          workflow: ProcessSchema.parse(scan(self("check"))),
        },
      ],
      typing,
    );
    expect(list.map((w) => [w.slug, w.enabled, w.steps.map((s) => s.id)])).toEqual([
      ["check", true, ["chk-read", "chk-stop"]],
      ["scan", false, ["scan-each"]],
    ]);
    expect(list[0]?.steps[0]?.input).toEqual(readInvoice.input);
  });
});
