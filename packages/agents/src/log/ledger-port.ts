// The ledger behind `ledger.*` (LedgerPort), over packages/db: one client-scoped transaction per
// call, so only that client's ledgers are visible (invariant 1).

import { type Db, ledgerChart, ledgerDimensions, withTenant } from "@countersign/db";
import type { LedgerPort } from "../tools/types";

export function dbLedgerPort(db: Db): LedgerPort {
  return {
    async accounts(tenantId, input) {
      const accounts = await withTenant(db, tenantId, (tx) =>
        ledgerChart(tx, tenantId, {
          connectionId: input.connectionId,
          kinds: input.kinds,
          inactive: input.inactive,
        }),
      );
      return {
        accounts: accounts.map((a) => ({
          id: a.id,
          connectionId: a.connectionId,
          connector: a.connector,
          externalId: a.externalId,
          name: a.name,
          fullName: a.fullName,
          number: a.number,
          classification: a.classification,
          kind: a.kind,
          type: a.type,
          subType: a.subType,
          description: a.description,
          active: a.active,
          notes: a.notes.map((n) => ({ note: n.note, source: n.source })),
        })),
        count: accounts.length,
        sources: accounts.map((a) => a.id),
      };
    },
    async dimensions(tenantId, input) {
      const dimensions = await withTenant(db, tenantId, (tx) =>
        ledgerDimensions(tx, tenantId, {
          connectionId: input.connectionId,
          kind: input.kind,
          inactive: input.inactive,
        }),
      );
      return { dimensions, count: dimensions.length, sources: dimensions.map((d) => d.id) };
    },
  };
}
