// R3: from a record to its runs (docs/reporting-plan.md §3 R3, docs/plan.md §1.194). The runs
// about one of a client's records, newest first, read from what each run kept (`run_subject`,
// §1.188), with what each did with it and the line of the step that did it. The portal reads only
// the rows its timeline shows (`client_visible`) of its live runs, and of the agents a limited
// person sees; it never carries cost, a bundle or instructions (invariant 11). Every query names
// the one client as well as relying on RLS (invariant 1).

import {
  RECORD_RUNS_LIMIT,
  type RecordRun,
  type RecordRunRole,
  type RunSubjectKind,
  subjectKindOfEntity,
} from "@countersign/core";
import {
  agent,
  contact,
  organization,
  rawRecord,
  receivable,
  run,
  runSubject,
  stepRun,
  type Tx,
  transaction,
  vendor,
} from "@countersign/db";
import { and, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { agentWhere } from "../assigned";
import { iso } from "../http";
import type { Platform } from "../platform";
import { clientWaits, OPEN_RUN } from "./client-status";
import { runSubjects } from "./subject";

/** A record as the client's tool knows it: the kinds a run may have kept it as, the tool and its id. */
interface ToolRef {
  kinds: readonly RunSubjectKind[];
  connector: string;
  externalId: string;
}

/** `{ qbo: "56" }` as tool refs of these kinds. */
function refsOf(kinds: readonly RunSubjectKind[], refs: unknown): ToolRef[] {
  if (refs === null || typeof refs !== "object" || Array.isArray(refs)) return [];
  return Object.entries(refs as Record<string, unknown>).flatMap(([connector, id]) =>
    typeof id === "string" && id !== "" ? [{ kinds, connector, externalId: id }] : [],
  );
}

/**
 * How the client's tools know the record with this id, if one of our tables holds it: a run's
 * change to a client's tool keeps the tool's id for the thing it wrote, not ours (§1.188).
 */
// DECISION: a change is matched to a record by its tool, its id there and a kind the record can
// be kept as, so a QuickBooks vendor 56 is never a bill 56. A document, a message and a pack's own
// record are matched by our id alone (docs/plan.md §1.194).
async function toolRefs(tx: Tx, tenantId: string, id: string): Promise<ToolRef[]> {
  const [txn] = await tx
    .select({ connector: transaction.connector, externalId: transaction.externalId })
    .from(transaction)
    .where(and(eq(transaction.tenantId, tenantId), eq(transaction.id, id)));
  if (txn) return [{ kinds: ["transaction"], ...txn }];
  const [rec] = await tx
    .select({ connector: receivable.connector, externalId: receivable.externalId })
    .from(receivable)
    .where(and(eq(receivable.tenantId, tenantId), eq(receivable.id, id)));
  if (rec) return [{ kinds: ["transaction"], ...rec }];
  const [raw] = await tx
    .select({
      connector: rawRecord.connector,
      externalId: rawRecord.externalId,
      entityType: rawRecord.entityType,
    })
    .from(rawRecord)
    .where(and(eq(rawRecord.tenantId, tenantId), eq(rawRecord.id, id)));
  if (raw) {
    return [
      {
        kinds: [subjectKindOfEntity(raw.entityType)],
        connector: raw.connector,
        externalId: raw.externalId,
      },
    ];
  }
  const [v] = await tx
    .select({ refs: vendor.externalRefs })
    .from(vendor)
    .where(and(eq(vendor.tenantId, tenantId), eq(vendor.id, id)));
  if (v) return refsOf(["vendor", "organization"], v.refs);
  const [o] = await tx
    .select({ refs: organization.externalRefs })
    .from(organization)
    .where(and(eq(organization.tenantId, tenantId), eq(organization.id, id)));
  if (o) return refsOf(["customer", "vendor", "organization"], o.refs);
  const [c] = await tx
    .select({ refs: contact.externalRefs })
    .from(contact)
    .where(and(eq(contact.tenantId, tenantId), eq(contact.id, id)));
  if (c) return refsOf(["person"], c.refs);
  return [];
}

/** A kept row about this record: by our id, or by the client's tool and its id there. */
function aboutRecord(id: string, refs: readonly ToolRef[]): SQL {
  return or(
    eq(runSubject.recordId, id),
    ...refs.map(
      (r) =>
        and(
          inArray(runSubject.kind, [...r.kinds]),
          eq(runSubject.connector, r.connector),
          eq(runSubject.externalId, r.externalId),
        ) as SQL,
    ),
  ) as SQL;
}

type Surface = "portal" | "ops";

/**
 * The runs about a record of one client, newest first. `agents` limits the portal to a limited
 * person's agents (null: every agent).
 */
export async function recordRuns(
  tx: Tx,
  tenantId: string,
  recordId: string,
  options: {
    surface: Surface;
    platform: Pick<Platform, "tools" | "connectors">;
    agents?: readonly string[] | null;
    limit?: number | undefined;
  },
): Promise<RecordRun[]> {
  const portal = options.surface === "portal";
  const id = recordId.toLowerCase();
  const about = aboutRecord(id, await toolRefs(tx, tenantId, id));
  const theirs = portal ? agentWhere(run.agentId, options.agents ?? null) : undefined;
  const rows = await tx
    .select({
      id: run.id,
      tenantId: run.tenantId,
      status: run.status,
      mode: run.mode,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      trigger: run.trigger,
      agentId: agent.id,
      agentName: agent.name,
      serviceName: agent.serviceName,
    })
    .from(run)
    .innerJoin(agent, and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)))
    .where(
      and(
        eq(run.tenantId, tenantId),
        // Test runs never reach the portal.
        ...(portal ? [eq(run.mode, "live")] : []),
        ...(theirs ? [theirs] : []),
        sql`exists (select 1 from ${runSubject}
          where ${runSubject.runId} = ${run.id} and ${runSubject.tenantId} = ${run.tenantId}
            ${portal ? sql`and ${runSubject.clientVisible}` : sql``}
            and ${about})`,
      ),
    )
    .orderBy(desc(run.createdAt), desc(run.id))
    .limit(options.limit ?? RECORD_RUNS_LIMIT);
  if (rows.length === 0) return [];
  const runIds = rows.map((r) => r.id);

  const [kept, subjects, waits] = await Promise.all([
    tx
      .select({
        runId: runSubject.runId,
        stepRunId: runSubject.stepRunId,
        role: runSubject.role,
        connector: runSubject.connector,
        summary: stepRun.summary,
      })
      .from(runSubject)
      .leftJoin(
        stepRun,
        and(eq(stepRun.id, runSubject.stepRunId), eq(stepRun.tenantId, runSubject.tenantId)),
      )
      .where(
        and(
          eq(runSubject.tenantId, tenantId),
          inArray(runSubject.runId, runIds),
          ...(portal ? [eq(runSubject.clientVisible, true)] : []),
          about,
        ),
      )
      .orderBy(runSubject.createdAt, runSubject.id),
    runSubjects(tx, [tenantId], rows, options.platform, { surface: options.surface }),
    portal ? clientWaits(tx, tenantId, runIds) : undefined,
  ]);

  // DECISION: one line per step and role (a step that read a vendor twice says so once); only a
  // change names its tool, and what started the run has no step line (docs/plan.md §1.194).
  const roles = new Map<string, RecordRunRole[]>();
  const seen = new Set<string>();
  for (const k of kept) {
    const connector = k.role === "changed" ? k.connector : null;
    const key = JSON.stringify([k.runId, k.stepRunId, k.role, connector]);
    if (seen.has(key)) continue;
    seen.add(key);
    const line: RecordRunRole = {
      role: k.role,
      connector,
      summary: k.stepRunId ? (k.summary ?? null) : null,
    };
    const list = roles.get(k.runId);
    if (list) list.push(line);
    else roles.set(k.runId, [line]);
  }

  return rows.map((r) => {
    const subject = subjects.get(r.id);
    const going = (OPEN_RUN as readonly string[]).includes(r.status);
    return {
      id: r.id,
      service: { id: r.agentId, name: r.serviceName ?? r.agentName },
      status: r.status,
      ...(portal ? {} : { mode: r.mode }),
      startedAt: iso(r.startedAt),
      finishedAt: iso(r.finishedAt),
      ...(portal
        ? {
            waitingOnYou:
              going && (r.status === "waiting" || (waits?.get(r.id)?.waitingOnYou ?? false)),
          }
        : {}),
      ...(subject ? { subject } : {}),
      roles: roles.get(r.id) ?? [],
    };
  });
}
