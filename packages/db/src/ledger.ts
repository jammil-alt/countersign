// The client's ledger as agents read it (docs/plan.md §1.79): each accounting connection's accounts
// with what each is for (the client's and the operator's notes first, then the agent's), and its
// classes and locations. One client's transaction; nothing of another client is visible
// (invariant 1). `ledger.*` (packages/agents) and the Bookkeeping pack read through these.

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Tx } from "./client";
import {
  type LedgerDimensionKind,
  type LedgerKind,
  type LedgerNoteSource,
  ledgerAccount,
  ledgerAccountNote,
  ledgerDimension,
} from "./schema";

/** At most this many notes per account in a listing. */
export const LEDGER_NOTES_PER_ACCOUNT = 5;

export interface LedgerNoteView {
  id: string;
  note: string;
  source: LedgerNoteSource;
  createdAt: string;
}

export interface LedgerAccountView {
  id: string;
  /** The accounting connection it belongs to (one ledger per connection). */
  connectionId: string;
  connector: string;
  /** Its id in the accounting tool. */
  externalId: string;
  name: string;
  fullName: string;
  number: string | null;
  classification: string | null;
  /** What it is, in the platform's words (`bank`, `card`, `expense`, …). */
  kind: LedgerKind;
  /** The tool's own type and sub-type, as written there. */
  type: string;
  subType: string | null;
  description: string | null;
  active: boolean;
  /** The client's and the operator's notes first, then the agent's; newest first in each. */
  notes: LedgerNoteView[];
}

export interface LedgerChartOptions {
  connectionId?: string | undefined;
  kinds?: readonly LedgerKind[] | undefined;
  classifications?: readonly string[] | undefined;
  ids?: readonly string[] | undefined;
  /** Inactive accounts too (a booking never goes to one). */
  inactive?: boolean | undefined;
}

const PERSON_FIRST: Record<LedgerNoteSource, number> = { client: 0, operator: 1, agent: 2 };

export async function ledgerChart(
  tx: Tx,
  tenantId: string,
  opts: LedgerChartOptions = {},
): Promise<LedgerAccountView[]> {
  const where = [eq(ledgerAccount.tenantId, tenantId)];
  if (!opts.inactive) where.push(eq(ledgerAccount.active, true));
  if (opts.connectionId) where.push(eq(ledgerAccount.connectionId, opts.connectionId));
  if (opts.kinds?.length) where.push(inArray(ledgerAccount.kind, [...opts.kinds]));
  if (opts.classifications?.length) {
    where.push(inArray(ledgerAccount.classification, [...opts.classifications] as never[]));
  }
  if (opts.ids) {
    if (opts.ids.length === 0) return [];
    where.push(inArray(ledgerAccount.id, [...opts.ids]));
  }
  const accounts = await tx
    .select()
    .from(ledgerAccount)
    .where(and(...where))
    .orderBy(asc(ledgerAccount.fullName), asc(ledgerAccount.id));
  if (accounts.length === 0) return [];
  const notes = await tx
    .select()
    .from(ledgerAccountNote)
    .where(
      and(
        eq(ledgerAccountNote.tenantId, tenantId),
        inArray(
          ledgerAccountNote.ledgerAccountId,
          accounts.map((a) => a.id),
        ),
      ),
    )
    .orderBy(desc(ledgerAccountNote.createdAt), desc(ledgerAccountNote.id));
  return accounts.map((a) => ({
    id: a.id,
    connectionId: a.connectionId,
    connector: a.connector,
    externalId: a.externalId,
    name: a.name,
    fullName: a.fullName,
    number: a.number,
    classification: a.classification,
    kind: a.kind,
    type: a.accountType,
    subType: a.accountSubType,
    description: a.description,
    active: a.active,
    notes: notes
      .filter((n) => n.ledgerAccountId === a.id)
      .sort((x, y) => PERSON_FIRST[x.source] - PERSON_FIRST[y.source])
      .slice(0, LEDGER_NOTES_PER_ACCOUNT)
      .map((n) => ({
        id: n.id,
        note: n.note,
        source: n.source,
        createdAt: n.createdAt.toISOString(),
      })),
  }));
}

export interface LedgerDimensionView {
  id: string;
  connectionId: string;
  connector: string;
  kind: LedgerDimensionKind;
  externalId: string;
  name: string;
  fullName: string;
  parentExternalId: string | null;
  active: boolean;
}

/** The ledger's classes and locations, active ones unless asked. */
export async function ledgerDimensions(
  tx: Tx,
  tenantId: string,
  opts: {
    connectionId?: string | undefined;
    kind?: LedgerDimensionKind | undefined;
    inactive?: boolean | undefined;
  } = {},
): Promise<LedgerDimensionView[]> {
  const where = [eq(ledgerDimension.tenantId, tenantId)];
  if (!opts.inactive) where.push(eq(ledgerDimension.active, true));
  if (opts.connectionId) where.push(eq(ledgerDimension.connectionId, opts.connectionId));
  if (opts.kind) where.push(eq(ledgerDimension.kind, opts.kind));
  const rows = await tx
    .select()
    .from(ledgerDimension)
    .where(and(...where))
    .orderBy(asc(ledgerDimension.kind), asc(ledgerDimension.fullName), asc(ledgerDimension.id));
  return rows.map((d) => ({
    id: d.id,
    connectionId: d.connectionId,
    connector: d.connector,
    kind: d.kind,
    externalId: d.externalId,
    name: d.name,
    fullName: d.fullName,
    parentExternalId: d.parentExternalId,
    active: d.active,
  }));
}
