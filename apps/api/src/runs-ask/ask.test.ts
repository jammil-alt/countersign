// v0.12 W2-F: plain words to RunFilter against replayed model answers (fixtures/llm, LLM_MODE
// replay). The answers are HAND-WRITTEN in the recorded format (this environment can't reach the
// API; each carries `"handWritten": true`), so these tests prove the request, the replay, the
// schema and the checks, not the model's reading. Rebuild them after changing the prompt with
//   WRITE_ASK_FIXTURES=1 pnpm --filter @countersign/api exec vitest run src/runs-ask/ask.test.ts
// and re-record them with a key (LLM_MODE=record) when one is available.

import type { AskContext } from "@countersign/core";
import { createLlmClient, fakeMessage, type LlmTransport, withRecording } from "@countersign/llm";
import { fileFixtureStore } from "@countersign/llm/node";
import { describe, expect, it } from "vitest";
import { compileQuestion } from "./ask";

const IRIS = "0193a5b0-0000-7000-8000-000000000001";
const COLE = "0193a5b0-0000-7000-8000-000000000002";
const STRANGER = "0193a5b0-0000-7000-8000-0000000000ff";

/** A fixed client: two services, three tools, a fixed day, so the requests (and hashes) are too. */
const context: AskContext = {
  surface: "portal",
  today: "2026-11-06",
  agents: [
    { id: COLE, name: "Cole", serviceName: "Collections" },
    { id: IRIS, name: "Iris", serviceName: "Invoice intake" },
  ],
  connectors: [
    { id: "gmail", name: "Gmail" },
    { id: "qbo", name: "QuickBooks Online" },
    { id: "upload", name: "Upload" },
  ],
};

/** Each question and the answer written for it. */
const ANSWERS: { question: string; input: unknown }[] = [
  // M26's example: Iris's runs that entered something in QuickBooks over $5,000 (v0.14 W4-B:
  // RunFilter's `amount`).
  {
    question: "bills Iris entered over $5,000",
    input: {
      agents: [IRIS],
      changedConnector: "qbo",
      amount: { over: "5000.00", currency: "USD" },
    },
  },
  // v0.14 W4-B: what the filter can't express is said, not dropped.
  {
    question: "Iris runs about the Hollis job",
    input: { agents: [IRIS], leftOut: ["about the Hollis job"] },
  },
  // A field outside the filter.
  { question: "Iris bills above 5000 dollars", input: { agents: [IRIS], amountOver: "5000" } },
  // A back-office key in the portal.
  {
    question: "failed runs that cost more than a dollar",
    input: { statuses: ["failed"], costOver: "1" },
  },
  // An id it was never given.
  {
    question: "what did Mira do this week",
    input: { agents: [STRANGER], since: "2026-11-02T00:00:00Z" },
  },
];

const answerFor = (question: string) => {
  const a = ANSWERS.find((x) => x.question === question);
  if (!a) throw new Error(`no answer written for ${question}`);
  return a;
};

/** The hand-written answer as the API would send it. */
function writtenAnswer(): LlmTransport {
  return {
    async create(request) {
      const first = request.messages[0];
      const text = typeof first?.content === "string" ? first.content : "";
      const question = text.replace("<question>", "").replace("</question>", "");
      const { input } = answerFor(question);
      const msg = fakeMessage(
        request.model,
        [
          {
            type: "tool_use",
            id: `toolu_handwritten_ask_${ANSWERS.findIndex((a) => a.question === question)}`,
            name: "run_filter",
            input,
            caller: { type: "direct" },
          } as never,
        ],
        "tool_use",
        { input: 900, output: 40 },
      );
      return { ...msg, id: `msg_handwritten_ask_${ANSWERS.indexOf(answerFor(question))}` };
    },
  };
}

const store = fileFixtureStore();
const replay = () => createLlmClient({ transport: withRecording(null, { mode: "replay", store }) });

describe.runIf(process.env.WRITE_ASK_FIXTURES === "1")("writing the hand-written answers", () => {
  it("writes one fixture per question", async () => {
    const llm = createLlmClient({
      transport: withRecording(writtenAnswer(), {
        mode: "record",
        now: () => new Date("2026-11-06T12:00:00.000Z"),
        store: {
          read: store.read,
          // Marked so nobody mistakes them for recorded answers.
          write: (call) => store.write({ ...call, handWritten: true } as typeof call),
        },
      }),
    });
    for (const { question } of ANSWERS) await compileQuestion({ llm, question, context });
  });
});

describe.skipIf(process.env.WRITE_ASK_FIXTURES === "1")(
  "plain words to RunFilter (replayed)",
  () => {
    it('turns "bills Iris entered over $5,000" into the expected filter', async () => {
      const outcome = await compileQuestion({
        llm: replay(),
        question: "bills Iris entered over $5,000",
        context,
      });
      expect(outcome).toMatchObject({
        ok: true,
        filter: {
          agents: [IRIS],
          changedConnector: "qbo",
          amount: { over: "5000.00", currency: "USD" },
        },
        leftOut: [],
      });
      if (!outcome.ok) return;
      expect(Object.keys(outcome.filter).sort()).toEqual(["agents", "amount", "changedConnector"]);
      // The call is priced and its tokens kept, for the client's usage under Sloan.
      expect(outcome.record.model).toBe("claude-haiku-5-5");
      expect(outcome.record.usage.inputTokens).toBe(900);
    });

    it("refuses an answer that isn't a valid RunFilter", async () => {
      const outside = await compileQuestion({
        llm: replay(),
        question: "Iris bills above 5000 dollars",
        context,
      });
      expect(outside.ok).toBe(false);
      if (outside.ok) return;
      expect(outside.reason).toMatch(/^invalid_input/);
      expect(outside.record).not.toBeNull();

      const opsKey = await compileQuestion({
        llm: replay(),
        question: "failed runs that cost more than a dollar",
        context,
      });
      expect(opsKey).toMatchObject({ ok: false });
      if (!opsKey.ok) expect(opsKey.reason).toMatch(/^invalid_input/);
    });

    // v0.14 W4-B
    it("says what the question asked that the filter can't express", async () => {
      const outcome = await compileQuestion({
        llm: replay(),
        question: "Iris runs about the Hollis job",
        context,
      });
      expect(outcome).toMatchObject({
        ok: true,
        filter: { agents: [IRIS] },
        leftOut: ["about the Hollis job"],
      });
      if (outcome.ok) expect(Object.keys(outcome.filter)).toEqual(["agents"]);
    });

    it("refuses an id the model was never given", async () => {
      const outcome = await compileQuestion({
        llm: replay(),
        question: "what did Mira do this week",
        context,
      });
      expect(outcome).toMatchObject({ ok: false, reason: `agents: unknown id ${STRANGER}` });
    });
  },
);
