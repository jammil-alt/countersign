// Data in and out of files (owner, 2026-11-20; docs/plan.md §1.164): the table files a client's
// documents may be besides PDFs and images: .csv, .xlsx and .json. They are stored and read in code
// (Read table), never sent to a model as files: extraction and an AI skill's `x-document` refuse
// them (`isExtractable` stays PDFs and images).

export const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const CSV_MIME_TYPE = "text/csv";
export const JSON_MIME_TYPE = "application/json";

/** The table files a document may be, by mime type. */
export const TABLE_MIME_TYPES = [CSV_MIME_TYPE, XLSX_MIME_TYPE, JSON_MIME_TYPE] as const;
export type TableMimeType = (typeof TABLE_MIME_TYPES)[number];

export type TableFileKind = "csv" | "xlsx" | "json";

const KIND: Record<TableMimeType, TableFileKind> = {
  [CSV_MIME_TYPE]: "csv",
  [XLSX_MIME_TYPE]: "xlsx",
  [JSON_MIME_TYPE]: "json",
};

/** The extension each table file is stored and named with. */
export const TABLE_EXTENSION_TYPES: Readonly<Record<TableFileKind, TableMimeType>> = {
  csv: CSV_MIME_TYPE,
  xlsx: XLSX_MIME_TYPE,
  json: JSON_MIME_TYPE,
};

export function isTableType(mime: string): mime is TableMimeType {
  return (TABLE_MIME_TYPES as readonly string[]).includes(mime);
}

/** `csv`, `xlsx` or `json` for a table file's type; null for any other. */
export function tableFileKind(mime: string): TableFileKind | null {
  return isTableType(mime) ? KIND[mime] : null;
}

/** A table file's type from what was declared and its name (`text/plain` + `.csv` → CSV). */
export function tableMimeType(declared: string, filename: string): TableMimeType | null {
  const d = (declared.split(";")[0] ?? "").trim().toLowerCase();
  // Browsers and mail clients declare CSV in several ways.
  if (d === "application/csv" || d === "text/x-csv" || d === "application/x-csv") {
    return CSV_MIME_TYPE;
  }
  if (isTableType(d)) return d;
  const ext = filename.toLowerCase().split(".").at(-1) ?? "";
  return Object.hasOwn(TABLE_EXTENSION_TYPES, ext)
    ? TABLE_EXTENSION_TYPES[ext as TableFileKind]
    : null;
}

/**
 * Whether a table file's bytes look like its type: an .xlsx is a zip (`PK\x03\x04`), a .json
 * starts with `{` or `[` (after a byte-order mark and white space), and a .csv is text (no NUL
 * byte in its first 4 KB).
 */
export function tableBytesMatch(bytes: Uint8Array, mime: string): boolean {
  switch (tableFileKind(mime)) {
    case "xlsx":
      return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    case "json": {
      let i = 0;
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
      while (i < bytes.length && [0x20, 0x09, 0x0a, 0x0d].includes(bytes[i] as number)) i++;
      return bytes[i] === 0x7b || bytes[i] === 0x5b;
    }
    case "csv":
      return !bytes.subarray(0, 4096).includes(0);
    default:
      return false;
  }
}
