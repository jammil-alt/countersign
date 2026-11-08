// How a write tool's change reads on an approval card ("now / after this change", docs/plan.md §1.x
// "Inbox and run views"). A connector declares it on each write tool; the inbox and run views render
// every tool through one generic renderer, which shows only the declared fields. Tools without it
// fall back to the record's own fields, field by field.
import { z } from "zod";
import { LocalizedString } from "../i18n/locale";
import { CurrencyCode } from "../money";

/**
 * A value in the change: `before.<field>` (the record in the client's tool now) or
 * `input.<field>` (what the change sets), dotted for nested fields.
 */
export const ChangePath = z
  .string()
  .regex(/^(before|input)(\.[A-Za-z_][A-Za-z0-9_]*)+$/, "before.<field> or input.<field>");
export type ChangePath = z.infer<typeof ChangePath>;

/** A field inside one line or file of a list, e.g. `amount`. */
const ItemKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/**
 * - `text`, `number`, `date`: shown as they are (dates and figures in the reader's locale);
 * - `money`: a decimal string with its currency;
 * - `ref`: a `{ id, name }` reference, shown by name;
 * - `lines`: a list of lines, shown as a small table with its total;
 * - `files`: a list of files, by name and size.
 */
export const DisplayKind = z.enum(["text", "number", "date", "money", "ref", "lines", "files"]);
export type DisplayKind = z.infer<typeof DisplayKind>;

/** The columns of a `lines` or `files` list: keys inside each item. */
export const DisplayColumns = z.strictObject({
  /** The item's own id, for `removes`. */
  id: ItemKey.optional(),
  /** The line's description, or the file's name. */
  description: ItemKey.optional(),
  qty: ItemKey.optional(),
  unitPrice: ItemKey.optional(),
  amount: ItemKey.optional(),
  /** A file's size in bytes. */
  size: ItemKey.optional(),
  /**
   * What a line is booked to, the first one present: a `{ id, name }` ref, or an id whose name
   * the before state keeps under the tool's `names` (`names: "items"` → `names.items[<id>]`).
   */
  refs: z
    .array(z.strictObject({ key: ItemKey, names: ItemKey.optional() }))
    .max(4)
    .optional(),
  // P-2 (docs/plan.md §1.64): a line's job and class.
  /**
   * More refs a line carries besides what it is booked to (its customer, its class), each one
   * present shown by name with it, read the same way as `refs`.
   */
  tags: z
    .array(z.strictObject({ key: ItemKey, names: ItemKey.optional() }))
    .max(4)
    .optional(),
});
export type DisplayColumns = z.infer<typeof DisplayColumns>;

/** Display kinds a person may edit before signing: plain values, never references (ids) or lists. */
export const EDITABLE_KINDS = ["text", "number", "date", "money"] as const;

export const DisplayField = z
  .strictObject({
    label: LocalizedString,
    kind: DisplayKind,
    /** The value now; absent when the record has no such value before the change. */
    now: ChangePath.optional(),
    /** The value after the change; absent when the change leaves it as it is now. */
    after: ChangePath.optional(),
    /** Money: where the currency code is (else `currency`, else USD). */
    currencyPath: ChangePath.optional(),
    currency: CurrencyCode.optional(),
    /** Lists: `after`'s items are added to the items now, rather than replacing them. */
    adds: z.boolean().optional(),
    /** Lists: the ids of the items now that the change removes (with `adds`, e.g. replaced lines). */
    removes: ChangePath.optional(),
    columns: DisplayColumns.optional(),
    // v0.12 W1-D: edit before signing (ARCHITECTURE §11.1).
    /**
     * The person signing may change this value before they sign: only a plain value (text, number,
     * date, money) the change sets from its input (`after: input.<field>`). Never ids, guards,
     * version tokens or fixed inputs; the edit is validated and routed again on the server.
     */
    editable: z.boolean().optional(),
  })
  .refine(
    (f) =>
      f.editable !== true ||
      (f.after?.startsWith("input.") === true &&
        (EDITABLE_KINDS as readonly string[]).includes(f.kind)),
    {
      message: "only a text, number, date or money value set from input.<field> can be editable",
      path: ["editable"],
    },
  );
export type DisplayField = z.infer<typeof DisplayField>;

export const ToolDisplay = z
  .strictObject({
    /** What the change is to, as a person names it: "QuickBooks bill". */
    name: LocalizedString,
    /**
     * For a tool that acts on several kinds of record: the name by the value at `path` (e.g. the
     * input's `entity`), else `name`.
     */
    nameBy: z
      .strictObject({ path: ChangePath, names: z.record(z.string(), LocalizedString) })
      .optional(),
    /** One plain line on what the change does, for the person approving it. */
    description: LocalizedString.optional(),
    /** The record's number as people know it, e.g. a bill's number. */
    number: ChangePath.optional(),
    /** Whom the record is with, e.g. its vendor: a `{ id, name }` ref or text. */
    subject: ChangePath.optional(),
    /** Where the before state keeps names for ids the input uses: `{ <list>: { <id>: name } }`. */
    names: ChangePath.optional(),
    /** The fields a person reads, in order. Nothing else of the record or the input is shown. */
    fields: z.array(DisplayField).min(1).max(20),
  })
  .meta({ id: "ToolDisplay" });
export type ToolDisplay = z.infer<typeof ToolDisplay>;

/** The value at a dotted path of `{ before, input }`, or undefined. */
export function changeValue(
  change: { before: unknown; input: unknown },
  path: ChangePath | undefined,
): unknown {
  if (path === undefined) return undefined;
  let at: unknown = change;
  for (const key of path.split(".")) {
    if (at === null || typeof at !== "object" || Array.isArray(at)) return undefined;
    at = Object.hasOwn(at, key) ? (at as Record<string, unknown>)[key] : undefined;
  }
  return at;
}
