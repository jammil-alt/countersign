// v0.19 (ARCHITECTURE §10.15 "Every change is suggested and approved", docs/plan.md §1.117, O8):
// the class of a drafted change to a process, computed by code from the two bundles, never by a
// model. `never`: it loosens or widens, or it may (an owner never drafts one); `process`: every
// change in it is known not to loosen anything, and the operator approves it; `none`: nothing
// changed. The client's own settings (people, hours, channels) are not in a bundle: their drafts
// are the client admin's to sign (account changes).
//
// Audit 5.11: the class is read from the whole bundle diff (core's `diffFlat`, the one the version
// history and merge view show), change by change. A change is `process` only when a rule below
// knows it is safe: a renamed step, a step's input while its writes stay approved, a tighter or
// added check, a new step that doesn't write, a lower limit, a removed trigger, tool or skill.
// Everything else is `never`.
// DECISION: unknown means loosening. A false "loosens" only asks for the operator's review; a
// false "safe" would skip it.

import { type BundleChange, diffFlat } from "../bundle/diff";
import { type FlatBundle, flattenBundle, ROOT, TRIGGER_ORDER } from "../bundle/flatten";
import { deepEqual, isPlainObject } from "../json";
import { Decimal } from "../money";
import type { AgentBundle } from "../schemas/agent";

export type ChangeClass = "none" | "process" | "never";

export interface ChangeClassResult {
  class: ChangeClass;
  /** Why, in plain words, one line each (empty for `none`). */
  reasons: string[];
}

type Json = Record<string, unknown>;

const WRITE_KINDS = new Set(["action", "write"]);
/**
 * Step kinds that, added new, write nothing to a client's tool and reach nobody outside the
 * client. A conversation, a sub-process, a hand-off or a v3 automation may, so they are `never`.
 */
const QUIET_KINDS = new Set([
  "read",
  "skill",
  "person",
  "notify",
  "wait",
  "stop",
  "if",
  "fork",
  "for_each",
  "repeat",
  "missing",
]);
/** A step's fields whose text only names or labels it. */
const TEXT_KEYS = new Set(["name", "title", "description", "need"]);

const obj = (v: unknown): Json => (isPlainObject(v) ? v : {});

/** A step's approval setting: its own `approval.required`, or a v4 check's; default required. */
function approvalOf(step: Json): string | null {
  const own = isPlainObject(step.approval) ? step.approval.required : undefined;
  const check = obj(step.checks).approval;
  const v4 = isPlainObject(check) ? (check.required ?? "required") : undefined;
  const value = own ?? v4;
  return typeof value === "string" ? value : null;
}

/** JSON pointer segments, unescaped. */
function segments(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

const isPrefix = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length <= b.length && a.every((x, i) => deepEqual(x, b[i]));

const subset = (after: unknown, before: unknown) =>
  Array.isArray(after) &&
  Array.isArray(before) &&
  after.every((x) => before.some((y) => deepEqual(x, y)));

/** `after` is a lower number or decimal than `before` (money compared as decimals). */
function lower(after: unknown, before: unknown): boolean {
  if (after === undefined || before === undefined) return false;
  try {
    return new Decimal(String(after)).lt(new Decimal(String(before)));
  } catch {
    return false;
  }
}

/** An approval check that holds on every run and stops when nobody answers or someone rejects. */
function fullApproval(check: unknown): boolean {
  if (!isPlainObject(check)) return false;
  return (
    check.required !== "not_required" &&
    check.when === undefined &&
    (check.ifNoAnswer === undefined || check.ifNoAnswer === "stop") &&
    (check.onReject === undefined || check.onReject === "stop")
  );
}

/** Checks added where there were none: each must be a full approval, a confer or a notice. */
function addedChecksTighten(checks: unknown): boolean {
  if (!isPlainObject(checks)) return false;
  return Object.entries(checks).every(([k, v]) => {
    if (v === undefined) return true;
    if (k === "approval") return fullApproval(v);
    return k === "confer" || k === "notify";
  });
}

/**
 * The same, but for conditions (`when`) left out: a check without its condition applies on every
 * run, so it only ever asks more (review of 5.10: the promotion scrub drops a check's condition
 * that names a client's records).
 */
function fewerConditions(before: unknown, after: unknown, key?: string): boolean {
  if (key === "when" && after === undefined) return true;
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.length === after.length && before.every((b, i) => fewerConditions(b, after[i]));
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].every((k) =>
      fewerConditions(before[k], after[k], k),
    );
  }
  return deepEqual(before, after);
}

/** A rule that never holds: its field in an empty list. */
const neverHolds = (rule: unknown) =>
  isPlainObject(rule) && rule.op === "in" && Array.isArray(rule.value) && rule.value.length === 0;

/**
 * A rule list where each rule is as it was or now never holds: whether the list is matched
 * `all` or `any`, it holds on fewer runs, never more.
 */
function narrowerRules(before: unknown, after: unknown): boolean {
  return (
    Array.isArray(before) &&
    Array.isArray(after) &&
    before.length === after.length &&
    before.every(
      (b, i) =>
        deepEqual(b, after[i]) ||
        (neverHolds(after[i]) && isPlainObject(b) && deepEqual(b.field, obj(after[i]).field)),
    )
  );
}

/** Whether one field change of a step (old and new contents, pointer into it) is safe. */
function safeStepField(old: Json, now: Json, change: BundleChange, at: string[]): boolean {
  const { before, after } = change;
  const [head, second, third] = at;
  // The step's own name, title or label (or one language of it).
  if (head !== undefined && TEXT_KEYS.has(head) && after !== undefined) return true;
  if (head === "client" && second === "label" && after !== undefined) return true;
  // What a step reads or is given, while every write it makes stays approved.
  if (head === "input" || head === "payload") {
    return (
      approvalOf(now) !== "not_required" && old.kind !== "process" && old.kind !== "use_automation"
    );
  }
  // A check's (or a notice's, or an inner approval's) condition left out.
  if (
    ((head === "checks" && (second === "confer" || second === "notify")) ||
      head === "approvals" ||
      head === "notify") &&
    fewerConditions(before, after, at.at(-1))
  ) {
    return true;
  }
  if (head === "review") return after === "always";
  if (head === "onError") return after === undefined || after === "fail";
  if (head === "approval" && second === "required" && at.length === 2) return after === "required";
  if (head !== "checks") return false;
  if (second === undefined) return before === undefined && addedChecksTighten(after);
  if (second === "confer") return before === undefined && isPlainObject(after) && !third;
  if (second === "notify") {
    return (
      at.length === 2 &&
      ((before === undefined && Array.isArray(after)) ||
        (Array.isArray(before) && Array.isArray(after) && isPrefix(before, after)))
    );
  }
  if (second !== "approval") return false;
  if (third === undefined) return before === undefined && fullApproval(after);
  if (at.length !== 3) return false;
  switch (third) {
    case "required":
      return after === "required";
    case "when":
      return after === undefined;
    case "ifNoAnswer":
    case "onReject":
      return after === "stop";
    case "mode":
      // `any` lets one person sign alone; `in_turn` and `all` ask everyone.
      return after === "in_turn" || after === "all";
    case "approvers": {
      // One more approver at the end, where everyone signs; never fewer or other people.
      const mode = obj(obj(now.checks).approval).mode ?? "in_turn";
      return mode !== "any" && Array.isArray(before) && Array.isArray(after)
        ? isPrefix(before, after)
        : false;
    }
    default:
      return false;
  }
}

/** Why a field change of a step loosens or may, in the words the operator reads. */
function stepReason(id: string, old: Json, now: Json, at: string[], after: unknown): string {
  const [head, second, third] = at;
  if (head === "kind" && WRITE_KINDS.has(String(now.kind))) return `turns "${id}" into a write`;
  if (head === "tool" && WRITE_KINDS.has(String(now.kind))) {
    return `changes the tool "${id}" writes with`;
  }
  if (approvalOf(old) !== "not_required" && approvalOf(now) === "not_required") {
    return `makes "${id}"'s approval not required`;
  }
  if (head === "checks" && second === "approval" && third === undefined && after === undefined) {
    return `removes "${id}"'s approval check`;
  }
  if (head === "checks" && second === "confer" && third === undefined && after === undefined) {
    return `removes "${id}"'s second check`;
  }
  if (head === "checks" && second === undefined) return `changes "${id}"'s checks`;
  if (head === "checks" && second === "approval" && third === "approvers") {
    return `changes who approves "${id}"`;
  }
  if (head === "checks" && second === "approval") return `changes "${id}"'s approval`;
  return `changes "${id}" (${at.join(".") || "the step"})`;
}

/** A step added new: quiet, its writes approved, run by this agent. */
function quietNewStep(step: Json): boolean {
  if (!QUIET_KINDS.has(String(step.kind))) return false;
  if (approvalOf(step) === "not_required") return false;
  if (step.agent !== undefined) return false;
  const approval = obj(step.checks).approval;
  return approval === undefined || fullApproval(approval);
}

/** The step key that owns a path or `otherwise` entity, from the list it is in. */
function ownerOf(flat: FlatBundle, key: string): string {
  const list = flat.entities.get(key)?.list ?? "";
  const i = list.indexOf(">");
  return i > 0 ? list.slice(0, i) : "";
}

const nameOf = (key: string) => key.slice(key.indexOf(":") + 1);

/** Why one field change loosens or may; null when it is known to be safe. */
function changedReason(
  a: FlatBundle,
  b: FlatBundle,
  c: BundleChange,
  kind: string,
  at: string[],
): string | null {
  const { before, after } = c;
  const id = nameOf(c.entity);
  if (kind === "step") {
    const old = obj(a.entities.get(c.entity)?.content);
    const now = obj(b.entities.get(c.entity)?.content);
    return safeStepField(old, now, c, at) ? null : stepReason(id, old, now, at, after);
  }
  if (kind === "path") return at[0] === "name" ? null : `changes when "${id}" is taken`;
  if (kind === "workflow") {
    const [head, second, third] = at;
    if (head === "name" && at.length === 1) return null;
    if (head === "enabled") return after === false ? null : `turns on the process ${id}`;
    if (head === "workflow" && second === "triggers" && third !== undefined) {
      if (at.length === 3 && after === undefined) return null;
      // A filter whose rules now hold on fewer deliveries starts fewer runs.
      if (at.at(-2) === "filter" && at.at(-1) === "rules" && narrowerRules(before, after)) {
        return null;
      }
      return `changes or adds the trigger ${third}`;
    }
    if (head === "workflow" && second === TRIGGER_ORDER && subset(after, before)) return null;
    return `changes the process ${id} (${at.join(".")})`;
  }
  if (kind === "skill") return `changes the skill ${id}`;
  if (c.entity !== ROOT) return `changes ${c.entity}`;
  const [head, second, third] = at;
  if (head !== "definition") return `changes the agent (${at.join(".")})`;
  switch (second) {
    case "instructions":
    case "identity":
      return null;
    case "extraTools": {
      if (subset(after, before)) return null;
      const had = Array.isArray(before) ? before : [];
      const added = (Array.isArray(after) ? after : []).find((t) => !had.includes(t));
      return added === undefined ? "changes the agent's tools" : `adds the tool ${String(added)}`;
    }
    case "canCommand":
      return subset(after, before) ? null : "lets the agent ask another agent";
    case "permissions":
      return "changes the agent's mode or permissions";
    case "budgets":
      return lower(after, before) ? null : "raises the agent's limits";
    case "memory":
      return third === "enabled" && after === false ? null : "changes the agent's memory";
    case "oversight":
      if (third === "maxPerRun") {
        return lower(after, before) ? null : "raises the owner's interventions per run";
      }
      if (third === "maxCostUsd") {
        return lower(after, before) ? null : "raises the owner's cost per run";
      }
      return "changes the owner's oversight";
    default:
      return `changes the agent (${at.slice(1).join(".")})`;
  }
}

function reasonsFor(a: FlatBundle, b: FlatBundle, changes: readonly BundleChange[]): string[] {
  const reasons: string[] = [];
  const added = new Set(changes.filter((c) => c.kind === "added").map((c) => c.entity));
  for (const c of changes) {
    const kind = c.entity.split(":")[0] ?? "";
    const id = nameOf(c.entity);
    switch (c.kind) {
      case "added": {
        if (kind === "step") {
          const step = obj(b.entities.get(c.entity)?.content);
          if (WRITE_KINDS.has(String(step.kind))) reasons.push(`adds a write step "${id}"`);
          else if (!quietNewStep(step)) reasons.push(`adds the step "${id}"`);
        } else if (kind === "path" || kind === "otherwise") {
          // A new branch in a step that was there routes some runs past what it did before.
          const owner = ownerOf(b, c.entity);
          if (!added.has(owner)) reasons.push(`adds a branch to "${nameOf(owner)}"`);
        } else if (kind === "skill") reasons.push(`adds the skill ${id}`);
        else if (kind === "workflow") reasons.push(`adds the process ${id}`);
        else reasons.push(`adds ${c.entity}`);
        break;
      }
      case "removed":
        // Fewer skills, processes or People roles reach less; a step or a branch gone may be a
        // check gone (a process's steps are removed with it).
        if (kind === "step") reasons.push(`removes the step "${id}"`);
        else if (kind === "path" || kind === "otherwise") {
          reasons.push(`removes a branch of "${nameOf(ownerOf(a, c.entity))}"`);
        } else if (kind !== "skill" && kind !== "person" && kind !== "workflow") {
          reasons.push(`removes ${c.entity}`);
        }
        break;
      case "moved":
        reasons.push(`moves the step "${id}"`);
        break;
      case "reordered":
        // The order of skills, processes or People roles changes nothing that runs.
        if (
          c.entity !== `${ROOT}>skills` &&
          c.entity !== `${ROOT}>workflows` &&
          c.entity !== `${ROOT}>people`
        ) {
          reasons.push("changes the order of steps");
        }
        break;
      case "changed": {
        const at = segments(c.path.slice(c.path.indexOf("#") + 1));
        const why = changedReason(a, b, c, kind, at);
        if (why) reasons.push(why);
        break;
      }
    }
  }
  return reasons;
}

/**
 * The class of the change from `before` to `after` (two versions of the same agent).
 */
export function classifyChange(before: unknown, after: unknown): ChangeClassResult {
  let a: FlatBundle;
  let b: FlatBundle;
  try {
    a = flattenBundle(before as AgentBundle);
    b = flattenBundle(after as AgentBundle);
  } catch {
    // Two versions that can't be read side by side are reviewed whole.
    return deepEqual(before, after)
      ? { class: "none", reasons: [] }
      : { class: "never", reasons: ["changes the agent in a way we can't compare"] };
  }
  const changes = diffFlat(a, b);
  if (changes.length === 0) return { class: "none", reasons: [] };
  const reasons = [...new Set(reasonsFor(a, b, changes))];
  if (reasons.length > 0) return { class: "never", reasons };
  return { class: "process", reasons: ["changes the process without loosening anything"] };
}
