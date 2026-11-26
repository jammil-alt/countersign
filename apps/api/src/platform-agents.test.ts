// Step model, stream C (docs/step-model-plan.md §2, §9, §12 R0): the platform's own agents as the
// seed holds them after the purge, one v1 each, their workflows in the step model. Checked against
// the registries a deployment builds: they pass the publish checks (with each action's side effect
// and required input), name only registered skills and actions (no skill that only wraps a tool,
// R1) and keep approval on every change to a client's tool (invariant 8).

import {
  type AgentBundle,
  isToolWrapper,
  parseSkillRef,
  processes,
  steps,
} from "@countersign/core";
import { loadSeedTemplates, loadSeedVersions } from "@countersign/db/seed";
import { knownModelIds } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import { createPlatform, deploymentConnectors } from "./platform";

const platform = createPlatform({ connectors: deploymentConnectors({}, false) });
const specs = platform.tools.specs();
const ctx = {
  skills: Object.fromEntries(platform.catalog.list().map((s) => [s.id, s])),
  tools: specs,
  events: platform.events.byType(),
  models: knownModelIds(),
};

const seeds = await loadSeedTemplates();

const v5 = (b: AgentBundle, slug: string) => {
  const w = b.workflows.find((x) => x.slug === slug)?.workflow;
  if (w?.schemaVersion !== 5) throw new Error(`${slug} isn't in the step model`);
  return steps.Workflow.parse(w);
};

describe("the platform agents' seeds in the step model", () => {
  it("are the five platform agents, one version each", async () => {
    expect(seeds.map((t) => t.slug)).toEqual([
      "bill-clerk",
      "builder",
      "coordinator",
      "document-clerk",
      "supervisor",
    ]);
    expect(await loadSeedVersions()).toEqual([]);
  });

  it.each(seeds)("$slug validates against the platform", (t) => {
    const r = processes.validateBundle(t.bundle, ctx);
    expect(r.errors).toEqual([]);
    expect(t.bundle.definition.kind).toBe("platform");
    // Approval stays on by default (invariant 8).
    expect(t.bundle.definition.permissions.mode).toBe("suggest_only");
  });

  it.each(seeds)("$slug passes the step model's publish checks with the registries", (t) => {
    const context = processes.stepContext({ tools: specs });
    for (const w of t.bundle.workflows) {
      expect(steps.validateWorkflow(v5(t.bundle, w.slug), context), w.slug).toEqual([]);
    }
  });

  it.each(seeds)("$slug names only registered skills and actions, none a tool wrapper", (t) => {
    for (const s of t.bundle.definition.skills) {
      const def = platform.catalog.get(parseSkillRef(s.skill).id);
      expect(def, s.skill).toBeDefined();
      expect(def && isToolWrapper(def), s.skill).toBe(false);
    }
    for (const tool of t.bundle.definition.extraTools) expect(specs[tool], tool).toBeDefined();
    for (const w of t.bundle.workflows) {
      const workflow = v5(t.bundle, w.slug);
      for (const id of steps.stepModelSkills(workflow)) {
        const def = platform.catalog.get(parseSkillRef(id).id);
        expect(def && !isToolWrapper(def), id).toBe(true);
        // A skill a step uses is the agent's own, with its values (§13a).
        expect(
          t.bundle.definition.skills.map((s) => s.skill),
          id,
        ).toContain(id);
      }
      for (const action of steps.stepModelActions(workflow)) {
        const known = specs[action] ?? steps.mergedAction(action);
        expect(known, action).toBeDefined();
      }
    }
  });

  it.each(seeds)("$slug keeps approval on every change to a client's tool", (t) => {
    for (const w of t.bundle.workflows) {
      steps.eachStep(v5(t.bundle, w.slug).steps, ({ step }) => {
        if (step.kind !== "do" || step.uses?.type !== "action") return;
        const action = step.uses.action;
        const merged = steps.mergedAction(action);
        const effect = specs[action]?.sideEffect ?? (merged ? "external" : undefined);
        if (effect !== "external") return;
        const approval = step.checks?.approval;
        expect(approval?.required, step.id).toBe("required");
        expect(processes.approvalLoosenings(approval, "checks.approval"), step.id).toEqual([]);
      });
    }
  });
});

// What each agent's workflow does, step for step (the PR's account of the rewrite).
describe("the Bill clerk", () => {
  const bill = seeds.find((t) => t.slug === "bill-clerk")?.bundle as AgentBundle;
  const w = v5(bill, "invoice-read");

  it("ends every path: three reports to the admin, or a question left to a person", () => {
    expect(w.outputs.map((o) => [o.id, o.kind, o.report?.to])).toEqual([
      ["out-itemized", "report", ["client_admin"]],
      ["out-already-done", "report", ["client_admin"]],
      ["out-added", "report", ["client_admin"]],
    ]);
    const ends: [string, string[], string | undefined][] = [];
    steps.eachStep(w.steps, ({ step }) => {
      if (step.kind === "end") ends.push([step.id, step.outputs, step.nothingToDo]);
    });
    expect(ends.map(([id, outputs, nothing]) => [id, outputs, Boolean(nothing)])).toEqual([
      ["done", ["out-itemized"], false],
      ["nothing", ["out-already-done"], false],
      ["end-asked-bill", [], true],
      ["end-asked-same-number", [], true],
      ["created", ["out-added"], false],
      ["end-asked-new-bill", [], true],
      ["end-asked-vendor-books", [], true],
      ["end-asked-vendor", [], true],
      ["end-asked-which", [], true],
    ]);
  });

  it("creates a bill with the Accounting action, and checks it with Check bill's action", () => {
    expect(steps.findStep(w.steps, "create")).toMatchObject({
      kind: "do",
      doneBy: "rules",
      uses: { type: "action", action: "accounting.bill.create" },
    });
    expect(steps.findStep(w.steps, "check-bill")).toMatchObject({
      kind: "do",
      doneBy: "rules",
      uses: { type: "action", action: "docs.bill.check" },
    });
    // The model only chooses (lines; a new bill's vendor and accounts); rules do the rest.
    const ai: string[] = [];
    steps.eachStep(w.steps, ({ step }) => {
      if (step.kind === "do" && step.doneBy === "ai") ai.push(step.id);
      expect(step.kind, step.id).not.toBe("loop");
    });
    expect(ai).toEqual(["map", "prepare"]);
  });

  // The owner's call (2026-11-25): the vendor is matched on our records, not searched by name in
  // QuickBooks; its QuickBooks id comes from the record (Get by id), and Prepare bill is given that
  // one vendor instead of a list of candidates.
  it("matches the vendor on the Vendors profile and reads its QuickBooks id by Get by id", () => {
    expect(steps.findStep(w.steps, "vendor")).toMatchObject({
      kind: "do",
      doneBy: "rules",
      uses: {
        type: "match",
        match: { to: "vendors", type: "hybrid", keys: ["name"], belowFloor: "person" },
      },
      input: { name: "{{steps.match.output.invoice.vendorName}}" },
      // A vendor the model isn't sure of is asked of the bill-questions seat, with the shortlist,
      // and the answer is learned (stream P).
      checks: {
        confer: {
          with: [
            {
              person: "seat:bill-questions",
              deadline: { after: "3 days", hours: "clock", ifNoAnswer: "skip" },
            },
          ],
        },
      },
    });
    expect(bill.people).toContainEqual(
      expect.objectContaining({ role: "bill-questions", kind: "answers" }),
    );
    expect(steps.findStep(w.steps, "vendor-record")).toMatchObject({
      uses: { type: "action", action: "records.vendor.get" },
      input: { id: "{{steps.vendor.output.items.0.matched}}" },
    });
    const vendor = [
      {
        id: "{{steps.vendor-record.output.externalRefs.qbo}}",
        name: "{{steps.vendor-record.output.name}}",
      },
    ];
    for (const id of ["prepare", "check-bill"]) {
      expect(steps.findStep(w.steps, id), id).toMatchObject({ input: { vendors: vendor } });
    }
    // Get by id reads only what the agent is granted: our vendors, read only.
    expect(bill.definition.data).toEqual({
      grants: [{ recordType: "vendor", read: true, create: false, update: false }],
      sets: [],
    });
    expect(bill.definition.extraTools).not.toContain("qbo.vendor.query");
    // No vendor we're sure of, or one not in QuickBooks: the bill-questions seat is asked.
    for (const id of ["no-vendor", "vendor-not-in-books"]) {
      expect(steps.findStep(w.steps, id), id).toMatchObject({
        doneBy: "person",
        person: { mode: "ask", who: "seat:bill-questions" },
      });
    }
  });

  it("asks about a bill with the invoice's number that doesn't match, and adds none", () => {
    expect(steps.findStep(w.steps, "same-number")).toMatchObject({
      kind: "fork",
      paths: [
        {
          id: "path-same-number",
          when: {
            rules: [{ field: "{{steps.match.output.sameNumber.0}}", op: "exists" }],
          },
          steps: [
            { id: "same-number-ask", person: { who: "seat:bill-questions" } },
            { id: "end-asked-same-number", kind: "end", outputs: [] },
          ],
        },
      ],
      otherwise: { id: "path-other-number" },
    });
  });
});

describe("the Document clerk", () => {
  const doc = seeds.find((t) => t.slug === "document-clerk")?.bundle as AgentBundle;
  const w = v5(doc, "read-again");

  it("saves the reading as its End's delivery, after a person checks totals that don't add up", () => {
    expect(w.outputs).toMatchObject([
      {
        id: "out-reading",
        kind: "save",
        action: {
          action: "docs.reading.record",
          input: {
            documentId: "{{trigger.documentId}}",
            reading: "{{steps.totals.output.reading}}",
          },
        },
      },
    ]);
    expect(w.steps.map((s) => [s.id, s.kind])).toEqual([
      ["read", "do"],
      ["totals", "do"],
      ["totals-off", "fork"],
      ["save-reading", "end"],
    ]);
    expect(steps.findStep(w.steps, "totals")).toMatchObject({
      doneBy: "rules",
      uses: { type: "action", action: "docs.totals.check" },
    });
    expect(steps.findStep(w.steps, "totals-person")).toMatchObject({
      doneBy: "person",
      person: { mode: "approve", who: "client_admin", onReject: "stop" },
    });
  });
});

describe("Sloan", () => {
  const sloan = seeds.find((t) => t.slug === "supervisor")?.bundle as AgentBundle;

  // DECISION (stream C): Sloan's answer is a Do done by AI with its own skill, not a Loop: a Loop
  // only reads (§8), and Sloan's answer writes the platform's own records for the person asking
  // (the reply, a pause, a draft for the admin; invariant 11).
  it("answers with its own skill, as one Do step, and ends", () => {
    const w = v5(sloan, "chat");
    expect(w.steps.map((s) => [s.id, s.kind])).toEqual([
      ["answer", "do"],
      ["answered", "end"],
    ]);
    expect(w.outputs).toMatchObject([{ id: "out-answered", kind: "nothing" }]);
  });
});
