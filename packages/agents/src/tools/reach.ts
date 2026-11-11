// The built-in skill `comms.reach-out` (docs/plan.md §1.25): an agent contacts a person by email,
// text, WhatsApp or call, through its own bound channels, under the conditions of the person's
// role binding, and waits for a reply. It runs only as a workflow step: the step's approval covers
// the whole plan, each attempt is its own external action, and the run waits for the reply like a
// person step. apps/api carries it out (it needs the contacts, the waits and the cron); its handler
// here only refuses to run anywhere else, e.g. from a model in agent mode.

import {
  lazy,
  lazyObject,
  REACH_OUT_FIXED_INPUTS,
  REACH_OUT_SKILL,
  ReachOutInput,
  ReachOutOutput,
  type SkillDefinition,
} from "@countersign/core";
import { z } from "zod";
import { defineInternalTool } from "./types";

export const REACH_OUT_TOOL = "comms.reach_out";

export const reachOutTool = defineInternalTool({
  id: REACH_OUT_TOOL,
  description:
    "Reach a person by email, text, WhatsApp or call. Runs only as a workflow step (comms.reach-out).",
  sideEffect: "internal",
  verb: "create",
  input: z.record(z.string(), z.unknown()),
  output: z.object({ refused: z.string() }),
  async run() {
    throw new Error("comms.reach-out runs only as a workflow step");
  },
});

// Worker startup (2026-11-11): made on first read (core `lazy`); the skills below are lazyObjects.
const json = (schema: z.ZodType) =>
  lazy(
    () =>
      z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>,
  );

export const REACH_OUT_SKILL_DEF: SkillDefinition = lazyObject({
  schemaVersion: 1,
  id: REACH_OUT_SKILL,
  name: "Reach out to a person",
  description:
    "Contacts a person in one of the agent's roles (or a contact) by email, text, WhatsApp or call, in their language, under the role's conditions, and waits for a reply.",
  category: "people",
  mode: "tool",
  handler: REACH_OUT_TOOL,
  tools: [],
  input: json(ReachOutInput),
  output: json(ReachOutOutput),
  settings: [],
  summary: "Reached out: {{outcome}}",
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
  fixedInputs: [...REACH_OUT_FIXED_INPUTS],
  reachesPeople: true,
});

export const REACH_SKILLS: readonly SkillDefinition[] = [REACH_OUT_SKILL_DEF];
