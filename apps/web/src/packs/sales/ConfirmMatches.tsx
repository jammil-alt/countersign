// Confirm matches (docs/plan.md §1.164): the Sales pack's card `sales.match`. The rows of a
// spreadsheet the match wasn't sure of come first, each with the sheet's values beside the
// suggested CRM record's, the differences marked, the confidence in words with its number and how
// the row was found. A person approves the suggestion, picks another candidate, looks up any synced
// record, or says No match; the rows the match settled are folded under "Matched" with "Approve all
// High". Finish sends the card back to the waiting run, which gets the confirmed matches as
// recorded (the API builds the answer, never this screen).
//
// Colours (brand book): a row waiting is signal with "Waiting on you"; a person's decision copper;
// the agent's matches stay ink. Sheet values and CRM records are data and show as written. The
// client's Desk and the back office's Escalations both show it; its words come from the message
// catalog (`sales.review.*`).
import { useEffect, useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import type { ResolveInput } from "../../inbox/InboxCard";
import { useDebounced } from "../../runs/useDebounced";
import { Badge, Button, cx, ErrorNotice, Loading } from "../../ui/primitives";
import {
  CONFIDENCE_LABEL,
  FIELD_LABEL,
  FOUND_LABEL,
  type LookupRecord,
  type MatchCandidate,
  type MatchRow,
  type SalesMatchData,
} from "./types";

type Decision =
  | { action: "approve"; input: { index: number } }
  | { action: "pick"; input: { index: number; recordKeyId: string } }
  | { action: "lookup"; input: { index: number; recordKeyId: string } }
  | { action: "no_match"; input: { index: number } }
  | { action: "approve_high"; input: Record<string, never> };

/** One record's values as one line: name, company, email (as written). */
function recordLine(values: Record<string, string>): string {
  return [values.name, values.deal, values.company, values.email, values.phone]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" · ");
}

function lookupLine(r: LookupRecord): string {
  return [r.name, r.deal, r.company, r.email, r.stage, r.amount]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" · ");
}

export function ConfirmMatches({
  itemId,
  surface,
  open,
  onResolve,
}: {
  itemId: string;
  surface: "portal" | "ops";
  open: boolean;
  /** Null when this person can't resolve the item. */
  onResolve: ((body: ResolveInput) => Promise<void>) | null;
}) {
  const { t } = useI18n();
  const client = useApiClient();
  const route = surface === "ops" ? apiRoutes.opsPackReview : apiRoutes.portalPackReview;
  const decideRoute =
    surface === "ops" ? apiRoutes.opsPackReviewDecide : apiRoutes.portalPackReviewDecide;
  const { data, error, loading, reload } = useApi(route, { params: { id: itemId } });
  const [view, setView] = useState<SalesMatchData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);

  if (loading && !data) return <Loading label={t("sales.review.loading")} />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const review = view ?? (data.data as unknown as SalesMatchData);
  const canDecide = data.canDecide && open;
  const unsure = review.rows.filter((r) => r.agent.decision === "unsure");
  const none = review.rows.filter((r) => r.agent.decision === "none");
  const matched = review.rows.filter((r) => r.agent.decision === "matched");
  const waiting = review.rows.filter((r) => r.decision === "unsure").length;
  const highLeft = matched.filter(
    (r) => r.decidedBy === "agent" && r.agent.confidence === "high",
  ).length;

  async function decide(key: string, body: Decision) {
    setBusy(key);
    setProblem(null);
    try {
      const res = await client.call(decideRoute, { params: { id: itemId }, body });
      setView(res.data as unknown as SalesMatchData);
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(null);
    }
  }

  const row = (r: MatchRow) => (
    <RowCard
      key={r.index}
      itemId={itemId}
      surface={surface}
      row={r}
      modules={review.modules}
      canDecide={canDecide}
      busy={busy !== null}
      onDecide={(body) => void decide(`row-${r.index}`, body)}
    />
  );

  return (
    <div className="flex flex-col gap-4" data-testid="sales-match-review">
      {unsure.length > 0 ? (
        <section className="flex flex-col gap-2" data-testid="sales-match-unsure">
          <h3 className="text-sm font-medium text-ink">
            {t("sales.review.unsure", { count: unsure.length })}
          </h3>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {unsure.map(row)}
          </ul>
        </section>
      ) : null}
      {none.length > 0 ? (
        <details className="rounded-md border border-line" data-testid="sales-match-none">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink">
            {t("sales.review.noneFound", { count: none.length })}
          </summary>
          <ul className="flex flex-col divide-y divide-line border-t border-line">
            {none.map(row)}
          </ul>
        </details>
      ) : null}
      {matched.length > 0 ? (
        <details className="rounded-md border border-line" data-testid="sales-match-matched">
          <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-3">
            <span className="text-sm font-medium text-ink">
              {t("sales.review.matched", { count: matched.length })}
            </span>
            {canDecide && highLeft > 0 ? (
              <Button
                size="sm"
                data-testid="sales-match-approve-high"
                disabled={busy !== null}
                onClick={(e) => {
                  e.preventDefault();
                  void decide("high", { action: "approve_high", input: {} });
                }}
              >
                {t("sales.review.approveHigh", { count: highLeft })}
              </Button>
            ) : null}
          </summary>
          <ul className="flex flex-col divide-y divide-line border-t border-line">
            {matched.map(row)}
          </ul>
        </details>
      ) : null}
      {problem ? <ErrorNotice error={problem} /> : null}
      {canDecide && onResolve ? (
        <div className="flex items-center justify-end gap-3">
          <span className="text-sm text-ink-muted" data-testid="sales-match-left">
            {waiting === 0
              ? t("sales.review.allDecided")
              : t("sales.review.left", { left: waiting, count: review.rows.length })}
          </span>
          <Button
            variant="primary"
            data-testid="sales-match-finish"
            disabled={waiting > 0 || busy !== null}
            onClick={() =>
              void onResolve({ decision: "approve", answer: { reviewed: review.rows.length } })
            }
          >
            {t("sales.review.finish")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** A row's state as a word: waiting (signal), a person's (copper), or the agent's (ink). */
function RowState({ row, canDecide }: { row: MatchRow; canDecide: boolean }) {
  const { t } = useI18n();
  if (row.decision === "unsure") {
    return (
      <Badge tone="warning" testId="sales-match-state">
        {t(canDecide ? "common.waitingOnYou" : "common.waiting")}
      </Badge>
    );
  }
  if (row.decidedBy === "person") {
    return (
      <Badge tone="person" testId="sales-match-state">
        {t(row.decision === "none" ? "sales.review.noMatch" : "sales.review.confirmed")}
      </Badge>
    );
  }
  return (
    <span className="text-sm text-ink" data-testid="sales-match-state">
      {t(row.decision === "none" ? "sales.review.noneWord" : "sales.review.matchedWord")}
    </span>
  );
}

function RowCard({
  itemId,
  surface,
  row,
  modules,
  canDecide,
  busy,
  onDecide,
}: {
  itemId: string;
  surface: "portal" | "ops";
  row: MatchRow;
  modules: string[];
  canDecide: boolean;
  busy: boolean;
  onDecide: (body: Decision) => void;
}) {
  const { t, intl } = useI18n();
  const sure = new Intl.NumberFormat(intl, { style: "percent", maximumFractionDigits: 0 });
  const [pick, setPick] = useState<string>("");
  const [looking, setLooking] = useState(false);
  const others: MatchCandidate[] = row.candidates.filter(
    (c) => !c.vetoed && c.recordKeyId !== row.record?.recordKeyId,
  );
  const person = row.decidedBy === "person";
  const found = person ? "person" : row.agent.found;
  const fieldLabel = (field: string) => {
    const key = FIELD_LABEL[field];
    return key ? t(key) : field;
  };
  return (
    <li
      className={cx("flex flex-col gap-3 p-4", row.decision === "unsure" && "bg-signal-tint/40")}
      data-testid="sales-match-row"
      data-row={row.index}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="font-medium text-ink">{t("sales.review.row", { n: row.index + 1 })}</p>
          <p className="text-sm text-ink-muted" data-testid="sales-match-confidence">
            {t("sales.review.confidence", {
              word: t(CONFIDENCE_LABEL[row.agent.confidence]),
              sure: sure.format(row.agent.score),
            })}
            {found ? ` · ${t(FOUND_LABEL[found])}` : ""}
          </p>
        </div>
        <RowState row={row} canDecide={canDecide} />
      </div>

      {row.compare.length > 0 ? (
        <table className="w-full text-sm" data-testid="sales-match-compare">
          <thead>
            <tr className="text-left text-ink-muted">
              <th className="py-1 pr-3 font-normal" scope="col">
                <span className="sr-only">{t("sales.review.fieldColumn")}</span>
              </th>
              <th className="py-1 pr-3 font-normal" scope="col">
                {t("sales.review.sheet")}
              </th>
              <th className="py-1 font-normal" scope="col">
                {row.suggested ? t("sales.review.suggested") : t("sales.review.record")}
                {row.record ? ` · ${row.record.module}` : ""}
              </th>
            </tr>
          </thead>
          <tbody>
            {row.compare.map((c) => (
              <tr
                key={c.field}
                className="border-t border-line align-top"
                data-testid="sales-match-field"
                data-differs={c.differs ? "true" : "false"}
              >
                <th scope="row" className="py-1 pr-3 text-left font-normal text-ink-muted">
                  {fieldLabel(c.field)}
                </th>
                <td className={cx("py-1 pr-3 text-ink", c.differs && "font-medium")}>
                  {c.sheet ?? "—"}
                </td>
                <td className={cx("py-1 text-ink", c.differs && "font-medium")}>
                  {c.record ?? "—"}
                  {c.differs ? (
                    <Badge className="ml-2" testId="sales-match-differs">
                      {t("sales.review.differs")}
                    </Badge>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-ink-muted">{t("sales.review.noValues")}</p>
      )}

      {canDecide ? (
        <div className="flex flex-wrap items-center gap-2">
          {row.record && !(person && row.decision === "matched") ? (
            <Button
              size="sm"
              variant="primary"
              data-testid="sales-match-approve"
              disabled={busy}
              onClick={() => onDecide({ action: "approve", input: { index: row.index } })}
            >
              {t("sales.review.approve")}
            </Button>
          ) : null}
          {others.length > 0 ? (
            <>
              <select
                className="ds-select min-w-56 flex-1"
                aria-label={t("sales.review.pick", { n: row.index + 1 })}
                data-testid="sales-match-candidate"
                value={pick}
                onChange={(e) => setPick(e.target.value)}
              >
                <option value="">{t("sales.review.another")}</option>
                {others.map((c) => (
                  <option key={c.recordKeyId} value={c.recordKeyId}>
                    {t("sales.review.candidate", {
                      record: recordLine(c.values),
                      word: t(CONFIDENCE_LABEL[c.confidence]),
                      sure: sure.format(c.score),
                    })}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                data-testid="sales-match-use"
                disabled={busy || !pick}
                onClick={() =>
                  onDecide({ action: "pick", input: { index: row.index, recordKeyId: pick } })
                }
              >
                {t("sales.review.use")}
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            data-testid="sales-match-lookup-open"
            aria-expanded={looking}
            disabled={busy}
            onClick={() => setLooking((v) => !v)}
          >
            {t("sales.review.lookUp")}
          </Button>
          {row.decision !== "none" || !person ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="sales-match-none"
              disabled={busy}
              onClick={() => onDecide({ action: "no_match", input: { index: row.index } })}
            >
              {t("sales.review.noMatch")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {canDecide && looking ? (
        <LookUp
          itemId={itemId}
          surface={surface}
          modules={modules}
          busy={busy}
          onChoose={(recordKeyId) => {
            setLooking(false);
            onDecide({ action: "lookup", input: { index: row.index, recordKeyId } });
          }}
        />
      ) : null}
    </li>
  );
}

/** The look-up: one of the batch's modules, what a person types, the client's records found. */
function LookUp({
  itemId,
  surface,
  modules,
  busy,
  onChoose,
}: {
  itemId: string;
  surface: "portal" | "ops";
  modules: string[];
  busy: boolean;
  onChoose: (recordKeyId: string) => void;
}) {
  const { t } = useI18n();
  const client = useApiClient();
  const [module, setModule] = useState(modules[0] ?? "");
  const [q, setQ] = useState("");
  // The server is asked once typing pauses, not once a letter (docs/audit-plan.md 2.4).
  const typed = useDebounced(q.trim());
  const [found, setFound] = useState<{ q: string; records: LookupRecord[] } | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const route =
    surface === "ops" ? apiRoutes.opsPackReviewLookup : apiRoutes.portalPackReviewLookup;

  useEffect(() => {
    if (!typed) {
      setFound(null);
      return;
    }
    let live = true;
    setProblem(null);
    client
      .call(route, { params: { id: itemId }, query: { q: typed, module } })
      .then((res) => {
        if (live) setFound({ q: typed, records: res.records as unknown as LookupRecord[] });
      })
      .catch((e: unknown) => {
        if (live) setProblem(e);
      });
    return () => {
      live = false;
    };
  }, [client, route, itemId, typed, module]);

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-line bg-surface p-3"
      data-testid="sales-match-lookup"
    >
      <div className="flex flex-wrap gap-2">
        {modules.length > 1 ? (
          <select
            className="ds-select w-40"
            aria-label={t("sales.review.module")}
            data-testid="sales-match-lookup-module"
            value={module}
            onChange={(e) => setModule(e.target.value)}
          >
            {modules.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : null}
        <input
          className="ds-input min-w-56 flex-1"
          type="search"
          aria-label={t("sales.review.search", { module })}
          placeholder={t("sales.review.searchHint")}
          data-testid="sales-match-lookup-q"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {problem ? <ErrorNotice error={problem} /> : null}
      {found && found.records.length === 0 ? (
        <p className="text-sm text-ink-muted">{t("sales.review.nothingFound", { q: found.q })}</p>
      ) : null}
      {found && found.records.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line" data-testid="sales-match-lookup-results">
          {found.records.map((r) => (
            <li key={r.recordKeyId} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 text-sm text-ink">{lookupLine(r)}</span>
              <Button
                size="sm"
                data-testid="sales-match-lookup-choose"
                disabled={busy}
                onClick={() => onChoose(r.recordKeyId)}
              >
                {t("sales.review.choose")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
