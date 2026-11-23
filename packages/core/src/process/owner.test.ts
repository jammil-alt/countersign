// R6 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14): the agent's owner is its definition's identity
// plus v0.13's oversight, the one-process rule, and the checkpoints of a v4 process.

import { describe, expect, it } from "vitest";
import {
  NEW_AGENT_OVERSIGHT,
  OVERSIGHT_ACTIONS,
  OVERSIGHT_MAX_PER_STEP,
  OversightDecision,
  OversightSettings,
} from "../oversight/decision";
import { type AnyAgentBundle, AnyAgentBundle as AnyBundleSchema } from "../schemas/agent";
import { bundle, ctx, edit, workflowInput } from "../testing/fixtures";
import { workflowCheckpoints } from "../workflow/validate";
import { fromWorkflowV3 } from "./convert";
import {
  OWNER_MAY,
  OWNER_NEVER,
  oneProcessProblems,
  ownerMay,
  ownerOfBundle,
  processCheckpoints,
} from "./owner";
import { Process } from "./schema";
import { SPLIT_MAX_STEPS } from "./validate";

/** Reads every skill as a skill (no wrapped tools): the converted process keeps v3's shape. */
const keepSkills = { wrappedTool: () => null, sideEffect: () => null };

function processBundle(over: (b: AnyAgentBundle) => void = () => {}): AnyAgentBundle {
  const b = AnyBundleSchema.parse(bundle());
  const first = b.workflows[0];
  if (first?.workflow.schemaVersion !== 3) throw new Error("fixture");
  first.workflow = Process.parse(fromWorkflowV3(first.workflow, keepSkills));
  over(b);
  return b;
}

describe("the owner of an agent", () => {
  it("is the definition's identity, instructions, model and mode, with the oversight as saved", () => {
    const b = edit(bundle(), (d) => {
      d.definition.oversight = OversightSettings.parse({
        review: "checkpoints",
        model: { id: "claude-haiku-4-5" },
        maxPerRun: 5,
      });
    });
    const owner = ownerOfBundle(b);
    expect(owner).toMatchObject({
      identity: { name: "Clerk", role: "Clerk", mission: "File invoices" },
      instructions: "Work carefully.",
      model: { id: "claude-haiku-4-5", maxTokens: 4096 },
      mode: "suggest_only",
      review: "checkpoints",
      source: "set",
      maxPerStep: OVERSIGHT_MAX_PER_STEP,
      maxPerRun: 5,
      maxCostUsd: "0.25",
      watch: false,
    });
    // The executor gets exactly what is saved.
    expect(owner.settings).toBe(b.definition.oversight);
  });

  it("keeps a stored v3 agent without oversight exactly as it ran: off, nothing for the executor", () => {
    const owner = ownerOfBundle(bundle());
    expect(owner).toMatchObject({ review: "off", source: "stored_off", watch: false });
    expect(owner.settings).toBeUndefined();
    expect(owner.model).toEqual({ id: "claude-sonnet-4-5", maxTokens: 4096 });
  });

  it("gives an agent that holds a v4 process the new default: failures reviewed, and the watch", () => {
    const owner = ownerOfBundle(processBundle());
    expect(owner).toMatchObject({ review: "failures", source: "new_default", watch: true });
    expect(owner.settings).toEqual(OversightSettings.parse(NEW_AGENT_OVERSIGHT));
  });

  it("respects a v4 agent whose operator turned its owner off", () => {
    const owner = ownerOfBundle(
      processBundle((b) => {
        b.definition.oversight = OversightSettings.parse({ review: "off" });
      }),
    );
    expect(owner).toMatchObject({ review: "off", source: "set", watch: false });
  });

  it("may do only what oversight decides, and has no decision that changes the plan", () => {
    expect(Object.values(OWNER_MAY).sort()).toEqual([...OVERSIGHT_ACTIONS].sort());
    expect(ownerMay("retry_with")).toBe(true);
    for (const never of [...OWNER_NEVER, "skip", "add_step", "approve"]) {
      expect(ownerMay(never)).toBe(false);
    }
    // The decision schema is strict: no field can carry a change to steps, approvals or grants.
    for (const field of ["steps", "approval", "permissions", "mode", "matrix"]) {
      expect(
        OversightDecision.safeParse({ action: "continue", note: "fine", [field]: {} }).success,
      ).toBe(false);
    }
  });
});

describe("the checkpoints of a v4 process", () => {
  it("match v3's for a v3 workflow read as v4", () => {
    const w = workflowInput();
    const p = Process.parse(fromWorkflowV3(w, keepSkills));
    expect(processCheckpoints(p, ctx)).toEqual(workflowCheckpoints(w, ctx));
    expect(processCheckpoints(p, ctx)).toEqual(["s1"]);
  });

  it("are the watched steps feeding a write or a conversation, and every review: always", () => {
    const p = Process.parse({
      schemaVersion: 4,
      triggers: [{ id: "t", on: { type: "event", event: "document.received" } }],
      steps: [
        { id: "find", kind: "read", name: "Find", tool: "qbo.bill.query" },
        {
          id: "x",
          kind: "skill",
          name: "Extract",
          skill: "docs.extract",
          input: { documentId: "{{trigger.documentId}}" },
        },
        {
          id: "w",
          kind: "write",
          name: "Itemize",
          tool: "qbo.bill.update_lines",
          input: { billId: "{{steps.find.output.bills.0}}", lines: "{{steps.x.output.lines}}" },
        },
        {
          id: "c",
          kind: "conversation",
          name: "Ask",
          with: "{{steps.w.output.billId}}",
          channel: "email",
          goal: "Confirm",
          deadline: { after: "1 day" },
        },
        { id: "q", kind: "read", name: "Again", tool: "qbo.bill.query", review: "always" },
        // A read's input never makes a checkpoint: nothing is written from it.
        {
          id: "r2",
          kind: "read",
          name: "Look",
          tool: "qbo.bill.query",
          input: { vendor: "{{steps.q.output.bills}}" },
        },
      ],
    });
    expect(processCheckpoints(p, ctx).sort()).toEqual(["find", "q", "w", "x"]);
  });

  it("list a pinned sub-process's own checkpoints under its step", () => {
    const inner = Process.parse({
      schemaVersion: 4,
      triggers: [{ id: "it", on: { type: "event", event: "document.received" } }],
      steps: [
        { id: "a", kind: "skill", name: "Extract", skill: "docs.extract" },
        {
          id: "b",
          kind: "write",
          name: "Attach",
          tool: "qbo.attachable.upload",
          input: { documentId: "{{steps.a.output.documentId}}" },
        },
      ],
    });
    const p = Process.parse({
      schemaVersion: 4,
      triggers: [{ id: "t", on: { type: "event", event: "document.received" } }],
      steps: [
        { id: "x", kind: "skill", name: "Extract", skill: "docs.extract" },
        {
          id: "use",
          kind: "process",
          name: "File it",
          process: "file-it@2",
          input: { id: "{{steps.x.output.documentId}}" },
        },
      ],
    });
    expect(processCheckpoints(p, { ...ctx, processes: { "file-it@2": inner } })).toEqual([
      "x",
      "use/a",
    ]);
    // Without the pinned process the step is unknown: no checkpoint (never less safe than none).
    expect(processCheckpoints(p, ctx)).toEqual([]);
  });
});

describe("one agent, one main workflow, more ways in", () => {
  it("has nothing to say about one enabled workflow of a fair size", () => {
    expect(oneProcessProblems(bundle())).toEqual({ errors: [], advisories: [] });
    expect(oneProcessProblems(processBundle())).toEqual({ errors: [], advisories: [] });
  });

  it("reports each enabled workflow past the first that doesn't hand off; disabled ones don't count", () => {
    const b = edit(bundle(), (d) => {
      const w = d.workflows[0];
      if (!w) throw new Error("fixture");
      d.workflows.push({ ...w, slug: "second" }, { ...w, slug: "third", enabled: false });
      d.workflows.push({ ...w, slug: "fourth" });
    });
    const { errors } = oneProcessProblems(b);
    expect(errors.map((e) => [e.field, e.code])).toEqual([
      ["workflows.1", "one_process"],
      ["workflows.3", "one_process"],
    ]);
    // The message says what to do: a trigger on the main workflow, or a hand-off into it.
    expect(errors[0]?.message).toContain(
      '"second" is a second way in beside the main workflow "intake"',
    );
    expect(errors[0]?.message).toContain('another trigger on "intake"');
    expect(errors[0]?.message).toContain('hand-off to "@self" into "intake", one per item');
    const off = edit(b, (d) => {
      for (const w of d.workflows.slice(1)) w.enabled = false;
    });
    expect(oneProcessProblems(off).errors).toEqual([]);
  });

  // Ways in, ways out (owner, 2026-11-23): the nightly scan is a second way in with its own
  // lead-in, ending with a fork out per unread invoice into the main workflow.
  describe("a second way in", () => {
    const handoff = (id: string, workflow: string, agent = "@self") => ({
      id,
      name: "Check it",
      kind: "handoff",
      to: { agent, workflow, step: "s1" },
      input: { invoice: "{{item}}" },
    });
    const scan = (steps: unknown[]) =>
      processBundle((b) => {
        const main = b.workflows[0];
        if (main?.workflow.schemaVersion !== 4) throw new Error("fixture");
        b.workflows.push({
          ...main,
          slug: "nightly-scan",
          workflow: { ...main.workflow, steps: steps as never },
        });
      });
    const read = {
      id: "find",
      name: "Find bills",
      kind: "read",
      tool: "qbo.bills.list",
      input: {},
    };
    const loop = (body: unknown[]) => ({
      id: "each",
      name: "Each bill",
      kind: "for_each",
      over: "{{steps.find.output.bills}}",
      concurrency: 10,
      steps: body,
    });

    it("is fine when every run ends by handing off into the main workflow, one per item", () => {
      const b = scan([
        read,
        loop([
          {
            id: "unread",
            name: "Not read yet?",
            kind: "if",
            paths: [
              {
                id: "p1",
                name: "Unread",
                when: { match: "all", rules: [] },
                steps: [handoff("h", "intake")],
              },
            ],
            otherwise: { id: "o1", name: "Otherwise", steps: [] },
          },
        ]),
      ]);
      expect(oneProcessProblems(b).errors).toEqual([]);
    });

    it("lets a path stop by choice", () => {
      const b = scan([
        read,
        {
          id: "any",
          name: "Any bills?",
          kind: "if",
          paths: [
            {
              id: "none",
              name: "None",
              when: { match: "all", rules: [] },
              steps: [{ id: "x", name: "Nothing to do", kind: "stop", status: "succeeded" }],
            },
          ],
          otherwise: { id: "o2", name: "Otherwise", steps: [] },
        },
        loop([handoff("h", "intake")]),
      ]);
      expect(oneProcessProblems(b).errors).toEqual([]);
    });

    it("is refused when a run can end anywhere else, naming the step", () => {
      const b = scan([
        read,
        loop([handoff("h", "intake")]),
        {
          id: "tell",
          name: "Tell the team",
          kind: "notify",
          notify: { to: ["client_admin"], channel: "inbox", message: "Done" },
        },
      ]);
      const { errors } = oneProcessProblems(b);
      expect(errors.map((e) => [e.field, e.code])).toEqual([["workflows.1", "one_process"]]);
      expect(errors[0]?.message).toContain('(a run can end on "Tell the team")');
    });

    it('counts only a hand-off to "@self" into another enabled workflow', () => {
      for (const h of [
        handoff("h", "nightly-scan"),
        handoff("h", "intake", "another-agent"),
        handoff("h", "gone"),
      ]) {
        expect(oneProcessProblems(scan([read, loop([h])])).errors).toHaveLength(1);
      }
      const into = scan([read, loop([handoff("h", "intake")])]);
      const off = edit(into, (d) => {
        const main = d.workflows[0];
        if (main) main.enabled = false;
      });
      // With the main workflow off, the scan is the first enabled one: the main workflow itself.
      expect(oneProcessProblems(off).errors).toEqual([]);
    });
  });

  it("passes on validateProcess's split advice for each enabled workflow, v3 read as v4", () => {
    const long = edit(bundle(), (d) => {
      const w = d.workflows[0];
      if (!w) throw new Error("fixture");
      for (let i = 0; i < SPLIT_MAX_STEPS; i++) {
        w.workflow.steps.push({ id: `wait${i}`, name: "Wait", kind: "wait", for: "1 minute" });
      }
    });
    const { errors, advisories } = oneProcessProblems(long);
    expect(errors).toEqual([]);
    expect(advisories).toEqual([
      expect.objectContaining({ workflow: "intake", code: "split_long", stepId: null }),
      // The other advice comes with it: a run that ends on a wait reports nothing out.
      expect.objectContaining({
        workflow: "intake",
        code: "no_output",
        stepId: `wait${SPLIT_MAX_STEPS - 1}`,
      }),
    ]);
  });
});
