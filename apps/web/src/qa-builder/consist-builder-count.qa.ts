// Consistency QA (Agent Builder): one draft's problem count in the workflow builder vs on its
// build. The build's draft gate (core `gateReasons`, fed `draft.problems.length` by
// apps/api/src/build/store.ts) counts every validator error; the workflow builder counts
// `problemLines`, where one step's references to the same later step are one. Fails while they
// disagree (findings-consist.md, CONS-6).
import { gateReasons, ProcessAgentBundle } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { validateProcessesLikeServer } from "../ops/builder/catalog";
import { problemLines } from "../ops/builder/problems";

/** "Tell" reads three fields of "Ask", which runs after it. */
const bundle = ProcessAgentBundle.parse({
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Vendor check", role: "checks vendors", mission: "Vendors checked." },
    kind: "functional",
    model: { id: "claude-opus-5-5", maxTokens: 1024 },
    instructions: "Only do what the process says.",
    skills: [],
    permissions: { mode: "suggest_only" },
  },
  workflows: [
    {
      slug: "main",
      name: "Main",
      workflow: {
        schemaVersion: 4,
        triggers: [{ id: "t", on: { type: "manual", input: {} } }],
        steps: [
          {
            id: "tell",
            kind: "notify",
            name: "Tell",
            notify: {
              to: ["client_admin"],
              channel: "inbox",
              message:
                "{{steps.ask.output.vendor}} {{steps.ask.output.total}} {{steps.ask.output.number}}",
            },
          },
          {
            id: "ask",
            kind: "person",
            name: "Ask",
            mode: "ask",
            assignee: "client_admin",
            title: "Which vendor?",
            payload: {},
            deadline: { after: "1 day" },
            channel: "inbox",
            onReject: "stop",
          },
        ],
      },
    },
  ],
});

describe("CONS-6: the draft's problem count, builder vs build", () => {
  it("the workflow builder and the build's draft gate count the same problems", () => {
    const r = validateProcessesLikeServer(bundle, { tools: {}, skills: {} }, { clientAgent: true });
    // The build's gate, as buildDetail feeds it (one per validator error).
    const gate = gateReasons({
      kind: "agent",
      phase: "draft",
      brief: {},
      fitgap: { rows: [], needsTrue: [], setup: [], decisions: [] },
      draft: true,
      draftErrors: r.errors.length,
      poc: { passed: false, detail: "" },
      trialDone: false,
      qaSigned: false,
      openItems: 0,
    });
    // The workflow builder's header and Publish line: plural(problemCount, "problem").
    const builder = problemLines(r.errors, bundle).length;
    expect(
      gate,
      `the workflow builder shows ${builder === 1 ? "1 problem" : `${builder} problems`}`,
    ).toEqual([`The draft has ${builder === 1 ? "1 problem" : `${builder} problems`} to fix.`]);
  });
});
