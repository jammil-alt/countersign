// The Builder's server guards (ARCHITECTURE §9.6, CLAUDE.md invariants 3 and 8). They hold
// whatever the model answers: a draft's bundle is reshaped here before it is validated and saved,
// and every change the guards make is reported as a gap (a missing capability) or a note (a rule
// the Builder may not break). Wave 3b: the Builder drafts and edits v4 processes (docs/plan.md
// §1.86); a stored v3 version reaches it read through the converter, every id kept.
//
// - Only registered skills and tools: a listed skill or extra tool the registries don't know is
//   removed and listed in `gaps`. v0.18: a skill, read or write step on one becomes a missing step
//   in its place (same id and name), so the canvas shows the hole (docs/plan.md §1.103).
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
  STEP_PURPOSE_MAX,
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
  /**
   * What the model should fix in its repair round although validation doesn't block on it (a
   * workflow that copies another's steps), one plain sentence each. Each is in `notes` too.
   */
  fix: string[];
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
    // v0.17: `loop.previous.<id>` names a step inside a repeat, as `steps.<id>` does.
    const ref = /(^|[^A-Za-z0-9_.])(steps|loop\.previous)\.([A-Za-z0-9][A-Za-z0-9_-]*)/g;
    return replaceTemplates(
      value,
      (inner) =>
        `{{${inner.replace(ref, (m, pre: string, root: string, id: string) => {
          const to = map.get(id);
          return to ? `${pre}${root}.${to}` : m;
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
  const maps = new Map<string, Map<string, string>>();
  const mapped = bundle.workflows.map((bw) => {
    const map = new Map<string, string>();
    if (!maps.has(bw.slug)) maps.set(bw.slug, map);
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
  // Ways in, ways out (2026-11-23): a hand-off into another workflow of this agent ("@self") names
  // a step of that workflow by id, so it follows that workflow's ids.
  const workflows = mapped.map((bw) => ({
    ...bw,
    workflow: {
      ...bw.workflow,
      steps: mapSteps(bw.workflow.steps, (s) => {
        if (s.kind !== "handoff") return s;
        const to = s.to as { agent: string; step: string; workflow?: string };
        if (to.agent !== processes.SELF_AGENT || to.workflow === undefined) return s;
        const step = maps.get(to.workflow)?.get(to.step);
        return step === undefined ? s : ({ ...s, to: { ...to, step } } as Step);
      }),
    },
  }));
  return { ...bundle, workflows };
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
    if (s.kind === "for_each" || s.kind === "repeat") {
      return fn({ ...s, steps: mapSteps(s.steps, fn) });
    }
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

/**
 * The same step in the operator's version: same id and kind, and it still does the same thing: a
 * read's or write's tool, a write's action and connector (`via`), a skill step's skill (by id) and
 * the agent that runs it, a process step's process. A loosening set on a step is for what that
 * step did then (invariant 8): when the model keeps the id but changes what it does, it is a
 * different step and its approval starts on again.
 */
// DECISION (AI-1): a skill step compares its skill by id, not by pinned version, as a revision may
// keep a pin (`normalRef`); a process step compares its whole `slug@version` ref, since its
// `approvals` overrides name the inner steps of that version.
function sameStep(was: Step | undefined, s: Step): Step | undefined {
  if (!was || was.kind !== s.kind) return undefined;
  if (s.kind === "read" && was.kind === "read" && was.tool !== s.tool) return undefined;
  if (
    s.kind === "write" &&
    was.kind === "write" &&
    (was.tool !== s.tool || was.action !== s.action || was.via !== s.via)
  ) {
    return undefined;
  }
  if (
    s.kind === "skill" &&
    was.kind === "skill" &&
    (parseSkillRef(was.skill).id !== parseSkillRef(s.skill).id || was.agent !== s.agent)
  ) {
    return undefined;
  }
  if (s.kind === "process" && was.kind === "process" && was.process !== s.process) {
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
export function holdApproval(
  answer: ApprovalCheck,
  prior: ApprovalCheck | undefined,
): ApprovalCheck {
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

/** The bundle-level rules a revision's or a draft's source decides (`guardDefinition`). */
type DefinitionSource = { definition: ProcessAgentBundle["definition"] } | null | undefined;

/**
 * The agent's own rules, whatever the model answered (shared by the v4 and step-model guards):
 * functional kind; the mode of the operator's version (`suggest_only` for a new agent); budgets and
 * memory as the operator set them; oversight as the operator set it, or on failures for a new
 * agent. Returns a copy.
 */
export function guardDefinition<D extends ProcessAgentBundle["definition"]>(
  input: D,
  sources: { operatorSource: DefinitionSource; source: DefinitionSource },
  note: (text: string) => void,
): D {
  const { operatorSource, source } = sources;
  const def = structuredClone(input);
  if (def.kind !== "functional") {
    def.kind = "functional";
    note("The Builder makes functional agents; platform agents are seeded.");
  }
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
  // Step model §10f: what an agent may read, create and change in our own records (its grants and
  // data sets) is the operator's, as its mode is: a draft keeps the operator's version's exactly,
  // and a new agent from the Builder is granted nothing (invariant 9).
  const data = operatorSource?.definition.data;
  if (JSON.stringify(def.data ?? null) !== JSON.stringify(data ?? null)) {
    note("Its data sets stay as you set them: the Builder doesn't change what an agent may reach.");
  }
  if (data === undefined) delete def.data;
  else def.data = structuredClone(data);
  return def;
}

/** Applies every guard to the model's bundle (already through Zod). */
/**
 * A step's purpose as its SOP shows it (staging, 2026-11-25): plain words, at most
 * `STEP_PURPOSE_MAX`. The model's answer is checked with short ids; a `{{steps.s6…}}` written in a
 * purpose then grows by an id's length per mention as the ids are put back, and the bundle failed
 * to parse after the model had answered. A reference means nothing in prose, so it is taken out;
 * a purpose still too long is cut at its last sentence or word that fits. Null when nothing is left.
 */
// DECISION: cut, not sent back to repair: the purpose is one line of the SOP, the operator edits
// it in the step panel, and a repair round would cost the turn a second model call.
export function plainPurpose(text: string): string | null {
  const plain = text
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/\s+([,.;:)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!plain) return null;
  if (plain.length <= STEP_PURPOSE_MAX) return plain;
  const room = plain.slice(0, STEP_PURPOSE_MAX);
  const sentence = room.lastIndexOf(". ");
  if (sentence >= STEP_PURPOSE_MAX / 2) return room.slice(0, sentence + 1);
  const word = room.slice(0, STEP_PURPOSE_MAX - 1).lastIndexOf(" ");
  return `${room.slice(0, word > 0 ? word : STEP_PURPOSE_MAX - 1).replace(/[\s,;:]+$/, "")}…`;
}

/** Every step's purpose made plain (`plainPurpose`), anywhere in a workflow's steps. */
function plainPurposes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainPurposes);
  if (!isPlainObject(value)) return value;
  const isStep = typeof value.id === "string" && typeof value.kind === "string";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (isStep && k === "purpose" && typeof v === "string") {
      const purpose = plainPurpose(v);
      if (purpose) out[k] = purpose;
    } else if (k !== "input") {
      out[k] = plainPurposes(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

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
  // v0.12 W3-A: in a conversation the operator's rules follow the version it started from (none for
  // a new agent), whatever earlier turns made of the working draft.
  const operatorSource = options.origin !== undefined ? options.origin : source;
  const def = guardDefinition(input.definition, { operatorSource, source }, note);

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

  // ── Steps: unknown skills and tools held as missing steps, what steps use added to the agent ──
  // v0.18: a step on a skill or tool that doesn't exist becomes a missing step in its place, with
  // the same id and name, rather than being left out; its need says what was asked for.
  let held = 0;
  const placed = new Set<string>();
  const workflows = input.workflows.map((bw) => {
    const hold = (s: Step): Step => {
      let need: string | null = null;
      let fill: processes.MissingFill = "skill";
      if (s.kind === "skill" && !knownRef(s.skill)) {
        need = `No skill does this yet (asked for "${s.skill}").`;
        placed.add(s.skill);
      } else if (
        // Skill model: an action write step names no tool; it resolves from the agent's bindings.
        (s.kind === "read" || s.kind === "write") &&
        s.tool !== undefined &&
        !tools.has(s.tool)
      ) {
        need = `No connected tool can do this yet (asked for "${s.tool}").`;
        fill = "tool";
      }
      if (need === null) return s;
      held += 1;
      return {
        id: s.id,
        kind: "missing",
        name: s.name,
        need: need.slice(0, processes.MISSING_NEED_MAX),
        fill,
      };
    };
    const steps = mapSteps(bw.workflow.steps, (s) =>
      s.kind === "skill" && knownRef(s.skill) ? { ...s, skill: normalRef(s.skill) } : hold(s),
    );
    return { ...bw, workflow: { ...bw.workflow, steps } };
  });
  for (const ref of unknownListed) {
    if (!placed.has(ref) && !gaps.some((g) => g.includes(`"${ref}"`))) {
      gap(`There is no skill "${ref}"; it was left out.`);
    }
  }
  if (held > 0)
    note(
      `${plural(held, "step")} it asked for can't be built yet; ${held === 1 ? "it is" : "they are"} on the canvas as missing.`,
    );

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
      if (
        (step.kind === "read" || step.kind === "write") &&
        step.tool !== undefined &&
        !allowedTools.has(step.tool)
      ) {
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
          // Owner, 2026-11-24: it comes on by itself when the agent is turned on for the client.
          gap(
            `${d?.name} needs the ${p} pack, off for ${ctx.client.name}: it comes on when the agent is turned on, or switch it on from What's left to try it before then.`,
          );
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
  const revised = source ? stepsOf(source) : new Map<string, Step>();
  let turnedOn = 0;
  bundle = mapBundleSteps(bundle, (s) => {
    const was = sameStep(before.get(s.id), s);
    let next = s;
    // A new step that changes a client's tool or reaches people starts with approval on; so does
    // a kept id the model made do something else (a read turned into a write, another action).
    const fresh = !keep.has(s.id) || sameStep(revised.get(s.id), s) === undefined;
    if (fresh && next.checks?.approval === undefined) {
      const writes = processes.stepWrites(next, typing);
      // Collect reports (2026-11-24): its links reach each report's owner, so it starts with
      // approval on as a reach-out does.
      const reaches =
        next.kind === "collect" ||
        (next.kind === "skill" &&
          skillsById.get(parseSkillRef(next.skill).id)?.reachesPeople === true);
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

  // ── Ways in, ways out (owner, 2026-11-23): never the same steps in two workflows ───────────────
  // DECISION: the test is core's `copiedSteps` (3 steps in a row, 2 of them calling something),
  // the same one the chart's advice uses. Only a copy this answer made goes back to the model; one
  // the version it revises already had is the operator's (the chart shows it), as with `known`.
  const fix: string[] = [];
  const copiesOf = (b: ProcessAgentBundle) =>
    processes.copiedSteps(b.workflows.filter((w) => w.enabled !== false));
  const keyOf = (r: processes.CopiedRun) => `${r.from}|${r.in}|${r.stepIds.join(",")}`;
  const had = new Set((source ? copiesOf(source) : []).map(keyOf));
  for (const run of copiesOf(bundle)) {
    if (had.has(keyOf(run))) continue;
    const text = `${processes.copiedStepsMessage(run)}.`;
    note(text);
    if (!fix.includes(text)) fix.push(text);
  }

  return {
    bundle: ProcessAgentBundleSchema.parse({
      ...bundle,
      workflows: bundle.workflows.map((w) => ({ ...w, workflow: plainPurposes(w.workflow) })),
    }) as ProcessAgentBundle,
    gaps,
    notes,
    fix,
  };
}
