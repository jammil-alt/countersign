// The merge view's model (ARCHITECTURE §10.5 "Merge view"): what each side changed against the
// base, per step, fork path and trigger; conflicts in words; the resolutions the operator picked;
// and the agent fields and settings side by side. Pure: the screen re-runs core's mergeBundles
// and validation with these on every change, and the server runs them again on save.
import {
  type AnyAgentBundle,
  type BuilderCatalog,
  type BundleChange,
  diffBundles,
  fromPointer,
  isToolWrapper,
  type MergeConflict,
  parseSkillRef,
  type processes,
  type Resolution,
} from "@countersign/core";
import { describeChange, entityName, listName, showValue } from "../agents/changes";
import { checkValueWords } from "../workflow/checks";
import { triggerTitle } from "../workflow/describe";

/** R8: a bundle the merge view reads: v3 workflows, v4 processes, or both (ARCHITECTURE §10.14). */
type AgentBundle = AnyAgentBundle;

/** The trigger order of a v4 process, as diff and merge key it (core's `TRIGGER_ORDER`). */
const TRIGGER_ORDER = "#/workflow/triggerOrder";

export function isTriggerOrder(path: string): boolean {
  return path.endsWith(TRIGGER_ORDER);
}

/**
 * R8: how the merge view reads stored v3 workflows as v4 when the sides mix them, from the builder
 * catalog the screen already loads: a tool-mode skill that only wraps one tool, and each tool's
 * side effect (core's `ConvertLookup`, as packages/agents builds it from the registries).
 */
// DECISION: the browser builds the lookup from the builder catalog (skills with their definitions,
// tools with their specs) rather than a new route: the catalog is the registries' view for this
// agent, the same the server's convertLookup reads. Unknown ids answer null, the safe side.
export function catalogLookup(
  catalog: Pick<BuilderCatalog, "skills" | "tools">,
): processes.ConvertLookup {
  return {
    wrappedTool(skillId) {
      const s = catalog.skills.find(
        (x) => x.ref === skillId || parseSkillRef(x.ref).id === skillId,
      );
      return s && isToolWrapper(s.definition) ? (s.definition.handler ?? null) : null;
    },
    sideEffect(toolId) {
      return catalog.tools.find((t) => t.id === toolId)?.sideEffect ?? null;
    },
  };
}

/** Each trigger's name by `trigger:<id>`, from every side, for the change and conflict lines. */
export function triggerLabels(...bundles: AgentBundle[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of bundles) {
    for (const w of b.workflows) {
      const triggers =
        w.workflow.schemaVersion === 4
          ? w.workflow.triggers
          : [w.workflow.trigger, ...(w.workflow.moreTriggers ?? [])];
      for (const t of triggers) out[`trigger:${t.id}`] = triggerTitle(t);
    }
  }
  return out;
}

export type Mode = "update" | "promote";
export type Side = "ours" | "theirs";
export type Mark = "added" | "removed" | "changed" | "moved";

/** Who each side is: an update merges the template into the client, a promotion the other way. */
export function sideNames(mode: Mode): Record<Side | "base", string> {
  return mode === "update"
    ? { base: "Template as forked", ours: "This client", theirs: "Template update" }
    : { base: "Template as forked", ours: "Template now", theirs: "Client's changes" };
}

const RANK: Record<Mark, number> = { added: 4, removed: 3, changed: 2, moved: 1 };

/**
 * What a change marks on the step list: a step or path, or (for trigger edits) the trigger. R8: a
 * v4 trigger by its id (`#/workflow/triggers/<id>/…`); a trigger reorder marks each trigger whose
 * place changed as moved.
 */
function markedIds(change: BundleChange, bundle: AgentBundle): [string, Mark][] {
  const colon = change.entity.indexOf(":");
  const kind = change.entity.slice(0, colon);
  const key = change.entity.slice(colon + 1);
  const mark: Mark =
    change.kind === "added" || change.kind === "removed" || change.kind === "moved"
      ? change.kind
      : "changed";
  if (kind === "step" || kind === "path") return [[key, mark]];
  if (kind !== "workflow") return [];
  if (isTriggerOrder(change.path)) {
    const before = Array.isArray(change.before) ? change.before : [];
    const after = Array.isArray(change.after) ? change.after : [];
    return after
      .filter((id, i) => typeof id === "string" && before.includes(id) && before[i] !== id)
      .map((id) => [String(id), "moved"]);
  }
  const v4 = /#\/workflow\/triggers\/([^/]+)/.exec(change.path);
  if (v4?.[1]) return [[v4[1], mark]];
  if (change.path.includes("#/workflow/trigger")) {
    const w = bundle.workflows.find((x) => x.slug === key)?.workflow;
    return w && w.schemaVersion !== 4 ? [[w.trigger.id, mark]] : [];
  }
  return [];
}

/** What one side did to each step, fork path and trigger, the strongest change winning. */
export function sideMarks(changes: readonly BundleChange[], after: AgentBundle): Map<string, Mark> {
  const out = new Map<string, Mark>();
  for (const c of changes) {
    if (c.kind === "reordered") continue;
    for (const [id, mark] of markedIds(c, after)) {
      const had = out.get(id);
      if (!had || RANK[mark] > RANK[had]) out.set(id, mark);
    }
  }
  return out;
}

/** The step, path or trigger id a conflict sits on, if any. */
export function conflictTarget(c: MergeConflict): string | null {
  if (c.entity.startsWith("step:") || c.entity.startsWith("path:")) {
    return c.entity.slice(c.entity.indexOf(":") + 1);
  }
  return null;
}

/** "Instructions", "Step “Confirm”: name", "Step “Ask” was removed on one side…". */
export function conflictText(c: MergeConflict, labels: Record<string, string>): string {
  switch (c.kind) {
    case "field":
      return describeChange(
        { kind: "changed", entity: c.entity, path: c.path },
        labels,
      ).text.replace(/ changed$/, "");
    case "exists":
      return `${entityName(c.entity, labels)} was removed on one side and changed on the other`;
    case "location":
      return `${entityName(c.entity, labels)} was moved to different places`;
    case "order":
      // R8: a v4 process's triggers, reordered differently on each side.
      if (isTriggerOrder(c.path)) {
        return `${entityName(c.entity, labels)}: its triggers were reordered on both sides`;
      }
      return `The steps in ${listName(c.entity, labels).replace(/^[A-Z]/, (x) => x.toLowerCase())} were reordered on both sides`;
  }
}

/** The pointer inside a step a conflict's path names (`step:x#/checks/…` → `/checks/…`). */
function pointerOf(path: string): string {
  const hash = path.indexOf("#");
  return hash === -1 ? "" : path.slice(hash + 1);
}

/** One side's value of a conflict, as words. */
export function conflictValue(
  c: MergeConflict,
  value: unknown,
  labels: Record<string, string>,
): string {
  switch (c.kind) {
    case "field": {
      // R8: checks and deadlines read in words ("Dana · 2 days, then client admin").
      const pointer = pointerOf(c.path);
      const words = c.entity.startsWith("step:") ? checkValueWords(pointer, value) : null;
      return words ?? showValue(value);
    }
    case "exists":
      return value === undefined ? "Removed" : "Kept, with changes";
    case "location":
      return typeof value === "string" ? listName(value, labels) : "(not there)";
    case "order":
      return Array.isArray(value)
        ? value
            .map((k) =>
              isTriggerOrder(c.path)
                ? (labels[`trigger:${String(k)}`] ?? String(k))
                : (labels[String(k)] ?? String(k)),
            )
            .join(" → ")
        : "(not there)";
  }
}

/** The choices a conflict offers (base only where it differs from both sides). */
export function conflictChoices(c: MergeConflict): ("ours" | "theirs" | "base")[] {
  const out: ("ours" | "theirs" | "base")[] = ["ours", "theirs"];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (
    (c.kind === "field" || c.kind === "order") &&
    !same(c.base, c.ours) &&
    !same(c.base, c.theirs)
  ) {
    out.push("base");
  }
  return out;
}

/** Only the resolutions that settle one of these conflicts (stale ones are dropped). */
export function activeResolutions(
  conflicts: readonly MergeConflict[],
  picked: Readonly<Record<string, Resolution>>,
): Resolution[] {
  return conflicts.flatMap((c) => (picked[c.path] ? [picked[c.path] as Resolution] : []));
}

// ── Agent fields and settings side by side ─────────────────────────────────────────────────────

export interface FieldRow {
  path: string;
  label: string;
  base: string;
  ours: string | null;
  theirs: string | null;
  result: string;
  conflict: boolean;
  /** The conflict is still unresolved. */
  waiting: boolean;
}

function readPointer(value: unknown, pointer: string): unknown {
  let cur = value;
  for (const seg of fromPointer(pointer)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** The value at a change path (`bundle#/…` or `skill:<id>#/…`) in a bundle. */
export function valueAt(bundle: AgentBundle, path: string): unknown {
  const hash = path.indexOf("#");
  const entity = hash === -1 ? path : path.slice(0, hash);
  const pointer = hash === -1 ? "" : path.slice(hash + 1);
  if (entity === "bundle") return readPointer(bundle, pointer);
  if (entity.startsWith("skill:")) {
    const id = entity.slice("skill:".length);
    const skill = bundle.definition.skills.find((s) => parseSkillRef(s.skill).id === id);
    return skill ? readPointer(skill, pointer) : undefined;
  }
  return undefined;
}

/**
 * Rows for the agent's own fields and its skills' settings that either side changed: the base
 * value, each side's (null where that side left it), the merged result, and whether it conflicts.
 */
export function fieldRows(input: {
  base: AgentBundle;
  ours: AgentBundle;
  theirs: AgentBundle;
  merged: AgentBundle;
  conflicts: readonly MergeConflict[];
  /** Conflicts still unresolved: their merged value is a placeholder, not a decision. */
  open?: readonly MergeConflict[];
  labels: Record<string, string>;
}): FieldRow[] {
  const isField = (c: BundleChange) =>
    c.entity === "bundle" || (c.entity.startsWith("skill:") && c.kind !== "reordered");
  const ours = diffBundles(input.base, input.ours).filter(isField);
  const theirs = diffBundles(input.base, input.theirs).filter(isField);
  const paths = [...new Set([...ours, ...theirs].map((c) => c.path))];
  const shown = (bundle: AgentBundle, path: string, added: boolean) => {
    if (!path.includes("#")) return added ? "Added" : "Removed";
    return showValue(valueAt(bundle, path));
  };
  return paths.map((path) => {
    const o = ours.find((c) => c.path === path);
    const t = theirs.find((c) => c.path === path);
    const any = (o ?? t) as BundleChange;
    const label = path.includes("#")
      ? describeChange(any, input.labels).text.replace(/ changed$/, "")
      : entityName(any.entity, input.labels);
    const inMerged =
      path.includes("#") ||
      input.merged.definition.skills.some((s) => `skill:${parseSkillRef(s.skill).id}` === path);
    return {
      path,
      label,
      base: path.includes("#")
        ? showValue(valueAt(input.base, path))
        : any.kind === "added"
          ? "(not there)"
          : "There",
      ours: o ? shown(input.ours, path, o.kind === "added") : null,
      theirs: t ? shown(input.theirs, path, t.kind === "added") : null,
      waiting: (input.open ?? []).some((c) => c.path === path),
      result: (input.open ?? []).some((c) => c.path === path)
        ? "Waiting on you"
        : path.includes("#")
          ? showValue(valueAt(input.merged, path))
          : inMerged
            ? "Kept"
            : "Not there",
      conflict: input.conflicts.some(
        (c) => c.path === path || (c.entity === path && c.kind === "exists"),
      ),
    };
  });
}

/** Steps and fork paths a side removed that the merged bundle no longer has. */
export function removedSteps(
  changes: readonly BundleChange[],
  merged: AgentBundle,
  labels: Record<string, string>,
): { key: string; name: string }[] {
  const present = new Set<string>();
  type Node = {
    id: string;
    kind: string;
    steps?: Node[];
    paths?: { id: string; steps: Node[] }[];
    otherwise?: { steps: Node[] };
  };
  const visit = (steps: readonly Node[]) => {
    for (const s of steps) {
      present.add(`step:${s.id}`);
      // A v3 fork or a v4 if.
      if ((s.kind === "fork" || s.kind === "if") && s.paths && s.otherwise) {
        for (const p of s.paths) {
          present.add(`path:${p.id}`);
          visit(p.steps);
        }
        visit(s.otherwise.steps);
      }
      if (s.kind === "for_each" && s.steps) visit(s.steps);
    }
  };
  for (const w of merged.workflows) visit(w.workflow.steps as unknown as Node[]);
  return changes
    .filter(
      (c) => c.kind === "removed" && (c.entity.startsWith("step:") || c.entity.startsWith("path:")),
    )
    .filter((c) => !present.has(c.entity))
    .map((c) => ({ key: c.entity, name: entityName(c.entity, labels, c.before) }));
}
