// The skill model (owner, 2026-11-10; ARCHITECTURE §10.14, docs/plan.md §1.86 "Skill model"),
// wave A: what the run views say of a step beyond its kind. A skill step is Deterministic or AI
// (core's `skillKind`, derived, never stored); a write step is "Save to records" (our own
// records) or "Change in <connector>" (a client's tool; core's `writeStepLabel`). The back office
// reads both by step id; the client's timeline reads only the write's kind and the connector's
// name, never a tool id, a model or a cost (invariant 11).

import { resolveCustomSkill } from "@countersign/agents";
import {
  parseSkillRef,
  type SkillDefinition,
  type StepModelFacts,
  skillKind,
  steps,
  type TimelineWrite,
  type ToolSpec,
  toolLookup,
  writeStepLabel,
  writesToClientTool,
} from "@countersign/core";
import type { Tx } from "@countersign/db";
import type { Platform } from "./platform";

type AnyStep = {
  id: string;
  kind: string;
  skill?: string;
  tool?: string;
};

/**
 * Every step of a stored workflow that uses a skill or an action, flat; none when it doesn't read.
 * An action is a read or a write by its tool's side effect (a merged action by its first tool).
 */
function stepsOf(definition: unknown, platform: Platform): AnyStep[] {
  const parsed = steps.Workflow.safeParse(definition);
  if (!parsed.success) return [];
  const out: AnyStep[] = [];
  steps.eachStep(parsed.data.steps, ({ step }) => {
    if (step.kind !== "do" || !step.uses) return;
    if (step.uses.type === "skill") {
      out.push({ id: step.id, kind: "skill", skill: step.uses.skill });
    } else if (step.uses.type === "action") {
      const merged = steps.mergedAction(step.uses.action);
      const tool = platform.tools.get(step.uses.action)
        ? step.uses.action
        : Object.values(merged?.tools ?? {})[0];
      if (!tool) return;
      const sideEffect = platform.tools.get(tool)?.spec.sideEffect;
      out.push({ id: step.id, kind: sideEffect === "none" ? "read" : "write", tool });
    }
  });
  return out;
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

/**
 * How a Do that uses an action reads on the client's timeline: saved or changed in their tool, by
 * the action's tool (a merged action by its first tool); null for a read or an action not known.
 */
export function actionTimelineWrite(platform: Platform, action: string): TimelineWrite | null {
  const merged = steps.mergedAction(action);
  const tool = platform.tools.get(action)
    ? action
    : Object.values(merged?.tools ?? {}).find((t) => platform.tools.get(t));
  const spec = tool ? platform.tools.get(tool)?.spec : undefined;
  if (!tool || !spec || spec.sideEffect === "none") return null;
  return timelineWrite(platform, tool);
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
  for (const step of stepsOf(definition, platform)) {
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
    } else if (step.kind === "write" && step.tool) {
      out[step.id] = {
        write: writeFacts(platform, step.tool),
        ...(lookup(step.tool)?.usesModel !== undefined ? { usesModel: true as const } : {}),
      };
    } else if (step.kind === "read" && step.tool && lookup(step.tool)?.usesModel !== undefined) {
      // Review: the hidden AI is never unlabelled, a read included.
      out[step.id] = { usesModel: true };
    }
  }
  return out;
}
