// Data in and out of files (owner, 2026-11-20; docs/plan.md §1.164): the expected columns of a
// table file, as the `columns` skill parameter holds them. Read table reads a .csv, .xlsx or .json
// file into rows by them; Write table writes rows out by them. Each column names the field it
// fills, the header names it accepts in a file ("Vendor", "Payee", "Supplier"), its type and
// whether a file must have it. Data only: no code, nothing a model writes at run time.

import { z } from "zod";

/** A column's field name: how later steps read it (`{{steps.read.output.rows}}` → `vendor`). */
export const TableFieldName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, "letters, digits and underscores, from a letter");

export const TABLE_COLUMN_TYPES = ["text", "number", "money", "date", "boolean"] as const;
export const TableColumnType = z.enum(TABLE_COLUMN_TYPES);
export type TableColumnType = z.infer<typeof TableColumnType>;

/** How a file writes its dates: 2026-11-20, 11/20/2026 or 20/11/2026. Read and written. */
export const TABLE_DATE_STYLES = ["iso", "mdy", "dmy"] as const;
export const TableDateStyle = z.enum(TABLE_DATE_STYLES);
export type TableDateStyle = z.infer<typeof TableDateStyle>;

/** One expected column. */
export const TableColumn = z.strictObject({
  field: TableFieldName,
  /**
   * The header names a file may give it, in order of preference; the field name always counts
   * too. Matched in any case, ignoring spaces and punctuation. Writing, the first is the header.
   */
  headers: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  type: TableColumnType,
  /** For a date: how the file writes it (default `iso`). Ignored for other types. */
  dateStyle: TableDateStyle.optional(),
  /** A file without it fails the step, naming it (default false). */
  required: z.boolean().optional(),
  /**
   * A column only this client has (docs/plan.md §1.164, "Per agent, per step"), shown as such in
   * the editor. A promotion never carries it: promotion carries no client's parameter values at
   * all (`stripForPromotion` in packages/agents keeps the template's own, or none).
   */
  // DECISION: no column-by-column merge on promotion; the stricter whole-value rule already keeps
  // a client's columns out, and a shared improvement goes into the template by hand.
  clientSpecific: z.boolean().optional(),
});
export type TableColumn = z.infer<typeof TableColumn>;
export type TableColumnInput = z.input<typeof TableColumn>;

/** The `columns` parameter's value: at most 200 columns, each field named once. */
export const TableColumns = z
  .array(TableColumn)
  .max(200)
  .refine((list) => new Set(list.map((c) => c.field)).size === list.length, {
    message: "each field is named once",
  });
export type TableColumns = z.infer<typeof TableColumns>;

/** The header a written file gives a column: its first header name, else its field name. */
export function columnLabel(c: Pick<TableColumn, "field" | "headers">): string {
  return c.headers[0] ?? c.field;
}

/** A header as it is compared: lower case, letters and digits only ("Vendor Name:" → vendorname). */
export function headerKey(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
