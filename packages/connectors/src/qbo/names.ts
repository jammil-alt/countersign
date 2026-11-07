// Names for the ids a QuickBooks approval card shows (a line's account or item) when the change's
// before state leaves them unnamed: read from the connection's synced records (Connector
// `syncedNames`). Accounts are not synced on their own, so an account is named by a synced bill,
// purchase or vendor credit whose line books to it, or an item whose expense account it is; an item
// by its own synced record, or a line that uses it.
import type { SyncedNameLookup } from "../connector";

const TXNS = ["Bill", "Purchase", "VendorCredit"] as const;

type Ref = { value?: unknown; name?: unknown };
type Line = {
  AccountBasedExpenseLineDetail?: { AccountRef?: Ref };
  ItemBasedExpenseLineDetail?: { ItemRef?: Ref };
};

const named = (ref: Ref | undefined, id: string): string | null =>
  ref && String(ref.value) === id && typeof ref.name === "string" && ref.name.length > 0
    ? ref.name
    : null;

function lines(payload: unknown): Line[] {
  const l = (payload as { Line?: unknown } | null)?.Line;
  return Array.isArray(l) ? (l as Line[]) : [];
}

function fromLines(id: string, pick: (l: Line) => Ref | undefined) {
  return (payload: unknown): string | null => {
    for (const l of lines(payload)) {
      const n = named(pick(l), id);
      if (n !== null) return n;
    }
    return null;
  };
}

/** Where QuickBooks' synced records name an account or item id (the display's names lists). */
export function qboSyncedNames(list: string, id: string): readonly SyncedNameLookup[] {
  if (list === "accounts") {
    const pick = (l: Line) => l.AccountBasedExpenseLineDetail?.AccountRef;
    return [
      ...TXNS.map((entityType) => ({
        entityType,
        contains: { Line: [{ AccountBasedExpenseLineDetail: { AccountRef: { value: id } } }] },
        name: fromLines(id, pick),
      })),
      {
        entityType: "Item",
        contains: { ExpenseAccountRef: { value: id } },
        name: (p: unknown) =>
          named((p as { ExpenseAccountRef?: Ref } | null)?.ExpenseAccountRef, id),
      },
    ];
  }
  if (list === "items") {
    const pick = (l: Line) => l.ItemBasedExpenseLineDetail?.ItemRef;
    return [
      {
        entityType: "Item",
        contains: { Id: id },
        name: (p: unknown) => {
          const n = (p as { Name?: unknown } | null)?.Name;
          return typeof n === "string" && n.length > 0 ? n : null;
        },
      },
      ...TXNS.map((entityType) => ({
        entityType,
        contains: { Line: [{ ItemBasedExpenseLineDetail: { ItemRef: { value: id } } }] },
        name: fromLines(id, pick),
      })),
    ];
  }
  return [];
}
