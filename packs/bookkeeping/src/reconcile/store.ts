// Reconciliations kept (docs/plan.md §1.80): each side built from its source (the bank feed, a
// step's figures such as QuickBooks' register or a statement read, or named bank transactions),
// the pair's last sign-off carried in, the engine run, and the result stored with its items and
// matches. Then the model's proposals and a person's decisions on the card, the residual worked
// out again after each, and the sign-off, only when explained.

import { dec, toNumeric } from "@countersign/core";
import type { Tx } from "@countersign/db";
import { and, asc, desc, eq, gt, inArray, lte, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { PackRefusal } from "../pack";
import {
  bankAccountLink,
  bankTxn,
  type ReconciliationLabel,
  type ReconciliationSide,
  reconciliation,
  reconciliationItem,
  reconciliationMatch,
} from "../schema";
import {
  DEFAULT_RECON_SETTINGS,
  type EngineLabel,
  type ReconItem,
  type ReconSettings,
  type ReconSide,
  reconcile,
} from "./engine";

const Money = z.string().regex(/^-?\d{1,12}(\.\d{1,4})?$/, "an amount, like -12.50");
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, yyyy-mm-dd");

export const GivenItem = z.object({
  id: z.string().min(1).max(200),
  date: Day.nullable().optional(),
  effect: Money,
  reference: z.string().max(200).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
});

/** Where a side's balance and items come from. */
export const SideInput = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("bank_feed"),
    accountLinkId: z.uuid(),
    /** `bankfeed.account.query`'s accounts: the account's current balance is read from them. */
    accounts: z.array(z.record(z.string(), z.unknown())).optional(),
    /** Or the account's balance today (`bookkeeping.reconcile.pairs` gives it). */
    current: Money.nullable().optional(),
    /** Or the balance as of the date, given. */
    balance: Money.optional(),
    label: z.string().max(100).optional(),
  }),
  z.object({
    source: z.literal("given"),
    label: z.string().min(1).max(100),
    opening: Money.nullable().optional(),
    closing: Money,
    items: z.array(GivenItem).max(2000),
  }),
  z.object({
    source: z.literal("records"),
    label: z.string().max(100).optional(),
    bankTxnIds: z.array(z.uuid()).min(1).max(200),
  }),
]);
export type SideInput = z.infer<typeof SideInput>;

export const ReconcileInput = z.object({
  a: SideInput,
  b: SideInput,
  /** The day both balances are as of; absent: the latest item's date. */
  asOf: Day.optional(),
  periodStart: Day.optional(),
  /** The same two sources over time; absent: worked out from the sides. */
  pairKey: z.string().min(1).max(300).optional(),
});
export type ReconcileInput = z.infer<typeof ReconcileInput>;

export interface Built {
  side: ReconSide;
  key: string;
  sources: string[];
  currency: string;
}

type LinkRow = typeof bankAccountLink.$inferSelect;
type TxnRow = typeof bankTxn.$inferSelect;

/** A bank transaction's effect on its account's balance: a card's balance is what it owes. */
function effectOf(t: Pick<TxnRow, "amount" | "direction">, link: Pick<LinkRow, "kind">): string {
  const a = dec(t.amount);
  const raises = link.kind === "card" ? t.direction === "out" : t.direction === "in";
  return toNumeric(raises ? a : a.negated());
}

const NOT_BOOKED: TxnRow["status"][] = ["pending", "removed"];

async function linkOf(tx: Tx, tenantId: string, id: string): Promise<LinkRow> {
  const [l] = await tx
    .select()
    .from(bankAccountLink)
    .where(and(eq(bankAccountLink.tenantId, tenantId), eq(bankAccountLink.id, id)));
  if (!l) throw new PackRefusal(`account ${id} isn't on this client's bank feed`);
  return l;
}

function asItem(t: TxnRow, link: LinkRow): ReconItem {
  return {
    ref: t.id,
    date: t.txnDate,
    effect: effectOf(t, link),
    reference: null,
    description: t.payee ?? t.description,
  };
}

export async function buildSide(
  tx: Tx,
  tenantId: string,
  input: SideInput,
  period: { start: string | null; asOf: string | null },
): Promise<Built> {
  if (input.source === "given") {
    const side: ReconSide = {
      label: input.label,
      opening: input.opening ?? null,
      closing: input.closing,
      items: input.items.map((i) => ({
        ref: i.id,
        date: i.date ?? null,
        effect: i.effect,
        reference: i.reference ?? null,
        description: i.description ?? null,
      })),
    };
    return {
      side,
      key: `given:${input.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      sources: input.items.map((i) => i.id),
      currency: "USD",
    };
  }
  if (input.source === "records") {
    const rows = await tx
      .select({ t: bankTxn, l: bankAccountLink })
      .from(bankTxn)
      .innerJoin(
        bankAccountLink,
        and(
          eq(bankAccountLink.id, bankTxn.accountLinkId),
          eq(bankAccountLink.tenantId, bankTxn.tenantId),
        ),
      )
      .where(and(eq(bankTxn.tenantId, tenantId), inArray(bankTxn.id, input.bankTxnIds)));
    if (rows.length !== new Set(input.bankTxnIds).size) {
      throw new PackRefusal("a bank transaction named isn't one of this client's");
    }
    const items = rows.map(({ t, l }) => asItem(t, l));
    const closing = toNumeric(items.reduce((s, i) => s.plus(dec(i.effect)), dec("0")));
    return {
      side: { label: input.label ?? "Bank transactions", opening: null, closing, items },
      key: `records:${[...input.bankTxnIds].sort().join(",")}`,
      sources: rows.map(({ t }) => t.rawRecordId),
      currency: rows[0]?.t.currency ?? "USD",
    };
  }
  // The bank feed: the account's posted transactions in the period, and its balance as of the day.
  const link = await linkOf(tx, tenantId, input.accountLinkId);
  const asOf = period.asOf;
  if (!asOf) throw new PackRefusal("say the day the bank's balance is as of (asOf)");
  const inPeriod = await tx
    .select()
    .from(bankTxn)
    .where(
      and(
        eq(bankTxn.tenantId, tenantId),
        eq(bankTxn.accountLinkId, link.id),
        notInArray(bankTxn.status, NOT_BOOKED),
        lte(bankTxn.txnDate, asOf),
        ...(period.start ? [sql`${bankTxn.txnDate} >= ${period.start}`] : []),
      ),
    )
    .orderBy(asc(bankTxn.txnDate), asc(bankTxn.id));
  let closing: string;
  if (input.balance !== undefined) {
    closing = input.balance;
  } else {
    const account = (input.accounts ?? []).find((a) => a.id === link.externalAccountId) as
      | { balances?: { current?: string | null } }
      | undefined;
    const current = input.current ?? account?.balances?.current;
    if (current === undefined || current === null) {
      throw new PackRefusal(
        `the bank feed gave no balance for ${link.name ?? "this account"}: pass bankfeed.account.query's accounts or a balance`,
      );
    }
    // DECISION (docs/plan.md §1.80): Plaid's balance is today's; what posted after the day is
    // taken off, so the balance is as of the day.
    const after = await tx
      .select()
      .from(bankTxn)
      .where(
        and(
          eq(bankTxn.tenantId, tenantId),
          eq(bankTxn.accountLinkId, link.id),
          notInArray(bankTxn.status, NOT_BOOKED),
          gt(bankTxn.txnDate, asOf),
        ),
      );
    closing = toNumeric(after.reduce((s, t) => s.minus(dec(effectOf(t, link))), dec(current)));
  }
  const items = inPeriod.map((t) => asItem(t, link));
  // DECISION: the feed's opening is its closing less the period's transactions (the feed is what
  // moved the balance); an item missing from the feed then shows in the residual.
  const opening = period.start
    ? toNumeric(items.reduce((s, i) => s.minus(dec(i.effect)), dec(closing)))
    : null;
  return {
    side: {
      label:
        input.label ?? [link.name, link.mask ? `…${link.mask}` : null].filter(Boolean).join(" "),
      opening,
      closing,
      items,
    },
    key: `bank:${link.id}`,
    sources: inPeriod.map((t) => t.rawRecordId),
    currency: inPeriod[0]?.currency ?? "USD",
  };
}

function settingsFrom(settings: Readonly<Record<string, unknown>>): ReconSettings {
  const n = (k: string, d: number, max: number) => {
    const v = Number(settings[k]);
    return Number.isFinite(v) && v >= 0 && v <= max ? Math.floor(v) : d;
  };
  const tol =
    typeof settings.tolerance === "string" && /^\d+(\.\d{1,4})?$/.test(settings.tolerance)
      ? settings.tolerance
      : DEFAULT_RECON_SETTINGS.tolerance;
  return {
    windowDays: n("window_days", DEFAULT_RECON_SETTINGS.windowDays, 60),
    tolerance: tol,
    maxGroup: Math.max(2, n("max_group", DEFAULT_RECON_SETTINGS.maxGroup, 10)),
    timingDays: n("timing_days", DEFAULT_RECON_SETTINGS.timingDays, 60),
  };
}

export interface Decider {
  tenantId: string;
  agentVersionId: string;
  runId: string | null;
}

function fmt(amount: string, currency: string): string {
  const d = dec(amount);
  const abs = d
    .abs()
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = d.isNegative() ? "−" : "";
  return currency === "USD" ? `${sign}$${abs}` : `${sign}${abs} ${currency}`;
}

const LABEL_WORDS: Record<EngineLabel, string> = {
  timing: "timing",
  missing: "only on one side",
  amount_differs: "amount differs",
  duplicate: "duplicate",
};

/** "Bank $1,000.00, QuickBooks $1,250.00, difference −$250.00: 1 item on QuickBooks (timing, …)". */
export function summaryOf(r: {
  aLabel: string;
  bLabel: string;
  aClosing: string;
  bClosing: string;
  difference: string;
  residual: string;
  outcome: string;
  currency: string;
  leftovers: { side: "a" | "b"; date: string | null; effect: string; label: EngineLabel | null }[];
}): string {
  const head = `${r.aLabel} ${fmt(r.aClosing, r.currency)}, ${r.bLabel} ${fmt(r.bClosing, r.currency)}, difference ${fmt(r.difference, r.currency)}`;
  if (r.outcome === "balanced") return `${head}: everything matches.`;
  const parts = r.leftovers
    .slice(0, 5)
    .map(
      (l) =>
        `${l.side === "a" ? r.aLabel : r.bLabel} ${fmt(l.effect, r.currency)}${l.date ? ` on ${l.date}` : ""} (${l.label ? LABEL_WORDS[l.label] : "to explain"})`,
    );
  const more = r.leftovers.length > 5 ? `; ${r.leftovers.length - 5} more` : "";
  const unexplained =
    r.outcome === "unexplained"
      ? ` ${fmt(r.residual, r.currency)} isn't explained by the items we have.`
      : "";
  return `${head}: ${r.leftovers.length} item${r.leftovers.length === 1 ? "" : "s"} left: ${parts.join("; ")}${more}.${unexplained}`;
}

export interface ReconcileOutput {
  recorded: boolean;
  reconciliationId: string | null;
  outcome: "balanced" | "explained" | "unexplained";
  summary: string;
  aLabel: string;
  bLabel: string;
  aClosing: string;
  bClosing: string;
  difference: string;
  residual: string;
  matched: number;
  leftovers: number;
  needsPerson: boolean;
  sources: string[];
}

/** Builds both sides, carries the pair's last sign-off in, runs the engine and keeps the result. */
export async function runReconciliation(
  tx: Tx,
  who: Decider,
  input: ReconcileInput,
  rawSettings: Readonly<Record<string, unknown>> = {},
  opts: { testRun?: boolean } = {},
): Promise<ReconcileOutput> {
  const settings = settingsFrom(rawSettings);
  const period = { start: input.periodStart ?? null, asOf: input.asOf ?? null };
  if (period.start && period.asOf && period.start > period.asOf) {
    throw new PackRefusal("the period starts after the day it is as of");
  }
  const a = await buildSide(tx, who.tenantId, input.a, period);
  const b = await buildSide(tx, who.tenantId, input.b, period);
  const asOf =
    period.asOf ??
    [...a.side.items, ...b.side.items]
      .map((i) => i.date)
      .filter((d): d is string => !!d)
      .sort()
      .at(-1) ??
    new Date().toISOString().slice(0, 10);
  const currency = a.currency;
  // Each side adds up before anything is compared (docs/plan.md §1.80).
  for (const [s, label] of [
    [a.side, "A"],
    [b.side, "B"],
  ] as const) {
    if (s.opening === null) continue;
    const gap = s.items
      .reduce((t, i) => t.plus(dec(i.effect)), dec(s.opening))
      .minus(dec(s.closing));
    if (!gap.isZero()) {
      throw new PackRefusal(
        `${s.label} doesn't add up: opening ${s.opening} and its items make ${toNumeric(dec(s.closing).plus(gap))}, not ${s.closing} (side ${label}); read it again or enter it by hand`,
      );
    }
  }
  const pairKey = input.pairKey ?? `${a.key}|${b.key}`;
  // The pair's last settled reconciliation before this day: its leftovers are carried in.
  // DECISION (docs/plan.md §1.80): settled is signed off, or balanced (nothing left to carry, so it
  // needs no person); an open one with leftovers isn't, so they are never carried unchecked.
  const [previous] = await tx
    .select()
    .from(reconciliation)
    .where(
      and(
        eq(reconciliation.tenantId, who.tenantId),
        eq(reconciliation.pairKey, pairKey),
        or(
          eq(reconciliation.status, "signed_off"),
          and(eq(reconciliation.status, "open"), eq(reconciliation.outcome, "balanced")),
        ),
        sql`${reconciliation.asOf} < ${asOf}`,
      ),
    )
    .orderBy(desc(reconciliation.asOf), desc(reconciliation.id))
    .limit(1);
  if (previous) {
    const carried = await tx
      .select()
      .from(reconciliationItem)
      .where(
        and(
          eq(reconciliationItem.tenantId, who.tenantId),
          eq(reconciliationItem.reconciliationId, previous.id),
          eq(reconciliationItem.state, "unmatched"),
        ),
      )
      .orderBy(asc(reconciliationItem.id));
    for (const c of carried) {
      const item: ReconItem = {
        ref: c.ref,
        date: c.txnDate,
        effect: c.effect,
        reference: c.reference,
        description: c.description,
        carried: true,
      };
      (c.side === "a" ? a.side : b.side).items.push(item);
    }
  }
  const result = reconcile(a.side, b.side, settings, asOf);
  const leftovers = [
    ...[...result.unmatched.a].map(([i, label]) => ({ side: "a" as const, i, label })),
    ...[...result.unmatched.b].map(([i, label]) => ({ side: "b" as const, i, label })),
  ];
  const itemOf = (side: "a" | "b", i: number) =>
    (side === "a" ? a.side : b.side).items[i] as ReconItem;
  const sources = [...a.sources, ...b.sources, ...(previous ? [previous.id] : [])];
  const summary = summaryOf({
    aLabel: a.side.label,
    bLabel: b.side.label,
    aClosing: a.side.closing,
    bClosing: b.side.closing,
    difference: result.difference,
    residual: result.residual,
    outcome: result.outcome,
    currency,
    leftovers: leftovers.map(({ side, i, label }) => ({
      side,
      date: itemOf(side, i).date,
      effect: itemOf(side, i).effect,
      label,
    })),
  });
  const out: Omit<ReconcileOutput, "recorded" | "reconciliationId"> = {
    outcome: result.outcome,
    summary,
    aLabel: a.side.label,
    bLabel: b.side.label,
    aClosing: toNumeric(dec(a.side.closing)),
    bClosing: toNumeric(dec(b.side.closing)),
    difference: result.difference,
    residual: result.residual,
    matched: result.matches.length,
    leftovers: leftovers.length,
    needsPerson: result.outcome !== "balanced",
    sources,
  };
  if (opts.testRun) return { ...out, recorded: false, reconciliationId: null };

  // A new run for the pair and day supersedes an open one.
  await tx
    .update(reconciliation)
    .set({ status: "superseded" })
    .where(
      and(
        eq(reconciliation.tenantId, who.tenantId),
        eq(reconciliation.pairKey, pairKey),
        eq(reconciliation.asOf, asOf),
        eq(reconciliation.status, "open"),
      ),
    );
  const [row] = await tx
    .insert(reconciliation)
    .values({
      tenantId: who.tenantId,
      pairKey,
      aLabel: a.side.label,
      bLabel: b.side.label,
      periodStart: period.start,
      asOf,
      currency,
      aOpening: a.side.opening,
      aClosing: a.side.closing,
      bOpening: b.side.opening,
      bClosing: b.side.closing,
      difference: result.difference,
      residual: result.residual,
      outcome: result.outcome,
      settings: { ...settings, startGap: result.startGap },
      carriedFromId: previous?.id ?? null,
      sources,
      agentVersionId: who.agentVersionId,
      runId: who.runId,
    })
    .returning({ id: reconciliation.id });
  if (!row) throw new Error("reconciliation not stored");
  const ids: Record<"a" | "b", string[]> = { a: [], b: [] };
  for (const sideKey of ["a", "b"] as const) {
    const s = sideKey === "a" ? a.side : b.side;
    const labels = result.unmatched[sideKey];
    for (let i = 0; i < s.items.length; i++) {
      const it = s.items[i] as ReconItem;
      const [made] = await tx
        .insert(reconciliationItem)
        .values({
          tenantId: who.tenantId,
          reconciliationId: row.id,
          side: sideKey,
          ref: it.ref,
          txnDate: it.date,
          effect: toNumeric(dec(it.effect)),
          description: it.description ?? null,
          reference: it.reference ?? null,
          carried: it.carried === true,
          state: labels.has(i) ? "unmatched" : "matched",
          label: labels.get(i) ?? null,
        })
        .returning({ id: reconciliationItem.id });
      ids[sideKey].push(made?.id ?? "");
    }
  }
  for (const m of result.matches) {
    await tx.insert(reconciliationMatch).values({
      tenantId: who.tenantId,
      reconciliationId: row.id,
      method: m.method,
      status: "accepted",
      aItemIds: m.a.map((i) => ids.a[i] as string),
      bItemIds: m.b.map((j) => ids.b[j] as string),
      confidence: "1.000",
      agentVersionId: who.agentVersionId,
      decidedAt: new Date(),
    });
  }
  return { ...out, recorded: true, reconciliationId: row.id };
}

// ── Reading one, and what the model and a person do with it ─────────────────────────────────────

export async function reconciliationOf(tx: Tx, tenantId: string, id: string) {
  const [r] = await tx
    .select()
    .from(reconciliation)
    .where(and(eq(reconciliation.tenantId, tenantId), eq(reconciliation.id, id)));
  if (!r) throw new PackRefusal(`reconciliation ${id} isn't one of this client's`);
  return r;
}

export async function reconciliationView(tx: Tx, tenantId: string, id: string) {
  const r = await reconciliationOf(tx, tenantId, id);
  const items = await tx
    .select()
    .from(reconciliationItem)
    .where(
      and(eq(reconciliationItem.tenantId, tenantId), eq(reconciliationItem.reconciliationId, id)),
    )
    .orderBy(
      asc(reconciliationItem.side),
      asc(reconciliationItem.txnDate),
      asc(reconciliationItem.id),
    );
  const matches = await tx
    .select()
    .from(reconciliationMatch)
    .where(
      and(eq(reconciliationMatch.tenantId, tenantId), eq(reconciliationMatch.reconciliationId, id)),
    )
    .orderBy(asc(reconciliationMatch.createdAt), asc(reconciliationMatch.id));
  const leftovers = items.filter((i) => i.state === "unmatched");
  return {
    id: r.id,
    pairKey: r.pairKey,
    aLabel: r.aLabel,
    bLabel: r.bLabel,
    periodStart: r.periodStart,
    asOf: r.asOf,
    currency: r.currency,
    aOpening: r.aOpening,
    aClosing: r.aClosing,
    bOpening: r.bOpening,
    bClosing: r.bClosing,
    difference: r.difference,
    residual: r.residual,
    outcome: r.outcome,
    status: r.status,
    signedOffAt: r.signedOffAt?.toISOString() ?? null,
    note: r.note,
    summary: summaryOf({
      aLabel: r.aLabel,
      bLabel: r.bLabel,
      aClosing: r.aClosing,
      bClosing: r.bClosing,
      difference: r.difference,
      residual: r.residual,
      outcome: r.outcome,
      currency: r.currency,
      leftovers: leftovers.map((i) => ({
        side: i.side,
        date: i.txnDate,
        effect: i.effect,
        label: i.label,
      })),
    }),
    items: items.map((i) => ({
      id: i.id,
      side: i.side,
      ref: i.ref,
      date: i.txnDate,
      effect: i.effect,
      description: i.description,
      reference: i.reference,
      carried: i.carried,
      addedByPerson: i.addedBy !== null,
      state: i.state,
      label: i.label,
    })),
    matches: matches.map((m) => ({
      id: m.id,
      method: m.method,
      status: m.status,
      aItemIds: m.aItemIds,
      bItemIds: m.bItemIds,
      confidence: m.confidence,
      reason: m.reason,
    })),
  };
}

function open(r: { status: string }) {
  if (r.status !== "open")
    throw new PackRefusal(`this reconciliation is ${r.status.replace("_", " ")} and can't change`);
}

/** The residual and outcome again, after the items' states changed. */
async function refresh(tx: Tx, tenantId: string, id: string): Promise<void> {
  const r = await reconciliationOf(tx, tenantId, id);
  const items = await tx
    .select()
    .from(reconciliationItem)
    .where(
      and(eq(reconciliationItem.tenantId, tenantId), eq(reconciliationItem.reconciliationId, id)),
    );
  const unmatched = items.filter((i) => i.state === "unmatched");
  const net = unmatched.reduce(
    (s, i) => (i.side === "a" ? s.plus(dec(i.effect)) : s.minus(dec(i.effect))),
    dec("0"),
  );
  const startGap = dec(String((r.settings as { startGap?: unknown }).startGap ?? "0"));
  const residual = dec(r.difference).minus(startGap).minus(net);
  const outcome = !residual.isZero()
    ? "unexplained"
    : dec(r.difference).isZero() && unmatched.length === 0
      ? "balanced"
      : "explained";
  await tx
    .update(reconciliation)
    .set({ residual: toNumeric(residual), outcome })
    .where(and(eq(reconciliation.tenantId, tenantId), eq(reconciliation.id, id)));
}

async function itemsIn(tx: Tx, tenantId: string, recId: string, ids: readonly string[]) {
  const rows = ids.length
    ? await tx
        .select()
        .from(reconciliationItem)
        .where(
          and(
            eq(reconciliationItem.tenantId, tenantId),
            eq(reconciliationItem.reconciliationId, recId),
            inArray(reconciliationItem.id, [...ids]),
          ),
        )
    : [];
  if (rows.length !== new Set(ids).size)
    throw new PackRefusal("an item named isn't part of this reconciliation");
  return rows;
}

/** The items each way add up to the same, within the reconciliation's tolerance; all unmatched. */
async function checkPair(
  tx: Tx,
  tenantId: string,
  r: typeof reconciliation.$inferSelect,
  aIds: readonly string[],
  bIds: readonly string[],
) {
  const a = await itemsIn(tx, tenantId, r.id, aIds);
  const b = await itemsIn(tx, tenantId, r.id, bIds);
  if (a.some((i) => i.side !== "a") || b.some((i) => i.side !== "b")) {
    throw new PackRefusal("name side A's items in aItemIds and side B's in bItemIds");
  }
  if ([...a, ...b].some((i) => i.state !== "unmatched"))
    throw new PackRefusal("an item named is already matched");
  const sa = a.reduce((s, i) => s.plus(dec(i.effect)), dec("0"));
  const sb = b.reduce((s, i) => s.plus(dec(i.effect)), dec("0"));
  const tol = dec(String((r.settings as { tolerance?: unknown }).tolerance ?? "0"));
  if (sa.minus(sb).abs().gt(tol)) {
    throw new PackRefusal(
      `these add up to ${toNumeric(sa)} and ${toNumeric(sb)}: not the same money`,
    );
  }
  return [...a, ...b];
}

async function setState(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
  state: "matched" | "unmatched",
) {
  if (ids.length === 0) return;
  await tx
    .update(reconciliationItem)
    .set({ state, ...(state === "matched" ? { label: null } : {}) })
    .where(
      and(eq(reconciliationItem.tenantId, tenantId), inArray(reconciliationItem.id, [...ids])),
    );
}

/** The model's proposed match for leftovers: kept as a proposal for a person, never accepted. */
export async function proposeMatch(
  tx: Tx,
  who: Decider,
  input: {
    reconciliationId: string;
    aItemIds: string[];
    bItemIds: string[];
    reason: string;
    confidence: number;
  },
): Promise<string> {
  const r = await reconciliationOf(tx, who.tenantId, input.reconciliationId);
  open(r);
  await checkPair(tx, who.tenantId, r, input.aItemIds, input.bItemIds);
  const [m] = await tx
    .insert(reconciliationMatch)
    .values({
      tenantId: who.tenantId,
      reconciliationId: r.id,
      method: "model",
      status: "proposed",
      aItemIds: input.aItemIds,
      bItemIds: input.bItemIds,
      confidence: Math.min(1, Math.max(0, input.confidence)).toFixed(3),
      reason: input.reason.slice(0, 500),
      agentVersionId: who.agentVersionId,
    })
    .returning({ id: reconciliationMatch.id });
  return m?.id ?? "";
}

export type PersonDecision =
  | { action: "accept"; input: { matchId: string } }
  | { action: "reject"; input: { matchId: string } }
  | {
      action: "match";
      input: { aItemIds: string[]; bItemIds: string[]; reason?: string | null | undefined };
    }
  | { action: "unmatch"; input: { matchId: string } }
  | { action: "label"; input: { itemId: string; label: ReconciliationLabel | null } }
  | {
      action: "add_item";
      input: {
        side: ReconciliationSide;
        date?: string | null | undefined;
        effect: string;
        description: string;
      };
    }
  | { action: "sign_off"; input: { note?: string | null | undefined } };

/** A person's decision on the card; the residual is worked out again after each. */
export async function decideReconciliation(
  tx: Tx,
  who: { tenantId: string; userId: string },
  reconciliationId: string,
  d: PersonDecision,
): Promise<void> {
  const r = await reconciliationOf(tx, who.tenantId, reconciliationId);
  open(r);
  const now = new Date();
  const matchOf = async (id: string) => {
    const [m] = await tx
      .select()
      .from(reconciliationMatch)
      .where(
        and(
          eq(reconciliationMatch.tenantId, who.tenantId),
          eq(reconciliationMatch.reconciliationId, r.id),
          eq(reconciliationMatch.id, id),
        ),
      );
    if (!m) throw new PackRefusal("that match isn't part of this reconciliation");
    return m;
  };
  if (d.action === "accept") {
    const m = await matchOf(d.input.matchId);
    if (m.status !== "proposed") throw new PackRefusal(`that match is ${m.status}`);
    await checkPair(tx, who.tenantId, r, m.aItemIds, m.bItemIds);
    await tx
      .update(reconciliationMatch)
      .set({ status: "accepted", userId: who.userId, decidedAt: now })
      .where(and(eq(reconciliationMatch.tenantId, who.tenantId), eq(reconciliationMatch.id, m.id)));
    await setState(tx, who.tenantId, [...m.aItemIds, ...m.bItemIds], "matched");
  } else if (d.action === "reject") {
    const m = await matchOf(d.input.matchId);
    if (m.status !== "proposed") throw new PackRefusal(`that match is ${m.status}`);
    await tx
      .update(reconciliationMatch)
      .set({ status: "rejected", userId: who.userId, decidedAt: now })
      .where(and(eq(reconciliationMatch.tenantId, who.tenantId), eq(reconciliationMatch.id, m.id)));
  } else if (d.action === "match") {
    await checkPair(tx, who.tenantId, r, d.input.aItemIds, d.input.bItemIds);
    await tx.insert(reconciliationMatch).values({
      tenantId: who.tenantId,
      reconciliationId: r.id,
      method: "person",
      status: "accepted",
      aItemIds: d.input.aItemIds,
      bItemIds: d.input.bItemIds,
      reason: d.input.reason?.slice(0, 500) ?? null,
      userId: who.userId,
      decidedAt: now,
    });
    await setState(tx, who.tenantId, [...d.input.aItemIds, ...d.input.bItemIds], "matched");
  } else if (d.action === "unmatch") {
    const m = await matchOf(d.input.matchId);
    if (m.status !== "accepted") throw new PackRefusal(`that match is ${m.status}`);
    await tx
      .update(reconciliationMatch)
      .set({ status: "rejected", userId: who.userId, decidedAt: now })
      .where(and(eq(reconciliationMatch.tenantId, who.tenantId), eq(reconciliationMatch.id, m.id)));
    await setState(tx, who.tenantId, [...m.aItemIds, ...m.bItemIds], "unmatched");
  } else if (d.action === "label") {
    const [item] = await itemsIn(tx, who.tenantId, r.id, [d.input.itemId]);
    if (item?.state !== "unmatched") throw new PackRefusal("only an unmatched item is labelled");
    await tx
      .update(reconciliationItem)
      .set({ label: d.input.label })
      .where(
        and(
          eq(reconciliationItem.tenantId, who.tenantId),
          eq(reconciliationItem.id, d.input.itemId),
        ),
      );
  } else if (d.action === "add_item") {
    // A person's own item: what one side is missing (a fee not yet in the books), in their words.
    await tx.insert(reconciliationItem).values({
      tenantId: who.tenantId,
      reconciliationId: r.id,
      side: d.input.side,
      ref: `person:${now.getTime()}`,
      txnDate: d.input.date ?? null,
      effect: toNumeric(dec(d.input.effect)),
      description: d.input.description.slice(0, 500),
      addedBy: who.userId,
      state: "unmatched",
      label: "missing",
    });
  } else {
    if (!dec(r.residual).isZero()) {
      throw new PackRefusal(
        `${r.residual} isn't explained yet: match the items, or add what one side is missing, before signing off`,
      );
    }
    await tx
      .update(reconciliation)
      .set({
        status: "signed_off",
        signedOffBy: who.userId,
        signedOffAt: now,
        note: d.input.note ?? null,
      })
      .where(and(eq(reconciliation.tenantId, who.tenantId), eq(reconciliation.id, r.id)));
    return;
  }
  await refresh(tx, who.tenantId, r.id);
}

/** Last month in UTC (the period a monthly run reconciles), or the month `month` (yyyy-mm). */
export function monthPeriod(today: Date, month?: string): { periodStart: string; asOf: string } {
  const [y, m] = month
    ? (month.split("-").map(Number) as [number, number])
    : [today.getUTCFullYear(), today.getUTCMonth()];
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return { periodStart: start.toISOString().slice(0, 10), asOf: end.toISOString().slice(0, 10) };
}
