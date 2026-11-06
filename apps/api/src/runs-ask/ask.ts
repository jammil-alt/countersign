// v0.12 W2-F: a plain-words question about runs, compiled to RunFilter (ARCHITECTURE §11.6;
// docs/plan.md §1.49). One Haiku call through packages/llm's `callTool`: the tool's input is the
// surface's RunFilter (Zod, strict), the question goes in the user message as data, and the
// answer is checked against the names the model was given. The model never writes SQL: the filter
// runs through the runs lists' own query (`runFilterWhere`).

import {
  type AskContext,
  askFilterProblems,
  askFilterSchema,
  askSystemPrompt,
  askUserMessage,
  RUN_FILTER_TOOL,
  RUN_FILTER_TOOL_DESCRIPTION,
  type RunFilter,
  tidyFilter,
} from "@countersign/core";
import { type LlmCallRecord, type LlmClient, LlmToolError, MODELS } from "@countersign/llm";

/** The model questions go to (§1.49: Haiku). */
export const ASK_MODEL = MODELS.haiku;

/** Enough for any filter; a longer answer is cut off and refused. */
export const ASK_MAX_TOKENS = 1024;

export type AskOutcome =
  | { ok: true; filter: RunFilter; record: LlmCallRecord }
  | { ok: false; reason: string; record: LlmCallRecord | null };

/**
 * The question as a RunFilter, or why it isn't one: the model didn't call the tool, its input
 * failed the surface's schema (a field outside the filter, a back-office key in the portal), or
 * it named an id or connector it wasn't given. Transport errors are thrown.
 */
export async function compileQuestion(input: {
  llm: LlmClient;
  question: string;
  context: AskContext;
}): Promise<AskOutcome> {
  const { llm, question, context } = input;
  try {
    const result = await llm.callTool({
      model: ASK_MODEL,
      system: askSystemPrompt(context),
      messages: [{ role: "user", content: askUserMessage(question) }],
      tool: {
        name: RUN_FILTER_TOOL,
        description: RUN_FILTER_TOOL_DESCRIPTION,
        schema: askFilterSchema(context.surface),
      },
      maxTokens: ASK_MAX_TOKENS,
      label: "runs.ask",
    });
    const filter = tidyFilter(result.value);
    const problems = askFilterProblems(filter, context);
    if (problems.length > 0) {
      return { ok: false, reason: problems.join("; "), record: result.record };
    }
    return { ok: true, filter, record: result.record };
  } catch (error) {
    if (error instanceof LlmToolError) {
      return { ok: false, reason: `${error.code}: ${error.message}`, record: error.result.record };
    }
    throw error;
  }
}
