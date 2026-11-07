// CSV for exports (docs/plan.md §1.36): RFC 4180 quoting, CRLF line ends, a UTF-8 byte order mark
// so spreadsheet programs read accents and non-Latin names right, times in ISO 8601 (UTC), money
// as decimal strings beside their currency, and structured values (an external action's before
// and after) as JSON with the fields no client may see taken out.

import { FORBIDDEN_PORTAL_FIELD, FORBIDDEN_SECRET_FIELD, isPlainObject } from "@countersign/core";

export type CsvValue = string | number | boolean | Date | null | undefined | readonly string[];

const encoder = new TextEncoder();
export const CSV_BOM = "﻿";
export const CSV_TYPE = "text/csv; charset=utf-8";

// DECISION: a text cell that a spreadsheet would run as a formula (it starts with =, +, -, @, a tab
// or a carriage return, and is not a number) gets a leading apostrophe, the usual guard against
// CSV injection. Numbers and decimal strings such as "-12.5000" are left as they are.
const FORMULA_START = /^[=+\-@\t\r]/;
const NUMBER = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function cellText(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.join("; ");
  if (typeof value === "string") {
    return FORMULA_START.test(value) && !NUMBER.test(value) ? `'${value}` : value;
  }
  return String(value);
}

export function csvCell(value: CsvValue): string {
  const text = cellText(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(values: readonly CsvValue[]): string {
  return `${values.map(csvCell).join(",")}\r\n`;
}

/** A whole CSV file: the byte order mark, the header and the rows. */
export function csvFile(
  header: readonly string[],
  rows: readonly (readonly CsvValue[])[],
): Uint8Array<ArrayBuffer> {
  const bytes = encoder.encode(CSV_BOM + csvLine(header) + rows.map(csvLine).join(""));
  return new Uint8Array(bytes);
}

/**
 * A structured value with every field a client may never see removed at any depth: agent
 * definitions, instructions, prompts, cost and tokens (invariant 11), and secrets (invariant 13).
 */
export function scrubForExport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubForExport);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_PORTAL_FIELD.test(k) || FORBIDDEN_SECRET_FIELD.test(k)) continue;
    out[k] = scrubForExport(v);
  }
  return out;
}

/** A JSON cell: the scrubbed value, or empty for null. */
export function jsonCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(scrubForExport(value));
}

/** A file name safe on every system, kept short. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize("NFC")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed.
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  const short = cleaned.length > 120 ? cleaned.slice(cleaned.length - 120) : cleaned;
  return short || "document";
}

/**
 * A document's path in an export: `documents/<last 8 of its id>-<its file name>`. The accountant
 * and client data exports name a document the same way, so a CSV row finds its file.
 */
export function documentPath(doc: { id: string; filename: string }): string {
  return `documents/${doc.id.replace(/-/g, "").slice(-8)}-${safeFileName(doc.filename)}`;
}
