import { isPlainObject, renderSummary, type ToolSpec } from "@countersign/core";
import type { z } from "zod";
import { actionIsOn } from "./actions";
import {
  type Connector,
  NotWrittenError,
  type ToolContext,
  type ToolHandler,
  type WriteContext,
} from "./connector";
import { childLogger } from "./logger";
import { connectionLevel } from "./permissions";

export type ToolCallErrorCode =
  | "unknown_tool"
  | "wrong_connection"
  | "not_connected"
  | "permission_off"
  | "action_off"
  | "invalid_input"
  | "invalid_output"
  | "invalid_before"
  | "not_a_write"
  | "not_a_read";

/** A tool call refused or broken at the framework boundary (not inside the handler). */
export class ToolCallError extends Error {
  constructor(
    readonly code: ToolCallErrorCode,
    readonly toolId: string,
    message: string,
    readonly issues?: z.core.$ZodIssue[],
  ) {
    super(`${toolId}: ${message}`);
    this.name = "ToolCallError";
  }
}

export interface ToolResult {
  output: unknown;
  /** The tool's summary template rendered over its output, for the client timeline. */
  summary?: string;
}

export interface WriteResult extends ToolResult {
  before: unknown;
}

function lookup(connector: Connector, toolId: string): { spec: ToolSpec; handler: ToolHandler } {
  const spec = connector.manifest.tools.find((t) => t.id === toolId);
  const handler = connector.tools[toolId];
  if (!spec || !handler) throw new ToolCallError("unknown_tool", toolId, "no such tool");
  return { spec, handler };
}

/**
 * Framework checks before any handler runs: the context's connection belongs to this client and
 * this connector, is connected, and its matrix doesn't have the verb `off`. The permission gate
 * in packages/agents decides run / approval / refused; this is the last line, so a client's
 * tightening applies even to a call already past the gate.
 */
function check(connector: Connector, spec: ToolSpec, ctx: ToolContext, input: unknown): void {
  const c = ctx.connection;
  if (c.tenantId !== ctx.tenantId || c.connector !== connector.manifest.id) {
    throw new ToolCallError(
      "wrong_connection",
      spec.id,
      "the connection is not this client's connection to this connector",
    );
  }
  // Connectors without auth (built in, always on) need no sign-in, so `pending` is fine for them;
  // a disconnected or failing connection is never used.
  const usable =
    c.status === "connected" || (c.status === "pending" && connector.manifest.auth === "none");
  if (!usable) {
    throw new ToolCallError("not_connected", spec.id, `the connection is ${c.status}`);
  }
  // Step model E: an action the operator turned off on the connector's page, or one still waiting to
  // be turned on, is refused here too, so a step stored while it was on stops at the call.
  if (!actionIsOn(connector.manifest, spec.id, c.actionSwitches)) {
    throw new ToolCallError("action_off", spec.id, "this action is turned off");
  }
  // v0.12 W2-A: the entity and its scope count too (connectionLevel folds them into the verb).
  if (connectionLevel(connector.manifest, spec, c.permissions, input) === "off") {
    throw new ToolCallError("permission_off", spec.id, `${spec.verb} is off on this connection`);
  }
}

function parse(
  schema: z.ZodType,
  value: unknown,
  code: ToolCallErrorCode,
  toolId: string,
): unknown {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  // A step's money is `{ amount, currency }`; a tool takes a decimal string beside its own
  // currency. Refused as it came, the input is tried once with each money value as its amount.
  if (code === "invalid_input") {
    const plain = moneyAsDecimals(value);
    if (plain !== undefined) {
      const again = schema.safeParse(plain);
      if (again.success) return again.data;
    }
  }
  throw new ToolCallError(code, toolId, code.replace("_", " "), r.error.issues);
}

const isMoney = (v: unknown): v is { amount: string; currency: string } =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.keys(v).length === 2 &&
  typeof (v as { amount?: unknown }).amount === "string" &&
  typeof (v as { currency?: unknown }).currency === "string";

/**
 * The input with every money value (`{ amount: "41.54", currency: "USD" }`) as its amount
 * (`"41.54"`), or undefined when it holds none, or when its money is in more than one currency or
 * in another than the input's own `currency`: an amount never loses the currency it was in.
 */
// Staging, 2026-11-28: a receipt agent's coded lines reached qbo.purchase.create as money objects
// ("qbo.purchase.create: invalid input"); the supervisor rewrote them by hand. Invariant 6 holds:
// the decimal string is passed on as it was, never through a number.
export function moneyAsDecimals(value: unknown): unknown {
  const currencies = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (isMoney(v)) {
      currencies.add(v.currency.toUpperCase());
      return v.amount;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object" && v !== null) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  const out = walk(value);
  if (currencies.size === 0 || currencies.size > 1) return undefined;
  const own =
    typeof value === "object" && value !== null
      ? (value as { currency?: unknown }).currency
      : undefined;
  if (typeof own === "string" && !currencies.has(own.toUpperCase())) return undefined;
  return out;
}

function summarize(spec: ToolSpec, output: unknown): string | undefined {
  if (!spec.summary) return undefined;
  try {
    return renderSummary(spec.summary, output) ?? undefined;
  } catch {
    // A broken summary template must not fail a tool call that already happened.
    return undefined;
  }
}

function withToolLogger<C extends ToolContext>(ctx: C, connector: Connector, toolId: string): C {
  return {
    ...ctx,
    logger: childLogger(ctx.logger, {
      connector: connector.manifest.id,
      connectionId: ctx.connection.id,
      tool: toolId,
    }),
  };
}

/** Runs a read tool: input validated, output validated (invariant 5). */
export async function runReadTool(
  connector: Connector,
  toolId: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const { spec, handler } = lookup(connector, toolId);
  if (handler.kind !== "read") throw new ToolCallError("not_a_read", toolId, "tool writes");
  check(connector, spec, ctx, input);
  const parsed = parse(handler.input, input, "invalid_input", toolId);
  const raw = await handler.run(parsed, withToolLogger(ctx, connector, toolId));
  const output = parse(handler.output, raw, "invalid_output", toolId);
  const summary = summarize(spec, output);
  return summary === undefined ? { output } : { output, summary };
}

/**
 * Reads the state a write would change, for the approval card ("now / after this change") and
 * `external_action.before`. Never writes. `skipBefore` (a test run's write on a record only an
 * unmade write would have created): the connection and input are checked as always, and nothing
 * is read; `before` is null.
 */
export async function captureBefore(
  connector: Connector,
  toolId: string,
  input: unknown,
  ctx: ToolContext,
  opts: { skipBefore?: boolean } = {},
): Promise<{ input: unknown; before: unknown }> {
  const { spec, handler } = lookup(connector, toolId);
  if (handler.kind !== "write") throw new ToolCallError("not_a_write", toolId, "tool only reads");
  check(connector, spec, ctx, input);
  const parsed = parse(handler.input, input, "invalid_input", toolId);
  if (opts.skipBefore) return { input: parsed, before: null };
  const raw = await handler.before(parsed, withToolLogger(ctx, connector, toolId));
  return {
    input: parsed,
    before: parse(handler.beforeSchema, raw ?? null, "invalid_before", toolId),
  };
}

// ── Audit 3.8: the platform's stale-write check ─────────────────────────────────────────────

/**
 * The top-level fields of a before state that mark a record's version: QuickBooks' sync token,
 * Podio's revision, HubSpot's, Odoo's and the testkit's updated time, BILL's, Zoho's modified
 * time, an etag. When the before state the approver saw has one, it must still be the same.
 */
// DECISION: by field name, top level only, so no connector needs a change: a tool whose before
// state has none of these (a create, a sheet's cells, a message) is left to its own checks.
// `version` is not one (a browser script's version means the script's, which its tool checks).
export const RECORD_VERSION_FIELDS = [
  "syncToken",
  "revision",
  "updatedAt",
  "updatedTime",
  "modifiedTime",
  "etag",
] as const;

/** Fields that name the record a before state is of: a different one is not a stale one. */
const RECORD_ID_FIELDS = ["id", "itemId", "recordId"] as const;

const marker = (v: unknown): v is string | number =>
  (typeof v === "string" && v.length > 0) || (typeof v === "number" && Number.isFinite(v));

/** Whether a key of a write's input names the record it writes (`id`, `itemId`, `module`, …). */
const namesRecord = (key: string) =>
  key === "id" || key === "module" || key === "objectType" || /(Id|_id)$/.test(key);

/** The input's fields that name its record differ from the proposal's: two records. */
function otherRecord(input: unknown, proposedInput: unknown): boolean {
  if (!isPlainObject(input) || !isPlainObject(proposedInput)) return false;
  for (const k of new Set([...Object.keys(input), ...Object.keys(proposedInput)])) {
    if (namesRecord(k) && JSON.stringify(input[k]) !== JSON.stringify(proposedInput[k])) {
      return true;
    }
  }
  return false;
}

/** A record state's id fields, where it has them (top level). */
const idsOf = (state: Record<string, unknown>) =>
  RECORD_ID_FIELDS.filter((k) => marker(state[k])).map((k) => [k, state[k]] as const);

/**
 * The record states an earlier write left (its result, its after state), at the top level and
 * one level down (`{ record: { … } }`).
 */
function statesIn(values: readonly unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const v of values) {
    if (!isPlainObject(v)) continue;
    out.push(v);
    for (const inner of Object.values(v)) if (isPlainObject(inner)) out.push(inner);
  }
  return out;
}

/**
 * The version field that moved between the before state proposed and the one read now, or null
 * when they can't be compared (no marker on both, or not the same record) or nothing moved.
 * A marker the write's input carries itself (`syncToken`, or `expectedUpdatedAt` for
 * `updatedAt`) is left to the tool, which checks it against the record. Review of 3.8:
 * - `earlier`: what writes already made in the same run on the same connection left (results,
 *   after states). A marker one of them left on the same record is the run's own change, not a
 *   stale one (one step proposing two changes to one record).
 * - `proposedInput`: the input the proposed before state was read for. When a signer's edit
 *   points the write at another record (an id field of the input differs), the two states are
 *   of different records and are not compared.
 */
export function recordChangedSince(
  proposed: unknown,
  current: unknown,
  input?: unknown,
  options: { earlier?: readonly unknown[]; proposedInput?: unknown } = {},
): string | null {
  if (!isPlainObject(proposed) || !isPlainObject(current)) return null;
  for (const k of RECORD_ID_FIELDS) {
    if (marker(proposed[k]) && marker(current[k]) && proposed[k] !== current[k]) return null;
  }
  if (options.proposedInput !== undefined && otherRecord(input, options.proposedInput)) return null;
  const given = isPlainObject(input) ? input : {};
  const ids = idsOf(current);
  const left = statesIn(options.earlier ?? []).filter(
    (st) => ids.length > 0 && ids.every(([k, v]) => st[k] === v),
  );
  for (const k of RECORD_VERSION_FIELDS) {
    const expected = `expected${k.charAt(0).toUpperCase()}${k.slice(1)}`;
    if (given[k] !== undefined || given[expected] !== undefined) continue;
    const was = proposed[k];
    const now = current[k];
    if (!marker(was) || !marker(now) || String(was) === String(now)) continue;
    // DECISION (review of 3.8): accepted only for a state that names the same record (an id
    // field on both): a marker without a record to tie it to never stands in for this one's.
    if (left.some((st) => marker(st[k]) && String(st[k]) === String(now))) continue;
    return k;
  }
  return null;
}

/** The proposed input as the tool reads it (defaults filled in), or as given when it doesn't parse. */
function parseWriteInputQuiet(schema: z.ZodType, value: unknown): unknown {
  const r = schema.safeParse(value);
  return r.success ? r.data : value;
}

/**
 * Executes an approved write once. The caller (the agents' external actions) has the
 * `external_action` row, runs this inside a step keyed by its idempotency key, and stores the
 * result and `before`. The before state is captured again right before writing (the record may
 * have changed since it was proposed), so `before` is what the write actually replaced.
 */
export async function executeWrite(
  connector: Connector,
  toolId: string,
  input: unknown,
  ctx: WriteContext,
  /**
   * Wave 5 review: told right before the handler runs, so the caller knows that an error after it
   * may come after the provider took the write (before it: checks, input, the before read).
   * Audit 3.8: `recheck: false` skips the stale-write check, for a try that takes over one that
   * may have written (the record then moved because of it; the connector's own retry check
   * decides).
   * Review of 3.8: `earlier`, what writes already made in this run on this connection left, and
   * `proposedInput`, the input the proposed before state was read for (`recordChangedSince`).
   */
  hooks: {
    sending?: () => void;
    recheck?: boolean;
    earlier?: readonly unknown[];
    proposedInput?: unknown;
  } = {},
): Promise<WriteResult> {
  const { spec, handler } = lookup(connector, toolId);
  if (handler.kind !== "write") throw new ToolCallError("not_a_write", toolId, "tool only reads");
  if (spec.verb === "read") throw new ToolCallError("not_a_write", toolId, "verb is read");
  check(connector, spec, ctx, input);
  const parsed = parse(handler.input, input, "invalid_input", toolId);
  const logged = withToolLogger(ctx, connector, toolId);
  const before = parse(
    handler.beforeSchema,
    (await handler.before(parsed, logged)) ?? null,
    "invalid_before",
    toolId,
  );
  // Audit 3.8: the record the approver saw must be the one written over. Nothing is sent.
  const moved =
    hooks.recheck === false
      ? null
      : recordChangedSince(ctx.proposedBefore, before, parsed, {
          ...(hooks.earlier ? { earlier: hooks.earlier } : {}),
          ...(hooks.proposedInput !== undefined
            ? { proposedInput: parseWriteInputQuiet(handler.input, hooks.proposedInput) }
            : {}),
        });
  if (moved) {
    throw new NotWrittenError(
      `${toolId}: the record changed since this change was proposed (its ${moved} moved); nothing was written. Propose it again from what is there now.`,
    );
  }
  hooks.sending?.();
  const raw = await handler.run(parsed, logged, before);
  const output = parse(handler.output, raw, "invalid_output", toolId);
  const summary = summarize(spec, output);
  return summary === undefined ? { output, before } : { output, before, summary };
}

/**
 * A test run's stand-in for what a write would return (docs/plan.md §1.94), or undefined when the
 * tool declares none. Input and output are validated like a write's (invariant 5); nothing is
 * read or written.
 */
export function standInOutput(connector: Connector, toolId: string, input: unknown): unknown {
  const { handler } = lookup(connector, toolId);
  if (handler.kind !== "write") throw new ToolCallError("not_a_write", toolId, "tool only reads");
  if (!handler.testOutput) return undefined;
  const parsed = parse(handler.input, input, "invalid_input", toolId);
  return parse(handler.output, handler.testOutput(parsed), "invalid_output", toolId);
}

/**
 * A write's input as its tool reads it (its Zod input, defaults filled in), as `captureBefore`
 * stores it on the proposal. Nothing is read or written. Throws ToolCallError when it doesn't
 * parse.
 */
export function parseWriteInput(connector: Connector, toolId: string, input: unknown): unknown {
  const { handler } = lookup(connector, toolId);
  if (handler.kind !== "write") throw new ToolCallError("not_a_write", toolId, "tool only reads");
  return parse(handler.input, input, "invalid_input", toolId);
}
