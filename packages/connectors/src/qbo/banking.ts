// B-4 (docs/plan.md §1.79): booking a bank or card transaction in QuickBooks. `qbo.purchase.create`
// (an expense, check or card charge; a card refund with `credit`), `qbo.deposit.create` and
// `qbo.transfer.create`. Each is a write behind approval like every other (invariant 8), with no
// prior state. Each carries a `reference` (the booking's) in its private note: a record there with
// it is this action's own earlier write (reported done, not made again); one with the same account,
// date and amount without it was entered by someone else, and the write is refused as a duplicate.

import { CurrencyCode, DecimalString, dec, type ToolDisplay } from "@countersign/core";
import { z } from "zod";
import { defineWriteTool, type ToolContext, type ToolDefinition } from "../connector";
import { QboApiError, type QboClient, qboLiteral, qboRequestId } from "./api";
import { QboId, toAccount, wire } from "./records";
import {
  type ClientFor,
  IsoDate,
  lineRefsProblem,
  NewLine,
  QBO_STAND_IN,
  QboTotalWouldChangeError,
  sum,
  wireLine,
} from "./tool-kit";

export const BANKING_TOOLS = {
  purchaseCreate: "qbo.purchase.create",
  depositCreate: "qbo.deposit.create",
  transferCreate: "qbo.transfer.create",
} as const;

/** The marker in a private note that names the booking a record was written for. */
export function referenceMark(reference: string): string {
  return `[Mezonas ${reference}]`;
}

const Reference = z
  .string()
  .regex(/^[A-Za-z0-9-]{4,40}$/, "a reference: 4 to 40 letters, digits or dashes");

function note(memo: string | undefined, reference: string): string {
  return [memo?.trim(), referenceMark(reference)].filter(Boolean).join(" ").slice(0, 4000);
}

/** A record refused because one like it is already in QuickBooks. */
export class QboDuplicateBankingError extends QboApiError {
  constructor(message: string) {
    super(409, "DUPLICATE", message, false);
    this.name = "QboDuplicateBankingError";
  }
}

const MONEY_TYPES = new Set(["Bank", "Credit Card"]);

/** An account of the company, active, or a refusal; `money` asks for a bank or card account. */
async function companyAccount(
  client: QboClient,
  id: string,
  opts: { money?: boolean } = {},
): Promise<{ id: string; name: string; type: string | null }> {
  const raw = await client.read("Account", id);
  const a = raw ? toAccount(raw) : null;
  if (!a?.active) {
    throw new QboApiError(
      422,
      "UNKNOWN_ACCOUNT",
      `account ${id} isn't one of this company's active accounts`,
      false,
    );
  }
  if (opts.money && !MONEY_TYPES.has(a.accountType ?? "")) {
    throw new QboApiError(
      422,
      "NOT_A_BANK_ACCOUNT",
      `${a.fullyQualifiedName} isn't a bank or card account`,
      false,
    );
  }
  return { id: a.id, name: a.fullyQualifiedName, type: a.accountType };
}

function totalProblem(lines: { amount: string }[], expected: string): QboApiError | null {
  const total = sum(lines.map((l) => l.amount));
  if (!dec(total).equals(dec(expected))) {
    return new QboTotalWouldChangeError(
      `the lines add up to ${total}, not the ${expected} expected`,
    );
  }
  if (!dec(expected).greaterThan(0)) {
    return new QboApiError(422, "EMPTY", "the amount must be more than zero", false);
  }
  return null;
}

interface Found {
  id: string;
  syncToken: string;
  total: string;
  ours: boolean;
}

/** Records of `entity` on that day whose account and total match; `ours` when they carry the mark. */
async function sameDay(
  client: QboClient,
  entity: "Purchase" | "Deposit" | "Transfer",
  txnDate: string,
  match: (row: Record<string, unknown>) => boolean,
  amountOf: (row: Record<string, unknown>) => unknown,
  reference: string,
): Promise<Found[]> {
  // UNCHECKED (NOTES.md): `TxnDate =` filters Purchase, Deposit and Transfer.
  const { rows } = await client.query(
    `select * from ${entity} where TxnDate = ${qboLiteral(txnDate)} maxresults 1000`,
    entity,
  );
  const mark = referenceMark(reference);
  return rows
    .map((r) => r as Record<string, unknown>)
    .filter(match)
    .map((r) => ({
      id: String(r.Id),
      syncToken: String(r.SyncToken ?? "0"),
      total: dec(String(amountOf(r) ?? 0)).toFixed(4),
      ours: String(r.PrivateNote ?? "").includes(mark),
    }));
}

/** What a retried write finds and does: done if ours is there, refused if someone else's is. */
function settleFound(found: Found[], expected: string, what: string, retry: boolean): Found | null {
  const same = found.filter((f) => dec(f.total).equals(dec(expected)));
  const ours = same.find((f) => f.ours);
  if (ours) {
    if (retry) return ours;
    throw new QboDuplicateBankingError(
      `${what} for this booking is already in QuickBooks (${ours.id})`,
    );
  }
  const theirs = same.find((f) => !f.ours);
  if (theirs) {
    throw new QboDuplicateBankingError(
      `${what} for the same account, day and amount is already in QuickBooks (${theirs.id}); match it instead`,
    );
  }
  return null;
}

const Created = z.object({
  id: z.string(),
  syncToken: z.string(),
  total: DecimalString,
  alreadyDone: z.boolean(),
});

const Before = z.object({
  account: z.object({ id: z.string(), name: z.string() }),
  names: z.object({ accounts: z.record(z.string(), z.string()) }),
});

// ── How each reads on an approval card ───────────────────────────────────────────────────────────

const L = {
  date: { en: "Date", es: "Fecha", fr: "Date", "pt-BR": "Data", it: "Data", de: "Datum" },
  account: {
    en: "Account",
    es: "Cuenta",
    fr: "Compte",
    "pt-BR": "Conta",
    it: "Conto",
    de: "Konto",
  },
  lines: {
    en: "Lines",
    es: "Líneas",
    fr: "Lignes",
    "pt-BR": "Linhas",
    it: "Righe",
    de: "Positionen",
  },
  total: { en: "Total", es: "Total", fr: "Total", "pt-BR": "Total", it: "Totale", de: "Gesamt" },
  memo: { en: "Memo", es: "Nota", fr: "Note", "pt-BR": "Observação", it: "Nota", de: "Notiz" },
  from: { en: "From", es: "Desde", fr: "De", "pt-BR": "De", it: "Da", de: "Von" },
  to: { en: "To", es: "Hacia", fr: "Vers", "pt-BR": "Para", it: "A", de: "An" },
  amount: {
    en: "Amount",
    es: "Importe",
    fr: "Montant",
    "pt-BR": "Valor",
    it: "Importo",
    de: "Betrag",
  },
};

const lineColumns = {
  description: "description",
  amount: "amount",
  refs: [{ key: "accountId", names: "accounts" }],
};

export const purchaseCreateDisplay: ToolDisplay = {
  name: {
    en: "QuickBooks expense",
    es: "Gasto de QuickBooks",
    fr: "Dépense QuickBooks",
    "pt-BR": "Despesa do QuickBooks",
    it: "Spesa QuickBooks",
    de: "QuickBooks-Ausgabe",
  },
  description: {
    en: "Book this bank or card transaction in QuickBooks. Nothing else changes.",
    es: "Registra este movimiento del banco o la tarjeta en QuickBooks. Nada más cambia.",
    fr: "Enregistre cette opération bancaire ou de carte dans QuickBooks. Rien d'autre ne change.",
    "pt-BR": "Lança esta transação do banco ou do cartão no QuickBooks. Nada mais muda.",
    it: "Registra questo movimento della banca o della carta in QuickBooks. Nient'altro cambia.",
    de: "Bucht diese Bank- oder Kartenbuchung in QuickBooks. Sonst ändert sich nichts.",
  },
  subject: "before.account",
  names: "before.names",
  fields: [
    { label: L.date, kind: "date", after: "input.txnDate" },
    {
      label: L.lines,
      kind: "lines",
      after: "input.lines",
      currencyPath: "input.currency",
      columns: lineColumns,
    },
    {
      label: L.total,
      kind: "money",
      after: "input.expectedTotal",
      currencyPath: "input.currency",
      currency: "USD",
    },
    { label: L.memo, kind: "text", after: "input.privateNote" },
  ],
};

export const depositCreateDisplay: ToolDisplay = {
  name: {
    en: "QuickBooks deposit",
    es: "Depósito de QuickBooks",
    fr: "Dépôt QuickBooks",
    "pt-BR": "Depósito do QuickBooks",
    it: "Deposito QuickBooks",
    de: "QuickBooks-Einzahlung",
  },
  description: {
    en: "Book this money in as a deposit in QuickBooks. Nothing else changes.",
    es: "Registra este ingreso como depósito en QuickBooks. Nada más cambia.",
    fr: "Enregistre cette entrée d'argent comme dépôt dans QuickBooks. Rien d'autre ne change.",
    "pt-BR": "Lança esta entrada como depósito no QuickBooks. Nada mais muda.",
    it: "Registra questa entrata come deposito in QuickBooks. Nient'altro cambia.",
    de: "Bucht diesen Eingang als Einzahlung in QuickBooks. Sonst ändert sich nichts.",
  },
  subject: "before.account",
  names: "before.names",
  fields: [
    { label: L.date, kind: "date", after: "input.txnDate" },
    {
      label: L.lines,
      kind: "lines",
      after: "input.lines",
      currencyPath: "input.currency",
      columns: lineColumns,
    },
    {
      label: L.total,
      kind: "money",
      after: "input.expectedTotal",
      currencyPath: "input.currency",
      currency: "USD",
    },
    { label: L.memo, kind: "text", after: "input.privateNote" },
  ],
};

export const transferCreateDisplay: ToolDisplay = {
  name: {
    en: "QuickBooks transfer",
    es: "Transferencia de QuickBooks",
    fr: "Virement QuickBooks",
    "pt-BR": "Transferência do QuickBooks",
    it: "Trasferimento QuickBooks",
    de: "QuickBooks-Umbuchung",
  },
  description: {
    en: "Book this move of money between two of your accounts in QuickBooks. Nothing else changes.",
    es: "Registra este movimiento entre dos de sus cuentas en QuickBooks. Nada más cambia.",
    fr: "Enregistre ce virement entre deux de vos comptes dans QuickBooks. Rien d'autre ne change.",
    "pt-BR": "Lança esta transferência entre duas das suas contas no QuickBooks. Nada mais muda.",
    it: "Registra questo trasferimento tra due dei tuoi conti in QuickBooks. Nient'altro cambia.",
    de: "Bucht diese Umbuchung zwischen zwei Ihrer Konten in QuickBooks. Sonst ändert sich nichts.",
  },
  fields: [
    { label: L.date, kind: "date", after: "input.txnDate" },
    { label: L.from, kind: "ref", after: "before.from" },
    { label: L.to, kind: "ref", after: "before.to" },
    { label: L.amount, kind: "money", after: "input.amount", currency: "USD" },
    { label: L.memo, kind: "text", after: "input.privateNote" },
  ],
};

// ── qbo.purchase.create ──────────────────────────────────────────────────────────────────────────

export const PurchaseCreateInput = z.object({
  /** The bank or card account the money left (or, with `credit`, came back to). */
  accountId: QboId,
  paymentType: z.enum(["Cash", "Check", "CreditCard"]),
  /** A refund to a card: the purchase is a credit. */
  credit: z.boolean().optional(),
  /** The payee, a vendor of the company, when known. */
  vendorId: QboId.optional(),
  txnDate: IsoDate,
  currency: CurrencyCode.optional(),
  expectedTotal: DecimalString,
  /** The memo, before the reference mark. */
  privateNote: z.string().max(3900).optional(),
  reference: Reference,
  lines: z.array(NewLine).min(1).max(100),
});
export type PurchaseCreateInput = z.infer<typeof PurchaseCreateInput>;

export function purchaseCreateTool(clientFor: ClientFor): ToolDefinition {
  const check = async (client: QboClient, input: PurchaseCreateInput, ctx: ToolContext) => {
    const problem = totalProblem(input.lines, input.expectedTotal);
    if (problem) throw problem;
    if (input.lines.some((l) => l.itemId !== undefined)) {
      throw new QboApiError(
        422,
        "ACCOUNT_LINES_ONLY",
        "a booked bank transaction has account lines only",
        false,
      );
    }
    const account = await companyAccount(client, input.accountId, { money: true });
    if (input.paymentType === "CreditCard" && account.type !== "Credit Card") {
      throw new QboApiError(422, "NOT_A_CARD", `${account.name} isn't a card account`, false);
    }
    if (input.vendorId) {
      const v = await client.read("Vendor", input.vendorId);
      if (!v || (v as { Active?: boolean }).Active === false) {
        throw new QboApiError(
          422,
          "UNKNOWN_VENDOR",
          `vendor ${input.vendorId} isn't one of this company's`,
          false,
        );
      }
    }
    const lineAccounts = [];
    for (const l of input.lines)
      lineAccounts.push(await companyAccount(client, l.accountId as string));
    const refs = await lineRefsProblem(client, input.lines);
    if (refs) throw refs;
    const found = await sameDay(
      client,
      "Purchase",
      input.txnDate,
      (r) =>
        (r.AccountRef as { value?: string } | undefined)?.value === input.accountId &&
        (r.Credit === true) === (input.credit === true),
      (r) => r.TotalAmt,
      input.reference,
    );
    const done = settleFound(found, input.expectedTotal, "a purchase", "idempotencyKey" in ctx);
    return { account, lineAccounts, done };
  };
  return defineWriteTool({
    id: BANKING_TOOLS.purchaseCreate,
    entity: "purchase",
    description:
      "Book a bank or card transaction in QuickBooks as an expense, check or card charge (a card refund with `credit`): the account it was paid from, the date, the payee, account lines and the expected total. Refused if the lines don't add up or the same purchase is already there.",
    verb: "create",
    // R5: no void or archive tool yet, and delete stays off (docs/plan.md §9 follow-ups).
    undo: { kind: "none" },
    summary: "Booked {{total}} in QuickBooks",
    amount: { path: "expectedTotal", currencyPath: "currency", currency: "USD" },
    display: purchaseCreateDisplay,
    input: PurchaseCreateInput,
    output: Created,
    testOutput: (input) => ({ ...QBO_STAND_IN, total: input.expectedTotal }),
    beforeSchema: Before,
    async before(input, ctx) {
      const client = await clientFor(ctx);
      const { account, lineAccounts } = await check(client, input, ctx);
      return {
        account: { id: account.id, name: account.name },
        names: { accounts: Object.fromEntries(lineAccounts.map((a) => [a.id, a.name])) },
      };
    },
    async run(input, ctx) {
      const client = await clientFor(ctx);
      const { done } = await check(client, input, ctx);
      if (done) {
        ctx.logger.info("purchase already booked", { id: done.id });
        return { id: done.id, syncToken: done.syncToken, total: done.total, alreadyDone: true };
      }
      const body = {
        AccountRef: { value: input.accountId },
        PaymentType: input.paymentType,
        ...(input.credit ? { Credit: true } : {}),
        ...(input.vendorId ? { EntityRef: { value: input.vendorId, type: "Vendor" } } : {}),
        TxnDate: input.txnDate,
        ...(input.currency ? { CurrencyRef: { value: input.currency } } : {}),
        PrivateNote: note(input.privateNote, input.reference),
        Line: input.lines.map((l) => wireLine(l, {})),
      };
      const answer = (await client.post("/purchase", body, {
        requestid: await qboRequestId(ctx.idempotencyKey),
      })) as { Purchase?: Record<string, unknown> };
      const p = answer.Purchase ?? {};
      const total = dec(String(p.TotalAmt ?? 0)).toFixed(4);
      if (!dec(total).equals(dec(input.expectedTotal))) {
        throw new QboApiError(
          502,
          "TOTAL_CHANGED",
          `QuickBooks made purchase ${String(p.Id)} total ${total}; check it`,
          false,
        );
      }
      return { id: String(p.Id), syncToken: String(p.SyncToken ?? "0"), total, alreadyDone: false };
    },
  });
}

// ── qbo.deposit.create ───────────────────────────────────────────────────────────────────────────

export const DepositLine = z.object({
  /** Where the money came from: an income account, usually. */
  accountId: QboId,
  amount: DecimalString,
  description: z.string().max(4000).optional(),
  classId: QboId.optional(),
});

export const DepositCreateInput = z.object({
  /** The bank account the money went into. */
  accountId: QboId,
  txnDate: IsoDate,
  currency: CurrencyCode.optional(),
  expectedTotal: DecimalString,
  privateNote: z.string().max(3900).optional(),
  reference: Reference,
  lines: z.array(DepositLine).min(1).max(100),
});
export type DepositCreateInput = z.infer<typeof DepositCreateInput>;

export function depositCreateTool(clientFor: ClientFor): ToolDefinition {
  const check = async (client: QboClient, input: DepositCreateInput, ctx: ToolContext) => {
    const problem = totalProblem(input.lines, input.expectedTotal);
    if (problem) throw problem;
    if (input.lines.some((l) => !dec(l.amount).equals(dec(l.amount).toDecimalPlaces(2)))) {
      throw new QboApiError(422, "CENTS", "a line's amount has at most 2 decimals", false);
    }
    const account = await companyAccount(client, input.accountId, { money: true });
    const lineAccounts = [];
    for (const l of input.lines) lineAccounts.push(await companyAccount(client, l.accountId));
    const refs = await lineRefsProblem(
      client,
      input.lines.map((l) => ({
        accountId: l.accountId,
        amount: l.amount,
        ...(l.classId ? { classId: l.classId } : {}),
      })),
    );
    if (refs) throw refs;
    const found = await sameDay(
      client,
      "Deposit",
      input.txnDate,
      (r) => (r.DepositToAccountRef as { value?: string } | undefined)?.value === input.accountId,
      (r) => r.TotalAmt,
      input.reference,
    );
    const done = settleFound(found, input.expectedTotal, "a deposit", "idempotencyKey" in ctx);
    return { account, lineAccounts, done };
  };
  return defineWriteTool({
    id: BANKING_TOOLS.depositCreate,
    entity: "deposit",
    description:
      "Book money that came into a bank account as a deposit in QuickBooks: the bank account, the date, the accounts it came from (usually income) and the expected total. Refused if the lines don't add up or the same deposit is already there.",
    verb: "create",
    // R5: no void or archive tool yet, and delete stays off (docs/plan.md §9 follow-ups).
    undo: { kind: "none" },
    summary: "Booked a deposit of {{total}} in QuickBooks",
    amount: { path: "expectedTotal", currencyPath: "currency", currency: "USD" },
    display: depositCreateDisplay,
    input: DepositCreateInput,
    output: Created,
    testOutput: (input) => ({ ...QBO_STAND_IN, total: input.expectedTotal }),
    beforeSchema: Before,
    async before(input, ctx) {
      const client = await clientFor(ctx);
      const { account, lineAccounts } = await check(client, input, ctx);
      return {
        account: { id: account.id, name: account.name },
        names: { accounts: Object.fromEntries(lineAccounts.map((a) => [a.id, a.name])) },
      };
    },
    async run(input, ctx) {
      const client = await clientFor(ctx);
      const { done } = await check(client, input, ctx);
      if (done)
        return { id: done.id, syncToken: done.syncToken, total: done.total, alreadyDone: true };
      const body = {
        DepositToAccountRef: { value: input.accountId },
        TxnDate: input.txnDate,
        ...(input.currency ? { CurrencyRef: { value: input.currency } } : {}),
        PrivateNote: note(input.privateNote, input.reference),
        Line: input.lines.map((l) => ({
          ...(l.description ? { Description: l.description } : {}),
          Amount: wire(l.amount),
          DetailType: "DepositLineDetail",
          DepositLineDetail: {
            AccountRef: { value: l.accountId },
            ...(l.classId ? { ClassRef: { value: l.classId } } : {}),
          },
        })),
      };
      const answer = (await client.post("/deposit", body, {
        requestid: await qboRequestId(ctx.idempotencyKey),
      })) as { Deposit?: Record<string, unknown> };
      const d = answer.Deposit ?? {};
      const total = dec(String(d.TotalAmt ?? 0)).toFixed(4);
      if (!dec(total).equals(dec(input.expectedTotal))) {
        throw new QboApiError(
          502,
          "TOTAL_CHANGED",
          `QuickBooks made deposit ${String(d.Id)} total ${total}; check it`,
          false,
        );
      }
      return { id: String(d.Id), syncToken: String(d.SyncToken ?? "0"), total, alreadyDone: false };
    },
  });
}

// ── qbo.transfer.create ──────────────────────────────────────────────────────────────────────────

export const TransferCreateInput = z.object({
  fromAccountId: QboId,
  toAccountId: QboId,
  amount: DecimalString,
  txnDate: IsoDate,
  privateNote: z.string().max(3900).optional(),
  reference: Reference,
});
export type TransferCreateInput = z.infer<typeof TransferCreateInput>;

export function transferCreateTool(clientFor: ClientFor): ToolDefinition {
  const check = async (client: QboClient, input: TransferCreateInput, ctx: ToolContext) => {
    if (input.fromAccountId === input.toAccountId) {
      throw new QboApiError(
        422,
        "SAME_ACCOUNT",
        "a transfer goes between two different accounts",
        false,
      );
    }
    if (
      !dec(input.amount).greaterThan(0) ||
      !dec(input.amount).equals(dec(input.amount).toDecimalPlaces(2))
    ) {
      throw new QboApiError(
        422,
        "AMOUNT",
        "a transfer's amount is more than zero, in cents",
        false,
      );
    }
    const from = await companyAccount(client, input.fromAccountId);
    const to = await companyAccount(client, input.toAccountId);
    const found = await sameDay(
      client,
      "Transfer",
      input.txnDate,
      (r) =>
        (r.FromAccountRef as { value?: string } | undefined)?.value === input.fromAccountId &&
        (r.ToAccountRef as { value?: string } | undefined)?.value === input.toAccountId,
      (r) => r.Amount,
      input.reference,
    );
    const done = settleFound(found, input.amount, "a transfer", "idempotencyKey" in ctx);
    return { from, to, done };
  };
  return defineWriteTool({
    id: BANKING_TOOLS.transferCreate,
    entity: "transfer",
    description:
      "Book a move of money between two of the company's accounts in QuickBooks (a card payment from the bank, a move to savings): from, to, the amount and the date. Refused if the same transfer is already there.",
    verb: "create",
    // R5: no void or archive tool yet, and delete stays off (docs/plan.md §9 follow-ups).
    undo: { kind: "none" },
    summary: "Booked a transfer of {{total}} in QuickBooks",
    amount: { path: "amount", currency: "USD" },
    display: transferCreateDisplay,
    input: TransferCreateInput,
    output: Created,
    testOutput: (input) => ({ ...QBO_STAND_IN, total: input.amount }),
    beforeSchema: z.object({
      from: z.object({ id: z.string(), name: z.string() }),
      to: z.object({ id: z.string(), name: z.string() }),
    }),
    async before(input, ctx) {
      const client = await clientFor(ctx);
      const { from, to } = await check(client, input, ctx);
      return { from: { id: from.id, name: from.name }, to: { id: to.id, name: to.name } };
    },
    async run(input, ctx) {
      const client = await clientFor(ctx);
      const { done } = await check(client, input, ctx);
      if (done)
        return { id: done.id, syncToken: done.syncToken, total: done.total, alreadyDone: true };
      const body = {
        FromAccountRef: { value: input.fromAccountId },
        ToAccountRef: { value: input.toAccountId },
        Amount: wire(input.amount),
        TxnDate: input.txnDate,
        PrivateNote: note(input.privateNote, input.reference),
      };
      const answer = (await client.post("/transfer", body, {
        requestid: await qboRequestId(ctx.idempotencyKey),
      })) as { Transfer?: Record<string, unknown> };
      const t = answer.Transfer ?? {};
      return {
        id: String(t.Id),
        syncToken: String(t.SyncToken ?? "0"),
        total: dec(String(t.Amount ?? 0)).toFixed(4),
        alreadyDone: false,
      };
    },
  });
}
