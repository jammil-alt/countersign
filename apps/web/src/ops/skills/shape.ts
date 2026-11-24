// Check the skill (owner, 2026-11-24): what a skill gets and gives back, as fields a person edits.
// A JSON Schema's top-level properties become fields with a kind in plain words; a list of records
// or a record keeps its own fields one level down (each filing's buyer, county, ZIP...). Anything
// the editor doesn't show (enum, format details, deeper nesting) is kept as it was, so a round
// trip changes only what was edited.

/** The kinds a field may be, in the words the screen shows. */
export const SHAPE_KINDS = [
  "text",
  "number",
  "whole",
  "yesno",
  "date",
  "document",
  "records",
  "list",
  "record",
] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

export const SHAPE_KIND_LABEL: Record<ShapeKind, string> = {
  text: "Text",
  number: "Number",
  whole: "Whole number",
  yesno: "Yes or no",
  date: "Date",
  document: "Document (PDF or image)",
  records: "List of records",
  list: "List of text",
  record: "Record",
};

/** The kinds that hold fields of their own. */
export const HAS_FIELDS: ReadonlySet<ShapeKind> = new Set(["records", "record"]);

export interface ShapeField {
  name: string;
  kind: ShapeKind;
  meaning: string;
  required: boolean;
  /** A list of records' or a record's own fields (one level down). */
  fields: ShapeField[];
  /** What else the property's schema said, kept as it was. */
  extra: Record<string, unknown>;
}

type Schema = Record<string, unknown>;

const isObject = (v: unknown): v is Schema => !!v && typeof v === "object" && !Array.isArray(v);

function kindOf(p: Schema): ShapeKind {
  const items = isObject(p.items) ? p.items : null;
  switch (p.type) {
    case "number":
      return "number";
    case "integer":
      return "whole";
    case "boolean":
      return "yesno";
    case "object":
      return "record";
    case "array":
      return items?.type === "object" || isObject(items?.properties) ? "records" : "list";
    default:
      if (p["x-document"] === true) return "document";
      if (p.format === "date") return "date";
      return "text";
  }
}

/** The fields of a schema's top-level properties (depth 0), or of a record's (depth 1). */
export function shapeFromSchema(schema: unknown, depth = 0): ShapeField[] {
  if (!isObject(schema) || !isObject(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(schema.properties).map(([name, raw]) => {
    const p = isObject(raw) ? raw : {};
    const kind = kindOf(p);
    const { type: _type, description, ...extra } = p;
    let fields: ShapeField[] = [];
    if (depth === 0 && kind === "records" && isObject(p.items)) {
      fields = shapeFromSchema(p.items, 1);
      const { properties: _p, required: _r, type: _t, ...itemExtra } = p.items;
      extra.items = itemExtra;
    } else if (depth === 0 && kind === "record") {
      fields = shapeFromSchema(p, 1);
      delete extra.properties;
      delete extra.required;
    }
    if (kind === "document") delete extra["x-document"];
    if (kind === "date") delete extra.format;
    return {
      name,
      kind,
      meaning: typeof description === "string" ? description : "",
      required: required.has(name),
      fields,
      extra,
    };
  });
}

function objectOf(fields: readonly ShapeField[], extra: Schema = {}): Schema {
  const properties: Schema = {};
  for (const f of fields) properties[f.name.trim()] = propertyOf(f);
  const required = fields.filter((f) => f.required).map((f) => f.name.trim());
  return { ...extra, type: "object", properties, ...(required.length ? { required } : {}) };
}

function propertyOf(f: ShapeField): Schema {
  const extra: Schema = { ...f.extra };
  // A field that changed kind drops the shapes the old kind had.
  if (f.kind !== "records" && f.kind !== "list") delete extra.items;
  if (f.kind !== "record") {
    delete extra.properties;
    delete extra.required;
  }
  if (f.kind !== "date") delete extra.format;
  delete extra["x-document"];
  const meaning = f.meaning.trim() ? { description: f.meaning.trim() } : {};
  switch (f.kind) {
    case "number":
      return { ...extra, type: "number", ...meaning };
    case "whole":
      return { ...extra, type: "integer", ...meaning };
    case "yesno":
      return { ...extra, type: "boolean", ...meaning };
    case "date":
      return { ...extra, type: "string", format: "date", ...meaning };
    case "document":
      return { ...extra, type: "string", "x-document": true, ...meaning };
    case "records": {
      const items = isObject(extra.items) ? extra.items : {};
      return { ...extra, type: "array", items: objectOf(f.fields, items), ...meaning };
    }
    case "list": {
      const items = isObject(extra.items) && extra.items.type !== "object" ? extra.items : {};
      return { ...extra, type: "array", items: { type: "string", ...items }, ...meaning };
    }
    case "record":
      return { ...objectOf(f.fields, extra), ...meaning };
    default:
      return { ...extra, type: "string", ...meaning };
  }
}

/** The JSON Schema of the fields: an object with each field a property. */
export function schemaFromShape(fields: readonly ShapeField[]): Schema {
  return objectOf(fields);
}

/** A new, empty field. */
export function blankField(): ShapeField {
  return { name: "", kind: "text", meaning: "", required: false, fields: [], extra: {} };
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What stops the fields from saving, in plain words; empty when nothing does. */
export function shapeProblems(fields: readonly ShapeField[], where: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of fields) {
    const name = f.name.trim();
    if (!name) out.push(`A field in ${where} has no name.`);
    else if (!NAME.test(name))
      out.push(`${where}: “${name}” is a field name with letters, digits and _ only.`);
    else if (seen.has(name)) out.push(`${where} has “${name}” twice.`);
    seen.add(name);
    if (HAS_FIELDS.has(f.kind))
      out.push(...shapeProblems(f.fields, `${where} › ${name || "a field"}`));
  }
  return out;
}
