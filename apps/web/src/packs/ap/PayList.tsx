// The week's approve-to-pay list (Plan entry §1.233), shared by the card and the Bills to pay
// screen. The bills that need a person come first, then the ready ones, then what is decided. A
// bill opens to its lines, each with its account or our suggestion. With `onDecide` (the card) a
// person approves, holds or rejects, codes a line, confirms an order or marks it received; without
// it (the screen) it reads only. Nothing is paid here.
//
// Colours (brand book): waiting on you is signal with its word; a person's decision copper; a
// blocking flag risk; the agent's work stays ink. Vendors' words show as written.
import { useState } from "react";
import { useI18n } from "../../i18n/i18n";
import { Badge, Button, EmptyState } from "../../ui/primitives";
import { dayLabel } from "../../usage/format";
import {
  type Account,
  type Bill,
  FLAG_TONE,
  flagLabel,
  type PayList,
  type PayListDecision,
  STATUS_LABEL,
  STATUS_TONE,
} from "./types";

export function PayListView({
  list,
  accounts = [],
  onDecide,
  busy = false,
}: {
  list: PayList;
  accounts?: readonly Account[];
  /** The card's decisions; absent where the list is read only. */
  onDecide?: ((d: PayListDecision) => Promise<boolean>) | undefined;
  busy?: boolean;
}) {
  const { t, fmt, intl } = useI18n();
  const undecided = (b: Bill) => b.status === "open" || b.status === "held";
  const needs = list.bills.filter((b) => undecided(b) && !b.ready);
  const ready = list.bills.filter((b) => undecided(b) && b.ready);
  const decided = list.bills.filter((b) => !undecided(b));
  const total = list.totals.map((x) => fmt.money(x.listed, x.currency)).join(" · ");
  const readyTotal = list.totals.map((x) => fmt.money(x.ready, x.currency)).join(" · ");
  const approvedTotal = list.totals.map((x) => fmt.money(x.approved, x.currency)).join(" · ");

  if (list.count === 0) return <EmptyState>{t("ap.list.empty")}</EmptyState>;
  const group = (title: string, bills: Bill[], testId: string) =>
    bills.length === 0 ? null : (
      <section className="flex flex-col gap-2" data-testid={testId}>
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
          {bills.map((b) => (
            <BillRow key={b.id} bill={b} accounts={accounts} onDecide={onDecide} busy={busy} />
          ))}
        </ul>
      </section>
    );
  return (
    <div className="flex flex-col gap-4" data-testid="ap-pay-list">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-ink">
          {t("ap.list.heading", { count: list.count, day: dayLabel(list.payDay, intl) })}{" "}
          <span className="ds-num">{total}</span>
        </p>
        {list.needsYou > 0 ? (
          <Badge tone="warning">{t("ap.list.needsYou", { count: list.needsYou })}</Badge>
        ) : null}
        {decided.some((b) => b.status === "approved") ? (
          <Badge tone="person">{t("ap.list.approved", { amount: approvedTotal })}</Badge>
        ) : null}
      </div>
      {group(t("ap.list.needsYouTitle"), needs, "ap-needs-you")}
      {ready.length > 0 ? (
        <section className="flex flex-col gap-2" data-testid="ap-ready">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-ink">
              {t("ap.list.ready", { amount: readyTotal })}
            </h3>
            {onDecide ? (
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                data-testid="ap-approve-ready"
                onClick={() => void onDecide({ action: "approve_ready", input: {} })}
              >
                {t("ap.list.approveReady")}
              </Button>
            ) : null}
          </div>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {ready.map((b) => (
              <BillRow key={b.id} bill={b} accounts={accounts} onDecide={onDecide} busy={busy} />
            ))}
          </ul>
        </section>
      ) : null}
      {group(t("ap.list.decided"), decided, "ap-decided")}
    </div>
  );
}

function BillRow({
  bill,
  accounts,
  onDecide,
  busy,
}: {
  bill: Bill;
  accounts: readonly Account[];
  onDecide?: ((d: PayListDecision) => Promise<boolean>) | undefined;
  busy: boolean;
}) {
  const { t, fmt, intl } = useI18n();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const live = onDecide && (bill.status === "open" || bill.status === "held");
  const flagged = !bill.ready;
  const act = async (d: PayListDecision) => {
    if (onDecide && (await onDecide(d))) setNote("");
  };
  return (
    <li className="flex flex-col gap-2 p-3" data-testid="ap-bill">
      <button
        type="button"
        className="flex flex-wrap items-center gap-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="font-medium text-ink">{bill.vendorName ?? "—"}</span>
        <span className="text-sm text-ink-muted">{bill.invoiceNumber ?? ""}</span>
        {bill.dueDate ? (
          <span className="text-sm text-ink-muted">
            {t("ap.bill.due", { day: dayLabel(bill.dueDate, intl) })}
          </span>
        ) : null}
        <span className="ds-num ml-auto text-ink">{fmt.money(bill.amount, bill.currency)}</span>
        <Badge tone={STATUS_TONE[bill.status]}>{t(STATUS_LABEL[bill.status])}</Badge>
      </button>
      <div className="flex flex-wrap gap-1">
        <span className="text-xs text-ink-muted">
          {bill.order?.reference
            ? t("ap.bill.order", { reference: bill.order.reference })
            : t("ap.bill.noOrder")}
        </span>
        {bill.flags.map((f) => (
          <Badge
            key={`${f.kind}-${f.lineNo ?? 0}-${f.sources.join(",")}`}
            tone={FLAG_TONE[f.severity]}
          >
            {t(flagLabel(f.kind))}
            {f.impact ? ` ${fmt.money(f.impact, bill.currency)}` : ""}
          </Badge>
        ))}
      </div>
      {bill.decisionNote ? (
        <p className="text-sm text-ink">
          {bill.decidedBy ? `${bill.decidedBy}: ` : ""}
          {bill.decisionNote}
        </p>
      ) : null}
      {open ? (
        <ul className="flex flex-col gap-1 text-sm" data-testid="ap-bill-lines">
          {bill.lines.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2">
              <span className="text-ink">{l.description}</span>
              {l.qty ? (
                <span className="ds-num text-ink-muted">
                  {l.qty} {l.unit ?? ""} × {fmt.money(l.unitPrice ?? "0", bill.currency)}
                </span>
              ) : null}
              <span className="ds-num ml-auto text-ink">{fmt.money(l.amount, bill.currency)}</span>
              {live && !l.account ? (
                <>
                  {l.proposal ? (
                    <Button
                      size="sm"
                      disabled={busy}
                      title={l.proposal.reason ?? undefined}
                      onClick={() =>
                        void act({ action: "take_proposal", input: { billLineId: l.id } })
                      }
                    >
                      {t("ap.bill.take", { account: l.proposal.account.name })}
                    </Button>
                  ) : null}
                  <select
                    className="ds-select"
                    aria-label={t("ap.bill.account")}
                    value=""
                    disabled={busy}
                    onChange={(e) =>
                      e.target.value &&
                      void act({
                        action: "code_line",
                        input: { billLineId: l.id, ledgerAccountId: e.target.value },
                      })
                    }
                  >
                    <option value="">{t("ap.bill.chooseAccount")}</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.number ? `${a.number} ${a.name}` : a.name}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <span className="text-ink-muted">
                  {l.account?.name ?? t("ap.bill.chooseAccount")}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {live ? (
        <div className="flex flex-wrap items-center gap-2">
          {bill.matchStatus === "proposed" ? (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void act({ action: "confirm_order", input: { billId: bill.id } })}
              >
                {t("ap.bill.confirmOrder")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void act({ action: "not_this_order", input: { billId: bill.id } })}
              >
                {t("ap.bill.notThisOrder")}
              </Button>
            </>
          ) : null}
          {bill.flags.some((f) => f.kind === "not_received") ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void act({ action: "received", input: { billId: bill.id } })}
            >
              {t("ap.bill.received")}
            </Button>
          ) : null}
          <input
            className="ds-input min-w-48 flex-1"
            aria-label={t("ap.bill.note")}
            placeholder={t("ap.bill.note")}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button
            size="sm"
            variant="primary"
            disabled={busy || (flagged && !note.trim())}
            data-testid="ap-approve"
            onClick={() =>
              void act({
                action: "approve",
                input: { billId: bill.id, ...(note.trim() ? { note: note.trim() } : {}) },
              })
            }
          >
            {t("ap.bill.approve")}
          </Button>
          <Button
            size="sm"
            disabled={busy || !note.trim()}
            onClick={() =>
              void act({ action: "hold", input: { billId: bill.id, note: note.trim() } })
            }
          >
            {t("ap.bill.hold")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !note.trim()}
            onClick={() =>
              void act({ action: "reject", input: { billId: bill.id, note: note.trim() } })
            }
          >
            {t("ap.bill.reject")}
          </Button>
        </div>
      ) : null}
    </li>
  );
}
