import { cloneJson } from "../json";
import type { AgentBundle } from "../schemas/agent";
import { parseSkillRef } from "../schemas/common";
import type { Step } from "../schemas/workflow";

/**
 * A bundle as a flat set of keyed entities in ordered lists, the shape diff and merge work on
 * (docs/plan.md §1.2 "Diff and three-way merge"). Keys: skills by skill id, workflows by slug,
 * steps, fork paths and otherwise branches by id, wherever they sit in the tree, so a step moved
 * between fork paths is the same entity in a different list.
 *
 * Entity keys: `skill:<id>`, `workflow:<slug>`, `step:<id>`, `path:<id>`, `otherwise:<id>`.
 * List keys: `<owner key>><field>`: `bundle>skills`, `bundle>workflows`, `workflow:<slug>>steps`,
 * `step:<fork>>paths`, `step:<fork>>otherwise`, `step:<for_each>>steps`, `path:<id>>steps`,
 * `otherwise:<id>>steps`.
 */

export type EntityKind = "skill" | "workflow" | "step" | "path" | "otherwise";

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
      if (entity.content.kind === "fork") return [`${entity.key}>paths`, `${entity.key}>otherwise`];
      if (entity.content.kind === "for_each") return [`${entity.key}>steps`];
      return [];
    default:
      return [];
  }
}

export function flattenBundle(bundle: AgentBundle): FlatBundle {
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
      if (step.kind === "fork") {
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
    const { steps: inner, ...wf } = w.workflow;
    const key = `workflow:${w.slug}`;
    add(key, "workflow", { ...w, workflow: wf }, `${ROOT}>workflows`);
    steps(inner, `${key}>steps`);
  }

  const { workflows: _w, definition, ...rest } = b;
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
      return { ...c, workflow: { ...(c.workflow as object), steps: list(`${key}>steps`) } };
    case "path":
    case "otherwise":
      return { ...c, steps: list(`${key}>steps`) };
    case "step":
      if (c.kind === "fork") {
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

export function unflattenBundle(flat: FlatBundle): AgentBundle {
  const root = cloneJson(flat.root) as { definition: Record<string, unknown> } & Record<
    string,
    unknown
  >;
  const skills = (flat.lists.get(`${ROOT}>skills`) ?? []).map((k) => buildEntity(flat, k));
  const workflows = (flat.lists.get(`${ROOT}>workflows`) ?? []).map((k) => buildEntity(flat, k));
  return {
    ...root,
    definition: { ...root.definition, skills },
    workflows,
  } as unknown as AgentBundle;
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
