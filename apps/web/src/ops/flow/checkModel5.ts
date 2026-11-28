// Check the steps in the step model (docs/step-model-plan.md §4, §5, §9, §13a; workflow
// `schemaVersion: 5`): the pure edits behind the list of lines for a v5 agent's draft, as
// ./checkModel has them for a v4 process. Every edit goes through the steps builder's own model
// (`../builder/steps/model`: insertStep, removeStep, moveStep, updateStep, ensureEnd), so step and
// path ids are made once and never regenerated (CLAUDE.md invariant 3), and the workflow is checked
// by core's one validator (`steps.validateWorkflow`, invariant 4).
//
// - A line typed by hand is a Do that uses "Not built yet" (`uses: { type: "missing", need }`),
//   its need its words. Matching it to an action, a skill or an automation makes it a Do with that
//   Uses (`matchLine`); a Change or a Send starts with its approver on (invariant 8).
// - A decision is a Fork: "If …" paths and an otherwise. "Ends here" puts an End as a path's last
//   step; "rejoins" takes it away.
// - How it ends (§9): every path that doesn't rejoin finishes on an End, which the builder keeps
//   (the main line's last End is never taken away), and each End delivers declared outputs. The
//   cards add an output of that kind and have the main line's End deliver it.

import { steps, uuidv7 } from "@countersign/core";
import {
  type ContainerId,
  ensureEnd,
  findStep,
  getContainer,
  insertStep,
  moveStep,
  type NewId,
  NOTHING_TO_DO_OUTPUT,
  newOutput,
  newStep,
  newStepWorkflow,
  ROOT,
  removeOutput,
  removeStep,
  setEndOutputs,
  updateStep,
  walk,
} from "../builder/steps/model";
import { withKind } from "../builder/steps/OutputsEditor";
import { chooseUses, type UsesContext } from "../builder/steps/options";
import type { DoneBy, DoStep, EndStep, Step, Uses, Workflow } from "../builder/steps/types";
import {
  ENDS,
  type EndKind,
  readIf,
  startOn,
  startsSentence,
  startWordsAll,
  tidy,
} from "./checkModel";

export type ForkStep = Extract<Step, { kind: "fork" }>;
export type LineStep = DoStep & { uses: Extract<Uses, { type: "missing" }> };
type LoopStep = Extract<Step, { kind: "for_each" | "repeat" }>;

/** The most a "Not built yet" need may say (the schema's `uses.need`). */
const NEED_MAX = 300;

// ── A workflow with nothing in it yet ──────────────────────────────────────────────────────────

/**
 * A v5 workflow started by a person, with no steps but its End (List the steps myself): the same
 * as every new workflow (`newStepWorkflow`: the trigger, "Nothing to do" and the End delivering it).
 */
export function blankWorkflow(newId: NewId = uuidv7): Workflow {
  return newStepWorkflow(startOn("person") as Workflow["triggers"][number]["on"], newId);
}

/**
 * A stored v5 workflow as Check the steps edits it: parsed by core's schema (its defaults filled),
 * with the End the builder keeps at the end of the main line (`ensureEnd`). Null when it isn't one.
 */
export function readWorkflow(stored: unknown, newId: NewId = uuidv7): Workflow | null {
  const parsed = steps.Workflow.safeParse(stored);
  return parsed.success ? ensureEnd(parsed.data, newId) : null;
}

// ── Lines ──────────────────────────────────────────────────────────────────────────────────────

/** A line typed by hand: a Do whose name and "Not built yet" need are its words. */
export function newLine(words: string, newId: NewId = uuidv7): LineStep {
  const w = tidy(words);
  return {
    id: newId(),
    kind: "do",
    name: w,
    input: {},
    uses: { type: "missing", need: w.slice(0, NEED_MAX) },
  };
}

/** Whether a step is a line typed here and not filled yet: a Do that is "Not built yet". */
export function isHandLine(step: Step): step is LineStep {
  return step.kind === "do" && step.uses?.type === "missing";
}

/** A line's words changed: a "Not built yet" need follows them; any other step takes the name. */
export function renameLine(workflow: Workflow, id: string, words: string): Workflow {
  return updateStep(workflow, id, (s) =>
    isHandLine(s)
      ? { ...s, name: words, uses: { ...s.uses, need: tidy(words).slice(0, NEED_MAX) } }
      : { ...s, name: words },
  );
}

/** Where a new line goes in a list: never after the End that closes it (it would never run). */
function placeIn(workflow: Workflow, container: ContainerId, index: number): number {
  const list = getContainer(workflow, container) ?? [];
  const closes = list.at(-1)?.kind === "end" ? list.length - 1 : list.length;
  return Math.max(0, Math.min(index, closes));
}

/** Adds a line typed by hand at `index` of a list (before the End that closes it). */
export function addLine(
  workflow: Workflow,
  container: ContainerId,
  index: number,
  words = "",
  newId: NewId = uuidv7,
): { workflow: Workflow; stepId: string } {
  const step = newLine(words, newId);
  return {
    workflow: insertStep(workflow, { container, index: placeIn(workflow, container, index) }, step),
    stepId: step.id,
  };
}

/** Takes a line out; an End the builder keeps stays (`removeStep`). */
export const removeLine = (workflow: Workflow, id: string): Workflow => removeStep(workflow, id);

/** Moves a top-level line to `index`, counted after it has left its place (as arrayMove). */
export function moveLine(workflow: Workflow, id: string, index: number): Workflow {
  const from = workflow.steps.findIndex((s) => s.id === id);
  if (from < 0) return workflow;
  // The builder's moveStep counts the place before the step leaves; arrayMove counts it after.
  const to = placeIn(workflow, ROOT, index > from ? index + 1 : index);
  return moveStep(workflow, id, { container: ROOT, index: to });
}

/**
 * Who does a step that uses this: an action, a Match and a Tell are Rules; a skill is its own kind;
 * Collect reports is people; an automation's own steps say (none). Picked in the Do form otherwise.
 */
export function doneByFor(uses: Uses, ctx: UsesContext): DoneBy | undefined {
  switch (uses.type) {
    case "automation":
      return undefined;
    case "skill":
      return ctx.skills.find((s) => s.ref === uses.skill)?.kind ?? "rules";
    case "collect":
      return "person";
    default:
      return "rules";
  }
}

/**
 * A line matched: a Do done by `doneBy` that uses `uses` (none: the work is written in the step,
 * for the builder's form), its id and name kept. Through the Do form's own `chooseUses`, so what it
 * drops and what it switches on are the same; a Change or a Send starts with its approver on
 * (invariant 8). A Done by the Uses doesn't allow is left for the form to say (the checks show it).
 */
export function matchLine(
  workflow: Workflow,
  id: string,
  pick: { doneBy?: DoneBy | undefined; uses?: Uses | undefined },
  ctx: UsesContext,
): Workflow {
  return updateStep(workflow, id, (s) => {
    if (s.kind !== "do") return s;
    const doneBy = pick.uses?.type === "automation" ? undefined : pick.doneBy;
    const bare: DoStep = { id: s.id, kind: "do", name: s.name, input: {} };
    if (s.purpose) bare.purpose = s.purpose;
    if (doneBy) bare.doneBy = doneBy;
    const chosen = chooseUses(bare, pick.uses, ctx);
    if (pick.uses?.type === "action" && ctx.actions.get(pick.uses.action)?.kind === "send") {
      // A Send goes out through the gate like a Change (the engine's `write`): asked first too.
      chosen.checks = {
        ...chosen.checks,
        approval: chosen.checks?.approval ?? {
          required: "required",
          mode: "in_turn",
          ifNoAnswer: "stop",
          onReject: "stop",
        },
      };
    }
    return chosen;
  });
}

// ── Decisions ──────────────────────────────────────────────────────────────────────────────────

/** A decision: a Fork with one path ("If <condition>") and an empty otherwise. */
export function newDecision(condition = "", newId: NewId = uuidv7): ForkStep {
  const fork = newStep("fork", newId) as ForkStep;
  const c = tidy(condition);
  return {
    ...fork,
    name: c ? `If ${c}` : "Decision",
    paths: fork.paths.map((p) => ({ ...p, name: c })),
  };
}

/** Adds a decision at `index` of a list (before the End that closes it). */
export function addDecision(
  workflow: Workflow,
  container: ContainerId,
  index: number,
  condition = "",
  newId: NewId = uuidv7,
): { workflow: Workflow; stepId: string } {
  const step = newDecision(condition, newId);
  return {
    workflow: insertStep(workflow, { container, index: placeIn(workflow, container, index) }, step),
    stepId: step.id,
  };
}

/** An End that closes a path: it delivers nothing yet (the checks ask what). */
const endStep = (newId: NewId): EndStep => newStep("end", newId) as EndStep;

/**
 * A line typed by hand that starts with "If " becomes a decision in its place, keeping the line's
 * id: its first path is the condition, "If A, do B" puts B on that path, and "…and stop" ends that
 * path on an End. Other steps are left as they are.
 */
// DECISION (as F5 in v4): only a line typed here turns into a decision; a drafted step renamed
// "If …" is a rename, so what the Builder chose is never thrown away by a word.
export function lineToDecision(workflow: Workflow, id: string, newId: NewId = uuidv7): Workflow {
  const loc = findStep(workflow, id);
  if (!loc || !isHandLine(loc.step)) return workflow;
  const read = readIf(loc.step.name);
  if (!read) return workflow;
  const made = newDecision(read.condition, newId);
  const onPath: Step[] = [];
  if (read.onPath) onPath.push(newLine(read.onPath, newId));
  if (read.stops) onPath.push(endStep(newId));
  const decision: ForkStep = {
    ...made,
    id,
    paths: made.paths.map((p, i) => (i === 0 ? { ...p, steps: onPath } : p)),
  };
  return updateStep(workflow, id, () => decision);
}

function updateFork(workflow: Workflow, forkId: string, fn: (s: ForkStep) => ForkStep): Workflow {
  return updateStep(workflow, forkId, (s) => (s.kind === "fork" ? fn(s) : s));
}

/** A path's condition, in words: its name. The decision's own name follows its first path. */
export function setCondition(
  workflow: Workflow,
  forkId: string,
  pathId: string,
  words: string,
): Workflow {
  return updateFork(workflow, forkId, (s) => {
    const first = s.paths[0]?.id === pathId;
    const c = tidy(words);
    return {
      ...s,
      ...(first && (s.name === "Decision" || s.name === "If" || s.name.startsWith("If "))
        ? { name: c ? `If ${c}` : "Decision" }
        : {}),
      paths: s.paths.map((p) => (p.id === pathId ? { ...p, name: words } : p)),
    };
  });
}

/** "Add a path: Or if …": a new path before the otherwise. */
export function addPath(
  workflow: Workflow,
  forkId: string,
  newId: NewId = uuidv7,
): { workflow: Workflow; pathId: string | null } {
  const loc = findStep(workflow, forkId);
  if (loc?.step.kind !== "fork") return { workflow, pathId: null };
  const path = { id: newId(), name: "", when: { match: "all" as const, rules: [] }, steps: [] };
  return {
    workflow: updateFork(workflow, forkId, (s) => ({ ...s, paths: [...s.paths, path] })),
    pathId: path.id,
  };
}

/** Removes a path and its steps; a decision keeps at least one path. */
export function removePath(workflow: Workflow, forkId: string, pathId: string): Workflow {
  return ensureEnd(
    updateFork(workflow, forkId, (s) =>
      s.paths.length <= 1 ? s : { ...s, paths: s.paths.filter((p) => p.id !== pathId) },
    ),
  );
}

export const pathContainer = (pathId: string): ContainerId => `path:${pathId}`;
export const otherwiseContainer = (fork: ForkStep): ContainerId => `otherwise:${fork.otherwise.id}`;

/** A path ends here when its last step is an End; otherwise it rejoins the steps below. */
export function pathEnds(list: readonly Step[]): boolean {
  return list.at(-1)?.kind === "end";
}

/** Every path of a decision with its container id, the otherwise last. */
export function decisionPaths(
  s: ForkStep,
): { key: string; container: ContainerId; steps: Step[]; otherwise: boolean }[] {
  return [
    ...s.paths.map((p) => ({
      key: p.id,
      container: pathContainer(p.id),
      steps: p.steps,
      otherwise: false,
    })),
    {
      key: s.otherwise.id,
      container: otherwiseContainer(s),
      steps: s.otherwise.steps,
      otherwise: true,
    },
  ];
}

/** The decision a path's container belongs to. */
function forkOf(workflow: Workflow, container: ContainerId): ForkStep | null {
  for (const { step } of walk(workflow)) {
    if (step.kind === "fork" && decisionPaths(step).some((p) => p.container === container)) {
      return step;
    }
  }
  return null;
}

/**
 * "then it: ends here / rejoins the steps below". Ends here puts an End as the path's last step;
 * rejoins takes that End away. The main line keeps its own End (`ensureEnd`).
 */
export function setPathEnd(
  workflow: Workflow,
  container: ContainerId,
  end: "stop" | "on",
  newId: NewId = uuidv7,
): Workflow {
  const fork = forkOf(workflow, container);
  if (!fork) return workflow;
  const edit = (list: Step[]): Step[] => {
    const ends = pathEnds(list);
    if (end === "stop") return ends ? list : [...list, endStep(newId)];
    return ends ? list.slice(0, -1) : list;
  };
  const next = updateFork(workflow, fork.id, (s) => ({
    ...s,
    paths: s.paths.map((p) =>
      pathContainer(p.id) === container ? { ...p, steps: edit(p.steps) } : p,
    ),
    otherwise:
      otherwiseContainer(s) === container
        ? { ...s.otherwise, steps: edit(s.otherwise.steps) }
        : s.otherwise,
  }));
  return ensureEnd(next, newId);
}

/** After the paths: they all rejoin, they all end, or some of each. */
export function afterPaths(s: ForkStep): "together" | "apart" | "mixed" {
  const ends = decisionPaths(s).map((p) => pathEnds(p.steps));
  return ends.every((e) => !e) ? "together" : ends.every(Boolean) ? "apart" : "mixed";
}

/** "they come back together": every path rejoins; "they go separate ways": every path ends. */
export function setAfterPaths(
  workflow: Workflow,
  forkId: string,
  how: "together" | "apart",
  newId: NewId = uuidv7,
): Workflow {
  const loc = findStep(workflow, forkId);
  if (loc?.step.kind !== "fork") return workflow;
  return decisionPaths(loc.step).reduce(
    (w, path) => setPathEnd(w, path.container, how === "apart" ? "stop" : "on", newId),
    workflow,
  );
}

/**
 * "Move these below the decision": a path's steps become the lines right after the decision, in
 * their order. A path that ends here keeps its steps: moving them would move its End too.
 */
export function movePathBelow(
  workflow: Workflow,
  forkId: string,
  container: ContainerId,
): Workflow {
  const loc = findStep(workflow, forkId);
  if (loc?.step.kind !== "fork") return workflow;
  const path = decisionPaths(loc.step).find((p) => p.container === container);
  if (!path || pathEnds(path.steps)) return workflow;
  return path.steps.reduce(
    (w, s, i) => moveStep(w, s.id, { container: loc.container, index: loc.index + 1 + i }),
    workflow,
  );
}

// ── How it ends ────────────────────────────────────────────────────────────────────────────────

/** The output kind each way-out card declares; a person finishing it is a step, not an output. */
const OUTPUT_FOR: Record<Exclude<EndKind, "person">, steps.OutputKind> = {
  write: "write",
  handoff: "handoff",
  notify: "report",
};

/** Which card a declared output is. */
function endKindOfOutput(kind: steps.OutputKind): EndKind | null {
  if (kind === "write" || kind === "save") return "write";
  if (kind === "handoff" || kind === "pass_on") return "handoff";
  if (kind === "report") return "notify";
  return null;
}

/** The Ends of a workflow with where each is, in words: the main line, or the path it closes. */
export interface EndAt {
  end: EndStep;
  /** "the main line", "If the invoice is a duplicate", "Otherwise", "Or if …". */
  where: string;
  /** What it delivers, by name; empty: nothing picked yet. */
  delivers: string[];
}

export function endsOf(workflow: Workflow): EndAt[] {
  const out: EndAt[] = [];
  const where = new Map<ContainerId, string>([[ROOT, "the main line"]]);
  for (const { step } of walk(workflow)) {
    if (step.kind !== "fork") continue;
    step.paths.forEach((p, i) => {
      const c = tidy(p.name);
      where.set(
        pathContainer(p.id),
        c ? `${i === 0 ? "If" : "Or if"} ${c}` : "a path with no condition",
      );
    });
    where.set(otherwiseContainer(step), "Otherwise");
  }
  for (const l of walk(workflow)) {
    if (l.step.kind !== "end") continue;
    const end = l.step;
    out.push({
      end,
      where: where.get(l.container) ?? "inside a loop",
      delivers: end.outputs
        .map((id) => workflow.outputs.find((o) => o.id === id)?.name)
        .filter((n): n is string => n !== undefined),
    });
  }
  return out;
}

/** "Ends on the main line: Create the bill", "Ends: Otherwise, with nothing picked yet". */
export function endWords(at: EndAt): string {
  if (at.delivers.length > 0) return `Ends on ${at.where}: ${at.delivers.join(", ")}`;
  if (at.end.nothingToDo?.trim())
    return `Ends on ${at.where}: nothing to do, ${tidy(at.end.nothingToDo)}`;
  return `Ends on ${at.where}, with nothing picked yet`;
}

/**
 * How the workflow ends as it stands: the cards that are on (an output of that kind, or a person
 * doing a step), and its Ends. `chosen` names the card picked for a line typed here.
 */
export function endingOf(
  workflow: Workflow,
  chosen: Readonly<Record<string, EndKind>> = {},
): { kinds: EndKind[]; ends: EndAt[] } {
  const kinds = new Set<EndKind>();
  for (const o of workflow.outputs) {
    const k = endKindOfOutput(o.kind);
    if (k) kinds.add(k);
  }
  for (const { step } of walk(workflow)) {
    if (step.kind === "do" && (step.doneBy === "person" || step.doneBy === "contact")) {
      kinds.add("person");
    }
    if (step.kind === "do" && step.uses?.type === "tell") kinds.add("notify");
    if (step.kind === "handoff") kinds.add("handoff");
    const c = chosen[step.id];
    if (c && isHandLine(step)) kinds.add(c);
  }
  return {
    kinds: (["write", "handoff", "notify", "person"] as const).filter((k) => kinds.has(k)),
    ends: endsOf(workflow),
  };
}

/** The main line's closing End (the one the builder keeps), if it has one. */
export function mainEnd(workflow: Pick<Workflow, "steps">): EndStep | null {
  const last = workflow.steps.at(-1);
  return last?.kind === "end" ? last : null;
}

/** Whether the outputs are still only the "Nothing to do" every new workflow starts with. */
function onlyStarterOutput(workflow: Workflow): boolean {
  const [only, ...rest] = workflow.outputs;
  return rest.length === 0 && only?.kind === "nothing" && only.name === NOTHING_TO_DO_OUTPUT;
}

/**
 * Picks a way out. "It changes a tool", "Another agent takes it" and "It tells someone" declare an
 * output of that kind, named in the card's words, which the main line's End delivers; the "Nothing
 * to do" a new workflow starts with gives way to it. "A person finishes it" is a line for a person
 * before that End, for the Builder to fill. `stepId` is that line's, or the main End's.
 */
// DECISION (§9): the cards stay as they are and map onto declared outputs; the output is set up in
// full (which action, who gets the report) in the outputs editor below them, and the checks say
// what it still needs.
export function addEnding(
  workflow: Workflow,
  kind: EndKind,
  newId: NewId = uuidv7,
): { workflow: Workflow; stepId: string | null } {
  if (kind === "person") {
    const out = addLine(workflow, ROOT, workflow.steps.length, ENDS.person.words, newId);
    return { workflow: out.workflow, stepId: out.stepId };
  }
  let w = ensureEnd(workflow, newId);
  if (onlyStarterOutput(w)) {
    const starter = w.outputs[0];
    if (starter) w = removeOutput(w, starter.id);
  }
  const first = w.steps[0]?.id ?? "start";
  const output = withKind(newOutput(ENDS[kind].words, newId), OUTPUT_FOR[kind], first);
  w = { ...w, outputs: [...w.outputs, output] };
  const end = mainEnd(w);
  if (!end) return { workflow: w, stepId: null };
  w = setEndOutputs(w, end.id, { outputs: [...end.outputs, output.id] });
  return { workflow: w, stepId: end.id };
}

/**
 * Takes a way out back (feedback, 2026-11-26: "once you click this, you cannot unclick"). The
 * card's outputs go, and the Ends stop delivering them; "A person finishes it" takes back the
 * blank lines it added. When nothing is left to deliver, the workflow is back on the "Nothing to
 * do" every new workflow starts with. A step that does it (a hand-off, a person's step, a Tell)
 * stays: the card is on for as long as it is there (`endingOf`).
 */
export function removeEnding(
  workflow: Workflow,
  kind: EndKind,
  chosen: Readonly<Record<string, EndKind>> = {},
  newId: NewId = uuidv7,
): Workflow {
  let w = workflow;
  if (kind === "person") {
    const added = walk(w)
      .map((l) => l.step)
      .filter(
        (s) =>
          isHandLine(s) &&
          (chosen[s.id] === "person" || tidy(s.uses.need) === tidy(ENDS.person.words)),
      )
      .map((s) => s.id);
    return added.reduce((acc, id) => removeStep(acc, id), w);
  }
  for (const o of w.outputs) {
    if (endKindOfOutput(o.kind) === kind) w = removeOutput(w, o.id);
  }
  if (w.outputs.length === 0) {
    const starter = newOutput(NOTHING_TO_DO_OUTPUT, newId);
    w = { ...ensureEnd(w, newId), outputs: [starter] };
    const end = mainEnd(w);
    if (end) w = setEndOutputs(w, end.id, { outputs: [starter.id] });
  }
  return w;
}

/** An End's outputs, one turned on or off ("Nothing to do" and its reason give way to it). */
export function toggleEndOutput(workflow: Workflow, endId: string, outputId: string): Workflow {
  const loc = findStep(workflow, endId);
  if (loc?.step.kind !== "end") return workflow;
  const has = loc.step.outputs.includes(outputId);
  return setEndOutputs(workflow, endId, {
    outputs: has ? loc.step.outputs.filter((o) => o !== outputId) : [...loc.step.outputs, outputId],
  });
}

/** The checks that stop Build it: every path must end on an End that delivers something (§9). */
export const ENDING_CODES: ReadonlySet<string> = new Set([
  "no_end",
  "end_empty",
  "no_outputs",
  "unknown_output",
  "output_never_delivered",
]);

// ── Build it ───────────────────────────────────────────────────────────────────────────────────

/** Lines left blank are dropped before saving: "Not built yet" says what is missing. */
export function finishLines(workflow: Workflow): Workflow {
  const blank = walk(workflow)
    .map((l) => l.step)
    .filter((s) => isHandLine(s) && !tidy(s.uses.need))
    .map((s) => s.id);
  return blank.reduce((w, id) => removeStep(w, id), workflow);
}

/** Top-level steps and decisions, for "read your description as 4 steps and 3 decisions". */
export function countLines(workflow: Pick<Workflow, "steps">): {
  steps: number;
  decisions: number;
} {
  let n = 0;
  let decisions = 0;
  for (const s of workflow.steps) {
    if (s.kind === "end") continue;
    if (s.kind === "fork") decisions += 1;
    else n += 1;
  }
  return { steps: n, decisions };
}

/** The lines typed by hand (with words) and the decisions made here, by id against the draft. */
export function handAdded(
  before: Workflow | null,
  after: Workflow,
): { lines: { id: string; need: string }[]; decisions: ForkStep[] } {
  const had = new Set(before ? walk(before).map((l) => l.step.id) : []);
  const lines: { id: string; need: string }[] = [];
  const decisions: ForkStep[] = [];
  for (const { step } of walk(after)) {
    if (had.has(step.id)) continue;
    if (isHandLine(step) && tidy(step.uses.need)) lines.push({ id: step.id, need: step.uses.need });
    if (step.kind === "fork") decisions.push(step);
  }
  return { lines, decisions };
}

/**
 * The list in words, for a build with no draft yet: every way in, the lines in order, then what it
 * delivers. "It starts: When …. 1. Read the invoice. 2. If the invoice is a duplicate: tell Dana,
 * then it ends. It delivers: Save the result."
 */
export function listWords(workflow: Workflow, start: string): string {
  const out: string[] = [];
  const starts = startsSentence(startWordsAll(workflow.triggers, start));
  if (starts) out.push(starts);
  const line = (st: Step): string => {
    if (st.kind === "fork") {
      const said = decisionPaths(st).filter((p) => !p.otherwise || p.steps.length > 0);
      return said
        .map((p, i) => {
          const what = p.steps
            .filter((x) => x.kind !== "end")
            .map((x) => tidy(x.name))
            .filter(Boolean);
          const head = p.otherwise
            ? "Otherwise"
            : `${i === 0 ? "If" : "or if"} ${tidy(st.paths[i]?.name ?? "")}`;
          const body = what.length ? `: ${what.join(", then ")}` : "";
          const tail = pathEnds(p.steps) ? ", then it ends" : "";
          return `${head}${body}${tail}`;
        })
        .join("; ");
    }
    return st.kind === "end" ? "" : tidy(st.name);
  };
  workflow.steps
    .map(line)
    .filter(Boolean)
    .forEach((l, i) => {
      out.push(`${i + 1}. ${l}.`);
    });
  const delivers = onlyStarterOutput(workflow)
    ? []
    : workflow.outputs.map((o) => tidy(o.name)).filter(Boolean);
  if (delivers.length > 0) out.push(`It delivers: ${delivers.join("; ")}.`);
  return out.join(" ").slice(0, 4000);
}

/** The step with this id, anywhere in the workflow. */
export function findLine(workflow: Workflow, id: string): Step | null {
  return findStep(workflow, id)?.step ?? null;
}

/** Whether a step was in the draft as it was loaded. */
export function hadStep(workflow: Workflow | null, id: string): boolean {
  return workflow ? findStep(workflow, id) !== null : false;
}

export type { LoopStep };
