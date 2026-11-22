// docs/plan.md §1.232 (the Close pack, Wave Y item Y3): `qbo.journal.create`, a journal entry in
// QuickBooks: an accrual at a month's end, its reversal on the next month's first day, or a
// recurring journal. A write behind approval like every other (invariant 8), with no prior state.
// It carries a `reference` (the close entry's) in its private note: a journal entry there with it
// is this action's own earlier write (reported done, not made again); one on the same day for the
// same total without any Mezonas mark was entered by someone else, and the write is refused.

import { CurrencyCode, DecimalString, dec, type ToolDisplay } from "@countersign/core";
import { z } from "zod";
import { defineWriteTool, type ToolContext, type ToolDefinition } from "../connector";
import { QboApiError, type QboClient, qboLiteral, qboRequestId } from "./api";
import { QboDuplicateBankingError, referenceMark } from "./banking";
import { QboId, toAccount } from "./records";
import { type ClientFor, IsoDate, QBO_STAND_IN, sum } from "./tool-kit";

export const JOURNAL_TOOLS = { create: "qbo.journal.create" } as const;

const Reference = z
  .string()
  .regex(/^[A-Za-z0-9-]{4,40}$/, "a reference: 4 to 40 letters, digits or dashes");

const ANY_MARK = /\[Mezonas [A-Za-z0-9-]{4,40}\]/;

export const JournalLine = z.object({
  accountId: QboId,
  posting: z.enum(["debit", "credit"]),
  amount: DecimalString,
  description: z.string().max(4000).optional(),
});
export type JournalLine = z.infer<typeof JournalLine>;

export const JournalCreateInput = z.object({
  txnDate: IsoDate,
  currency: CurrencyCode.optional(),
  /** The total of the debits, which must equal the total of the credits. */
  expectedTotal: DecimalString,
  /** The memo, before the reference mark. */
  privateNote: z.string().max(3900).optional(),
  reference: Reference,
  lines: z.array(JournalLine).min(2).max(100),
});
export type JournalCreateInput = z.infer<typeof JournalCreateInput>;

const Created = z.object({
  id: z.string(),
  syncToken: z.string(),
  total: DecimalString,
  alreadyDone: z.boolean(),
});

const Before = z.object({
  names: z.object({ accounts: z.record(z.string(), z.string()) }),
});

/** Debits equal credits, both more than zero and equal to the expected total (decimal). */
export function journalProblem(lines: readonly JournalLine[], expected: string): string | null {
  const debits = sum(lines.filter((l) => l.posting === "debit").map((l) => l.amount));
  const credits = sum(lines.filter((l) => l.posting === "credit").map((l) => l.amount));
  if (lines.some((l) => !dec(l.amount).greaterThan(0)))
    return "every line's amount is more than zero";
  if (!dec(debits).equals(dec(credits))) {
    return `the debits (${debits}) and credits (${credits}) don't balance`;
  }
  if (!dec(debits).equals(dec(expected))) {
    return `the entry totals ${debits}, not the ${expected} expected`;
  }
  return null;
}

function note(memo: string | undefined, reference: string): string {
  return [memo?.trim(), referenceMark(reference)].filter(Boolean).join(" ").slice(0, 4000);
}

/** A journal entry's debit total as QuickBooks keeps it. */
function debitTotal(row: Record<string, unknown>): string {
  const lines = (Array.isArray(row.Line) ? row.Line : []) as Record<string, unknown>[];
  return sum(
    lines
      .filter(
        (l) =>
          (l.JournalEntryLineDetail as { PostingType?: string } | undefined)?.PostingType ===
          "Debit",
      )
      .map((l) => dec(String(l.Amount ?? 0)).toFixed(4)),
  );
}

export const journalCreateDisplay: ToolDisplay = {
  name: {
    en: "QuickBooks journal entry",
    es: "Asiento de diario de QuickBooks",
    fr: "Écriture de journal QuickBooks",
    "pt-BR": "Lançamento de diário do QuickBooks",
    it: "Registrazione contabile QuickBooks",
    de: "QuickBooks-Journalbuchung",
  },
  description: {
    en: "Record this journal entry in QuickBooks for the month's close. Nothing else changes.",
    es: "Registra este asiento en QuickBooks para el cierre del mes. Nada más cambia.",
    fr: "Enregistre cette écriture dans QuickBooks pour la clôture du mois. Rien d'autre ne change.",
    "pt-BR": "Lança este lançamento no QuickBooks para o fechamento do mês. Nada mais muda.",
    it: "Registra questa scrittura in QuickBooks per la chiusura del mese. Nient'altro cambia.",
    de: "Bucht diese Journalbuchung in QuickBooks für den Monatsabschluss. Sonst ändert sich nichts.",
  },
  names: "before.names",
  fields: [
    {
      label: { en: "Date", es: "Fecha", fr: "Date", "pt-BR": "Data", it: "Data", de: "Datum" },
      kind: "date",
      after: "input.txnDate",
    },
    {
      label: {
        en: "Lines",
        es: "Líneas",
        fr: "Lignes",
        "pt-BR": "Linhas",
        it: "Righe",
        de: "Positionen",
      },
      kind: "lines",
      after: "input.lines",
      currencyPath: "input.currency",
      columns: {
        description: "description",
        amount: "amount",
        refs: [{ key: "accountId", names: "accounts" }],
      },
    },
    {
      label: {
        en: "Total",
        es: "Total",
        fr: "Total",
        "pt-BR": "Total",
        it: "Totale",
        de: "Gesamt",
      },
      kind: "money",
      after: "input.expectedTotal",
      currencyPath: "input.currency",
      currency: "USD",
    },
    {
      label: { en: "Memo", es: "Nota", fr: "Note", "pt-BR": "Observação", it: "Nota", de: "Notiz" },
      kind: "text",
      after: "input.privateNote",
    },
  ],
};

export function journalCreateTool(clientFor: ClientFor): ToolDefinition {
  const check = async (client: QboClient, input: JournalCreateInput, ctx: ToolContext) => {
    const problem = journalProblem(input.lines, input.expectedTotal);
    if (problem) throw new QboApiError(422, "UNBALANCED", problem, false);
    const names: Record<string, string> = {};
    for (const l of input.lines) {
      if (names[l.accountId]) continue;
      const raw = await client.read("Account", l.accountId);
      const a = raw ? toAccount(raw) : null;
      if (!a?.active) {
        throw new QboApiError(
          422,
          "UNKNOWN_ACCOUNT",
          `account ${l.accountId} isn't one of this company's active accounts`,
          false,
        );
      }
      names[a.id] = a.fullyQualifiedName;
    }
    // UNCHECKED (NOTES.md, "Journal entries"): `TxnDate =` filters JournalEntry.
    const { rows } = await client.query(
      `select * from JournalEntry where TxnDate = ${qboLiteral(input.txnDate)} maxresults 1000`,
      "JournalEntry",
    );
    const mark = referenceMark(input.reference);
    const same = rows
      .map((r) => r as Record<string, unknown>)
      .filter((r) => dec(debitTotal(r)).equals(dec(input.expectedTotal)));
    const ours = same.find((r) => String(r.PrivateNote ?? "").includes(mark));
    if (ours && !("idempotencyKey" in ctx)) {
      throw new QboDuplicateBankingError(
        `a journal entry for this close entry is already in QuickBooks (${String(ours.Id)})`,
      );
    }
    // DECISION: another close entry's journal (two $500 accruals on one day) isn't a duplicate;
    // only one with no Mezonas mark at all was entered by someone else.
    const theirs = same.find((r) => !ANY_MARK.test(String(r.PrivateNote ?? "")));
    if (!ours && theirs) {
      throw new QboDuplicateBankingError(
        `a journal entry for the same day and total is already in QuickBooks (${String(theirs.Id)}); check it isn't this one`,
      );
    }
    return { names, done: ours ?? null };
  };
  return defineWriteTool({
    id: JOURNAL_TOOLS.create,
    entity: "journal_entry",
    description:
      "Record a journal entry in QuickBooks: the date, debit and credit lines to the company's accounts, and the expected total. Refused if the debits and credits don't balance or the same entry is already there.",
    verb: "create",
    // No void tool yet, and delete stays off.
    undo: { kind: "none" },
    summary: "Recorded a {{total}} journal entry in QuickBooks",
    amount: { path: "expectedTotal", currencyPath: "currency", currency: "USD" },
    display: journalCreateDisplay,
    input: JournalCreateInput,
    output: Created,
    testOutput: (input) => ({ ...QBO_STAND_IN, total: input.expectedTotal }),
    beforeSchema: Before,
    async before(input, ctx) {
      const { names } = await check(await clientFor(ctx), input, ctx);
      return { names: { accounts: names } };
    },
    async run(input, ctx) {
      const client = await clientFor(ctx);
      const { done } = await check(client, input, ctx);
      if (done) {
        ctx.logger.info("journal entry already recorded", { id: String(done.Id) });
        return {
          id: String(done.Id),
          syncToken: String(done.SyncToken ?? "0"),
          total: debitTotal(done),
          alreadyDone: true,
        };
      }
      const body = {
        TxnDate: input.txnDate,
        ...(input.currency ? { CurrencyRef: { value: input.currency } } : {}),
        PrivateNote: note(input.privateNote, input.reference),
        Line: input.lines.map((l) => ({
          DetailType: "JournalEntryLineDetail",
          Amount: Number(dec(l.amount).toFixed(2)),
          ...(l.description ? { Description: l.description } : {}),
          JournalEntryLineDetail: {
            PostingType: l.posting === "debit" ? "Debit" : "Credit",
            AccountRef: { value: l.accountId },
          },
        })),
      };
      const answer = (await client.post("/journalentry", body, {
        requestid: await qboRequestId(ctx.idempotencyKey),
      })) as { JournalEntry?: Record<string, unknown> };
      const j = answer.JournalEntry ?? {};
      const total = debitTotal(j);
      if (!dec(total).equals(dec(input.expectedTotal))) {
        throw new QboApiError(
          502,
          "TOTAL_CHANGED",
          `QuickBooks made journal entry ${String(j.Id)} total ${total}; check it`,
          false,
        );
      }
      return { id: String(j.Id), syncToken: String(j.SyncToken ?? "0"), total, alreadyDone: false };
    },
  });
}
