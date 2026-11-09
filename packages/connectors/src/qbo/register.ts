// `qbo.account.register` (docs/plan.md §1.80): one account's opening balance, closing balance and
// postings between two dates, from QuickBooks' GeneralLedger report, for reconciliation. Each
// posting's `effect` is how much it moved the account's balance as QuickBooks keeps it (a deposit
// raises a bank account; a charge raises what a card account owes). Read only.

import { DecimalString, dec, toNumeric } from "@countersign/core";
import { z } from "zod";
import { defineReadTool, type ToolDefinition } from "../connector";
import { QboApiError } from "./api";
import { QboId, toAccount } from "./records";
import { type ClientFor, IsoDate, notFound } from "./tool-kit";

export const QBO_REGISTER_TOOL = "qbo.account.register";

export const RegisterInput = z
  .object({
    accountId: QboId,
    startDate: IsoDate,
    endDate: IsoDate,
  })
  .refine((v) => v.startDate <= v.endDate, "startDate is after endDate");

export const RegisterItem = z.object({
  /** `qbo:<TxnType>:<id>`: the posting's record in QuickBooks. */
  id: z.string(),
  date: z.string().nullable(),
  type: z.string().nullable(),
  reference: z.string().nullable(),
  description: z.string().nullable(),
  effect: DecimalString,
});

export const RegisterOutput = z.object({
  accountId: z.string(),
  accountName: z.string(),
  accountType: z.string().nullable(),
  currency: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  opening: DecimalString,
  closing: DecimalString,
  items: z.array(RegisterItem),
  sources: z.array(z.string()),
});
export type RegisterOutput = z.infer<typeof RegisterOutput>;

const Cell = z.looseObject({
  value: z.string().optional(),
  id: z.union([z.string(), z.number()]).transform(String).optional(),
});
type Cell = z.infer<typeof Cell>;
type Row = {
  type?: string;
  ColData?: Cell[];
  Header?: { ColData?: Cell[] };
  Rows?: { Row?: Row[] };
  Summary?: { ColData?: Cell[] };
};

/** The report's column keys in order (`tx_date`, `subt_nat_amount`, …). */
function columnKeys(report: Record<string, unknown>): string[] {
  const cols = ((report.Columns as { Column?: unknown[] } | undefined)?.Column ?? []) as {
    ColTitle?: string;
    MetaData?: { Name?: string; Value?: string }[];
  }[];
  return cols.map((c) => c.MetaData?.find((m) => m.Name === "ColKey")?.Value ?? c.ColTitle ?? "");
}

function rows(report: Record<string, unknown>): Row[] {
  const out: Row[] = [];
  const walk = (list: Row[] | undefined) => {
    for (const r of list ?? []) {
      if (r.ColData) out.push(r);
      walk(r.Rows?.Row);
    }
  };
  walk((report.Rows as { Row?: Row[] } | undefined)?.Row);
  return out;
}

const money = (v: string | undefined): string | null => {
  const t = (v ?? "").replace(/,/g, "").trim();
  if (!t) return null;
  try {
    return toNumeric(dec(t));
  } catch {
    return null;
  }
};

/**
 * QuickBooks' GeneralLedger answer for one account → opening, postings and closing. The opening is
 * the "Beginning Balance" row; the closing is the last running balance, else opening + postings.
 */
// UNCHECKED (NOTES.md): the column keys, the Beginning Balance row, and that `subt_nat_amount` is
// signed as the account's own balance (a card's charge positive).
export function readRegister(report: unknown): {
  opening: string;
  closing: string;
  items: z.infer<typeof RegisterItem>[];
} {
  const r = (report ?? {}) as Record<string, unknown>;
  const keys = columnKeys(r);
  const at = (row: Row, key: string): Cell | undefined => row.ColData?.[keys.indexOf(key)];
  let opening: string | null = null;
  let running: string | null = null;
  const items: z.infer<typeof RegisterItem>[] = [];
  for (const row of rows(r)) {
    const first = row.ColData?.[0]?.value ?? "";
    if (/^beginning balance$/i.test(first.trim())) {
      opening =
        money(at(row, "rbal_nat_amount")?.value) ?? money(at(row, "subt_nat_amount")?.value) ?? "0";
      running = opening;
      continue;
    }
    const date = at(row, "tx_date")?.value ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const effect = money(at(row, "subt_nat_amount")?.value);
    if (effect === null) continue;
    const type = at(row, "txn_type");
    items.push({
      id: `qbo:${(type?.value ?? "Txn").replace(/\s+/g, "")}:${type?.id ?? items.length + 1}`,
      date,
      type: type?.value ?? null,
      reference: at(row, "doc_num")?.value || null,
      description:
        [at(row, "name")?.value, at(row, "memo")?.value].filter(Boolean).join(" · ") || null,
      effect,
    });
    running = money(at(row, "rbal_nat_amount")?.value) ?? running;
  }
  const start = opening ?? "0.0000";
  const summed = items.reduce((s, i) => s.plus(dec(i.effect)), dec(start));
  return { opening: start, closing: running ?? toNumeric(summed), items };
}

export function registerTool(clientFor: ClientFor): ToolDefinition {
  return defineReadTool({
    id: QBO_REGISTER_TOOL,
    entity: "account",
    description:
      "One account's register in QuickBooks between two dates: its opening balance, closing balance and every posting with how much it moved the balance, for reconciling it against the bank or a statement.",
    summary: "Read {{items.length}} postings on {{accountName}}",
    input: RegisterInput,
    output: RegisterOutput,
    async run(input, ctx) {
      const client = await clientFor(ctx);
      const raw = await client.read("Account", input.accountId);
      if (!raw) throw notFound("Account", input.accountId);
      const account = toAccount(raw);
      const report = await client.get("/reports/GeneralLedger", {
        account: input.accountId,
        start_date: input.startDate,
        end_date: input.endDate,
        columns: "tx_date,txn_type,doc_num,name,memo,subt_nat_amount,rbal_nat_amount",
        sort_by: "tx_date",
      });
      const read = readRegister(report);
      // The register must add up before anyone compares it (docs/plan.md §1.80).
      const sum = read.items.reduce((s, i) => s.plus(dec(i.effect)), dec(read.opening));
      if (!sum.equals(dec(read.closing))) {
        throw new QboApiError(
          502,
          "REGISTER_DOESNT_ADD_UP",
          `QuickBooks' register for ${account.fullyQualifiedName} doesn't add up (opening ${read.opening} and postings make ${toNumeric(sum)}, not ${read.closing})`,
          false,
        );
      }
      return {
        accountId: account.id,
        accountName: account.fullyQualifiedName,
        accountType: account.accountType,
        currency: account.currency ?? "USD",
        startDate: input.startDate,
        endDate: input.endDate,
        ...read,
        sources: read.items.map((i) => i.id),
      };
    },
  });
}
