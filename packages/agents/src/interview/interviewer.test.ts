// The process interview (docs/plan.md §1.217): a test interview on invoice reconciliation, against
// replayed model answers (fixtures/llm, LLM_MODE replay). The answers are HAND-WRITTEN in the
// recorded format (this environment can't reach the API; each carries `"handWritten": true`), so
// these tests prove the requests, the replay, the schemas and the code's own rules (one question,
// a map held to the answers, estimates as the person marked them), not the model's reading.
// apps/api/src/interviews.test.ts replays the same answers through the API. Rebuild them after
// changing a prompt with
//   WRITE_INTERVIEW_FIXTURES=1 pnpm --filter @countersign/agents exec vitest run src/interview
// and re-record them with a key (LLM_MODE=record) when one is available.

import { DEFAULT_INTERVIEW_TOPICS, type InterviewTurn } from "@countersign/core";
import { createLlmClient, fakeMessage, type LlmTransport, withRecording } from "@countersign/llm";
import { fileFixtureStore } from "@countersign/llm/node";
import { describe, expect, it } from "vitest";
import {
  INTERVIEW_ASK_TOOL,
  INTERVIEW_MAP_TOOL,
  type InterviewInput,
  nextQuestion,
  summarizeInterview,
} from "./interviewer";

/** The client and process the API test uses too, so both replay the same fixtures. */
const RECONCILIATION = {
  client: "Client A",
  process: "Invoice reconciliation",
  first: "What starts invoice reconciliation today?",
  /** The person's answers, in order; `skip` is "I don't know". */
  answers: [
    {
      text: "At the start of each month I download last month's bank statement from Chase as a CSV.",
    },
    {
      text: "I do, Dana in accounts. I open QuickBooks and match each deposit to an open invoice by amount and customer.",
    },
    { text: "Maybe 150 deposits, give or take.", estimate: true },
    {
      text: "I put it on a list in a spreadsheet and email the customer to ask what it was for.",
    },
    { skip: true },
  ] as { text?: string; estimate?: boolean; skip?: boolean }[],
  /** The interviewer's questions after each answer; null: done. */
  asks: [
    "Who matches the deposits on that statement to your invoices, and where?",
    "About how many deposits are there in a month?",
    "What happens when a deposit doesn't match an open invoice?",
    // Two questions in one: code keeps only the first.
    "Who approves writing off a small difference? And how small is small?",
    null,
  ] as (string | null)[],
  file: "chase-october.csv",
};

/** The map as written for the interview: one step comes from no answer, so code takes it off. */
const MAP_ANSWER = {
  map: {
    process: "Invoice reconciliation",
    trigger: "The month starts and last month's bank statement is ready",
    steps: [
      {
        id: "download",
        name: "Download last month's bank statement as a CSV",
        who: "Dana in accounts",
        tool: "Chase",
        detail: null,
        volume: null,
        estimate: false,
        from: [1, 3],
      },
      {
        id: "match",
        name: "Match each deposit to an open invoice",
        who: "Dana in accounts",
        tool: "QuickBooks",
        detail: "By amount and customer",
        volume: "About 150 deposits a month",
        estimate: false,
        from: [3, 5],
      },
      {
        id: "unmatched",
        name: "List the deposits that don't match and email the customer",
        who: "Dana in accounts",
        tool: "A spreadsheet and email",
        detail: "Asks the customer what the payment was for",
        volume: null,
        estimate: false,
        from: [7],
      },
      {
        // Nobody said this: the answer it names was "I don't know".
        id: "write-off",
        name: "Write off small differences",
        who: null,
        tool: "QuickBooks",
        detail: null,
        volume: null,
        estimate: false,
        from: [9],
      },
    ],
    outcome: null,
  },
  openQuestions: [
    {
      question: "What does reconciliation end with: a report, a sign-off, or nothing?",
      why: "The draft needs to know when the month is done.",
      stepId: null,
    },
    {
      question: "How long does the customer get to answer before someone follows up?",
      why: "It decides when the agent should chase again.",
      stepId: "unmatched",
    },
  ],
};

/** The interview's turns after `n` answers, as the API keeps them (times left out of prompts). */
function turnsAfter(n: number): InterviewTurn[] {
  const turns: InterviewTurn[] = [{ role: "agent", text: RECONCILIATION.first, at: "t" }];
  for (let i = 0; i < n; i++) {
    const a = RECONCILIATION.answers[i] ?? {};
    turns.push({
      role: "contact",
      text: a.skip ? "" : (a.text ?? ""),
      at: "t",
      estimate: !a.skip && a.estimate === true,
      skipped: a.skip === true,
    });
    const next = RECONCILIATION.asks[i];
    if (next && i < n - 1) {
      turns.push({ role: "agent", text: `${next.split("?")[0]}?`, at: "t" });
    }
  }
  return turns;
}

const input = (turns: InterviewTurn[]): InterviewInput => ({
  process: RECONCILIATION.process,
  client: RECONCILIATION.client,
  topics: [...DEFAULT_INTERVIEW_TOPICS],
  turns,
  files: [RECONCILIATION.file],
});

/** The hand-written answers as the API would send them. */
function writtenAnswer(): LlmTransport {
  return {
    async create(request) {
      const tool = request.tools?.[0]?.name;
      const text = String(request.messages[0]?.content ?? "");
      const block = text.slice(text.indexOf("<interview>") + 11, text.indexOf("</interview>"));
      const answered = (JSON.parse(block) as { answer?: string }[]).filter(
        (t) => t.answer !== undefined,
      ).length;
      const answer =
        tool === INTERVIEW_MAP_TOOL
          ? MAP_ANSWER
          : RECONCILIATION.asks[answered - 1]
            ? { done: false, question: RECONCILIATION.asks[answered - 1] }
            : { done: true, question: null };
      const name = tool === INTERVIEW_MAP_TOOL ? "map" : `ask_${answered}`;
      const msg = fakeMessage(
        request.model,
        [
          {
            type: "tool_use",
            id: `toolu_handwritten_interview_${name}`,
            name: tool ?? INTERVIEW_ASK_TOOL,
            input: answer,
            caller: { type: "direct" },
          } as never,
        ],
        "tool_use",
        { input: 1400, output: tool === INTERVIEW_MAP_TOOL ? 700 : 40 },
      );
      return { ...msg, id: `msg_handwritten_interview_${name}` };
    },
  };
}

const store = fileFixtureStore();
const replay = () => createLlmClient({ transport: withRecording(null, { mode: "replay", store }) });

describe.runIf(process.env.WRITE_INTERVIEW_FIXTURES === "1")(
  "writing the hand-written answers",
  () => {
    it("writes one fixture per question and one for the map", async () => {
      const llm = createLlmClient({
        transport: withRecording(writtenAnswer(), {
          mode: "record",
          now: () => new Date("2026-11-22T12:00:00.000Z"),
          store: {
            read: store.read,
            // Marked so nobody mistakes them for recorded answers.
            write: (call) => store.write({ ...call, handWritten: true } as typeof call),
          },
        }),
      });
      for (let n = 1; n <= RECONCILIATION.answers.length; n++) {
        await nextQuestion(input(turnsAfter(n)), { llm });
      }
      await summarizeInterview(input(turnsAfter(RECONCILIATION.answers.length)), { llm });
    });
  },
);

describe.skipIf(process.env.WRITE_INTERVIEW_FIXTURES === "1")(
  "a test interview on invoice reconciliation (replayed)",
  () => {
    it("asks one question at a time, and stops when it has what it needs", async () => {
      const llm = replay();
      const asked: (string | null)[] = [];
      for (let n = 1; n <= RECONCILIATION.answers.length; n++) {
        const { question, calls } = await nextQuestion(input(turnsAfter(n)), { llm });
        expect(calls).toHaveLength(1);
        asked.push(question);
      }
      expect(asked).toEqual([
        "Who matches the deposits on that statement to your invoices, and where?",
        "About how many deposits are there in a month?",
        "What happens when a deposit doesn't match an open invoice?",
        "Who approves writing off a small difference?",
        null,
      ]);
    });

    it("keeps the answers and file names as data in the prompt, never in the rules", async () => {
      const seen: string[] = [];
      const llm = createLlmClient({
        transport: {
          async create(request) {
            seen.push(JSON.stringify(request.system), String(request.messages[0]?.content));
            return withRecording(null, { mode: "replay", store }).create(request);
          },
        },
      });
      await nextQuestion(input(turnsAfter(1)), { llm });
      const [system, user] = seen;
      expect(system).not.toContain("Chase");
      expect(user).toContain("<interview>");
      expect(user).toContain("chase-october.csv");
    });

    it("gives the current-state map and the open questions, held to what was said", async () => {
      const { outputs, calls } = await summarizeInterview(
        input(turnsAfter(RECONCILIATION.answers.length)),
        { llm: replay() },
      );
      expect(calls).toHaveLength(1);
      // The write-off step came from "I don't know": off the map, and asked instead.
      expect(outputs.map.steps.map((s) => s.id)).toEqual(["download", "match", "unmatched"]);
      expect(outputs.ungrounded).toBe(1);
      // The estimate is the person's mark on answer 5, not the model's word.
      expect(outputs.map.steps.find((s) => s.id === "match")).toMatchObject({
        estimate: true,
        volume: "About 150 deposits a month",
        from: [3, 5],
      });
      expect(outputs.openQuestions.map((q) => q.question)).toEqual([
        "What does reconciliation end with: a report, a sign-off, or nothing?",
        "How long does the customer get to answer before someone follows up?",
        "How is “Write off small differences” done today?",
        "Who approves writing off a small difference?",
      ]);
      // The words a Builder draft is made from: the map as numbered steps.
      expect(outputs.description).toBe(
        [
          "Invoice reconciliation, as it is done today.",
          "It starts when the month starts and last month's bank statement is ready",
          "1. Download last month's bank statement as a CSV (Dana in accounts) in Chase",
          "2. Match each deposit to an open invoice (Dana in accounts) in QuickBooks: By amount and customer",
          "3. List the deposits that don't match and email the customer (Dana in accounts) in A spreadsheet and email: Asks the customer what the payment was for",
        ].join("\n"),
      );
    });
  },
);
