// A second look at a brief before it is confirmed (owner, 2026-11-17: "getting this right upfront").
// The Builder that wrote the brief with the operator is not the best judge of what it missed, so a
// reviewer, with its own prompt, reads the brief against the build checklist (core's
// `BUILD_CHECKLIST`), the catalog in short and the other work, and names what the brief doesn't
// settle and matters for this work. The API turns each into an open question before the fit-gap.

import { BRIEF_FIELDS, BRIEF_LABELS, type Brief, BUILD_CHECKLIST } from "@countersign/core";
import {
  BUILDER_EFFORT,
  DEFAULT_MODELS,
  type LlmCallRecord,
  type LlmClient,
  LlmToolError,
  type ModelId,
} from "@countersign/llm";
import { z } from "zod";
import { BuilderError, catalogBriefBlock, totalCost } from "../builder/builder";
import type { BuilderContext } from "../builder/context";

export const REVIEW_TOOL = "submit_review";

/**
 * At most this many concerns: the ones that matter most. QA (2026-11-17, fourth run): eight a
 * press, on every press, never let the brief feel finished. The review runs once a build (the
 * API) and names only what a first draft can't do without.
 */
export const REVIEW_MAX = 5;

export const ReviewAnswer = z.object({
  concerns: z
    .array(
      z.object({
        title: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("The question to settle, as you'd ask the operator: one line, plain words"),
        detail: z
          .string()
          .trim()
          .max(600)
          .describe("Why it matters for this work, in one or two sentences"),
        checklist: z
          .string()
          .max(40)
          .optional()
          .describe("The checklist item's id it comes from, if one"),
      }),
    )
    .max(REVIEW_MAX)
    .describe("What the brief doesn't settle and matters; none when it's settled"),
});
export type ReviewAnswer = z.infer<typeof ReviewAnswer>;

export interface ReviewInput {
  title: string;
  kind: "agent" | "skill";
  clientName: string | null;
  brief: Brief;
  /** Other builds and their open issues, one line each. */
  otherWork: readonly string[];
  /** The open issues of this build, one line each: not raised again. */
  issues: readonly string[];
  ctx: BuilderContext | null;
}

const REVIEW_RULES = `You review a brief for Mezonas, a managed-agents service for back-office work, before the operator confirms it and the build moves on to checking it against the catalog. You did not write the brief. Your job is to find what it doesn't settle that would make the agent wrong, stuck or unsafe once it runs for real clients.

The brief doesn't have to be complete: it has to be good enough for a first draft. The fit-gap, the draft and the tests will settle much of the rest, and every question you raise is one more the operator has to answer before going on. So name only what a first draft can't do without: what would make the agent do the wrong work, get stuck on most runs, or put a client's data or money at risk. A detail that can be settled while drafting or testing (a wording, a threshold to tune, a rare case) is not a concern now.

Read the brief against the checklist, the catalog and the other work. Name only what applies to this work and the brief doesn't already settle; skip the rest. At most ${REVIEW_MAX}, most important first. Each concern is a question the operator can answer, in plain words, with why it matters. If another build or its open issue covers part of this work, raise it. Never ask for secrets (passwords, tax ids, card numbers). If the brief settles everything that matters, answer with no concerns.

Checklist:
${BUILD_CHECKLIST.map((c) => `- ${c.id}: ${c.question}`).join("\n")}`;

/** The brief's second look: what it doesn't settle yet. */
export async function reviewBrief(
  input: ReviewInput,
  options: { llm: LlmClient; model?: ModelId; signal?: AbortSignal },
): Promise<{ concerns: ReviewAnswer["concerns"]; calls: LlmCallRecord[]; costUsd: string | null }> {
  const brief = BRIEF_FIELDS.map((k) => {
    const f = input.brief[k];
    return `- ${BRIEF_LABELS[k]}: ${f ? `[${f.state}] ${f.text || "(open)"}` : "(not asked)"}`;
  }).join("\n");
  const content = [
    `<build>`,
    `Building: ${input.kind === "skill" ? "a skill" : "an agent"}, "${input.title}", ${input.clientName ? `for the client ${input.clientName}` : "for every client (a template)"}.`,
    `Brief:\n${brief}`,
    input.issues.length
      ? `Already open (don't raise again):\n${input.issues.map((i) => `- ${i}`).join("\n")}`
      : null,
    input.otherWork.length
      ? `Other work (other builds and their open issues):\n${input.otherWork.map((w) => `- ${w}`).join("\n")}`
      : null,
    `</build>`,
    "Review the brief.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const calls: LlmCallRecord[] = [];
  try {
    const res = await options.llm.callTool({
      model: options.model ?? DEFAULT_MODELS.builder,
      system: [
        ...(input.ctx
          ? [
              {
                type: "text" as const,
                text: `The platform's catalog, everything a build may use:\n${catalogBriefBlock(input.ctx)}`,
                cache_control: { type: "ephemeral" as const, ttl: "1h" as const },
              },
            ]
          : []),
        { type: "text" as const, text: REVIEW_RULES },
      ],
      messages: [{ role: "user", content }],
      tool: {
        name: REVIEW_TOOL,
        description: "What the brief doesn't settle yet",
        schema: ReviewAnswer,
      },
      maxTokens: 16_000,
      effort: BUILDER_EFFORT,
      label: "build-review",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    calls.push(res.record);
    return { concerns: res.value.concerns, calls, costUsd: totalCost(calls) };
  } catch (error) {
    if (error instanceof BuilderError) throw error;
    if (error instanceof LlmToolError) {
      throw new BuilderError("invalid_answer", `the review could not be used: ${error.message}`, {
        code: error.code,
      });
    }
    throw new BuilderError(
      "model_unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }
}
