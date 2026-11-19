// The setup checklist as the portal's Getting started and the back office's agent page show it
// (docs/builder-plan.md §6): each item, whether it is done, who did it and when, and which items
// hold the next stages. Nothing of the agent's version beyond the items' own words (invariant 11):
// an item says whether its answer sets a value, never which skill or parameter.

import { z } from "zod";
import type { AgentStage } from "../lifecycle/stage";
import { type SetupFacts, setupHolds, setupHoldText, setupItemDone } from "./checklist";
import { SetupGuard, type SetupItem, SetupItemKind, type SetupProgress } from "./item";

export const SetupRowView = z.object({
  id: z.string(),
  label: z.string(),
  kind: SetupItemKind,
  hint: z.string(),
  guards: SetupGuard,
  done: z.boolean(),
  /** Done by its connection (a connect item), not by a person. */
  byConnection: z.boolean(),
  /** Whether an answer becomes a setting of the agent. */
  setsValue: z.boolean(),
  suggested: z.string().nullable(),
  options: z.array(z.string()).nullable(),
  min: z.string().nullable(),
  max: z.string().nullable(),
  /** The connector a connect item is for. */
  connector: z.string().nullable(),
  value: z.string().nullable(),
  files: z.number().int(),
  byName: z.string().nullable(),
  side: z.enum(["client", "operator"]).nullable(),
  at: z.string().nullable(),
});
export type SetupRowView = z.infer<typeof SetupRowView>;

export const SetupView = z.object({
  items: z.array(SetupRowView),
  /** What holds the trial's start, and sign-off and live, in plain words; empty when nothing. */
  holds: z.object({ trial: z.string(), live: z.string() }),
  done: z.number().int(),
  total: z.number().int(),
});
export type SetupView = z.infer<typeof SetupView>;

/** The checklist with a client copy's progress, as both sides show it. */
export function setupView(
  items: readonly SetupItem[],
  progress: Readonly<Record<string, SetupProgress>> | undefined,
  facts: SetupFacts,
): SetupView {
  const rows: SetupRowView[] = items.map((i) => {
    const p = progress?.[i.id];
    const byConnection = i.kind === "connect" && !!i.connector;
    const done = setupItemDone(i, p, facts);
    return {
      id: i.id,
      label: i.label,
      kind: i.kind,
      hint: i.hint,
      guards: i.guards,
      done,
      byConnection,
      setsValue: i.setting !== undefined,
      suggested: i.suggested ?? null,
      options: i.bounds?.options ?? null,
      min: i.bounds?.min ?? null,
      max: i.bounds?.max ?? null,
      connector: i.connector ?? null,
      value: p?.value ?? null,
      files: p?.files?.length ?? 0,
      byName: byConnection ? null : (p?.byName ?? null),
      side: byConnection ? null : (p?.side ?? null),
      at: byConnection ? null : (p?.at ?? null),
    };
  });
  const holds = (to: AgentStage) => setupHoldText(setupHolds(items, progress, facts, to));
  return {
    items: rows,
    holds: { trial: holds("trial"), live: holds("live") },
    done: rows.filter((r) => r.done).length,
    total: rows.length,
  };
}
