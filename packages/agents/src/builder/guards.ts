// The Builder's server guards (ARCHITECTURE §9.6, CLAUDE.md invariants 3 and 8). They hold
// whatever the model answers: a draft's bundle is reshaped here before it is validated and saved,
// and every change the guards make is reported as a gap (a missing capability) or a note (a rule
// the Builder may not break). Wave 3b: the Builder drafts and edits v4 processes (docs/plan.md
// §1.86); a stored v3 version reaches it read through the converter, every id kept.
//
// - Only registered skills and tools: a skill step, read or write step, listed skill or extra
//   tool the registries don't know is removed and listed in `gaps`.
// - New agents are `suggest_only`; a revision keeps the mode of the version it revises.
// - Every step that writes to a client's tool keeps approval on: a new one starts with an approval
//   check, and no approval, sub-process override or conversation's message setting is loosened
//   unless the operator had that same loosening on that same step. The Builder never loosens one.
// - Platform kind, budgets and memory stay the operator's: the Builder makes functional agents.
// - Ids: a new draft's step, path and trigger ids are made here, once (uuid v7); a revision keeps
//   every id of the version it revises and gives new nodes new ids. References follow the ids.

import {
  canonicalJson,
  isPlainObject,
  NEW_AGENT_OVERSIGHT,
  OversightSettings,
  type ProcessAgentBundle,
  ProcessAgentBundle as ProcessAgentBundleSchema,
  parseSkillRef,
  processes,
  type SkillDefinition,
  type ToolSpec,
  type TypingContext,
  uuidv7,
} from "@countersign/core";
import { mapProcessSteps } from "./aliases";
import type { BuilderContext } from "./context";

type Step = processes.Step;
type ApprovalCheck = processes.ApprovalCheck;

export interface GuardOptions {
  /** `draft`: a new agent; `revise`: a new version of `source`. */
  mode: "draft" | "revise";
  /** The version a revision starts from (v3 versions read as processes, ids kept). */
  source?: ProcessAgentBundle;
  /**
   * v0.12 W3-A: in a conversation, the operator's version the session started from (null for a
   * new agent). When given, the operator's rules (mode, budgets, memory, oversight, approvals the
   * operator loosened) follow it, while ids and skill references follow `source`, the working
   * draft, so the guards hold across turns.
   */
  origin?: ProcessAgentBundle | null;
  /** Fresh node ids (uuid v7 by default; tests pass a counter). */
  newId?: () => string;
}

export interface GuardResult {
  bundle: ProcessAgentBundle;
  /** Capabilities the request needs that don't exist (no skill, tool, connector, connection). */
  gaps: string[];
  /** Rules the guards enforced on the model's answer, in plain words. */
  notes: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Every node id of a process, in order: triggers, then steps, paths and otherwise branches. */
export function workflowNodeIds(w: processes.Process): string[] {
  return processes.nodeIds(w);
}

/**
 * `text.replace(/\{\{([^}]*)\}\}/g, (_, inner) => fn(inner))` without the regular expression,
 * which is quadratic on a long run of `{{` with no `}}` (CodeQL js/polynomial-redos). Same
 * matches: from each `{{`, the inner text runs to the first `}`, which must start `}}`.
 */
export function replaceTemplates(text: string, fn: (inner: string) => string): string {
  let out = "";
  let from = 0;
  let at = text.indexOf("{{");
  while (at !== -1) {
    const close = text.indexOf("}", at + 2);
    if (close === -1) break;
    if (text.charCodeAt(close + 1) === 125) {
      out += text.slice(from, at) + fn(text.slice(at + 2, close));
      from = close + 2;
      at = text.indexOf("{{", from);
    } else {
      // Every `{{` before this `}` meets the same lone `}`, so none of them can match.
      at = text.indexOf("{{", close + 1);
    }
  }
  return out + text.slice(from);
}

/** Rewrites `steps.<old>` inside every `{{…}}` of every string under `value`. */
export function rewriteRefs(value: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    if (!value.includes("{{")) return value;
    const ref = /(^|[^A-Za-z0-9_.])steps\.([A-Za-z0-9][A-Za-z0-9_-]*)/g;
    return replaceTemplates(
      value,
      (inner) =>
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
  bundle: ProcessAgentBundle,
  keep: ReadonlySet<string>,
  newId: () => string,
): ProcessAgentBundle {
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
    // v0.12 W3-A: every trigger's id follows the same rule.
    const triggers = bw.workflow.triggers.map((t) => ({ ...t, id: take(t.id) }));
    const steps = mapProcessSteps(bw.workflow.steps, take);
    let slug = bw.slug;
    for (let n = 2; slugs.has(slug); n += 1) slug = `${bw.slug}-${n}`;
    slugs.add(slug);
    const workflow = rewriteRefs({ ...bw.workflow, triggers, steps }, map) as typeof bw.workflow;
    return { ...bw, slug, workflow };
  });
  return { ...bundle, workflows };
}

/** Every step list, depth first, dropping steps `keep` refuses. */
function filterSteps(steps: readonly Step[], keepStep: (s: Step) => boolean): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    if (!keepStep(s)) continue;
    if (s.kind === "if") {
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
function mapSteps(steps: readonly Step[], fn: (s: Step) => Step): Step[] {
  return steps.map((s) => {
    if (s.kind === "if") {
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

/** Every process of the bundle with `fn` applied to each step. */
function mapBundleSteps(bundle: ProcessAgentBundle, fn: (s: Step) => Step): ProcessAgentBundle {
  return {
    ...bundle,
    workflows: bundle.workflows.map((bw) => ({
      ...bw,
      workflow: { ...bw.workflow, steps: mapSteps(bw.workflow.steps, fn) },
    })),
  };
}

function stepsOf(bundle: ProcessAgentBundle): Map<string, Step> {
  const out = new Map<string, Step>();
  for (const w of bundle.workflows) {
    processes.walkSteps(w.workflow, ({ step }) => out.set(step.id, step));
  }
  return out;
}

/** The same step in the operator's version: same id, same kind, and a read or write's same tool. */
function sameStep(was: Step | undefined, s: Step): Step | undefined {
  if (!was || was.kind !== s.kind) return undefined;
  if ((s.kind === "write" || s.kind === "read") && "tool" in was && was.tool !== s.tool) {
    return undefined;
  }
  return was;
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** A new step's approval: on, the default approver, stopping when nobody answers (invariant 8). */
// DECISION: as the workflow builder's `createStep`: a Builder step that writes to a client's tool
// or reaches people starts with an explicit approval check, so the draft says what it does.
export const DEFAULT_APPROVAL: ApprovalCheck = {
  required: "required",
  mode: "in_turn",
  ifNoAnswer: "stop",
  onReject: "stop",
};

/**
 * The answer's approval with every loosening the operator's (`prior`) didn't have taken out: a
 * switched-off approval, a `when`, going ahead when nobody answers (the approval's own or an
 * approver's deadline). What the operator had, on that same step, stays.
 */
function holdApproval(answer: ApprovalCheck, prior: ApprovalCheck | undefined): ApprovalCheck {
  const tight = processes.tightenedApproval(answer);
  const out: ApprovalCheck = { ...answer };
  if (answer.required === "not_required" && prior?.required !== "not_required") {
    out.required = "required";
  }
  if (answer.when !== undefined && !same(answer.when, prior?.when)) delete out.when;
  if (!same(answer.ifNoAnswer, prior?.ifNoAnswer)) out.ifNoAnswer = tight.ifNoAnswer;
  if (answer.approvers) {
    out.approvers = answer.approvers.map((a, i) =>
      same(a, prior?.approvers?.[i]) ? a : (tight.approvers?.[i] ?? a),
    );
  }
  return out;
}

/** Applies every guard to the model's bundle (already through Zod). */
export function guardBundle(
  input: ProcessAgentBundle,
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
      processes.walkSteps(w.workflow, ({ step }) => {
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

  const skillList: ProcessAgentBundle["definition"]["skills"] = [];
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
      if ((s.kind === "read" || s.kind === "write") && !tools.has(s.tool)) {
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
    processes.walkSteps(w.workflow, ({ step }) => {
      if (step.kind === "skill" && step.agent === undefined) {
        const id = parseSkillRef(step.skill).id;
        if (!agentSkillIds.has(id)) {
          agentSkillIds.add(id);
          def.skills.push({ skill: step.skill, settings: {} });
        }
      }
      if ((step.kind === "read" || step.kind === "write") && !allowedTools.has(step.tool)) {
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
  bundle = mapBundleSteps(bundle, (s) => {
    if (s.kind !== "skill" || s.model === undefined) return s;
    const d = skillsById.get(parseSkillRef(s.skill).id);
    const unknown = models !== null && !models.has(s.model.id);
    if (!unknown && d?.mode !== "tool") return s;
    modelsDropped += 1;
    const { model: _m, ...rest } = s;
    return rest as Step;
  });
  if (modelsDropped > 0) {
    note(
      `${plural(modelsDropped, "step")} kept the model ${modelsDropped === 1 ? "its skill or agent" : "their skills or agent"} runs on: the one asked for is unknown, or the skill runs as code.`,
    );
  }

  // ── Approval (invariant 8): on, unless the operator had that same loosening on that step ──────
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
  bundle = mapBundleSteps(bundle, (s) => {
    const was = sameStep(before.get(s.id), s);
    let next = s;
    // A new step that changes a client's tool or reaches people starts with approval on.
    if (!keep.has(s.id) && next.checks?.approval === undefined) {
      const writes = processes.stepWrites(next, typing);
      const reaches =
        next.kind === "skill" &&
        skillsById.get(parseSkillRef(next.skill).id)?.reachesPeople === true;
      if ((next.kind === "write" && writes === undefined) || (writes?.length ?? 0) > 0 || reaches) {
        next = { ...next, checks: { ...next.checks, approval: DEFAULT_APPROVAL } };
      }
    }
    const approval = next.checks?.approval;
    if (approval && processes.approvalLoosenings(approval, "a").length > 0) {
      const held = holdApproval(approval, was?.checks?.approval);
      if (!same(held, approval)) {
        turnedOn += 1;
        next = { ...next, checks: { ...next.checks, approval: held } };
      }
    }
    // v0.12 W3-A: a process step's overrides never loosen an inner step's approval, unless the
    // operator had that same override on that same step.
    if (next.kind === "process" && next.approvals) {
      const prior = was?.kind === "process" ? was.approvals : undefined;
      const kept = Object.entries(next.approvals).filter(([inner, a]) => {
        if (processes.approvalLoosenings(a, "a").length === 0) return true;
        const ok = prior !== undefined && Object.hasOwn(prior, inner) && same(prior[inner], a);
        if (!ok) turnedOn += 1;
        return ok;
      });
      const { approvals: _drop, ...rest } = next;
      next = (kept.length > 0 ? { ...rest, approvals: Object.fromEntries(kept) } : rest) as Step;
    }
    // A conversation's messages wait for a person unless the operator had them go without.
    if (next.kind === "conversation") {
      const prior = was?.kind === "conversation" ? was.messages : undefined;
      const first =
        next.messages.first === "not_required" && prior?.first !== "not_required"
          ? "required"
          : next.messages.first;
      const later =
        next.messages.later === "within_goal" && prior?.later !== "within_goal"
          ? "required"
          : next.messages.later;
      if (first !== next.messages.first || later !== next.messages.later) {
        turnedOn += 1;
        next = { ...next, messages: { first, later } };
      }
    }
    return next;
  });
  if (turnedOn > 0) {
    note(
      `Approval stays on for ${plural(turnedOn, "step")} that change a client's tool. You can switch it off in the workflow builder where the client's connection allows it.`,
    );
  }

  return { bundle: ProcessAgentBundleSchema.parse(bundle) as ProcessAgentBundle, gaps, notes };
}
