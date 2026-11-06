// The Builder's server guards (ARCHITECTURE §9.6, CLAUDE.md invariants 3 and 8). They hold
// whatever the model answers: a draft's bundle is reshaped here before it is validated and saved,
// and every change the guards make is reported as a gap (a missing capability) or a note (a rule
// the Builder may not break).
//
// - Only registered skills and tools: a skill step, action step, listed skill or extra tool the
//   registries don't know is removed and listed in `gaps`.
// - New agents are `suggest_only`; a revision keeps the mode of the version it revises.
// - Every step that writes to a client's tool keeps approval on. A revision may keep an approval
//   the operator switched off on that same step; the Builder never switches one off itself.
// - Platform kind, budgets and memory stay the operator's: the Builder makes functional agents.
// - Ids: a new draft's step, path and trigger ids are made here, once (uuid v7); a revision keeps
//   every id of the version it revises and gives new nodes new ids. References follow the ids.

import {
  type AgentBundle,
  AgentBundle as AgentBundleSchema,
  type Approval,
  type BundleWorkflow,
  isPlainObject,
  NEW_AGENT_OVERSIGHT,
  OversightSettings,
  parseSkillRef,
  type SkillDefinition,
  type Step,
  stepWrites,
  type ToolSpec,
  type TypingContext,
  uuidv7,
  walkSteps,
} from "@countersign/core";
import type { BuilderContext } from "./context";

export interface GuardOptions {
  /** `draft`: a new agent; `revise`: a new version of `source`. */
  mode: "draft" | "revise";
  /** The version a revision starts from. */
  source?: AgentBundle;
  /**
   * v0.12 W3-A: in a conversation, the operator's version the session started from (null for a
   * new agent). When given, the operator's rules (mode, budgets, memory, oversight, approvals the
   * operator switched off) follow it, while ids and skill references follow `source`, the working
   * draft, so the guards hold across turns.
   */
  origin?: AgentBundle | null;
  /** Fresh node ids (uuid v7 by default; tests pass a counter). */
  newId?: () => string;
}

export interface GuardResult {
  bundle: AgentBundle;
  /** Capabilities the request needs that don't exist (no skill, tool, connector, connection). */
  gaps: string[];
  /** Rules the guards enforced on the model's answer, in plain words. */
  notes: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Every node id of a workflow, in order: trigger, then steps, paths and otherwise branches. */
export function workflowNodeIds(w: BundleWorkflow["workflow"]): string[] {
  // v0.12 W3-A: other triggers (W2-E) have ids too.
  const ids = [w.trigger.id, ...(w.moreTriggers ?? []).map((t) => t.id)];
  walkSteps(w, ({ step }) => {
    ids.push(step.id);
    if (step.kind === "fork") {
      for (const p of step.paths) ids.push(p.id);
      ids.push(step.otherwise.id);
    }
  });
  return ids;
}

/** Rewrites `steps.<old>` inside every `{{…}}` of every string under `value`. */
export function rewriteRefs(value: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    if (!value.includes("{{")) return value;
    const ref = /(^|[^A-Za-z0-9_.])steps\.([A-Za-z0-9][A-Za-z0-9_-]*)/g;
    return value.replace(
      /\{\{([^}]*)\}\}/g,
      (_whole, inner: string) =>
        `{{${inner.replace(ref, (m, pre: string, id: string) => {
          const to = map.get(id);
          return to ? `${pre}steps.${to}` : m;
        })}}}`,
    );
  }
  if (Array.isArray(value)) return value.map((v) => rewriteRefs(v, map));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteRefs(v, map)]));
  }
  return value;
}

/**
 * Gives every node an id under the rules above. Returns the bundle with ids replaced and every
 * `{{steps.<id>…}}` reference pointed at the new ids.
 */
export function assignIds(
  bundle: AgentBundle,
  keep: ReadonlySet<string>,
  newId: () => string,
): AgentBundle {
  const used = new Set<string>();
  const slugs = new Set<string>();
  const workflows = bundle.workflows.map((bw) => {
    const map = new Map<string, string>();
    const take = (id: string): string => {
      const next = keep.has(id) && !used.has(id) ? id : newId();
      used.add(next);
      if (!map.has(id)) map.set(id, next);
      return next;
    };
    const renameSteps = (steps: Step[]): Step[] =>
      steps.map((s): Step => {
        const id = take(s.id);
        if (s.kind === "fork") {
          return {
            ...s,
            id,
            paths: s.paths.map((p) => {
              const pid = take(p.id);
              return { ...p, id: pid, steps: renameSteps(p.steps) };
            }),
            otherwise: (() => {
              const oid = take(s.otherwise.id);
              return { ...s.otherwise, id: oid, steps: renameSteps(s.otherwise.steps) };
            })(),
          };
        }
        if (s.kind === "for_each") return { ...s, id, steps: renameSteps(s.steps) };
        return { ...s, id };
      });
    const trigger = { ...bw.workflow.trigger, id: take(bw.workflow.trigger.id) };
    // v0.12 W3-A: other triggers' ids follow the same rule.
    const more = bw.workflow.moreTriggers?.map((t) => ({ ...t, id: take(t.id) }));
    const steps = renameSteps(bw.workflow.steps);
    let slug = bw.slug;
    for (let n = 2; slugs.has(slug); n += 1) slug = `${bw.slug}-${n}`;
    slugs.add(slug);
    const workflow = rewriteRefs(
      { ...bw.workflow, trigger, ...(more ? { moreTriggers: more } : {}), steps },
      map,
    ) as typeof bw.workflow;
    return { ...bw, slug, workflow };
  });
  return { ...bundle, workflows };
}

/** Maps every step list in a workflow, depth first, dropping steps `keep` refuses. */
function filterSteps(steps: Step[], keepStep: (s: Step) => boolean): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    if (!keepStep(s)) continue;
    if (s.kind === "fork") {
      out.push({
        ...s,
        paths: s.paths.map((p) => ({ ...p, steps: filterSteps(p.steps, keepStep) })),
        otherwise: { ...s.otherwise, steps: filterSteps(s.otherwise.steps, keepStep) },
      });
    } else if (s.kind === "for_each") {
      out.push({ ...s, steps: filterSteps(s.steps, keepStep) });
    } else {
      out.push(s);
    }
  }
  return out;
}

/** Applies `fn` to every step (containers after their children), returning new lists. */
function mapSteps(steps: Step[], fn: (s: Step) => Step): Step[] {
  return steps.map((s) => {
    if (s.kind === "fork") {
      return fn({
        ...s,
        paths: s.paths.map((p) => ({ ...p, steps: mapSteps(p.steps, fn) })),
        otherwise: { ...s.otherwise, steps: mapSteps(s.otherwise.steps, fn) },
      });
    }
    if (s.kind === "for_each") return fn({ ...s, steps: mapSteps(s.steps, fn) });
    return fn(s);
  });
}

function stepsOf(bundle: AgentBundle): Map<string, Step> {
  const out = new Map<string, Step>();
  for (const w of bundle.workflows) walkSteps(w.workflow, ({ step }) => out.set(step.id, step));
  return out;
}

function approvalOf(step: Step): Approval | undefined {
  return step.kind === "skill" || step.kind === "action" ? step.approval : undefined;
}

/** Applies every guard to the model's bundle (already through Zod). */
export function guardBundle(
  input: AgentBundle,
  ctx: BuilderContext,
  options: GuardOptions,
): GuardResult {
  const gaps: string[] = [];
  const notes: string[] = [];
  const gap = (text: string) => {
    if (!gaps.includes(text)) gaps.push(text);
  };
  const note = (text: string) => {
    if (!notes.includes(text)) notes.push(text);
  };
  const source = options.mode === "revise" ? options.source : undefined;
  const newId = options.newId ?? (() => uuidv7());

  const tools = new Map(ctx.tools.map((t) => [t.id, t]));
  const skillsById = new Map<string, SkillDefinition>();
  for (const s of ctx.skills) skillsById.set(parseSkillRef(s.ref).id, s.definition);
  // A revision may keep every reference its source already makes (pinned versions, client copies).
  const sourceRefs = new Set<string>();
  if (source) {
    for (const s of source.definition.skills) sourceRefs.add(s.skill);
    for (const w of source.workflows) {
      walkSteps(w.workflow, ({ step }) => {
        if (step.kind === "skill") sourceRefs.add(step.skill);
      });
    }
  }
  const knownRef = (ref: string) => sourceRefs.has(ref) || skillsById.has(parseSkillRef(ref).id);
  /** New references name the skill, not a version: pins come from the operator. */
  const normalRef = (ref: string) => (sourceRefs.has(ref) ? ref : parseSkillRef(ref).id);

  // ── Definition ────────────────────────────────────────────────────────────────────────────────
  const def = structuredClone(input.definition);
  if (def.kind !== "functional") {
    def.kind = "functional";
    note("The Builder makes functional agents; platform agents are seeded.");
  }
  // v0.12 W3-A: in a conversation the operator's rules follow the version it started from (none for
  // a new agent), whatever earlier turns made of the working draft.
  const operatorSource = options.origin !== undefined ? options.origin : source;
  const mode = operatorSource ? operatorSource.definition.permissions.mode : "suggest_only";
  if (def.permissions.mode !== mode) {
    note(
      mode === "suggest_only"
        ? "It suggests only: every change it wants to make waits for a person. Only you can change that."
        : "Its mode stays as it was: the Builder doesn't change what an agent may do.",
    );
    def.permissions = { ...def.permissions, mode };
  }
  const budgetSource = operatorSource ?? source;
  if (budgetSource) {
    // What an agent may spend and remember is the operator's to set.
    def.budgets = budgetSource.definition.budgets;
    def.memory = budgetSource.definition.memory;
  }
  // v0.13 W2-I / v0.12 W3-A: oversight is the operator's on an existing agent; a new agent from
  // the Builder reviews its failed steps at least (ARCHITECTURE §10.11).
  if (operatorSource) {
    if (operatorSource.definition.oversight === undefined) delete def.oversight;
    else def.oversight = operatorSource.definition.oversight;
  } else if (def.oversight === undefined || def.oversight.review === "off") {
    if (def.oversight?.review === "off") {
      note("It reviews its failed steps: new agents start with oversight on failures.");
    }
    def.oversight = OversightSettings.parse(NEW_AGENT_OVERSIGHT);
  }

  const skillList: AgentBundle["definition"]["skills"] = [];
  // Unknown skills a step also asks for are reported once, by the step (below).
  const unknownListed: string[] = [];
  for (const s of def.skills) {
    if (!knownRef(s.skill)) {
      unknownListed.push(s.skill);
      continue;
    }
    const ref = normalRef(s.skill);
    if (!skillList.some((x) => parseSkillRef(x.skill).id === parseSkillRef(ref).id)) {
      skillList.push({ ...s, skill: ref });
    }
  }
  def.skills = skillList;

  const extraTools: string[] = [];
  for (const t of def.extraTools) {
    if (!tools.has(t)) gap(`There is no tool "${t}"; it was left out.`);
    else if (!extraTools.includes(t)) extraTools.push(t);
  }
  def.extraTools = extraTools;

  const askable = new Set(ctx.agentSlugs);
  def.canCommand = def.canCommand.filter((slug) => {
    if (askable.has(slug)) return true;
    gap(`There is no agent "${slug}" for it to ask.`);
    return false;
  });

  // ── Steps: unknown skills and tools out, what steps use added to the agent ────────────────────
  let removed = 0;
  const workflows = input.workflows.map((bw) => {
    const keepStep = (s: Step) => {
      if (s.kind === "skill" && !knownRef(s.skill)) {
        gap(`No skill does "${s.name}" (asked for "${s.skill}").`);
        removed += 1;
        return false;
      }
      if (s.kind === "action" && !tools.has(s.tool)) {
        gap(`No connected tool can "${s.name}" (asked for "${s.tool}").`);
        removed += 1;
        return false;
      }
      return true;
    };
    const steps = mapSteps(filterSteps(bw.workflow.steps, keepStep), (s) =>
      s.kind === "skill" ? { ...s, skill: normalRef(s.skill) } : s,
    );
    return { ...bw, workflow: { ...bw.workflow, steps } };
  });
  for (const ref of unknownListed) {
    if (!gaps.some((g) => g.includes(`"${ref}"`))) {
      gap(`There is no skill "${ref}"; it was left out.`);
    }
  }
  if (removed > 0)
    note(`${plural(removed, "step")} it asked for can't be built yet; see the gaps.`);

  const agentSkillIds = new Set(def.skills.map((s) => parseSkillRef(s.skill).id));
  const allowedTools = new Set(def.extraTools);
  for (const s of def.skills) {
    const d = skillsById.get(parseSkillRef(s.skill).id);
    if (d) for (const t of [...(d.handler ? [d.handler] : []), ...d.tools]) allowedTools.add(t);
  }
  for (const w of workflows) {
    walkSteps(w.workflow, ({ step }) => {
      if (step.kind === "skill" && step.agent === undefined) {
        const id = parseSkillRef(step.skill).id;
        if (!agentSkillIds.has(id)) {
          agentSkillIds.add(id);
          def.skills.push({ skill: step.skill, settings: {} });
        }
      }
      if (step.kind === "action" && !allowedTools.has(step.tool)) {
        allowedTools.add(step.tool);
        def.extraTools.push(step.tool);
      }
    });
  }

  // ── Client: skills that need what the client hasn't connected or enabled ──────────────────────
  if (ctx.client) {
    const connected = new Set(
      ctx.client.connections.filter((c) => c.status !== "disconnected").map((c) => c.connector),
    );
    const packs = new Set(ctx.client.packs);
    for (const s of def.skills) {
      const d = skillsById.get(parseSkillRef(s.skill).id);
      for (const c of d?.requiresConnectors ?? []) {
        if (!connected.has(c))
          gap(`${d?.name} needs a ${c} connection; ${ctx.client.name} has none.`);
      }
      for (const p of d?.requiresPacks ?? []) {
        if (!packs.has(p))
          gap(`${d?.name} needs the ${p} pack; it is not on for ${ctx.client.name}.`);
      }
    }
  }

  // ── Ids ───────────────────────────────────────────────────────────────────────────────────────
  const keep = new Set<string>();
  if (source)
    for (const w of source.workflows) for (const id of workflowNodeIds(w.workflow)) keep.add(id);
  let bundle = assignIds({ ...input, definition: def, workflows }, keep, newId);

  // ── v0.13 W2-H / v0.12 W3-A: a step's model is one the platform prices, never on a tool skill ──
  const models = ctx.models ? new Set(ctx.models) : null;
  let modelsDropped = 0;
  bundle = {
    ...bundle,
    workflows: bundle.workflows.map((bw) => ({
      ...bw,
      workflow: {
        ...bw.workflow,
        steps: mapSteps(bw.workflow.steps, (s) => {
          if (s.kind !== "skill" || s.model === undefined) return s;
          const d = skillsById.get(parseSkillRef(s.skill).id);
          const unknown = models !== null && !models.has(s.model.id);
          if (!unknown && d?.mode !== "tool") return s;
          modelsDropped += 1;
          const { model: _m, ...rest } = s;
          return rest as Step;
        }),
      },
    })),
  };
  if (modelsDropped > 0) {
    note(
      `${plural(modelsDropped, "step")} kept the model ${modelsDropped === 1 ? "its skill or agent" : "their skills or agent"} runs on: the one asked for is unknown, or the skill runs as code.`,
    );
  }

  // ── Approval: on for every write step unless the operator had it off on that step ─────────────
  const typing: TypingContext = {
    tools: Object.fromEntries(ctx.tools.map((t) => [t.id, t])) as Record<string, ToolSpec>,
    skills: Object.fromEntries(
      def.skills.flatMap((s) => {
        const d = skillsById.get(parseSkillRef(s.skill).id);
        return d ? [[s.skill, d] as const] : [];
      }),
    ),
  };
  const before = operatorSource ? stepsOf(operatorSource) : new Map<string, Step>();
  let turnedOn = 0;
  bundle = {
    ...bundle,
    workflows: bundle.workflows.map((bw) => ({
      ...bw,
      workflow: {
        ...bw.workflow,
        steps: mapSteps(bw.workflow.steps, (s) => {
          // v0.12 W3-A: a use step's overrides never switch an inner step's approval off, unless
          // the operator had that same override on that same step.
          if (s.kind === "use_automation" && s.approvals) {
            const was = before.get(s.id);
            const kept = Object.entries(s.approvals).filter(([inner, a]) => {
              if (a.required !== "not_required") return true;
              const prior = was?.kind === "use_automation" ? was.approvals : undefined;
              const same = prior
                ? Object.entries(prior).some(
                    ([k, p]) => k === inner && p.required === "not_required",
                  )
                : false;
              if (!same) turnedOn += 1;
              return same;
            });
            const { approvals: _drop, ...rest } = s;
            return (
              kept.length > 0 ? { ...rest, approvals: Object.fromEntries(kept) } : rest
            ) as Step;
          }
          const approval = approvalOf(s);
          if (approval?.required !== "not_required") return s;
          const was = before.get(s.id);
          const operatorChoice =
            was !== undefined &&
            was.kind === s.kind &&
            approvalOf(was)?.required === "not_required" &&
            (s.kind !== "action" || (was.kind === "action" && was.tool === s.tool));
          const writes = stepWrites(s, typing);
          if (operatorChoice && writes !== undefined && writes.length > 0) return s;
          if (writes !== undefined && writes.length > 0) turnedOn += 1;
          return { ...s, approval: { ...approval, required: "required" } } as Step;
        }),
      },
    })),
  };
  if (turnedOn > 0) {
    note(
      `Approval stays on for ${plural(turnedOn, "step")} that change a client's tool. You can switch it off in the workflow builder where the client's connection allows it.`,
    );
  }

  return { bundle: AgentBundleSchema.parse(bundle), gaps, notes };
}
