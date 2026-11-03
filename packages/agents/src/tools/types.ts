// Tools the platform and packs implement in-process (sideEffect `none` or `internal`). Connector
// tools keep their own handler shape (packages/connectors); the tool registry holds both.

import type { JsonObject, ToolSpec } from "@countersign/core";
import { z } from "zod";

export type RunMode = "live" | "test";

/** Who and what a tool call is made for: one client, one agent version, one step of one run. */
export interface ToolInvocation {
  tenantId: string;
  agentId: string;
  agentVersionId: string;
  runId: string;
  stepRunId: string;
  /** The workflow step (or command) the call belongs to. */
  stepId: string;
  mode: RunMode;
  threadId?: string | undefined;
  /** The platform's own records (inbox, threads, memory), reached through a port. */
  platform: PlatformStore;
}

/** A platform or pack tool: its spec plus a handler validated on both sides (invariant 5). */
export interface InternalTool {
  spec: ToolSpec;
  input: z.ZodType;
  output: z.ZodType;
  run(input: unknown, ctx: ToolInvocation): Promise<unknown>;
}

export interface InboxItemInput {
  kind: "approval" | "review" | "request" | "extraction_review" | "external_action";
  title: string;
  payload: JsonObject;
  agentId?: string | null;
  runId?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  assigneeRole?: "operator" | "client_admin" | "client_user" | null;
  assigneeUserId?: string | null;
  dueAt?: Date | null;
}

export interface MessageInput {
  threadId?: string | undefined;
  /** Used to find or open the subject's thread when no thread id is given. */
  subject?: { type: string; id: string | null; title: string } | undefined;
  agentVersionId: string | null;
  body: JsonObject;
  sources: string[];
  audience: "client" | "operator";
}

/**
 * The platform's own records a tool may write. Implemented over the database in `src/log/`;
 * tests may pass an in-memory one.
 */
export interface PlatformStore {
  createInboxItem(tenantId: string, item: InboxItemInput): Promise<{ id: string }>;
  postMessage(tenantId: string, message: MessageInput): Promise<{ id: string; threadId: string }>;
  writeMemory(
    tenantId: string,
    note: { agentId: string; note: string; scope: string },
  ): Promise<{ id: string }>;
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
}

/** Defines a platform or pack tool; its spec's JSON Schemas come from the Zod schemas. */
export function defineInternalTool<I extends z.ZodType, O extends z.ZodType>(def: {
  id: string;
  description: string;
  sideEffect: "none" | "internal";
  verb?: "read" | "create" | "update";
  source?: string;
  summary?: string;
  input: I;
  output: O;
  run(input: z.output<I>, ctx: ToolInvocation): Promise<z.input<O>>;
}): InternalTool {
  return {
    spec: {
      id: def.id,
      description: def.description,
      input: jsonSchemaOf(def.input),
      output: jsonSchemaOf(def.output),
      sideEffect: def.sideEffect,
      verb: def.sideEffect === "none" ? "read" : (def.verb ?? "create"),
      source: def.source ?? "platform",
      ...(def.summary === undefined ? {} : { summary: def.summary }),
    },
    input: def.input,
    output: def.output,
    run: (input, ctx) => def.run(input as z.output<I>, ctx),
  };
}
