import { cloneJson } from "../json";
import type { Step as ProcessStep } from "../process/schema";
import type { AgentBundle, AnyAgentBundle } from "../schemas/agent";
import { parseSkillRef } from "../schemas/common";
import type { Trigger, Step as WorkflowStep } from "../schemas/workflow";

/** A v3 workflow step or a v4 process step. */
type Step = WorkflowStep | ProcessStep;

/**
 * A bundle as a flat set of keyed entities in ordered lists, the shape diff and merge work on
 * (docs/plan.md §1.2 "Diff and three-way merge"). Keys: skills by skill id, workflows by slug,
 * steps, fork paths and otherwise branches by id, wherever they sit in the tree, so a step moved
 * between fork paths is the same entity in a different list.
 *
 * Entity keys: `skill:<id>`, `workflow:<slug>`, `step:<id>`, `path:<id>`, `otherwise:<id>`,
 * `person:<role>` (the bundle's `people`, by role).
 * List keys: `<owner key>><field>`: `bundle>skills`, `bundle>workflows`, `bundle>people` (only
 * when the bundle has `people`, so bundles without it rebuild unchanged), `workflow:<slug>>steps`,
 * `step:<fork>>paths`, `step:<fork>>otherwise`, `step:<for_each>>steps`, `path:<id>>steps`,
 * `otherwise:<id>>steps`.
 *
 * R1 (docs/plan.md §1.86): a v4 process flattens the same way, its `if` steps like forks (paths
 * and otherwise by id). Its `triggers` stay a field of the workflow entity, as a v3 workflow's
 * `trigger` does, but keyed by trigger id (`workflow/triggers/<id>`), so each trigger merges field
 * by field and adding one on one side never conflicts with editing another on the other. Their
 * order is the field `workflow/triggerOrder` (the ids in order), so a reorder is a change that
 * diff shows, merge merges as a sequence (`TRIGGER_ORDER`) and select carries with the workflow.
 */
// DECISION: triggers are an id-keyed field of the workflow entity, not entities of their own: no
// new entity kind (screens map every kind to a word), and trigger changes group with their
// workflow when selected, as v3 trigger changes do. Their order is kept beside them as a list of
// ids, since an object's key order is not something diff or merge compare (and a numeric id such
// as `"2"` would sort first).

export type EntityKind = "skill" | "workflow" | "step" | "path" | "otherwise" | "person";

/** Steps whose branches flatten as paths and an otherwise: v3 `fork` and v4 `if`. */
function isBranching(kind: unknown): boolean {
  return kind === "fork" || kind === "if";
}

/** A workflow entity's content holds a v4 process. */
function isProcess(content: Record<string, unknown>): boolean {
  const wf = content.workflow as { schemaVersion?: unknown } | undefined;
  return wf?.schemaVersion === 4;
}

/** The field of a v4 workflow entity's `workflow` that holds its trigger ids in order. */
export const TRIGGER_ORDER = "triggerOrder";

/** The trigger order a workflow entity's content holds (v4), or undefined (v3, or none). */
export function triggerOrderOf(content: Record<string, unknown> | undefined): string[] | undefined {
  const wf = content?.workflow as Record<string, unknown> | undefined;
  const order = wf?.[TRIGGER_ORDER];
  return Array.isArray(order) ? order.filter((x): x is string => typeof x === "string") : undefined;
}

/** The list of the bundle's people; present only when the bundle declares `people`. */
export const PEOPLE_LIST = "bundle>people";

export interface Entity {
  key: string;
  kind: EntityKind;
  /** The entity without its child lists. */
  content: Record<string, unknown>;
  /** The list it sits in. */
  list: string;
}

export interface FlatBundle {
  /** The bundle without `definition.skills` and `workflows`. */
  root: Record<string, unknown>;
  entities: Map<string, Entity>;
  lists: Map<string, string[]>;
}

export const ROOT = "bundle";

export function listOwner(listKey: string): string {
  return listKey.slice(0, listKey.lastIndexOf(">"));
}

/** The child lists an entity of this kind owns. */
export function childLists(entity: Pick<Entity, "key" | "kind" | "content">): string[] {
  switch (entity.kind) {
    case "workflow":
    case "path":
    case "otherwise":
      return [`${entity.key}>steps`];
    case "step":
      if (isBranching(entity.content.kind)) {
        return [`${entity.key}>paths`, `${entity.key}>otherwise`];
      }
      if (entity.content.kind === "for_each") return [`${entity.key}>steps`];
      return [];
    default:
      return [];
  }
}

export function flattenBundle(bundle: AnyAgentBundle): FlatBundle {
  const b = cloneJson(bundle);
  const entities = new Map<string, Entity>();
  const lists = new Map<string, string[]>();

  const add = (key: string, kind: EntityKind, content: Record<string, unknown>, list: string) => {
    if (entities.has(key)) {
      throw new Error(`duplicate ${key}: ids must be unique across the bundle (validate first)`);
    }
    entities.set(key, { key, kind, content, list });
    const members = lists.get(list);
    if (members) members.push(key);
    else lists.set(list, [key]);
  };
  const ensure = (list: string) => {
    if (!lists.has(list)) lists.set(list, []);
  };

  const steps = (items: Step[], list: string) => {
    ensure(list);
    for (const step of items) {
      const key = `step:${step.id}`;
      if (step.kind === "fork" || step.kind === "if") {
        const { paths, otherwise, ...content } = step;
        add(key, "step", content, list);
        ensure(`${key}>paths`);
        for (const p of paths) {
          const { steps: inner, ...pc } = p;
          add(`path:${p.id}`, "path", pc, `${key}>paths`);
          steps(inner, `path:${p.id}>steps`);
        }
        add(`otherwise:${otherwise.id}`, "otherwise", { id: otherwise.id }, `${key}>otherwise`);
        steps(otherwise.steps, `otherwise:${otherwise.id}>steps`);
      } else if (step.kind === "for_each") {
        const { steps: inner, ...content } = step;
        add(key, "step", content, list);
        steps(inner, `${key}>steps`);
      } else {
        add(key, "step", { ...step }, list);
      }
    }
  };

  ensure(`${ROOT}>skills`);
  for (const s of b.definition.skills) {
    add(`skill:${parseSkillRef(s.skill).id}`, "skill", { ...s }, `${ROOT}>skills`);
  }
  ensure(`${ROOT}>workflows`);
  for (const w of b.workflows) {
    const key = `workflow:${w.slug}`;
    if (w.workflow.schemaVersion === 4) {
      const { steps: inner, triggers, ...wf } = w.workflow;
      const byId: Record<string, Trigger> = {};
      for (const t of triggers) {
        if (Object.hasOwn(byId, t.id)) {
          throw new Error(`duplicate trigger ${t.id} in ${key} (validate first)`);
        }
        byId[t.id] = t;
      }
      const workflow = { ...wf, triggers: byId, [TRIGGER_ORDER]: triggers.map((t) => t.id) };
      add(key, "workflow", { ...w, workflow }, `${ROOT}>workflows`);
      steps(inner, `${key}>steps`);
    } else {
      const { steps: inner, ...wf } = w.workflow;
      add(key, "workflow", { ...w, workflow: wf }, `${ROOT}>workflows`);
      steps(inner, `${key}>steps`);
    }
  }

  if (b.people !== undefined) {
    ensure(PEOPLE_LIST);
    for (const p of b.people) add(`person:${p.role}`, "person", { ...p }, PEOPLE_LIST);
  }

  const { workflows: _w, definition, people: _p, ...rest } = b;
  const { skills: _s, ...def } = definition;
  return { root: { ...rest, definition: def }, entities, lists };
}

/** Rebuilds the nested value of one entity (with its descendants). */
export function buildEntity(flat: FlatBundle, key: string): Record<string, unknown> {
  const e = flat.entities.get(key);
  if (!e) throw new Error(`no entity ${key}`);
  const list = (k: string) => (flat.lists.get(k) ?? []).map((c) => buildEntity(flat, c));
  const c = cloneJson(e.content);
  switch (e.kind) {
    case "workflow":
      if (isProcess(c)) {
        const { [TRIGGER_ORDER]: _order, ...wf } = c.workflow as Record<string, unknown>;
        const byId = (wf.triggers ?? {}) as Record<string, unknown>;
        // In the stored order; a trigger the order doesn't list (none, when flattened here) last.
        const order = (triggerOrderOf(c) ?? []).filter((id) => Object.hasOwn(byId, id));
        const ids = [...new Set([...order, ...Object.keys(byId)])];
        return {
          ...c,
          workflow: { ...wf, triggers: ids.map((id) => byId[id]), steps: list(`${key}>steps`) },
        };
      }
      return { ...c, workflow: { ...(c.workflow as object), steps: list(`${key}>steps`) } };
    case "path":
    case "otherwise":
      return { ...c, steps: list(`${key}>steps`) };
    case "step":
      if (isBranching(c.kind)) {
        const otherwise = list(`${key}>otherwise`)[0] ?? {
          id: `${String(c.id)}-otherwise`,
          steps: [],
        };
        return { ...c, paths: list(`${key}>paths`), otherwise };
      }
      if (c.kind === "for_each") return { ...c, steps: list(`${key}>steps`) };
      return c;
    default:
      return c;
  }
}

/**
 * The bundle a flat bundle describes. Typed as a v3 `AgentBundle` by default; a caller that
 * flattened a bundle holding v4 processes names `AnyAgentBundle`.
 */
export function unflattenBundle<B extends AnyAgentBundle = AgentBundle>(flat: FlatBundle): B {
  const root = cloneJson(flat.root) as { definition: Record<string, unknown> } & Record<
    string,
    unknown
  >;
  const skills = (flat.lists.get(`${ROOT}>skills`) ?? []).map((k) => buildEntity(flat, k));
  const workflows = (flat.lists.get(`${ROOT}>workflows`) ?? []).map((k) => buildEntity(flat, k));
  const people = flat.lists.get(PEOPLE_LIST)?.map((k) => buildEntity(flat, k));
  return {
    ...root,
    definition: { ...root.definition, skills },
    workflows,
    ...(people ? { people } : {}),
  } as unknown as B;
}

/** The entity's ancestors (nearest first), following list owners up to the bundle. */
export function ancestors(flat: FlatBundle, key: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([key]);
  let cur = flat.entities.get(key);
  while (cur) {
    const owner = listOwner(cur.list);
    if (owner === ROOT || seen.has(owner)) break;
    out.push(owner);
    seen.add(owner);
    cur = flat.entities.get(owner);
  }
  return out;
}
