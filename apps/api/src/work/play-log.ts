// Autopilot's two small stores (docs/plan.md §1.124; migration 0063): how far a play goes (its
// `play_setting` row, else the code default, `draft`) and what a play did (`play_log`, Autopilot's
// track record and Your call's Done today). Both tables are operator-only, so these run in an
// operator's transaction.

import { DEFAULT_PLAY_LEVEL, type PlayFlow, type PlayLevel } from "@countersign/core";
import { playLog, playSetting, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";

export type PlayLogRow = typeof playLog.$inferSelect;

/** The play's level: its row, else `draft`. */
export async function playLevel(
  tx: Tx,
  flow: PlayFlow,
  stage: string,
  play: string,
): Promise<PlayLevel> {
  const [row] = await tx
    .select({ level: playSetting.level })
    .from(playSetting)
    .where(
      and(eq(playSetting.flow, flow), eq(playSetting.stage, stage), eq(playSetting.play, play)),
    );
  return row?.level ?? DEFAULT_PLAY_LEVEL;
}

export interface PlayLogEntry {
  clientId: string | null;
  flow: PlayFlow;
  stage: string;
  play: string;
  level: PlayLevel;
  outcome: PlayLogRow["outcome"];
  edited?: boolean;
  about?: { kind: NonNullable<PlayLogRow["aboutKind"]>; id: string } | null;
  summary: string;
  internal?: boolean;
}

/** One line of what a play did. */
export async function logPlay(tx: Tx, entry: PlayLogEntry): Promise<PlayLogRow> {
  const [row] = await tx
    .insert(playLog)
    .values({
      clientId: entry.clientId,
      flow: entry.flow,
      stage: entry.stage,
      play: entry.play,
      level: entry.level,
      outcome: entry.outcome,
      edited: entry.edited ?? false,
      aboutKind: entry.about?.kind ?? null,
      aboutId: entry.about?.id ?? null,
      summary: entry.summary.slice(0, 300),
      internal: entry.internal ?? false,
    })
    .returning();
  if (!row) throw new Error("play_log insert returned nothing");
  return row;
}
