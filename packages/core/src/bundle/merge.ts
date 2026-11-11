import { deepEqual, isPlainObject, toPointer } from "../json";
import type { AgentBundle, AnyAgentBundle } from "../schemas/agent";
import {
  ancestors,
  buildEntity,
  childLists,
  type Entity,
  type FlatBundle,
  flattenBundle,
  listOwner,
  PEOPLE_LIST,
  ROOT,
  TRIGGER_ORDER,
  triggerOrderOf,
  unflattenBundle,
} from "./flatten";
import { type BundleReadOptions, readBundles } from "./normalize";

/**
 * Three-way merge of agent bundles (ARCHITECTURE §9.3, docs/plan.md §1.2): template updates merge
 * base = the client's base template version, ours = the client's live version, theirs = the new
 * template version; promotion runs the other way. Pure and shared by the server and the merge view.
 *
 * - Items line up by key (skills by skill id, workflows by slug, steps and fork paths by id
 *   anywhere in the tree). Objects merge field by field; arrays and scalars are whole values.
 * - A change on one side is taken; the same change on both sides once; anything else conflicts.
 * - Deleting an item conflicts with any edit inside it on the other side (delete vs edit).
 * - A list's order merges as a sequence: inserts stay next to their neighbours; two different
 *   reorders of one list, or one step moved to two different places, conflict.
 * - Ids are never generated: every id in the result comes from an input.
 * - R1 (docs/plan.md §1.86): bundles holding v4 processes merge the same way. When any side holds
 *   one, all three are read as v4 first (the converter keeps every id, so a v3 base still lines
 *   up with a v4 side); `if` paths merge like fork paths, a v4 process's triggers by id (their
 *   order as a sequence, like a list's), step config field by field, and checks (confer,
 *   approval, notify) field by field too (lists in them, such as `notify` or an approval's
 *   `approvers`, are whole values).
 *
 * Unresolved conflicts leave ours in place, so the result is always a complete bundle; a merge
 * draft can be saved only when `conflicts` is empty and the bundle passes validateBundle.
 */

export type ConflictKind = "field" | "exists" | "location" | "order";

export interface MergeConflict {
  /** `<entity>#<pointer>`, `<entity>#@exists`, `<entity>#@location` or `<list>#@order`. */
  path: string;
  kind: ConflictKind;
  /** The entity key (or list key for order conflicts). */
  entity: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
}

export type Resolution =
  | { path: string; choice: "ours" | "theirs" | "base" }
  | { path: string; choice: "value"; value: unknown };

/** The merged bundle: a v3 `AgentBundle` when every input was v3 (the default type). */
export interface MergeResult<B extends AnyAgentBundle = AgentBundle> {
  bundle: B;
  conflicts: MergeConflict[];
  /** True when nothing is left to resolve. */
  clean: boolean;
  /** Resolutions that matched no conflict (stale or misspelt paths). */
  unusedResolutions: string[];
}

class Merger {
  readonly conflicts: MergeConflict[] = [];
  private readonly used = new Set<string>();
  private readonly resolutions: Map<string, Resolution>;

  constructor(
    readonly b: FlatBundle,
    readonly o: FlatBundle,
    readonly t: FlatBundle,
    resolutions: readonly Resolution[],
  ) {
    this.resolutions = new Map(resolutions.map((r) => [r.path, r]));
  }

  unused(): string[] {
    return [...this.resolutions.keys()].filter((k) => !this.used.has(k));
  }

  /** The resolved value of a conflict, or ours (recording the conflict) when unresolved. */
  private decide<T>(c: MergeConflict, pick: (r: Resolution) => T, fallback: T): T {
    const r = this.resolutions.get(c.path);
    if (r) {
      this.used.add(c.path);
      return pick(r);
    }
    this.conflicts.push(c);
    return fallback;
  }

  value(entity: string, b: unknown, o: unknown, t: unknown, at: string[]): unknown {
    if (deepEqual(o, t)) return o;
    if (deepEqual(o, b)) return t;
    if (deepEqual(t, b)) return o;
    if (isPlainObject(o) && isPlainObject(t) && (b === undefined || isPlainObject(b))) {
      const base = (b ?? {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of new Set([...Object.keys(o), ...Object.keys(t), ...Object.keys(base)])) {
        const v = this.value(entity, base[k], o[k], t[k], [...at, k]);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    const c: MergeConflict = {
      path: `${entity}#${toPointer(at)}`,
      kind: "field",
      entity,
      base: b,
      ours: o,
      theirs: t,
    };
    return this.decide(
      c,
      (r) =>
        r.choice === "value" ? r.value : r.choice === "base" ? b : r.choice === "ours" ? o : t,
      o,
    );
  }

  /** Did `side` change anything inside `key`'s subtree relative to base (deletions excluded)? */
  editedWithin(side: FlatBundle, key: string): boolean {
    const inSubtree = (flat: FlatBundle, k: string) =>
      k === key || ancestors(flat, k).includes(key);
    const sideKeys = [...side.entities.keys()].filter((k) => inSubtree(side, k));
    for (const k of sideKeys) {
      const e = side.entities.get(k) as Entity;
      const be = this.b.entities.get(k);
      if (!be) return true;
      if (!deepEqual(be.content, e.content) || be.list !== e.list) return true;
      for (const list of childLists(e)) {
        const sl = side.lists.get(list) ?? [];
        const bl = this.b.lists.get(list) ?? [];
        const common = (xs: string[], ys: string[]) => xs.filter((x) => ys.includes(x));
        if (!deepEqual(common(sl, bl), common(bl, sl))) return true;
      }
    }
    for (const k of this.b.entities.keys()) {
      if (inSubtree(this.b, k) && side.entities.has(k) && !inSubtree(side, k)) return true;
    }
    return false;
  }

  /** keep/delete for every key, top-down, with delete-vs-edit conflicts at the topmost item. */
  existence(): Map<string, boolean> {
    const keep = new Map<string, boolean>();
    const { b, o, t } = this;
    const all = new Set([...b.entities.keys(), ...o.entities.keys(), ...t.entities.keys()]);
    for (const k of all) if (!b.entities.has(k)) keep.set(k, true);

    // Base entities, parents before children.
    const ordered = [...b.entities.keys()].sort(
      (x, y) => ancestors(b, x).length - ancestors(b, y).length,
    );
    for (const k of ordered) {
      const inO = o.entities.has(k);
      const inT = t.entities.has(k);
      if (inO && inT) {
        keep.set(k, true);
        continue;
      }
      if (!inO && !inT) {
        keep.set(k, false);
        continue;
      }
      const delFlat = inO ? t : o;
      const other = inO ? o : t;
      const owner = listOwner((b.entities.get(k) as Entity).list);
      const ownerGone = owner !== ROOT && !delFlat.entities.has(owner);
      if (ownerGone) {
        // Removed with its container: follow the container's fate, unless both sides removed
        // the container (then this item was moved out on the other side and decides for itself).
        const ownerKept = keep.get(owner);
        const ownerGoneBoth = !o.entities.has(owner) && !t.entities.has(owner);
        if (!ownerGoneBoth) {
          keep.set(k, ownerKept === true);
          continue;
        }
      }
      if (!this.editedWithin(other, k)) {
        keep.set(k, false);
        continue;
      }
      const c: MergeConflict = {
        path: `${k}#@exists`,
        kind: "exists",
        entity: k,
        base: buildEntity(b, k),
        ours: inO ? buildEntity(o, k) : undefined,
        theirs: inT ? buildEntity(t, k) : undefined,
      };
      const keepIt = this.decide(
        c,
        (r) => (r.choice === "ours" ? inO : r.choice === "theirs" ? inT : true),
        inO,
      );
      keep.set(k, keepIt);
    }
    return keep;
  }

  location(k: string): string {
    const lb = this.b.entities.get(k)?.list;
    const lo = this.o.entities.get(k)?.list;
    const lt = this.t.entities.get(k)?.list;
    if (lo === undefined) return (lt ?? lb) as string;
    if (lt === undefined) return lo;
    if (lo === lt) return lo;
    if (lo === lb) return lt;
    if (lt === lb) return lo;
    const c: MergeConflict = {
      path: `${k}#@location`,
      kind: "location",
      entity: k,
      base: lb,
      ours: lo,
      theirs: lt,
    };
    return this.decide(
      c,
      (r) =>
        r.choice === "value" && typeof r.value === "string"
          ? r.value
          : r.choice === "theirs"
            ? lt
            : r.choice === "base" && lb !== undefined
              ? lb
              : lo,
      lo,
    );
  }

  content(k: string): Record<string, unknown> {
    const cb = this.b.entities.get(k)?.content;
    const co = this.o.entities.get(k)?.content;
    const ct = this.t.entities.get(k)?.content;
    if (co === undefined) return ct as Record<string, unknown>;
    if (ct === undefined) return co;
    const orders = [cb, co, ct].map(triggerOrderOf);
    if (orders.every((o) => o === undefined)) {
      return this.value(k, cb, co, ct, []) as Record<string, unknown>;
    }
    // R1: a v4 workflow's trigger order merges as a sequence over the triggers kept, so one side
    // adding a trigger and the other adding or reordering another doesn't conflict.
    const [ob, oo, ot] = orders;
    const merged = this.value(k, withoutOrder(cb), withoutOrder(co), withoutOrder(ct), []) as {
      workflow?: Record<string, unknown>;
    } & Record<string, unknown>;
    const wf = merged.workflow ?? {};
    const members = new Set(Object.keys((wf.triggers ?? {}) as Record<string, unknown>));
    const proj = (o: string[] | undefined) => (o ?? []).filter((id) => members.has(id));
    const order = this.sequence(
      `${k}#/workflow/${TRIGGER_ORDER}`,
      k,
      proj(ob),
      proj(oo),
      proj(ot),
      members,
    );
    return { ...merged, workflow: { ...wf, [TRIGGER_ORDER]: order } };
  }

  order(list: string, members: Set<string>): string[] {
    const proj = (flat: FlatBundle) => (flat.lists.get(list) ?? []).filter((k) => members.has(k));
    return this.sequence(`${list}#@order`, list, proj(this.b), proj(this.o), proj(this.t), members);
  }

  /**
   * One ordered sequence, three ways (`bs`, `os`, `ts` already hold only the kept `members`): a
   * reorder on one side is taken, two different reorders conflict (at `path`), inserts stay next
   * to their neighbours.
   */
  sequence(
    path: string,
    entity: string,
    bs: string[],
    os: string[],
    ts: string[],
    members: Set<string>,
  ): string[] {
    const common = (xs: string[], ys: string[]) => xs.filter((x) => ys.includes(x));
    const oMoved = !deepEqual(common(bs, os), common(os, bs));
    const tMoved = !deepEqual(common(bs, ts), common(ts, bs));

    let skeleton: string[];
    if (oMoved && tMoved) {
      const all3 = (xs: string[]) =>
        xs.filter((x) => bs.includes(x) && os.includes(x) && ts.includes(x));
      if (deepEqual(all3(os), all3(ts))) {
        skeleton = os;
      } else {
        const c: MergeConflict = {
          path,
          kind: "order",
          entity,
          base: bs,
          ours: os,
          theirs: ts,
        };
        skeleton = this.decide(
          c,
          (r) =>
            r.choice === "value" && Array.isArray(r.value)
              ? (r.value as string[]).filter((k) => members.has(k))
              : r.choice === "theirs"
                ? ts
                : r.choice === "base"
                  ? bs
                  : os,
          os,
        );
      }
    } else if (oMoved) skeleton = os;
    else if (tMoved) skeleton = ts;
    else skeleton = bs;

    // DECISION: two inserts at the same spot are both kept, ours first, rather than conflicting.
    const result = [...new Set(skeleton)];
    for (const seq of [os, ts, bs]) {
      let prev: string | null = null;
      for (const k of seq) {
        if (!result.includes(k)) {
          let at = prev === null ? 0 : result.indexOf(prev) + 1;
          // Step past the other side's inserts at the same spot, so ours come first.
          while (at < result.length) {
            const next = result[at] as string;
            if (seq.includes(next) || bs.includes(next)) break;
            at++;
          }
          result.splice(at, 0, k);
        }
        prev = k;
      }
    }
    for (const k of members) if (!result.includes(k)) result.push(k);
    return result;
  }
}

/** A workflow entity's content without its trigger order (merged apart, as a sequence). */
function withoutOrder(content: Record<string, unknown> | undefined) {
  if (!content || !isPlainObject(content.workflow)) return content;
  const { [TRIGGER_ORDER]: _order, ...workflow } = content.workflow;
  return { ...content, workflow };
}

function mergeFlat(
  base: FlatBundle,
  ours: FlatBundle,
  theirs: FlatBundle,
  resolutions: readonly Resolution[],
): { flat: FlatBundle; conflicts: MergeConflict[]; unused: string[] } {
  const m = new Merger(base, ours, theirs, resolutions);
  const root = m.value(ROOT, base.root, ours.root, theirs.root, []) as Record<string, unknown>;
  const keep = m.existence();

  const entities = new Map<string, Entity>();
  for (const [k, kept] of keep) {
    if (!kept) continue;
    const kind = (ours.entities.get(k) ?? theirs.entities.get(k) ?? base.entities.get(k))?.kind;
    if (!kind) continue;
    entities.set(k, { key: k, kind, content: m.content(k), list: m.location(k) });
  }

  // An item whose merged container is gone (or that would sit inside itself) falls back to its
  // place on another side, or goes with its container.
  const ownerOk = (list: string, k: string) => {
    let owner = listOwner(list);
    const seen = new Set([k]);
    while (owner !== ROOT) {
      if (seen.has(owner)) return false;
      seen.add(owner);
      const e = entities.get(owner);
      if (!e) return false;
      owner = listOwner(e.list);
    }
    return true;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [k, e] of entities) {
      if (ownerOk(e.list, k)) continue;
      const alt = [ours, theirs, base]
        .map((f) => f.entities.get(k)?.list)
        .find((l): l is string => l !== undefined && l !== e.list && ownerOk(l, k));
      if (alt) e.list = alt;
      else entities.delete(k);
      changed = true;
    }
  }

  const members = new Map<string, Set<string>>();
  for (const [k, e] of entities) {
    const set = members.get(e.list);
    if (set) set.add(k);
    else members.set(e.list, new Set([k]));
  }
  const lists = new Map<string, string[]>();
  const listKeys = new Set<string>([`${ROOT}>skills`, `${ROOT}>workflows`]);
  // `people` is kept when any side has it (a side that added roles, or a base that had them).
  if ([base, ours, theirs].some((f) => f.lists.has(PEOPLE_LIST))) listKeys.add(PEOPLE_LIST);
  for (const e of entities.values()) for (const l of childLists(e)) listKeys.add(l);
  for (const l of listKeys) lists.set(l, m.order(l, members.get(l) ?? new Set()));

  return { flat: { root, entities, lists }, conflicts: m.conflicts, unused: m.unused() };
}

/**
 * Three-way merge; `resolutions` (from the merge view) settle conflicts by path. Three v3 bundles
 * merge as v3. When any side holds a v4 process, every side is read as v4 first and the result is
 * v4; `options.lookup` reads the v3 sides (required when the sides mix v3 and v4).
 */
export function mergeBundles(
  base: AgentBundle,
  ours: AgentBundle,
  theirs: AgentBundle,
  resolutions?: readonly Resolution[],
): MergeResult;
export function mergeBundles(
  base: AnyAgentBundle,
  ours: AnyAgentBundle,
  theirs: AnyAgentBundle,
  resolutions?: readonly Resolution[],
  options?: BundleReadOptions,
): MergeResult<AnyAgentBundle>;
export function mergeBundles(
  base: AnyAgentBundle,
  ours: AnyAgentBundle,
  theirs: AnyAgentBundle,
  resolutions: readonly Resolution[] = [],
  options: BundleReadOptions = {},
): MergeResult<AnyAgentBundle> {
  const [b, o, t] = readBundles([base, ours, theirs], options).bundles as [
    AnyAgentBundle,
    AnyAgentBundle,
    AnyAgentBundle,
  ];
  const r = mergeFlat(flattenBundle(b), flattenBundle(o), flattenBundle(t), resolutions);
  return {
    bundle: unflattenBundle<AnyAgentBundle>(r.flat),
    conflicts: r.conflicts,
    clean: r.conflicts.length === 0,
    unusedResolutions: r.unused,
  };
}

/**
 * Re-runs the merge with the operator's resolutions. The draft can be saved when `clean` is true
 * (and the bundle validates).
 */
export function applyResolutions(
  inputs: { base: AgentBundle; ours: AgentBundle; theirs: AgentBundle },
  resolutions: readonly Resolution[],
): MergeResult;
export function applyResolutions(
  inputs: { base: AnyAgentBundle; ours: AnyAgentBundle; theirs: AnyAgentBundle },
  resolutions: readonly Resolution[],
  options?: BundleReadOptions,
): MergeResult<AnyAgentBundle>;
export function applyResolutions(
  inputs: { base: AnyAgentBundle; ours: AnyAgentBundle; theirs: AnyAgentBundle },
  resolutions: readonly Resolution[],
  options: BundleReadOptions = {},
): MergeResult<AnyAgentBundle> {
  return mergeBundles(inputs.base, inputs.ours, inputs.theirs, resolutions, options);
}
