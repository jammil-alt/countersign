// What the builder says about a workflow problem, in plain words. The validator (packages/core) words
// its messages for the Builder model and the API: step ids, template references and field paths
// ("{{steps.match.output.bill.recordId}}: step "match" does not run before this one on its path").
// Here they become sentences a person reads: step names, field names in words, and what to do.
// DECISION: the rewording lives in the web app, not in core (2026-11-10): the model and the API
// keep the exact references, which they need to fix a draft; only the screen changes.
// On v4 processes (merge of main, 2026-11-11): the builder edits processes, so a step is found in
// a process, a trigger is one of its triggers, and a path's owner is its `if`.
import type { ProcessAgentBundle } from "@countersign/core";
import type { BuilderProblem } from "./catalog";
import { ifOfBranch, locate, type Process, type Step } from "./model";

type ValidationError = BuilderProblem;
type AgentBundle = ProcessAgentBundle;
type Workflow = Process;

/** A problem as the builder shows it. `group` joins several references to one step. */
export interface ReadableProblem {
  error: ValidationError;
  text: string;
  /** Problems with the same key say the same thing about the same step: shown as one line. */
  group?: { key: string; what: string; from: string; removed: boolean };
}

const REF = /\{\{\s*([^}]+?)\s*\}\}/g;

/** "vendorName" → "vendor name"; "record_id" → "record id". */
export function words(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
}

function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const first = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.?!]$/.test(first) ? first : `${first}.`;
}

/** A path's field words, without list positions ("bill.recordId" → "bill record id"). */
export function pathWords(segments: readonly string[]): string {
  return segments
    .filter((s) => !/^\d+$/.test(s))
    .map(words)
    .join(" ");
}

const FIELD_NAMES: Record<string, string> = {
  "on.cron": "Schedule",
  "on.tz": "Time zone",
  "on.event": "Event",
  "on.from": "Who may send it",
  "on.channels": "Channels",
  "on.reply.confirm": "Confirmation",
  "model.id": "Model",
  over: "List to go over",
  paths: "Paths",
  choices: "Quick answers",
};

/** A field path as a label: "input.ids.0" → "Ids"; "" → null (the step itself). */
export function fieldLabel(field: string): string | null {
  if (!field) return null;
  const known = FIELD_NAMES[field];
  if (known) return known;
  const segs = field.split(".").filter((s) => !/^\d+$/.test(s));
  const tail = segs[0] === "input" && segs.length > 1 ? segs.slice(1) : segs;
  const text = pathWords(tail);
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : null;
}

export type Namer = (stepId: string) => string | null;

/** A step's name by its id: in this workflow first, then in the agent's other workflows. */
export function stepNamer(workflow: Workflow | undefined, bundle: AgentBundle): Namer {
  return (id) => {
    const inWorkflow = workflow ? (locate(workflow, id)?.step ?? null) : null;
    if (inWorkflow) return inWorkflow.name;
    if (workflow?.triggers.some((t) => t.id === id)) return "the trigger";
    for (const w of bundle.workflows) {
      const s: Step | null = locate(w.workflow, id)?.step ?? null;
      if (s) return s.name;
    }
    return null;
  };
}

/** A template reference in words: "{{steps.match.output.invoice.number}}" → "invoice number from “Match”". */
export function referenceText(expr: string, name: Namer): string {
  const [root, ...rest] = expr.split(".");
  switch (root) {
    case "steps": {
      const [id = "", , ...tail] = rest;
      const step = name(id);
      const what = pathWords(tail);
      const from = step ? `“${step}”` : "a removed step";
      return what ? `the ${what} from ${from}` : `what ${from} gives back`;
    }
    case "trigger": {
      const what = pathWords(rest);
      return what ? `the trigger's ${what}` : "the trigger";
    }
    case "input": {
      const what = pathWords(rest);
      return what ? `the automation's ${what}` : "the automation's input";
    }
    case "item": {
      const what = pathWords(rest);
      return what ? `the current item's ${what}` : "the current item";
    }
    case "index":
      return "the item's position";
    default:
      return `“${expr}”`;
  }
}

/**
 * A reference as a short label for a chip in a field: "Find the bill · bill record id",
 * "Trigger · doc id", "Item · amount". Null when the text isn't a reference we know.
 */
export function referenceLabel(expr: string, name: Namer): string {
  const [root, ...rest] = expr.split(".");
  const join = (head: string, tail: readonly string[]) => {
    const what = pathWords(tail);
    return what ? `${head} · ${what}` : head;
  };
  switch (root) {
    case "steps": {
      const [id = "", , ...tail] = rest;
      return join(name(id) ?? "Removed step", tail);
    }
    case "trigger":
      return join("Trigger", rest);
    case "input":
      return join("Input", rest);
    case "item":
      return join("Item", rest);
    case "index":
      return "Item position";
    default:
      return expr;
  }
}

function refsInWords(text: string, name: Namer): string {
  return text.replace(REF, (_, expr: string) => referenceText(expr, name));
}

/** One problem in plain words. */
export function readableProblem(
  e: ValidationError,
  bundle: AgentBundle,
  workflow?: Workflow,
): ReadableProblem {
  // DECISION (merge of main): a Reshape mapping's problem names the mapping's own fields
  // ("invoiceNumber reads input.…"), which its editor shows beside each field: kept as written.
  if (e.code === "reshape_mapping") return { error: e, text: e.message };
  const w = workflow ?? bundle.workflows.find((x) => x.slug === e.workflow)?.workflow;
  const name = stepNamer(w, bundle);
  const lead = /^\{\{\s*([^}]+?)\s*\}\}:\s*(.*)$/s.exec(e.message);
  const expr = lead?.[1];
  const rest = lead?.[2] ?? e.message;
  const uses = expr ? `Uses ${referenceText(expr, name)}` : null;

  // A reference to a step that runs later, on another path, or not at all.
  const order = /^step "(.+)" does not run before this one on its path$/.exec(rest);
  if (expr && order?.[1]) {
    const id = order[1];
    const step = name(id);
    const [, , , ...tail] = expr.split(".");
    const what = pathWords(tail) || "result";
    const text = step
      ? `${uses}, but “${step}” doesn't run before this step. Move this step below “${step}”, on the same path.`
      : `${uses}. That step is no longer in this workflow: pick the value again.`;
    return {
      error: e,
      text,
      group: {
        key: `${e.workflow}:${e.stepId}:order:${id}`,
        what,
        from: step ?? id,
        removed: step === null,
      },
    };
  }

  return { error: e, text: sentence(plainText(rest, uses, expr, name)) };
}

/** Rewords a message that isn't about step order: each rule a pattern and its sentence. */
const USE_RULES: [RegExp, (uses: string, m: RegExpExecArray) => string][] = [
  [/^no field "(.+)"$/, (uses, m) => `${uses}, but there is no ${words(m[1] ?? "")} there`],
  [
    /^"(.+)" is not a field of an? (.+)$/,
    (uses, m) => `${uses}, but it has no ${words(m[1] ?? "")}`,
  ],
  [
    /^\{\{(item|index)\}\} is only available inside a for_each$/,
    (uses) => `${uses}, but this step isn't inside a “For each”`,
  ],
  [
    /^\{\{input\}\} is only available inside an automation$/,
    (uses) => `${uses}, which only an automation has`,
  ],
  [
    /^an automation has no trigger/,
    (uses) => `${uses}, but an automation has no trigger: use its inputs instead`,
  ],
];

const PLAIN_RULES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^"(.+)" is required$/, (m) => `${fieldLabel(m[1] ?? "") ?? m[1]} is required`],
  [/^"(.+)" is not an input of this step$/, (m) => `This step has no ${words(m[1] ?? "")} input`],
];

function plainText(
  rest: string,
  uses: string | null,
  expr: string | undefined,
  name: Namer,
): string {
  if (uses) {
    if (/^unknown reference/.test(rest)) {
      return `Uses “{{${expr}}}”, which isn't a value this step can read`;
    }
    for (const [re, say] of USE_RULES) {
      const m = re.exec(rest);
      if (m) return say(uses, m);
    }
    return `${uses}: ${refsInWords(rest, name)}`;
  }
  for (const [re, say] of PLAIN_RULES) {
    const m = re.exec(rest);
    if (m) return say(m);
  }
  return refsInWords(rest, name)
    .replace(/\bfor_each\b/g, "for each")
    .replace(/\bsteps\.<id>\.output\.\.\./g, "a step's result");
}

/** The problems with their messages in plain words, for every place the builder shows one. */
export function readableErrors(
  errors: readonly ValidationError[],
  bundle: AgentBundle,
): ValidationError[] {
  return errors.map((e) => ({ ...e, message: readableProblem(e, bundle).text }));
}

/** Lists "a, b and c"; more than `max` become "a, b, c and 2 more". */
function list(items: readonly string[], max = 3): string {
  const shown = items.slice(0, max);
  const more = items.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** One line of the problems list: its first error, its words, and every error it stands for. */
export interface ProblemLine {
  error: ValidationError;
  text: string;
  count: number;
  all: ValidationError[];
}

/**
 * The problems as lines: references from one step to the same earlier step become one line
 * ("Uses the invoice number, vendor name and reason from “Match”, but …").
 */
export function problemLines(
  errors: readonly ValidationError[],
  bundle: AgentBundle,
): ProblemLine[] {
  const lines: ProblemLine[] = [];
  const groups = new Map<string, { at: number; whats: string[]; from: string; removed: boolean }>();
  for (const e of errors) {
    const p = readableProblem(e, bundle);
    if (!p.group) {
      lines.push({ error: e, text: p.text, count: 1, all: [e] });
      continue;
    }
    const g = groups.get(p.group.key);
    if (g) {
      if (!g.whats.includes(p.group.what)) g.whats.push(p.group.what);
      const line = lines[g.at];
      if (line) {
        line.count += 1;
        line.all.push(e);
      }
      continue;
    }
    groups.set(p.group.key, {
      at: lines.length,
      whats: [p.group.what],
      from: p.group.from,
      removed: p.group.removed,
    });
    lines.push({ error: e, text: p.text, count: 1, all: [e] });
  }
  for (const g of groups.values()) {
    const line = lines[g.at];
    if (!line || line.count === 1) continue;
    line.text = g.removed
      ? `Uses the ${list(g.whats)} from a step that is no longer in this workflow. Pick those values again.`
      : `Uses the ${list(g.whats)} from “${g.from}”, but “${g.from}” doesn't run before this step. Move this step below “${g.from}”, on the same path.`;
  }
  return lines;
}

/** Where a problem is, for the problems list: the step's name, with its workflow when it's another. */
export function problemPlace(e: ValidationError, bundle: AgentBundle, slug: string): string {
  if (!e.workflow) return "Agent";
  const w = bundle.workflows.find((x) => x.slug === e.workflow);
  if (!w) return e.workflow;
  const prefix = e.workflow === slug ? "" : `${w.name} · `;
  if (w.workflow.triggers.some((t) => t.id === e.stepId)) return `${prefix}Trigger`;
  const owner = e.stepId
    ? (locate(w.workflow, e.stepId)?.step ?? ifOfBranch(w.workflow, e.stepId))
    : null;
  return owner ? `${prefix}${owner.name}` : w.name;
}
