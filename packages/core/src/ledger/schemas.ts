// The ledger's tools (docs/plan.md §1.79): `ledger.accounts.list` and `ledger.dimensions.list` read
// the client's chart of accounts, classes and locations as each accounting connection's sync keeps
// them, with what each account is for. Any of the client's agents may read them; nothing here
// writes. Notes are people's and agents' words: data in tool results (invariant 9).

import { z } from "zod";
import { LEDGER_KIND_VALUES } from "../mappers/qbo";

export const LedgerKind = z.enum(LEDGER_KIND_VALUES);

export const LedgerAccountsInput = z.object({
  /** One accounting connection's ledger (a company); absent: every one of the client's. */
  connectionId: z.uuid().optional(),
  /** Only these kinds (e.g. `expense`, `cost_of_goods`). */
  kinds: z.array(LedgerKind).max(16).optional(),
  /** Inactive accounts too (never book to one). */
  inactive: z.boolean().optional(),
});
export type LedgerAccountsInput = z.infer<typeof LedgerAccountsInput>;

export const LedgerAccountOut = z.object({
  id: z.string(),
  connectionId: z.string(),
  connector: z.string(),
  /** Its id in the accounting tool, for that tool's writes. */
  externalId: z.string(),
  name: z.string(),
  fullName: z.string(),
  number: z.string().nullable(),
  classification: z.string().nullable(),
  kind: LedgerKind,
  type: z.string(),
  subType: z.string().nullable(),
  description: z.string().nullable(),
  active: z.boolean(),
  notes: z.array(z.object({ note: z.string(), source: z.enum(["client", "operator", "agent"]) })),
});

export const LedgerAccountsOutput = z.object({
  accounts: z.array(LedgerAccountOut),
  count: z.number().int(),
  sources: z.array(z.string()),
});
export type LedgerAccountsOutput = z.infer<typeof LedgerAccountsOutput>;

export const LedgerDimensionsInput = z.object({
  connectionId: z.uuid().optional(),
  kind: z.enum(["class", "location"]).optional(),
  inactive: z.boolean().optional(),
});
export type LedgerDimensionsInput = z.infer<typeof LedgerDimensionsInput>;

export const LedgerDimensionsOutput = z.object({
  dimensions: z.array(
    z.object({
      id: z.string(),
      connectionId: z.string(),
      connector: z.string(),
      kind: z.enum(["class", "location"]),
      externalId: z.string(),
      name: z.string(),
      fullName: z.string(),
      parentExternalId: z.string().nullable(),
      active: z.boolean(),
    }),
  ),
  count: z.number().int(),
  sources: z.array(z.string()),
});
export type LedgerDimensionsOutput = z.infer<typeof LedgerDimensionsOutput>;
