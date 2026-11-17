// An enhancement (docs/plan.md §1.123.1): the asks it groups (each in its client's words), the
// decision (do it, later, no or sell it: yours) and, once shipped, the note everyone who asked
// is told. "Sell it" hands over to Sales with the enhancement as the deal's origin.
import { type EnhancementDetail, PIPELINES, type WorkEnhancementDecision } from "@countersign/core";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiRoutes } from "../../../api/routes";
import { useApi, useApiClient } from "../../../api/useApi";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Page } from "../../../ui/page";
import { Button, Loading } from "../../../ui/primitives";
import { OPS_PATHS } from "../../paths";
import { Due, StandingPill, shortDate } from "../parts";

const DECISIONS: [WorkEnhancementDecision, string][] = [
  ["do", "Do it"],
  ["later", "Later"],
  ["no", "No"],
  ["sell", "Sell it"],
];

export function EnhancementPage() {
  const { id = "" } = useParams();
  const state = useApi(apiRoutes.opsEnhancement, { params: { id } });
  return (
    <Page testId="ops-enhancement">
      {state.error ? <ErrorNotice error={state.error} onRetry={state.reload} /> : null}
      {state.loading && !state.data ? <Loading /> : null}
      {state.data ? <EnhancementView detail={state.data} reload={state.reload} /> : null}
    </Page>
  );
}

function EnhancementView({ detail, reload }: { detail: EnhancementDetail; reload: () => void }) {
  const api = useApiClient();
  const e = detail.enhancement;
  const [note, setNote] = useState(e.decisionNote ?? "");
  const [told, setTold] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="ui-crumbs mb-2 text-sm">
        <Link to={OPS_PATHS.buildWork}>Build</Link> ›{" "}
        <Link to={OPS_PATHS.buildTab("enh")}>Enhancements</Link>
      </div>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="type-title text-ink">{e.title}</h1>
          {e.description ? <p className="mt-1 text-ink-muted">{e.description}</p> : null}
          <p className="mt-1 text-sm text-ink-muted">
            {e.asks} client{e.asks === 1 ? "" : "s"} asked · Decide by{" "}
            <Due iso={e.decideBy} done={e.standing === "done"} />
          </p>
        </div>
        <StandingPill standing={e.standing} line={e.statusLine} />
      </header>
      {error ? <ErrorNotice error={error} /> : null}
      <fieldset className="m-0 mb-4 flex flex-wrap gap-1 border-0 p-0" aria-label="Stage">
        {PIPELINES.enh.stages.map((s) => (
          <span
            key={s.id}
            className={`ds-pill ds-pill--sm ${s.id === e.stage ? "ds-pill--warning" : "ds-pill--neutral"}`}
          >
            {s.name}
          </span>
        ))}
      </fieldset>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="ds-card p-4" data-testid="enhancement-asks">
          <div className="eyebrow mb-2 text-ink-muted">Who asked</div>
          {detail.asks.length === 0 ? (
            <p className="text-sm text-ink-muted">No asks grouped yet.</p>
          ) : null}
          <ul className="flex flex-col gap-3">
            {detail.asks.map((a) => (
              <li key={a.id}>
                <div className="text-sm">
                  <Link to={OPS_PATHS.client(a.client.id)}>{a.client.name}</Link>
                  {a.raisedBy ? ` · ${a.raisedBy}` : ""} · {shortDate(a.createdAt)}
                </div>
                <p className="whitespace-pre-wrap">{a.text}</p>
              </li>
            ))}
          </ul>
        </section>
        <aside className="flex flex-col gap-4">
          <section className="ds-card p-4" data-testid="enhancement-decide">
            <div className="eyebrow mb-2 text-ink-muted">Decide</div>
            <textarea
              className="ds-textarea w-full"
              rows={3}
              placeholder="Why, in a line the clients can read"
              value={note}
              onChange={(ev) => setNote(ev.target.value)}
              aria-label="Decision note"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              {DECISIONS.map(([d, label]) => (
                <Button
                  key={d}
                  size="sm"
                  variant={e.decision === d ? "primary" : "secondary"}
                  disabled={busy || e.stage === "shipped"}
                  onClick={() =>
                    void run(() =>
                      api.call(apiRoutes.opsDecideEnhancement, {
                        params: { id: e.id },
                        body: { decision: d, note },
                      }),
                    )
                  }
                >
                  {label}
                </Button>
              ))}
            </div>
            {e.decision === "sell" ? (
              <Link
                className="ds-btn ds-btn--secondary ds-btn--sm mt-3"
                to={`/ops/sales/grow?from=enhancement:${e.id}`}
                data-testid="enhancement-sell"
              >
                Open a deal in Sales
              </Link>
            ) : null}
          </section>
          {e.decision && e.decision !== "no" && e.stage !== "shipped" ? (
            <section className="ds-card p-4" data-testid="enhancement-told">
              <div className="eyebrow mb-2 text-ink-muted">Shipped: tell everyone who asked</div>
              <textarea
                className="ds-textarea w-full"
                rows={3}
                value={told}
                onChange={(ev) => setTold(ev.target.value)}
                aria-label="What shipped"
              />
              <Button
                variant="primary"
                size="sm"
                className="mt-2"
                disabled={busy || !told.trim()}
                onClick={() =>
                  void run(() =>
                    api.call(apiRoutes.opsToldEnhancement, {
                      params: { id: e.id },
                      body: { note: told },
                    }),
                  )
                }
              >
                Tell them
              </Button>
            </section>
          ) : null}
        </aside>
      </div>
    </>
  );
}
