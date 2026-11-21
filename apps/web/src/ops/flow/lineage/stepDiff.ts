// A client agent's step against its template's (docs/builder-plan.md §12.1: "its own copy, marked
// Customized and Added against the template"): what differs, a line per setting in plain words
// ("Approval: Ask first → On its own", "Skill version 3 → 4", "Name: “Ask” → “Ask Jammil”"), and
// "Put back the template's step". Both read the comparison `customizedSteps` uses: a step with its
// nested steps as ids (`shallow` in ../../builder/model), so a nested step's edit is its own.
import { canonicalJson, parseSkillRef, processes } from "@countersign/core";
import {
  findTemplateStep,
  locate,
  type Process,
  replaceStep,
  type Step,
  shallow,
} from "../../builder/model";
import { checksLines, deadlineWords, whoWords } from "../../workflow/checks";
import { PROCESS_KIND_LABEL } from "../../workflow/describe";

export interface DiffLine {
  /** The setting that differs: `name`, `checks.approval`, `skill`, `paths.<id>`. */
  field: string;
  text: string;
}

type Fields = Record<string, unknown>;

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

const isRecord = (v: unknown): v is Fields =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const scalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** A value as it is written, with the braces of a reference left out. */
function say(v: unknown): string {
  if (v === undefined || v === null || v === "") return "not set";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v)
    .replace(/\{\{\s*|\s*\}\}/g, "")
    .replace(/_/g, " ");
}

const arrow = (label: string, a: string, b: string) => `${label}: ${a} → ${b}`;

/** Settings whose values read well as they are. */
const LABELS: Record<string, string> = {
  tool: "Tool",
  process: "Automation",
  agent: "Agent",
  via: "Connection",
  mode: "Asks for",
  title: "Question",
  channel: "Channel",
  onReject: "If the answer is no",
  onError: "If it fails",
  for: "Waits",
  status: "Ends as",
  over: "List",
  concurrency: "At a time",
  maxTimes: "Tries",
  between: "Between tries",
  onLimit: "After the last try",
  with: "Talks with",
  goal: "Goal",
  maxTurns: "Turns",
  decide: "Decided by",
  ifUnsure: "If unsure",
  need: "What it needs",
  fill: "Filled by",
};

/** Settings shown by name only: their values are data, not words. */
const NAMES: Record<string, string> = {
  input: "Input",
  payload: "What it shows",
  settings: "Settings",
  find: "What it finds out",
  show: "What it shows",
  action: "What it writes",
  customize: "Skill instructions",
  reshape: "Field mapping",
  client: "What the client sees",
  review: "Review",
  choices: "Choices",
  mayShare: "What it may share",
  messages: "Message approval",
  approvals: "Approvals inside",
  until: "Until",
  to: "Hands off to",
  notify: "Notice",
};

/** "mayShare" → "May share", for a setting with no words of its own. */
function humanize(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The keys of a record that differ between two versions of it. */
function changedKeys(a: unknown, b: unknown): string[] {
  const x = isRecord(a) ? a : {};
  const y = isRecord(b) ? b : {};
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => !same(x[k], y[k]));
}

const approvalWord = (a: processes.ApprovalCheck | undefined) =>
  a?.required === "not_required" ? "On its own" : "Ask first";

function presence(label: string, a: unknown, b: unknown): string {
  if (a === undefined || a === null) return `${label}: added`;
  if (b === undefined || b === null) return `${label}: removed`;
  return `${label}: changed`;
}

function checksDiff(a: processes.Checks | undefined, b: processes.Checks | undefined): DiffLine[] {
  const out: DiffLine[] = [];
  if (!same(a?.approval, b?.approval)) {
    const was = approvalWord(a?.approval);
    const now = approvalWord(b?.approval);
    if (was !== now) {
      out.push({ field: "checks.approval", text: arrow("Approval", was, now) });
    } else {
      // Who approves, how long they have, what happens with no answer: in the read-only words.
      const line = (c: processes.ApprovalCheck | undefined) =>
        c ? (checksLines({ approval: c })[0] ?? "").replace(/^Approval[^:]*: /, "") : "the default";
      const [x, y] = [line(a?.approval), line(b?.approval)];
      out.push({
        field: "checks.approval",
        text: x !== y ? arrow("Approval", x, y) : "Approval: when it applies",
      });
    }
  }
  if (!same(a?.confer, b?.confer)) {
    out.push({ field: "checks.confer", text: presence("Second check", a?.confer, b?.confer) });
  }
  if (!same(a?.notify, b?.notify)) {
    out.push({ field: "checks.notify", text: presence("Notices", a?.notify, b?.notify) });
  }
  return out;
}

interface ShallowPath {
  id: string;
  name: string;
  when: unknown;
  steps: string[];
}

function pathsDiff(a: ShallowPath[], b: ShallowPath[]): DiffLine[] {
  const out: DiffLine[] = [];
  const before = new Map(a.map((p) => [p.id, p]));
  const after = new Map(b.map((p) => [p.id, p]));
  for (const p of b) {
    const was = before.get(p.id);
    const field = `paths.${p.id}`;
    if (!was) {
      out.push({ field, text: `Path added: “${p.name}”` });
      continue;
    }
    if (was.name !== p.name) {
      out.push({
        field: `${field}.name`,
        text: arrow("Path name", `“${was.name}”`, `“${p.name}”`),
      });
    }
    if (!same(was.when, p.when)) {
      out.push({ field: `${field}.when`, text: `Path “${p.name}”: when it is taken` });
    }
    if (!same(was.steps, p.steps)) {
      out.push({ field: `${field}.steps`, text: `Path “${p.name}”: the steps on it` });
    }
  }
  for (const p of a) {
    if (!after.has(p.id)) out.push({ field: `paths.${p.id}`, text: `Path removed: “${p.name}”` });
  }
  const kept = (list: ShallowPath[], other: Map<string, ShallowPath>) =>
    list.filter((p) => other.has(p.id)).map((p) => p.id);
  if (!same(kept(a, after), kept(b, before))) {
    out.push({ field: "paths", text: "Paths: their order" });
  }
  return out;
}

/**
 * What a client agent's step changed against the template's step, a line per setting. Empty when
 * the step is not in the template (it was added) or says the same.
 */
export function stepDiff(step: Step, templateStep: Step | undefined): DiffLine[] {
  if (!templateStep) return [];
  const a = shallow(templateStep) as Fields;
  const b = shallow(step) as Fields;
  const out: DiffLine[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const [was, now] = [a[key], b[key]];
    if (key === "id" || same(was, now)) continue;
    switch (key) {
      case "name":
        out.push({
          field: key,
          text: arrow("Name", `“${String(was ?? "")}”`, `“${String(now ?? "")}”`),
        });
        break;
      case "kind":
        out.push({
          field: key,
          text: arrow(
            "Kind",
            PROCESS_KIND_LABEL[templateStep.kind] ?? say(was),
            PROCESS_KIND_LABEL[step.kind] ?? say(now),
          ),
        });
        break;
      case "skill": {
        const [x, y] = [parseSkillRef(String(was ?? "")), parseSkillRef(String(now ?? ""))];
        out.push({
          field: key,
          text:
            x.id === y.id && x.version !== null && y.version !== null
              ? `Skill version ${x.version} → ${y.version}`
              : arrow("Skill", x.id || "not set", y.id || "not set"),
        });
        break;
      }
      case "checks":
        out.push(
          ...checksDiff(was as processes.Checks | undefined, now as processes.Checks | undefined),
        );
        break;
      case "deadline": {
        const words = (d: unknown) => (d ? deadlineWords(d as processes.Deadline) : "none");
        out.push({ field: key, text: arrow("Deadline", words(was), words(now)) });
        break;
      }
      case "assignee":
        out.push({
          field: key,
          text: arrow("Who", whoWords(String(was ?? "")), whoWords(String(now ?? ""))),
        });
        break;
      case "model": {
        const id = (m: unknown) => (isRecord(m) && scalar(m.id) ? String(m.id) : "the default");
        out.push({
          field: key,
          text: id(was) !== id(now) ? arrow("Model", id(was), id(now)) : "Model: its limits",
        });
        break;
      }
      case "paths":
        out.push(...pathsDiff((was ?? []) as ShallowPath[], (now ?? []) as ShallowPath[]));
        break;
      case "otherwise":
        out.push({ field: key, text: "Otherwise: the steps on it" });
        break;
      case "steps":
        out.push({ field: key, text: "The steps inside" });
        break;
      default: {
        const label = LABELS[key];
        if (label && (scalar(was) || was === undefined) && (scalar(now) || now === undefined)) {
          out.push({ field: key, text: arrow(label, say(was), say(now)) });
          break;
        }
        const name = NAMES[key] ?? label ?? humanize(key);
        const keys = isRecord(was) || isRecord(now) ? changedKeys(was, now) : [];
        out.push({
          field: key,
          text: keys.length > 0 && keys.length <= 4 ? `${name}: ${keys.join(", ")}` : name,
        });
      }
    }
  }
  return out;
}

/** Every step id under these steps, at any depth. */
function idsWithin(steps: readonly Step[]): Set<string> {
  return new Set(processes.allSteps({ steps: [...steps] }).map((l) => l.step.id));
}

/**
 * The template's step as it goes back into the client's process: the template's own settings, the
 * id kept, and the steps inside left as the client has them (they are steps of their own, each
 * with its own mark). A path the client removed comes back with the template's steps, without
 * any the client now keeps somewhere else; a path the client added stays, with its steps.
 */
function restored(process: Process, current: Step, template: Step): Step {
  if (template.kind === "if" && current.kind === "if") {
    const mine = new Map(current.paths.map((p) => [p.id, p]));
    const elsewhere = idsWithin(process.steps);
    const fromTemplate = template.paths.map((p) => {
      const kept = mine.get(p.id);
      return {
        ...p,
        steps: kept ? kept.steps : p.steps.filter((s) => !elsewhere.has(s.id)),
      };
    });
    const theirs = new Set(template.paths.map((p) => p.id));
    return {
      ...template,
      paths: [...fromTemplate, ...current.paths.filter((p) => !theirs.has(p.id))],
      otherwise: { ...template.otherwise, steps: current.otherwise.steps },
    };
  }
  if (
    (template.kind === "for_each" || template.kind === "repeat") &&
    (current.kind === "for_each" || current.kind === "repeat")
  ) {
    return { ...template, steps: current.steps };
  }
  return template;
}

/**
 * "Put back the template's step": the client's process with this step's own settings as the
 * template has them, under the same id (invariant 3: ids are never regenerated). An ordinary edit
 * of the client's draft; the host saves it as the client agent's own new version. Null when the
 * step is not in the template or already says what the template says.
 */
export function putBackStep(
  process: Process,
  template: Process | undefined,
  id: string,
): Process | null {
  const current = locate(process, id)?.step;
  const was = findTemplateStep(template, id);
  if (!current || !was) return null;
  // A step that holds steps can only take the settings of the same kind of step.
  const holds = (s: Step) => s.kind === "if" || s.kind === "for_each" || s.kind === "repeat";
  if ((holds(current) || holds(was)) && current.kind !== was.kind) return null;
  const next = restored(process, current, was);
  if (same(shallow(next), shallow(current))) return null;
  return replaceStep(process, id, next);
}
