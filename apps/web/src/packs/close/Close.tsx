// The Close pack's screens (docs/plan.md §1.232), loaded on their own (never in the first load):
// the close report (each month's checklist, its journal entries and who signed it off; portal and
// back office) and the sign-off card, where a person waives a line with a reason, turns down an
// entry, and signs the month off once nothing is open. Led by the result and its numbers. The
// checklist's sentences come from the API in English, as other server-side words do.
import { type CSSProperties, useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import type { ResolveInput } from "../../inbox/InboxCard";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";
import { dayLabel } from "../../usage/format";
import {
  type CloseMonth,
  type CloseReport,
  ENTRY_LABEL,
  ENTRY_TONE,
  ITEM_LABEL,
  ITEM_TONE,
  KIND_LABEL,
} from "./types";

const PACK = "close";
const REPORT = "close";

interface Actions {
  busy: boolean;
  waive(itemId: string, note: string): void;
  unwaive(itemId: string): void;
  reject(entryId: string): void;
}

/** One month: the result, its checklist and its journal entries. */
export function CloseMonthView({ close, actions }: { close: CloseMonth; actions?: Actions }) {
  const { t, fmt, intl } = useI18n();
  const p = close.period;
  const money = (v: string, currency = p.currency) => fmt.money(v, currency);
  const [waiving, setWaiving] = useState<{ id: string; note: string } | null>(null);
  return (
    <div className="flex flex-col gap-4" data-testid="close-month">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">
          {t("close.periodOf", {
            start: dayLabel(p.periodStart, intl),
            end: dayLabel(p.periodEnd, intl),
          })}
        </span>
        {p.status === "signed_off" ? (
          <Badge tone="person" testId="close-signed-off">
            {t("close.status.signed_off")}
          </Badge>
        ) : close.readyToSignOff ? (
          <Badge tone="positive" testId="close-ready">
            {t("close.ready")}
          </Badge>
        ) : (
          <Badge tone="warning" testId="close-open">
            {t("close.linesOpen", { count: close.open })}
          </Badge>
        )}
      </div>
      {p.status === "signed_off" && p.signedOffAt ? (
        <p className="text-sm text-ink">
          {t("close.signedOffBy", {
            name: p.signedOffBy ?? "",
            day: dayLabel(p.signedOffAt.slice(0, 10), intl),
          })}
          {p.note ? ` · ${p.note}` : ""}
        </p>
      ) : null}

      <SectionLabel>{t("close.checklist")}</SectionLabel>
      {close.items.length === 0 ? (
        <EmptyState>{t("close.notChecked")}</EmptyState>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="close-items">
          {close.items.map((i) => (
            <li key={i.id} className="ds-card flex flex-col gap-1 p-3" data-testid="close-item">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={ITEM_TONE[i.status]}>{t(ITEM_LABEL[i.status])}</Badge>
                <span className="font-medium">{i.title}</span>
                {i.amount && i.status !== "done" && !/^0+(\.0+)?$/.test(i.amount) ? (
                  <span className="ds-num text-sm">{money(i.amount)}</span>
                ) : null}
              </div>
              {i.summary ? <p className="text-sm text-ink">{i.summary}</p> : null}
              {i.status === "waived" && i.note ? (
                <p className="text-sm text-ink-muted">
                  {t("close.waivedBecause", { note: i.note })}
                </p>
              ) : null}
              {actions && i.status === "open" && waiving?.id !== i.id ? (
                <div>
                  <Button
                    size="sm"
                    disabled={actions.busy}
                    onClick={() => setWaiving({ id: i.id, note: "" })}
                    data-testid="close-waive"
                  >
                    {t("close.waive")}
                  </Button>
                </div>
              ) : null}
              {actions && waiving?.id === i.id ? (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className="ds-input"
                    value={waiving.note}
                    maxLength={500}
                    placeholder={t("close.waiveReason")}
                    aria-label={t("close.waiveReason")}
                    onChange={(e) => setWaiving({ id: i.id, note: e.target.value })}
                    data-testid="close-waive-note"
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={actions.busy || !waiving.note.trim()}
                    onClick={() => {
                      actions.waive(i.id, waiving.note.trim());
                      setWaiving(null);
                    }}
                    data-testid="close-waive-save"
                  >
                    {t("close.waive")}
                  </Button>
                  <Button size="sm" onClick={() => setWaiving(null)}>
                    {t("common.cancel")}
                  </Button>
                </div>
              ) : null}
              {actions && i.status === "waived" ? (
                <div>
                  <Button size="sm" disabled={actions.busy} onClick={() => actions.unwaive(i.id)}>
                    {t("close.unwaive")}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <SectionLabel>{t("close.entries")}</SectionLabel>
      {close.entries.length === 0 ? (
        <EmptyState>{t("close.noEntries")}</EmptyState>
      ) : (
        <div className="dt dt-ana" style={{ "--dt-max-h": "520px" } as CSSProperties}>
          <div className="dt-scroll">
            <table data-testid="close-entries">
              <thead>
                <tr className="dt-cols">
                  <th>{t("close.date")}</th>
                  <th>{t("close.entry")}</th>
                  <th className="n">{t("close.amount")}</th>
                  <th>{t("close.statusCol")}</th>
                </tr>
              </thead>
              <tbody>
                {close.entries.map((e) => (
                  <tr key={e.id} data-testid="close-entry">
                    <td>{dayLabel(e.txnDate, intl)}</td>
                    <td className="dt-who">
                      <b>{t(KIND_LABEL[e.kind])}</b> {e.memo}
                      {e.reason ? <div className="text-sm text-ink-muted">{e.reason}</div> : null}
                      <div className="text-sm">
                        {e.lines.map((l) => (
                          <div key={`${l.posting}-${l.accountName}-${l.amount}`}>
                            {t(l.posting === "debit" ? "close.debit" : "close.credit")}{" "}
                            {l.accountName}{" "}
                            <span className="ds-num">{money(l.amount, e.currency)}</span>
                          </div>
                        ))}
                      </div>
                      {e.error ? <div className="text-sm text-risk">{e.error}</div> : null}
                    </td>
                    <td className="n ds-num">{money(e.amount, e.currency)}</td>
                    <td>
                      <div className="flex flex-col items-start gap-1">
                        <Badge tone={e.write ? "warning" : ENTRY_TONE[e.status]}>
                          {e.write ? t("close.entry.waitingSignature") : t(ENTRY_LABEL[e.status])}
                        </Badge>
                        {actions &&
                        !e.write &&
                        (e.status === "proposed" || e.status === "failed") ? (
                          <Button
                            size="sm"
                            disabled={actions.busy}
                            onClick={() => actions.reject(e.id)}
                            data-testid="close-reject"
                          >
                            {t("close.reject")}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** The close report: the months, and one month in full (the latest unless one is picked). */
export function CloseReportView({ clientId }: { clientId?: string }) {
  const { t, intl } = useI18n();
  const [periodId, setPeriodId] = useState<string | null>(null);
  const query = periodId ? { periodId } : undefined;
  const portal = useApi(
    apiRoutes.portalPackReport,
    clientId ? null : { params: { pack: PACK, report: REPORT }, ...(query ? { query } : {}) },
  );
  const ops = useApi(
    apiRoutes.opsClientPackReport,
    clientId
      ? { params: { id: clientId, pack: PACK, report: REPORT }, ...(query ? { query } : {}) }
      : null,
  );
  const { data, error, loading, reload } = clientId ? ops : portal;
  if (loading && !data) return <Loading label={t("close.loading")} />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  const report = (data?.report ?? { periods: [], close: null }) as unknown as CloseReport;
  return (
    <div className="flex flex-col gap-6" data-testid="close-report">
      <PageHeader title={t("close.title")} subtitle={t("close.description")} />
      {report.periods.length === 0 || !report.close ? (
        <EmptyState>{t("close.empty")}</EmptyState>
      ) : (
        <>
          <label className="flex items-center gap-2 text-sm">
            {t("close.month")}
            <select
              className="ds-input"
              value={report.close.period.id}
              onChange={(e) => setPeriodId(e.target.value)}
              data-testid="close-period"
            >
              {report.periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {dayLabel(p.periodEnd, intl)} ·{" "}
                  {p.status === "signed_off"
                    ? t("close.status.signed_off")
                    : t("close.linesOpen", { count: p.open })}
                </option>
              ))}
            </select>
          </label>
          <CloseMonthView close={report.close} />
        </>
      )}
    </div>
  );
}

/** The sign-off card: the month with its decisions, and the sign-off once nothing is open. */
export function CloseSignOffCard({
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
  const { t } = useI18n();
  const client = useApiClient();
  const route = surface === "ops" ? apiRoutes.opsPackReview : apiRoutes.portalPackReview;
  const decideRoute =
    surface === "ops" ? apiRoutes.opsPackReviewDecide : apiRoutes.portalPackReviewDecide;
  const { data, error, loading, reload } = useApi(route, { params: { id: itemId } });
  const [view, setView] = useState<CloseMonth | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  if (loading && !data) return <Loading label={t("close.loading")} />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;
  const close = view ?? (data.data as unknown as { close: CloseMonth | null }).close;
  if (!close) return <EmptyState>{t("close.empty")}</EmptyState>;
  const canDecide = data.canDecide && open && close.period.status === "open";

  async function decide(action: string, input: Record<string, unknown>) {
    setBusy(true);
    setProblem(null);
    try {
      const res = await client.call(decideRoute, {
        params: { id: itemId },
        body: { action, input },
      });
      setView((res.data as unknown as { close: CloseMonth }).close);
      return true;
    } catch (e) {
      setProblem(e);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const actions: Actions | undefined = canDecide
    ? {
        busy,
        waive: (itemId, n) => void decide("waive", { itemId, note: n }),
        unwaive: (itemId) => void decide("unwaive", { itemId }),
        reject: (entryId) => void decide("reject", { entryId }),
      }
    : undefined;

  return (
    <div className="flex flex-col gap-4" data-testid="close-signoff">
      <CloseMonthView close={close} {...(actions ? { actions } : {})} />
      {problem ? <ErrorNotice error={problem} /> : null}
      {canDecide ? (
        <div className="flex flex-col gap-2">
          {close.blockers.length > 0 ? (
            <ul className="text-sm text-ink" data-testid="close-blockers">
              {close.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : null}
          <input
            className="ds-input"
            value={note}
            maxLength={1000}
            placeholder={t("close.signOffNote")}
            aria-label={t("close.signOffNote")}
            onChange={(e) => setNote(e.target.value)}
            data-testid="close-signoff-note"
          />
          <div>
            <Button
              variant="primary"
              disabled={busy || !close.readyToSignOff}
              onClick={async () => {
                if (await decide("sign_off", { note: note.trim() || null })) {
                  if (onResolve) await onResolve({ decision: "approve" });
                }
              }}
              data-testid="close-signoff-button"
            >
              {t("close.signOff")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Screens ──────────────────────────────────────────────────────────────────────────────────────

export const PortalCloseScreen = () => <CloseReportView />;
