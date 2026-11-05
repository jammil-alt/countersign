// The supervisor's writes (FindingsPort, docs/plan.md §1.28 "Reporting") over the database.
//
// A finding is an inbox item (kind `review`, subject `supervisor_finding`; no migration) whose
// payload carries the issue's fingerprint. Every open item about an issue carries it, whoever
// opened it (a stopped website login's own items do too), so an issue still open is never
// reported twice: seeing it again only counts it, and once the client's reminder time has passed
// (`tenant.settings.supervisor.reminderHours`, default 24) it is reminded instead. The client
// admin's item holds a title and plain steps in the client's language (core's findingText); the
// operator's holds the details and the supervisor's note. The daily summary is a `health.checked`
// event in the outbox, which a test run never writes.

import {
  clientLanguage,
  FINDING_SUBJECT,
  FINGERPRINT_KEY,
  findingText,
  isPlainObject,
  isUuid,
  type JsonObject,
  supervisorSettings,
} from "@countersign/core";
import { type Db, inboxItem, type Tx, tenant, withTenant } from "@countersign/db";
import { emit as emitEvent } from "@countersign/senses";
import { and, eq, gte, isNull, ne, or, sql } from "drizzle-orm";
import type { FindingItemStatus, FindingOutcome, FindingsPort } from "../tools/types";
import type { Emit } from "./external-actions";

/** What every finding's item keeps about the issue, under `payload.finding`. */
interface FindingState {
  kind: string;
  occurrences: number;
  lastSeenAt: string;
  reminders: number;
  remindedAt: string | null;
  /** The client admin's plain steps (client items only). */
  steps?: string[];
}

type Audience = "client_admin" | "operator";

async function settingsOf(tx: Tx, tenantId: string): Promise<Record<string, unknown>> {
  const [row] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  return row?.settings ?? {};
}

function stateOf(payload: unknown, kind: string, createdAt: Date): FindingState {
  const raw = isPlainObject(payload) && isPlainObject(payload.finding) ? payload.finding : {};
  return {
    kind: typeof raw.kind === "string" ? raw.kind : kind,
    occurrences: typeof raw.occurrences === "number" ? raw.occurrences : 1,
    lastSeenAt: typeof raw.lastSeenAt === "string" ? raw.lastSeenAt : createdAt.toISOString(),
    reminders: typeof raw.reminders === "number" ? raw.reminders : 0,
    remindedAt: typeof raw.remindedAt === "string" ? raw.remindedAt : null,
    ...(Array.isArray(raw.steps) ? { steps: raw.steps.filter((x) => typeof x === "string") } : {}),
  };
}

const isOperatorItem = (role: string | null) => role === "operator";

export function dbFindingsPort(db: Db, options: { emit?: Emit } = {}): FindingsPort {
  const emit: Emit =
    options.emit ??
    (async (tx, tenantId, e) => {
      await emitEvent(tx, {
        tenantId,
        type: e.type,
        subjectType: e.subjectType,
        subjectId: e.subjectId,
        payload: e.payload as Record<string, unknown>,
      });
    });

  return {
    report(tenantId, input, now) {
      return withTenant(db, tenantId, async (tx) => {
        // One issue at a time per client: two failures reported at once can't both open an item.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`finding:${tenantId}:${input.fingerprint}`}))`,
        );
        const settings = await settingsOf(tx, tenantId);
        const { reminderHours } = supervisorSettings(settings);
        const open = await tx
          .select()
          .from(inboxItem)
          .where(
            and(
              eq(inboxItem.tenantId, tenantId),
              eq(inboxItem.status, "open"),
              sql`${inboxItem.payload}->>${FINGERPRINT_KEY} = ${input.fingerprint}`,
            ),
          )
          .for("update");
        // Items people closed after the issue was last seen: that occurrence was dealt with.
        const closed = input.seenAt
          ? await tx
              .select({ id: inboxItem.id, assigneeRole: inboxItem.assigneeRole })
              .from(inboxItem)
              .where(
                and(
                  eq(inboxItem.tenantId, tenantId),
                  eq(inboxItem.status, "resolved"),
                  gte(inboxItem.resolvedAt, input.seenAt),
                  sql`${inboxItem.payload}->>${FINGERPRINT_KEY} = ${input.fingerprint}`,
                ),
              )
          : [];

        const touch = async (
          audience: Audience,
          make: () => { title: string; payload: JsonObject },
        ): Promise<{ itemId: string; status: FindingItemStatus }> => {
          const existing = open.find((i) =>
            audience === "operator"
              ? isOperatorItem(i.assigneeRole)
              : !isOperatorItem(i.assigneeRole),
          );
          if (existing) {
            const state = stateOf(existing.payload, input.kind, existing.createdAt);
            const since = Date.parse(state.remindedAt ?? existing.createdAt.toISOString());
            const due = now.getTime() - since >= reminderHours * 3_600_000;
            const next: FindingState = {
              ...state,
              occurrences: state.occurrences + 1,
              lastSeenAt: now.toISOString(),
              ...(due ? { reminders: state.reminders + 1, remindedAt: now.toISOString() } : {}),
            };
            await tx
              .update(inboxItem)
              .set({
                payload: sql`${inboxItem.payload} || ${JSON.stringify({ finding: next })}::jsonb`,
              })
              .where(and(eq(inboxItem.id, existing.id), eq(inboxItem.tenantId, tenantId)));
            return { itemId: existing.id, status: due ? "reminded" : "open" };
          }
          // DECISION: the daily check looks back a day; a failure in that day that a person has
          // already closed is not reported again (a new failure is, through its event).
          const done = closed.find((i) =>
            audience === "operator"
              ? isOperatorItem(i.assigneeRole)
              : !isOperatorItem(i.assigneeRole),
          );
          if (done) return { itemId: done.id, status: "resolved" };
          const { title, payload } = make();
          const [row] = await tx
            .insert(inboxItem)
            .values({
              tenantId,
              kind: "review",
              agentId: input.reporterAgentId,
              subjectType: FINDING_SUBJECT,
              subjectId: input.subjectId && isUuid(input.subjectId) ? input.subjectId : null,
              assigneeRole: audience,
              title: title.slice(0, 200),
              payload,
            })
            .returning({ id: inboxItem.id });
          if (!row) throw new Error("finding insert returned nothing");
          return { itemId: row.id, status: "opened" };
        };

        const fresh = (extra: Partial<FindingState> = {}): FindingState => ({
          kind: input.kind,
          occurrences: 1,
          lastSeenAt: now.toISOString(),
          reminders: 0,
          remindedAt: null,
          ...extra,
        });

        let client: FindingOutcome["client"] = null;
        if (input.client) {
          const params = input.client.params;
          client = await touch("client_admin", () => {
            const words = findingText(clientLanguage(settings) ?? "en", input.kind, params);
            // DECISION: the client admin's item carries the fingerprint, the kind and its plain
            // steps only: no ids beyond the fingerprint, no details, no note, no sources
            // (invariant 11; the contract test checks it).
            return {
              title: words.title,
              payload: {
                [FINGERPRINT_KEY]: input.fingerprint,
                finding: { ...fresh({ steps: words.steps }) } as unknown as JsonObject,
              },
            };
          });
        }
        const operator = await touch("operator", () => ({
          title: input.operator.title,
          payload: {
            [FINGERPRINT_KEY]: input.fingerprint,
            finding: fresh() as unknown as JsonObject,
            details: input.operator.details,
            note: input.operator.note,
            sources: input.sources,
          },
        }));
        return { fingerprint: input.fingerprint, client, operator };
      });
    },

    openClientFindings(tenantId) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(inboxItem)
          .where(
            and(
              eq(inboxItem.tenantId, tenantId),
              eq(inboxItem.status, "open"),
              sql`${inboxItem.payload}->>${FINGERPRINT_KEY} is not null`,
              or(isNull(inboxItem.assigneeRole), ne(inboxItem.assigneeRole, "operator")),
            ),
          );
        return row?.n ?? 0;
      });
    },

    settings(tenantId) {
      return withTenant(db, tenantId, (tx) => settingsOf(tx, tenantId));
    },

    summarize(tenantId, summary) {
      return withTenant(db, tenantId, async (tx) => {
        await emit(tx, tenantId, {
          type: "health.checked",
          subjectType: null,
          subjectId: null,
          payload: summary as unknown as JsonObject,
        });
      });
    },
  };
}
