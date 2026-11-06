// v0.12 W1-E: model calls (ARCHITECTURE §10.10; docs/plan.md §1.40). After each model call of a
// run's step (the agent loop, a reach-out's message, a document read by `docs.extract`), the
// runtime hands this port the request, the answer, usage and timing. The writer
// below records a `model_call` row (provider, model, tokens, cost, duration, stop reason) in the
// client's own transaction, then stores the request and answer, card numbers redacted (§16), in
// object storage under the client's prefix. The back office reads them; the portal never does.

import type { ObjectStore } from "@countersign/connectors";
import { Decimal, redactCardNumbersDeep, uuidv7 } from "@countersign/core";
import { type Db, modelCall, withTenant } from "@countersign/db";

/** One model call of a run's step, as the runtime saw it. */
export interface ModelCallInput {
  runId: string;
  stepRunId: string;
  agentVersionId: string | null;
  /** `anthropic` | `openai`. */
  provider: string;
  model: string;
  /** Input tokens, cache reads and writes included. */
  tokensIn: number;
  tokensOut: number;
  /** USD; null when the model has no price or the call failed before an answer. */
  costUsd: string | null;
  durationMs: number;
  /** The provider's stop reason, or null for a call that failed. */
  stopReason: string | null;
  request: unknown;
  /** The model's answer; null when the call failed. */
  answer: unknown;
  error?: string | undefined;
}

export interface ModelCallPort {
  record(tenantId: string, call: ModelCallInput): Promise<void>;
}

/** `tenants/<client id>/model-calls/<id>.json`: under the client's prefix (invariant 1). */
export function modelCallBodyKey(tenantId: string, id: string): string {
  return `tenants/${tenantId}/model-calls/${id}.json`;
}

/**
 * What is stored of a call: request and answer with card numbers replaced (`[card ending 1234]`)
 * and inline files (a document's base64 bytes) left out, with their size.
 */
// DECISION: a document read by the model is already stored once as the client's document; its
// bytes are not copied into every model call's body.
export function modelCallBody(call: Pick<ModelCallInput, "request" | "answer" | "error">) {
  return redactCardNumbersDeep({
    request: withoutInlineFiles(call.request),
    answer: call.answer ?? null,
    error: call.error ?? null,
  });
}

function withoutInlineFiles(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutInlineFiles);
  if (value === null || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  if (obj.type === "base64" && typeof obj.data === "string") {
    return { ...obj, data: `[${Math.floor((obj.data.length * 3) / 4)} bytes not kept]` };
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, withoutInlineFiles(v)]));
}

/**
 * The writer over the database and object storage. The row commits first, then the body is
 * stored; a body that fails to store is logged and the row stays (the run page says so).
 */
// DECISION: the writer lives in src/log with the run's other log writers (only src/registry and
// src/log import the database); apps/api passes it the R2 bucket. Without one (tests), rows only.
export function dbModelCalls(
  db: Db,
  options: { bodies?: ObjectStore | null; now?: () => Date } = {},
): ModelCallPort {
  return {
    async record(tenantId, call) {
      const id = uuidv7((options.now?.() ?? new Date()).getTime());
      const bodyKey = modelCallBodyKey(tenantId, id);
      await withTenant(db, tenantId, async (tx) => {
        await tx.insert(modelCall).values({
          id,
          tenantId,
          runId: call.runId,
          stepRunId: call.stepRunId,
          agentVersionId: call.agentVersionId,
          provider: call.provider,
          model: call.model,
          tokensIn: call.tokensIn,
          tokensOut: call.tokensOut,
          // numeric(14,4): rounded up to a ten-thousandth, so a call never shows as free.
          costUsd: new Decimal(call.costUsd ?? "0").toDecimalPlaces(4, Decimal.ROUND_UP).toFixed(4),
          durationMs: Math.max(0, Math.round(call.durationMs)),
          stopReason: call.stopReason ?? "error",
          bodyKey,
        });
      });
      if (!options.bodies) return;
      try {
        await options.bodies.put(
          bodyKey,
          new TextEncoder().encode(JSON.stringify(modelCallBody(call))),
          {
            contentType: "application/json",
          },
        );
      } catch (error) {
        console.error(`model call ${id}: the body was not stored`, error);
      }
    },
  };
}
