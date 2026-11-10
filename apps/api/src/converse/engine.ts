// R7 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "Conversations as a step"): P-4's conversation
// service as the v4 conversation step's engine (packages/agents `ConversationEngine`, behind its
// `conversationRunner`). Nothing here talks or decides: the step becomes the service's own
// `comms.converse` request, and the service does everything it does for a v3 step (each message a
// reach-out, signatures, quiet hours, the hand-over, stepping in). The service's rows are the
// truth; the step's event only wakes the run, so whatever woke it, an item it waits on is read
// from the inbox, never from the event's payload.

import type {
  ConversationEnded,
  ConversationEngine,
  ConversationEngineRequest,
  ConversationProgress,
} from "@countersign/agents";
import {
  CONVERSE_SKILL,
  type ConverseOutput,
  DEFAULT_APPROVAL,
  type SkillStep,
} from "@countersign/core";
import { inboxItem, run, withTenant } from "@countersign/db";
import type { RunInfo, StepOutcome } from "@countersign/workflows";
import { and, eq, isNull, sql } from "drizzle-orm";
import { toRunResolution } from "../inbox";
import { type ConverseDeps, type ConversePeek, conversePort } from "./service";

/** How the service's output reads to the runner. */
function endedOf(output: ConverseOutput): ConversationEnded {
  return {
    outcome: output.outcome,
    result: output.result,
    confirmed: output.confirmed,
    who: output.who ? { name: output.who.name } : null,
    messages: output.messages,
    replies: output.replies,
    transcript: output.transcript,
    sources: output.sources,
    reason: output.reason,
    ...(output.testRun ? { testRun: true } : {}),
    ...(output.opening ? { opening: output.opening } : {}),
  };
}

/** What a step outcome of the service means to the runner. */
function progressOf(outcome: StepOutcome, now: Date): ConversationProgress {
  switch (outcome.kind) {
    case "done":
      return { kind: "ended", output: endedOf(outcome.output as ConverseOutput) };
    case "approval":
      return {
        kind: "waiting",
        on: outcome.pending.waitingFor === "answer" ? "answer" : "signature",
        wakeAt: null,
      };
    case "waiting": {
      const minutes = Number.parseInt(outcome.wait.timeout, 10);
      const wakeAt = Number.isFinite(minutes)
        ? new Date(now.getTime() + minutes * 60_000).toISOString()
        : null;
      return { kind: "waiting", on: "reply", wakeAt };
    }
    case "escalated":
      return { kind: "failed", error: outcome.reason };
    case "failed":
      return { kind: "failed", error: outcome.error };
  }
}

export function conversationEngine(deps: ConverseDeps): ConversationEngine {
  const port = conversePort(deps);
  const { db } = deps;
  const now = () => deps.now?.() ?? deps.runtime.now?.() ?? new Date();

  /** The run as the service needs it: whose agent, which workflow. */
  const runInfo = async (req: ConversationEngineRequest): Promise<RunInfo | null> => {
    const [r] = await withTenant(db, req.tenantId, (tx) =>
      tx
        .select({ agentId: run.agentId, workflowSlug: run.workflowSlug })
        .from(run)
        .where(and(eq(run.id, req.runId), eq(run.tenantId, req.tenantId))),
    );
    if (!r) return null;
    return {
      id: req.runId,
      tenantId: req.tenantId,
      agentId: r.agentId,
      agentVersionId: req.agentVersionId,
      workflowSlug: r.workflowSlug,
      mode: req.mode,
    };
  };

  /** An item's resolution once it can reach the run (resolved, outside its undo window). */
  const resolutionOf = (tenantId: string, inboxItemId: string) =>
    withTenant(db, tenantId, async (tx) => {
      const [row] = await tx
        .select({
          item: inboxItem,
          held: sql<boolean>`coalesce(${inboxItem.deliverAfter} > now(), false)`,
        })
        .from(inboxItem)
        .where(and(eq(inboxItem.id, inboxItemId), eq(inboxItem.tenantId, tenantId)));
      return row?.item.status === "resolved" && !row.held ? toRunResolution(row.item) : null;
    });

  /** The run took the item's resolution: the cron stops re-sending its events. */
  const received = (tenantId: string, inboxItemId: string) =>
    withTenant(db, tenantId, (tx) =>
      tx
        .update(inboxItem)
        .set({ runReceivedAt: now() })
        .where(
          and(
            eq(inboxItem.id, inboxItemId),
            eq(inboxItem.tenantId, tenantId),
            isNull(inboxItem.runReceivedAt),
          ),
        ),
    );

  /**
   * Where it is, without moving it on. Something the run can take at once (an answered item, a
   * reply the next turn hasn't read) wakes it now, so a lost event costs nothing.
   */
  const report = async (tenantId: string, there: ConversePeek): Promise<ConversationProgress> => {
    const t = now().toISOString();
    switch (there.kind) {
      case "ended":
        return { kind: "ended", output: endedOf(there.output) };
      case "item": {
        const answered = await resolutionOf(tenantId, there.inboxItemId);
        return { kind: "waiting", on: there.on, wakeAt: answered ? t : null };
      }
      case "reply":
        return { kind: "waiting", on: "reply", wakeAt: there.wakeAt };
      case "moving":
        return { kind: "waiting", on: "reply", wakeAt: t };
    }
  };

  return {
    async advance(req) {
      // DECISION (R7): a conversation by phone isn't wired to the voice path in this stream: the
      // step fails with a plain reason rather than place a call nobody built the checks for.
      if (req.talk.kind === "call") {
        return { kind: "failed", error: "conversations by phone aren't available yet" };
      }
      if (!req.stepRunId)
        return { kind: "failed", error: "the conversation has no step to log on" };
      const info = await runInfo(req);
      if (!info) return { kind: "failed", error: "the run is gone" };
      const approval = { ...DEFAULT_APPROVAL, required: req.messages.first };
      const step: SkillStep = {
        id: req.key,
        name: "Conversation",
        kind: "skill",
        skill: CONVERSE_SKILL,
        // The step's input as written: its goal and result are the step's own fixed text.
        input: req.talk.input,
        approval,
      };
      const base = { run: info, step, nodeId: req.key, stepRunId: req.stepRunId };
      const there = info.mode === "test" ? null : await port.peek(info, req.key);
      if (!there) {
        const started = await port.start(
          { ...base, input: req.talk.input, approval },
          { perMessage: req.messages.later === "required" },
        );
        return progressOf(started, now());
      }
      // The first call and the check before each wait only say where it is.
      if (!req.wake) return report(info.tenantId, there);
      if (there.kind === "ended") return report(info.tenantId, there);
      if (there.kind === "item") {
        const resolution = await resolutionOf(info.tenantId, there.inboxItemId);
        if (!resolution) return report(info.tenantId, there);
        const next = await port.resume({
          ...base,
          pending: {
            inboxItemId: there.inboxItemId,
            state: there.state,
            ...(there.on === "answer" ? { waitingFor: "answer" as const } : {}),
          },
          resolution,
        });
        await received(info.tenantId, there.inboxItemId);
        return progressOf(next, now());
      }
      // A reply, the reply's wait passing, a held message gone out: the service carries on.
      const next = await port.afterWait({
        ...base,
        wait: {
          eventType: "conversation",
          timeout: "1 minute",
          state: { converse: { key: req.key } },
        },
        timedOut: req.wake.timedOut === true,
      });
      return progressOf(next, now());
    },

    async end(req) {
      const [r] = await withTenant(db, req.tenantId, (tx) =>
        tx
          .select({
            agentId: run.agentId,
            agentVersionId: run.agentVersionId,
            workflowSlug: run.workflowSlug,
            mode: run.mode,
          })
          .from(run)
          .where(and(eq(run.id, req.runId), eq(run.tenantId, req.tenantId))),
      );
      if (!r) return null;
      const info: RunInfo = {
        id: req.runId,
        tenantId: req.tenantId,
        agentId: r.agentId,
        agentVersionId: r.agentVersionId,
        workflowSlug: r.workflowSlug,
        mode: r.mode as RunInfo["mode"],
      };
      const ended = await port.end(info, req.key, req.reason);
      return ended ? { output: endedOf(ended.output), endedNow: ended.endedNow } : null;
    },
  };
}
