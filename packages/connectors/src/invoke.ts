import { levelFor, renderSummary, type ToolSpec } from "@countersign/core";
import type { z } from "zod";
import type { Connector, ToolContext, ToolHandler, WriteContext } from "./connector";
import { childLogger } from "./logger";

export type ToolCallErrorCode =
  | "unknown_tool"
  | "wrong_connection"
  | "not_connected"
  | "permission_off"
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
function check(connector: Connector, spec: ToolSpec, ctx: ToolContext): void {
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
  if (levelFor(c.permissions, spec.verb) === "off") {
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
  if (!r.success) throw new ToolCallError(code, toolId, code.replace("_", " "), r.error.issues);
  return r.data;
}

function summarize(spec: ToolSpec, output: unknown): string | undefined {
  if (!spec.summary) return undefined;
  try {
    return renderSummary(spec.summary, output);
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
  check(connector, spec, ctx);
  const parsed = parse(handler.input, input, "invalid_input", toolId);
  const raw = await handler.run(parsed, withToolLogger(ctx, connector, toolId));
  const output = parse(handler.output, raw, "invalid_output", toolId);
  const summary = summarize(spec, output);
  return summary === undefined ? { output } : { output, summary };
}

/**
 * Reads the state a write would change, for the approval card ("now / after this change") and
 * `external_action.before`. Never writes.
 */
export async function captureBefore(
  connector: Connector,
  toolId: string,
  input: unknown,
  ctx: ToolContext,
): Promise<{ input: unknown; before: unknown }> {
  const { spec, handler } = lookup(connector, toolId);
  if (handler.kind !== "write") throw new ToolCallError("not_a_write", toolId, "tool only reads");
  check(connector, spec, ctx);
  const parsed = parse(handler.input, input, "invalid_input", toolId);
  const raw = await handler.before(parsed, withToolLogger(ctx, connector, toolId));
  return {
    input: parsed,
    before: parse(handler.beforeSchema, raw ?? null, "invalid_before", toolId),
  };
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
): Promise<WriteResult> {
  const { spec, handler } = lookup(connector, toolId);
  if (handler.kind !== "write") throw new ToolCallError("not_a_write", toolId, "tool only reads");
  if (spec.verb === "read") throw new ToolCallError("not_a_write", toolId, "verb is read");
  check(connector, spec, ctx);
  const parsed = parse(handler.input, input, "invalid_input", toolId);
  const logged = withToolLogger(ctx, connector, toolId);
  const before = parse(
    handler.beforeSchema,
    (await handler.before(parsed, logged)) ?? null,
    "invalid_before",
    toolId,
  );
  const raw = await handler.run(parsed, logged, before);
  const output = parse(handler.output, raw, "invalid_output", toolId);
  const summary = summarize(spec, output);
  return summary === undefined ? { output, before } : { output, before, summary };
}
