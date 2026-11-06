// The platform's own sense types (ARCHITECTURE §8), with their payloads. Payloads stay small: ids
// and the few fields a trigger filter is likely to test. Anything larger is read through tools
// from the record the event points at.

import {
  ConnectionNeedsAttentionPayload,
  DecimalString,
  type EventTypeSpec,
  HealthSummary,
  type PlatformEventType,
  RunFailedPayload,
} from "@countersign/core";
import { z } from "zod";

const Id = z.uuid();
const NullableId = Id.nullable();

const Money = z.strictObject({ amount: DecimalString, currency: z.string().length(3) });

export const TransactionCreatedPayload = z.strictObject({
  transactionId: Id,
  /** The connector that brought it in, e.g. `qbo` or `upload`. */
  source: z.string().min(1),
  vendorId: NullableId,
  total: Money.nullable(),
  /** ISO date (yyyy-mm-dd). */
  txnDate: z.string().nullable(),
});

export const TransactionUpdatedPayload = TransactionCreatedPayload.extend({
  /** Field names that changed. */
  changed: z.array(z.string()),
});

export const DocumentReceivedPayload = z.strictObject({
  documentId: Id,
  /** `upload`, `email`, … */
  source: z.string().min(1),
  filename: z.string(),
  mimeType: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const DocumentExtractedPayload = z.strictObject({
  documentId: Id,
  extractionId: Id,
  lineCount: z.number().int().nonnegative(),
  totalsValid: z.boolean(),
});

export const DocumentExtractionFailedPayload = z.strictObject({
  documentId: Id,
  error: z.string(),
});

export const InboxResolvedPayload = z.strictObject({
  inboxItemId: Id,
  kind: z.string(),
  runId: NullableId,
  approved: z.boolean().nullable(),
  resolvedBy: NullableId,
});

export const ExternalActionDonePayload = z.strictObject({
  externalActionId: Id,
  tool: z.string(),
  connectionId: Id,
  runId: NullableId,
});

export const ExternalActionFailedPayload = ExternalActionDonePayload.extend({ error: z.string() });

export const AlertRaisedPayload = z.strictObject({
  alertId: Id,
  kind: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
  /** Record ids the alert rests on (CLAUDE.md invariant 10): never empty. */
  sources: z.array(z.string()).min(1),
});

export const ScheduleTickPayload = z.strictObject({
  /** The tick (ISO instant) this is for. */
  scheduledAt: z.iso.datetime({ offset: true }),
});

// v0.12 W1-F: accounts receivable (ARCHITECTURE §6.2, docs/plan.md §1.41).
/** An invoice to a customer in the client's books. */
export const ReceivableCreatedPayload = z.strictObject({
  receivableId: Id,
  /** The connector it came from, e.g. `qbo`. */
  source: z.string().min(1),
  /** The directory organization it is linked to, when one has its customer's id. */
  organizationId: NullableId,
  total: Money,
  /** What is still owed. */
  balance: Money,
  /** ISO date (yyyy-mm-dd), when it has one. */
  dueDate: z.string().nullable(),
  status: z.enum(["open", "paid", "void", "deleted"]),
});

export const ReceivableUpdatedPayload = ReceivableCreatedPayload.extend({
  /** What changed: balance, total, status, dueDate, customer, docNumber, note. */
  changed: z.array(z.string()),
});

export const ReceivablePaidPayload = ReceivableCreatedPayload.omit({ status: true });
// end v0.12 W1-F

interface PlatformEventDef {
  description: string;
  subjectType?: string;
  payload: z.ZodType;
  sample: unknown;
}

const SAMPLE_ID = "0192f7a0-0000-7000-8000-000000000001";
const SAMPLE_ID_2 = "0192f7a0-0000-7000-8000-000000000002";

export const PLATFORM_EVENTS = {
  "transaction.created": {
    description: "A purchase or bill arrived from a connected tool or an upload.",
    subjectType: "transaction",
    payload: TransactionCreatedPayload,
    sample: {
      transactionId: SAMPLE_ID,
      source: "upload",
      vendorId: SAMPLE_ID_2,
      total: { amount: "1250.0000", currency: "USD" },
      txnDate: "2026-11-02",
    },
  },
  "transaction.updated": {
    description: "A transaction changed in the connected tool.",
    subjectType: "transaction",
    payload: TransactionUpdatedPayload,
    sample: {
      transactionId: SAMPLE_ID,
      source: "upload",
      vendorId: SAMPLE_ID_2,
      total: { amount: "1300.0000", currency: "USD" },
      txnDate: "2026-11-02",
      changed: ["total"],
    },
  },
  "document.received": {
    description: "A document was uploaded or forwarded.",
    subjectType: "document",
    payload: DocumentReceivedPayload,
    sample: {
      documentId: SAMPLE_ID,
      source: "upload",
      filename: "invoice-1042.pdf",
      mimeType: "application/pdf",
      sha256: "0".repeat(64),
    },
  },
  "document.extracted": {
    description: "A document's lines and totals were extracted.",
    subjectType: "document",
    payload: DocumentExtractedPayload,
    sample: { documentId: SAMPLE_ID, extractionId: SAMPLE_ID_2, lineCount: 12, totalsValid: true },
  },
  "document.extraction_failed": {
    description: "Extraction could not read a document.",
    subjectType: "document",
    payload: DocumentExtractionFailedPayload,
    sample: { documentId: SAMPLE_ID, error: "unreadable scan" },
  },
  "inbox.resolved": {
    description: "Someone approved, rejected or answered an inbox item.",
    subjectType: "inbox_item",
    payload: InboxResolvedPayload,
    sample: {
      inboxItemId: SAMPLE_ID,
      kind: "approval",
      runId: SAMPLE_ID_2,
      approved: true,
      resolvedBy: null,
    },
  },
  "external_action.done": {
    description: "A change to a client's tool was made.",
    subjectType: "external_action",
    payload: ExternalActionDonePayload,
    sample: {
      externalActionId: SAMPLE_ID,
      tool: "testkit.write",
      connectionId: SAMPLE_ID_2,
      runId: null,
    },
  },
  "external_action.failed": {
    description: "A change to a client's tool failed.",
    subjectType: "external_action",
    payload: ExternalActionFailedPayload,
    sample: {
      externalActionId: SAMPLE_ID,
      tool: "testkit.write",
      connectionId: SAMPLE_ID_2,
      runId: null,
      error: "record changed since it was read",
    },
  },
  "alert.raised": {
    description: "An agent raised an alert with its evidence.",
    subjectType: "alert",
    payload: AlertRaisedPayload,
    sample: {
      alertId: SAMPLE_ID,
      kind: "price_change",
      severity: "warning",
      sources: [SAMPLE_ID_2],
    },
  },
  "schedule.tick": {
    description: "A scheduled time came round.",
    payload: ScheduleTickPayload,
    sample: { scheduledAt: "2026-11-03T14:00:00.000Z" },
  },
  // The supervisor's (docs/plan.md §1.28); payloads are validated by core's schemas.
  "run.failed": {
    description: "A live run of one of the client's agents failed.",
    subjectType: "run",
    payload: RunFailedPayload,
    sample: {
      runId: SAMPLE_ID,
      agentId: SAMPLE_ID_2,
      agentVersionId: "0192f7a0-0000-7000-8000-000000000003",
      workflowSlug: "check-bills",
      stepId: "extract",
      error: "the testkit connection is not bound",
    },
  },
  "connection.needs_attention": {
    description:
      "A connection needs a person: a sign-in expired or was revoked, a sync failed, a website login stopped, or a code alert.",
    subjectType: "connection",
    payload: ConnectionNeedsAttentionPayload,
    sample: {
      connectionId: SAMPLE_ID,
      connector: "zoho_crm",
      reason: "signin_expired",
      detail: "Zoho CRM refused the refresh",
      sourceId: null,
    },
  },
  "health.checked": {
    description: "The supervisor's daily health check finished, with its summary.",
    payload: HealthSummary,
    sample: {
      checkedAt: "2026-11-05T08:00:00.000Z",
      runs: { total: 12, failed: 1 },
      connections: { total: 3, needsAttention: 0 },
      waiting: { count: 2, oldestHours: 5 },
      agents: { active: 3, paused: 0 },
      openFindings: 1,
      sources: [SAMPLE_ID],
    },
  },
  // v0.12 W1-F: accounts receivable.
  "receivable.created": {
    description: "An invoice to a customer arrived from the client's books (QuickBooks).",
    subjectType: "receivable",
    payload: ReceivableCreatedPayload,
    sample: {
      receivableId: SAMPLE_ID,
      source: "qbo",
      organizationId: SAMPLE_ID_2,
      total: { amount: "4200.0000", currency: "USD" },
      balance: { amount: "4200.0000", currency: "USD" },
      dueDate: "2026-12-01",
      status: "open",
    },
  },
  "receivable.updated": {
    description: "An invoice to a customer changed in the client's books (a payment, an edit).",
    subjectType: "receivable",
    payload: ReceivableUpdatedPayload,
    sample: {
      receivableId: SAMPLE_ID,
      source: "qbo",
      organizationId: SAMPLE_ID_2,
      total: { amount: "4200.0000", currency: "USD" },
      balance: { amount: "2100.0000", currency: "USD" },
      dueDate: "2026-12-01",
      status: "open",
      changed: ["balance"],
    },
  },
  "receivable.paid": {
    description: "An invoice to a customer was paid in full (its balance reached zero).",
    subjectType: "receivable",
    payload: ReceivablePaidPayload,
    sample: {
      receivableId: SAMPLE_ID,
      source: "qbo",
      organizationId: SAMPLE_ID_2,
      total: { amount: "4200.0000", currency: "USD" },
      balance: { amount: "0.0000", currency: "USD" },
      dueDate: "2026-12-01",
    },
  },
} as const satisfies Record<PlatformEventType, PlatformEventDef>;

export type PlatformEventPayloads = {
  [K in PlatformEventType]: z.infer<(typeof PLATFORM_EVENTS)[K]["payload"]>;
};

/** The platform's event types as catalogue entries (JSON Schema payloads) for the builder. */
export function platformEventSpecs(): EventTypeSpec[] {
  return Object.entries(PLATFORM_EVENTS).map(([type, def]) => {
    const spec: EventTypeSpec = {
      type,
      description: def.description,
      payload: z.toJSONSchema(def.payload, { io: "input" }) as Record<string, unknown>,
      sample: def.sample,
    };
    if ("subjectType" in def) spec.subjectType = def.subjectType;
    return spec;
  });
}
