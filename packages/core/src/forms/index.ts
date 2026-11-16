// Forms: "Request info" (owner, 2026-11-16; docs/forms-plan.md, docs/plan.md §1.115).
//
// The built-in skill `forms.request` sends one contact a form built for this case and waits for the
// answers. The agent may write the form (`forms.draft`, or any earlier step); the operator fixes
// what must come back (`ask.required`) and the limits on what the agent may add (`ask`). The link
// goes out as a reach-out (its consent, quiet hours, channels and approval), and the person answers
// on a public page in the client's name. Pure: schemas, limits, checks and the answers' shape.

import { z } from "zod";
import { Duration, parseDuration } from "../duration";
import { RUN_ID_NAMESPACE, uuidv5 } from "../ids";
import { isPlainObject } from "../json";
import { DECIMAL_RE } from "../money";
import { ReachTo } from "../reach/rules";

export const FORMS_REQUEST_SKILL = "forms.request";
export const FORMS_DRAFT_SKILL = "forms.draft";

export const QUESTION_TYPES = [
  "text",
  "long_text",
  "number",
  "money",
  "percent",
  "date",
  "choice",
  "choices",
  "yes_no",
  "files",
  "rows",
] as const;
export const QuestionType = z.enum(QUESTION_TYPES);
export type QuestionType = z.infer<typeof QuestionType>;

/** What a files question takes: the documents capability keeps PDFs and images. */
export const FORM_FILE_KINDS = ["pdf", "image"] as const;
export const FormFileKind = z.enum(FORM_FILE_KINDS);
export type FormFileKind = z.infer<typeof FormFileKind>;

// DECISION: caps keep a form short enough to answer on a phone, whatever a model writes.
export const FORM_CAPS = {
  questions: 40,
  options: 20,
  columns: 8,
  rows: 50,
  filesPerQuestion: 10,
  title: 200,
  intro: 2000,
  label: 300,
  help: 500,
  text: 2000,
  longText: 20000,
  required: 20,
  extra: 20,
  /** The longest a request may wait for its answers. */
  dueMs: 30 * 24 * 3600_000,
} as const;

export const FORM_DEFAULTS = {
  maxExtra: 5,
  due: "5 days" as Duration,
} as const;

/** A question's id: stable, short, a key in the answers. */
export const QuestionId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "lower-case letters, digits and _, starting with a letter");

const Label = z.string().trim().min(1).max(FORM_CAPS.label);
const Help = z.string().trim().min(1).max(FORM_CAPS.help);

const base = {
  id: QuestionId,
  label: Label,
  help: Help.optional(),
  required: z.boolean().default(false),
};

const ChoiceOption = z.strictObject({ id: QuestionId, label: Label });

const TextQuestion = z.strictObject({ ...base, type: z.enum(["text", "long_text"]) });
const NumberQuestion = z.strictObject({
  ...base,
  type: z.enum(["number", "money", "percent", "date"]),
});
const ChoiceQuestion = z.strictObject({
  ...base,
  type: z.enum(["choice", "choices"]),
  options: z.array(ChoiceOption).min(2).max(FORM_CAPS.options),
  /** An "Other" answer in the person's own words. */
  other: z.boolean().default(false),
});
const YesNoQuestion = z.strictObject({ ...base, type: z.literal("yes_no") });
const FilesQuestion = z.strictObject({
  ...base,
  type: z.literal("files"),
  accept: z.array(FormFileKind).min(1).default(["pdf", "image"]),
  max: z.number().int().min(1).max(FORM_CAPS.filesPerQuestion).default(3),
});

/** A column of a table question: no files and no tables inside a table. */
export const ColumnQuestion = z.union([
  TextQuestion,
  NumberQuestion,
  ChoiceQuestion,
  YesNoQuestion,
]);
export type ColumnQuestion = z.infer<typeof ColumnQuestion>;

const RowsQuestion = z.strictObject({
  ...base,
  type: z.literal("rows"),
  columns: z.array(ColumnQuestion).min(1).max(FORM_CAPS.columns),
  min: z.number().int().min(0).max(FORM_CAPS.rows).optional(),
  max: z.number().int().min(1).max(FORM_CAPS.rows).default(20),
});

export const Question = z
  .union([TextQuestion, NumberQuestion, ChoiceQuestion, YesNoQuestion, FilesQuestion, RowsQuestion])
  .meta({ id: "FormQuestion" });
export type Question = z.infer<typeof Question>;
export type QuestionIn = z.input<typeof Question>;

/** A form: a title, a short intro and its questions in order. */
// DECISION: one list of questions in v1 (no sections or conditions); a long form is two requests.
export const FormDefinition = z
  .strictObject({
    schemaVersion: z.literal(1).default(1),
    title: z.string().trim().min(1).max(FORM_CAPS.title),
    intro: z.string().trim().min(1).max(FORM_CAPS.intro).optional(),
    questions: z.array(Question).min(1).max(FORM_CAPS.questions),
  })
  .meta({ id: "FormDefinition" });
export type FormDefinition = z.infer<typeof FormDefinition>;
export type FormDefinitionIn = z.input<typeof FormDefinition>;

/**
 * What the operator fixes on the step: the questions that must come back (the agent may reword
 * them and add context, never drop or retype them) and the limits on what it may add.
 */
export const FormAsk = z.strictObject({
  required: z.array(Question).max(FORM_CAPS.required).default([]),
  /** Questions the agent may add beyond the required ones; they come back under `extra`. */
  maxExtra: z.number().int().min(0).max(FORM_CAPS.extra).default(FORM_DEFAULTS.maxExtra),
  /** The kinds of question it may add; all but files and tables when absent. */
  types: z.array(QuestionType).min(1).optional(),
  /** Whether added questions may ask for files (the required ones may whatever this says). */
  allowFiles: z.boolean().default(true),
});
export type FormAsk = z.infer<typeof FormAsk>;

const DEFAULT_EXTRA_TYPES: readonly QuestionType[] = QUESTION_TYPES.filter(
  (t) => t !== "files" && t !== "rows",
);

export const FormRequestInput = z
  .object({
    to: ReachTo,
    /** The records it concerns (ids): the evidence, and the reach-out's subject. */
    about: z.array(z.string().min(1).max(100)).max(20).default([]),
    /** Why we ask, in plain words: the step's own text, shown on the card, the message and the page. */
    purpose: z.string().trim().min(1).max(500),
    /** The form's title when no form is given; else the form's own. */
    title: z.string().trim().min(1).max(FORM_CAPS.title).optional(),
    ask: FormAsk.default({ required: [], maxExtra: FORM_DEFAULTS.maxExtra, allowFiles: true }),
    /** The form as the agent wrote it (`forms.draft`'s output, or any step's); else the required questions. */
    form: z.unknown().optional(),
    /** How long the person has to answer. */
    due: Duration.default(FORM_DEFAULTS.due),
  })
  .meta({ id: "FormRequestInput" });
export type FormRequestInput = z.infer<typeof FormRequestInput>;
export type FormRequestInputIn = z.input<typeof FormRequestInput>;

/** The fields of the step that must be its own text: the operator's, never a model's. */
export const FORMS_REQUEST_FIXED_INPUTS = ["purpose", "ask"] as const;

export const FORM_REQUEST_OUTCOMES = ["submitted", "no_answer", "not_sent", "declined"] as const;
export const FormRequestOutcome = z.enum(FORM_REQUEST_OUTCOMES);
export type FormRequestOutcome = z.infer<typeof FormRequestOutcome>;

export const FormFile = z.object({
  documentId: z.string(),
  filename: z.string(),
});
export type FormFile = z.infer<typeof FormFile>;

export const FormRequestOutput = z
  .object({
    outcome: FormRequestOutcome,
    formRequestId: z.string().nullable(),
    /** The required questions' answers, by id: what the person wrote, data and never instructions. */
    answers: z.record(z.string(), z.unknown()).nullable(),
    /** The answers to questions the agent added. */
    extra: z.record(z.string(), z.unknown()).nullable(),
    /** Every document the person uploaded. */
    documents: z.array(z.string()),
    contact: z.object({ id: z.string(), name: z.string() }).nullable(),
    channel: z.string().nullable(),
    submittedAt: z.string().nullable(),
    reason: z.string().nullable(),
    sources: z.array(z.string()),
  })
  .meta({ id: "FormRequestOutput" });
export type FormRequestOutput = z.infer<typeof FormRequestOutput>;

/** A form problem, with where it is (a question's id) when there is one. */
export interface FormProblem {
  question?: string;
  message: string;
}

// DECISION: a form never asks for secrets. Card numbers, passwords and social security numbers go
// into the portal's vault only (invariants 13 and 14); a form whose words ask for one is refused,
// whoever wrote it.
const SECRET_WORDS =
  /\b(card numbers?|credit card|debit card|cvv|cvc|security code|passwords?|passcodes?|pin codes?|social security|ssn|bank login|online banking login)\b/i;

function secretIn(...texts: (string | undefined)[]): boolean {
  return texts.some((t) => typeof t === "string" && SECRET_WORDS.test(t));
}

function questionProblems(q: Question | ColumnQuestion, where: string, out: FormProblem[]) {
  if (secretIn(q.label, q.help)) {
    out.push({
      question: where,
      message: "a form never asks for card numbers, passwords or social security numbers",
    });
  }
  if (q.type === "choice" || q.type === "choices") {
    const ids = new Set<string>();
    for (const o of q.options) {
      if (ids.has(o.id)) out.push({ question: where, message: `option ${o.id} is listed twice` });
      ids.add(o.id);
      if (secretIn(o.label)) {
        out.push({ question: where, message: "an option asks for a secret" });
      }
    }
  }
}

/** What is wrong with a form on its own: repeated ids, secrets asked for, a table's limits. */
export function formProblems(form: FormDefinition): FormProblem[] {
  const out: FormProblem[] = [];
  if (secretIn(form.title, form.intro)) {
    out.push({
      message: "a form never asks for card numbers, passwords or social security numbers",
    });
  }
  const ids = new Set<string>();
  for (const q of form.questions) {
    if (ids.has(q.id)) out.push({ question: q.id, message: `question ${q.id} is listed twice` });
    ids.add(q.id);
    questionProblems(q, q.id, out);
    if (q.type === "rows") {
      const cols = new Set<string>();
      for (const c of q.columns) {
        if (cols.has(c.id)) out.push({ question: q.id, message: `column ${c.id} is listed twice` });
        cols.add(c.id);
        questionProblems(c, `${q.id}.${c.id}`, out);
      }
      if (q.min !== undefined && q.min > q.max) {
        out.push({ question: q.id, message: "at least more rows than at most" });
      }
    }
  }
  return out;
}

function sameOptions(a: Question, b: Question): boolean {
  if (
    (a.type === "choice" || a.type === "choices") &&
    (b.type === "choice" || b.type === "choices")
  ) {
    return (
      a.options.map((o) => o.id).join("|") === b.options.map((o) => o.id).join("|") &&
      a.other === b.other
    );
  }
  if (a.type === "rows" && b.type === "rows") {
    return (
      a.columns.map((c) => `${c.id}:${c.type}`).join("|") ===
      b.columns.map((c) => `${c.id}:${c.type}`).join("|")
    );
  }
  return true;
}

/**
 * What is wrong with a form against the step's ask: every required question there, with its id,
 * type and options, and required; at most `maxExtra` others, of the kinds allowed.
 */
export function askProblems(form: FormDefinition, ask: FormAsk): FormProblem[] {
  const out: FormProblem[] = [];
  const byId = new Map(form.questions.map((q) => [q.id, q]));
  const requiredIds = new Set(ask.required.map((q) => q.id));
  for (const want of ask.required) {
    const got = byId.get(want.id);
    if (!got) {
      out.push({
        question: want.id,
        message: `the form leaves out ${want.id}, which must be asked`,
      });
      continue;
    }
    if (got.type !== want.type) {
      out.push({ question: want.id, message: `${want.id} must be a ${want.type} question` });
    } else if (!sameOptions(got, want)) {
      out.push({ question: want.id, message: `${want.id} must keep the step's options` });
    }
    if (want.required && !got.required) {
      out.push({ question: want.id, message: `${want.id} must be answered` });
    }
  }
  const extra = form.questions.filter((q) => !requiredIds.has(q.id));
  if (extra.length > ask.maxExtra) {
    out.push({
      message: `the form adds ${extra.length} questions; this step allows ${ask.maxExtra}`,
    });
  }
  const allowed = new Set(ask.types ?? DEFAULT_EXTRA_TYPES);
  for (const q of extra) {
    if (q.type === "files") {
      // Files are their own switch; a step that lists its kinds must list files too.
      if (!ask.allowFiles || (ask.types && !allowed.has("files"))) {
        out.push({ question: q.id, message: "this step doesn't let the agent ask for files" });
      }
    } else if (!allowed.has(q.type)) {
      out.push({
        question: q.id,
        message: `this step doesn't let the agent add ${q.type} questions`,
      });
    }
  }
  return out;
}

/**
 * The form a request sends: the one given (checked), else the required questions under the
 * step's title. An error names what is wrong; nothing is sent then.
 */
export function formForRequest(
  input: Pick<FormRequestInput, "form" | "ask" | "title" | "purpose">,
): { ok: true; form: FormDefinition } | { ok: false; problems: FormProblem[] } {
  let form: FormDefinition;
  if (input.form === undefined || input.form === null) {
    if (input.ask.required.length === 0) {
      return { ok: false, problems: [{ message: "no form and no required questions to ask" }] };
    }
    form = {
      schemaVersion: 1,
      title: input.title ?? input.purpose.slice(0, FORM_CAPS.title),
      questions: input.ask.required,
    };
  } else {
    const parsed = FormDefinition.safeParse(input.form);
    if (!parsed.success) {
      return {
        ok: false,
        problems: parsed.error.issues.slice(0, 10).map((i) => ({
          message: `${i.path.join(".") || "form"}: ${i.message}`,
        })),
      };
    }
    form = parsed.data;
  }
  const problems = [...formProblems(form), ...askProblems(form, input.ask)];
  return problems.length > 0 ? { ok: false, problems } : { ok: true, form };
}

/** Whether a due date is within the cap. */
export function dueProblem(due: string): string | null {
  const ms = parseDuration(due);
  if (ms < 3600_000) return "give the person at least an hour";
  if (ms > FORM_CAPS.dueMs) return "at most 30 days";
  return null;
}

// ── Answers ─────────────────────────────────────────────────────────────────────────────────────

/** What a choice with "Other" holds when the person wrote their own. */
export const OtherAnswer = z.strictObject({ other: z.string().trim().min(1).max(FORM_CAPS.text) });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Whether a value counts as no answer (left empty). */
export function isEmptyAnswer(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    (typeof v === "string" && v.trim() === "") ||
    (Array.isArray(v) && v.length === 0)
  );
}

function valueProblem(q: Question | ColumnQuestion, v: unknown): string | null {
  switch (q.type) {
    case "text":
    case "long_text": {
      const max = q.type === "text" ? FORM_CAPS.text : FORM_CAPS.longText;
      if (typeof v !== "string") return "write an answer";
      return v.length > max ? `at most ${max} characters` : null;
    }
    case "number":
    case "money":
    case "percent":
      if (typeof v !== "string" || !DECIMAL_RE.test(v.trim())) return "a number, like 1250.50";
      return null;
    case "date":
      return typeof v === "string" && validDate(v) ? null : "a date";
    case "yes_no":
      return typeof v === "boolean" ? null : "yes or no";
    case "choice": {
      if (typeof v === "string") {
        return q.options.some((o) => o.id === v) ? null : "pick one of the options";
      }
      if (q.other && OtherAnswer.safeParse(v).success) return null;
      return "pick one of the options";
    }
    case "choices": {
      if (!Array.isArray(v)) return "pick from the options";
      const ids = new Set(q.options.map((o) => o.id));
      for (const x of v) {
        if (typeof x === "string" && ids.has(x)) continue;
        if (q.other && OtherAnswer.safeParse(x).success) continue;
        return "pick from the options";
      }
      return new Set(v.map((x) => JSON.stringify(x))).size === v.length
        ? null
        : "each option at most once";
    }
  }
  return null;
}

/**
 * What is wrong with answers to a form: an answer to a question it doesn't have, a value of the
 * wrong kind, and (when `final`, on submitting) a required question left empty. Files are the
 * server's: only their ids are checked here (`files` question values are `FormFile[]`).
 */
export function answerProblems(
  form: FormDefinition,
  answers: unknown,
  options: { final: boolean },
): FormProblem[] {
  const out: FormProblem[] = [];
  if (!isPlainObject(answers)) return [{ message: "answers are an object, by question" }];
  const byId = new Map(form.questions.map((q) => [q.id, q]));
  for (const key of Object.keys(answers)) {
    if (!byId.has(key)) out.push({ question: key, message: "the form has no such question" });
  }
  for (const q of form.questions) {
    const v = answers[q.id];
    if (isEmptyAnswer(v)) {
      if (options.final && q.required) out.push({ question: q.id, message: "this one is needed" });
      else if (options.final && q.type === "rows" && (q.min ?? 0) > 0) {
        out.push({ question: q.id, message: `at least ${q.min} rows` });
      }
      continue;
    }
    if (q.type === "files") {
      const parsed = z.array(FormFile).safeParse(v);
      if (!parsed.success) out.push({ question: q.id, message: "files you added here" });
      else if (parsed.data.length > q.max) {
        out.push({ question: q.id, message: `at most ${q.max} files` });
      }
      continue;
    }
    if (q.type === "rows") {
      if (!Array.isArray(v)) {
        out.push({ question: q.id, message: "a table of rows" });
        continue;
      }
      if (v.length > q.max) out.push({ question: q.id, message: `at most ${q.max} rows` });
      if (options.final && q.min !== undefined && v.length < q.min) {
        out.push({ question: q.id, message: `at least ${q.min} rows` });
      }
      v.forEach((row, i) => {
        if (!isPlainObject(row)) {
          out.push({ question: `${q.id}.${i}`, message: "a row" });
          return;
        }
        const cols = new Map(q.columns.map((c) => [c.id, c]));
        for (const key of Object.keys(row)) {
          if (!cols.has(key))
            out.push({ question: `${q.id}.${i}.${key}`, message: "no such column" });
        }
        for (const c of q.columns) {
          const cell = row[c.id];
          if (isEmptyAnswer(cell)) {
            if (options.final && c.required) {
              out.push({ question: `${q.id}.${i}.${c.id}`, message: "this one is needed" });
            }
            continue;
          }
          const p = valueProblem(c, cell);
          if (p) out.push({ question: `${q.id}.${i}.${c.id}`, message: p });
        }
      });
      continue;
    }
    const p = valueProblem(q, v);
    if (p) out.push({ question: q.id, message: p });
  }
  return out;
}

/** Answers with empty values left out and text trimmed, as they are kept. */
export function cleanAnswers(form: FormDefinition, answers: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const q of form.questions) {
    const v = answers[q.id];
    if (isEmptyAnswer(v)) continue;
    out[q.id] = typeof v === "string" ? v.trim() : v;
  }
  return out;
}

/** The required answers and the agent's added ones, apart: what the step puts out. */
export function splitAnswers(
  answers: Record<string, unknown>,
  ask: Pick<FormAsk, "required">,
): { answers: Record<string, unknown>; extra: Record<string, unknown> } {
  const required = new Set(ask.required.map((q) => q.id));
  const a: Record<string, unknown> = {};
  const e: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(answers)) (required.has(k) ? a : e)[k] = v;
  return { answers: a, extra: e };
}

/** Every document id in a form's file answers. */
export function documentsOf(form: FormDefinition, answers: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const q of form.questions) {
    if (q.type !== "files") continue;
    const parsed = z.array(FormFile).safeParse(answers[q.id]);
    if (parsed.success) for (const f of parsed.data) out.push(f.documentId);
  }
  return [...new Set(out)];
}

/** Whether a file's type is one a files question takes. */
export function acceptsFile(q: Extract<Question, { type: "files" }>, mimeType: string): boolean {
  const kind: FormFileKind | null =
    mimeType === "application/pdf" ? "pdf" : mimeType.startsWith("image/") ? "image" : null;
  return kind !== null && q.accept.includes(kind);
}

// ── The link and the page ───────────────────────────────────────────────────────────────────────

/** What a form link's token carries (signed by the Worker): the client, the request, its expiry. */
export const FormLinkToken = z.object({
  t: z.uuid(),
  r: z.uuid(),
  /** Seconds since the epoch. */
  e: z.number().int(),
});
export type FormLinkToken = z.infer<typeof FormLinkToken>;

/** The web app's page for a token. */
export function formPagePath(token: string): string {
  return `/f/${token}`;
}

/** How long a link keeps working after the due date: late answers are still welcome. */
export const FORM_LINK_GRACE_MS = 7 * 24 * 3600_000;

/**
 * A request's id, from its run and step: a retried step (or one that stopped between sending and
 * keeping its row) finds the same request, so the link already sent still opens it.
 */
export function formRequestId(input: { runId: string; nodeId: string }): Promise<string> {
  return uuidv5(`form:${input.runId}:${input.nodeId}`, RUN_ID_NAMESPACE);
}

/** The event a waiting request step wakes on. */
export function formEventType(formRequestId: string): string {
  return `form-${formRequestId.replace(/-/g, "")}`;
}

export const FORM_REQUEST_STATUSES = [
  "sending",
  "open",
  "submitted",
  "expired",
  "cancelled",
  "not_sent",
] as const;
export type FormRequestStatus = (typeof FORM_REQUEST_STATUSES)[number];
