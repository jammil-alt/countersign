// "Now / after this change" (design screen 6; ARCHITECTURE §11; docs/plan.md "Inbox and run
// views"): an external action's before state (the record in the client's tool now) against its
// input (what the agent will write). Pure, shared by the inbox cards and the run views of both
// surfaces.
//
// A tool that declares a display (core ToolDisplay) is read through it: only its fields, with their
// labels and kinds, the same paths giving "now" and "after". A tool without one falls back to the
// record's own fields, field by field, hiding ids and version tokens and never showing a raw object.
import {
  type ChangeDisplayView,
  type ChangePath,
  changeValue,
  type DisplayColumns,
  type DisplayField,
  dec,
  deepEqual,
  isPlainObject,
  type Locale,
  pickLocalized,
  type ToolDisplay,
} from "@countersign/core";
import { EN, type I18n } from "../i18n/i18n";
import { money, moneyShape } from "../runs/format";

/** One line of a `lines` list, or one file of a `files` list, as text. */
export interface ItemView {
  description: string | null;
  /** What the line is booked to (an item or account name), or null. */
  ref: string | null;
  qty: string | null;
  unitPrice: string | null;
  amount: string | null;
  /** A file's size in bytes. */
  size: number | null;
  /** Now: the change removes it. After: the change adds it. */
  marked: boolean;
}

/** One side of a field, typed for the renderer, which formats it in the reader's locale. */
export type ChangeValue =
  | { type: "none" }
  | { type: "text"; text: string }
  | { type: "money"; amount: string; currency: string }
  | { type: "number"; value: string }
  | { type: "date"; value: string }
  | { type: "lines"; items: ItemView[]; total: string | null; currency: string }
  | { type: "files"; items: ItemView[] }
  /** A list of records without a display (the fallback): a small table of text. */
  | { type: "table"; columns: string[]; rows: string[][] };

export interface ChangeField {
  /** Stable for test ids: the declared path's last part, or the record's field. */
  key: string;
  label: string;
  /** Lists render as their own now / after tables; the rest in the two-sided grid. */
  list: boolean;
  now: ChangeValue;
  after: ChangeValue;
  changed: boolean;
}

export interface ChangeModel {
  fields: ChangeField[];
  /** The record does not exist yet (a create): there is no "now". */
  create: boolean;
}

const NONE: ChangeValue = { type: "none" };

/**
 * Identity and concurrency fields: they name the record or guard the write, they are not part of
 * the change a person approves.
 */
// DECISION: without a display spec the card hides `id`, fields named like ids (`vendorId`,
// `replaceLineIds`) and version tokens (QBO's SyncToken, ETags); the record is named in the title.
const TOKENS = /^(id|ids|sync_?token|etag|version_?token)$/i;
const ID_NAMED = /^[a-z][A-Za-z0-9]*Ids?$|_ids?$/;
const HIDDEN = { test: (k: string) => TOKENS.test(k) || ID_NAMED.test(k) };

/** True when the record does not exist yet (a create): there is no "now". */
export function isCreate(before: unknown): boolean {
  return before === null || before === undefined;
}

/** The record as an object: a scalar before state is shown as one `value` field. */
function asRecord(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  return isPlainObject(v) ? v : { value: v };
}

// ── Plain text for anything ─────────────────────────────────────────────────────────────────────

/** A `{ id, name }` reference: shown by its name. */
function refName(v: unknown): string | null {
  if (!isPlainObject(v)) return null;
  for (const k of ["name", "displayName", "title", "label"]) {
    if (typeof v[k] === "string" && (v[k] as string).length > 0) return v[k] as string;
  }
  return null;
}

/**
 * A value as text: scalars as they are, refs by name, lists joined, objects as "Label: value"
 * pairs. Never JSON.
 */
export function formatValue(v: unknown, i18n: Pick<I18n, "fmt"> = EN): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "—";
    return v.map((x) => formatValue(x, i18n)).join(isPlainObject(v[0]) ? "; " : ", ");
  }
  if (isPlainObject(v)) {
    // `{ amount: "9742.3500", currency: "USD" }` reads "$9,742.35", never "9742.3500 USD".
    const m = moneyShape(v);
    if (m) return money(m.amount, m.currency, i18n);
    const name = refName(v);
    if (name !== null) return name;
    const pairs = Object.entries(v).filter(([k, x]) => !HIDDEN.test(k) && x !== undefined);
    if (pairs.length === 0) return "—";
    return pairs.map(([k, x]) => `${fieldLabel(k)}: ${formatValue(x, i18n)}`).join(", ");
  }
  return String(v);
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

// ── Declared fields ─────────────────────────────────────────────────────────────────────────────

const DECIMAL = /^-?\d+(\.\d+)?$/;

function str(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

type Names = Record<string, Record<string, string>>;

function asNames(v: unknown): Names {
  if (!isPlainObject(v)) return {};
  const out: Names = {};
  for (const [list, map] of Object.entries(v)) {
    if (!isPlainObject(map)) continue;
    out[list] = Object.fromEntries(
      Object.entries(map).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  }
  return out;
}

/**
 * What a line is booked to, as text: a `{ id, name }` ref by name, an id by the name the before
 * state keeps for it. An id with no name known reads as nothing ("—"), never "#20".
 */
// DECISION: a bare id is not shown to people (UI cleanup decision 3); when the tool couldn't
// name an item or account, the line still reads by its description and amount.
function refText(v: unknown, known: Record<string, string> | undefined): string | null {
  if (v === null || v === undefined) return null;
  const name = refName(v);
  if (name !== null) return name;
  const id = isPlainObject(v) ? str(v.id) : str(v);
  if (id === null) return null;
  return known?.[id] ?? null;
}

function itemView(
  raw: unknown,
  cols: DisplayColumns,
  names: Names,
  marked: boolean,
): ItemView | null {
  if (!isPlainObject(raw)) return null;
  const at = (k: string | undefined) => (k === undefined ? undefined : raw[k]);
  let ref: string | null = null;
  for (const r of cols.refs ?? []) {
    ref = refText(raw[r.key], r.names === undefined ? undefined : names[r.names]);
    if (ref !== null) break;
  }
  const size = at(cols.size);
  return {
    description: str(at(cols.description)),
    ref,
    qty: str(at(cols.qty)),
    unitPrice: str(at(cols.unitPrice)),
    amount: str(at(cols.amount)),
    size: typeof size === "number" && Number.isFinite(size) ? size : null,
    marked,
  };
}

function listOf(v: unknown): unknown[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** The sum of the lines' amounts, as a decimal string (never a float), or null if any is not one. */
function total(items: ItemView[]): string | null {
  if (items.length === 0 || items.some((l) => l.amount === null || !DECIMAL.test(l.amount))) {
    return null;
  }
  return items.reduce((s, l) => s.plus(dec(l.amount as string)), dec("0")).toFixed();
}

function currencyOf(field: DisplayField, ctx: { before: unknown; input: unknown }): string {
  const named = str(changeValue(ctx, field.currencyPath));
  return named && /^[A-Z]{3}$/.test(named.toUpperCase())
    ? named.toUpperCase()
    : (field.currency ?? "USD");
}

function scalar(field: DisplayField, raw: unknown, currency: string): ChangeValue {
  if (raw === null || raw === undefined || raw === "") return NONE;
  switch (field.kind) {
    case "money": {
      const amount = str(raw);
      return amount !== null && DECIMAL.test(amount)
        ? { type: "money", amount, currency }
        : { type: "text", text: formatValue(raw) };
    }
    case "number": {
      const value = str(raw);
      return value !== null && DECIMAL.test(value)
        ? { type: "number", value }
        : { type: "text", text: formatValue(raw) };
    }
    case "date":
      return typeof raw === "string"
        ? { type: "date", value: raw }
        : { type: "text", text: formatValue(raw) };
    default:
      return { type: "text", text: formatValue(raw) };
  }
}

function lastPart(path: ChangePath | undefined, fallback: string): string {
  return path?.split(".").at(-1) ?? fallback;
}

function declaredField(
  field: DisplayField,
  index: number,
  ctx: { before: unknown; input: unknown },
  names: Names,
  locale: Locale,
): ChangeField | null {
  const key = lastPart(field.now ?? field.after, `field${index}`);
  const label = pickLocalized(field.label, locale);
  const nowRaw = changeValue(ctx, field.now);
  // A field the change does not set reads the same after as now.
  const afterRaw = field.after === undefined ? nowRaw : changeValue(ctx, field.after);
  const currency = currencyOf(field, ctx);

  if (field.kind === "lines" || field.kind === "files") {
    const cols = field.columns ?? {};
    const removed = new Set(listOf(changeValue(ctx, field.removes)).map((v) => String(v)));
    const idOf = (raw: unknown) =>
      cols.id !== undefined && isPlainObject(raw) ? str(raw[cols.id]) : null;
    const nowItems = listOf(nowRaw)
      .map((raw) => {
        const id = idOf(raw);
        // Without `adds`, a change that sets the list replaces every item.
        const goes = field.after !== undefined && (!field.adds || (id !== null && removed.has(id)));
        return itemView(raw, cols, names, goes);
      })
      .filter((x): x is ItemView => x !== null);
    const afterItems =
      field.after === undefined
        ? nowItems.map((l) => ({ ...l, marked: false }))
        : [
            ...(field.adds
              ? listOf(nowRaw)
                  .filter((raw) => {
                    const id = idOf(raw);
                    return id === null || !removed.has(id);
                  })
                  .map((raw) => itemView(raw, cols, names, false))
              : []),
            ...listOf(afterRaw).map((raw) => itemView(raw, cols, names, true)),
          ].filter((x): x is ItemView => x !== null);
    const side = (items: ItemView[]): ChangeValue =>
      field.kind === "lines"
        ? { type: "lines", items, total: total(items), currency }
        : { type: "files", items };
    const changed = nowItems.some((l) => l.marked) || afterItems.some((l) => l.marked);
    if (nowItems.length === 0 && afterItems.length === 0) return null;
    return { key, label, list: true, now: side(nowItems), after: side(afterItems), changed };
  }

  const now = scalar(field, nowRaw, currency);
  const after = scalar(field, afterRaw, currency);
  // A field empty on both sides (an optional note the change leaves out) is not shown.
  if (now.type === "none" && after.type === "none") return null;
  const same =
    field.kind === "money" && now.type === "money" && after.type === "money"
      ? dec(now.amount).equals(dec(after.amount))
      : deepEqual(nowRaw ?? null, afterRaw ?? null);
  return { key, label, list: false, now, after, changed: !same };
}

// ── The fallback: the record's own fields ───────────────────────────────────────────────────────

/** Fields a record keeps money in, as decimal strings beside its `currency`. */
const MONEY_FIELD = /^(total|amount|subtotal|balance|tax|price|unitPrice|cost)$|(Total|Amount)$/;

function genericValue(v: unknown, field = "", currency: string | null = null): ChangeValue {
  if (v === null || v === undefined || v === "") return NONE;
  if (currency && MONEY_FIELD.test(field) && typeof v === "string" && DECIMAL.test(v)) {
    return { type: "money", amount: v, currency };
  }
  const m = moneyShape(v);
  if (m) return { type: "money", amount: m.amount, currency: m.currency };
  if (Array.isArray(v) && v.length > 0 && v.every(isPlainObject)) {
    const rows = v as Record<string, unknown>[];
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter(
      (k) => !HIDDEN.test(k),
    );
    return {
      type: "table",
      columns: columns.map(fieldLabel),
      rows: rows.map((r) => columns.map((c) => formatValue(r[c]))),
    };
  }
  return { type: "text", text: formatValue(v) };
}

/**
 * One row per field the change touches or the record has: `now` from `before` (absent for a new
 * record), `after` from the input where it sets the field, else unchanged.
 */
function genericFields(before: unknown, input: unknown): ChangeField[] {
  const now = asRecord(before);
  const set = asRecord(input) ?? {};
  const fields = [...new Set([...Object.keys(now ?? {}), ...Object.keys(set)])].filter(
    (f) => !HIDDEN.test(f),
  );
  const code = [set.currency, now?.currency].find(
    (c): c is string => typeof c === "string" && /^[A-Z]{3}$/.test(c),
  );
  return fields.map((field) => {
    const was = now ? now[field] : undefined;
    const after = Object.hasOwn(set, field) ? set[field] : was;
    const nowValue = genericValue(was, field, code ?? null);
    const afterValue = genericValue(after, field, code ?? null);
    return {
      key: field,
      label: fieldLabel(field),
      list: nowValue.type === "table" || afterValue.type === "table",
      now: nowValue,
      after: afterValue,
      changed: !deepEqual(was ?? null, after ?? null),
    };
  });
}

/** The change, field by field, through the tool's display when it declares one. */
export function changeModel(
  display: ToolDisplay | null | undefined,
  before: unknown,
  input: unknown,
  locale: Locale = "en",
): ChangeModel {
  const create = isCreate(before);
  if (!display) return { fields: genericFields(before, input), create };
  const ctx = { before, input };
  const names = asNames(changeValue(ctx, display.names));
  const fields = display.fields
    .map((f, i) => declaredField(f, i, ctx, names, locale))
    .filter((f): f is ChangeField => f !== null);
  return { fields, create };
}

// ── The card's title ────────────────────────────────────────────────────────────────────────────

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

/** `testkit.record.update` → "testkit": the connector a tool belongs to. */
export function connectorOf(toolId: string): string {
  return toolId.split(".")[0] ?? toolId;
}

/** "Testkit": a connector id as a name, when no manifest name is at hand. */
export function connectorName(id: string, names?: Record<string, string>): string {
  return names?.[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

export interface ChangeHeading {
  /** "QuickBooks bill 20418 · Northline Panel Supply". */
  title: string;
  /** The tool's plain line, when it declares one. */
  description: string | null;
  /** "QuickBooks": for "Sign and update QuickBooks". */
  connector: string;
}

/**
 * The card's heading: the tool's name, the record's number and whom it is with, in the reader's
 * language; without a display, the connector and the record's id and name.
 */
export function changeHeading(
  view: ChangeDisplayView | null | undefined,
  toolId: string,
  before: unknown,
  input: unknown,
  locale: Locale = "en",
): ChangeHeading {
  const connector = view?.connectorName ?? connectorName(connectorOf(toolId));
  const display = view?.tool ?? null;
  if (!display) {
    const target = changeTarget(before, input);
    return { title: target ? `${connector} · ${target}` : connector, description: null, connector };
  }
  const ctx = { before, input };
  const variant = display.nameBy ? str(changeValue(ctx, display.nameBy.path)) : null;
  const name = pickLocalized(
    (variant !== null ? display.nameBy?.names[variant] : undefined) ?? display.name,
    locale,
  );
  const number = str(changeValue(ctx, display.number));
  const subjectRaw = changeValue(ctx, display.subject);
  const subject = refName(subjectRaw) ?? str(subjectRaw);
  const head = number ? `${name} ${number}` : name;
  return {
    title: subject ? `${head} · ${subject}` : head,
    description: display.description ? pickLocalized(display.description, locale) : null,
    connector,
  };
}
