// Scripted site tools (docs/plan.md §1.86 "Scripts (wave 4)"; ARCHITECTURE v0.16 §10.14 "Browser
// connectors"): a recorded script's fixed steps, run by our code in a session our code signed in
// (./session.ts), every page checked against the site's allowed pages on the way in and on the
// address it lands on. The same runner replays a recording while it is made, tests a script (a dry
// run: the submit is never clicked, nothing is stored) and runs a published one as a tool. An
// element that isn't there stops the run with what was tried: the step asks for help (the browse
// help path, `needsHelp`), it never guesses another element.

import {
  type BrowserScriptDefinition,
  fillScriptUrl,
  type JsonObject,
  type PublishedBrowserScript,
  type ScriptOutputDecl,
  type ScriptStep,
  scriptFieldValue,
  scriptInputSchema,
  scriptOutputSchema,
} from "@countersign/core";
import type { ToolContext } from "../connector";
import { isDocumentType } from "../upload/forwarding";
import { BROWSER_SCRIPT_READ_TOOL, BROWSER_SCRIPT_SUBMIT_TOOL } from "./ids";
import { type BrowserSessionOptions, type SignedInPage, withBrowserSession } from "./session";
import { BrowserRefused } from "./sign-in";

/** A step's element (or table) isn't on the page: the run stops and asks for help. */
export class ScriptStepMissing extends Error {
  override name = "ScriptStepMissing";
  /** The steps done before it, with their evidence (set by `runScriptSteps`). */
  done: ScriptStepResult[] = [];
  constructor(
    readonly step: ScriptStep,
    readonly url: string,
    readonly what: string,
  ) {
    super(`step ${step.id}: ${what} isn't on ${url}`);
  }
}

/** One step as it ran: where, its evidence, and what a read gave. */
export interface ScriptStepResult {
  id: string;
  op: ScriptStep["op"];
  url: string;
  /** The evidence screenshot's storage key; null when it failed (evidence is best effort). */
  screenshot: string | null;
  /** `skipped`: a submit in a dry run, never clicked. */
  status: "done" | "skipped";
  /** What a read or a download gave, as the output will hold it. */
  value?: unknown;
}

export interface ScriptRun {
  steps: ScriptStepResult[];
  /** Raw values by output name (checked by `runScript`, not here). */
  outputs: Record<string, unknown>;
  /** Whether the submitting click was made. */
  submitted: boolean;
  url: string;
}

export interface ScriptRunOptions {
  /** Never clicks a submit and stores no file: a recording's replay and a test (they never write). */
  dryRun: boolean;
  /** Stores a downloaded file in the client's documents; required unless `dryRun`. */
  store?: (file: {
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
    sourceUrl: string;
  }) => Promise<{ documentId: string; created: boolean }>;
  /** A screenshot after every step, not only after a page opens or a click (the recorder's). */
  everyStep?: boolean;
}

/**
 * Runs steps in order with `values` (the inputs; a recording's examples) on a signed-in page.
 * Throws ScriptStepMissing for an element or table that isn't there (nothing after it is done),
 * BrowserRefused for a page the site doesn't allow, and the session's own errors.
 */
export async function runScriptSteps(
  page: SignedInPage,
  steps: readonly ScriptStep[],
  values: Readonly<Record<string, unknown>>,
  outputs: readonly ScriptOutputDecl[],
  options: ScriptRunOptions,
): Promise<ScriptRun> {
  const types = new Map<string, ScriptOutputDecl["type"]>(outputs.map((o) => [o.name, o.type]));
  const run: ScriptRun = { steps: [], outputs: {}, submitted: false, url: page.url() };
  try {
    await runSteps(page, steps, values, types, options, run);
  } catch (error) {
    if (error instanceof ScriptStepMissing) error.done = [...run.steps];
    throw error;
  }
  return run;
}

async function runSteps(
  page: SignedInPage,
  steps: readonly ScriptStep[],
  values: Readonly<Record<string, unknown>>,
  types: ReadonlyMap<string, ScriptOutputDecl["type"]>,
  options: ScriptRunOptions,
  run: ScriptRun,
): Promise<void> {
  const need = async (step: ScriptStep, selector: string) => {
    if (!(await page.has(selector))) throw new ScriptStepMissing(step, page.url(), selector);
  };
  for (const step of steps) {
    let shot: string | null = null;
    let status: ScriptStepResult["status"] = "done";
    let value: unknown;
    switch (step.op) {
      case "open":
        await page.open(fillScriptUrl(step.url, values));
        shot = page.lastScreenshot();
        break;
      case "fill": {
        await need(step, step.selector);
        const v = "input" in step.value ? values[step.value.input] : step.value.text;
        await page.fill(step.selector, v === undefined || v === null ? "" : String(v));
        break;
      }
      case "click":
        await need(step, step.selector);
        if (step.submits && options.dryRun) {
          status = "skipped";
          break;
        }
        await page.click(step.selector);
        if (step.submits) run.submitted = true;
        shot = page.lastScreenshot();
        break;
      case "read_field": {
        const text = await page.textOf(step.selector);
        if (text === null) throw new ScriptStepMissing(step, page.url(), step.selector);
        value = scriptFieldValue(types.get(step.output) ?? "text", text);
        page.note({ kind: "read", url: page.url() });
        break;
      }
      case "read_table": {
        const table = (await page.readTables())[step.table];
        if (!table) throw new ScriptStepMissing(step, page.url(), `table ${step.table + 1}`);
        value = table;
        page.note({ kind: "read", url: page.url() });
        break;
      }
      case "download": {
        const file = await page.download(fillScriptUrl(step.url, values));
        if (!isDocumentType(file.mimeType)) {
          throw new BrowserRefused(
            `${step.url} is ${file.mimeType || "an unknown type"}; documents are PDFs or images`,
          );
        }
        if (options.dryRun) {
          // DECISION: a test or a recording fetches the file to see it is there, and keeps
          // nothing: no document is made (test runs never write, not even our own records).
          value = { documentId: "", filename: file.filename };
          break;
        }
        if (!options.store) throw new BrowserRefused("documents are not available here");
        const stored = await options.store({
          bytes: file.bytes,
          filename: file.filename,
          mimeType: file.mimeType,
          sourceUrl: file.finalUrl,
        });
        page.note({ kind: "download", url: file.finalUrl, documentId: stored.documentId });
        value = { documentId: stored.documentId, filename: file.filename };
        break;
      }
    }
    if (shot === null && options.everyStep) shot = await page.shoot();
    if (value !== undefined && "output" in step) run.outputs[step.output] = value;
    run.url = page.url();
    run.steps.push({
      id: step.id,
      op: step.op,
      url: run.url,
      screenshot: shot,
      status,
      ...(value !== undefined ? { value } : {}),
    });
  }
}

/** A script's inputs, checked against its declarations (invariant 5); throws a refusal. */
export function scriptInputs(
  def: Pick<BrowserScriptDefinition, "inputs" | "name">,
  inputs: unknown,
): Record<string, unknown> {
  const parsed = scriptInputSchema(def).safeParse(inputs ?? {});
  if (!parsed.success) {
    const why = parsed.error.issues
      .map((i) => `${i.path.join(".") || "inputs"}: ${i.message}`)
      .join("; ");
    throw new BrowserRefused(`"${def.name}" can't take these inputs: ${why}`);
  }
  return parsed.data as Record<string, unknown>;
}

/** What a script gives back: its outputs, checked against its declarations (invariant 5). */
export function scriptResult(def: BrowserScriptDefinition, run: ScriptRun): JsonObject {
  const raw: Record<string, unknown> = { ...run.outputs };
  if (def.sideEffect === "external") {
    raw.submitted = run.submitted;
    raw.url = run.url;
  }
  const parsed = scriptOutputSchema(def).safeParse(raw);
  if (!parsed.success) {
    const why = parsed.error.issues
      .map((i) => `${i.path.join(".") || "output"}: ${i.message}`)
      .join("; ");
    throw new Error(`"${def.name}" read something it can't give back: ${why}`);
  }
  return parsed.data as JsonObject;
}

/**
 * The help request for a step that couldn't find its element: the executor asks the lead with what
 * was tried and the screenshots, as a browsing skill's (`needsHelp`, ./scope.ts).
 */
// DECISION: no `remember` tag: an answer can't change a script's fixed steps, so it is kept as an
// ordinary note on the step (the executor's default) and the operator re-records the script.
export function scriptNeedsHelp(
  def: Pick<BrowserScriptDefinition, "name" | "site">,
  missing: ScriptStepMissing,
  done: readonly ScriptStepResult[],
): { question: string; tried: string[]; screenshots?: string[] } {
  const shots = done.map((s) => s.screenshot).filter((s): s is string => s !== null);
  return {
    question:
      `The script "${def.name}" couldn't find ${missing.what} on ${missing.url}. The page may have changed: can you check it, or have us record the script again?`.slice(
        0,
        500,
      ),
    tried: [
      `Ran the script "${def.name}" on ${def.site}`,
      ...done.map((s) => `${s.status === "skipped" ? "Skipped" : "Did"} ${s.op} on ${s.url}`),
      `Step ${missing.step.id} (${missing.step.op}) found no ${missing.what}`,
    ].slice(0, 50),
    ...(shots.length > 0 ? { screenshots: shots.slice(-10) } : {}),
  };
}

// ── As a tool ────────────────────────────────────────────────────────────────────────────────────

/** A script tool's call: the site, the script's slug and its inputs. */
export interface ScriptCall {
  site: string;
  script: string;
  inputs: Record<string, unknown>;
}

/**
 * The client's published script a call names, checked: published (a draft never runs), on the
 * call's site, of the tool's kind (a read tool never submits), and the inputs typed as it declares.
 */
export async function loadScript(
  ctx: ToolContext,
  call: ScriptCall,
  sideEffect: "none" | "external",
): Promise<{ script: PublishedBrowserScript; inputs: Record<string, unknown> }> {
  const services = ctx.services?.browser;
  if (!services?.script) throw new BrowserRefused("scripts are not available in this deployment");
  const script = await services.script(call.script);
  if (!script || script.definition.site !== call.site) {
    throw new BrowserRefused(`there is no published script "${call.script}" on ${call.site}`);
  }
  const def = script.definition;
  if (def.sideEffect !== sideEffect) {
    throw new BrowserRefused(
      def.sideEffect === "external"
        ? `"${def.name}" submits a form: it runs as ${BROWSER_SCRIPT_SUBMIT_TOOL}, behind approval`
        : `"${def.name}" only reads: it runs as ${BROWSER_SCRIPT_READ_TOOL}`,
    );
  }
  return { script, inputs: scriptInputs(def, call.inputs) };
}

/** The reverse script's call a submitted write names (its undo), or null. */
function reverseOf(
  def: BrowserScriptDefinition,
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown>,
): JsonObject | null {
  if (def.undo.kind !== "reverse") return null;
  const values: JsonObject = {};
  for (const [name, from] of Object.entries(def.undo.inputs)) {
    const v = "input" in from ? inputs[from.input] : outputs[from.output];
    if (v !== undefined) values[name] = v as JsonObject[string];
  }
  return { script: def.undo.script, inputs: values };
}

/**
 * Runs a published script in one signed-in session (./session.ts: sign-in by code, every page
 * checked, sign-out and the session's record). A step whose element isn't there answers
 * `{ needsHelp }` (a write's with `submitted: false`: the submit is its last step, so nothing was
 * sent); the executor asks the lead and runs the step once more.
 */
export async function runPublishedScript(
  ctx: ToolContext,
  call: ScriptCall,
  sideEffect: "none" | "external",
  options: BrowserSessionOptions,
): Promise<JsonObject> {
  const { script, inputs } = await loadScript(ctx, call, sideEffect);
  const def = script.definition;
  const store = ctx.services?.browser?.storeDocument;
  const tool = sideEffect === "external" ? BROWSER_SCRIPT_SUBMIT_TOOL : BROWSER_SCRIPT_READ_TOOL;
  return withBrowserSession(ctx, { tool, site: call.site }, options, async (page) => {
    try {
      const run = await runScriptSteps(page, def.steps, inputs, def.outputs, {
        dryRun: false,
        ...(store ? { store } : {}),
      });
      const out = scriptResult(def, run);
      return sideEffect === "external" ? { ...out, reverse: reverseOf(def, inputs, out) } : out;
    } catch (error) {
      if (!(error instanceof ScriptStepMissing)) throw error;
      const needsHelp = scriptNeedsHelp(def, error, error.done) as unknown as JsonObject;
      return sideEffect === "external"
        ? { submitted: false, url: error.url, needsHelp }
        : { needsHelp };
    }
  });
}
