// The test set a shipped Loop carries (docs/step-model-plan.md §8): a Loop from a pack or the
// platform is not published through the lab, so its cases ship beside it and CI replays them. A
// case is an input, what its read actions answer (fixtures), the model's turns written out by
// hand (replay: no model is called, and this environment has no key), and what it should hand back.
import { z } from "zod";
import { ToolId } from "../schemas/common";
import { Fixtures, Matcher } from "./case";

/** One turn the model takes in a replay: its words, and the action it calls (`finish` ends it). */
export const LoopReplayTurn = z.strictObject({
  said: z.string().max(2000).optional(),
  call: z.strictObject({ tool: z.union([z.literal("finish"), ToolId]), input: z.unknown() }),
});
export type LoopReplayTurn = z.infer<typeof LoopReplayTurn>;

export const LoopTestCase = z.strictObject({
  name: z.string().trim().min(1).max(200),
  input: z.unknown(),
  fixtures: Fixtures.default([]),
  replay: z.array(LoopReplayTurn).min(1).max(50),
  expected: z.unknown(),
  matcher: Matcher.default({ kind: "subset", tolerances: {} }),
});
export type LoopTestCase = z.infer<typeof LoopTestCase>;

/** A shipped Loop's cases, by its skill id. */
export const LoopTests = z.record(z.string(), z.array(LoopTestCase).min(1).max(50));
export type LoopTests = z.infer<typeof LoopTests>;

/** The Loop skills in a list that have no cases in `tests`, by id. */
export function loopsWithoutTests(
  skills: readonly { id: string; loop?: unknown }[],
  tests: LoopTests | undefined,
): string[] {
  return skills.filter((s) => s.loop !== undefined && !tests?.[s.id]?.length).map((s) => s.id);
}
