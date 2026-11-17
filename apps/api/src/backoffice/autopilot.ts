// Autopilot on the server (docs/plan.md §1.123.4): the screen's view (every play at its level, with
// its record this month), setting a level, and `mayAct`, the check every play runs before it drafts
// or sends. What is always the operator's is refused here in code, whatever the screen shows.

import {
  ALWAYS_YOURS,
  ALWAYS_YOURS_SECRETS,
  AUTOPILOT_TARGETS,
  type AutopilotView,
  type NeverAuto,
  PLAY_FLOW_IDS,
  PLAY_FLOW_WORDS,
  PLAYS,
  type Play,
  type PlayFlow,
  type PlayLevel,
  type PlayTrack,
  type PlayView,
  playMaySend,
  playOf,
  playStages,
  REGGIE_NEVER_AUTO,
  readyToSend,
  trackLine,
} from "@countersign/core";
import { playSetting, type Tx } from "@countersign/db";
import { sql } from "drizzle-orm";
import { HttpError, notFound } from "../http";
import { playLevel } from "../work/play-log";

const ZERO: PlayTrack = {
  drafted: 0,
  sent: 0,
  edited: 0,
  done: 0,
  lastFive: 0,
  lastFiveUnchanged: 0,
};

const keyOf = (flow: string, stage: string, play: string) => `${flow}/${stage}/${play}`;

/** The first of this month (UTC): "this month" on the track lines. */
function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Each play's record: this month's counts and its last five sent. */
async function tracks(tx: Tx, now: Date): Promise<Map<string, PlayTrack>> {
  const out = new Map<string, PlayTrack>();
  const counts = await tx.execute<{
    flow: string;
    stage: string;
    play: string;
    drafted: number;
    sent: number;
    edited: number;
    done: number;
  }>(sql`select flow, stage, play,
      count(*) filter (where outcome = 'drafted')::int as drafted,
      count(*) filter (where outcome = 'sent')::int as sent,
      count(*) filter (where outcome = 'sent' and edited)::int as edited,
      count(*) filter (where outcome = 'done')::int as done
    from play_log where created_at >= ${monthStart(now).toISOString()}
    group by flow, stage, play`);
  for (const r of counts) {
    out.set(keyOf(r.flow, r.stage, r.play), {
      ...ZERO,
      drafted: r.drafted,
      sent: r.sent,
      edited: r.edited,
      done: r.done,
    });
  }
  const recent = await tx.execute<{
    flow: string;
    stage: string;
    play: string;
    n: number;
    unchanged: number;
  }>(sql`select flow, stage, play, count(*)::int as n,
      count(*) filter (where not edited)::int as unchanged
    from (
      select flow, stage, play, edited,
        row_number() over (partition by flow, stage, play order by created_at desc) as rn
      from play_log where outcome = 'sent'
    ) last where rn <= 5
    group by flow, stage, play`);
  for (const r of recent) {
    const k = keyOf(r.flow, r.stage, r.play);
    out.set(k, { ...(out.get(k) ?? ZERO), lastFive: r.n, lastFiveUnchanged: r.unchanged });
  }
  return out;
}

async function levels(tx: Tx): Promise<Map<string, PlayLevel>> {
  const rows = await tx.select().from(playSetting);
  return new Map(rows.map((r) => [keyOf(r.flow, r.stage, r.play), r.level]));
}

function view(
  flow: PlayFlow,
  stage: string,
  play: Play,
  level: PlayLevel,
  track: PlayTrack,
): PlayView {
  return {
    flow,
    stage,
    key: play.key,
    name: play.name,
    when: play.when,
    does: play.does,
    internal: play.internal,
    locked: play.locked ?? null,
    level,
    maySend: playMaySend(play),
    track,
    trackLine: trackLine(play, track),
    ready: !!play.suggest && readyToSend(play, level, track),
  };
}

export async function autopilotView(tx: Tx, now = new Date()): Promise<AutopilotView> {
  const [set, track] = [await levels(tx), await tracks(tx, now)];
  return {
    flows: PLAY_FLOW_IDS.map((flow) => ({
      flow,
      name: PLAY_FLOW_WORDS[flow],
      stages: playStages(flow).map((s) => ({
        stage: s.id,
        name: s.name,
        plays: (PLAYS[flow][s.id] ?? []).map((pl) => {
          const k = keyOf(flow, s.id, pl.key);
          return view(flow, s.id, pl, set.get(k) ?? "draft", track.get(k) ?? ZERO);
        }),
      })),
    })),
    alwaysYours: [...ALWAYS_YOURS],
    secrets: ALWAYS_YOURS_SECRETS,
    targets: [...AUTOPILOT_TARGETS],
  };
}

/** Sets a play's level. Send is refused (409 always_yours) for a play that is always yours. */
export async function setPlayLevel(
  tx: Tx,
  input: { flow: PlayFlow; stage: string; play: string; level: PlayLevel; userId: string },
  now = new Date(),
): Promise<PlayView> {
  const play = playOf(input.flow, input.stage, input.play);
  if (!play) throw notFound("play");
  if (input.level === "send" && !playMaySend(play)) {
    throw new HttpError(409, "always_yours", play.locked ?? "this play is always yours");
  }
  await tx
    .insert(playSetting)
    .values({
      flow: input.flow,
      stage: input.stage,
      play: input.play,
      level: input.level,
      updatedBy: input.userId,
    })
    .onConflictDoUpdate({
      target: [playSetting.flow, playSetting.stage, playSetting.play],
      set: { level: input.level, updatedBy: input.userId, updatedAt: now },
    });
  const track = (await tracks(tx, now)).get(keyOf(input.flow, input.stage, input.play)) ?? ZERO;
  return view(input.flow, input.stage, play, input.level, track);
}

export type PlayAction = "draft" | "send";

export interface MayAct {
  /** What the play may do now: send on its own, only draft for a person, or nothing. */
  allowed: "send" | "draft" | "off";
  level: PlayLevel;
  /** Why it was brought down, when it was. */
  reason: string | null;
}

/**
 * What a play may do, checked in code before it acts: the play's level, its lock, and anything on
 * the always-yours list (`touches`). Asking to send what may only be drafted comes back as draft;
 * nothing comes back as more than was asked.
 */
export async function mayAct(
  tx: Tx,
  input: {
    flow: PlayFlow;
    stage: string;
    play: string;
    action: PlayAction;
    touches?: readonly NeverAuto[];
    /** The read was unsure: the operator's, at any setting. */
    unsure?: boolean;
  },
): Promise<MayAct> {
  const play = playOf(input.flow, input.stage, input.play);
  if (!play) return { allowed: "off", level: "off", reason: "no such play" };
  const level = await playLevel(tx, input.flow, input.stage, input.play);
  if (level === "off") return { allowed: "off", level, reason: "the play is off" };
  if (input.action === "draft" || level === "draft") {
    return { allowed: "draft", level, reason: level === "draft" ? "the play drafts" : null };
  }
  if (!playMaySend(play)) return { allowed: "draft", level, reason: play.locked ?? "always yours" };
  const never = (input.touches ?? []).find((t) =>
    (REGGIE_NEVER_AUTO as readonly string[]).includes(t),
  );
  if (never) return { allowed: "draft", level, reason: `always yours: ${never}` };
  if (input.unsure) return { allowed: "draft", level, reason: "Reggie is unsure" };
  return { allowed: "send", level, reason: null };
}
