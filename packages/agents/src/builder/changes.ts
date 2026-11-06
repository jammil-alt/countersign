// v0.12 W3-A: a turn's changes as labelled entries, and undo of one entry (ARCHITECTURE §9.6;
// docs/plan.md §1.51). Entries are core's selectable changes between the draft before and after
// the turn (`selectableBetween`, i.e. diffBundles grouped by item, agent field or list), each
// with a label in plain words ("+1 step, step 4 · Check the receipt", "~1 skill
// materials.match-lines setting · window 3 → 5"). Undo reverts one entry with core's three-way
// merge: base = the draft after the entry's turn, ours = the working draft, theirs = the draft
// after the turn with only that entry reverted, so later changes stay; a conflict refuses it.

import {
  type AgentBundle,
  type BuilderChange,
  type BundleChange,
  buildEntity,
  type Entity,
  type FlatBundle,
  flattenBundle,
  fromPointer,
  type MergeConflict,
  mergeBundles,
  selectableBetween,
  selectChanges,
} from "@countersign/core";

/** core's root entity key (`bundle`). */
const ROOT = "bundle";
const MAX_VALUE = 40;

/** A short, plain rendering of a value for a label. */
export function showValue(v: unknown): string {
  if (v === undefined) return "none";
  if (v === null) return "none";
  if (typeof v === "string") return v.length > MAX_VALUE ? `${v.slice(0, MAX_VALUE - 1)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  return "…";
}

/** `step:<id>` → "step 3", "step 3.2" (its place in the tree, counted from 1), by workflow. */
function stepNumbers(flat: FlatBundle): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (list: string, prefix: string) => {
    (flat.lists.get(list) ?? []).forEach((key, i) => {
      const n = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      out.set(key, n);
      const e = flat.entities.get(key);
      if (!e) return;
      if (e.kind === "step") {
        if (e.content.kind === "for_each") walk(`${key}>steps`, n);
        if (e.content.kind === "fork") {
          for (const p of flat.lists.get(`${key}>paths`) ?? []) walk(`${p}>steps`, n);
          for (const o of flat.lists.get(`${key}>otherwise`) ?? []) walk(`${o}>steps`, n);
        }
      }
    });
  };
  for (const w of flat.lists.get(`${ROOT}>workflows`) ?? []) walk(`${w}>steps`, "");
  return out;
}

const KIND_WORD: Record<Entity["kind"], string> = {
  skill: "skill",
  workflow: "workflow",
  step: "step",
  path: "fork path",
  otherwise: "otherwise branch",
  person: "person",
};

function entityWords(e: Entity, numbers: Map<string, string>): { what: string; name: string } {
  const name =
    e.kind === "skill"
      ? String(e.content.skill)
      : e.kind === "person"
        ? String(e.content.role)
        : typeof e.content.name === "string"
          ? e.content.name
          : "";
  if (e.kind === "step") {
    const kind = String(e.content.kind ?? "step").replace("_", " ");
    return { what: `${kind}, step ${numbers.get(e.key) ?? "?"}`, name };
  }
  return { what: KIND_WORD[e.kind], name };
}

/** A pointer like `/settings/window` → "setting window"; `/input/days` → "input days". */
function fieldWords(path: string[]): string {
  if (path[0] === "settings" && path.length > 1) return `setting · ${path.slice(1).join(".")}`;
  return path.join(".");
}

function fieldChange(c: BundleChange): string {
  const at = c.path.indexOf("#");
  const pointer = at === -1 ? [] : fromPointer(c.path.slice(at + 1));
  return `${fieldWords(pointer)} ${showValue(c.before)} → ${showValue(c.after)}`;
}

/** One entry's label, from its grouped changes. */
function labelFor(
  id: string,
  changes: readonly BundleChange[],
  fa: FlatBundle,
  fb: FlatBundle,
  na: Map<string, string>,
  nb: Map<string, string>,
): string {
  if (id.startsWith(`${ROOT}#`)) {
    const c = changes[0] as BundleChange;
    const path = fromPointer(id.slice(ROOT.length + 1));
    const words = path[0] === "definition" ? path.slice(1) : path;
    return `~ ${words.join(".")} · ${showValue(c.before)} → ${showValue(c.after)}`;
  }
  if (changes.some((c) => c.kind === "reordered")) {
    const owner = fb.entities.get(id.slice(0, id.lastIndexOf(">"))) ?? fa.entities.get(id);
    const name = owner && typeof owner.content.name === "string" ? owner.content.name : "a list";
    return `↕ steps of ${name} reordered`;
  }
  const after = fb.entities.get(id);
  const before = fa.entities.get(id);
  if (after && !before) {
    const w = entityWords(after, nb);
    return `+1 ${w.what}${w.name ? ` · ${w.name}` : ""}`;
  }
  if (before && !after) {
    const w = entityWords(before, na);
    return `−1 ${w.what}${w.name ? ` · ${w.name}` : ""}`;
  }
  const e = (after ?? before) as Entity;
  const w = entityWords(e, nb);
  const fields = changes.filter((c) => c.kind === "changed");
  const moved = changes.some((c) => c.kind === "moved");
  const head = `~${fields.length || 1} ${w.what}${w.name ? ` · ${w.name}` : ""}`;
  if (fields.length === 0) return moved ? `${head} moved` : head;
  const first = fieldChange(fields[0] as BundleChange);
  return `${head} · ${first}${fields.length > 1 ? ` (+${fields.length - 1} more)` : ""}`;
}

/** The entity (without its children) or agent field on one side, for the entry's before/after. */
function sideOf(flat: FlatBundle, id: string): unknown {
  if (id.startsWith(`${ROOT}#`)) {
    let cur: unknown = flat.root;
    for (const seg of fromPointer(id.slice(ROOT.length + 1))) {
      if (cur === null || typeof cur !== "object") return undefined;
      cur = Object.hasOwn(cur, seg) ? (cur as Record<string, unknown>)[seg] : undefined;
    }
    return cur;
  }
  if (id.includes(">")) return flat.lists.get(id);
  return flat.entities.get(id)?.content;
}

/** The labelled entries between two drafts, in diff order. */
export function labelledChanges(before: AgentBundle, after: AgentBundle): BuilderChange[] {
  const fa = flattenBundle(before);
  const fb = flattenBundle(after);
  const na = stepNumbers(fa);
  const nb = stepNumbers(fb);
  return selectableBetween(before, after).map((g) => {
    const entry: BuilderChange = { id: g.id, label: labelFor(g.id, g.changes, fa, fb, na, nb) };
    const b = sideOf(fa, g.id);
    const a = sideOf(fb, g.id);
    if (b !== undefined) entry.before = b;
    if (a !== undefined) entry.after = a;
    return entry;
  });
}

export type UndoResult =
  | { ok: true; bundle: AgentBundle }
  | { ok: false; conflicts: MergeConflict[] };

/**
 * Reverts one entry of a turn on the working draft. `before` and `after` are the drafts around the
 * entry's turn. Later turns' changes stay; when a later change touched what the entry changed, the
 * merge conflicts and nothing is reverted.
 */
export function undoChange(input: {
  before: AgentBundle;
  after: AgentBundle;
  working: AgentBundle;
  changeId: string;
}): UndoResult {
  const theirs = selectChanges(input.after, input.before, [input.changeId]);
  const merged = mergeBundles(input.after, input.working, theirs);
  if (!merged.clean) return { ok: false, conflicts: merged.conflicts };
  return { ok: true, bundle: merged.bundle };
}

/** The entity, built with its children, for tests and labels. */
export function entityOf(bundle: AgentBundle, key: string): Record<string, unknown> | null {
  const flat = flattenBundle(bundle);
  return flat.entities.has(key) ? buildEntity(flat, key) : null;
}

/** `turnId:changeId`, how a change entry is named across a conversation. */
export const entryKey = (turnId: string, changeId: string) => `${turnId}:${changeId}`;

/**
 * Which entries of a conversation are undone now: an entry is undone when a later undo entry names
 * it and that undo is not itself undone (undoing an undo puts the change back).
 */
export function undoneEntries(
  turns: readonly { id: string; seq: number; changes: readonly BuilderChange[] }[],
): Set<string> {
  const undoers = new Map<string, string[]>();
  for (const t of [...turns].sort((a, b) => a.seq - b.seq)) {
    for (const c of t.changes) {
      if (!c.undoes) continue;
      const target = entryKey(c.undoes.turnId, c.undoes.changeId);
      const list = undoers.get(target);
      if (list) list.push(entryKey(t.id, c.id));
      else undoers.set(target, [entryKey(t.id, c.id)]);
    }
  }
  const memo = new Map<string, boolean>();
  const undone = (key: string): boolean => {
    const known = memo.get(key);
    if (known !== undefined) return known;
    memo.set(key, false);
    const result = (undoers.get(key) ?? []).some((u) => !undone(u));
    memo.set(key, result);
    return result;
  };
  const out = new Set<string>();
  for (const t of turns)
    for (const c of t.changes) if (undone(entryKey(t.id, c.id))) out.add(entryKey(t.id, c.id));
  return out;
}
