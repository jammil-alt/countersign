// The portal's views and writes, for Sloan's account tools (ARCHITECTURE §9.8; docs/plan.md
// §1.47): `AccountViews` for packages/agents' account port. Every read is the portal's own query
// for the person asking (their role and, for the Desk, their own items), returned in the portal's
// own shapes; every write is the portal's own function, attributed to that person. Runs inside
// the port's client-scoped transaction (invariant 1).

import { AccountRefusal, type AccountScope, type AccountViews } from "@countersign/agents";
import {
  type AccountService,
  DESK_WORDS,
  isPlainObject,
  type Locale,
  oversightLine,
  ownerDid,
  ownerRole,
  readWhyApproval,
} from "@countersign/core";
import { areaOwner, inboxItem, oversightDecision, run, thread } from "@countersign/db";
import { and, desc, eq, gte, inArray, type SQL, sql } from "drizzle-orm";
import { HttpError, notFound } from "../http";
import { controllableAgents, pauseAgent, resumeAgent, serviceControl } from "../lifecycle/pause";
import { processesOf } from "../owners/store";
import type { Platform } from "../platform";
import { tenantLocale } from "../routes/language";
import {
  portalInboxFilter,
  portalItems,
  portalRunView,
  runSummaries,
  snoozedNow,
} from "../routes/portal";
import { raiseRequest } from "../routes/requests";
import { clientDescription } from "../weekly/stats";
import { draftAccountChange } from "./changes";

const ACTIVE_RUN = ["queued", "running", "waiting"] as const;

async function localeOf(s: AccountScope): Promise<Locale> {
  return s.call.language ?? tenantLocale(s.tx, s.tenantId);
}

/** The asker's Desk filter: their role, and their own items for a client user. */
function deskFilter(s: AccountScope): SQL {
  return portalInboxFilter(s.asker.role, s.asker.userId ?? "");
}

/** A service of this client that the asker's controls show, never Sloan itself. */
async function controllable(s: AccountScope, serviceId: string) {
  if (serviceId === s.call.agentId) {
    throw new AccountRefusal("Sloan doesn't pause or resume itself: ask your lead");
  }
  const rows = await controllableAgents(s.tx, s.tenantId);
  const row = rows.find((a) => a.id === serviceId);
  if (!row) throw notFound("service");
  return row;
}

/** An error the portal would answer with, as words for the model to pass on. */
function refusalOf(error: unknown): never {
  if (error instanceof HttpError) throw new AccountRefusal(error.message);
  throw error;
}

export function accountViews(platform: Platform): AccountViews {
  return {
    async services(s) {
      const rows = await controllableAgents(s.tx, s.tenantId);
      const out: AccountService[] = [];
      for (const a of rows) {
        const [current] = await runSummaries(
          s.tx,
          s.tenantId,
          [eq(run.agentId, a.id), inArray(run.status, [...ACTIVE_RUN])],
          1,
        );
        out.push({
          ...serviceControl(a),
          description: clientDescription(a),
          current: current ?? null,
        });
      }
      return out;
    },

    runs(s, query) {
      const where: SQL[] = [];
      if (query.serviceId) where.push(eq(run.agentId, query.serviceId));
      if (query.status) where.push(eq(run.status, query.status));
      return runSummaries(s.tx, s.tenantId, where, query.limit, platform);
    },

    run(s, runId) {
      return portalRunView(s.tx, s.tenantId, runId, platform);
    },

    async waiting(s, input) {
      const rows = await s.tx
        .select()
        .from(inboxItem)
        .where(
          and(
            eq(inboxItem.tenantId, s.tenantId),
            eq(inboxItem.status, "open"),
            deskFilter(s),
            snoozedNow(false),
          ),
        )
        .orderBy(desc(inboxItem.createdAt))
        .limit(input.limit);
      return portalItems(s.tx, rows, platform);
    },

    async explainWait(s, itemId) {
      const [item] = await s.tx
        .select()
        .from(inboxItem)
        .where(and(eq(inboxItem.id, itemId), eq(inboxItem.tenantId, s.tenantId), deskFilter(s)));
      if (!item) throw notFound("item");
      const [shown] = await portalItems(s.tx, [item], platform);
      const words = DESK_WORDS[await localeOf(s)];
      const why = readWhyApproval(
        isPlainObject(item.payload) ? item.payload.whyApproval : undefined,
      );
      return {
        item: { id: item.id, title: shown?.title ?? item.title, status: item.status },
        reasons: (why?.reasons ?? []).map((code) => ({
          code,
          words:
            code === "stage"
              ? why?.stage === "signoff"
                ? words.stage.signoff
                : words.stage.trial
              : words.why[code],
        })),
        stage: why?.stage ?? null,
        byRule:
          why?.route?.source === "rule" ? { ruleId: why.route.ruleId, words: words.byRule } : null,
      };
    },

    async pause(s, input) {
      const row = await controllable(s, input.serviceId);
      if (row.runStatus === "paused") {
        return { status: "already_paused", service: serviceControl(row) };
      }
      const updated = await pauseAgent(s.tx, {
        tenantId: s.tenantId,
        agentId: row.id,
        side: "client",
        by: s.asker.userId,
        reason: input.reason,
        until: input.until,
      }).catch(refusalOf);
      return { status: "paused", service: serviceControl(updated) };
    },

    async resume(s, input) {
      const row = await controllable(s, input.serviceId);
      if (row.runStatus !== "paused") return { status: "not_paused", service: serviceControl(row) };
      const updated = await resumeAgent(s.tx, {
        tenantId: s.tenantId,
        agentId: row.id,
        side: "client",
        by: s.asker.userId,
      }).catch(refusalOf);
      return { status: "resumed", service: serviceControl(updated) };
    },

    async draftChange(s, input) {
      return draftAccountChange(
        {
          tx: s.tx,
          tenantId: s.tenantId,
          asker: s.asker,
          agentId: s.call.agentId,
          agentVersionId: s.call.agentVersionId,
          runId: s.call.runId,
          locale: await localeOf(s),
          platform,
        },
        input,
      ).catch(refusalOf);
    },

    async passToLead(s, input) {
      const row = await raiseRequest(s.tx, s.tenantId, {
        text: input.text,
        subject: input.subject,
        serviceId: input.serviceId,
        raisedBy: s.asker.userId as string,
        // Linked to the conversation (ARCHITECTURE §9.8), and marked as Sloan's.
        extra: {
          via: "account_agent",
          kind: input.kind,
          threadId: s.asker.threadId,
          runId: s.call.runId,
          agentVersionId: s.call.agentVersionId,
          sources: input.sources,
        },
      }).catch(refusalOf);
      return { status: "passed", requestId: row.id };
    },
    // v0.17 (§10.15 "Talking to an owner"): an owner by its name, with its area's services.
    async owner(s, name) {
      // With no name: the owner this conversation is with (the account thread's subject).
      let subject: string | null = null;
      if (!name && s.asker.threadId) {
        const [t] = await s.tx
          .select({ subjectId: thread.subjectId })
          .from(thread)
          .where(and(eq(thread.id, s.asker.threadId), eq(thread.tenantId, s.tenantId)));
        subject = t?.subjectId ?? null;
        if (!subject) return null;
      }
      if (!name && !subject) return null;
      const [o] = await s.tx
        .select({ id: areaOwner.id, name: areaOwner.name, area: areaOwner.area })
        .from(areaOwner)
        .where(
          and(
            eq(areaOwner.tenantId, s.tenantId),
            subject
              ? eq(areaOwner.id, subject)
              : sql`lower(${areaOwner.name}) = ${(name ?? "").trim().replace(/^@/, "").toLowerCase()}`,
          ),
        );
      if (!o) return null;
      const locale = await tenantLocale(s.tx, s.tenantId);
      const mine = (await processesOf(s.tx, s.tenantId, platform)).filter((p) => p.area === o.area);
      const services = mine.map((p) => ({ id: p.agentId, name: p.name }));
      // What it did lately: its decisions on its processes' runs, in the portal's words.
      const ids = mine.map((p) => p.agentId);
      const since = new Date(Date.now() - 14 * 86_400_000);
      const decided = ids.length
        ? await s.tx
            .select({ action: oversightDecision.action, at: oversightDecision.createdAt })
            .from(oversightDecision)
            .innerJoin(
              run,
              and(
                eq(run.id, oversightDecision.runId),
                eq(run.tenantId, oversightDecision.tenantId),
              ),
            )
            .where(
              and(
                eq(oversightDecision.tenantId, s.tenantId),
                inArray(run.agentId, ids),
                eq(run.mode, "live"),
                gte(oversightDecision.createdAt, since),
              ),
            )
            .orderBy(desc(oversightDecision.createdAt))
            .limit(10)
        : [];
      return {
        ...o,
        role: ownerRole(locale, o.area),
        services,
        recent: decided.map(
          (d) =>
            `${d.at.toISOString().slice(0, 10)}: ${ownerDid(locale, o.name, oversightLine(locale, { action: d.action }))}`,
        ),
      };
    },
  };
}
