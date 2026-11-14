// Tools the platform and packs implement in-process (sideEffect `none` or `internal`). Connector
// tools keep their own handler shape (packages/connectors); the tool registry holds both.

import {
  type DirectoryGetInput,
  type DirectoryGetOutput,
  type DirectorySearchInput,
  type DirectorySearchOutput,
  type DirectorySuggestInput,
  type FindingKind,
  type FindingParams,
  type HealthSummary,
  type JsonObject,
  type LedgerAccountsInput,
  type LedgerAccountsOutput,
  type LedgerDimensionsInput,
  type LedgerDimensionsOutput,
  type Locale,
  lazy,
  lazyObject,
  type ToolSpec,
  type VoiceSampleChannel,
} from "@countersign/core";
import type { MatchBillInput, MatchBillResult } from "@countersign/documents";
import type { LlmCallRecord, LlmExchange } from "@countersign/llm";
import { z } from "zod";
// v0.12 W2-D
import type { AccountPort } from "./account";
// v0.12 W2-E
import type { InboundPort } from "./inbound";
import type { ThreadsPort } from "./threads";
// P-7
import type { TranslationPort } from "./translate";
// §1.77
import type { WebResearchPort } from "./web";

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
  // P-1: what a pack's tools need (docs/plan.md §1.63).
  /**
   * The settings of the skill this call runs under (its defaults under the agent's and the step's
   * overrides), e.g. a matching threshold. Tools read thresholds here, never from the model's input.
   */
  settings?: Readonly<Record<string, unknown>> | undefined;
  /**
   * What apps/api hands a pack's tools (the run's database and model transport), opaque here: the
   * platform never imports a pack, and a pack never imports packages/agents (invariant 2).
   */
  packServices?: Readonly<Record<string, unknown>> | undefined;
  /** The client's knowledge base (`knowledge.search`); absent where nothing provides it. */
  knowledge?: KnowledgePort | undefined;
  /** The client's directory (`directory.*`); absent where nothing provides it. */
  directory?: DirectoryPort | undefined;
  /** B-2: the client's ledger (`ledger.*`); absent where nothing provides it. */
  ledger?: LedgerPort | undefined;
  /** The client's own health records (`health.*`, the supervisor); absent where none is given. */
  health?: HealthPort | undefined;
  /** The supervisor's findings and summaries (`supervisor.*`); absent where none is given. */
  findings?: FindingsPort | undefined;
  // v0.12 W1-C
  /** The client's threads (`threads.post`, `threads.read`); absent where none is given. */
  threads?: ThreadsPort | undefined;
  // v0.12 W2-D
  /** The client's account as the portal shows it (`account.*`, Sloan); absent where none is given. */
  account?: AccountPort | undefined;
  // v0.12 W2-E
  /** The message that started the run (`inbound.get`); absent where none is given. */
  inbound?: InboundPort | undefined;
  // P-7: message translation (docs/plan.md §1.69)
  /** Translations of the client's messages (`comms.translate`); absent where none is given. */
  translation?: TranslationPort | undefined;
  // §1.77: web research
  /** `web.search` and `web.fetch`; absent where research is off (they answer `off`). */
  web?: WebResearchPort | undefined;
  /**
   * Asks another agent of the same client (`agents.ask`): set by the runtime for a skill's tool
   * calls, absent inside an ask (no asks within asks) and in action steps.
   */
  ask?: ((input: AskInput) => Promise<AskAnswer>) | undefined;
  /** The client's language (docs/plan.md §1.18), when the run knows it. */
  language?: Locale | undefined;
  /** The clock (tests move it); default the system clock. */
  now?: (() => Date) | undefined;
  /** Adds a model call a tool made (e.g. extraction) to the step's and run's cost. */
  recordUsage?:
    | ((usage: { costUsd: string; tokensIn: number; tokensOut: number }) => Promise<void>)
    | undefined;
  /** v0.12 W1-E: records a model call a tool made (e.g. extraction) as the step's `model_call`. */
  recordModelCall?: ((record: LlmCallRecord, exchange: LlmExchange) => Promise<void>) | undefined;
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
      recordModelCall?: ToolInvocation["recordModelCall"];
      // P-9: read as a vendor's quote (no totals review, no duplicate check).
      reading?: "invoice" | "quote";
    },
  ): Promise<ExtractSummary>;
  findSupport(
    tenantId: string,
    input: { transactionId: string; testRun: boolean },
  ): Promise<FindSupportOutcome>;
  /** The one synced bill an invoice belongs to (packages/documents' matchBill); reads only. */
  matchBill(tenantId: string, input: MatchBillInput): Promise<MatchBillResult>;
  // Skill model (2026-11-10): "Read document" (an AI skill) and "record the reading" (a write).
  /**
   * The document's file, whole, for an AI skill's model call (packages/documents' readingFile).
   * Absent where nothing provides it: an AI skill that reads a document then fails with a reason.
   */
  file?(tenantId: string, documentId: string): Promise<DocumentFile>;
  /** Records a reading a skill step made as the document's latest extraction (no model here). */
  record?(
    tenantId: string,
    input: {
      documentId: string;
      reading: unknown;
      readBy: string;
      agentVersionId: string;
      testRun: boolean;
      asQuote: boolean;
    },
  ): Promise<RecordedReading>;
}

/** A document's file as a model reads it. */
export interface DocumentFile {
  documentId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

/** What recording a reading answers. */
export interface RecordedReading {
  documentId: string;
  extractionId: string;
  status: "extracted" | "needs_review";
  totalsMatch: boolean;
  problems: string[];
  lineCount: number;
  duplicateOfDocumentId: string | null;
}

/** One thing `knowledge.search` found: an FAQ, policy, document or memory note. */
export interface KnowledgeHitForTool {
  kind: "faq" | "policy" | "document" | "memory";
  id: string;
  title: string;
  excerpt: string;
  score: number;
  sources: string[];
}

/**
 * The client's knowledge base as tools reach it. Implemented over packages/documents in
 * `src/log/`; each call is one client-scoped transaction.
 */
export interface KnowledgePort {
  search(
    tenantId: string,
    input: {
      query: string;
      limit: number;
      /** The asking agent's own memory notes in these scopes are searched too. */
      memory: { agentId: string; scopes: string[] };
    },
  ): Promise<KnowledgeHitForTool[]>;
  // v0.12 W1-G: voice samples (docs/plan.md §1.42).
  /** The client's voice samples, newest first; optional: absent, `knowledge.voice_samples` fails. */
  voiceSamples?(
    tenantId: string,
    input: {
      personUserId?: string | undefined;
      channel?: VoiceSampleChannel | undefined;
      limit: number;
    },
  ): Promise<{ samples: VoiceSampleForTool[]; channelMatched: boolean }>;
}

/** One voice sample as a tool reads it: how a person writes, as data. */
export interface VoiceSampleForTool {
  id: string;
  versionId: string;
  title: string;
  text: string;
  channel: VoiceSampleChannel;
  person: { id: string; name: string | null };
}

/**
 * The client's directory as tools reach it (docs/plan.md §1.27). Implemented over the database in
 * `src/log/`; each call is one client-scoped transaction.
 */
/** B-2 (docs/plan.md §1.79): the client's ledger for `ledger.*`, read in its own transaction. */
export interface LedgerPort {
  accounts(tenantId: string, input: LedgerAccountsInput): Promise<LedgerAccountsOutput>;
  dimensions(tenantId: string, input: LedgerDimensionsInput): Promise<LedgerDimensionsOutput>;
}

export interface DirectoryPort {
  search(tenantId: string, input: DirectorySearchInput): Promise<DirectorySearchOutput>;
  get(tenantId: string, input: DirectoryGetInput): Promise<DirectoryGetOutput>;
  /**
   * Checks a suggestion against the client's directory and opens the client admin's inbox item,
   * unless the same change is already waiting (`duplicate`) or this is a test (`test_run`).
   */
  suggest(
    tenantId: string,
    input: {
      agentId: string;
      agentVersionId: string;
      runId: string;
      suggestion: DirectorySuggestInput;
      test: boolean;
    },
  ): Promise<{ status: "suggested" | "duplicate" | "test_run"; inboxItemId: string | null }>;
  // v0.14 W4-B: the supervisor's directory upkeep (docs/plan.md §1.27, §1.28 "Directory upkeep").
  /**
   * Vendors on the client's recent transactions that the directory doesn't have (no organization
   * linked to the vendor or of its name) and that were never suggested before (waiting, accepted
   * or declined), newest first, with the transactions as sources. Absent: no upkeep here.
   */
  unlistedVendors?(
    tenantId: string,
    input: { sinceDays: number; limit: number; now: Date },
  ): Promise<{ vendorId: string; name: string; sources: string[] }[]>;
}

// ── Health (docs/plan.md §1.28) ──────────────────────────────────────────────────────────────────

/** One run as the health tools see it. */
export interface HealthRun {
  id: string;
  agentId: string;
  agentName: string;
  agentVersionId: string;
  workflowSlug: string;
  mode: "live" | "test";
  status: string;
  createdAt: string;
  finishedAt: string | null;
  /** The step it failed at, and why (the run's recorded error). */
  failedStep: string | null;
  error: string | null;
}

export interface HealthConnection {
  id: string;
  connector: string;
  connectorName: string;
  /** What a person calls it: a website's address for a website login, else the tool's name. */
  label: string;
  status: string;
  lastSyncAt: string | null;
  /** A website login's stop (docs/plan.md §1.26). */
  stopped: { reason: string; at: string } | null;
  /** The latest time the platform found it needing a person, and why. */
  attention: { reason: string; at: string } | null;
  /** Client agents bound to it. */
  usedBy: string[];
}

export interface HealthInboxItem {
  id: string;
  kind: string;
  title: string;
  assignee: "client" | "operator";
  subjectType: string | null;
  createdAt: string;
  waitingHours: number;
  /** One of the supervisor's own findings (or an item carrying a finding's fingerprint). */
  finding: boolean;
}

export interface HealthAgent {
  id: string;
  slug: string;
  name: string;
  runStatus: string | null;
  liveVersionId: string | null;
  liveVersion: number | null;
  lastRun: { id: string; status: string; at: string } | null;
  lastTest: { id: string; status: string; at: string } | null;
}

/**
 * The client's own records the health tools read (src/log/health-port.ts): each call one
 * client-scoped transaction, so only that client's rows are visible (invariant 1).
 */
export interface HealthPort {
  runs(
    tenantId: string,
    input: { sinceHours: number; failedOnly: boolean; limit: number; agentId?: string | undefined },
  ): Promise<HealthRun[]>;
  connections(tenantId: string): Promise<HealthConnection[]>;
  inbox(tenantId: string, input: { now: Date }): Promise<HealthInboxItem[]>;
  agents(tenantId: string): Promise<HealthAgent[]>;
}

/** One finding to report (src/log/findings-port.ts writes it). */
export interface FindingInput {
  kind: FindingKind;
  fingerprint: string;
  /** The connection or agent it is about. */
  subjectId: string | null;
  /** The agent reporting it (the supervisor). */
  reporterAgentId: string;
  /** The client admin's item: its words come from core's findingText; null = operator only. */
  client: { params: FindingParams } | null;
  operator: { title: string; details: JsonObject; note: string | null };
  sources: string[];
  /**
   * When the issue was seen happening (a failed run's time). A finding a person resolved after
   * that is not opened again for it; absent: now (the issue is current).
   */
  seenAt?: Date | undefined;
}

/** `resolved`: a person already closed this issue after it was last seen; nothing was written. */
export type FindingItemStatus = "opened" | "open" | "reminded" | "resolved";

export interface FindingOutcome {
  fingerprint: string;
  client: { itemId: string; status: FindingItemStatus } | null;
  operator: { itemId: string; status: FindingItemStatus };
}

/**
 * The supervisor's writes (src/log/findings-port.ts): findings as inbox items keyed by their
 * fingerprint, and the daily summary as a `health.checked` event.
 */
export interface FindingsPort {
  report(tenantId: string, input: FindingInput, now: Date): Promise<FindingOutcome>;
  /** Open findings for the client admin (after a check), for the summary. */
  openClientFindings(tenantId: string): Promise<number>;
  /** The client's settings (`tenant.settings`), for the supervisor's own (core's supervisorSettings). */
  settings(tenantId: string): Promise<Record<string, unknown>>;
  summarize(tenantId: string, summary: HealthSummary): Promise<void>;
}

// ── Asking another agent ─────────────────────────────────────────────────────────────────────────

export interface AskInput {
  agentId: string;
  question: string;
}

export interface AskAnswer {
  agentId: string;
  agentName: string;
  /** The ask's own test run. */
  runId: string;
  status: "answered" | "no_answer";
  answer: string;
  sources: string[];
  /** Why there is no answer (a budget reached, a model error). */
  reason: string | null;
}

/** A platform or pack tool: its spec plus a handler validated on both sides (invariant 5). */
export interface InternalTool {
  spec: ToolSpec;
  input: z.ZodType;
  output: z.ZodType;
  run(input: unknown, ctx: ToolInvocation): Promise<unknown>;
  // v0.12 W2-C: the test bench (docs/plan.md §1.46)
  /**
   * Reads only its input (no port, no storage, no network): a tool-mode skill whose handler is
   * pure can run on the test bench. Absent: not pure.
   */
  pure?: boolean;
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

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
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
  /** v0.12 W2-C: reads only its input, so it may run on the test bench. */
  pure?: boolean;
  /** Skill model (2026-11-10): the tool's code calls a model inside it, and why (`ToolSpec`). */
  usesModel?: string;
}): InternalTool {
  return {
    ...(def.pure ? { pure: true } : {}),
    // Worker startup (2026-11-11): the JSON Schemas are made on first read (core `lazy`).
    spec: lazyObject({
      id: def.id,
      description: def.description,
      input: lazy(() => jsonSchemaOf(def.input)),
      output: lazy(() => jsonSchemaOf(def.output)),
      sideEffect: def.sideEffect,
      verb: def.sideEffect === "none" ? "read" : (def.verb ?? "create"),
      source: def.source ?? "platform",
      ...(def.summary === undefined ? {} : { summary: def.summary }),
      ...(def.usesModel === undefined ? {} : { usesModel: def.usesModel }),
    }),
    input: def.input,
    output: def.output,
    run: (input, ctx) => def.run(input as z.output<I>, ctx),
  };
}
