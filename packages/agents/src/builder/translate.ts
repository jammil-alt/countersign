// Translation between steps (docs/step-model-plan.md §6): what the rules (core
// `steps.workOutTranslation`) leave without a source, the Builder AI may fill. This is Reshape's
// suggestion (`./reshape`, `suggestReshape`), asked once, in the back office, at the operator's
// cost, never during a client's run; every expression is parsed and typed by core before it is
// used, and what checks is applied without confirming (owner, 2026-11-25: "lets not overvalidate
// things, assumptions are ok and tweaks will come after"). Nothing here touches the database.

import { type processes, steps } from "@countersign/core";
import type { LlmCallRecord, LlmClient, ModelId } from "@countersign/llm";
import { suggestReshape } from "./reshape";

export interface TranslateLeftoversRequest {
  /** The fields the step takes. */
  needs: readonly steps.Field[];
  /** What it can read: the trigger and the steps before it. */
  sources: readonly steps.TranslateSource[];
  /** The rules' result (`steps.workOutTranslation`). */
  worked: steps.WorkedOut;
  /** The step's name, for the prompt. */
  stepName?: string | undefined;
}

export interface TranslateLeftovers {
  /** The incoming side with the AI's fills added. */
  worked: steps.WorkedOut;
  /** Whether the AI was asked (only when something had no source). */
  asked: boolean;
  /** The fields it filled. */
  filled: string[];
  /** What it said that was dropped, and why. */
  dropped: { field: string; reason: string }[];
  calls: LlmCallRecord[];
  costUsd: string | null;
}

/**
 * Asks the Builder AI once about the fields the rules left (required or not, top level only) and
 * adds what checks. With nothing left, nothing is asked.
 */
// DECISION (stream G): the AI is asked about optional fields left empty too, not only Doesn't fit:
// the call costs the same, and an assumption the operator can change beats a field left empty.
export async function translateLeftovers(
  request: TranslateLeftoversRequest,
  options: { llm: LlmClient; model?: ModelId; signal?: AbortSignal },
): Promise<TranslateLeftovers> {
  const { needs, sources, worked } = request;
  const left = steps.unfilled(worked);
  const none: TranslateLeftovers = {
    worked,
    asked: false,
    filled: [],
    dropped: [],
    calls: [],
    costUsd: null,
  };
  if (left.length === 0 || sources.length === 0) return none;
  const base = steps.translateContext(needs, sources, worked.input);
  const context: processes.ReshapeContext = {
    ...base,
    next: base.next ? { ...base.next, name: request.stepName ?? "" } : null,
  };
  const byName = new Map(needs.map((f) => [f.name, f]));
  const mapping: processes.ReshapeMapping = {
    fields: [
      ...(worked.translation?.fields ?? []),
      ...left.flatMap((name) => {
        const f = byName.get(name);
        return f
          ? [
              {
                name,
                schema: steps.fieldSchema(f),
                ...(f.required ? {} : { required: false }),
              },
            ]
          : [];
      }),
    ],
  };
  const s = await suggestReshape({ context, mapping, unmapped: left }, options);
  return {
    worked: steps.withSuggestions(worked, s.fields, needs, sources),
    asked: true,
    filled: Object.keys(s.fields),
    dropped: s.dropped,
    calls: s.calls,
    costUsd: s.costUsd,
  };
}
