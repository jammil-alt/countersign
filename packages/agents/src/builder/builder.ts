// The Builder's shared parts (ARCHITECTURE §9.6): the one ask-and-repair loop (`ask`) the step
// model's draft, revision and conversation (`./step-model`) and the build page share: one
// structured answer (packages/llm `callTool`, Zod-validated), the caller's guards and validation,
// and one chance to repair what failed. Nothing here touches the database.

import {
  ComplianceRefusal,
  canonicalJson,
  dec,
  promptJson,
  type ValidationError,
} from "@countersign/core";
import {
  BUILDER_EFFORT,
  type CallToolInput,
  DEFAULT_MODELS,
  type LlmCallRecord,
  type LlmClient,
  LlmToolError,
  type ModelId,
} from "@countersign/llm";
import type { z } from "zod";
import { type BuilderContext, catalogBriefForPrompt, catalogForPrompt } from "./context";
import { unseenPartsBlock } from "./shortlist";

// ── Errors ───────────────────────────────────────────────────────────────────────────────────────

/** `refusal`: the model declined to answer (BUILDER_QA AI-7), which a form's retry won't fix. */
export type BuilderErrorCode = "model_unavailable" | "invalid_answer" | "refusal";

/** A model's answer that can't be used, as the Builder reports it: a refusal keeps its own code. */
export function unusableAnswer(error: LlmToolError, what = "the Builder's answer"): BuilderError {
  if (error.code === "refusal") {
    return new BuilderError("refusal", `the model declined to give ${what}`, { code: error.code });
  }
  return new BuilderError("invalid_answer", `${what} could not be used: ${error.message}`, {
    code: error.code,
  });
}

export class BuilderError extends Error {
  override name = "BuilderError";
  constructor(
    readonly code: BuilderErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * A model call that failed, as the Builder reports it: `model_unavailable`, except a HIPAA mode
 * refusal (core's `ComplianceRefusal`, nothing was sent), which passes as it is so the caller can
 * say why.
 */
export function modelUnavailable(error: unknown): Error {
  if (error instanceof ComplianceRefusal) return error;
  return new BuilderError(
    "model_unavailable",
    error instanceof Error ? error.message : String(error),
  );
}

/** The catalog in short (`catalogBriefForPrompt`): what each part does, its fields by name. */
export function catalogBriefBlock(ctx: BuilderContext): string {
  return `<catalog>\n${promptJson(catalogBriefForPrompt(ctx))}\n</catalog>`;
}

/**
 * The longest answer the Builder may write. A drafted agent is one tool call holding the whole
 * bundle, and the model's thinking counts against the same limit: a 17-step workflow ran past
 * 16,000 tokens and was cut off (QA on staging, 2026-11-17). The transport streams, so a high
 * limit costs no HTTP timeout; the models allow 128K.
 */
// DECISION (QA on staging, 2026-11-17): 64,000, half the models' ceiling, with a smaller-draft
// retry (`shorter`) for anything still cut off.
export const BUILDER_ANSWER_TOKENS = 64_000;

export interface BuilderOptions {
  llm: LlmClient;
  /** Default `DEFAULT_MODELS.builder`. */
  model?: ModelId;
  /** Fresh node ids (default uuid v7). */
  newId?: () => string;
  /** Repair rounds after a failed answer (default 1). */
  repairs?: number;
  /**
   * Two rounds (owner, 2026-11-24): a shortlist from the catalog in short, then the draft with the
   * shortlist in full (`./shortlist`). Default off here; the API turns it on.
   */
  shortlist?: boolean;
  signal?: AbortSignal;
}

export interface BuilderResult {
  summary: string;
  gaps: string[];
  notes: string[];
  /** What would still stop a publish (drafts may be saved with errors, §10.2). */
  errors: ValidationError[];
  /** The model calls made, with usage and cost. */
  calls: LlmCallRecord[];
  /** USD, the sum of the calls' cost (null when a call had no price). */
  costUsd: string | null;
}

/** Errors the model can fix. Missing bindings and a connection's settings are the operator's. */
export const OPERATOR_FIXES = new Set([
  "connection_missing",
  "verb_off",
  "approval_required_by_connection",
  // v0.18 (docs/plan.md §1.103): a missing step is the Builder's answer for what it can't build;
  // a repair round must not take it out to make the draft validate.
  "missing_step",
]);

/** v0.12 W3-A: an error by where it is and what it is, to tell an old error from a new one. */
export function errorKey(e: ValidationError): string {
  return [e.workflow ?? "", e.stepId ?? "", e.field, e.code].join("|");
}

function describeErrors(errors: readonly ValidationError[]): string {
  return errors
    .map(
      (e) =>
        `- ${[e.workflow, e.stepId, e.field].filter(Boolean).join(" / ") || "bundle"}: ${e.message} (${(e as { stepCode?: string }).stepCode ?? e.code})`,
    )
    .join("\n");
}

export function totalCost(calls: readonly LlmCallRecord[]): string | null {
  let sum = dec("0");
  for (const c of calls) {
    if (c.costUsd === null) return null;
    sum = sum.plus(c.costUsd);
  }
  return sum.toFixed(6);
}

// DECISION (step model, build item 9): one ask-and-repair loop for both models, generic over the
// bundle it answers; a v5 draft passes its own validation and catalog (`./step-model/draft`).
export async function ask<
  T extends { bundle: B; gaps: string[] },
  B extends { workflows: readonly { workflow: unknown }[] },
>(
  input: {
    schema: z.ZodType<T>;
    toolName: string;
    toolDescription: string;
    label: string;
    ctx: BuilderContext;
    first: string;
    guard: (answer: T) => {
      bundle: B;
      gaps: string[];
      notes: string[];
      /** What the repair round should fix besides validation errors (`GuardResult.fix`). */
      fix?: string[];
    };
    // v0.12 W3-A: a conversation's own system prompt, and how a guarded bundle and the errors are
    // shown back to the model in a repair round (aliases, never the ids it could regenerate).
    present?: (bundle: B) => B;
    presentText?: (text: string) => string;
    /** Errors the draft had before this answer (keys from `errorKey`): not the model's to repair. */
    known?: ReadonlySet<string>;
    /** Asked once when an answer is cut off at the token limit: how to answer smaller. */
    shorter?: string;
    /** Error codes left out of a repair round (default `OPERATOR_FIXES`). */
    operatorFixes?: ReadonlySet<string>;
    /** Errors left out of a repair round besides those codes (a v5 "Not built yet" step). */
    operatorFix?: (e: ValidationError) => boolean;
    /** Two rounds: the parts shown in full; a repair round shows the others it used in full. */
    shown?: ReadonlySet<string> | null;
    /** Validation of a guarded bundle as a publish would (the caller knows the agent and its client). */
    validate: (bundle: B) => Promise<ValidationError[]>;
    /** The conversation's or draft's system prompt. */
    system: string;
    /** The catalog in full, for the parts a repair round shows (default `catalogForPrompt`). */
    full?: (ctx: BuilderContext) => Record<string, unknown>;
  },
  options: BuilderOptions,
): Promise<{
  answer: T;
  bundle: B;
  gaps: string[];
  notes: string[];
  errors: ValidationError[];
  calls: LlmCallRecord[];
}> {
  const calls: LlmCallRecord[] = [];
  const messages: CallToolInput<unknown>["messages"] = [{ role: "user", content: input.first }];
  let repairs = options.repairs ?? 1;
  let shortened = false;
  let reasked = false;
  for (;;) {
    let answer: T;
    try {
      const res = await options.llm.callTool({
        model: options.model ?? DEFAULT_MODELS.builder,
        system: input.system,
        messages,
        tool: { name: input.toolName, description: input.toolDescription, schema: input.schema },
        maxTokens: BUILDER_ANSWER_TOKENS,
        effort: BUILDER_EFFORT,
        label: input.label,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      calls.push(res.record);
      answer = res.value;
    } catch (error) {
      if (error instanceof LlmToolError) {
        calls.push(error.result.record);
        if (error.code === "invalid_input" && repairs > 0) {
          repairs -= 1;
          messages.push(
            { role: "assistant", content: JSON.stringify(error.input ?? null) },
            {
              role: "user",
              content: `That answer did not match the schema:\n${error.message}\n\nAnswer again with the whole corrected answer.`,
            },
          );
          continue;
        }
        // Staging, 2026-11-22 (MEZONAS-API-G; docs/plan.md §1.183): asked "how can we add a
        // second trigger?", the model answered in plain words, without the tool, and the answer
        // was thrown away. The models always think, so the call can't be forced
        // (`ANSWER_TOOL_CHOICE`); asked once more with what it wrote, it answers through the
        // tool. The build page's Builder has done this since MEZONAS-API-6 (../build/turn.ts).
        // DECISION: its own single retry, not one of the schema's repairs, so an answer that
        // then fails the schema still gets its repair.
        if (error.code === "no_tool_call" && !reasked) {
          reasked = true;
          const said = error.result.message.content
            .flatMap((b) => (b.type === "text" ? [b.text] : []))
            .join("\n")
            .trim();
          if (said) messages.push({ role: "assistant", content: said.slice(0, 20_000) });
          messages.push({
            role: "user",
            content: `${said ? "That answer" : "Your last answer"} did not call the \`${input.toolName}\` tool, so it can't be used. Answer again by calling \`${input.toolName}\` exactly once, with the whole answer in it. A question is answered in its words, with no change to the draft.`,
          });
          continue;
        }
        // Cut off: once, ask for a smaller answer (the main path, the rest named in gaps), so a
        // big job still gets a draft to add to step by step instead of nothing.
        if (error.code === "max_tokens" && input.shorter && !shortened) {
          shortened = true;
          const last = messages[messages.length - 1];
          if (last && typeof last.content === "string") {
            messages[messages.length - 1] = {
              ...last,
              content: `${last.content}\n\n${input.shorter}`,
            };
          }
          continue;
        }
        throw unusableAnswer(error);
      }
      throw modelUnavailable(error);
    }
    const guarded = input.guard(answer);
    const errors = await input.validate(guarded.bundle);
    const notRepaired = input.operatorFixes ?? OPERATOR_FIXES;
    const fixable = errors.filter(
      (e) =>
        !notRepaired.has(e.code) &&
        !(input.operatorFix?.(e) ?? false) &&
        !(input.known?.has(errorKey(e)) ?? false),
    );
    const asked = guarded.fix ?? [];
    if ((fixable.length > 0 || asked.length > 0) && repairs > 0) {
      repairs -= 1;
      const problems = [
        fixable.length > 0
          ? `does not validate:\n${
              input.presentText
                ? input.presentText(describeErrors(fixable))
                : describeErrors(fixable)
            }`
          : null,
        asked.length > 0
          ? `${fixable.length > 0 ? "and it " : ""}breaks the Builder's rules:\n${asked
              .map((t) => `- ${input.presentText ? input.presentText(t) : t}`)
              .join("\n")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n\n");
      messages.push(
        {
          role: "assistant",
          content: canonicalJson({
            ...answer,
            bundle: input.present ? input.present(guarded.bundle) : guarded.bundle,
          }),
        },
        {
          role: "user",
          content: `That bundle (after the server's rules were applied, so ids may have changed) ${problems}\n\nAnswer again with the whole corrected answer. Keep the ids it has now.${unseenPartsBlock(guarded.bundle, input.ctx, input.shown, input.full ?? catalogForPrompt)}`,
        },
      );
      continue;
    }
    const { fix: _fix, ...kept } = guarded;
    return { answer, ...kept, errors, calls };
  }
}
