// Check the steps (docs/builder-plan.md §12.5 F5, docs/plan.md §1.170 "Check the steps"): the
// pure edits behind a new build's list of lines, over the saved draft's process. Every edit goes
// through ../builder/model (insertStep, removeStep, moveStep, updateStep, newPath, createStep), so
// step and path ids are made once and never regenerated (CLAUDE.md invariant 3). A line typed by
// hand is a `missing` step whose need is its words: the kind that exists today for a part not
// built yet; the Builder fills it on Build it. No step kind is added here.
import { type TriggerOn, uuidv7 } from "@countersign/core";
import {
  type ContainerId,
  createStep,
  insertStep,
  locate,
  moveStep,
  type NewId,
  newPath,
  type Process,
  ROOT,
  removeStep,
  type Step,
  setTrigger,
  updateContainer,
  updateStep,
} from "../builder/model";
import { eventKind } from "../workflow/labels";

type IfStep = Extract<Step, { kind: "if" }>;
type MissingStep = Extract<Step, { kind: "missing" }>;

/** The most a missing step's need may say (core's `MISSING_NEED_MAX`). */
const NEED_MAX = 300;

// ── How it starts ────────────────────────────────────────────────────────────────────────────────

/** The five ways a new agent starts, as the mock-up offers them. */
export const START_KINDS = ["document", "schedule", "record", "message", "person"] as const;
export type StartKind = (typeof START_KINDS)[number];

export const STARTS: Record<StartKind, { title: string; hint: string }> = {
  document: { title: "A document arrives", hint: "An invoice, a receipt, a file" },
  schedule: { title: "On a schedule", hint: "Every day, every week" },
  record: { title: "A record changes", hint: "Something new or changed in a tool" },
  message: { title: "A message arrives", hint: "An email, a text, a WhatsApp" },
  person: { title: "A person starts it", hint: "By hand, when they choose" },
};

/**
 * Which of the five a trigger is, by today's trigger kinds; null for one that is none of them
 * (a webhook, a hand-off, an event of another kind).
 */
export function startKindOf(on: TriggerOn): StartKind | null {
  switch (on.type) {
    case "schedule":
      return "schedule";
    case "manual":
    case "command":
      return "person";
    case "message":
      return "message";
    case "event": {
      const k = eventKind(on.event);
      return k === "document" || k === "record" || k === "message" || k === "schedule" ? k : null;
    }
    default:
      return null;
  }
}

/**
 * The trigger a kind starts with, in today's trigger kinds. Each is a starting point the chart's
 * trigger panel changes after (which event, which schedule).
 */
// DECISION (F5): a document is `document.received`, a record `transaction.created`, a message
// `message.received` (events every client has a source for: upload, the accounting tool, the
// agent's number); a schedule weekdays at 7:00 as the builder's palette starts one; a person the
// manual start with no fields.
export function startOn(kind: StartKind): TriggerOn {
  switch (kind) {
    case "document":
      return { type: "event", event: "document.received" };
    case "record":
      return { type: "event", event: "transaction.created" };
    case "message":
      return { type: "event", event: "message.received" };
    case "schedule":
      return { type: "schedule", cron: "0 7 * * 1-5" };
    case "person":
      return { type: "manual", input: { type: "object", properties: {} } };
  }
}

/** Sets the first trigger to a kind (its id kept). A trigger already of that kind is kept as is. */
export function setStart(process: Process, kind: StartKind): Process {
  const first = process.triggers[0];
  if (!first) return process;
  if (startKindOf(first.on) === kind) return process;
  return setTrigger(process, startOn(kind), first.id);
}

/** A process with nothing in it yet: started by a person, no steps (List the steps myself). */
export function blankProcess(newId: NewId = uuidv7): Process {
  return { schemaVersion: 4, triggers: [{ id: newId(), on: startOn("person") }], steps: [] };
}

// ── Lines ────────────────────────────────────────────────────────────────────────────────────────

const tidy = (words: string) => words.replace(/\s+/g, " ").trim();

/** A line typed by hand: a missing step whose name and need are its words. */
export function newLine(words: string, newId: NewId = uuidv7): MissingStep {
  const w = tidy(words);
  return { id: newId(), kind: "missing", name: w, need: w.slice(0, NEED_MAX) };
}

/** Whether a line is one typed here and not filled yet (blank or not). */
export function isHandLine(step: Step): step is MissingStep {
  return step.kind === "missing";
}

/**
 * A line's words changed. A missing step's need follows its words (it says what is missing); any
 * other step only takes the new name. Ids are kept.
 */
export function renameLine(process: Process, id: string, words: string): Process {
  return updateStep(process, id, (s) =>
    s.kind === "missing"
      ? { ...s, name: words, need: tidy(words).slice(0, NEED_MAX) }
      : { ...s, name: words },
  );
}

/** Adds a line typed by hand at `index` of a list. */
export function addLine(
  process: Process,
  container: ContainerId,
  index: number,
  words = "",
  newId: NewId = uuidv7,
): { process: Process; stepId: string } {
  const step = newLine(words, newId);
  return { process: insertStep(process, container, index, step), stepId: step.id };
}

export const removeLine = removeStep;

/** Moves a top-level line to `index` (counted after it has left its place, as arrayMove). */
export function moveLine(process: Process, id: string, index: number): Process {
  return moveStep(process, id, ROOT, index);
}

// ── Decisions ────────────────────────────────────────────────────────────────────────────────────

/** The words of an "If …" line: its condition, and what happens on that path, if it says. */
export function readIf(words: string): {
  condition: string;
  /** What happens on that path, in words. */
  onPath: string;
  stops: boolean;
} | null {
  const m = tidy(words).match(/^if\s+(.*)$/i);
  if (!m) return null;
  const rest = m[1] ?? "";
  // A comma with a space after it ends the condition ("over $5,000, ask Dana").
  const split = rest.match(/^(.+?)(?:,\s+|\s+then\s+)(.+)$/i);
  const condition = (split ? split[1] : rest)?.trim() ?? "";
  let onPath = (split?.[2] ?? "").trim();
  let stops = false;
  const end = onPath.match(/^(.*?)(?:,?\s+and\s+|,\s*|^)(?:stop|end)(?:\s+here)?$/i);
  if (end) {
    stops = true;
    onPath = (end[1] ?? "").trim();
  }
  return { condition, onPath, stops };
}

/** A decision with one path ("If <condition>") and an empty otherwise. */
export function newDecision(condition = "", newId: NewId = uuidv7): IfStep {
  const step = createStep(
    { type: "logic", key: "logic:if", title: "If", detail: "", logic: "if" },
    {},
    newId,
  ) as IfStep;
  const c = tidy(condition);
  return {
    ...step,
    name: c ? `If ${c}` : "Decision",
    paths: step.paths.map((p) => ({ ...p, name: c })),
  };
}

/** Adds a decision at `index` of a list. */
export function addDecision(
  process: Process,
  container: ContainerId,
  index: number,
  condition = "",
  newId: NewId = uuidv7,
): { process: Process; stepId: string } {
  const step = newDecision(condition, newId);
  return { process: insertStep(process, container, index, step), stepId: step.id };
}

const stopStep = (newId: NewId): Step => ({
  ...createStep(
    { type: "logic", key: "logic:stop", title: "Stop", detail: "", logic: "stop" },
    {},
    newId,
  ),
  name: "Stop here",
});

/**
 * A line typed by hand that starts with "If " becomes a decision in its place: the decision keeps
 * the line's id (it never ran or published), its first path is the condition, and "If A, do B"
 * puts B on that path ("…and stop" ends it there). Other lines are left as they are.
 */
// DECISION (F5): only a line typed here turns into a decision; a drafted step renamed "If …" is a
// rename, so a skill or a write the Builder chose is never thrown away by a word.
export function lineToDecision(process: Process, id: string, newId: NewId = uuidv7): Process {
  const loc = locate(process, id);
  if (loc?.step.kind !== "missing") return process;
  const read = readIf(loc.step.name);
  if (!read) return process;
  const made = newDecision(read.condition, newId);
  const path = made.paths[0];
  const onPath: Step[] = [];
  if (path) {
    if (read.onPath) onPath.push(newLine(read.onPath, newId));
    if (read.stops) onPath.push(stopStep(newId));
  }
  const decision: IfStep = {
    ...made,
    id,
    paths: made.paths.map((p, i) => (i === 0 ? { ...p, steps: onPath } : p)),
  };
  return updateContainer(process, loc.container, (steps) =>
    steps.map((s) => (s.id === id ? decision : s)),
  );
}

function updateIf(process: Process, ifId: string, fn: (s: IfStep) => IfStep): Process {
  return updateStep(process, ifId, (s) => (s.kind === "if" ? fn(s) : s));
}

/** A path's condition, in words: its name. The decision's own name follows its first path. */
export function setCondition(
  process: Process,
  ifId: string,
  pathId: string,
  words: string,
): Process {
  return updateIf(process, ifId, (s) => {
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
  process: Process,
  ifId: string,
  newId: NewId = uuidv7,
): { process: Process; pathId: string | null } {
  const loc = locate(process, ifId);
  if (loc?.step.kind !== "if") return { process, pathId: null };
  const path = { ...newPath(loc.step.paths.length + 1, newId), name: "" };
  return {
    process: updateIf(process, ifId, (s) => ({ ...s, paths: [...s.paths, path] })),
    pathId: path.id,
  };
}

/** Removes a path and its steps; a decision keeps at least one path. */
export function removePath(process: Process, ifId: string, pathId: string): Process {
  return updateIf(process, ifId, (s) =>
    s.paths.length <= 1 ? s : { ...s, paths: s.paths.filter((p) => p.id !== pathId) },
  );
}

/** A path's container id (`path:<id>`), or its otherwise's (`otherwise:<id>`). */
export const pathContainer = (pathId: string): ContainerId => `path:${pathId}`;
export const otherwiseContainer = (ifStep: IfStep): ContainerId =>
  `otherwise:${ifStep.otherwise.id}`;

/** A path ends here when its last step is Stop; otherwise it rejoins the steps below. */
export function pathEnds(steps: readonly Step[]): boolean {
  return steps.at(-1)?.kind === "stop";
}

/**
 * "then it: ends here / rejoins the steps below". Ends here puts a Stop as the path's last step;
 * rejoins takes that Stop away. Nothing else on the path changes.
 */
export function setPathEnd(
  process: Process,
  container: ContainerId,
  end: "stop" | "on",
  newId: NewId = uuidv7,
): Process {
  return updateContainer(process, container, (steps) => {
    const ends = pathEnds(steps);
    if (end === "stop") return ends ? steps : [...steps, stopStep(newId)];
    return ends ? steps.slice(0, -1) : steps;
  });
}

/** Every path of a decision with its container id, the otherwise last. */
export function decisionPaths(
  s: IfStep,
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

/** After the paths: they all rejoin, they all end, or some of each. */
export function afterPaths(s: IfStep): "together" | "apart" | "mixed" {
  const ends = decisionPaths(s).map((p) => pathEnds(p.steps));
  return ends.every((e) => !e) ? "together" : ends.every(Boolean) ? "apart" : "mixed";
}

/** "they come back together": every path rejoins; "they go separate ways": every path ends. */
export function setAfterPaths(
  process: Process,
  ifId: string,
  how: "together" | "apart",
  newId: NewId = uuidv7,
): Process {
  const loc = locate(process, ifId);
  if (loc?.step.kind !== "if") return process;
  return decisionPaths(loc.step).reduce(
    (p, path) => setPathEnd(p, path.container, how === "apart" ? "stop" : "on", newId),
    process,
  );
}

/**
 * "Move these below the decision": a path's steps leave the decision and become the lines right
 * after it, in their order, so the decision holds only what differs and every path that rejoins
 * goes on to them. A path that ends here keeps its steps: moving them would move its Stop too.
 */
// DECISION (owner, 2026-11-23: "contain the decisions to encompass the decision point and then
// the path just continues"): one move for the whole path, since a line on a path can't be dragged.
export function movePathBelow(process: Process, ifId: string, container: ContainerId): Process {
  const loc = locate(process, ifId);
  if (loc?.step.kind !== "if") return process;
  const path = decisionPaths(loc.step).find((p) => p.container === container);
  if (!path || pathEnds(path.steps)) return process;
  return path.steps.reduce(
    (p, s, i) => moveStep(p, s.id, loc.container, loc.index + 1 + i),
    process,
  );
}

// ── Build it ─────────────────────────────────────────────────────────────────────────────────────

function walk(steps: readonly Step[], fn: (s: Step) => void) {
  for (const s of steps) {
    fn(s);
    if (s.kind === "if") {
      for (const p of s.paths) walk(p.steps, fn);
      walk(s.otherwise.steps, fn);
    }
    if (s.kind === "for_each" || s.kind === "repeat") walk(s.steps, fn);
  }
}

/** Lines left blank are dropped before saving: a missing step says what is missing. */
export function finishLines(process: Process): Process {
  const blank: string[] = [];
  walk(process.steps, (s) => {
    if (s.kind === "missing" && !tidy(s.need)) blank.push(s.id);
  });
  return blank.reduce((p, id) => removeStep(p, id), process);
}

/** Top-level steps and decisions, for "read your description as 4 steps and 3 decisions". */
export function countLines(process: Process): { steps: number; decisions: number } {
  let steps = 0;
  let decisions = 0;
  for (const s of process.steps) {
    if (s.kind === "if") decisions += 1;
    else steps += 1;
  }
  return { steps, decisions };
}

/**
 * What was added here and not drafted: the lines typed by hand (missing steps with words) and the
 * decisions made here, by id against the draft as it was loaded (null: nothing was drafted).
 */
export function handAdded(
  before: Process | null,
  after: Process,
): { lines: MissingStep[]; decisions: IfStep[] } {
  const had = new Set<string>();
  if (before) walk(before.steps, (s) => had.add(s.id));
  const lines: MissingStep[] = [];
  const decisions: IfStep[] = [];
  walk(after.steps, (s) => {
    if (had.has(s.id)) return;
    if (s.kind === "missing" && tidy(s.need)) lines.push(s);
    if (s.kind === "if") decisions.push(s);
  });
  return { lines, decisions };
}

const quote = (w: string) => `"${tidy(w)}"`;
const conditionOf = (s: IfStep) =>
  s.paths
    .map((p) => tidy(p.name))
    .filter(Boolean)
    .map(quote)
    .join(" or ");

/**
 * The one request to the Builder on Build it: fill the lines typed by hand with the steps the
 * catalog has, give the decisions made here their rules, and start the way the operator said.
 * Null when there is nothing to ask.
 */
export function fillRequest(input: {
  workflowName: string;
  added: ReturnType<typeof handAdded>;
  /** The operator's own words for how it starts, when they changed them. */
  startWords?: string | null;
}): string | null {
  const parts: string[] = [];
  const { lines, decisions } = input.added;
  if (lines.length > 0) {
    parts.push(
      `In the workflow "${input.workflowName}" I added ${lines.length === 1 ? "a step" : `${lines.length} steps`} by hand as missing steps: ${lines.map((l) => quote(l.need)).join(", ")}. Replace each with the step from the catalog that does it, keeping its place. Where nothing fits, leave it missing and say what it needs.`,
    );
  }
  const asked = decisions.filter((d) => conditionOf(d));
  if (asked.length > 0) {
    parts.push(
      `Give the decisions I added their rules: ${asked.map((d) => `if ${conditionOf(d)}`).join("; ")}. Keep their paths and steps.`,
    );
  }
  const start = tidy(input.startWords ?? "");
  if (start) parts.push(`It starts: ${start}. Set its trigger to match.`);
  if (parts.length === 0) return null;
  return parts.join("\n\n").slice(0, 4000);
}

/**
 * The list in words, for a build with no draft yet (List the steps myself): what the Builder drafts
 * from. "When …. 1. Read the invoice. 2. If the invoice is a duplicate: tell Dana, then it ends.
 * Otherwise it goes on."
 */
export function listWords(process: Process, start: string): string {
  const out: string[] = [];
  const s = tidy(start);
  if (s) out.push(`It starts: ${s}.`);
  const line = (st: Step): string => {
    if (st.kind === "if") {
      // An otherwise with nothing on it goes on to the next line: nothing to say.
      const said = decisionPaths(st).filter((p) => !p.otherwise || p.steps.length > 0);
      const paths = said.map((p, i) => {
        const what = p.steps
          .filter((x) => x.kind !== "stop")
          .map((x) => tidy(x.name))
          .filter(Boolean);
        const head = p.otherwise
          ? "Otherwise"
          : `${i === 0 ? "If" : "or if"} ${tidy(st.paths[i]?.name ?? "")}`;
        const body = what.length ? `: ${what.join(", then ")}` : "";
        const tail = pathEnds(p.steps) ? ", then it ends" : "";
        return `${head}${body}${tail}`;
      });
      return paths.join("; ");
    }
    return tidy(st.name);
  };
  process.steps
    .map(line)
    .filter(Boolean)
    .forEach((l, i) => {
      out.push(`${i + 1}. ${l}.`);
    });
  return out.join(" ").slice(0, 4000);
}

export type { IfStep, MissingStep };
