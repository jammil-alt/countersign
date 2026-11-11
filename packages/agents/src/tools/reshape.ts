// Reshape data (owner, 2026-11-11; ARCHITECTURE §10.14 "Reshape data"): the built-in deterministic
// skill that turns any input into the output its step defines. Its handler is pure code over the
// step's mapping (core `processes.evaluateReshape`): it reads only its input, writes nothing and
// calls no model, so it is labelled Deterministic and may run on the test bench.

import { processes, type SkillDefinition } from "@countersign/core";
import { z } from "zod";
import { defineInternalTool } from "./types";

export const RESHAPE_SKILL = processes.RESHAPE_SKILL;

/** The handler: the step's mapping run on the step's input. */
// DECISION: the mapping reaches the handler in its input with the data and today (the runtime puts
// them there from the step), so the tool stays a pure function of its input, logged like any other
// call; a problem with any field fails the step naming the fields, never a partial output.
export const reshapeTool = defineInternalTool({
  id: processes.RESHAPE_TOOL,
  description:
    "Reshapes data into the fields a step defines: copies, literals and small typed calculations (sums, dates, money, text, lists, units). Reads only its input; no model.",
  sideEffect: "none",
  pure: true,
  summary: "Reshaped into {{fieldCount}} fields",
  input: z.object({
    data: z.unknown(),
    mapping: processes.ReshapeMapping,
    today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  output: z.object({
    output: z.record(z.string(), z.unknown()),
    fieldCount: z.number().int(),
  }),
  async run(input) {
    const r = processes.evaluateReshape(input.mapping, input.data, { today: input.today });
    if (r.problems.length > 0) {
      throw new Error(r.problems.map((p) => p.message).join("; "));
    }
    return { output: r.output, fieldCount: Object.keys(r.output).length };
  },
});

export const RESHAPE_SKILL_DEF: SkillDefinition = {
  schemaVersion: 1,
  id: RESHAPE_SKILL,
  name: "Reshape data",
  description:
    "Turns what earlier steps found into what the next step takes: each field copied, fixed, or worked out (sums, dates, money, text, lists, units). The same every time; no model.",
  category: "data",
  mode: "tool",
  handler: processes.RESHAPE_TOOL,
  // A built-in code skill lists its handler too: it isn't a tool wrapper (docs/plan.md §1.86).
  tools: [processes.RESHAPE_TOOL],
  input: { type: "object", additionalProperties: true },
  // The step's mapping types the output (`processes.reshapeOutputSchema`); the skill's is open.
  output: { type: "object", additionalProperties: true },
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
};

export const RESHAPE_SKILLS: readonly SkillDefinition[] = [RESHAPE_SKILL_DEF];
