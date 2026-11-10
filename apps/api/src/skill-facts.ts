// The skill model (owner, 2026-11-10; ARCHITECTURE §10.14, docs/plan.md §1.86 "Skill model"),
// wave A: what the run views say of a step beyond its kind. A skill step is Deterministic or AI
// (core's `skillKind`, derived, never stored); a write step is "Save to records" (our own
// records) or "Change in <connector>" (a client's tool; core's `writeStepLabel`). The back office
// reads both by step id; the client's timeline reads only the write's kind and the connector's
// name, never a tool id, a model or a cost (invariant 11).

import { resolveCustomSkill } from "@countersign/agents";
import {
  allSteps,
  parseSkillRef,
  processes,
  type SkillDefinition,
  type StepModelFacts,
  skillKind,
  type TimelineWrite,
  type ToolSpec,
  toolLookup,
  Workflow,
  writeStepLabel,
  writesToClientTool,
} from "@countersign/core";
import type { Tx } from "@countersign/db";
import type { Platform } from "./platform";

type AnyStep = { id: string; kind: string; skill?: string; tool?: string };

/** Every step of a stored v3 workflow or v4 process, flat; none when it reads as neither. */
function stepsOf(definition: unknown): AnyStep[] {
  const v4 = processes.Process.safeParse(definition);
  if (v4.success) return processes.allSteps(v4.data).map((l) => l.step as AnyStep);
  const v3 = Workflow.safeParse(definition);
  return v3.success ? allSteps(v3.data).map((l) => l.step as AnyStep) : [];
}

/** The connector's name as people know it, for a tool's connector (null for our own tools). */
function connectorNameOf(platform: Platform, tool: ToolSpec | undefined): string | null {
  if (!tool) return null;
  const id = tool.connector ?? tool.source;
  return platform.connectors.get(id)?.manifest.name ?? null;
}

/** A write step's label, from the tool it calls. */
export function writeFacts(platform: Platform, toolId: string): StepModelFacts["write"] {
  const tool = platform.tools.get(toolId)?.spec;
  const label = writeStepLabel({ kind: "write" }, tool, connectorNameOf(platform, tool));
  return { kind: label.kind, text: label.text };
}

/** How a write reads on the client's timeline: saved, or changed in their tool (by name). */
export function timelineWrite(platform: Platform, toolId: string): TimelineWrite {
  const tool = platform.tools.get(toolId)?.spec;
  if (!writesToClientTool(tool)) return { kind: "save_to_records", connector: null };
  return { kind: "change_in", connector: connectorNameOf(platform, tool) };
}

/**
 * Each step's facts by step id: a skill step's kind (a built-in from the catalog, an operator
 * skill from its stored version, in the run's client), a write's (or a v3 action's) label.
 */
export async function stepModelFacts(
  tx: Tx,
  tenantId: string,
  definition: unknown,
  platform: Platform,
): Promise<Record<string, StepModelFacts>> {
  const lookup = toolLookup(platform.tools.specs());
  const out: Record<string, StepModelFacts> = {};
  const skills = new Map<string, SkillDefinition | null>();
  for (const step of stepsOf(definition)) {
    if (step.kind === "skill" && step.skill) {
      let def = skills.get(step.skill);
      if (def === undefined) {
        def =
          platform.catalog.get(parseSkillRef(step.skill).id) ??
          (await resolveCustomSkill(tx, { tenantId, ref: step.skill }))?.definition ??
          null;
        skills.set(step.skill, def);
      }
      if (def) out[step.id] = { skillKind: skillKind(def, lookup) };
    } else if ((step.kind === "write" || step.kind === "action") && step.tool) {
      out[step.id] = { write: writeFacts(platform, step.tool) };
    }
  }
  return out;
}
