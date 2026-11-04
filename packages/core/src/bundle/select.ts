import { cloneJson, fromPointer } from "../json";
import type { AgentBundle } from "../schemas/agent";
import { type BundleChange, diffFlat } from "./diff";
import {
  childLists,
  type Entity,
  type FlatBundle,
  flattenBundle,
  listOwner,
  ROOT,
  unflattenBundle,
} from "./flatten";

/**
 * One change a person can pick when promoting a client's changes into a template (ARCHITECTURE
 * §9.3 "Promoting": "all, or selected changes"). `id` is what `selectChanges` takes:
 * - an agent field: its change path (`bundle#/definition/instructions`);
 * - a skill, workflow, step, fork path or otherwise branch: its entity key (`step:<id>`), covering
 *   every field change, add, remove and move between lists of that item;
 * - a reordered list: the list key (`workflow:main>steps`), covering the moves within it.
 */
export interface SelectableChange {
  id: string;
  changes: BundleChange[];
}

/**
 * Groups `diffBundles(a, b)` output into selectable changes, in diff order. A step's move within
 * its list (`#@position`) belongs to its list's reorder, which diffBundles reports just before.
 */
export function selectableChanges(changes: readonly BundleChange[]): SelectableChange[] {
  const out: SelectableChange[] = [];
  const byId = new Map<string, SelectableChange>();
  let lastReorder: string | null = null;
  for (const c of changes) {
    let id: string;
    if (c.entity === ROOT) id = c.path;
    else if (c.kind === "reordered") {
      id = c.entity;
      lastReorder = id;
    } else if (c.path.endsWith("#@position") && lastReorder) id = lastReorder;
    else id = c.entity;
    let group = byId.get(id);
    if (!group) {
      group = { id, changes: [] };
      byId.set(id, group);
      out.push(group);
    }
    group.changes.push(c);
  }
  return out;
}

function setAt(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: Record<string, unknown> = target;
  for (const seg of path.slice(0, -1)) {
    const next = cur[seg];
    if (next === null || typeof next !== "object" || Array.isArray(next)) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  const last = path[path.length - 1] as string;
  if (value === undefined) delete cur[last];
  else cur[last] = cloneJson(value);
}

function getAt(source: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = source;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * `a` with only the selected changes of `a → b` applied (ids from `selectableChanges`). Unselected
 * items keep their state in `a`. An added or removed container brings its added or removed
 * contents with it. An item whose container is not in the result goes back to its place in `a`,
 * or is left out when `a` has no place for it. Ids are never generated: every item comes from `a`
 * or `b`.
 */
export function selectChanges(a: AgentBundle, b: AgentBundle, ids: readonly string[]): AgentBundle {
  const fa = flattenBundle(a);
  const fb = flattenBundle(b);
  const selected = new Set(ids);

  // Agent fields, one change path at a time.
  const root = cloneJson(fa.root);
  for (const id of selected) {
    if (!id.startsWith(`${ROOT}#`)) continue;
    const path = fromPointer(id.slice(ROOT.length + 1));
    if (path.length === 0) continue;
    setAt(root, path, getAt(fb.root, path));
  }

  // Which side each item follows.
  const follows = new Map<string, boolean>();
  const followsB = (k: string): boolean => {
    const known = follows.get(k);
    if (known !== undefined) return known;
    follows.set(k, false); // cycle guard
    let r = selected.has(k);
    if (!r) {
      const inA = fa.entities.get(k);
      const inB = fb.entities.get(k);
      // Added inside an added container, or removed inside a removed one: goes with it.
      const owner = !inA && inB ? listOwner(inB.list) : inA && !inB ? listOwner(inA.list) : null;
      if (owner && owner !== ROOT) {
        const ownerAdded = !inA && !fa.entities.has(owner) && fb.entities.has(owner);
        const ownerRemoved = inA && !inB && fa.entities.has(owner) && !fb.entities.has(owner);
        if (ownerAdded || ownerRemoved) r = followsB(owner);
      }
    }
    follows.set(k, r);
    return r;
  };

  const entities = new Map<string, Entity>();
  for (const k of new Set([...fa.entities.keys(), ...fb.entities.keys()])) {
    const e = (followsB(k) ? fb : fa).entities.get(k);
    if (e) entities.set(k, cloneJson(e));
  }

  // Items whose container isn't there go back to their place in `a`, or out.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [k, e] of entities) {
      const owner = listOwner(e.list);
      if (owner === ROOT || (entities.has(owner) && owner !== k)) continue;
      const back = fa.entities.get(k);
      if (back && back.list !== e.list) entities.set(k, cloneJson(back));
      else entities.delete(k);
      changed = true;
    }
  }

  // Lists: `b`'s order where its reorder is selected, else `a`'s; other members go in after the
  // neighbour they follow on the side they came from.
  const members = new Map<string, string[]>();
  for (const [k, e] of entities) {
    const m = members.get(e.list);
    if (m) m.push(k);
    else members.set(e.list, [k]);
  }
  const listKeys = new Set<string>([`${ROOT}>skills`, `${ROOT}>workflows`]);
  for (const e of entities.values()) for (const l of childLists(e)) listKeys.add(l);
  const lists = new Map<string, string[]>();
  for (const list of listKeys) {
    const mine = new Set(members.get(list) ?? []);
    const primary = (selected.has(list) ? fb : fa).lists.get(list) ?? [];
    const out = primary.filter((k) => mine.has(k));
    for (const k of mine) {
      if (out.includes(k)) continue;
      const source: FlatBundle = followsB(k) ? fb : fa;
      const seq = source.lists.get(list) ?? [];
      let at = 0;
      for (let i = seq.indexOf(k) - 1; i >= 0; i--) {
        const prev = out.indexOf(seq[i] as string);
        if (prev !== -1) {
          at = prev + 1;
          break;
        }
      }
      out.splice(at, 0, k);
    }
    lists.set(list, out);
  }

  return unflattenBundle({ root, entities, lists });
}

/** The selectable changes from `a` to `b` (diffBundles grouped). */
export function selectableBetween(a: AgentBundle, b: AgentBundle): SelectableChange[] {
  return selectableChanges(diffFlat(flattenBundle(a), flattenBundle(b)));
}
