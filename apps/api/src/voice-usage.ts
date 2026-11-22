// H5 (docs/plan.md §1.196): what voice typing cost. Each recording written out (a segment of live
// dictation, §1.109) is one call to OpenAI, recorded as a portal question is (runs-ask/usage.ts):
// a portal dictation is the client's usage under its account agent (Sloan), a test run with one
// step and its `model_call` row, rolled up into usage_daily; the back office's, and a portal
// dictation of a client with no account agent, are the operator's cost, logged only. Neither keeps
// the recording or its words.

import type { Tx } from "@countersign/db";
import type { Transcription } from "@countersign/llm";
import { meterModelCalls } from "./metering";
import { recordAccountAgentCall } from "./runs-ask/usage";

/** `run.workflow_slug` of a dictation's run: it runs no workflow. */
export const VOICE_RUN_WORKFLOW = "voice.transcribe";

export interface TranscriptionUsage {
  surface: "portal" | "ops";
  /** The portal's client; for the back office, the client the dictation is about, if any. */
  tenantId: string | null;
  /** Who dictated. */
  userId: string;
  transcription: Transcription;
  /** The recording's type and size, never its sound. */
  recording: { type: string; bytes: number };
  /** The language the model was told, if any. */
  language?: string | undefined;
}

/**
 * §1.210: a dictation that is the operator's own cost, recorded as ours (on the client it is
 * about, or none), and logged as before.
 */
export async function recordOperatorTranscription(
  tx: Tx,
  u: TranscriptionUsage,
  why: string,
): Promise<void> {
  await meterModelCalls(tx, {
    tenantId: u.tenantId,
    source: "dictation",
    key: `dictation:${crypto.randomUUID()}`,
    calls: [
      {
        model: u.transcription.model,
        tokensIn: u.transcription.usage?.inputTokens ?? 0,
        tokensOut: u.transcription.usage?.outputTokens ?? 0,
        costUsd: u.transcription.costUsd,
      },
    ],
  });
  logTranscriptionCost(u, why);
}

/** A dictation's cost, logged as the operator's: who, about which client, the model and cost. */
export function logTranscriptionCost(u: TranscriptionUsage, why: string): void {
  console.info(
    JSON.stringify({
      event: "voice.transcribe.cost",
      who: "operator",
      why,
      surface: u.surface,
      tenantId: u.tenantId,
      userId: u.userId,
      model: u.transcription.model,
      tokensIn: u.transcription.usage?.inputTokens ?? 0,
      tokensOut: u.transcription.usage?.outputTokens ?? 0,
      seconds: u.transcription.usage?.seconds ?? null,
      costUsd: u.transcription.costUsd,
    }),
  );
}

/**
 * Records one portal dictation's call as the client's usage under Sloan, else logs it as the
 * operator's. Returns the run it wrote, if any.
 */
// DECISION: action `tool_call` ("Tool's own call"): speech-to-text is a capability's own call, as
// a translation or a web search in a step is, not an agent's turn or a question. Its own action
// would need a migration of `model_call_action_check`; the run's `workflow_slug`
// (`voice.transcribe`) and the step's node (`transcription`) tell dictation apart meanwhile.
// DECISION: an answer that says nothing of what it used is recorded with no tokens and a cost of
// 0, as an unpriced question is, with a warning in the log, so the gap shows rather than vanishes.
export async function recordTranscriptionUsage(
  tx: Tx,
  u: TranscriptionUsage,
): Promise<string | null> {
  if (u.surface === "ops" || !u.tenantId) {
    await recordOperatorTranscription(tx, u, "back office dictation");
    return null;
  }
  const t = u.transcription;
  const runId = await recordAccountAgentCall(tx, {
    tenantId: u.tenantId,
    workflowSlug: VOICE_RUN_WORKFLOW,
    trigger: { type: "dictation", surface: u.surface, dictatedBy: u.userId },
    node: "transcription",
    input: {
      type: u.recording.type,
      bytes: u.recording.bytes,
      ...(u.language ? { language: u.language } : {}),
    },
    output: {
      characters: t.text.length,
      ...(t.usage?.seconds != null ? { seconds: t.usage.seconds } : {}),
    },
    call: {
      model: t.model,
      action: "tool_call",
      tokensIn: t.usage?.inputTokens ?? 0,
      tokensOut: t.usage?.outputTokens ?? 0,
      costUsd: t.costUsd,
      durationMs: t.durationMs,
      stopReason: "transcribed",
    },
  });
  if (!runId) await recordOperatorTranscription(tx, u, "no account agent");
  else if (t.costUsd === null) {
    console.warn(
      JSON.stringify({ event: "voice.transcribe.unpriced", tenantId: u.tenantId, model: t.model }),
    );
  }
  return runId;
}
