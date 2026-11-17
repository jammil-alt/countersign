// Stages are a record, not a gate (docs/cases-plan.md §3.1; docs/plan.md §1.126): a deal moves
// forward past any stage, and each stage it passes over is a `stage` line on its timeline marked
// skipped, with who and why. What a later stage wants and wasn't given (the agreed price, the
// signed copy, what we're starting with) becomes a to-do on Your call, due in a week, made once per
// deal and item; never a block.

import {
  DEAL_WANT_DUE_DAYS,
  DEAL_WANT_WORDS,
  type DealKind,
  type DealStage,
  type DealWant,
  dealCheckBackOn,
  dealStageOf,
  dealWants,
  lastDealStage,
  skippedStages,
} from "@countersign/core";
import type { deal, Tx } from "@countersign/db";
import { addActivity, type DealRow, salesToday } from "./deals";
import { addTodo, type TodoRow } from "./todos-store";

/** A reason as a sentence: capitalised, ending in a full stop. */
function sentence(why: string): string {
  const t = why.trim();
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.?!]$/.test(s) ? s : `${s}.`;
}

export interface StageMover {
  actor: "operator" | "reggie" | "system";
  userId: string | null;
  /** Why: the move line's reason, and each skipped stage's. */
  why?: string | null | undefined;
}

/**
 * A stage move: the lines on the timeline (each stage passed over as skipped, then the move) and
 * the columns to set. Reaching the last stage wins it.
 */
// DECISION: a skipped stage is a `stage` line with `meta.skipped` (no new activity kind, so no
// migration), its body "Skipped Diagnostic: signed up directly."
export async function moveDealStage(
  tx: Tx,
  row: DealRow,
  to: DealStage,
  by: StageMover,
): Promise<Partial<typeof deal.$inferInsert>> {
  const kind = row.kind as DealKind;
  const from = dealStageOf(kind, row.stage as DealStage);
  const next = dealStageOf(kind, to);
  const why = by.why?.trim() || null;
  for (const id of skippedStages(kind, from.id, next.id)) {
    await addActivity(tx, row.id, {
      kind: "stage",
      actor: by.actor,
      userId: by.userId,
      body: `Skipped ${dealStageOf(kind, id).name}${why ? `: ${why.replace(/\.$/, "")}` : ""}.`,
      meta: { skipped: id, why },
    });
  }
  await addActivity(tx, row.id, {
    kind: "stage",
    actor: by.actor,
    userId: by.userId,
    body: `Moved from ${from.name} to ${next.name}.${why ? ` ${sentence(why)}` : ""}`,
    meta: { from: from.id, to: next.id },
  });
  // DECISION: the last stage (first agent live, live and billed) is the win: the deal is won there,
  // so the board's last column and the Done filter agree without a second step.
  const now = new Date();
  return {
    stage: to,
    stageAt: now,
    ...(to === lastDealStage(kind) ? { outcome: "won" as const, wonAt: now, closedAt: now } : {}),
  };
}

/** The lines a deal opened at a later stage writes: each stage before it, skipped. */
export async function addSkippedBefore(
  tx: Tx,
  row: DealRow,
  stages: readonly DealStage[],
  by: StageMover,
): Promise<void> {
  const kind = row.kind as DealKind;
  const why = by.why?.trim() || null;
  for (const id of stages) {
    await addActivity(tx, row.id, {
      kind: "stage",
      actor: by.actor,
      userId: by.userId,
      body: `Skipped ${dealStageOf(kind, id).name}${why ? `: ${why.replace(/\.$/, "")}` : ""}.`,
      meta: { skipped: id, why },
    });
  }
}

export interface WantedTodo {
  want: DealWant;
  title: string;
  dueOn: string;
}

/** What a deal wants and hasn't got, as the to-dos it would make (for a preview, and to make). */
export function wantedTodos(
  row: Pick<DealRow, "kind" | "stage" | "agreedMrr" | "signedCopyKey">,
  who: string,
  opts: { nothingChosen?: boolean; now?: Date } = {},
): WantedTodo[] {
  const dueOn = dealCheckBackOn(salesToday(opts.now), DEAL_WANT_DUE_DAYS);
  return dealWants({
    kind: row.kind as DealKind,
    stage: row.stage as DealStage,
    agreedMrr: row.agreedMrr,
    hasSignedCopy: !!row.signedCopyKey,
    ...(opts.nothingChosen ? { nothingChosen: true } : {}),
  }).map((want) => ({ want, title: DEAL_WANT_WORDS[want](who), dueOn }));
}

const WANT_WHY: Record<DealWant, string> = {
  price: "The deal moved on without an agreed price.",
  signed_copy: "The deal moved on without the signed contract.",
  start: "The account was made without anything to start with.",
};

/** Makes the to-dos for what the deal wants: once per deal and item (the dedupe key). */
export async function addWantedTodos(
  tx: Tx,
  row: DealRow,
  who: string,
  userId: string | null,
  opts: { nothingChosen?: boolean } = {},
): Promise<TodoRow[]> {
  const out: TodoRow[] = [];
  for (const w of wantedTodos(row, who, opts)) {
    out.push(
      await addTodo(tx, {
        clientId: row.clientId,
        owner: "operator",
        title: w.title,
        why: WANT_WHY[w.want],
        dueAt: new Date(`${w.dueOn}T09:00:00Z`),
        about: { kind: "deal", id: row.id },
        source: "system",
        dedupeKey: `deal:${row.id}:wants:${w.want}`,
        createdBy: userId,
      }),
    );
  }
  return out;
}
