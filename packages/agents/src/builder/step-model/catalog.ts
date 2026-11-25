// The catalog a v5 draft reads (docs/step-model-plan.md §10, build item 9): what the Uses picker
// offers, in the picker's own groups, so the Builder picks "QuickBooks › Create bill" where a person
// would. In order of reuse: actions (connectors' and areas'), match profiles, library skills, saved
// Loops, automations. Pure: the API gathers `ctx.stepModel`; this shapes it for the prompt.

import {
  CONVERSE_SKILL,
  FORMS_REQUEST_SKILL,
  processes,
  promptJson,
  REACH_OUT_SKILL,
  type SkillDefinition,
  skillKind,
  steps,
  toolLookup,
} from "@countersign/core";
import type { BuilderContext, BuilderSkill } from "../context";

/** A skill offered as a Do step's Uses: deterministic ones are done by rules, the rest by AI. */
export function skillDoneBy(
  def: SkillDefinition,
  ctx: Pick<BuilderContext, "tools">,
): "rules" | "ai" {
  return skillKind(def, toolLookup(ctx.tools)) === "deterministic" ? "rules" : "ai";
}

/** The skill categories a Do step never picks: F's step skills are a step's own text. */
const NOT_OFFERED_CATEGORIES = new Set(["in-a-step"]);

/**
 * Built-in skills that run only as a step of their own (apps/api carries them out), never as a
 * tool: reach out to a contact, ask someone through a form and wait for the answers, hold a
 * conversation. They were core's `STEP_ONLY_SKILLS`.
 */
export const STEP_ONLY_SKILLS: readonly string[] = [CONVERSE_SKILL, REACH_OUT_SKILL, FORMS_REQUEST_SKILL];

/**
 * The library skills a Do step may use: not a Loop (a Loop step's), not a step's own text, not a
 * skill that only stands for its tool (the API leaves those out), not one of the engines behind a
 * person's or a contact's Do (Request info, Reach out, Converse: §10e).
 */
export function doSkills(ctx: Pick<BuilderContext, "skills">): BuilderSkill[] {
  // The API offers no skill that only wraps its tool (`isToolWrapper`): its action is offered.
  const engines = new Set(STEP_ONLY_SKILLS);
  return ctx.skills.filter(
    (s) =>
      s.definition.loop === undefined &&
      !NOT_OFFERED_CATEGORIES.has(s.definition.category) &&
      !engines.has(s.ref),
  );
}

/**
 * The merged Accounting actions stand for a write action (`processes.ACTION_SPECS`): a run maps
 * from that action's own input (`processes.actionInputSchema`), translated to each accounting
 * tool's, so its fields are those, not its first tool's (QuickBooks').
 */
const MERGED_WRITE_ACTIONS: Readonly<Record<string, processes.WriteAction>> = {
  "accounting.bill.create": "create_bill",
  "accounting.vendor.create": "create_vendor",
};

/**
 * The catalog with each merged Accounting action's input read from its own write action, as runs
 * and the publish checks read it (`stepContext.requiredInput`).
 */
// DECISION (coordinator, from stream A's #682): fixed where the catalog is built for the route
// and the Builder, not in the frozen `steps/catalog.ts`, which takes a merged action's fields from
// its first tool.
export function withWriteActionFields(groups: readonly steps.CatalogGroup[]): steps.CatalogGroup[] {
  return groups.map((g) => ({
    ...g,
    actions: g.actions.map((a) => {
      const write = MERGED_WRITE_ACTIONS[a.id];
      return write
        ? { ...a, input: steps.fieldsFromSchema(processes.actionInputSchema(write)) }
        : a;
    }),
  }));
}

/** The action catalog for this context: the API's, else made from the tools it has. */
export function actionGroups(ctx: Pick<BuilderContext, "tools" | "stepModel" | "connectors">) {
  if (ctx.stepModel) return ctx.stepModel.actions;
  return withWriteActionFields(
    steps.buildActionCatalog(ctx.tools, {
      connectors: Object.fromEntries(ctx.connectors.map((c) => [c.id, c.name])),
      areas: {},
    }),
  );
}

/**
 * The action ids a draft may use: the catalog's (the Uses picker's, without what the operator
 * turned off on a connector's page); every registered tool when the context has no catalog.
 */
export function offeredActions(
  ctx: Pick<BuilderContext, "tools" | "stepModel" | "connectors">,
): Set<string> {
  const out = new Set<string>();
  for (const g of actionGroups(ctx)) for (const a of g.actions) out.add(a.id);
  if (!ctx.stepModel) for (const t of ctx.tools) out.add(t.id);
  return out;
}

/** Every action id the catalog offers, merged ones included, with its kind. */
export function actionKinds(
  ctx: Pick<BuilderContext, "tools" | "stepModel" | "connectors">,
): Map<string, steps.ActionKind> {
  const out = new Map<string, steps.ActionKind>();
  for (const g of actionGroups(ctx)) for (const a of g.actions) out.set(a.id, a.kind);
  // A registered tool the catalog leaves out (an engine, a superseded action) keeps its kind, so a
  // revision that still uses it is read right; it is never offered.
  for (const t of ctx.tools) {
    if (!out.has(t.id)) out.set(t.id, steps.actionKind(t));
  }
  return out;
}

/** Fields in short: `name: type` (`?` when optional), a list's or a group's fields inside. */
function fieldsShort(fields: readonly steps.Field[]): string[] {
  return fields.map((f) => {
    const inner = f.of && f.of.length > 0 ? ` of {${fieldsShort(f.of).join(", ")}}` : "";
    const record = f.record ? ` (${f.record})` : "";
    return `${f.name}${f.required ? "" : "?"}: ${f.type}${record}${inner}`;
  });
}

/**
 * The catalog as a v5 draft reads it. Actions show only what the narrowed context keeps (two
 * rounds, `../shortlist`): a tool's action when the tool is in `ctx.tools`, a merged action when
 * any of its tools is.
 */
export function stepCatalogForPrompt(ctx: BuilderContext): Record<string, unknown> {
  const toolIds = new Set(ctx.tools.map((t) => t.id));
  const shown = (a: steps.CatalogAction) => {
    const merged = steps.mergedAction(a.id);
    return merged ? Object.values(merged.tools).some((t) => toolIds.has(t)) : toolIds.has(a.id);
  };
  const actions = actionGroups(ctx)
    .map((g) => ({
      [g.type]: g.id,
      name: g.name,
      actions: g.actions.filter(shown).map((a) => ({
        id: a.id,
        label: a.label,
        kind: a.kind,
        description: a.description,
        input: fieldsShort(a.input),
        output: fieldsShort(a.output),
      })),
    }))
    .filter((g) => g.actions.length > 0);
  const profiles = (ctx.stepModel?.profiles ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    area: p.area,
    types: p.types,
    keys: p.keys.map((k) => ({ id: k.id, name: k.name, field: k.field })),
    input: fieldsShort(p.input),
    ...(p.neverSame.length ? { neverTheSameIf: p.neverSame.map((n) => n.words) } : {}),
  }));
  const skills = doSkills(ctx).map((s) => ({
    id: s.ref,
    name: s.definition.name,
    description: s.definition.description,
    doneBy: skillDoneBy(s.definition, ctx),
    input: fieldsShort(steps.fieldsFromSchema(s.definition.input)),
    output: fieldsShort(steps.fieldsFromSchema(s.definition.output)),
    ...(s.definition.settings.length
      ? {
          settings: s.definition.settings.map((x) => ({
            key: x.key,
            label: x.label,
            type: x.type,
            default: x.default,
          })),
        }
      : {}),
    ...(s.definition.requiresConnectors.length
      ? { needsConnectors: s.definition.requiresConnectors }
      : {}),
    ...(s.definition.requiresPacks.length ? { needsPacks: s.definition.requiresPacks } : {}),
  }));
  const loops = (ctx.stepModel?.loops ?? []).map((s) => ({
    id: s.ref,
    name: s.definition.name,
    description: s.definition.description,
    goal: s.definition.loop?.goal,
    reads: s.definition.reads ?? [],
    input: fieldsShort(steps.fieldsFromSchema(s.definition.input)),
    output: fieldsShort(steps.fieldsFromSchema(s.definition.output)),
  }));
  return {
    actions,
    matchProfiles: profiles,
    skills,
    loops,
    ...(ctx.automations
      ? {
          automations: ctx.automations.map((a) => ({
            ref: a.ref,
            name: a.name,
            description: a.description,
            input: fieldsShort(steps.fieldsFromSchema(a.input)),
          })),
        }
      : {}),
    connectors: ctx.connectors,
    events: ctx.events.map((e) => ({
      type: e.type,
      description: e.description,
      payload: e.payload,
    })),
    templates: ctx.templates,
    otherAgents: ctx.agentSlugs,
    ...(ctx.models ? { models: ctx.models } : {}),
    ...(ctx.people ? { people: ctx.people } : {}),
    ...(ctx.client
      ? {
          client: {
            name: ctx.client.name,
            connections: ctx.client.connections,
            packs: ctx.client.packs,
          },
        }
      : {}),
  };
}

export function stepCatalogBlock(ctx: BuilderContext): string {
  return `<catalog>\n${promptJson(stepCatalogForPrompt(ctx))}\n</catalog>`;
}
