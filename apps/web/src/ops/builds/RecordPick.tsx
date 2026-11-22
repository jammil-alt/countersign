// docs/open.md G3: a try on one of the Sandbox's records. The operator picks a purchase or bill, or
// an invoice to a customer, from what the Sandbox's connections brought in (the Records page's own
// list and search), and the try runs on it as its `*.created` event would carry it.

import type { RecordList, TryRecordKind } from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { ErrorNotice } from "../../ui/ErrorState";
import { Select, TextInput } from "../../ui/forms";
import { Button } from "../../ui/primitives";

/** Rows offered at once: the search narrows them. */
const ROWS = 8;

export interface PickedRecord {
  kind: TryRecordKind;
  id: string;
  /** How the row reads, for the try's label. */
  label: string;
}

const KINDS: { kind: TryRecordKind; list: "transactions" | "receivables"; words: string }[] = [
  { kind: "transaction", list: "transactions", words: "Purchases and bills" },
  { kind: "receivable", list: "receivables", words: "Invoices to customers" },
];

/** The rows of one page as the picker shows them. */
export function pickRows(page: RecordList["page"] | undefined): PickedRecord[] {
  if (page?.kind === "transactions") {
    return page.rows
      .filter((r) => !r.deleted)
      .map((r) => ({
        kind: "transaction" as const,
        id: r.id,
        label: [
          r.txnKind.replace(/_/g, " "),
          r.docNumber,
          r.vendor ? `from ${r.vendor.name}` : null,
          `${r.total} ${r.currency}`,
          r.txnDate,
        ]
          .filter(Boolean)
          .join(" · "),
      }));
  }
  if (page?.kind === "receivables") {
    return page.rows
      .filter((r) => r.status !== "deleted")
      .map((r) => ({
        kind: "receivable" as const,
        id: r.id,
        label: [
          r.docNumber ? `invoice ${r.docNumber}` : "invoice",
          `to ${r.customer.name}`,
          `${r.total} ${r.currency}`,
          r.txnDate,
        ].join(" · "),
      }));
  }
  return [];
}

export function RecordPick({
  clientId,
  busy,
  onPick,
}: {
  /** The Sandbox client whose records are offered. */
  clientId: string;
  busy: boolean;
  onPick(record: PickedRecord): void;
}) {
  const [kind, setKind] = useState<TryRecordKind>("transaction");
  const [q, setQ] = useState("");
  const list = KINDS.find((k) => k.kind === kind)?.list ?? "transactions";
  const state = useApi(apiRoutes.opsClientRecords, {
    params: { id: clientId },
    query: { kind: list, ...(q.trim() ? { q: q.trim() } : {}), limit: ROWS },
    keep: true,
  });
  const rows = state.data?.page.kind === list ? pickRows(state.data.page) : [];
  return (
    <div className="flex flex-col gap-2" data-testid="build-try-records">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Which records"
          className="h-8 w-auto text-sm"
          value={kind}
          onChange={(e) => setKind(e.target.value as TryRecordKind)}
          data-testid="build-try-record-kind"
        >
          {KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.words}
            </option>
          ))}
        </Select>
        <TextInput
          aria-label="Search the records"
          className="h-8 min-w-0 flex-1 text-sm"
          placeholder="A number, vendor, customer or amount"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="build-try-record-search"
        />
      </div>
      {state.error ? <ErrorNotice error={state.error} /> : null}
      {state.data && rows.length === 0 ? (
        <p className="text-ink-muted" data-testid="build-try-records-none">
          {q.trim() ? "No records match." : "The Sandbox has none of these yet."}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="flex flex-col rounded-md border border-line" aria-label="Records">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2 last:border-b-0"
            >
              <span className="min-w-0 break-words text-ink">{r.label}</span>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => onPick(r)}
                data-testid={`build-try-record-${r.id}`}
              >
                Try it on this
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
