// R-1 (docs/plan.md §1.80): the reconciliation card. Two numbers led by the result (each side's
// balance, the difference and what isn't explained), then what is left on each side with its label,
// our suggested matches to accept or reject, what matched (which a person can undo), a way to add
// what one side is missing, and the sign-off, open only once nothing is unexplained. The items'
// words come from banks, statements and QuickBooks and show as written.
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import type { ResolveInput } from "../../inbox/InboxCard";
import { Badge, Button, ErrorNotice, Loading, SectionLabel } from "../../ui/primitives";
import { dayLabel } from "../../usage/format";
import {
  LABEL_WORDS,
  METHOD_WORDS,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  RECON_STATUS_LABEL,
  type ReconciliationView,
  type ReconItem,
  type ReconLabel,
} from "./types";

const LABELS: ReconLabel[] = ["timing", "missing", "amount_differs", "duplicate"];

export function ReconciliationReview({
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
  const [view, setView] = useState<ReconciliationView | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState({ side: "a", date: "", effect: "", description: "" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  if (loading && !data) return <Loading label={t("bookkeeping.recon.loading")} />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const r = view ?? (data.data as unknown as { reconciliation: ReconciliationView }).reconciliation;
  const canDecide = data.canDecide && open && r.status === "open";
  const money = (v: string) => fmt.money(v, r.currency);
  const byId = new Map(r.items.map((i) => [i.id, i]));
  const left = r.items.filter((i) => i.state === "unmatched");
  const proposals = r.matches.filter((m) => m.status === "proposed");
  const accepted = r.matches.filter((m) => m.status === "accepted");
  // A decimal string, compared as text: "0.0000" is zero (money is never a float).
  const unexplained = !/^-?0+(\.0+)?$/.test(r.residual);

  async function decide(action: string, input: Record<string, unknown>) {
    setBusy(true);
    setProblem(null);
    try {
      const res = await client.call(decideRoute, {
        params: { id: itemId },
        body: { action, input },
      });
      setView((res.data as unknown as { reconciliation: ReconciliationView }).reconciliation);
      return true;
    } catch (e) {
      setProblem(e);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function matchPicked() {
    const ids = [...picked];
    const ok = await decide("match", {
      aItemIds: ids.filter((id) => byId.get(id)?.side === "a"),
      bItemIds: ids.filter((id) => byId.get(id)?.side === "b"),
    });
    if (ok) setPicked(new Set());
  }

  async function addItem() {
    const ok = await decide("add_item", {
      side: adding.side,
      date: adding.date || null,
      effect: adding.effect.trim(),
      description: adding.description.trim(),
    });
    if (ok) setAdding({ side: adding.side, date: "", effect: "", description: "" });
  }

  async function signOff() {
    if (await decide("sign_off", { note: note.trim() || null })) {
      if (onResolve) await onResolve({ decision: "approve" });
    }
  }

  const sideLabel = (side: "a" | "b") => (side === "a" ? r.aLabel : r.bLabel);
  const describe = (i: ReconItem) =>
    [i.date ? dayLabel(i.date, intl) : null, i.description ?? i.reference ?? i.ref]
      .filter(Boolean)
      .join(" · ");
  const pickedSides = new Set([...picked].map((id) => byId.get(id)?.side));

  return (
    <div className="flex flex-col gap-4" data-testid="reconciliation-review">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="reconciliation-numbers">
        <Figure label={r.aLabel} value={money(r.aClosing)} />
        <Figure label={r.bLabel} value={money(r.bClosing)} />
        <Figure label={t("bookkeeping.recon.difference")} value={money(r.difference)} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={OUTCOME_TONE[r.outcome]} testId="reconciliation-outcome">
          {t(OUTCOME_LABEL[r.outcome])}
        </Badge>
        {unexplained ? (
          <span className="text-sm text-risk" data-testid="reconciliation-residual">
            {t("bookkeeping.recon.unexplainedBy", { amount: money(r.residual) })}
          </span>
        ) : null}
        <span className="text-sm text-ink-muted">
          {t("bookkeeping.recon.asOf", { day: dayLabel(r.asOf, intl) })}
        </span>
        {r.status !== "open" ? (
          <Badge tone={r.status === "signed_off" ? "person" : "neutral"}>
            {t(RECON_STATUS_LABEL[r.status])}
          </Badge>
        ) : null}
      </div>

      {proposals.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionLabel>{t("bookkeeping.recon.suggestions")}</SectionLabel>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {proposals.map((m) => (
              <li
                key={m.id}
                className="flex flex-col gap-2 p-3"
                data-testid="reconciliation-proposal"
              >
                <p className="text-sm text-ink">
                  {[...m.aItemIds, ...m.bItemIds]
                    .map((id) => byId.get(id))
                    .filter((i): i is ReconItem => !!i)
                    .map((i) => `${sideLabel(i.side)}: ${money(i.effect)} (${describe(i)})`)
                    .join(" = ")}
                </p>
                {m.reason ? <p className="text-sm text-ink-muted">{m.reason}</p> : null}
                {canDecide ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      data-testid="reconciliation-accept"
                      onClick={() => void decide("accept", { matchId: m.id })}
                    >
                      {t("bookkeeping.recon.accept")}
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void decide("reject", { matchId: m.id })}
                    >
                      {t("bookkeeping.recon.reject")}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <SectionLabel>{t("bookkeeping.recon.left")}</SectionLabel>
        {left.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("bookkeeping.recon.nothingLeft")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {left.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-center gap-3 p-3"
                data-testid="reconciliation-leftover"
              >
                {canDecide ? (
                  <input
                    type="checkbox"
                    className="ds-check"
                    aria-label={t("bookkeeping.recon.pick", { item: describe(i) })}
                    checked={picked.has(i.id)}
                    onChange={(e) =>
                      setPicked((c) => {
                        const next = new Set(c);
                        if (e.target.checked) next.add(i.id);
                        else next.delete(i.id);
                        return next;
                      })
                    }
                  />
                ) : null}
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">
                    <b>{sideLabel(i.side)}</b> · {describe(i)}
                  </p>
                  {i.carried ? (
                    <p className="text-xs text-ink-muted">{t("bookkeeping.recon.carried")}</p>
                  ) : null}
                </div>
                <span className="ds-num text-sm">{money(i.effect)}</span>
                {canDecide ? (
                  <select
                    className="ds-select"
                    aria-label={t("bookkeeping.recon.labelFor", { item: describe(i) })}
                    value={i.label ?? ""}
                    disabled={busy}
                    onChange={(e) =>
                      void decide("label", { itemId: i.id, label: e.target.value || null })
                    }
                  >
                    <option value="">{t("bookkeeping.recon.label.none")}</option>
                    {LABELS.map((l) => (
                      <option key={l} value={l}>
                        {t(LABEL_WORDS[l])}
                      </option>
                    ))}
                  </select>
                ) : i.label ? (
                  <Badge tone="neutral">{t(LABEL_WORDS[i.label])}</Badge>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canDecide && picked.size > 0 ? (
          <div>
            <Button
              size="sm"
              variant="primary"
              disabled={busy || pickedSides.size < 2}
              data-testid="reconciliation-match"
              onClick={() => void matchPicked()}
            >
              {t("bookkeeping.recon.matchPicked")}
            </Button>
          </div>
        ) : null}
      </section>

      {accepted.length > 0 ? (
        <details className="rounded-md border border-line p-3">
          <summary className="cursor-pointer text-sm text-ink">
            {t("bookkeeping.recon.matched", { count: accepted.length })}
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {accepted.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
                data-testid="reconciliation-matched"
              >
                <span className="text-ink">
                  {m.aItemIds
                    .map((id) => byId.get(id))
                    .filter((i): i is ReconItem => !!i)
                    .map((i) => `${money(i.effect)} (${describe(i)})`)
                    .join(", ")}{" "}
                  · {t(METHOD_WORDS[m.method])}
                </span>
                {canDecide ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void decide("unmatch", { matchId: m.id })}
                  >
                    {t("bookkeeping.recon.unmatch")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {canDecide ? (
        <section className="flex flex-col gap-2" data-testid="reconciliation-add">
          <SectionLabel>{t("bookkeeping.recon.add")}</SectionLabel>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="ds-select"
              aria-label={t("bookkeeping.recon.addSide")}
              value={adding.side}
              onChange={(e) => setAdding((c) => ({ ...c, side: e.target.value }))}
            >
              <option value="a">{r.aLabel}</option>
              <option value="b">{r.bLabel}</option>
            </select>
            <input
              type="date"
              className="ds-input"
              aria-label={t("bookkeeping.recon.addDate")}
              value={adding.date}
              onChange={(e) => setAdding((c) => ({ ...c, date: e.target.value }))}
            />
            <input
              className="ds-input w-32"
              inputMode="decimal"
              aria-label={t("bookkeeping.recon.addAmount")}
              placeholder="-12.50"
              value={adding.effect}
              onChange={(e) => setAdding((c) => ({ ...c, effect: e.target.value }))}
            />
            <input
              className="ds-input min-w-48 flex-1"
              aria-label={t("bookkeeping.recon.addWhat")}
              placeholder={t("bookkeeping.recon.addWhat")}
              maxLength={500}
              value={adding.description}
              onChange={(e) => setAdding((c) => ({ ...c, description: e.target.value }))}
            />
            <Button
              size="sm"
              disabled={busy || !adding.effect.trim() || !adding.description.trim()}
              data-testid="reconciliation-add-button"
              onClick={() => void addItem()}
            >
              {t("bookkeeping.recon.addButton")}
            </Button>
          </div>
        </section>
      ) : null}

      {problem ? <ErrorNotice error={problem} /> : null}
      {r.note ? <p className="text-sm text-ink">{r.note}</p> : null}
      {canDecide ? (
        <div className="flex flex-col items-end gap-2">
          <input
            className="ds-input w-full"
            aria-label={t("bookkeeping.recon.note")}
            placeholder={t("bookkeeping.recon.note")}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {unexplained ? (
            <p className="text-sm text-ink-muted">
              {t("bookkeeping.recon.cantSign", { amount: money(r.residual) })}
            </p>
          ) : null}
          <Button
            variant="primary"
            disabled={busy || unexplained}
            data-testid="reconciliation-sign-off"
            onClick={() => void signOff()}
          >
            {t("bookkeeping.recon.signOff")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line p-3">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="ds-num text-lg text-ink">{value}</p>
    </div>
  );
}
