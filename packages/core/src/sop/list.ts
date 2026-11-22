// Every agent's SOP in a row (docs/sop-plan.md §6, S2 "Across agents"): what the portal's
// Procedures page lists and filters across all of a client's agents. Made by code from each
// agent's own SOP view, so the list and the SOP can't disagree; it carries nothing the SOP doesn't
// (never the bundle, instructions, prompts or cost: invariant 11).

import { z } from "zod";
import { SopChange, SopLevel, SopParty, type SopView } from "./view";

export const SopListItem = z.object({
  agent: z.object({ id: z.string(), name: z.string() }),
  code: z.string(),
  area: z.object({ id: z.string(), words: z.string() }),
  stage: z.object({ id: z.string(), words: z.string() }),
  /** The SOP's purpose, as its section 1 says it. */
  purpose: z.string(),
  /** The current revision and what changed in it; null until the first is recorded. */
  revision: z
    .object({
      number: z.string(),
      at: z.string(),
      by: z.string().nullable(),
      where: z.string(),
      changes: z.array(SopChange),
    })
    .nullable(),
  /** Each system it uses and what it may do there (the SOP's section 7). */
  systems: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      read: SopLevel.nullable(),
      create: SopLevel.nullable(),
      update: SopLevel.nullable(),
      delete: SopLevel.nullable(),
    }),
  ),
  /** Who else takes part (the SOP's people matrix), never the agent itself. */
  parties: z.array(SopParty),
  /** How many steps, and how many of them AI or a person does. */
  steps: z.object({ all: z.number().int(), ai: z.number().int(), person: z.number().int() }),
});
export type SopListItem = z.infer<typeof SopListItem>;

export const SopList = z.object({ sops: z.array(SopListItem) }).meta({ id: "SopList" });
export type SopList = z.infer<typeof SopList>;

/** One agent's row in the list, from its SOP. */
export function sopListItem(view: SopView): SopListItem {
  const { revision } = view;
  return {
    agent: { id: view.agent.id, name: view.agent.name },
    code: view.code,
    area: view.area,
    stage: view.stage,
    purpose: view.purpose,
    revision: revision
      ? {
          number: revision.number,
          at: revision.at,
          by: revision.by,
          where: revision.where,
          changes: revision.changes,
        }
      : null,
    systems: view.systems.map((s) => ({
      key: s.key,
      name: s.name,
      read: s.read,
      create: s.create,
      update: s.update,
      delete: s.delete,
    })),
    parties: view.matrix.parties,
    steps: {
      all: view.summary.steps,
      ai: view.summary.ai + view.summary.rulesThenAi,
      person: view.summary.person,
    },
  };
}

/** Whether the agent may change records in a system: create or update not off. */
export function sopMayChange(system: SopListItem["systems"][number]): boolean {
  return [system.create, system.update].some((l) => l === "auto" || l === "ask");
}
