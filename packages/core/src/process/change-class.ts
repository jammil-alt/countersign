// v0.17 (ARCHITECTURE §10.15 "Every change is suggested and approved", docs/plan.md §1.96, O8):
// the class of a drafted change to a process, computed by code from the two bundles, never by a
// model. `never`: it loosens or widens (an approval made not required or removed, a check removed,
// a new write step or write tool, new tools, a changed mode or permissions, the owner's limits
// raised); an owner never drafts one. `process`: anything else that changes the process; the
// operator approves it. `none`: nothing changed. The client's own settings (people, hours,
// channels) are not in a bundle: their drafts are the client admin's to sign (account changes).

export type ChangeClass = "none" | "process" | "never";

export interface ChangeClassResult {
  class: ChangeClass;
  /** Why, in plain words, one line each (empty for `none`). */
  reasons: string[];
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every step object in a bundle's workflows, by id, at any depth (branches, loops, routes). */
function stepsOf(bundle: unknown): Map<string, Json> {
  const out = new Map<string, Json>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (!isObject(v)) return;
    if (typeof v.id === "string" && typeof v.kind === "string") out.set(v.id, v);
    for (const x of Object.values(v)) visit(x);
  };
  visit(isObject(bundle) ? bundle.workflows : undefined);
  return out;
}

/** A step's approval setting: its own `approval.required`, or a v4 check's; default required. */
function approvalOf(step: Json): string | null {
  const own = isObject(step.approval) ? step.approval.required : undefined;
  const checks =
    isObject(step.checks) && isObject(step.checks.approval) ? step.checks.approval : null;
  const v4 = checks ? (checks.required ?? "required") : undefined;
  const value = own ?? v4;
  return typeof value === "string" ? value : null;
}

const WRITE_KINDS = new Set(["action", "write"]);

function definitionOf(bundle: unknown): Json {
  return isObject(bundle) && isObject(bundle.definition) ? bundle.definition : {};
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The class of the change from `before` to `after` (two bundles of the same process). */
export function classifyChange(before: unknown, after: unknown): ChangeClassResult {
  const reasons: string[] = [];
  const never = (why: string) => reasons.push(why);
  const was = stepsOf(before);
  const now = stepsOf(after);

  for (const [id, step] of now) {
    const old = was.get(id);
    if (!old) {
      if (WRITE_KINDS.has(String(step.kind))) never(`adds a write step "${id}"`);
      continue;
    }
    const a = approvalOf(old);
    const b = approvalOf(step);
    if (a !== "not_required" && b === "not_required")
      never(`makes "${id}"'s approval not required`);
    if (
      isObject(old.checks) &&
      isObject(old.checks.approval) &&
      !(isObject(step.checks) && isObject(step.checks.approval))
    ) {
      never(`removes "${id}"'s approval check`);
    }
    if (
      isObject(old.checks) &&
      isObject(old.checks.confer) &&
      !(isObject(step.checks) && isObject(step.checks.confer))
    ) {
      never(`removes "${id}"'s second check`);
    }
    if (step.kind !== old.kind && WRITE_KINDS.has(String(step.kind)))
      never(`turns "${id}" into a write`);
    if (old.tool !== step.tool && WRITE_KINDS.has(String(step.kind)))
      never(`changes the tool "${id}" writes with`);
  }

  const d0 = definitionOf(before);
  const d1 = definitionOf(after);
  const tools0 = new Set(Array.isArray(d0.extraTools) ? d0.extraTools.map(String) : []);
  for (const t of Array.isArray(d1.extraTools) ? d1.extraTools.map(String) : []) {
    if (!tools0.has(t)) never(`adds the tool ${t}`);
  }
  if (!same(d0.permissions, d1.permissions)) never("changes the agent's mode or permissions");
  const o0 = isObject(d0.oversight) ? d0.oversight : {};
  const o1 = isObject(d1.oversight) ? d1.oversight : {};
  if (Number(o1.maxPerRun ?? 0) > Number(o0.maxPerRun ?? 0))
    never("raises the owner's interventions per run");
  if (Number(o1.maxCostUsd ?? 0) > Number(o0.maxCostUsd ?? 0))
    never("raises the owner's cost per run");

  if (reasons.length > 0) return { class: "never", reasons };
  if (same(before, after)) return { class: "none", reasons: [] };
  return { class: "process", reasons: ["changes the process without loosening anything"] };
}
