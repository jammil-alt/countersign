// P-4: the built-in skill `comms.converse` (ARCHITECTURE §10.12; docs/plan.md §1.66): the agent
// talks with one person on one channel until a typed goal is met, within limits. It runs only as a
// workflow step: apps/api carries it out (it needs contacts, reach out's sends, waits and the
// cron); its handler here only refuses to run anywhere else, e.g. from a model in agent mode.

import {
  CONVERSE_FIXED_INPUTS,
  CONVERSE_SKILL,
  ConverseInput,
  ConverseOutput,
  lazy,
  lazyObject,
  type SkillDefinition,
} from "@countersign/core";
import { z } from "zod";
import { defineInternalTool } from "./types";

export const CONVERSE_TOOL = "comms.converse";

export const converseTool = defineInternalTool({
  id: CONVERSE_TOOL,
  usesModel: "each turn of the conversation is written by a model in the agent's voice",
  description:
    "Talk with a person until a goal is met. Runs only as a workflow step (comms.converse).",
  sideEffect: "internal",
  verb: "create",
  input: z.record(z.string(), z.unknown()),
  output: z.object({ refused: z.string() }),
  async run() {
    throw new Error("comms.converse runs only as a workflow step");
  },
});

// Worker startup (2026-11-11): made on first read (core `lazy`); the skills below are lazyObjects.
const json = (schema: z.ZodType) =>
  lazy(
    () =>
      z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>,
  );

export const CONVERSE_SKILL_DEF: SkillDefinition = lazyObject({
  schemaVersion: 1,
  id: CONVERSE_SKILL,
  name: "Talk with a person",
  description:
    "Holds a short conversation with one person (a contact on WhatsApp, text or email, or a client user in the portal) until a goal is met and confirmed, within limits on messages, time and cost; a limit hands it to a person.",
  category: "people",
  mode: "tool",
  handler: CONVERSE_TOOL,
  tools: [],
  input: json(ConverseInput),
  output: json(ConverseOutput),
  settings: [],
  summary: "Talked it through: {{outcome}}",
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
  fixedInputs: [...CONVERSE_FIXED_INPUTS],
  reachesPeople: true,
  resultFromInput: "result",
});

export const CONVERSE_SKILLS: readonly SkillDefinition[] = [CONVERSE_SKILL_DEF];
