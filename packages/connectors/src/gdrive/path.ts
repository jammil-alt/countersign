// Where `drive.file.upload` files a document: a path template under the connection's own folder,
// such as `Bills/{yyyy}/{MM}`, resolved against a date. Index loops only (no regular expressions on
// what an agent or a step wrote), and every segment is checked: no `.` or `..`, no control
// characters, no empty names, a bounded depth.
// DECISION: date tokens take single braces (`{yyyy}`, `{yy}`, `{MM}`, `{dd}`), not ARCHITECTURE
// §6.11's `{{yyyy}}`: in a workflow step's input `{{…}}` is the workflow's own template, so
// `{{yyyy}}` would be read (and refused) as a reference. The day itself can come from the workflow
// (`date: "{{trigger.invoiceDate}}"`).

/** The date parts a template may use. */
export const PATH_TOKENS = ["yyyy", "yy", "MM", "dd"] as const;
export type PathToken = (typeof PATH_TOKENS)[number];

export const MAX_TEMPLATE_LENGTH = 300;
export const MAX_SEGMENTS = 8;
export const MAX_SEGMENT_LENGTH = 100;
export const MAX_FILE_NAME_LENGTH = 200;

export interface PathDate {
  year: number;
  /** 1–12. */
  month: number;
  /** 1–31. */
  day: number;
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

function tokenValue(token: string, date: PathDate): string | null {
  switch (token) {
    case "yyyy":
      return pad(date.year, 4);
    case "yy":
      return pad(date.year % 100, 2);
    case "MM":
      return pad(date.month, 2);
    case "dd":
      return pad(date.day, 2);
    default:
      return null;
  }
}

function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Why a folder or file name can't be used, or null. */
export function nameProblem(name: string, max = MAX_SEGMENT_LENGTH): string | null {
  if (name.length === 0) return "a name is empty";
  if (name.length > max) return `"${name.slice(0, 20)}…" is longer than ${max} characters`;
  if (name === "." || name === "..") return `"${name}" can't be a folder name`;
  if (hasControl(name)) return "a name has a control character";
  return null;
}

/** Splits a resolved path into its folder names: `/`-separated, trimmed, empty parts dropped. */
export function pathSegments(path: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i <= path.length; i++) {
    if (i === path.length || path[i] === "/") {
      const part = path.slice(start, i).trim();
      if (part.length > 0) out.push(part);
      start = i + 1;
    }
  }
  return out;
}

export type Resolved = { ok: true; segments: string[] } | { ok: false; problems: string[] };

/** Fills the template's `{token}`s from the date and checks the folders it names. */
export function resolvePathTemplate(template: string, date: PathDate): Resolved {
  const problems: string[] = [];
  if (template.length > MAX_TEMPLATE_LENGTH) {
    return { ok: false, problems: [`the path is longer than ${MAX_TEMPLATE_LENGTH} characters`] };
  }
  let out = "";
  let i = 0;
  while (i < template.length) {
    if (template[i] === "{") {
      const end = template.indexOf("}", i + 1);
      if (end < 0) {
        problems.push("a { has no closing }");
        break;
      }
      const token = template.slice(i + 1, end).trim();
      const value = tokenValue(token, date);
      if (value === null) {
        problems.push(`{${token}} is not one of ${PATH_TOKENS.map((t) => `{${t}}`).join(", ")}`);
      } else {
        out += value;
      }
      i = end + 1;
      continue;
    }
    if (template[i] === "}") {
      problems.push("a } has no opening {");
      i += 1;
      continue;
    }
    out += template[i];
    i += 1;
  }
  const segments = pathSegments(out);
  if (segments.length > MAX_SEGMENTS) {
    problems.push(`the path has more than ${MAX_SEGMENTS} folders`);
  }
  for (const s of segments) {
    const p = nameProblem(s);
    if (p) problems.push(p);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, segments };
}

/** Problems with a template alone (any date): for input validation. */
export function templateProblems(template: string): string[] {
  const r = resolvePathTemplate(template, { year: 2026, month: 1, day: 1 });
  return r.ok ? [] : r.problems;
}

/** `2026-11-06` → its parts, or the UTC day of `now`. */
export function pathDate(date: string | undefined, now: Date): PathDate {
  if (date) {
    return {
      year: Number(date.slice(0, 4)),
      month: Number(date.slice(5, 7)),
      day: Number(date.slice(8, 10)),
    };
  }
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
}

/**
 * A stored document's file name made safe for Drive: no `/` (Drive allows it, but it reads as a
 * folder to people), no control characters, at most 200 characters keeping the extension.
 */
export function driveFileName(name: string): string {
  let out = "";
  for (let i = 0; i < name.length; i++) {
    const ch = name[i] as string;
    const c = name.charCodeAt(i);
    out += ch === "/" || ch === "\\" || c < 0x20 || c === 0x7f ? "_" : ch;
  }
  out = out.trim();
  if (out === "" || out === "." || out === "..") return "document";
  if (out.length <= MAX_FILE_NAME_LENGTH) return out;
  const dot = out.lastIndexOf(".");
  const ext = dot > 0 && out.length - dot <= 10 ? out.slice(dot) : "";
  return out.slice(0, MAX_FILE_NAME_LENGTH - ext.length) + ext;
}

/** A string literal in a Drive `q` query: `'…'` with `\` and `'` escaped. */
export function driveQueryLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
