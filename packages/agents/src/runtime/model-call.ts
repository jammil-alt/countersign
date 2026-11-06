// v0.12 W1-E: one model call as the `modelCalls` port records it (docs/plan.md §1.40), from what
// the model client reports (`onCall`). Used by the agent loop, a reach-out's message and a tool's
// own call (a document read by `docs.extract`).

import { isUuid, type ModelCallAction } from "@countersign/core";
import { type LlmCallRecord, type LlmExchange, providerOf } from "@countersign/llm";
import type { ModelCallPort } from "../log/model-calls";

/** Where a model call happened: the run's step, and the agent version that made it. */
export interface ModelCallPlace {
  runId: string;
  stepRunId: string;
  agentVersionId: string | null;
  /** What the call was for (docs/plan.md §1.62), so tokens can be counted by action. */
  action: ModelCallAction;
}

/**
 * Records one call the model client reported (`onCall`), at its step. A call with no step to
 * belong to is not recorded: `model_call` rows name their run and step.
 */
// DECISION: the one shape every caller records with (the agent loop, a reach-out's message, a
// document read in a step), so tokens count cache reads and writes alike everywhere.
export async function recordModelCall(
  port: ModelCallPort | undefined,
  tenantId: string,
  place: ModelCallPlace,
  record: LlmCallRecord,
  exchange: LlmExchange,
): Promise<void> {
  if (!port || !isUuid(place.runId) || !isUuid(place.stepRunId)) return;
  await port.record(tenantId, {
    ...place,
    provider: providerOf(record.model),
    model: record.model,
    tokensIn:
      record.usage.inputTokens + record.usage.cacheWriteTokens + record.usage.cacheReadTokens,
    tokensOut: record.usage.outputTokens,
    costUsd: record.costUsd,
    durationMs: record.durationMs,
    stopReason: record.stopReason,
    request: exchange.request,
    answer: exchange.response,
    error: record.error,
  });
}
