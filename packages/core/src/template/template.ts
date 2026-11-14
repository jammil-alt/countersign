import { DEFAULT_LOCALE, type Locale, type LocalizedText, pickLocalized } from "../i18n/locale";
import { isPlainObject } from "../json";

/**
 * Templates (ARCHITECTURE §10.1, docs/plan.md §1.2): text with `{{path}}` references, where a path
 * is dot-separated names or indexes (`steps.extract.output.lines.0.qty`, `lines.length`). No
 * expressions and no eval: the builder, validation and the executor all use this one parser.
 */

export type TemplatePart = { type: "text"; text: string } | { type: "ref"; path: string[] };

export interface TemplateRef {
  /** The path segments, e.g. ["steps", "abc", "output", "total"]. */
  path: string[];
  /** The text inside the braces, trimmed. */
  expr: string;
  /** Where in the templated value the string sits (segments from the value's root). */
  at: (string | number)[];
}

export class TemplateSyntaxError extends Error {
  constructor(
    message: string,
    readonly template: string,
  ) {
    super(message);
    this.name = "TemplateSyntaxError";
  }
}

const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

export function parsePath(expr: string): string[] {
  const trimmed = expr.trim();
  if (trimmed === "") throw new TemplateSyntaxError("empty reference {{}}", expr);
  const segments = trimmed.split(".");
  for (const s of segments) {
    if (!SEGMENT_RE.test(s)) {
      throw new TemplateSyntaxError(`invalid reference "${trimmed}"`, expr);
    }
  }
  return segments;
}

export function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{{", i);
    if (open === -1) {
      parts.push({ type: "text", text: template.slice(i) });
      break;
    }
    const close = template.indexOf("}}", open + 2);
    if (close === -1) throw new TemplateSyntaxError("unclosed {{", template);
    if (open > i) parts.push({ type: "text", text: template.slice(i, open) });
    const inner = template.slice(open + 2, close);
    if (inner.includes("{{")) throw new TemplateSyntaxError("nested {{", template);
    parts.push({ type: "ref", path: parsePath(inner) });
    i = close + 2;
  }
  const stray = parts.find((p) => p.type === "text" && p.text.includes("}}"));
  if (stray) throw new TemplateSyntaxError("}} without {{", template);
  return parts;
}

/** The path when the whole string is one reference (`"{{trigger.total}}"`), else null. */
export function singleRef(template: string): string[] | null {
  const m = /^\{\{([^{}]*)\}\}$/.exec(template);
  return m ? parsePath(m[1] as string) : null;
}

export function isTemplate(value: string): boolean {
  return value.includes("{{");
}

/**
 * Every reference inside a templated JSON value (strings anywhere in objects and arrays). Syntax
 * errors are reported, not thrown, so validation can list them all.
 */
export function collectRefs(
  value: unknown,
  at: (string | number)[] = [],
): { refs: TemplateRef[]; errors: { at: (string | number)[]; message: string }[] } {
  const refs: TemplateRef[] = [];
  const errors: { at: (string | number)[]; message: string }[] = [];
  const visit = (v: unknown, where: (string | number)[]) => {
    if (typeof v === "string") {
      try {
        for (const p of parseTemplate(v)) {
          if (p.type === "ref") refs.push({ path: p.path, expr: p.path.join("."), at: where });
        }
      } catch (e) {
        errors.push({ at: where, message: (e as Error).message });
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => {
        visit(x, [...where, i]);
      });
    } else if (isPlainObject(v)) {
      for (const [k, x] of Object.entries(v)) visit(x, [...where, k]);
    }
  };
  visit(value, at);
  return { refs, errors };
}

/** Follows a path through objects and arrays; `length` works on arrays and strings. */
export function resolvePath(root: unknown, path: readonly string[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      if (seg === "length") cur = cur.length;
      else if (/^\d+$/.test(seg)) cur = cur[Number(seg)];
      else return undefined;
    } else if (typeof cur === "string") {
      if (seg !== "length") return undefined;
      cur = cur.length;
    } else if (isPlainObject(cur)) {
      cur = Object.hasOwn(cur, seg) ? cur[seg] : undefined;
    } else {
      return undefined;
    }
  }
  return cur;
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** Renders one template string to text (missing values render as ""). */
export function renderTemplate(template: string, context: unknown): string {
  return parseTemplate(template)
    .map((p) => (p.type === "text" ? p.text : stringify(resolvePath(context, p.path))))
    .join("");
}

/**
 * Resolves a templated value against a context. A string that is exactly one reference keeps the
 * referenced value's type (`"{{steps.a.output.lines}}"` gives the array); other strings render as
 * text; objects and arrays resolve recursively.
 */
export function resolveTemplate(value: unknown, context: unknown): unknown {
  if (typeof value === "string") {
    if (!isTemplate(value)) return value;
    const single = singleRef(value);
    return single ? resolvePath(context, single) : renderTemplate(value, context);
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplate(v, context));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveTemplate(v, context);
    return out;
  }
  return value;
}

/** What a workflow template resolves against at run time. */
export interface RunContext {
  trigger: unknown;
  // v0.12 W2-B
  /** Inside a use step: its resolved input (`{{input...}}`); there is no trigger there. */
  input?: unknown;
  steps: Record<string, StepScope>;
  item?: unknown;
  index?: number;
  /**
   * v0.17: inside a repeat, `{{loop.pass}}` (from 1) and the pass before's top-level steps as
   * `{{loop.previous.<id>.output…}}` (absent on the first pass).
   */
  loop?: { pass: number; previous?: Record<string, { output: unknown }>; feedback?: string };
}

/**
 * One step as the steps after it read it: its output and, wave 5 (docs/plan.md §1.86 "Forks"), how
 * it ended, for an `if` to route on (`processes.StepRecord`, `processes.stepRecordSchema`). The
 * outcome fields are filled for native v4 processes only.
 */
export interface StepScope {
  output: unknown;
  outcome?: string;
  approval?: { outcome: string; by?: string | null };
  confer?: Record<string, unknown>;
  error?: { code: string; message: string };
  choice?: string;
  counts?: { items: number; failed: number };
  stopStatus?: string;
}

/** Whether a value fills a slot in a sentence: not missing, null or blank. */
function fills(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim() !== "";
}

/**
 * A skill's or tool's client timeline line, rendered over its output (docs/plan.md §1.2), in the
 * client's language when the template has a version for it, else in English (§1.18). Null when a
 * reference has no value: a summary is never a sentence with an empty slot ("total unchanged at"),
 * so the caller says it without that part (the step's label).
 */
// DECISION: a summary with any empty reference is not rendered at all, rather than rendered with a
// gap: callers fall back to a line without the detail (the executor: "<label>: done").
export function renderSummary(
  template: LocalizedText,
  output: unknown,
  locale: Locale = DEFAULT_LOCALE,
): string | null {
  const parts = parseTemplate(pickLocalized(template, locale));
  const values = parts.map((p) => (p.type === "text" ? p.text : resolvePath(output, p.path)));
  if (parts.some((p, i) => p.type === "ref" && !fills(values[i]))) return null;
  const english = typeof template === "string" || locale === "en" || template[locale] === undefined;
  const line = values
    .map((v, i) => {
      if (parts[i]?.type !== "text") return summaryValue(v);
      const text = v as string;
      return english && isOne(values[i - 1]) && parts[i - 1]?.type === "ref"
        ? singularAfterOne(text)
        : text;
    })
    .join("")
    .trim();
  return line === "" ? null : line;
}

/** A stored amount ("9742.3500") reads with two places when the rest are zeros ("9742.35"). */
function summaryValue(v: unknown): string {
  // P-2: the two places stay when they are zeros too ("1125.0000" reads "1125.00", not "1125.").
  if (typeof v === "string" && /^-?\d+\.\d{2}0+$/.test(v)) return v.replace(/(\.\d{2})0+$/, "$1");
  return stringify(v);
}

function isOne(v: unknown): boolean {
  return v === 1 || v === "1";
}

const IRREGULAR: Record<string, string> = { people: "person", children: "child" };
/** Words ending in "s" that are not plurals. */
const NOT_PLURAL = new Set(["was", "has", "does", "its", "this", "yes", "as", "plus", "across"]);

/**
 * The text after a count of one, with its noun singular: " bills" → " bill", " open invoices,"
 * → " open invoice,", " people" → " person". Only the first of the next two words that reads as
 * a plural changes; "row(s)" and words ending in "ss" or "us" are left alone.
 */
// DECISION: English summaries are written for many ("Found {{bills.length}} bills"); rather than a
// plural syntax in every template, a count of exactly one makes its noun singular here, so no
// summary says "Found 1 bills". Other languages write their own templates and are left as written.
export function singularAfterOne(text: string): string {
  const m = /^(\s+)(\S+)(?:(\s+)(\S+))?/.exec(text);
  if (!m) return text;
  const words = [m[2] as string, m[4]];
  for (let w = 0; w < words.length; w++) {
    const raw = words[w];
    if (raw === undefined) break;
    const word = /^[A-Za-z]+/.exec(raw)?.[0] ?? "";
    const one = singular(word);
    if (one === null) continue;
    const head = w === 0 ? (m[1] as string) : `${m[1]}${m[2]}${m[3]}`;
    return `${head}${one}${text.slice(head.length + word.length)}`;
  }
  return text;
}

function singular(word: string): string | null {
  const lower = word.toLowerCase();
  if (IRREGULAR[lower]) return IRREGULAR[lower] as string;
  if (NOT_PLURAL.has(lower)) return null;
  if (lower.length < 3 || !lower.endsWith("s") || /(ss|us|is)$/.test(lower)) return null;
  if (lower.endsWith("ies")) return `${word.slice(0, -3)}y`;
  return word.slice(0, -1);
}

/** Whether a templated value (a string, or strings anywhere in objects and arrays) has a `{{`. */
export function hasTemplate(value: unknown): boolean {
  if (typeof value === "string") return isTemplate(value);
  if (Array.isArray(value)) return value.some(hasTemplate);
  if (isPlainObject(value)) return Object.values(value).some(hasTemplate);
  return false;
}

/**
 * Why a call to a tool with fixed inputs (ToolSpec `fixedInputs`) may not run, or null when it may.
 * `literal` is the action step's input as written in the agent's version, before templates; it is
 * undefined when a model wrote the call (a skill, agent mode). Each fixed field the call carries
 * must be the step's own text: written there, with no template, and unchanged.
 */
// DECISION: fixed inputs are checked against the unrendered step input at the gate, the one place
// every tool call passes, rather than escaped into the prompt as data: what a contact wrote (an
// SMS, a call transcript, a model's reading of either) can then never become a voice agent's
// instructions or opening line, whichever path filled it (docs/plan.md §1.23).
export function fixedInputProblem(
  fields: readonly string[],
  literal: unknown,
  input: unknown,
): string | null {
  const given = isPlainObject(input) ? input : {};
  for (const f of fields) {
    if (!isPlainObject(literal)) {
      if (given[f] !== undefined) {
        return `${f} has to be written in an action step, not by a model: it becomes instructions`;
      }
      continue;
    }
    const raw = literal[f];
    if (hasTemplate(raw)) {
      return `${f} has to be written in the step, not filled from a template: it becomes instructions`;
    }
    if (JSON.stringify(raw ?? null) !== JSON.stringify(given[f] ?? null)) {
      return `${f} isn't the text written in the step`;
    }
  }
  return null;
}
