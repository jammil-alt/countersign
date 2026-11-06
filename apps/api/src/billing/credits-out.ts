// When a month's included credits run out (ARCHITECTURE §11.5; docs/plan.md §1.50, W2-G). The
// client admin chooses in `tenant.settings.billing.onCreditsOut`: `continue` (the default: work
// goes on, extra credits are billed at the credit price as the statement already does, and the
// client admin is told each time another `creditBlock` credits, 2,500 by default, are used beyond
// the included ones) or `pause` (once the month's credits used reach the included credits, every
// billable agent but Sloan is paused with side `system`, reason `credits_out`, and the client
// admin is told). Choosing `continue`, or the first pass of the next month, resumes them. Checked
// on the hourly billing pass, inside the client's own scope (invariant 1). Nothing here bills:
// the statement's "Extra usage" line is the only charge for credits.

import {
  billingPeriod,
  buildStatement,
  CREDITS_BLOCK,
  type CreditsOutView,
  dedupeKeys,
  isPlainObject,
  notificationPath,
  type OnCreditsOut,
  OnCreditsOut as OnCreditsOutSchema,
  readPause,
  readTenantBilling,
  SUPERVISOR_SLUG,
  utcDayOf,
} from "@countersign/core";
import { agent, type Tx, tenant, tenantChange } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { pauseAgent, resumeAgent } from "../lifecycle/pause";
import { candidatesFor, enqueue } from "../notify/outbox";
import { clientPeople, tenantRow } from "../notify/people";
import {
  type AgentRow,
  type BillingConfig,
  billedDays,
  clientAgents,
  creditsBetween,
  isActive,
  type Pricing,
  priceOf,
  usageFrom,
} from "./ledger";

/** The pause reason a credits-out pause carries, so only those are resumed for credits. */
export const CREDITS_OUT_REASON = "credits_out";

export interface CreditsOutSettings {
  onCreditsOut: OnCreditsOut;
  creditBlock: number;
}

/** The client's choice and block size, read leniently from `tenant.settings.billing`. */
// DECISION: `creditBlock` is read from the settings when it is a positive whole number, else
// 2,500; no route sets it (ARCHITECTURE §11.5 names only the choice), so the operator sets it in
// the client's settings by hand when a client needs another size.
export function creditsOutSettings(settings: unknown): CreditsOutSettings {
  const billing = isPlainObject(settings) ? settings.billing : undefined;
  const raw = isPlainObject(billing) ? billing : {};
  const choice = OnCreditsOutSchema.safeParse(raw.onCreditsOut);
  const block = raw.creditBlock;
  return {
    onCreditsOut: choice.success ? choice.data : "continue",
    creditBlock:
      typeof block === "number" && Number.isInteger(block) && block > 0 ? block : CREDITS_BLOCK,
  };
}

/** Sloan, the account agent: never paused for credits. */
function isAccountAgent(a: AgentRow, pricing: Pick<Pricing, "platform"> | null): boolean {
  if (a.slug === SUPERVISOR_SLUG) return true;
  return !!a.templateId && pricing?.platform.get(a.templateId) === SUPERVISOR_SLUG;
}

const isCreditsPause = (a: AgentRow) => {
  const p = readPause(a.pause);
  return a.runStatus === "paused" && p?.side === "system" && p.reason === CREDITS_OUT_REASON;
};

const nameOf = (a: AgentRow) => a.serviceName ?? a.name;

/** The client's agents paused because credits ran out. */
async function creditsPaused(tx: Tx, tenantId: string): Promise<AgentRow[]> {
  const rows = await tx
    .select()
    .from(agent)
    .where(
      and(
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        eq(agent.testCopy, false),
        eq(agent.runStatus, "paused"),
      ),
    );
  return rows.filter(isCreditsPause);
}

/** Resumes credits-out pauses: all of them, or those made before `before` (an ISO time). */
async function resumeCreditsPauses(
  tx: Tx,
  tenantId: string,
  input: { before?: string; by: string | null; reason: string },
): Promise<string[]> {
  const resumed: string[] = [];
  for (const a of await creditsPaused(tx, tenantId)) {
    const at = readPause(a.pause)?.at ?? "";
    if (input.before !== undefined && at >= input.before) continue;
    await resumeAgent(tx, {
      tenantId,
      agentId: a.id,
      side: "system",
      by: input.by,
      reason: input.reason,
    });
    resumed.push(a.id);
  }
  return resumed;
}

/** What the portal shows of the choice. */
export async function creditsOutView(tx: Tx, tenantId: string): Promise<CreditsOutView> {
  const t = await tenantRow(tx, tenantId);
  const s = creditsOutSettings(t?.settings);
  return {
    onCreditsOut: s.onCreditsOut,
    creditBlock: s.creditBlock,
    pausedForCredits: (await creditsPaused(tx, tenantId)).map((a) => ({
      id: a.id,
      name: nameOf(a),
    })),
  };
}

/**
 * The client admin's choice, saved in `tenant.settings.billing.onCreditsOut` (other billing keys
 * untouched) and logged in the client's change log. Choosing `continue` resumes the services
 * paused for credits at once.
 */
export async function setCreditsOut(
  tx: Tx,
  input: { tenantId: string; choice: OnCreditsOut; by: string },
): Promise<CreditsOutView> {
  const t = await tenantRow(tx, input.tenantId);
  const from = creditsOutSettings(t?.settings).onCreditsOut;
  await tx
    .update(tenant)
    .set({
      settings: sql`jsonb_set(${tenant.settings}, '{billing}', coalesce(${tenant.settings} -> 'billing', '{}'::jsonb) || jsonb_build_object('onCreditsOut', ${input.choice}::text))`,
    })
    .where(eq(tenant.id, input.tenantId));
  if (from !== input.choice) {
    await tx.insert(tenantChange).values({
      tenantId: input.tenantId,
      actorId: input.by,
      change: { setting: "billing.onCreditsOut", from, to: input.choice },
      reason:
        input.choice === "pause"
          ? "Pause the services when the month's credits run out"
          : "Keep working and add credits when the month's credits run out",
    });
  }
  if (input.choice === "continue") {
    await resumeCreditsPauses(tx, input.tenantId, {
      by: input.by,
      reason: "the client chose to continue",
    });
  }
  return creditsOutView(tx, input.tenantId);
}

/** The month's credits so far against the included credits the month will have. */
export interface CreditsMonth {
  period: string;
  used: number;
  included: number;
  extra: number;
}

/**
 * The month so far: credits used from the start of the month (or set-up) through today, and the
 * pooled allowance as the statement will have it if the agents active now stay active to the
 * month's end (the days already billed, plus each active agent's remaining days at today's price).
 */
// DECISION: "the included credits" (ARCHITECTURE §11.5) are the month's pooled allowance as the
// statement will compute it (plan §1.32), projected to the month's end for the agents billable
// now. The allowance billed so far alone would pause a client on the 2nd of the month; the
// projection matches the statement exactly while nothing changes, and shrinks as agents pause.
export async function creditsMonth(
  tx: Tx,
  input: {
    tenantId: string;
    at: Date;
    config: BillingConfig;
    pricing: Pricing;
    settings: unknown;
  },
): Promise<CreditsMonth> {
  const today = utcDayOf(input.at);
  const { start, end } = billingPeriod(today);
  const days = await billedDays(tx, { tenantId: input.tenantId, period: start, through: today });
  const billed = new Set(days.map((d) => `${d.agentId}:${d.day}`));
  const active = (await clientAgents(tx, input.tenantId)).filter((r) => isActive(r.agent));
  const projected = [...days];
  for (let d = today; d <= end; d = nextDay(d)) {
    for (const { agent: a, override } of active) {
      if (billed.has(`${a.id}:${d}`)) continue;
      const p = priceOf(a, override, input.pricing);
      projected.push({
        agentId: a.id,
        agentName: nameOf(a),
        day: d,
        monthlyPrice: p.monthlyPrice,
        includedCredits: p.includedCredits,
      });
    }
  }
  const used = await creditsBetween(tx, {
    tenantId: input.tenantId,
    from: usageFrom(start, readTenantBilling(input.settings)),
    to: today,
    config: input.config,
  });
  const built = buildStatement({
    period: start,
    days: projected,
    creditsUsed: used.credits,
    creditPrice: input.config.settings.creditPrice,
  });
  return {
    period: start,
    used: built.creditsUsed,
    included: built.creditsIncluded,
    extra: built.extraCredits,
  };
}

const nextDay = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** The client admins' notifications for one credits block (0: the included credits ran out). */
async function notifyAdmins(
  tx: Tx,
  input: {
    tenantId: string;
    period: string;
    block: number;
    credits: number;
    origin: string;
    at: Date;
  },
): Promise<number> {
  const t = await tenantRow(tx, input.tenantId);
  if (!t || t.retiredAt) return 0;
  const admins = (await clientPeople(tx, t)).filter((p) => p.role === "client_admin");
  const month = input.period.slice(0, 7);
  const rows = await enqueue(
    tx,
    t.id,
    input.origin,
    admins.flatMap((p) =>
      candidatesFor(p, {
        kind: "credits",
        dedupeKey: dedupeKeys.credits(month, input.block, p.userId),
        path: notificationPath("credits"),
        counts: input.block === 0 ? { block: 0 } : { block: input.block, credits: input.credits },
      }),
    ),
    input.at,
  );
  return rows.length;
}

export interface CreditsOutResult {
  month: CreditsMonth;
  paused: string[];
  resumed: string[];
  notified: number;
}

/**
 * One client's credits check on the hourly billing pass: resume last month's credits-out pauses
 * (and every one when the client chose `continue`), work out the month so far, then pause and
 * tell (`pause`) or tell per block (`continue`). Notifications are queued once each by their
 * dedupe key (month, block, person); the notification pass sends them.
 */
export async function creditsOutPass(
  tx: Tx,
  input: {
    tenantId: string;
    at: Date;
    config: BillingConfig;
    pricing: Pricing;
    origin: string;
  },
): Promise<CreditsOutResult> {
  const t = await tenantRow(tx, input.tenantId);
  const s = creditsOutSettings(t?.settings);
  const periodStart = billingPeriod(utcDayOf(input.at)).start;
  // DECISION: "the first pass of a month" is any pass that finds a credits-out pause made before
  // this month began (UTC, as billing periods are), so a missed pass is caught up an hour later.
  const resumed = await resumeCreditsPauses(tx, input.tenantId, {
    ...(s.onCreditsOut === "continue" ? {} : { before: `${periodStart}T00:00:00.000Z` }),
    by: null,
    reason: s.onCreditsOut === "continue" ? "the client chose to continue" : "a new month",
  });
  const month = await creditsMonth(tx, { ...input, settings: t?.settings });
  const paused: string[] = [];
  let notified = 0;
  if (s.onCreditsOut === "pause") {
    // DECISION: while the month's credits are used up, every pass pauses the billable agents
    // still running (one made active since is paused too); Sloan stays on to help. An agent
    // already paused keeps its pause (and its side).
    if (month.included > 0 || month.used > 0) {
      if (month.used >= month.included) {
        for (const { agent: a } of await clientAgents(tx, input.tenantId)) {
          if (!isActive(a) || isAccountAgent(a, input.pricing)) continue;
          await pauseAgent(tx, {
            tenantId: input.tenantId,
            agentId: a.id,
            side: "system",
            by: null,
            reason: CREDITS_OUT_REASON,
            now: input.at,
          });
          paused.push(a.id);
        }
        notified += await notifyAdmins(tx, {
          tenantId: input.tenantId,
          period: month.period,
          block: 0,
          credits: 0,
          origin: input.origin,
          at: input.at,
        });
      }
    }
  } else {
    const block = Math.floor(month.extra / s.creditBlock);
    if (block >= 1) {
      // DECISION: one notification for the highest block reached; blocks crossed between two
      // passes are not sent one by one.
      notified += await notifyAdmins(tx, {
        tenantId: input.tenantId,
        period: month.period,
        block,
        credits: block * s.creditBlock,
        origin: input.origin,
        at: input.at,
      });
    }
  }
  return { month, paused, resumed, notified };
}
