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
  /** The documents capability (`docs.*` tools); absent where nothing provides it. */
  documents?: DocumentsPort | undefined;
  /**
   * The settings of the skill this call runs under (its defaults under the agent's overrides),
   * e.g. a matching threshold. Tools read thresholds here, never from the model's input.
   */
  settings?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Per-run handles apps/api gives pack tools (a database, the model transport). Opaque here:
   * packages/agents passes them through and never reads them (plan §1.12).
   */
  services?: Readonly<Record<string, unknown>> | undefined;
  /** Adds a model call a tool made (e.g. extraction) to the step's and run's cost. */
  recordUsage?:
    | ((usage: { costUsd: string; tokensIn: number; tokensOut: number }) => Promise<void>)
    | undefined;
}

/** A document as tools see it: metadata, a short-lived link, and its latest reading. */
export interface DocumentForTool {
  id: string;
  source: string;
  filename: string;
  mimeType: string;
  status: string;
  pageCount: number | null;
  transactionId: string | null;
  receivedAt: string;
  /** Signed, 5 minutes; null where no signer is configured. */
  url: string | null;
  extraction: {
    id: string;
    model: string;
    header: Record<string, unknown>;
    subtotal: string;
    freight: string;
    surcharges: { label: string; amount: string }[];
    tax: string;
    total: string;
    totalsMatch: boolean;
    problems: string[];
    lines: {
      lineNo: number;
      vendorSku: string | null;
      description: string;
      qty: string;
      uom: string | null;
      unitPrice: string;
      extPrice: string;
      page: number | null;
    }[];
  } | null;
}

export interface ExtractSummary {
  documentId: string;
  extractionId: string;
  status: "extracted" | "needs_review";
  totalsMatch: boolean;
  problems: string[];
  lineCount: number;
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string;
  total: string;
  inboxItemId: string | null;
}

export type FindSupportOutcome =
  | { status: "found"; transactionId: string; documentIds: string[]; linkedNow: boolean }
  | { status: "candidates"; transactionId: string; documentIds: string[] }
  | { status: "missing"; transactionId: string; unextractedDocumentIds: string[] };

/**
 * The documents capability as tools reach it. Implemented over packages/documents in `src/log/`;
 * each call is its own client-scoped transaction(s), never held across a model call.
 */
export interface DocumentsPort {
  get(tenantId: string, documentId: string): Promise<DocumentForTool | null>;
  extract(
    tenantId: string,
    input: {
      documentId: string;
      agentVersionId: string;
      testRun: boolean;
      recordUsage?: ToolInvocation["recordUsage"];
    },
  ): Promise<ExtractSummary>;
  findSupport(
    tenantId: string,
    input: { transactionId: string; testRun: boolean },
  ): Promise<FindSupportOutcome>;
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
