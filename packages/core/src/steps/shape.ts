// What a value looks like as it travels between steps (docs/step-model-plan.md §6, ARCHITECTURE
// §10.2): the one model the publish checks read every step's output and every action's input in,
// whether it was declared as fields (a Do step's output, a Match profile) or as a JSON Schema (a
// tool's, a skill's, a trigger's). Pure: the server's publish checks, the web builder and the run's
// conversions use the same code, so what publishing accepts is what the run does.

import DecimalJs from "decimal.js";
import { isPlainObject } from "../json";
import type { JsonSchema } from "../schemas/common";
import type { Field } from "./schema";

/**
 * A value's shape. `any` is not known (an untyped JSON field, a registry the caller didn't pass):
 * anything read under it passes. A group is `open` when it may hold fields it doesn't name.
 */
export type Shape =
  | { type: "any"; about?: string | undefined }
  | { type: "text" | "number" | "date" | "yes_no"; about?: string | undefined }
  | { type: "record"; record?: string | undefined; about?: string | undefined }
  /** An amount and its currency: `{ amount: "125.00", currency: "USD" }`. */
  | { type: "money"; about?: string | undefined }
  | { type: "list"; of: Shape; about?: string | undefined }
  | {
      type: "group";
      fields: Readonly<Record<string, Shape>>;
      required?: readonly string[] | undefined;
      open?: boolean | undefined;
      about?: string | undefined;
    };

export type GroupShape = Extract<Shape, { type: "group" }>;

export const ANY: Shape = { type: "any" };

export const group = (
  fields: Readonly<Record<string, Shape>>,
  more: Omit<GroupShape, "type" | "fields"> = {},
): GroupShape => ({ type: "group", fields, ...more });

const TEXT: Shape = { type: "text" };
const MONEY_PARTS = group({ amount: TEXT, currency: TEXT }, { required: ["amount", "currency"] });

// ── From fields ──────────────────────────────────────────────────────────────────────────────────

export interface FieldShapeOptions {
  /**
   * How a `money` field travels: as `{ amount, currency }` (`object`: what a Do step written in
   * the step hands on, its step skill's schema) or as a decimal string (`decimal`: a Loop's
   * output, a translation's).
   */
  money?: "object" | "decimal";
}

export function fieldShape(field: Field, options: FieldShapeOptions = {}): Shape {
  const about = field.about ? { about: field.about } : {};
  switch (field.type) {
    case "text":
    case "number":
    case "date":
    case "yes_no":
      return { type: field.type, ...about };
    case "money":
      return options.money === "decimal"
        ? { type: "text", about: field.about ?? "an amount, as a decimal" }
        : { type: "money", ...about };
    case "record":
      return { type: "record", ...(field.record ? { record: field.record } : {}), ...about };
    case "group":
      return { ...fieldsShape(field.of ?? [], options), ...about };
    case "list":
      // A list of plain values names no fields: each item is text (`fieldAt`).
      return {
        type: "list",
        of: (field.of ?? []).length > 0 ? fieldsShape(field.of ?? [], options) : TEXT,
        ...about,
      };
  }
}

/** Fields as one group: closed, the required ones required. */
export function fieldsShape(fields: readonly Field[], options: FieldShapeOptions = {}): GroupShape {
  return group(Object.fromEntries(fields.map((f) => [f.name, fieldShape(f, options)])), {
    required: fields.filter((f) => f.required).map((f) => f.name),
  });
}

// ── From a JSON Schema ───────────────────────────────────────────────────────────────────────────

function deref(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return schema;
  let cur: unknown = root;
  for (const seg of ref.slice(2).split("/")) {
    cur = isPlainObject(cur) ? cur[seg.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
  }
  return isPlainObject(cur) ? (cur as JsonSchema) : {};
}

/**
 * A JSON Schema's shape. Unknown (`undefined`, `{}`, a type it can't tell) is `any`; an object with
 * declared properties is closed unless it says otherwise (as the template typer reads it); an object
 * of exactly `amount` and `currency` is money; a string marked `x-record` is a record's id.
 */
export function schemaShape(schema: JsonSchema | undefined, root?: JsonSchema, depth = 0): Shape {
  if (!schema || !isPlainObject(schema) || depth > 12) return ANY;
  const top = root ?? schema;
  const s = deref(schema, top);
  const about = typeof s.description === "string" ? { about: s.description.slice(0, 200) } : {};
  for (const key of ["anyOf", "oneOf"] as const) {
    const alts = s[key];
    if (!Array.isArray(alts)) continue;
    const real = alts.filter(
      (a) => isPlainObject(a) && !(a.type === "null" && Object.keys(a).length === 1),
    );
    // DECISION: one alternative besides null is that one; several are read as not known.
    return real.length === 1 ? schemaShape(real[0] as JsonSchema, top, depth + 1) : ANY;
  }
  const raw = s.type;
  const types = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter(
    (t) => t !== "null",
  );
  const type =
    types.length === 1
      ? types[0]
      : types.length === 0
        ? isPlainObject(s.properties)
          ? "object"
          : s.items !== undefined
            ? "array"
            : undefined
        : undefined;
  switch (type) {
    case "string":
      if (typeof s["x-record"] === "string") {
        return { type: "record", record: s["x-record"] as string, ...about };
      }
      return s.format === "date" || s.format === "date-time"
        ? { type: "date", ...about }
        : { type: "text", ...about };
    case "number":
    case "integer":
      return { type: "number", ...about };
    case "boolean":
      return { type: "yes_no", ...about };
    case "array":
      return {
        type: "list",
        of: isPlainObject(s.items) ? schemaShape(s.items as JsonSchema, top, depth + 1) : ANY,
        ...about,
      };
    case "object": {
      if (!isPlainObject(s.properties)) return { ...group({}, { open: true }), ...about };
      const props = s.properties as Record<string, unknown>;
      const keys = Object.keys(props);
      if (keys.length === 2 && keys.includes("amount") && keys.includes("currency")) {
        return { type: "money", ...about };
      }
      const fields = Object.fromEntries(
        keys.map((k) => [
          k,
          isPlainObject(props[k]) ? schemaShape(props[k] as JsonSchema, top, depth + 1) : ANY,
        ]),
      );
      const extra = s.additionalProperties;
      return group(fields, {
        required: Array.isArray(s.required)
          ? s.required.filter((r): r is string => typeof r === "string")
          : [],
        ...(extra === true || isPlainObject(extra) ? { open: true } : {}),
        ...about,
      });
    }
    default:
      return ANY;
  }
}

// ── Putting shapes together ──────────────────────────────────────────────────────────────────────

/**
 * What either of two shapes may be (the paths of a Fork that rejoin): a group holds the fields of
 * both, a list the items of either; two different kinds of value are not known.
 */
export function mergeShapes(a: Shape, b: Shape): Shape {
  if (a.type === "any" || b.type === "any") return ANY;
  if (a.type === "group" && b.type === "group") {
    const fields: Record<string, Shape> = { ...a.fields };
    for (const [k, v] of Object.entries(b.fields)) {
      const here = fields[k];
      fields[k] = here ? mergeShapes(here, v) : v;
    }
    const required = (a.required ?? []).filter((r) => (b.required ?? []).includes(r));
    return group(fields, { required, ...(a.open || b.open ? { open: true } : {}) });
  }
  if (a.type === "list" && b.type === "list") return { type: "list", of: mergeShapes(a.of, b.of) };
  if (a.type === "record" && b.type === "record") {
    return a.record === b.record ? a : { type: "record" };
  }
  return a.type === b.type ? a : ANY;
}

/** A group with more fields beside its own (theirs win a clash); any other shape as it is. */
export function withFields(shape: Shape, more: Readonly<Record<string, Shape>>): Shape {
  if (shape.type !== "group") return shape;
  return { ...shape, fields: { ...shape.fields, ...more } };
}

// ── Reading a path ───────────────────────────────────────────────────────────────────────────────

export type ShapeAt =
  | { ok: true; shape: Shape }
  /** `reached` segments of the path were found; `shape` is what is there. */
  | { ok: false; reached: number; shape: Shape };

/**
 * The shape at a path (`items.0.matched`): a group's field, a list's item by its position, a
 * list's or a text's `length`, money's `amount` and `currency`. Anything under `any` is `any`.
 */
export function shapeAt(shape: Shape, path: readonly string[]): ShapeAt {
  let cur = shape;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i] as string;
    if (cur.type === "any") return { ok: true, shape: ANY };
    const next = step(cur, seg);
    if (!next) return { ok: false, reached: i, shape: cur };
    cur = next;
  }
  return { ok: true, shape: cur };
}

function step(shape: Shape, seg: string): Shape | undefined {
  switch (shape.type) {
    case "group": {
      if (Object.hasOwn(shape.fields, seg)) return shape.fields[seg];
      return shape.open ? ANY : undefined;
    }
    case "list":
      if (/^\d+$/.test(seg)) return shape.of;
      return seg === "length" ? { type: "number" } : undefined;
    case "money":
      return Object.hasOwn(MONEY_PARTS.fields, seg) ? MONEY_PARTS.fields[seg] : undefined;
    case "text":
      return seg === "length" ? { type: "number" } : undefined;
    default:
      return undefined;
  }
}

// ── Words ───────────────────────────────────────────────────────────────────────────────────────

const recordWords = (record: string | undefined) =>
  record ? `the ${record.replace(/_/g, " ")}'s id` : "a record's id";

/** A shape in a few plain words: "the vendor's id", "a list", "an amount and a currency". */
export function shapeWords(shape: Shape): string {
  switch (shape.type) {
    case "any":
      return "anything";
    case "text":
      return "text";
    case "number":
      return "a number";
    case "date":
      return "a date";
    case "yes_no":
      return "yes or no";
    case "record":
      return recordWords(shape.record);
    case "money":
      return "an amount and a currency";
    case "list":
      return shape.of.type === "group" || shape.of.type === "money"
        ? "a list"
        : `a list of ${plural(shape.of)}`;
    case "group":
      return "a group of fields";
  }
}

function plural(shape: Shape): string {
  switch (shape.type) {
    case "text":
      return "text";
    case "number":
      return "numbers";
    case "date":
      return "dates";
    case "yes_no":
      return "yes or no";
    case "record":
      return shape.record ? `${shape.record.replace(/_/g, " ")} ids` : "record ids";
    default:
      return "values";
  }
}

/** A group's own field names, as `a`, `b` and `c` (at most `max`, then "and N more"). */
export function fieldList(shape: GroupShape, max = 8): string {
  const names = Object.keys(shape.fields).map((n) => `\`${n}\``);
  if (names.length === 0) return "nothing";
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length === 1) return shown[0] as string;
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

// ── Does it fit ──────────────────────────────────────────────────────────────────────────────────

/**
 * The conversions the run makes by itself where a value's form differs from what the step takes:
 * money to its amount (when the currencies agree), a number to a decimal string. A text into a
 * record's id and a list's item by its position need none.
 */
export type Conversion = "money_amount" | "number_text";

export type Fit =
  | { fits: true; conversions: Conversion[] }
  | {
      fits: false;
      /** Why, as what the source is ("is a list, and …", "has no `amount`, which this needs"). */
      why: string;
      /** Where inside the source it doesn't fit (`["0", "amount"]`); empty: the source itself. */
      at: string[];
    };

const FITS: Fit = { fits: true, conversions: [] };

/**
 * Whether a value of the `source` shape fits a field of the `target` one, and the conversion it
 * needs. Lenient where nothing can be known: `any` on either side fits, text fits a date, and a
 * group missing a field it would need is refused only when the group is closed.
 */
export function fitShape(source: Shape, target: Shape, depth = 0): Fit {
  if (source.type === "any" || target.type === "any" || depth > 12) return FITS;
  const nope = (why: string, at: string[] = []): Fit => ({ fits: false, why, at });
  const is = `is ${shapeWords(source)}`;
  switch (target.type) {
    case "text":
      if (source.type === "text" || source.type === "date" || source.type === "record") {
        return FITS;
      }
      if (source.type === "number") return { fits: true, conversions: ["number_text"] };
      if (source.type === "money") return { fits: true, conversions: ["money_amount"] };
      if (source.type === "list") {
        return nope(`${is}, and this takes one value: read one of its items by position (\`.0\`)`);
      }
      return nope(`${is}, and this takes text`);
    case "number":
      if (source.type === "number") return FITS;
      return nope(`${is}, and this takes a number`);
    case "date":
      return source.type === "date" || source.type === "text"
        ? FITS
        : nope(`${is}, and this takes a date`);
    case "yes_no":
      return source.type === "yes_no" ? FITS : nope(`${is}, and this takes yes or no`);
    case "record":
      if (source.type === "text") return FITS;
      if (source.type === "record") {
        return !source.record || !target.record || source.record === target.record
          ? FITS
          : nope(`${is}, and this takes ${recordWords(target.record)}`);
      }
      if (source.type === "group" && Object.hasOwn(source.fields, "id")) {
        return nope(`${is}, and this takes its id: read its \`id\``);
      }
      return nope(`${is}, and this takes ${recordWords(target.record)}`);
    case "money":
      return source.type === "money"
        ? FITS
        : nope(`${is}, and this takes an amount and a currency`);
    case "list": {
      if (source.type !== "list") return nope(`${is}, and this takes a list`);
      const inner = fitShape(source.of, target.of, depth + 1);
      return inner.fits ? inner : nope(inner.why, ["0", ...inner.at]);
    }
    case "group": {
      const from = source.type === "money" ? MONEY_PARTS : source;
      if (from.type !== "group") return nope(`${is}, and this takes a group of fields`);
      const conversions = new Set<Conversion>();
      for (const [name, want] of Object.entries(target.fields)) {
        const has = Object.hasOwn(from.fields, name) ? from.fields[name] : undefined;
        if (!has) {
          if ((target.required ?? []).includes(name) && !from.open) {
            return nope(`has no \`${name}\`, which this needs`);
          }
          continue;
        }
        const f = fitShape(has, want, depth + 1);
        if (!f.fits) return nope(f.why, [name, ...f.at]);
        for (const c of f.conversions) conversions.add(c);
      }
      return { fits: true, conversions: [...conversions] };
    }
  }
}

// ── At run time ──────────────────────────────────────────────────────────────────────────────────

const isMoneyValue = (v: unknown): v is { amount: string; currency: string } =>
  isPlainObject(v) &&
  Object.keys(v).length === 2 &&
  typeof v.amount === "string" &&
  typeof v.currency === "string";

export interface Converted {
  value: unknown;
  /** Where a conversion couldn't be made safely, in plain words; the value is then as it came. */
  problems: string[];
}

/**
 * A step's resolved input with the conversions `fitShape` allows made where the step takes
 * another form (`target`, the action's or skill's input): money to its amount, a number to a
 * decimal string. Money becomes its amount only when every amount converted is in one currency,
 * and that is the input's own `currency` when it names one: an amount never loses its currency
 * (invariant 6, and the connector's last resort, `moneyAsDecimals`, holds to the same).
 */
export function convertToShape(value: unknown, target: Shape): Converted {
  const currencies = new Set<string>();
  let converted = false;
  const walk = (v: unknown, t: Shape, depth: number): unknown => {
    if (depth > 12 || t.type === "any") return v;
    if (t.type === "text") {
      if (isMoneyValue(v)) {
        currencies.add(v.currency.toUpperCase());
        converted = true;
        return v.amount;
      }
      if (typeof v === "number" && Number.isFinite(v)) {
        converted = true;
        return new DecimalJs(v).toFixed();
      }
      return v;
    }
    if (t.type === "list" && Array.isArray(v)) return v.map((x) => walk(x, t.of, depth + 1));
    if (t.type === "group" && isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const want = Object.hasOwn(t.fields, k) ? t.fields[k] : undefined;
        out[k] = want ? walk(x, want, depth + 1) : x;
      }
      return out;
    }
    return v;
  };
  const out = walk(value, target, 0);
  if (!converted) return { value, problems: [] };
  const own = isPlainObject(value) ? value.currency : undefined;
  const ownCode = typeof own === "string" ? own.toUpperCase() : undefined;
  if (currencies.size > 1) {
    return {
      value,
      problems: [
        `its amounts are in ${[...currencies].join(" and ")}, and this takes amounts in one currency`,
      ],
    };
  }
  const [only] = [...currencies];
  if (only && ownCode && only !== ownCode) {
    return {
      value,
      problems: [`its amounts are in ${only}, and its currency is ${ownCode}`],
    };
  }
  return { value: out, problems: [] };
}
