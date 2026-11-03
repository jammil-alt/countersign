import { deepEqual, isPlainObject, toPointer } from "../json";
import type { AgentBundle } from "../schemas/agent";
import { buildEntity, type FlatBundle, flattenBundle, ROOT } from "./flatten";

/**
 * A change between two bundles, keyed so the merge view and version history can place it.
 * `path` is `<entity key>#<JSON pointer into the entity>` for field changes, `<entity key>` for
 * added/removed, `<entity key>#@location` for moves between lists, `<entity key>#@position` for a
 * step that moved within its list, and `<list key>#@order` for a reordered list.
 */
export interface BundleChange {
  kind: "added" | "removed" | "changed" | "moved" | "reordered";
  /** Entity key (`step:<id>`, `workflow:<slug>`, `skill:<id>`, ...) or "bundle"; a list key for "reordered". */
  entity: string;
  path: string;
  before?: unknown;
  after?: unknown;
}

function fieldChanges(
  entity: string,
  a: unknown,
  b: unknown,
  at: string[],
  out: BundleChange[],
): void {
  if (deepEqual(a, b)) return;
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      fieldChanges(entity, a[k], b[k], [...at, k], out);
    }
    return;
  }
  const change: BundleChange = { kind: "changed", entity, path: `${entity}#${toPointer(at)}` };
  if (a !== undefined) change.before = a;
  if (b !== undefined) change.after = b;
  out.push(change);
}

/** Longest common subsequence of two key lists (lists are short: steps in one list). */
export function lcs(a: readonly string[], b: readonly string[]): string[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const row = dp[i] as number[];
      row[j] =
        a[i] === b[j]
          ? ((dp[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((dp[i + 1] as number[])[j] as number, row[j + 1] as number);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(a[i] as string);
      i++;
      j++;
    } else if (((dp[i + 1] as number[])[j] as number) >= ((dp[i] as number[])[j + 1] as number))
      i++;
    else j++;
  }
  return out;
}

export function diffFlat(a: FlatBundle, b: FlatBundle): BundleChange[] {
  const out: BundleChange[] = [];
  fieldChanges(ROOT, a.root, b.root, [], out);

  for (const [key, ea] of a.entities) {
    const eb = b.entities.get(key);
    if (!eb) {
      out.push({ kind: "removed", entity: key, path: key, before: buildEntity(a, key) });
      continue;
    }
    fieldChanges(key, ea.content, eb.content, [], out);
    if (ea.list !== eb.list) {
      out.push({
        kind: "moved",
        entity: key,
        path: `${key}#@location`,
        before: ea.list,
        after: eb.list,
      });
    }
  }
  for (const key of b.entities.keys()) {
    if (!a.entities.has(key)) {
      out.push({ kind: "added", entity: key, path: key, after: buildEntity(b, key) });
    }
  }

  for (const [list, la] of a.lists) {
    const lb = b.lists.get(list);
    if (!lb) continue;
    const ca = la.filter((k) => lb.includes(k));
    const cb = lb.filter((k) => la.includes(k));
    if (deepEqual(ca, cb)) continue;
    out.push({ kind: "reordered", entity: list, path: `${list}#@order`, before: ca, after: cb });
    const kept = new Set(lcs(ca, cb));
    for (const k of cb) {
      if (!kept.has(k)) {
        out.push({
          kind: "moved",
          entity: k,
          path: `${k}#@position`,
          before: ca.indexOf(k),
          after: cb.indexOf(k),
        });
      }
    }
  }
  return out;
}

/**
 * What changed from `a` to `b`: fields as values, items by key (ARCHITECTURE §9.3 version history,
 * the customizations view, and each side of the merge view).
 */
export function diffBundles(a: AgentBundle, b: AgentBundle): BundleChange[] {
  return diffFlat(flattenBundle(a), flattenBundle(b));
}
