import { describe, expect, it } from "vitest";
import { forbiddenPortalFields, secretResponseFields } from "../api/contract";
import { interviewRoutes } from "../api/interviews";
import { genericAreaSection } from "../onboarding/sections";
import {
  DEFAULT_INTERVIEW_TOPICS,
  groundOutputs,
  type InterviewOutputs,
  type InterviewTurn,
  interviewTopics,
  mapDescription,
  oneQuestion,
  type ProcessStep,
} from ".";

const step = (id: string, from: number[], more: Partial<ProcessStep> = {}): ProcessStep => ({
  id,
  name: `Step ${id}`,
  who: null,
  tool: null,
  detail: null,
  volume: null,
  estimate: false,
  from,
  ...more,
});

const turns: InterviewTurn[] = [
  { role: "agent", text: "What starts it?", at: "t" },
  { role: "contact", text: "An email from the bank.", at: "t", estimate: false, skipped: false },
  { role: "agent", text: "How many a month?", at: "t" },
  { role: "contact", text: "About 40.", at: "t", estimate: true, skipped: false },
  { role: "agent", text: "Who signs off?", at: "t" },
  { role: "contact", text: "", at: "t", estimate: false, skipped: true },
];

const outputs = (steps: ProcessStep[]): InterviewOutputs => ({
  map: { process: "Reconciliation", trigger: null, steps, outcome: null },
  openQuestions: [],
  description: "",
  ungrounded: 0,
});

describe("one question at a time", () => {
  it("keeps the first question of two", () => {
    expect(oneQuestion("Who does it? And when?")).toBe("Who does it?");
  });

  it("refuses an empty question and one that asks for a secret", () => {
    expect(oneQuestion("   ")).toBeNull();
    expect(oneQuestion("What is the password for your bank login?")).toBeNull();
  });
});

describe("a map held to what was said", () => {
  it("takes off a step no answer describes, and asks it instead", () => {
    const out = groundOutputs(outputs([step("a", [1]), step("b", [5]), step("c", [0])]), turns);
    expect(out.map.steps.map((s) => s.id)).toEqual(["a"]);
    expect(out.ungrounded).toBe(2);
    expect(out.openQuestions.map((q) => q.question)).toEqual([
      "How is “Step b” done today?",
      "How is “Step c” done today?",
      "Who signs off?",
    ]);
  });

  it("marks a step an estimate from the person's mark, never the model's", () => {
    const out = groundOutputs(
      outputs([step("a", [1], { estimate: true }), step("b", [1, 3])]),
      turns,
    );
    expect(out.map.steps.map((s) => s.estimate)).toEqual([false, true]);
  });

  it("drops a second step with the same id, and points questions about it at the process", () => {
    const base = outputs([step("a", [1]), step("a", [3])]);
    const out = groundOutputs(
      {
        ...base,
        openQuestions: [{ question: "Q?", why: "W.", stepId: "gone" }],
      },
      turns,
    );
    expect(out.map.steps).toHaveLength(1);
    expect(out.openQuestions[0]).toEqual({ question: "Q?", why: "W.", stepId: null });
  });
});

describe("what an interview covers", () => {
  it("asks an area's intake questions, and the generic ones without an area", () => {
    expect(interviewTopics(genericAreaSection("receivables"))).toEqual([
      ...DEFAULT_INTERVIEW_TOPICS,
    ]);
    expect(interviewTopics(null)).toEqual([...DEFAULT_INTERVIEW_TOPICS]);
  });
});

describe("the words to draft from", () => {
  it("numbers the steps in order", () => {
    const map = {
      process: "Reconciliation",
      trigger: "The statement arrives",
      steps: [step("a", [1], { name: "Download it", tool: "Chase" })],
      outcome: null,
    };
    expect(mapDescription(map)).toBe(
      "Reconciliation, as it is done today.\nIt starts when the statement arrives\n1. Download it in Chase",
    );
  });
});

describe("the public page's routes", () => {
  it("return no agent, prompt, cost or secret", () => {
    for (const r of Object.values(interviewRoutes)) {
      if (r.auth !== "public") continue;
      expect(forbiddenPortalFields(r.response)).toEqual([]);
      expect(secretResponseFields(r.response)).toEqual([]);
    }
  });
});
