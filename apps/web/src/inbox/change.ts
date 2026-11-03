// "Now / after this change" (design screen 6; ARCHITECTURE §11): an external action's before state
// (what the record looks like in the client's tool now) against its input (what the agent will
// write), field by field. Pure, shared by the inbox cards and the run views of both surfaces.
import { deepEqual, isPlainObject } from "@countersign/core";

export interface ChangeRow {
  field: string;
  now: unknown;
  after: unknown;
  changed: boolean;
}

/**
 * Identity and concurrency fields: they name the record or guard the write, they are not part of
 * the change a person approves.
 */
// DECISION: the now/after table hides `id` and version tokens (QBO's SyncToken, ETags); the record
// id is shown as the card's target instead.
const HIDDEN = /^(id|sync_?token|etag|version_?token)$/i;

/** The record as an object: a scalar before state is shown as one `value` field. */
function asRecord(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  return isPlainObject(v) ? v : { value: v };
}

/**
 * One row per field the change touches or the record has: `now` from `before` (absent for a new
 * record), `after` from the input where it sets the field, else unchanged.
 */
export function changeRows(before: unknown, input: unknown): ChangeRow[] {
  const now = asRecord(before);
  const set = asRecord(input) ?? {};
  const fields = [...new Set([...Object.keys(now ?? {}), ...Object.keys(set)])].filter(
    (f) => !HIDDEN.test(f),
  );
  return fields.map((field) => {
    const was = now ? now[field] : undefined;
    const after = Object.hasOwn(set, field) ? set[field] : was;
    return { field, now: was, after, changed: !deepEqual(was ?? null, after ?? null) };
  });
}

/** True when the record does not exist yet (a create): there is no "now". */
export function isCreate(before: unknown): boolean {
  return before === null || before === undefined;
}

/** The record the change is about: "r1 · Oak board", from the input's or the record's id and name. */
export function changeTarget(before: unknown, input: unknown): string | null {
  const b = asRecord(before) ?? {};
  const i = asRecord(input) ?? {};
  const id = [i.id, b.id, i.externalId, b.externalId].find(
    (v) => typeof v === "string" || typeof v === "number",
  );
  const name = [b.name, b.title, b.displayName, i.name, i.title].find(
    (v) => typeof v === "string" && v.length > 0,
  );
  const parts = [id === undefined ? null : String(id), (name as string | undefined) ?? null];
  const out = parts.filter((p): p is string => p !== null);
  return out.length > 0 ? out.join(" · ") : null;
}

/** A field label: `unitPrice` → "Unit price", `vendor_name` → "Vendor name". */
export function fieldLabel(field: string): string {
  const words = field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A value as text: scalars as they are, lists of scalars joined, anything else as JSON. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object")) {
    return v.map((x) => formatValue(x)).join(", ");
  }
  return JSON.stringify(v);
}

/** `testkit.record.update` → "testkit": the connector a tool belongs to. */
export function connectorOf(toolId: string): string {
  return toolId.split(".")[0] ?? toolId;
}

/** "Testkit", "Qbo": a connector id as a name, when no manifest name is at hand. */
export function connectorName(id: string, names?: Record<string, string>): string {
  return names?.[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}
