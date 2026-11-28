// The contracts the Sales pack's tools keep. apps/api adapts every pack's tools to the tool registry
// (apps/api/src/packs.ts `adapt`) with the same call context Materials' tools get; `PackToolContext`
// here is the part of it this pack uses. Pack tools are reads (`none`) or the pack's own records
// (`internal`); a write to the client's CRM is a connector's external tool, never a pack's
// (invariant 8).

import { lazy, lazyObject, type ToolSpec } from "@countersign/core";
import type { Db } from "@countersign/db";
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
  /** The workflow step (node id) the call belongs to, when the caller says. */
  stepId?: string | null | undefined;
  /** A test run records no decision (it answers what it would have decided). */
  mode: "live" | "test";
  /** The settings of the skill the step runs (`match_threshold`, `match_on`). */
  settings: Readonly<Record<string, unknown>>;
  /** Opened in the client's transaction by the tool itself (`withTenant(db, tenantId, …)`). */
  db: Db;
  /** The model and embeddings, each call's cost on the step; null where none is configured. */
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
 * A pack tool, named `sales.<what>`. Its input is parsed before `run`; its output is the tool
 * result the model reads, where a sheet's and a CRM's words are data, never instructions
 * (invariant 9).
 */
export function defineTool<I extends z.ZodType, O extends z.ZodType>(def: {
  id: `${typeof PACK_ID}.${string}`;
  description: string;
  sideEffect: "none" | "internal";
  verb?: "update";
  summary?: string;
  /** The tool calls a model (or embeddings) inside it, and why; only then is it handed one. */
  usesModel?: string;
  /** v0.18 (ARCHITECTURE §12.0): the record type it reads or saves. Its area is Sales. */
  entity?: string;
  /**
   * 2026-11-24: the connector whose synced records it reads (core `ToolSpec.feed`): apps/api
   * brings them up to date before the tool runs, and the step shows the connector's mark.
   */
  feed?: string;
  input: I;
  output: O;
  run(input: z.output<I>, ctx: PackToolContext): Promise<z.input<O>>;
}): PackTool {
  return {
    spec: lazyObject({
      id: def.id,
      description: def.description,
      input: lazy(() => jsonSchemaOf(def.input)),
      output: lazy(() => jsonSchemaOf(def.output)),
      sideEffect: def.sideEffect,
      verb: def.sideEffect === "none" ? "read" : (def.verb ?? "create"),
      source: PACK_ID,
      ...(def.summary ? { summary: def.summary } : {}),
      ...(def.usesModel ? { usesModel: def.usesModel } : {}),
      area: "sales",
      ...(def.entity ? { entity: def.entity } : {}),
      ...(def.feed ? { feed: def.feed } : {}),
    }),
    input: def.input,
    output: def.output,
    run: async (input, ctx) => def.run(def.input.parse(input) as z.output<I>, ctx),
  };
}

/** A refusal in our words: a tool's error the model and the operator read. */
export class SalesRefusal extends Error {
  override name = "SalesRefusal";
}
