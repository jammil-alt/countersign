// The contracts the Bookkeeping pack's tools, reports, cards and actions keep. apps/api adapts
// every pack's tools to the tool registry (apps/api/src/packs.ts `adapt`) with the same call context
// Materials' tools get; `PackToolContext` here is the part of it this pack uses. Pack tools are
// reads (`none`) or the pack's own records (`internal`); a write to the client's accounting tool is
// a connector's external tool, never a pack's (invariant 8).

import { lazy, lazyObject, type ToolSpec } from "@countersign/core";
import type { Db, Tx } from "@countersign/db";
import type { LlmClient } from "@countersign/llm";
import { z } from "zod";
import { PACK_ID } from "./ids";

/** What a pack tool gets for one call: one client, one agent version, one step's settings. */
export interface PackToolContext {
  tenantId: string;
  /** The agent version making the call: every decision records it (invariant 10). */
  agentVersionId: string;
  /** The run the call belongs to; null outside a run. */
  runId: string | null;
  /** A test run records nothing (it answers what it would have done). */
  mode: "live" | "test";
  /** The settings of the skill the step runs. */
  settings: Readonly<Record<string, unknown>>;
  /** Opened in the client's transaction by the tool itself (`withTenant(db, tenantId, …)`). */
  db: Db;
  llm: LlmClient | null;
}

export interface PackTool {
  spec: ToolSpec;
  input: z.ZodType;
  output: z.ZodType;
  run(input: unknown, ctx: PackToolContext): Promise<unknown>;
}

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
}

/**
 * A pack tool, named `bookkeeping.<what>`. Its input is parsed before `run`; its output is the tool
 * result the model reads, where a bank's words are data, never instructions (invariant 9).
 */
export function defineTool<I extends z.ZodType, O extends z.ZodType>(def: {
  id: `${typeof PACK_ID}.${string}`;
  description: string;
  sideEffect: "none" | "internal";
  verb?: "update";
  summary?: string;
  input: I;
  output: O;
  run(input: z.output<I>, ctx: PackToolContext): Promise<z.input<O>>;
}): PackTool {
  return {
    // Worker startup (2026-11-11): the JSON Schemas are made on first read (core `lazy`).
    spec: lazyObject({
      id: def.id,
      description: def.description,
      input: lazy(() => jsonSchemaOf(def.input)),
      output: lazy(() => jsonSchemaOf(def.output)),
      sideEffect: def.sideEffect,
      verb: def.sideEffect === "none" ? "read" : (def.verb ?? "create"),
      source: PACK_ID,
      ...(def.summary ? { summary: def.summary } : {}),
    }),
    input: def.input,
    output: def.output,
    run: async (input, ctx) => def.run(def.input.parse(input) as z.output<I>, ctx),
  };
}

/** A report for the back office and the portal, as JSON and CSV. */
export interface PackReportHandler {
  title: string;
  json(tx: Tx, tenantId: string, today: string): Promise<Record<string, unknown>>;
  csv(tx: Tx, tenantId: string, today: string): Promise<string>;
  item?(tx: Tx, tenantId: string, id: string): Promise<Record<string, unknown> | null>;
}

/** A back-office action on one client's pack data (a person's, never an agent's). */
export interface PackActionHandler {
  input: z.ZodType;
  run(
    db: Db,
    ctx: { tenantId: string; userId: string; input: unknown },
  ): Promise<Record<string, unknown>>;
}

/** A card's decision: `{action, input}`, checked by the card's own handler. */
export interface CardDecision {
  action: string;
  input: Record<string, unknown>;
}

/** An inbox card of this pack, by the `review` key of the item's payload. */
export interface PackReviewHandler {
  load(
    tx: Tx,
    tenantId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  decide(
    db: Db,
    input: {
      tenantId: string;
      userId: string;
      payload: Record<string, unknown>;
      decision: CardDecision | object;
      testRun: boolean;
    },
  ): Promise<void>;
}

/** A refusal in our words: an action's 422 (apps/api reads the name), a tool's error the model reads. */
export class PackRefusal extends Error {
  override name = "PackRefusal";
}

/** A card's refusal: the card's 422 (apps/api reads the name). */
export class ReviewError extends Error {
  override name = "ReviewError";
}

/** Runs a card's decision, turning the pack's refusals and bad input into the card's 422. */
export async function asReview<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ReviewError(error.issues.map((i) => i.message).join("; "));
    }
    if (error instanceof PackRefusal) throw new ReviewError(error.message);
    throw error;
  }
}
