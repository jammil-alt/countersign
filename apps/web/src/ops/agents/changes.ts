// Bundle changes as sentences (ARCHITECTURE §9.3: "fields as sentences; workflows as a step-by-step
// diff"). The API sends core's `diffBundles` output with a label for every entity; this turns each
// change into one line a person can read, with the before and after values when there are any.
import type { BundleChangeView } from "@countersign/core";

export interface ChangeLine {
  /** The change's path: unique within one diff. */
  key: string;
  kind: BundleChangeView["kind"];
  /** What the change is about: "Instructions", "Step “Ask Jammil”", "Workflow “New bill”". */
  subject: string;
  /** The sentence: "Instructions changed", "Added step “Ask Jammil”". */
  text: string;
  before?: string;
  after?: string;
}

const FIELD_LABEL: Record<string, string> = {
  "/definition/identity/name": "Name",
  "/definition/identity/role": "Area",
  "/definition/identity/mission": "Mission",
  "/definition/identity/avatar": "Avatar",
  "/definition/instructions": "Instructions",
  "/definition/model/id": "Model",
  "/definition/model/maxTokens": "Max tokens",
  "/definition/permissions/mode": "Permissions",
  "/definition/permissions/approver": "Default approver",
  "/definition/budgets/maxSteps": "Max steps per run",
  "/definition/budgets/maxCostUsd": "Max cost per run",
  "/definition/memory/enabled": "Memory",
  "/definition/extraTools": "Extra tools",
  "/definition/canCommand": "Agents it may ask",
  "/definition/kind": "Kind",
};

const STEP_KIND: Record<string, string> = {
  skill: "skill step",
  action: "action",
  person: "person step",
  fork: "fork",
  for_each: "for each",
  wait: "wait",
  notify: "notify step",
  stop: "stop",
};

/** `/approval/required` → "approval required"; `/settings/threshold_pct` → "setting threshold_pct". */
function humanPointer(pointer: string): string {
  const parts = pointer
    .split("/")
    .filter(Boolean)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (parts[0] === "settings" && parts[1]) return `setting ${parts.slice(1).join(".")}`;
  if (parts[0] === "workflow" && parts[1] === "trigger") return "trigger";
  if (parts[0] === "when") return "rules";
  return parts
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

/** A value for the before/after line: text as is (shortened), anything else as compact JSON. */
export function showValue(v: unknown, max = 160): string {
  if (v === undefined) return "(not set)";
  if (v === "") return "(empty)";
  if (v === "suggest_only") return "suggest only";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function kindOf(key: string): string {
  return key.slice(0, key.indexOf(":"));
}

/** "Step “Ask Jammil”", "Workflow “New bill”", "Skill custom:price-watch". */
export function entityName(key: string, labels: Record<string, string>, value?: unknown): string {
  const kind = kindOf(key);
  const fromValue =
    value && typeof value === "object" && "name" in value
      ? String((value as { name: unknown }).name)
      : undefined;
  const label = labels[key] ?? fromValue ?? key.slice(key.indexOf(":") + 1);
  switch (kind) {
    case "step": {
      const stepKind =
        value && typeof value === "object" && "kind" in value
          ? STEP_KIND[String((value as { kind: unknown }).kind)]
          : undefined;
      return `${stepKind ? stepKind[0]?.toUpperCase() + stepKind.slice(1) : "Step"} “${label}”`;
    }
    case "workflow":
      return `Workflow “${label}”`;
    case "path":
      return `Fork path “${label}”`;
    case "otherwise":
      return "Otherwise branch";
    case "skill":
      return `Skill ${label}`;
    default:
      return label;
  }
}

/** The owner of a list key (`path:low>steps` → "Fork path “Low”"; `bundle>skills` → "the agent"). */
export function listName(listKey: string, labels: Record<string, string>): string {
  const owner = listKey.slice(0, listKey.lastIndexOf(">"));
  if (owner === "bundle") return listKey.endsWith(">skills") ? "the skills" : "the workflows";
  return entityName(owner, labels);
}

function withValues(line: ChangeLine, c: BundleChangeView): ChangeLine {
  if ("before" in c) line.before = showValue(c.before);
  if ("after" in c) line.after = showValue(c.after);
  return line;
}

export function describeChange(c: BundleChangeView, labels: Record<string, string>): ChangeLine {
  const hash = c.path.indexOf("#");
  const pointer = hash === -1 ? "" : c.path.slice(hash + 1);
  const key = c.path;

  if (c.entity === "bundle") {
    const field = FIELD_LABEL[pointer] ?? humanPointer(pointer.replace(/^\/definition/, ""));
    const subject = field.charAt(0).toUpperCase() + field.slice(1);
    return withValues({ key, kind: c.kind, subject, text: `${subject} changed` }, c);
  }

  switch (c.kind) {
    case "added": {
      const name = entityName(c.entity, labels, c.after);
      return { key, kind: c.kind, subject: name, text: `Added ${lower(name)}` };
    }
    case "removed": {
      const name = entityName(c.entity, labels, c.before);
      return { key, kind: c.kind, subject: name, text: `Removed ${lower(name)}` };
    }
    case "reordered": {
      const name = listName(c.entity, labels);
      return { key, kind: c.kind, subject: name, text: `Reordered the steps in ${lower(name)}` };
    }
    case "moved": {
      const name = entityName(c.entity, labels);
      if (pointer === "@location") {
        const to = typeof c.after === "string" ? listName(c.after, labels) : "another list";
        const from = typeof c.before === "string" ? listName(c.before, labels) : "another list";
        return {
          key,
          kind: c.kind,
          subject: name,
          text: `Moved ${lower(name)} from ${lower(from)} to ${lower(to)}`,
        };
      }
      const before = typeof c.before === "number" ? c.before + 1 : "?";
      const after = typeof c.after === "number" ? c.after + 1 : "?";
      return {
        key,
        kind: c.kind,
        subject: name,
        text: `Moved ${lower(name)} from position ${before} to ${after}`,
      };
    }
    default: {
      const name = entityName(c.entity, labels);
      const what = humanPointer(pointer);
      return withValues(
        { key, kind: c.kind, subject: name, text: `${name}: ${what || "changed"} changed` },
        c,
      );
    }
  }
}

function lower(s: string): string {
  // Keep quoted names and ids as they are; only the leading word is lowercased.
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function describeChanges(
  changes: readonly BundleChangeView[],
  labels: Record<string, string>,
): ChangeLine[] {
  return changes.map((c) => describeChange(c, labels));
}
