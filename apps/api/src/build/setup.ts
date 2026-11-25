// A template build's setup checklist (docs/builder-plan.md §6, B4): the client intake form, the
// build's `client_setup` decisions and, by code, the draft's writes ("When do we start writing into
// QuickBooks?", "Who signs new bills in QuickBooks?") become the draft's `definition.setup` when the
// draft is made and when it moves to the POC test. A client copy forked from the template carries
// it; each client's progress is the copy's (`apps/api/src/setup/checklist.ts`).

import {
  AgentBundle,
  buildSetupItems,
  deepEqual,
  type FitGap,
  parseSkillRef,
  type SetupItem,
  type SkillDefinition,
  settingForDecision,
  stepModelWriteUses,
  steps,
} from "@countersign/core";
import type { Services } from "../http";

/**
 * The checklist for a draft's latest bundle (stored, as `agent_version.bundle` holds it), from the
 * build's fit-gap record. Null when the bundle doesn't read: then nothing is saved.
 */
export function draftSetupItems(
  services: Pick<Services, "platform">,
  fitgap: Pick<FitGap, "setup" | "decisions">,
  stored: unknown,
): SetupItem[] | null {
  const { platform } = services;
  let bundle: AgentBundle;
  try {
    bundle = AgentBundle.parse(stored);
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
  for (const ref of bundle.workflows.flatMap((w) => steps.stepModelSkills(w.workflow))) {
    addSkill(ref);
  }
  const tools = platform.tools.specs();
  return buildSetupItems({
    form: fitgap.setup,
    decisions: fitgap.decisions,
    writes: stepModelWriteUses(bundle, tools),
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
