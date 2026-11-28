// Invariant 11 in the step model: a promotion or a copy to another client never carries one
// client's people. A v5 workflow names them on a Do step's person and Tell, on an approval, and on
// a declared output (a report's `to`); each is put back to the base template's, or reset.

import { type AgentBundle, cloneJson, steps, uuidv7 } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { makeBundle } from "../log/harness.test-helper";
import { stripForPromotion } from "./lineage";

function bundleWith(people: { asker: string; told: string; approver: string; report: string }) {
  const workflow = steps.Workflow.parse({
    schemaVersion: 5,
    triggers: [{ id: "trg", on: { type: "manual", input: { type: "object", properties: {} } } }],
    outputs: [
      {
        id: "out-report",
        name: "Report",
        kind: "report",
        report: { to: [people.report], channel: "inbox", message: "Done." },
      },
    ],
    steps: [
      {
        id: "ask",
        name: "Ask",
        kind: "do",
        doneBy: "person",
        person: {
          mode: "ask",
          who: people.asker,
          question: "Which one?",
          deadline: { after: "1 day", ifNoAnswer: "stop" },
        },
      },
      {
        id: "tell",
        name: "Tell",
        kind: "do",
        doneBy: "rules",
        uses: { type: "tell" },
        tell: { to: [people.told], channel: "inbox", message: "Heads up." },
      },
      {
        id: "write",
        name: "Write",
        kind: "do",
        doneBy: "rules",
        uses: { type: "action", action: "testkit.record.update" },
        checks: {
          approval: {
            required: "required",
            mode: "in_turn",
            ifNoAnswer: "stop",
            approvers: [{ who: people.approver }],
          },
        },
      },
      { id: "end", name: "End", kind: "end", outputs: ["out-report"] },
    ],
  });
  const b = cloneJson(makeBundle()) as AgentBundle;
  return { ...b, workflows: [{ slug: "main", name: "Main", enabled: true, workflow }] };
}

describe("the promotion scrub on a step-model workflow", () => {
  const people = { asker: uuidv7(), told: uuidv7(), approver: uuidv7(), report: uuidv7() };
  const client = bundleWith(people);

  it("carries none of the client's people into a template with no base", () => {
    const out = stripForPromotion(client, null, {});
    const text = JSON.stringify(out);
    for (const id of Object.values(people)) expect(text).not.toContain(id);
    const w = out.workflows[0]?.workflow;
    if (w?.schemaVersion !== 5) throw new Error("not v5");
    // What is required still validates: a person to ask, someone to tell and to report to.
    expect(steps.Workflow.safeParse(w).success).toBe(true);
    expect(steps.validateWorkflow(steps.Workflow.parse(w))).toEqual([]);
  });

  it("puts back the base template's people", () => {
    const base = bundleWith({
      asker: "client_admin",
      told: "client_admin",
      approver: "seat:approver",
      report: "client_admin",
    });
    const out = stripForPromotion(client, base, {});
    expect(JSON.stringify(out.workflows)).toEqual(JSON.stringify(base.workflows));
  });
});
