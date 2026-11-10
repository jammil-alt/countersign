// Scripted site tools (docs/plan.md §1.86 "Scripts (wave 4)", §9 R9; ARCHITECTURE v0.16 §10.14
// "Browser connectors"). A script is fixed steps on one client's browser site: open a page the site
// allows, fill a field, click, read a field or a table, download a file. It declares typed inputs
// (what its steps fill) and typed outputs (what it reads), its side effect (`none` for a script
// that only reads, `external` for one that submits) and its undo (`none` unless a reverse script is
// named). It is data: versioned, each version immutable (invariants 3 and 4), per client (invariant
// 1). Our code runs it (packages/connectors' browser/script.ts) in a session our code signed in;
// the model never drives it, so it never decides.

import { z } from "zod";
import { BrowserSiteSlug, CssSelector } from "./site";

/** A script's slug: as a site's, unique per client and site. */
export const BrowserScriptSlug = BrowserSiteSlug;

/** An input's or output's name, as steps and the tool's input refer to it. */
export const ScriptValueName = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_]{0,39}$/, "a name such as orderNumber: letters, digits and _");

/** What a step fills: a declared input, or fixed text the recording typed. */
export const ScriptValue = z.union([
  z.strictObject({ input: ScriptValueName }),
  z.strictObject({ text: z.string().max(2000) }),
]);
export type ScriptValue = z.infer<typeof ScriptValue>;

/**
 * An address a step opens: a full address on the site, where `{{name}}` stands for an input's
 * value (percent-encoded when filled). Checked against the site's pages after filling, every run.
 */
export const ScriptUrl = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .regex(/^https?:\/\/[^\s]+$/i, "a full address on the site");

const StepId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "a step id");

export const ScriptStep = z.discriminatedUnion("op", [
  z.strictObject({ id: StepId, op: z.literal("open"), url: ScriptUrl }),
  z.strictObject({ id: StepId, op: z.literal("fill"), selector: CssSelector, value: ScriptValue }),
  z.strictObject({
    id: StepId,
    op: z.literal("click"),
    selector: CssSelector,
    /** The click sends the form: the script's write. Never performed by a recording or a test. */
    submits: z.boolean().default(false),
  }),
  z.strictObject({
    id: StepId,
    op: z.literal("read_field"),
    selector: CssSelector,
    output: ScriptValueName,
  }),
  z.strictObject({
    id: StepId,
    op: z.literal("read_table"),
    /** Which table on the page, counting from 0 in the page's order. */
    table: z.number().int().min(0).max(19),
    output: ScriptValueName,
  }),
  z.strictObject({
    id: StepId,
    op: z.literal("download"),
    url: ScriptUrl,
    output: ScriptValueName,
  }),
]);
export type ScriptStep = z.infer<typeof ScriptStep>;
export type ScriptStepInput = z.input<typeof ScriptStep>;

export const ScriptInputType = z.enum(["text", "decimal", "integer", "date"]);
export type ScriptInputType = z.infer<typeof ScriptInputType>;
export const ScriptOutputType = z.enum(["text", "decimal", "integer", "table", "document"]);
export type ScriptOutputType = z.infer<typeof ScriptOutputType>;

export const ScriptInputDecl = z.strictObject({
  name: ScriptValueName,
  label: z.string().trim().min(1).max(120),
  type: ScriptInputType,
  /** The value typed while recording: what a recording's replay and a test fill. */
  example: z.string().max(2000).optional(),
});
export type ScriptInputDecl = z.infer<typeof ScriptInputDecl>;

export const ScriptOutputDecl = z.strictObject({
  name: ScriptValueName,
  label: z.string().trim().min(1).max(120),
  type: ScriptOutputType,
});
export type ScriptOutputDecl = z.infer<typeof ScriptOutputDecl>;

/** How a submitted write is taken back: not at all, or by another script of the same site. */
export const ScriptUndo = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    kind: z.literal("reverse"),
    script: BrowserScriptSlug,
    /** The reverse script's inputs, each from this script's input or output. */
    inputs: z.record(
      ScriptValueName,
      z.union([
        z.strictObject({ input: ScriptValueName }),
        z.strictObject({ output: ScriptValueName }),
      ]),
    ),
  }),
]);
export type ScriptUndo = z.infer<typeof ScriptUndo>;

export const BrowserScriptDefinition = z
  .strictObject({
    schemaVersion: z.literal(1),
    site: BrowserSiteSlug,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).default(""),
    inputs: z.array(ScriptInputDecl).max(30).default([]),
    outputs: z.array(ScriptOutputDecl).max(30).default([]),
    steps: z.array(ScriptStep).min(1).max(50),
    sideEffect: z.enum(["none", "external"]),
    undo: ScriptUndo.default({ kind: "none" }),
  })
  .meta({ id: "BrowserScriptDefinition" });
export type BrowserScriptDefinition = z.infer<typeof BrowserScriptDefinition>;
export type BrowserScriptDefinitionInput = z.input<typeof BrowserScriptDefinition>;

/**
 * Output names the tools keep for themselves: what a submit reads back (`submitted`, `url`), the
 * reverse script's input (`reverse`) and a help request (`needsHelp`).
 */
export const RESERVED_OUTPUTS = ["submitted", "url", "reverse", "needsHelp"] as const;

/** A client's published script as a tool runs it (BrowserServices `script`). */
export interface PublishedBrowserScript {
  id: string;
  slug: string;
  versionId: string;
  version: number;
  definition: BrowserScriptDefinition;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** The input names a step's address uses. */
export function urlInputs(url: string): string[] {
  return [...url.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
}

/** An address with its `{{name}}`s filled, each value percent-encoded (never a path climb). */
export function fillScriptUrl(url: string, values: Readonly<Record<string, unknown>>): string {
  return url.replace(PLACEHOLDER, (_, name: string) =>
    encodeURIComponent(String(values[name] ?? "")),
  );
}

/** The click that submits, if the script has one. */
export function submitStep(def: Pick<BrowserScriptDefinition, "steps">): ScriptStep | null {
  return def.steps.find((s) => s.op === "click" && s.submits) ?? null;
}

/**
 * What is wrong with a script beyond its shape, as plain lines (empty: it may be saved). Names are
 * unique; every input a step uses is declared and every declared input is used; each output is
 * read by exactly one step of a fitting kind; a script submits exactly when it says `external`, at
 * most once and as its last step (a recording never performs the submit, so nothing after it was
 * ever seen); only a write names a reverse script.
 */
// DECISION: the submit is the last step. The recorder never clicks it (a recording writes nothing
// to the client's tool: invariant 8), so a page after it was never seen and can't be recorded; a
// write script's output is `{ submitted, url }` and anything it read before submitting.
export function scriptProblems(def: BrowserScriptDefinition): string[] {
  const problems: string[] = [];
  const dup = (names: string[], what: string) => {
    const seen = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) problems.push(`two ${what} are called ${n}`);
      seen.add(n);
    }
  };
  dup(
    def.inputs.map((i) => i.name),
    "inputs",
  );
  dup(
    def.outputs.map((o) => o.name),
    "outputs",
  );
  dup(
    def.steps.map((s) => s.id),
    "steps",
  );
  const inputs = new Map(def.inputs.map((i) => [i.name, i]));
  const outputs = new Map(def.outputs.map((o) => [o.name, o]));
  for (const name of RESERVED_OUTPUTS) {
    if (outputs.has(name)) problems.push(`"${name}" can't be an output's name`);
  }
  const used = new Set<string>();
  const written = new Map<string, number>();
  const useInput = (name: string, where: string) => {
    used.add(name);
    if (!inputs.has(name)) problems.push(`${where} uses ${name}, which isn't an input`);
  };
  for (const s of def.steps) {
    if (s.op === "open" || s.op === "download") {
      for (const n of urlInputs(s.url)) useInput(n, `step ${s.id}`);
    }
    if (s.op === "fill" && "input" in s.value) useInput(s.value.input, `step ${s.id}`);
    if (s.op === "read_field" || s.op === "read_table" || s.op === "download") {
      written.set(s.output, (written.get(s.output) ?? 0) + 1);
      const out = outputs.get(s.output);
      if (!out) {
        problems.push(`step ${s.id} reads ${s.output}, which isn't an output`);
        continue;
      }
      const fits =
        s.op === "read_table"
          ? out.type === "table"
          : s.op === "download"
            ? out.type === "document"
            : out.type === "text" || out.type === "decimal" || out.type === "integer";
      if (!fits) problems.push(`step ${s.id} can't read ${s.output} as ${out.type}`);
    }
  }
  for (const i of def.inputs) {
    if (!used.has(i.name)) problems.push(`no step uses the input ${i.name}`);
  }
  for (const o of def.outputs) {
    const n = written.get(o.name) ?? 0;
    if (n === 0) problems.push(`no step reads the output ${o.name}`);
    if (n > 1) problems.push(`more than one step reads ${o.name}`);
  }
  const submits = def.steps.filter((s) => s.op === "click" && s.submits);
  if (def.sideEffect === "none" && submits.length > 0) {
    problems.push("a script that submits a form is a write (side effect external)");
  }
  if (def.sideEffect === "external" && submits.length === 0) {
    problems.push("a write script submits: mark the click that sends the form");
  }
  if (submits.length > 1) problems.push("a script submits once");
  if (submits.length === 1 && def.steps.at(-1) !== submits[0]) {
    problems.push("the submit is the script's last step");
  }
  if (def.undo.kind === "reverse") {
    if (def.sideEffect !== "external") problems.push("only a write names a reverse script");
    for (const [name, from] of Object.entries(def.undo.inputs)) {
      if ("input" in from && !inputs.has(from.input)) {
        problems.push(
          `the reverse script's ${name} comes from ${from.input}, which isn't an input`,
        );
      }
      if ("output" in from && !outputs.has(from.output)) {
        problems.push(
          `the reverse script's ${name} comes from ${from.output}, which isn't an output`,
        );
      }
    }
  }
  return problems;
}

// ── Values at the boundary (invariant 5) ─────────────────────────────────────────────────────────

const DECIMAL = /^-?\d{1,14}(\.\d{1,6})?$/;

function inputSchema(type: ScriptInputType): z.ZodType {
  switch (type) {
    case "text":
      return z.string().max(2000);
    // Money and quantities as decimal strings, never floats (invariant 6).
    case "decimal":
      return z.string().trim().regex(DECIMAL, "a decimal number such as 12.50");
    case "integer":
      return z.number().int().min(-1e12).max(1e12);
    case "date":
      return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date such as 2026-11-10");
  }
}

/** The tool input's `inputs`, typed by the script's declarations (strict: nothing undeclared). */
export function scriptInputSchema(def: Pick<BrowserScriptDefinition, "inputs">) {
  return z.strictObject(
    Object.fromEntries(def.inputs.map((i) => [i.name, inputSchema(i.type)])) as Record<
      string,
      z.ZodType
    >,
  );
}

const Table = z.object({ headers: z.array(z.string()), rows: z.array(z.array(z.string())) });

/**
 * A field's text as the output's type: decimals and integers lose currency signs, spaces and
 * thousands commas (`$1,234.50` → `1234.50`); anything else is not that number.
 */
export function scriptFieldValue(type: ScriptOutputType, text: string): unknown {
  if (type !== "decimal" && type !== "integer") return text.trim();
  const bare = text.replace(/[\s,$€£]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (type === "integer") return /^-?\d{1,13}$/.test(bare) ? Number(bare) : text;
  return DECIMAL.test(bare) ? bare : text;
}

function outputSchema(type: ScriptOutputType): z.ZodType {
  switch (type) {
    case "text":
      return z.string().max(60_000);
    case "decimal":
      return z.string().regex(DECIMAL, "not a decimal number");
    case "integer":
      return z.number().int();
    case "table":
      return Table;
    case "document":
      return z.object({ documentId: z.string(), filename: z.string() });
  }
}

/** What a script reads, typed by its declarations; a write's adds `submitted` and `url`. */
export function scriptOutputSchema(def: Pick<BrowserScriptDefinition, "outputs" | "sideEffect">) {
  const fields: Record<string, z.ZodType> = Object.fromEntries(
    def.outputs.map((o) => [o.name, outputSchema(o.type)]),
  );
  if (def.sideEffect === "external") {
    fields.submitted = z.boolean();
    fields.url = z.string();
  }
  return z.strictObject(fields);
}

/** A script's tool input and output as JSON Schema, for the builder's and Library's listings. */
export function scriptJsonSchemas(def: BrowserScriptDefinition): {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
} {
  const js = (s: z.ZodType) =>
    z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return { input: js(scriptInputSchema(def)), output: js(scriptOutputSchema(def)) };
}

// ── The recorder ─────────────────────────────────────────────────────────────────────────────────

/**
 * One thing the person recording asks our browser to do (docs/plan.md §1.86 "Scripts"): the
 * recorded step comes from it. A typed value marked `as` becomes an input of that name (the value
 * is its example); a read marked `as` becomes an output. A click that `submits` is recorded and
 * never performed.
 */
export const RecorderAction = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("open"),
    /** A full address, or a path on the site's own address (`/orders/new`). */
    url: z.string().trim().min(1).max(2000),
  }),
  z.strictObject({
    op: z.literal("fill"),
    selector: CssSelector,
    value: z.string().max(2000),
    as: ScriptValueName.optional(),
  }),
  z.strictObject({
    op: z.literal("click"),
    selector: CssSelector,
    submits: z.boolean().default(false),
  }),
  z.strictObject({ op: z.literal("read_field"), selector: CssSelector, as: ScriptValueName }),
  z.strictObject({
    op: z.literal("read_table"),
    table: z.number().int().min(0).max(19),
    as: ScriptValueName,
  }),
  z.strictObject({
    op: z.literal("download"),
    url: z.string().trim().min(1).max(2000),
    as: ScriptValueName,
  }),
]);
export type RecorderAction = z.infer<typeof RecorderAction>;
export type RecorderActionInput = z.input<typeof RecorderAction>;

/**
 * The recording being made (`browser_script.recording`): the working copy, edited in place while
 * someone records, with each step's evidence (its screenshot's storage key and the address it was
 * on). Saving it makes an immutable version (`recordingDefinition`).
 */
export const ScriptRecording = z.object({
  description: z.string().max(1000).default(""),
  inputs: z.array(ScriptInputDecl).max(30).default([]),
  outputs: z.array(ScriptOutputDecl).max(30).default([]),
  steps: z.array(ScriptStep).max(50).default([]),
  evidence: z
    .record(z.string(), z.object({ screenshot: z.string().nullable(), url: z.string() }))
    .default({}),
  undo: ScriptUndo.default({ kind: "none" }),
});
export type ScriptRecording = z.infer<typeof ScriptRecording>;

/** A recorded action as a step: a path is on the site's own address; `as` names an input or output. */
export function recordedStep(
  action: RecorderAction,
  id: string,
  siteOrigin: string,
): { step: ScriptStep; input?: ScriptInputDecl; output?: ScriptOutputDecl } {
  const full = (url: string) => (url.startsWith("/") ? `${siteOrigin}${url}` : url);
  switch (action.op) {
    case "open":
      return { step: { id, op: "open", url: full(action.url) } };
    case "fill":
      return action.as
        ? {
            step: { id, op: "fill", selector: action.selector, value: { input: action.as } },
            input: { name: action.as, label: action.as, type: "text", example: action.value },
          }
        : { step: { id, op: "fill", selector: action.selector, value: { text: action.value } } };
    case "click":
      return { step: { id, op: "click", selector: action.selector, submits: action.submits } };
    case "read_field":
      return {
        step: { id, op: "read_field", selector: action.selector, output: action.as },
        output: { name: action.as, label: action.as, type: "text" },
      };
    case "read_table":
      return {
        step: { id, op: "read_table", table: action.table, output: action.as },
        output: { name: action.as, label: action.as, type: "table" },
      };
    case "download":
      return {
        step: { id, op: "download", url: full(action.url), output: action.as },
        output: { name: action.as, label: action.as, type: "document" },
      };
  }
}

/** The values a recording's replay and a test fill: each input's example. */
export function recordingExamples(
  recording: Pick<ScriptRecording, "inputs">,
): Record<string, unknown> {
  return Object.fromEntries(
    recording.inputs.map((i) => [
      i.name,
      i.type === "integer" && i.example !== undefined && /^-?\d+$/.test(i.example)
        ? Number(i.example)
        : (i.example ?? ""),
    ]),
  );
}

/** The definition a recording saves as: it submits, so it is a write, or it only reads. */
export function recordingDefinition(
  site: string,
  name: string,
  recording: ScriptRecording,
): BrowserScriptDefinitionInput {
  return {
    schemaVersion: 1,
    site,
    name,
    description: recording.description,
    inputs: recording.inputs,
    outputs: recording.outputs,
    steps: recording.steps,
    sideEffect: submitStep(recording) ? "external" : "none",
    undo: recording.undo,
  };
}
