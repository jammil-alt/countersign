// The back office's chart of accounts (docs/plan.md §1.79, owner 2026-11-08: full control of the
// ledger's set-up, always behind an approval gate): a client's ledger per accounting connection,
// and a change to it (an account, a class or a location added or changed) that the operator signs
// as they make it. The change is an external action they approved, run once through the
// connection's tool; nothing is deleted (a record is made inactive).

import { z } from "zod";
import { isUuid } from "../ids";
import { LedgerKind } from "../ledger/schemas";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;

/** The ledger's writes the back office makes, each always signed (connector `LEDGER_WRITE_TOOLS`). */
export const LEDGER_CHANGE_TOOLS = [
  "qbo.account.create",
  "qbo.account.update",
  "qbo.class.create",
  "qbo.class.update",
  "qbo.location.create",
  "qbo.location.update",
] as const;

export const OpsLedgerAccount = z.object({
  id: z.string(),
  externalId: z.string(),
  name: z.string(),
  fullName: z.string(),
  number: z.string().nullable(),
  classification: z.string().nullable(),
  kind: LedgerKind,
  type: z.string(),
  subType: z.string().nullable(),
  description: z.string().nullable(),
  parentExternalId: z.string().nullable(),
  active: z.boolean(),
  /** The version last synced: a change names it, and is refused if QuickBooks moved on. */
  syncToken: z.string().nullable(),
  notes: z.array(z.object({ note: z.string(), source: z.enum(["client", "operator", "agent"]) })),
});

export const OpsLedgerDimension = z.object({
  id: z.string(),
  kind: z.enum(["class", "location"]),
  externalId: z.string(),
  name: z.string(),
  fullName: z.string(),
  parentExternalId: z.string().nullable(),
  active: z.boolean(),
  syncToken: z.string().nullable(),
});

export const OpsLedger = z.object({
  ledgers: z.array(
    z.object({
      connectionId: z.string(),
      connector: z.string(),
      /** The company's name in the tool. */
      accountName: z.string().nullable(),
      status: z.string(),
      lastSyncAt: z.string().nullable(),
      accounts: z.array(OpsLedgerAccount),
      dimensions: z.array(OpsLedgerDimension),
    }),
  ),
});
export type OpsLedger = z.infer<typeof OpsLedger>;

export const OpsLedgerChangeBody = z.strictObject({
  connectionId: Id,
  tool: z.enum(LEDGER_CHANGE_TOOLS),
  /** The tool's input; the tool checks it. */
  input: z.record(z.string(), z.unknown()),
  /** One per click of "Sign and save": the same request twice writes once. */
  requestId: Id,
});

export const OpsLedgerChangeResult = z.object({
  status: z.enum(["done", "failed"]),
  /** What QuickBooks has now (the record's id and name), when done. */
  output: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
});

export const ledgerRoutes = {
  opsClientLedger: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/ledger",
    auth: "session",
    roles: OPS,
    summary: "A client's ledger per accounting connection: its accounts, classes and locations",
    params: z.object({ id: Id }),
    response: OpsLedger,
  }),
  opsClientLedgerChange: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/ledger/changes",
    auth: "session",
    roles: OPS,
    summary:
      "Add or change an account, class or location in a client's accounting tool, signed by the person making it",
    params: z.object({ id: Id }),
    body: OpsLedgerChangeBody,
    response: OpsLedgerChangeResult,
  }),
};
