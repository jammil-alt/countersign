// The tables in a client data export (docs/plan.md §1.36): what each CSV holds, read one page at a
// time inside the client's own scope (withTenant), with each query also filtered by the client.
//
// Columns are listed one by one, never `select *`, so nothing new reaches an export unnoticed.
// Left out on purpose: connection credentials and settings, the client's data key, grants and
// release codes (invariant 13); agent bundles, skills, step inputs and outputs, tool calls and
// agent memory, which are Mezonas' work and may hold instructions or prompts; cost and tokens;
// test runs, operator-only inbox items and messages, the event outbox, billing and feedback.
// JSON cells are scrubbed of every forbidden field besides (csv.ts).

import {
  clientLabel,
  findStep,
  isClientVisible,
  isPlainObject,
  type Step,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  connection,
  connectionChange,
  contact,
  contactChange,
  docExtraction,
  docLine,
  document,
  externalAction,
  inboxItem,
  knowledgeEntry,
  knowledgeEntryVersion,
  message,
  organization,
  organizationChange,
  rawRecord,
  run,
  stepRun,
  type Tx,
  tenantChange,
  thread,
  transaction,
  transactionLine,
  vendor,
} from "@countersign/db";
import { and, eq, gt, inArray, isNull, ne, or, type SQL } from "drizzle-orm";
import { plainTitle } from "../change-display";
import { sourcesOf } from "../routes/portal";
import { type CsvValue, documentPath, jsonCell } from "./csv";

export interface TablePage {
  rows: CsvValue[][];
  /** The id the next page starts after; null when this was the last page. */
  next: string | null;
}

export interface ExportTable {
  /** The file in the ZIP. */
  file: string;
  /** What the README says it holds. */
  about: string;
  header: readonly string[];
  page(tx: Tx, tenantId: string, after: string | null, limit: number): Promise<TablePage>;
}

/** `id > after`, for keyset paging by id. */
function after(column: Parameters<typeof gt>[0], cursor: string | null): SQL | undefined {
  return cursor ? gt(column, cursor) : undefined;
}

/** Splits a `limit + 1` read into this page and where the next one starts. */
function paged<T extends { id: string }>(
  rows: T[],
  limit: number,
  map: (row: T) => CsvValue[] | null,
): TablePage {
  const page = rows.slice(0, limit);
  return {
    rows: page.map(map).filter((r): r is CsvValue[] => r !== null),
    next: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Email addresses of the people a page names, read in one query. */
export async function emails(tx: Tx, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((v): v is string => v !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({ id: appUser.id, email: appUser.email })
    .from(appUser)
    .where(inArray(appUser.id, wanted));
  return new Map(rows.map((r) => [r.id, r.email]));
}

const by = (map: Map<string, string>, id: string | null) => (id ? (map.get(id) ?? id) : null);

/** Who decided an approval, as the portal's run view reads it. */
export function decisionOf(item: { status: string; resolution: unknown }): string | null {
  if (item.status !== "resolved") return null;
  const res = (isPlainObject(item.resolution) ? item.resolution : {}) as {
    approved?: unknown;
    decision?: unknown;
  };
  if (typeof res.approved === "boolean") return res.approved ? "approved" : "rejected";
  if (typeof res.decision === "string") return res.decision === "approve" ? "approved" : "rejected";
  return null;
}

/** Inbox items a client may see: never the operator's own (escalations, budget hits, test runs). */
const notOperatorItem = or(isNull(inboxItem.assigneeRole), ne(inboxItem.assigneeRole, "operator"));

/** A step_run's node id names its step: the id, or `${loop}:${index}:${childId}` in a loop. */
function stepOfNode(steps: (id: string) => Step | undefined, nodeId: string): Step | undefined {
  return steps(nodeId) ?? steps(nodeId.split(":").at(-1) ?? nodeId);
}

export const EXPORT_TABLES: readonly ExportTable[] = [
  {
    file: "services.csv",
    about: "The agents we run for you: their names and status (services.csv keeps its old name).",
    header: ["id", "name", "description", "status", "created_at"],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select()
        .from(agent)
        .where(
          and(
            eq(agent.tenantId, tenantId),
            eq(agent.kind, "client"),
            eq(agent.testCopy, false),
            after(agent.id, cursor),
          ),
        )
        .orderBy(agent.id)
        .limit(limit + 1);
      return paged(rows, limit, (a) => [
        a.id,
        a.serviceName ?? a.name,
        a.serviceDescription,
        a.runStatus,
        a.createdAt,
      ]);
    },
  },
  {
    file: "connections.csv",
    about:
      "Your connected tools: which system, the account, its status and what agents may do there. No logins or keys.",
    header: ["id", "system", "account", "status", "permissions", "last_sync_at", "created_at"],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select({
          id: connection.id,
          connector: connection.connector,
          account: connection.externalAccountId,
          status: connection.status,
          permissions: connection.permissions,
          lastSyncAt: connection.lastSyncAt,
          createdAt: connection.createdAt,
        })
        .from(connection)
        .where(and(eq(connection.tenantId, tenantId), after(connection.id, cursor)))
        .orderBy(connection.id)
        .limit(limit + 1);
      return paged(rows, limit, (c) => [
        c.id,
        c.connector,
        c.account,
        c.status,
        jsonCell(c.permissions),
        c.lastSyncAt,
        c.createdAt,
      ]);
    },
  },
  {
    file: "vendors.csv",
    about: "Vendors, with other names they go by and their ids in your tools.",
    header: ["id", "name", "other_names", "ids_in_your_tools", "created_at"],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select({
          id: vendor.id,
          name: vendor.name,
          aliases: vendor.aliases,
          externalRefs: vendor.externalRefs,
          createdAt: vendor.createdAt,
        })
        .from(vendor)
        .where(and(eq(vendor.tenantId, tenantId), after(vendor.id, cursor)))
        .orderBy(vendor.id)
        .limit(limit + 1);
      return paged(rows, limit, (v) => [
        v.id,
        v.name,
        v.aliases,
        jsonCell(v.externalRefs),
        v.createdAt,
      ]);
    },
  },
  {
    file: "transactions.csv",
    about: "Purchases, bills and vendor credits, from your tools and uploads.",
    header: [
      "id",
      "kind",
      "source",
      "id_in_source",
      "vendor_id",
      "vendor",
      "date",
      "total",
      "currency",
      "purchaser",
      "payment_type",
      "memo",
      "status",
      "created_at",
    ],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select({ t: transaction, vendorName: vendor.name })
        .from(transaction)
        .leftJoin(
          vendor,
          and(eq(vendor.id, transaction.vendorId), eq(vendor.tenantId, transaction.tenantId)),
        )
        .where(and(eq(transaction.tenantId, tenantId), after(transaction.id, cursor)))
        .orderBy(transaction.id)
        .limit(limit + 1);
      return paged(
        rows.map((r) => ({ ...r, id: r.t.id })),
        limit,
        ({ t, vendorName }) => [
          t.id,
          t.kind,
          t.connector,
          t.externalId,
          t.vendorId,
          vendorName,
          t.txnDate,
          t.total,
          t.currency,
          t.purchaserRef,
          t.paymentType,
          t.memo,
          t.status,
          t.createdAt,
        ],
      );
    },
  },
  {
    file: "transaction_lines.csv",
    about: "The lines of each transaction.",
    header: [
      "id",
      "transaction_id",
      "line",
      "type",
      "account",
      "item",
      "description",
      "quantity",
      "unit_price",
      "amount",
      "currency",
    ],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select({ l: transactionLine, currency: transaction.currency })
        .from(transactionLine)
        .innerJoin(
          transaction,
          and(
            eq(transaction.id, transactionLine.transactionId),
            eq(transaction.tenantId, transactionLine.tenantId),
          ),
        )
        .where(and(eq(transactionLine.tenantId, tenantId), after(transactionLine.id, cursor)))
        .orderBy(transactionLine.id)
        .limit(limit + 1);
      return paged(
        rows.map((r) => ({ ...r, id: r.l.id })),
        limit,
        ({ l, currency }) => [
          l.id,
          l.transactionId,
          l.lineNo,
          l.detailType,
          l.accountRef,
          l.itemRef,
          l.description,
          l.qty,
          l.unitPrice,
          l.amount,
          currency,
        ],
      );
    },
  },
  {
    file: "documents.csv",
    about:
      "Your documents (invoices, receipts and other files). `file` is where each one is in this export.",
    header: [
      "id",
      "file",
      "filename",
      "type",
      "size_bytes",
      "sha256",
      "pages",
      "source",
      "status",
      "transaction_id",
      "received_at",
      "details",
    ],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select()
        .from(document)
        .where(and(eq(document.tenantId, tenantId), after(document.id, cursor)))
        .orderBy(document.id)
        .limit(limit + 1);
      return paged(rows, limit, (d) => [
        d.id,
        documentPath(d),
        d.filename,
        d.mimeType,
        d.sizeBytes,
        d.sha256,
        d.pageCount,
        d.source,
        d.status,
        d.transactionId,
        d.receivedAt,
        jsonCell(d.meta),
      ]);
    },
  },
  {
    file: "document_readings.csv",
    about:
      "What was read from each document: vendor, invoice number and date, totals, and whether the totals add up. A document read again has a row per reading.",
    header: [
      "id",
      "document_id",
      "read_at",
      "header",
      "currency",
      "subtotal",
      "freight",
      "surcharges",
      "tax",
      "total",
      "lines_sum",
      "totals_match",
      "problems",
      "agent_version_id",
    ],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select()
        .from(docExtraction)
        .where(and(eq(docExtraction.tenantId, tenantId), after(docExtraction.id, cursor)))
        .orderBy(docExtraction.id)
        .limit(limit + 1);
      return paged(rows, limit, (e) => [
        e.id,
        e.documentId,
        e.createdAt,
        jsonCell(e.header),
        e.currency,
        e.subtotal,
        e.freight,
        jsonCell(e.surcharges),
        e.tax,
        e.total,
        e.linesSum,
        e.totalsMatch,
        e.problems,
        e.agentVersionId,
      ]);
    },
  },
  {
    file: "items.csv",
    about: "The line items read from documents: what was bought, how many, at what price.",
    header: [
      "id",
      "document_id",
      "reading_id",
      "line",
      "vendor_sku",
      "description",
      "quantity",
      "unit",
      "unit_price",
      "amount",
      "discount",
      "currency",
      "page",
    ],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select({
          l: docLine,
          documentId: docExtraction.documentId,
          currency: docExtraction.currency,
        })
        .from(docLine)
        .innerJoin(
          docExtraction,
          and(
            eq(docExtraction.id, docLine.extractionId),
            eq(docExtraction.tenantId, docLine.tenantId),
          ),
        )
        .where(and(eq(docLine.tenantId, tenantId), after(docLine.id, cursor)))
        .orderBy(docLine.id)
        .limit(limit + 1);
      return paged(
        rows.map((r) => ({ ...r, id: r.l.id })),
        limit,
        ({ l, documentId, currency }) => [
          l.id,
          documentId,
          l.extractionId,
          l.lineNo,
          l.vendorSku,
          l.rawDescription,
          l.qty,
          l.uomRaw,
          l.unitPrice,
          l.extPrice,
          l.discount,
          currency,
          l.page,
        ],
      );
    },
  },
  {
    file: "synced_records.csv",
    about:
      "Records as they came from your tools (QuickBooks items, bills and vendors, texts and the like), every version kept.",
    header: [
      "id",
      "connection_id",
      "system",
      "record_type",
      "id_in_system",
      "version",
      "synced_at",
      "deleted",
      "record",
    ],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select()
        .from(rawRecord)
        .where(and(eq(rawRecord.tenantId, tenantId), after(rawRecord.id, cursor)))
        .orderBy(rawRecord.id)
        .limit(limit + 1);
      return paged(rows, limit, (r) => [
        r.id,
        r.connectionId,
        r.connector,
        r.entityType,
        r.externalId,
        r.externalVersion,
        r.syncedAt,
        r.isDeleted,
        jsonCell(r.payload),
      ]);
    },
  },
  {
    file: "organizations.csv",
    about: "Your directory's organizations: vendors, customers, partners.",
    header: [
      "id",
      "name",
      "kinds",
      "website",
      "email",
      "phone",
      "address",
      "language",
      "notes",
      "ids_in_your_tools",
      "vendor_id",
      "source",
      "created_at",
      "updated_at",
    ],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select()
        .from(organization)
        .where(and(eq(organization.tenantId, tenantId), after(organization.id, cursor)))
        .orderBy(organization.id)
        .limit(limit + 1);
      return paged(rows, limit, (o) => [
        o.id,
        o.name,
        o.kinds,
        o.website,
        o.email,
        o.phone,
        jsonCell(o.address),
        o.language,
        o.notes,
        jsonCell(o.externalRefs),
        o.vendorId,
        o.source,
        o.createdAt,
        o.updatedAt,
      ]);
    },
  },
  {
    file: "contacts.csv",
    about: "Your directory's people, with their consent to be texted, called or emailed.",
    header: [
      "id",
      "name",
      "organization_id",
      "title",
      "relationship",
      "phone",
      "whatsapp",
      "email",
      "language",
      "preferred_channels",
      "timezone",
      "quiet_hours",
      "roles",
      "notes",
      "consent",
      "opted_out_at",
      "opt_out_source",
      "ids_in_your_tools",
      "source",
      "created_at",
      "updated_at",
    ],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select()
        .from(contact)
        .where(and(eq(contact.tenantId, tenantId), after(contact.id, cursor)))
        .orderBy(contact.id)
        .limit(limit + 1);
      return paged(rows, limit, (p) => [
        p.id,
        p.name,
        p.organizationId,
        p.title,
        p.relationship,
        p.phone,
        p.whatsapp,
        p.email,
        p.language,
        p.preferredChannels,
        p.timezone,
        jsonCell(p.quietHours),
        p.roles,
        p.notes,
        jsonCell(p.consent),
        p.optedOutAt,
        p.optOutSource,
        jsonCell(p.externalRefs),
        p.source,
        p.createdAt,
        p.updatedAt,
      ]);
    },
  },
  {
    file: "runs.csv",
    about:
      "Every run of your agents: which agent (the service columns) and version, when, and how it ended.",
    header: [
      "id",
      "service_id",
      "service",
      "agent_version_id",
      "agent_version",
      "workflow",
      "trigger",
      "status",
      "started_at",
      "finished_at",
      "created_at",
    ],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select({
          r: run,
          serviceName: agent.serviceName,
          agentName: agent.name,
          version: agentVersion.version,
        })
        .from(run)
        .innerJoin(agent, and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)))
        .leftJoin(
          agentVersion,
          and(eq(agentVersion.id, run.agentVersionId), eq(agentVersion.tenantId, run.tenantId)),
        )
        // Test runs are the operator's building, never the client's work.
        .where(and(eq(run.tenantId, tenantId), eq(run.mode, "live"), after(run.id, cursor)))
        .orderBy(run.id)
        .limit(limit + 1);
      return paged(
        rows.map((x) => ({ ...x, id: x.r.id })),
        limit,
        ({ r, serviceName, agentName, version }) => [
          r.id,
          r.agentId,
          serviceName ?? agentName,
          r.agentVersionId,
          version,
          r.workflowSlug,
          isPlainObject(r.trigger) && typeof r.trigger.type === "string" ? r.trigger.type : null,
          r.status,
          r.startedAt,
          r.finishedAt,
          r.createdAt,
        ],
      );
    },
  },
  {
    file: "steps.csv",
    about:
      "The steps of each run that your timeline shows, with their summary and the records they rest on.",
    header: ["id", "run_id", "step", "status", "summary", "sources", "started_at", "finished_at"],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select({ s: stepRun, versionId: run.agentVersionId, slug: run.workflowSlug })
        .from(stepRun)
        .innerJoin(run, and(eq(run.id, stepRun.runId), eq(run.tenantId, stepRun.tenantId)))
        .where(and(eq(stepRun.tenantId, tenantId), eq(run.mode, "live"), after(stepRun.id, cursor)))
        .orderBy(stepRun.id)
        .limit(limit + 1);
      // The bundle is read here only to know which steps the client's timeline shows and what it
      // calls them, as the portal's run view does; nothing of it is written to the export.
      const versionIds = [...new Set(rows.map((r) => r.versionId))];
      const bundles = new Map(
        versionIds.length === 0
          ? []
          : (
              await tx
                .select({ id: agentVersion.id, bundle: agentVersion.bundle })
                .from(agentVersion)
                .where(
                  and(eq(agentVersion.tenantId, tenantId), inArray(agentVersion.id, versionIds)),
                )
            ).map((v) => [v.id, v.bundle]),
      );
      return paged(
        rows.map((x) => ({ ...x, id: x.s.id })),
        limit,
        ({ s, versionId, slug }) => {
          const workflow = bundles.get(versionId)?.workflows.find((w) => w.slug === slug)?.workflow;
          const step = workflow
            ? stepOfNode((id) => findStep(workflow, id)?.step, s.nodeId)
            : undefined;
          // Unknown nodes (agent tasks, internal bookkeeping) and hidden steps stay out.
          if (!step || !isClientVisible(step)) return null;
          return [
            s.id,
            s.runId,
            clientLabel(step),
            s.status,
            s.summary,
            sourcesOf(s.output),
            s.startedAt,
            s.finishedAt,
          ];
        },
      );
    },
  },
  {
    file: "external_actions.csv",
    about:
      "Every change agents proposed or made in your tools: the record before, the change, the result, who approved it and when.",
    header: [
      "id",
      "run_id",
      "step_id",
      "agent_version_id",
      "connection_id",
      "system",
      "tool",
      "status",
      "approved_by",
      "approved_at",
      "executed_at",
      "created_at",
      "before",
      "change",
      "result",
      "error",
    ],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select({ a: externalAction, connector: connection.connector })
        .from(externalAction)
        .innerJoin(
          connection,
          and(
            eq(connection.id, externalAction.connectionId),
            eq(connection.tenantId, externalAction.tenantId),
          ),
        )
        .leftJoin(
          run,
          and(eq(run.id, externalAction.runId), eq(run.tenantId, externalAction.tenantId)),
        )
        .where(
          and(
            eq(externalAction.tenantId, tenantId),
            or(isNull(run.id), eq(run.mode, "live")),
            after(externalAction.id, cursor),
          ),
        )
        .orderBy(externalAction.id)
        .limit(limit + 1);
      const people = await emails(
        tx,
        rows.map((r) => r.a.approvedBy),
      );
      return paged(
        rows.map((x) => ({ ...x, id: x.a.id })),
        limit,
        ({ a, connector }) => [
          a.id,
          a.runId,
          a.stepRunId,
          a.agentVersionId,
          a.connectionId,
          connector,
          a.tool,
          a.status,
          by(people, a.approvedBy),
          a.approvedAt,
          a.executedAt,
          a.createdAt,
          jsonCell(a.before),
          jsonCell(a.input),
          jsonCell(a.result),
          jsonCell(a.error),
        ],
      );
    },
  },
  {
    file: "inbox_items.csv",
    about: "Your Desk: approvals, reviews and requests, and how each was resolved.",
    header: [
      "id",
      "kind",
      "title",
      "status",
      "run_id",
      "assigned_to",
      "resolved_by",
      "resolved_at",
      "due_at",
      "created_at",
      "details",
      "resolution",
    ],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select()
        .from(inboxItem)
        .where(and(eq(inboxItem.tenantId, tenantId), notOperatorItem, after(inboxItem.id, cursor)))
        .orderBy(inboxItem.id)
        .limit(limit + 1);
      const people = await emails(tx, [
        ...rows.map((r) => r.resolvedBy),
        ...rows.map((r) => r.assigneeUserId),
      ]);
      return paged(rows, limit, (i) => [
        i.id,
        i.kind,
        plainTitle(i),
        i.status,
        i.runId,
        i.assigneeUserId ? by(people, i.assigneeUserId) : i.assigneeRole,
        by(people, i.resolvedBy),
        i.resolvedAt,
        i.dueAt,
        i.createdAt,
        jsonCell(i.payload),
        jsonCell(i.resolution),
      ]);
    },
  },
  {
    file: "approvals.csv",
    about: "Each approval asked of your people: what, the decision, who made it and when.",
    header: ["id", "run_id", "title", "status", "decision", "decided_by", "decided_at"],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select()
        .from(inboxItem)
        .where(
          and(
            eq(inboxItem.tenantId, tenantId),
            inArray(inboxItem.kind, ["approval", "external_action"]),
            notOperatorItem,
            after(inboxItem.id, cursor),
          ),
        )
        .orderBy(inboxItem.id)
        .limit(limit + 1);
      const people = await emails(
        tx,
        rows.map((r) => r.resolvedBy),
      );
      return paged(rows, limit, (i) => [
        i.id,
        i.runId,
        plainTitle(i),
        i.status,
        decisionOf(i),
        by(people, i.resolvedBy),
        i.resolvedAt,
      ]);
    },
  },
  {
    file: "messages.csv",
    about:
      "Messages: what your agents posted for you, and texts, emails and calls with your contacts.",
    header: [
      "id",
      "thread_id",
      "thread",
      "from",
      "sender_id",
      "kind",
      "text",
      "message",
      "sources",
      "created_at",
    ],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select({ m: message, threadTitle: thread.title })
        .from(message)
        .innerJoin(
          thread,
          and(eq(thread.id, message.threadId), eq(thread.tenantId, message.tenantId)),
        )
        .where(
          and(
            eq(message.tenantId, tenantId),
            // DECISION: the messages a client sees (audience `client`) and the conversations with
            // its contacts (texts, emails, calls); the operator's own notes stay out.
            or(
              eq(message.audience, "client"),
              eq(message.senderType, "contact"),
              eq(thread.subjectType, "contact"),
            ),
            after(message.id, cursor),
          ),
        )
        .orderBy(message.id)
        .limit(limit + 1);
      const people = await emails(
        tx,
        rows.filter((r) => r.m.senderType === "user").map((r) => r.m.senderId),
      );
      return paged(
        rows.map((x) => ({ ...x, id: x.m.id })),
        limit,
        ({ m, threadTitle }) => [
          m.id,
          m.threadId,
          threadTitle,
          m.senderType,
          m.senderType === "user" ? by(people, m.senderId) : m.senderId,
          m.kind,
          isPlainObject(m.body) && typeof m.body.text === "string" ? m.body.text : null,
          jsonCell(m.body),
          m.sources,
          m.createdAt,
        ],
      );
    },
  },
  {
    file: "knowledge.csv",
    about: "Your knowledge base (FAQs and policies), every saved version of each entry.",
    header: [
      "entry_id",
      "version_id",
      "version",
      "kind",
      "title",
      "text",
      "status",
      "saved_by",
      "saved_by_role",
      "saved_at",
    ],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select({ v: knowledgeEntryVersion, kind: knowledgeEntry.kind })
        .from(knowledgeEntryVersion)
        .innerJoin(
          knowledgeEntry,
          and(
            eq(knowledgeEntry.id, knowledgeEntryVersion.entryId),
            eq(knowledgeEntry.tenantId, knowledgeEntryVersion.tenantId),
          ),
        )
        .where(
          and(
            eq(knowledgeEntryVersion.tenantId, tenantId),
            after(knowledgeEntryVersion.id, cursor),
          ),
        )
        .orderBy(knowledgeEntryVersion.id)
        .limit(limit + 1);
      const people = await emails(
        tx,
        rows.map((r) => r.v.authorId),
      );
      return paged(
        rows.map((x) => ({ ...x, id: x.v.id })),
        limit,
        ({ v, kind }) => [
          v.entryId,
          v.id,
          v.version,
          kind,
          v.title,
          v.body,
          v.status,
          by(people, v.authorId),
          v.authorRole,
          v.createdAt,
        ],
      );
    },
  },
  changeLog(
    "contact_changes.csv",
    "Every change to a contact: consent given or withdrawn, opt-outs, edits.",
    (tx, tenantId, cursor, limit) =>
      tx
        .select({
          id: contactChange.id,
          recordId: contactChange.contactId,
          change: contactChange.change,
          actorId: contactChange.actorId,
          createdAt: contactChange.createdAt,
        })
        .from(contactChange)
        .where(and(eq(contactChange.tenantId, tenantId), after(contactChange.id, cursor)))
        .orderBy(contactChange.id)
        .limit(limit + 1),
  ),
  changeLog(
    "organization_changes.csv",
    "Every change to an organization in your directory.",
    (tx, tenantId, cursor, limit) =>
      tx
        .select({
          id: organizationChange.id,
          recordId: organizationChange.organizationId,
          change: organizationChange.change,
          actorId: organizationChange.actorId,
          createdAt: organizationChange.createdAt,
        })
        .from(organizationChange)
        .where(and(eq(organizationChange.tenantId, tenantId), after(organizationChange.id, cursor)))
        .orderBy(organizationChange.id)
        .limit(limit + 1),
  ),
  changeLog(
    "connection_changes.csv",
    "Every change to a connection: connected, permissions changed, disconnected.",
    (tx, tenantId, cursor, limit) =>
      tx
        .select({
          id: connectionChange.id,
          recordId: connectionChange.connectionId,
          change: connectionChange.change,
          actorId: connectionChange.actorId,
          createdAt: connectionChange.createdAt,
        })
        .from(connectionChange)
        .where(and(eq(connectionChange.tenantId, tenantId), after(connectionChange.id, cursor)))
        .orderBy(connectionChange.id)
        .limit(limit + 1),
  ),
  {
    file: "account_changes.csv",
    about: "Changes we made to your account's settings, each with its reason.",
    header: ["id", "change", "reason", "changed_by", "changed_at"],
    async page(tx, tenantId, cursor, limit) {
      const rows = await tx
        .select()
        .from(tenantChange)
        .where(and(eq(tenantChange.tenantId, tenantId), after(tenantChange.id, cursor)))
        .orderBy(tenantChange.id)
        .limit(limit + 1);
      const people = await emails(
        tx,
        rows.map((r) => r.actorId),
      );
      return paged(rows, limit, (r) => [
        r.id,
        jsonCell(r.change),
        r.reason,
        by(people, r.actorId),
        r.createdAt,
      ]);
    },
  },
];

interface ChangeRow {
  id: string;
  recordId: string;
  change: unknown;
  actorId: string | null;
  createdAt: Date;
}

/** A change log (contact, organization, connection): one row per change, as recorded. */
function changeLog(
  file: string,
  about: string,
  read: (tx: Tx, tenantId: string, cursor: string | null, limit: number) => Promise<ChangeRow[]>,
): ExportTable {
  return {
    file,
    about,
    header: ["id", "record_id", "change", "changed_by", "changed_at"],
    async page(tx, tenantId, cursor, limit) {
      const rows = await read(tx, tenantId, cursor, limit);
      const people = await emails(
        tx,
        rows.map((r) => r.actorId),
      );
      return paged(rows, limit, (r) => [
        r.id,
        r.recordId,
        jsonCell(r.change),
        by(people, r.actorId),
        r.createdAt,
      ]);
    },
  };
}
