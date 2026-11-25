// A template build's setup checklist (docs/builder-plan.md §6, B4): the client intake form, the
// build's `client_setup` decisions and, by code, the draft's writes ("When do we start writing into
// QuickBooks?", "Who signs new bills in QuickBooks?") become the draft's `definition.setup` when the
// draft is made and when it moves to the POC test. A client copy forked from the template carries
// it; each client's progress is the copy's (`apps/api/src/setup/checklist.ts`).

import { convertLookup } from "@countersign/agents";
import {
  AnyAgentBundle,
  buildSetupItems,
  deepEqual,
  draftWriteUses,
  type FitGap,
  parseSkillRef,
  processes,
  type SetupItem,
  type SkillDefinition,
  settingForDecision,
  stepModelWriteUses,
  steps,
  toProcessBundle,
} from "@countersign/core";
import type { Services } from "../http";

/**
 * The checklist for a draft's latest bundle (stored, as `agent_version.bundle` holds it), from the
 * build's fit-gap record. Null when the bundle doesn't read as processes: then nothing is saved.
 */
export function draftSetupItems(
  services: Pick<Services, "platform">,
  fitgap: Pick<FitGap, "setup" | "decisions">,
  stored: unknown,
): SetupItem[] | null {
  const { platform } = services;
  let bundle: ReturnType<typeof toProcessBundle>;
  try {
    // Step model (build item 9): v5 workflows are read apart (`stepModelWriteUses`).
    bundle = toProcessBundle(
      AnyAgentBundle.parse(stored),
      convertLookup(platform.catalog, platform.tools),
      { stepModel: "skip" },
    );
  } catch {
    return null;
  }
  // The skills its steps and its definition use, from the platform's catalog (a client's own skill
  // isn't in a template's draft).
  const skills: Record<string, SkillDefinition> = {};
  const addSkill = (ref: string) => {
    const def = platform.catalog.get(parseSkillRef(ref).id);
    if (def) skills[ref] = def;
  };
  for (const s of bundle.definition.skills) addSkill(s.skill);
  for (const ref of AnyAgentBundle.parse(stored).workflows.flatMap((w) =>
    w.workflow.schemaVersion === 5 ? steps.stepModelSkills(w.workflow) : [],
  )) {
    addSkill(ref);
  }
  for (const w of bundle.workflows) {
    for (const { step } of processes.allSteps(w.workflow)) {
      if (step.kind === "skill") addSkill(step.skill);
    }
  }
  const tools = platform.tools.specs();
  return buildSetupItems({
    form: fitgap.setup,
    decisions: fitgap.decisions,
    writes: [
      ...draftWriteUses(bundle, { tools, skills }),
      ...stepModelWriteUses(AnyAgentBundle.parse(stored), tools),
    ],
    connectors: platform.connectors.list().map((c) => ({
      id: c.manifest.id,
      name: c.manifest.name,
    })),
    settingFor: (d) => settingForDecision(d, bundle, skills),
  });
}

/** The stored bundle with its checklist, or null when it already carries that one. */
export function withSetupItems(stored: unknown, items: readonly SetupItem[]): unknown | null {
  const b = stored as { definition?: { setup?: unknown } } | null;
  if (!b?.definition) return null;
  if (deepEqual(b.definition.setup ?? [], items)) return null;
  return { ...b, definition: { ...b.definition, setup: items } };
}
