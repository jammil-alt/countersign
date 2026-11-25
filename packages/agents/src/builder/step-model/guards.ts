// The Builder's server guards in the step model (docs/step-model-plan.md §10, build item 9;
// invariants 3, 8, 9, 11). They hold whatever the model answers, as the v4 guards (`../guards`) do
// for processes: a draft's v5 bundle is reshaped here before it is validated and saved, and every
// change is reported as a gap (a missing capability), a note (a rule the Builder may not break), or
// a fix (what its repair round should put right).
//
// - The agent's own rules (kind, mode, budgets, memory, oversight): `guardDefinition`, shared.
// - Only parts the catalog has: a Do on an action, a skill, a match profile or an automation that
//   doesn't exist becomes a "Not built yet" step in its place (same id and name). A Loop keeps only
//   the Get actions the catalog has; a saved Loop it doesn't know is written in the step instead.
// - A Match is held to its profile: the match types and keys the profile allows, so Vendor items
//   are exact on SKU only (the profile says so; nothing here names a pack, invariant 2).
// - Approval (invariant 8): every new Do that changes a client's tool or sends a message, and every
//   write output, starts with approval on; no approval, contact's messages or person's sign-off is
//   loosened unless the operator had that same loosening on that same step.
// - Untrusted text stays data (invariant 9): a reference to earlier steps inside AI instructions or
//   a Loop's goal moves into the step's input, so text from documents reaches the model only there.
// - A template holds nothing of one client (invariant 11): record ids, emails and phone numbers
//   are taken out of a template's steps and outputs (`holdsClientLiteral`).
// - Ids: a new draft's ids are made here, once (uuid v7); a revision keeps every id of the version
//   it revises and gives new nodes new ids (invariant 3). References follow the ids.

import {
  isPlainObject,
  parseSkillRef,
  processes,
  type SkillDefinition,
  steps,
  uuidv7,
} from "@countersign/core";
import { holdsClientLiteral } from "../../registry/lineage";
import type { BuilderContext } from "../context";
import { DEFAULT_APPROVAL, guardDefinition, holdApproval, rewriteRefs } from "../guards";
import { StepAgentBundle } from "./answer";
import { actionKinds, doSkills, offeredActions, skillDoneBy } from "./catalog";

type Step = steps.Step;
type DoStep = steps.DoStep;

export interface StepGuardOptions {
  /** `draft`: a new agent; `revise`: a new version of `source`. */
  mode: "draft" | "revise";
  /** The version a revision starts from. */
  source?: StepAgentBundle;
  /**
   * In a conversation, the operator's version it started from (null for a new agent): the
   * operator's rules follow it, while ids and references follow `source`, the working draft.
   */
  origin?: StepAgentBundle | null;
  /** Fresh node ids (uuid v7 by default; tests pass a counter). */
  newId?: () => string;
}

export interface StepGuardResult {
  bundle: StepAgentBundle;
  gaps: string[];
  notes: string[];
  /** What the repair round should fix although validation doesn't block on it. */
  fix: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── Walking ────────────────────────────────────────────────────────────────────────────────────

/** Applies `fn` to every step (containers after their children), returning new lists. */
export function mapSteps(list: readonly Step[], fn: (s: Step) => Step): Step[] {
  return list.map((s) => {
    if (s.kind === "fork") {
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

function mapBundle(bundle: StepAgentBundle, fn: (s: Step) => Step): StepAgentBundle {
  return {
    ...bundle,
    workflows: bundle.workflows.map((w) => ({
      ...w,
      workflow: { ...w.workflow, steps: mapSteps(w.workflow.steps, fn) },
    })),
  };
}

function stepsOf(bundle: Pick<StepAgentBundle, "workflows"> | null | undefined): Map<string, Step> {
  const out = new Map<string, Step>();
  for (const w of bundle?.workflows ?? []) {
    steps.eachStep(w.workflow.steps, ({ step }) => out.set(step.id, step));
  }
  return out;
}

function outputsOf(
  bundle: Pick<StepAgentBundle, "workflows"> | null | undefined,
): Map<string, steps.WorkflowOutput> {
  const out = new Map<string, steps.WorkflowOutput>();
  for (const w of bundle?.workflows ?? []) for (const o of w.workflow.outputs) out.set(o.id, o);
  return out;
}

/** Every node id of a bundle: triggers, outputs, steps, Fork paths and otherwise. */
export function stepBundleIds(bundle: Pick<StepAgentBundle, "workflows">): Set<string> {
  const out = new Set<string>();
  for (const w of bundle.workflows) for (const id of steps.stepModelIds(w.workflow)) out.add(id);
  return out;
}

// ── Ids ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Gives every node an id: one `keep` holds stays (once), any other gets `newId()`. References follow:
 * `{{steps.<id>…}}` in every string, an End's outputs, and a hand-off to another workflow of this
 * agent ("@self"), which names a step of that workflow.
 */
export function assignStepIds(
  bundle: StepAgentBundle,
  keep: ReadonlySet<string>,
  newId: () => string,
): StepAgentBundle {
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
    const triggers = bw.workflow.triggers.map((t) => ({ ...t, id: take(t.id) }));
    const outputs = bw.workflow.outputs.map((o) => ({ ...o, id: take(o.id) }));
    const renumber = (list: readonly Step[]): Step[] =>
      list.map((s) => {
        const id = take(s.id);
        if (s.kind === "fork") {
          return {
            ...s,
            id,
            paths: s.paths.map((p) => ({ ...p, id: take(p.id), steps: renumber(p.steps) })),
            otherwise: { id: take(s.otherwise.id), steps: renumber(s.otherwise.steps) },
          };
        }
        if (s.kind === "for_each" || s.kind === "repeat") {
          return { ...s, id, steps: renumber(s.steps) };
        }
        return { ...s, id };
      });
    const stepList = renumber(bw.workflow.steps);
    let slug = bw.slug;
    for (let n = 2; slugs.has(slug); n += 1) slug = `${bw.slug}-${n}`;
    slugs.add(slug);
    const workflow = rewriteRefs(
      { ...bw.workflow, triggers, outputs, steps: stepList },
      map,
    ) as steps.Workflow;
    const ends = mapSteps(workflow.steps, (s) =>
      s.kind === "end" ? { ...s, outputs: s.outputs.map((o) => map.get(o) ?? o) } : s,
    );
    return { ...bw, slug, workflow: { ...workflow, steps: ends } };
  });
  const selfStep = (agent: string, workflow: string | undefined, step: string) =>
    agent === processes.SELF_AGENT && workflow !== undefined
      ? (maps.get(workflow)?.get(step) ?? step)
      : step;
  return {
    ...bundle,
    workflows: mapped.map((bw) => ({
      ...bw,
      workflow: {
        ...bw.workflow,
        outputs: bw.workflow.outputs.map((o) =>
          o.handoff
            ? {
                ...o,
                handoff: {
                  ...o.handoff,
                  step: selfStep(o.handoff.agent, o.handoff.workflow, o.handoff.step),
                },
              }
            : o,
        ),
        steps: mapSteps(bw.workflow.steps, (s) =>
          s.kind === "handoff" && s.to.step !== ""
            ? { ...s, to: { ...s.to, step: selfStep(s.to.agent, s.to.workflow, s.to.step) } }
            : s,
        ),
      },
    })),
  };
}

// ── Steps the same as the operator's ───────────────────────────────────────────────────────────

/**
 * The same step in the operator's version: same id and kind, and it still does the same thing (a
 * Do's done by, what it uses, the agent that runs it; a Loop's saved Loop). A loosening set on a
 * step is for what that step did then (invariant 8): when the model keeps the id but changes what
 * it does, it is a different step and its approval starts on again.
 */
function sameStep(was: Step | undefined, s: Step): Step | undefined {
  if (!was || was.kind !== s.kind) return undefined;
  if (s.kind === "do" && was.kind === "do") {
    if (was.doneBy !== s.doneBy || was.agent !== s.agent) return undefined;
    if (usesKey(was.uses) !== usesKey(s.uses)) return undefined;
  }
  if (s.kind === "loop" && was.kind === "loop") {
    const id = (ref?: string) => (ref === undefined ? "" : parseSkillRef(ref).id);
    if (id(was.skill) !== id(s.skill)) return undefined;
  }
  return was;
}

function usesKey(uses: steps.Uses | undefined): string {
  if (!uses) return "";
  switch (uses.type) {
    case "action":
      return `action:${uses.action}`;
    case "skill":
      return `skill:${parseSkillRef(uses.skill).id}`;
    case "automation":
      return `automation:${uses.automation}`;
    case "match":
      return `match:${uses.match.to}`;
    default:
      return uses.type;
  }
}

/** A deadline with "nobody answered" never going ahead, unless `prior` went ahead the same way. */
function holdDeadline(
  d: processes.Deadline,
  prior: processes.Deadline | undefined,
): processes.Deadline {
  if (canonical(d.ifNoAnswer) === canonical(prior?.ifNoAnswer)) return d;
  const tight = processes.tightenedApproval({ ...DEFAULT_APPROVAL, ifNoAnswer: d.ifNoAnswer });
  return { ...d, ifNoAnswer: tight.ifNoAnswer };
}

const canonical = (v: unknown) => JSON.stringify(v ?? null);

// ── Untrusted text stays data (invariant 9) ────────────────────────────────────────────────────

const REF_IN_TEXT = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Text with its `{{references}}` moved into `input`: each becomes an input field (one that already
 * holds that reference keeps its name) and the text names the field instead. Returns the count.
 */
export function refsToInput(
  text: string,
  input: Record<string, unknown>,
): { text: string; input: Record<string, unknown>; moved: number } {
  let moved = 0;
  const next = { ...input };
  const out = text.replace(REF_IN_TEXT, (_m, inner: string) => {
    const ref = `{{${inner}}}`;
    // A Loop's or AI's own input is named as it is.
    if (inner.startsWith("input.")) return `the "${inner.slice(6)}" input`;
    moved += 1;
    const existing = Object.entries(next).find(([, v]) => v === ref)?.[0];
    if (existing) return `the "${existing}" input`;
    const last = inner
      .split(".")
      .filter((p) => /^[A-Za-z][A-Za-z0-9_]*$/.test(p))
      .at(-1);
    const base = (last ?? "value").slice(0, 60);
    let name = base;
    for (let n = 2; Object.hasOwn(next, name); n += 1) name = `${base}${n}`;
    next[name] = ref;
    return `the "${name}" input`;
  });
  return { text: out, input: next, moved };
}

// ── A template holds nothing of one client (invariant 11) ──────────────────────────────────────

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// The phone numbers `holdsClientLiteral` counts: E.164, (555) 123-4567 and 1-555-123-4567; a bare
// 555-123-4567 is a part or account number as often as a phone number.
const PHONE =
  /\+[1-9]\d{7,14}(?!\d)|(?:\+?1[\s.-]?)?\(\d{3}\)\s?\d{3}[\s.-]\d{4}|\+?1[\s.-]\d{3}[\s.-]\d{3}[\s.-]\d{4}/g;
const REF_SPLIT = /(\{\{[^{}]*\}\})/;

/** A string with the client's literals outside `{{refs}}` taken out; null when it held none. */
function scrubText(text: string): string | null {
  if (!holdsClientLiteral(text)) return null;
  const parts = text
    .split(REF_SPLIT)
    .map((part) =>
      part.startsWith("{{")
        ? part
        : part.replace(UUID, "").replace(EMAIL, "").replace(PHONE, "").replace(/ {2,}/g, " "),
    );
  let out = parts.join("").trim();
  if (holdsClientLiteral(out)) out = "";
  // A person named by id or address ("user:<id>") is the client's admin in a template.
  if (out === "" || /^[a-z_]+:$/.test(out)) return "client_admin";
  return out;
}

/**
 * Every string under `value` with the client's literals taken out, except the node ids `ids` (a
 * revision keeps uuid ids) and an action's or skill's id. Counts what it took out.
 */
function scrubLiterals(value: unknown, ids: ReadonlySet<string>, count: { n: number }): unknown {
  if (typeof value === "string") {
    if (ids.has(value)) return value;
    const out = scrubText(value);
    if (out === null) return value;
    count.n += 1;
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => scrubLiterals(v, ids, count));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === "uses" ? v : scrubLiterals(v, ids, count)]),
    );
  }
  return value;
}

// ── The guard ──────────────────────────────────────────────────────────────────────────────────

/** Applies every guard to the model's v5 bundle (already through Zod). */
export function guardStepBundle(
  input: StepAgentBundle,
  ctx: BuilderContext,
  options: StepGuardOptions,
): StepGuardResult {
  const gaps: string[] = [];
  const notes: string[] = [];
  const fix: string[] = [];
  const gap = (text: string) => {
    if (!gaps.includes(text)) gaps.push(text);
  };
  const note = (text: string) => {
    if (!notes.includes(text)) notes.push(text);
  };
  const ask = (text: string) => {
    note(text);
    if (!fix.includes(text)) fix.push(text);
  };
  const source = options.mode === "revise" ? options.source : undefined;
  const operatorSource = options.origin !== undefined ? options.origin : source;
  const newId = options.newId ?? (() => uuidv7());

  const kinds = actionKinds(ctx);
  const tools = new Map(ctx.tools.map((t) => [t.id, t]));
  const skillsById = new Map<string, SkillDefinition>();
  for (const s of doSkills(ctx)) skillsById.set(parseSkillRef(s.ref).id, s.definition);
  const loopsById = new Map<string, SkillDefinition>();
  for (const s of ctx.stepModel?.loops ?? []) loopsById.set(parseSkillRef(s.ref).id, s.definition);
  const profiles = ctx.stepModel ? new Map(ctx.stepModel.profiles.map((p) => [p.id, p])) : null;
  const automations = new Set((ctx.automations ?? []).map((a) => a.ref));

  // What the version it revises already names may stay (pinned skills, an action since hidden).
  const sourceRefs = new Set<string>();
  const sourceActions = new Set<string>();
  const sourceAutomations = new Set<string>();
  if (source) {
    for (const s of source.definition.skills) sourceRefs.add(s.skill);
    for (const w of source.workflows) {
      for (const ref of steps.stepModelSkills(w.workflow)) sourceRefs.add(ref);
      for (const a of steps.stepModelActions(w.workflow)) sourceActions.add(a);
      steps.eachStep(w.workflow.steps, ({ step }) => {
        if (step.kind === "do" && step.uses?.type === "automation") {
          sourceAutomations.add(step.uses.automation);
        }
      });
    }
  }
  const knownSkill = (ref: string) => sourceRefs.has(ref) || skillsById.has(parseSkillRef(ref).id);
  const knownLoop = (ref: string) => sourceRefs.has(ref) || loopsById.has(parseSkillRef(ref).id);
  /** New references name the skill, not a version: pins come from the operator. */
  const normalRef = (ref: string) => (sourceRefs.has(ref) ? ref : parseSkillRef(ref).id);
  const offered = offeredActions(ctx);
  const knownAction = (id: string) => offered.has(id) || sourceActions.has(id);
  const kindOf = (id: string): steps.ActionKind => kinds.get(id) ?? "change";

  // ── Definition ──────────────────────────────────────────────────────────────────────────────
  const def = guardDefinition(input.definition, { operatorSource, source }, note);
  const askable = new Set(ctx.agentSlugs);
  def.canCommand = def.canCommand.filter((slug) => {
    if (askable.has(slug)) return true;
    gap(`There is no agent "${slug}" for it to ask.`);
    return false;
  });

  // ── Template: nothing of one client (invariant 11) ──────────────────────────────────────────
  let bundle: StepAgentBundle = { ...input, definition: def };
  if (!ctx.client) {
    const ids = new Set([...stepBundleIds(bundle), ...(source ? stepBundleIds(source) : [])]);
    const count = { n: 0 };
    bundle = {
      ...bundle,
      definition: {
        ...bundle.definition,
        instructions: scrubLiterals(bundle.definition.instructions, ids, count) as string,
      },
      workflows: bundle.workflows.map((w) => ({
        ...w,
        workflow: scrubLiterals(w.workflow, ids, count) as steps.Workflow,
      })),
    };
    if (count.n > 0) {
      ask(
        `A template holds nothing of one client: ${plural(count.n, "place")} named a record, an email address or a phone number and ${count.n === 1 ? "was" : "were"} taken out. Name people by seat ("seat:<role>") or client_admin, and records by the trigger's or a step's fields.`,
      );
    }
  }

  // ── Parts the catalog doesn't have: "Not built yet" in their place ──────────────────────────
  let held = 0;
  let movedRefs = 0;
  let loopWrites = 0;
  const notBuilt = (s: DoStep, need: string, fill: "skill" | "tool" | "connector"): DoStep => {
    held += 1;
    const { rules: _r, ai: _a, person: _p, collect: _c, contact: _ct, tell: _t, ...rest } = s;
    const { doneBy: _d, output: _o, ...kept } = rest;
    return {
      ...kept,
      uses: { type: "missing", need: need.slice(0, processes.MISSING_NEED_MAX), fill },
    };
  };
  const models = ctx.models ? new Set(ctx.models) : null;
  let modelsDropped = 0;

  const guardDo = (s: DoStep): Step => {
    let step: DoStep = s;
    const uses = step.uses;
    if (uses?.type === "action" && !knownAction(uses.action)) {
      return notBuilt(step, `No action does this yet (asked for "${uses.action}").`, "tool");
    }
    if (uses?.type === "skill") {
      const id = parseSkillRef(uses.skill).id;
      const loop = loopsById.get(id);
      if (loop && !skillsById.has(id)) {
        // A saved Loop is a Loop step's (§8): the step becomes one, with the Loop's own settings.
        return {
          id: step.id,
          kind: "loop",
          name: step.name,
          ...(step.purpose ? { purpose: step.purpose } : {}),
          ...(step.client ? { client: step.client } : {}),
          skill: normalRef(uses.skill),
          goal: loop.loop?.goal ?? step.name,
          input: step.input,
          output: [],
          reads: loop.reads ?? [],
          instructions: "",
          maxTurns: loop.loop?.maxTurns ?? 10,
          atLimit: loop.loop?.atLimit ?? "stop",
        };
      }
      if (!knownSkill(uses.skill)) {
        return notBuilt(step, `No skill does this yet (asked for "${uses.skill}").`, "skill");
      }
      const def = skillsById.get(id);
      const doneBy = def ? skillDoneBy(def, ctx) : step.doneBy;
      step = {
        ...step,
        uses: { type: "skill", skill: normalRef(uses.skill) },
        ...(doneBy ? { doneBy } : {}),
      };
    }
    if (uses?.type === "automation" && !automations.has(uses.automation)) {
      if (!sourceAutomations.has(uses.automation)) {
        return notBuilt(
          step,
          `No automation does this yet (asked for "${uses.automation}").`,
          "skill",
        );
      }
    }
    if (uses?.type === "match" && profiles) {
      const profile = profiles.get(uses.match.to);
      if (!profile) {
        return notBuilt(step, `Nothing can be matched to "${uses.match.to}" yet.`, "tool");
      }
      const match = { ...uses.match };
      if (!profile.types.includes(match.type)) {
        match.type = profile.types.includes("exact") ? "exact" : (profile.types[0] ?? "exact");
        note(
          `${profile.name} can be matched by ${profile.types.join(" or ")} only: the step was set to ${match.type}.`,
        );
      }
      if (match.keys) {
        const allowed = match.keys.filter((k) => profile.keys.some((x) => x.id === k));
        if (allowed.length !== match.keys.length) {
          note(
            `${profile.name} is matched on ${profile.keys.map((k) => k.name).join(", ")} only: other keys were taken out.`,
          );
        }
        if (allowed.length > 0) match.keys = allowed;
        else delete match.keys;
      }
      if (match.secondOpinion && match.secondOpinion.from >= match.confidenceThreshold) {
        match.secondOpinion = {
          ...match.secondOpinion,
          from: Math.max(1, match.confidenceThreshold - 20),
        };
      }
      step = { ...step, uses: { type: "match", match } };
    }
    // Invariant 9: AI instructions read the input by name; earlier steps' text comes in there.
    if (step.ai?.text && REF_IN_TEXT.test(step.ai.text)) {
      REF_IN_TEXT.lastIndex = 0;
      const r = refsToInput(step.ai.text, step.input);
      movedRefs += r.moved;
      step = { ...step, ai: { ...step.ai, text: r.text }, input: r.input };
    }
    REF_IN_TEXT.lastIndex = 0;
    if (step.ai?.model && models !== null && !models.has(step.ai.model.id)) {
      modelsDropped += 1;
      const { model: _m, ...ai } = step.ai;
      step = { ...step, ai };
    }
    return step;
  };

  const guardLoop = (s: steps.LoopStep): Step => {
    let step = s;
    if (step.skill !== undefined && !knownLoop(step.skill)) {
      const { skill: _s, ...rest } = step;
      step = rest;
      note("A saved Loop it asked for doesn't exist: the Loop is written in the step instead.");
    } else if (step.skill !== undefined) {
      step = { ...step, skill: normalRef(step.skill) };
    }
    const reads: string[] = [];
    for (const action of step.reads) {
      if (!knownAction(action)) {
        gap(`There is no action "${action}" for the Loop to read; it was left out.`);
        continue;
      }
      if (kindOf(action) !== "get") {
        loopWrites += 1;
        continue;
      }
      if (!reads.includes(action)) reads.push(action);
    }
    step = { ...step, reads };
    let input = step.input;
    for (const key of ["goal", "instructions"] as const) {
      if (!REF_IN_TEXT.test(step[key])) continue;
      REF_IN_TEXT.lastIndex = 0;
      const r = refsToInput(step[key], input);
      movedRefs += r.moved;
      input = r.input;
      step = { ...step, [key]: r.text };
    }
    REF_IN_TEXT.lastIndex = 0;
    step = { ...step, input };
    if (step.model && models !== null && !models.has(step.model.id)) {
      modelsDropped += 1;
      const { model: _m, ...rest } = step;
      step = rest;
    }
    return step;
  };

  bundle = mapBundle(bundle, (s) =>
    s.kind === "do" ? guardDo(s) : s.kind === "loop" ? guardLoop(s) : s,
  );
  if (held > 0) {
    note(
      `${plural(held, "step")} it asked for can't be built yet; ${held === 1 ? "it is" : "they are"} on the canvas as "Not built yet".`,
    );
  }
  if (loopWrites > 0) {
    ask(
      `A Loop only reads: ${plural(loopWrites, "action")} that change${loopWrites === 1 ? "s" : ""} something ${loopWrites === 1 ? "was" : "were"} taken out of its reads. Save or change what it finds in a Do step after it, with approval on.`,
    );
  }
  if (movedRefs > 0) {
    note(
      `Text from earlier steps reaches the model through the step's input, never inside its instructions: ${plural(movedRefs, "reference")} moved to the input.`,
    );
  }
  if (modelsDropped > 0) {
    note(`${plural(modelsDropped, "step")} kept the agent's model: the one asked for is unknown.`);
  }

  // ── Ids (invariant 3) ───────────────────────────────────────────────────────────────────────
  const keep = source ? stepBundleIds(source) : new Set<string>();
  bundle = assignStepIds(bundle, keep, newId);

  // ── Skills and actions the steps use, on the agent ──────────────────────────────────────────
  const skillList: StepAgentBundle["definition"]["skills"] = [];
  const addSkill = (ref: string, from?: (typeof skillList)[number]) => {
    const id = parseSkillRef(ref).id;
    if (skillList.some((x) => parseSkillRef(x.skill).id === id)) return;
    skillList.push(from ? { ...from, skill: ref } : { skill: ref, settings: {} });
  };
  for (const s of def.skills) {
    // F's step skills are pinned here by the builder, never named by a step's Uses.
    if (sourceRefs.has(s.skill)) addSkill(s.skill, s);
    else if (knownSkill(s.skill) || knownLoop(s.skill)) addSkill(normalRef(s.skill), s);
    else gap(`There is no skill "${s.skill}"; it was left out.`);
  }
  const extraTools: string[] = [];
  const addTool = (id: string) => {
    if (tools.has(id) && !extraTools.includes(id)) extraTools.push(id);
  };
  for (const t of def.extraTools) {
    if (tools.has(t) || sourceActions.has(t)) {
      if (!extraTools.includes(t)) extraTools.push(t);
    } else if (!steps.mergedAction(t)) {
      gap(`There is no tool "${t}"; it was left out.`);
    }
  }
  for (const w of bundle.workflows) {
    for (const ref of steps.stepModelSkills(w.workflow)) addSkill(ref);
    for (const a of steps.stepModelActions(w.workflow)) addTool(a);
  }
  bundle = {
    ...bundle,
    definition: { ...bundle.definition, skills: skillList, extraTools },
  };

  // ── Client: what it needs that the client hasn't connected or enabled ───────────────────────
  if (ctx.client) {
    const client = ctx.client;
    const connected = new Set(
      client.connections.filter((c) => c.status !== "disconnected").map((c) => c.connector),
    );
    const packs = new Set(client.packs);
    for (const s of skillList) {
      const d =
        skillsById.get(parseSkillRef(s.skill).id) ?? loopsById.get(parseSkillRef(s.skill).id);
      for (const c of d?.requiresConnectors ?? []) {
        if (!connected.has(c)) gap(`${d?.name} needs a ${c} connection; ${client.name} has none.`);
      }
      for (const p of d?.requiresPacks ?? []) {
        if (!packs.has(p)) {
          gap(
            `${d?.name} needs the ${p} pack, off for ${client.name}: it comes on when the agent is turned on, or switch it on from What's left to try it before then.`,
          );
        }
      }
    }
    for (const w of bundle.workflows) {
      for (const a of steps.stepModelActions(w.workflow)) {
        const merged = steps.mergedAction(a);
        if (merged) {
          if (!Object.keys(merged.tools).some((c) => connected.has(c))) {
            gap(
              `"${merged.label}" needs one of ${Object.keys(merged.tools).join(", ")} connected; ${client.name} has none.`,
            );
          }
          continue;
        }
        const connector = tools.get(a)?.connector;
        if (connector && !connected.has(connector)) {
          gap(`"${a}" needs a ${connector} connection; ${client.name} has none.`);
        }
      }
    }
  }

  // ── Approval (invariant 8): on, unless the operator had that same loosening on that step ────
  const before = stepsOf(operatorSource);
  const revised = stepsOf(source);
  const reachesPeople = (s: DoStep) =>
    s.uses?.type === "collect" ||
    (s.uses?.type === "skill" &&
      skillsById.get(parseSkillRef(s.uses.skill).id)?.reachesPeople === true);
  const writes = (s: Step) =>
    s.kind === "do" &&
    s.doneBy === "rules" &&
    s.uses?.type === "action" &&
    kindOf(s.uses.action) !== "get" &&
    kindOf(s.uses.action) !== "save";
  let turnedOn = 0;
  bundle = mapBundle(bundle, (s) => {
    const was = sameStep(before.get(s.id), s);
    const fresh = !keep.has(s.id) || sameStep(revised.get(s.id), s) === undefined;
    let next = s;
    if (
      fresh &&
      next.checks?.approval === undefined &&
      (writes(next) || (next.kind === "do" && reachesPeople(next)))
    ) {
      next = { ...next, checks: { ...next.checks, approval: DEFAULT_APPROVAL } };
    }
    const approval = next.checks?.approval;
    if (approval && processes.approvalLoosenings(approval, "a").length > 0) {
      const heldApproval = holdApproval(approval, was?.checks?.approval);
      if (canonical(heldApproval) !== canonical(approval)) {
        turnedOn += 1;
        next = { ...next, checks: { ...next.checks, approval: heldApproval } };
      }
    }
    if (next.kind === "do" && next.contact) {
      const prior = was?.kind === "do" ? was.contact?.messages : undefined;
      const m = next.contact.messages;
      const first =
        m.first === "not_required" && prior?.first !== "not_required" ? "required" : m.first;
      const later =
        m.later === "within_goal" && prior?.later !== "within_goal" ? "required" : m.later;
      if (first !== m.first || later !== m.later) {
        turnedOn += 1;
        next = { ...next, contact: { ...next.contact, messages: { first, later } } };
      }
    }
    if (next.kind === "do" && next.person?.mode === "approve") {
      const prior = was?.kind === "do" ? was.person : undefined;
      const person = next.person;
      const deadline = holdDeadline(person.deadline, prior?.deadline);
      const onReject =
        person.onReject === "continue" && prior?.onReject !== "continue" ? "stop" : person.onReject;
      if (canonical(deadline) !== canonical(person.deadline) || onReject !== person.onReject) {
        turnedOn += 1;
        next = { ...next, person: { ...person, deadline, onReject } };
      }
    }
    return next;
  });
  // A write output delivers a change to a client's tool: its approval is on (§9).
  const priorOutputs = outputsOf(operatorSource);
  const revisedOutputs = outputsOf(source);
  bundle = {
    ...bundle,
    workflows: bundle.workflows.map((w) => ({
      ...w,
      workflow: {
        ...w.workflow,
        outputs: w.workflow.outputs.map((o) => {
          const action = o.action?.action;
          const isWrite =
            (o.kind === "write" || o.kind === "save") &&
            action !== undefined &&
            kindOf(action) !== "save" &&
            kindOf(action) !== "get";
          const sameOutput = (x: steps.WorkflowOutput | undefined) =>
            x && x.kind === o.kind && x.action?.action === action ? x : undefined;
          const was = sameOutput(priorOutputs.get(o.id));
          const fresh = !keep.has(o.id) || sameOutput(revisedOutputs.get(o.id)) === undefined;
          let next = o;
          if (isWrite && fresh && next.checks?.approval === undefined) {
            next = { ...next, checks: { ...next.checks, approval: DEFAULT_APPROVAL } };
          }
          const approval: processes.ApprovalCheck | undefined = next.checks?.approval;
          if (approval && processes.approvalLoosenings(approval, "a").length > 0) {
            const heldApproval = holdApproval(approval, was?.checks?.approval);
            if (canonical(heldApproval) !== canonical(approval)) {
              turnedOn += 1;
              next = { ...next, checks: { ...next.checks, approval: heldApproval } };
            }
          }
          return next;
        }),
      },
    })),
  };
  if (turnedOn > 0) {
    note(
      `Approval stays on for ${plural(turnedOn, "step")} that change a client's tool or reach people. You can switch it off in the workflow builder where the client's connection allows it.`,
    );
  }

  return { bundle: StepAgentBundle.parse(bundle), gaps, notes, fix };
}
