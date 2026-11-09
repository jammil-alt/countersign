// B-6 (docs/plan.md §1.79): the booking review card. The bank transactions we weren't sure of, each
// with our suggestion and why; a person approves it, books it to another account (with a word on
// why, kept as their note on that account, and a rule if they like), or leaves it out. Done sends
// the review back to the waiting run. Payees and account names are data and show as written.
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import type { ResolveInput } from "../../inbox/InboxCard";
import { Badge, Button, ErrorNotice, Loading } from "../../ui/primitives";
import { dayLabel } from "../../usage/format";
import {
  type BookingsReviewData,
  DECIDABLE,
  type ReviewTransaction,
  STATUS_LABEL,
  STATUS_TONE,
} from "./types";

export function BookingsReview({
  itemId,
  surface,
  open,
  onResolve,
}: {
  itemId: string;
  surface: "portal" | "ops";
  open: boolean;
  onResolve: ((body: ResolveInput) => Promise<void>) | null;
}) {
  const { t, fmt, intl } = useI18n();
  const client = useApiClient();
  const route = surface === "ops" ? apiRoutes.opsPackReview : apiRoutes.portalPackReview;
  const decideRoute =
    surface === "ops" ? apiRoutes.opsPackReviewDecide : apiRoutes.portalPackReviewDecide;
  const { data, error, loading, reload } = useApi(route, { params: { id: itemId } });
  const [view, setView] = useState<BookingsReviewData | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [why, setWhy] = useState<Record<string, string>>({});
  const [rule, setRule] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);

  if (loading && !data) return <Loading label={t("bookkeeping.review.loading")} />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const review = view ?? (data.data as unknown as BookingsReviewData);
  const canDecide = data.canDecide && open;
  const left = review.transactions.filter((x) => DECIDABLE.includes(x.status)).length;

  async function decide(txn: ReviewTransaction, action: "approve" | "book" | "exclude") {
    setBusy(txn.id);
    setProblem(null);
    try {
      const account = pick[txn.id] ?? txn.booking?.lines[0]?.ledgerAccountId ?? "";
      const input =
        action === "book"
          ? {
              bankTxnId: txn.id,
              lines: [{ ledgerAccountId: account }],
              ...(why[txn.id]?.trim() ? { why: why[txn.id]?.trim() } : {}),
              ...(rule[txn.id] ? { makeRule: true } : {}),
            }
          : { bankTxnId: txn.id };
      const res = await client.call(decideRoute, {
        params: { id: itemId },
        body: { action, input },
      });
      setView(res.data as unknown as BookingsReviewData);
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="bookings-review">
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
        {review.transactions.map((txn) => {
          const suggestion = txn.booking?.lines[0]?.account ?? null;
          const chosen = pick[txn.id] ?? txn.booking?.lines[0]?.ledgerAccountId ?? "";
          const decidable = canDecide && DECIDABLE.includes(txn.status);
          const payee = txn.payee ?? txn.description ?? "";
          return (
            <li key={txn.id} className="flex flex-col gap-2 p-4" data-testid="bookings-review-txn">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-ink">{payee}</p>
                  <p className="text-sm text-ink-muted">
                    {[
                      dayLabel(txn.date, intl),
                      `${txn.direction === "in" ? "+" : "−"}${fmt.money(txn.amount, txn.currency)}`,
                      [txn.account.name, txn.account.mask ? `…${txn.account.mask}` : null]
                        .filter(Boolean)
                        .join(" "),
                    ].join(" · ")}
                  </p>
                  <p className="text-sm text-ink">
                    {suggestion
                      ? t("bookkeeping.review.suggested", { account: suggestion })
                      : t("bookkeeping.review.noSuggestion")}
                    {txn.booking?.reason ? (
                      <span className="text-ink-muted">{` · ${txn.booking.reason}`}</span>
                    ) : null}
                  </p>
                </div>
                <Badge
                  tone={decidable ? "warning" : STATUS_TONE[txn.status]}
                  testId="bookings-review-state"
                >
                  {decidable ? t("common.waitingOnYou") : t(STATUS_LABEL[txn.status])}
                </Badge>
              </div>
              {decidable ? (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className="ds-select min-w-64 flex-1"
                      aria-label={t("bookkeeping.review.account", { payee })}
                      data-testid="bookings-review-account"
                      value={chosen}
                      onChange={(e) => setPick((c) => ({ ...c, [txn.id]: e.target.value }))}
                    >
                      {chosen === "" ? <option value="" /> : null}
                      {review.accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {[a.number, a.fullName].filter(Boolean).join(" ")}
                        </option>
                      ))}
                    </select>
                    <input
                      className="ds-input min-w-48 flex-1"
                      aria-label={t("bookkeeping.review.why")}
                      placeholder={t("bookkeeping.review.why")}
                      maxLength={500}
                      value={why[txn.id] ?? ""}
                      onChange={(e) => setWhy((c) => ({ ...c, [txn.id]: e.target.value }))}
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={rule[txn.id] ?? false}
                      onChange={(e) => setRule((c) => ({ ...c, [txn.id]: e.target.checked }))}
                    />
                    {t("bookkeeping.review.rule")}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {txn.booking && !pick[txn.id] && !why[txn.id] && !rule[txn.id] ? (
                      <Button
                        size="sm"
                        variant="primary"
                        data-testid="bookings-review-approve"
                        disabled={busy !== null}
                        onClick={() => void decide(txn, "approve")}
                      >
                        {t("bookkeeping.review.approve")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        data-testid="bookings-review-book"
                        disabled={busy !== null || chosen === ""}
                        onClick={() => void decide(txn, "book")}
                      >
                        {t("bookkeeping.review.book")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      data-testid="bookings-review-exclude"
                      disabled={busy !== null}
                      onClick={() => void decide(txn, "exclude")}
                    >
                      {t("bookkeeping.review.exclude")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {problem ? <ErrorNotice error={problem} /> : null}
      {canDecide && onResolve ? (
        <div className="flex items-center justify-end gap-3">
          <span className="text-sm text-ink-muted">
            {left === 0
              ? t("bookkeeping.review.allDone")
              : t("bookkeeping.review.left", { left, count: review.transactions.length })}
          </span>
          <Button
            variant="primary"
            data-testid="bookings-review-finish"
            disabled={busy !== null}
            onClick={() => void onResolve({ decision: "approve", answer: { left } })}
          >
            {t("bookkeeping.review.done")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
