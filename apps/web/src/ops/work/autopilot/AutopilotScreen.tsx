// `/ops/autopilot` and `/ops/autopilot/:flow` (docs/plan.md §1.124.4; docs/design/pipelines.html
// `autopilot()`): what Reggie does in each stage of each flow and how far it goes on its own. Every
// play starts at "Draft for me". A play that is always yours shows its lock and can't be set to
// send (the server refuses it too, 409 always_yours). Internal plays read Off, Suggest, On.
import {
  AUTOPILOT_WORDS,
  type AutopilotView,
  PLAY_FLOW_IDS,
  PLAY_FLOW_WORDS,
  type PlayFlow,
  type PlayLevel,
  type PlayView,
} from "@countersign/core";
import { useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { apiRoutes } from "../../../api/routes";
import { useApi, useApiClient } from "../../../api/useApi";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Icon } from "../../../ui/icons";
import { Page } from "../../../ui/page";
import { Loading, PageHeader } from "../../../ui/primitives";
import { OPS_PATHS } from "../../paths";
import { PageTabs } from "../parts";

const LEVELS: PlayLevel[] = ["off", "draft", "send"];

export function AutopilotScreen() {
  const { flow = "new" } = useParams();
  const state = useApi(apiRoutes.opsAutopilot, {});
  if (!(PLAY_FLOW_IDS as readonly string[]).includes(flow)) {
    return <Navigate to={OPS_PATHS.autopilot} replace />;
  }
  return (
    <Page testId="autopilot">
      <PageHeader title={AUTOPILOT_WORDS.title} subtitle={AUTOPILOT_WORDS.lede} />
      <PageTabs
        label="Flows"
        tabs={PLAY_FLOW_IDS.map((f) => ({
          to: OPS_PATHS.autopilotFlow(f),
          label: PLAY_FLOW_WORDS[f],
          current: f === flow,
        }))}
      />
      {state.error ? <ErrorNotice error={state.error} onRetry={state.reload} /> : null}
      {state.loading && !state.data ? <Loading /> : null}
      {state.data ? (
        <FlowView view={state.data} flow={flow as PlayFlow} reload={state.reload} />
      ) : null}
    </Page>
  );
}

function FlowView({
  view,
  flow,
  reload,
}: {
  view: AutopilotView;
  flow: PlayFlow;
  reload: () => void;
}) {
  const f = view.flows.find((x) => x.flow === flow);
  return (
    <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col gap-4">
        {(f?.stages ?? []).map((s) => (
          <section key={s.stage} className="ds-card p-4" data-testid={`autopilot-stage-${s.stage}`}>
            <h3 className="type-heading mb-2 text-ink">{s.name}</h3>
            <ul className="flex flex-col divide-y divide-line">
              {s.plays.map((p) => (
                <PlayRow key={p.key} play={p} reload={reload} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      <aside className="flex flex-col gap-4">
        <section className="ds-card p-4" data-testid="autopilot-always-yours">
          <div className="ds-eyebrow mb-2">{AUTOPILOT_WORDS.alwaysYours}</div>
          <ul className="flex flex-col gap-2 text-sm">
            {view.alwaysYours.map((line) => (
              <li key={line} className="flex gap-2">
                <Icon name="sign" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 mb-0 text-xs text-ink-muted">{view.secrets}</p>
        </section>
        <section className="ds-card p-4" data-testid="autopilot-targets">
          <div className="ds-eyebrow mb-2">{AUTOPILOT_WORDS.targets}</div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {view.targets.map((t) => (
              <div key={t.label} className="contents">
                <dt className="text-ink-muted">{t.label}</dt>
                <dd className="m-0">{t.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </aside>
    </div>
  );
}

function PlayRow({ play, reload }: { play: PlayView; reload: () => void }) {
  const api = useApiClient();
  const [level, setLevel] = useState<PlayLevel>(play.level);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const words = play.internal ? AUTOPILOT_WORDS.internalLevels : AUTOPILOT_WORDS.levels;
  const set = async (next: PlayLevel) => {
    setBusy(true);
    setError(null);
    try {
      const out = await api.call(apiRoutes.opsSetPlay, {
        params: { flow: play.flow, stage: play.stage, play: play.key },
        body: { level: next },
      });
      setLevel(out.level);
      reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li
      className="grid gap-3 py-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,220px)]"
      data-testid={`play-${play.stage}-${play.key}`}
    >
      <div className="min-w-0">
        <div className="font-medium text-ink">{play.name}</div>
        <div className="text-sm text-ink-muted">
          {play.when}
          {play.does ? ` · ${play.does}` : ""}
        </div>
      </div>
      <div>
        <fieldset className="ds-seg" aria-label={`How far: ${play.name}`} disabled={busy}>
          {LEVELS.map((l) => {
            const locked = l === "send" && !play.maySend;
            return (
              <button
                key={l}
                type="button"
                aria-pressed={level === l}
                disabled={locked}
                title={locked ? (play.locked ?? undefined) : undefined}
                onClick={() => void set(l)}
              >
                {words[l]}
              </button>
            );
          })}
        </fieldset>
        {play.locked ? (
          <div className="mt-1 flex items-center gap-1 text-xs text-ink-muted">
            <Icon name="sign" />
            {play.locked}
          </div>
        ) : null}
      </div>
      <div className="text-xs text-ink-muted">
        {play.trackLine}
        {play.ready && level === "draft" ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="ds-pill ds-pill--warning ds-pill--sm">{AUTOPILOT_WORDS.ready}</span>
            <button type="button" className="ds-btn ds-btn--link" onClick={() => void set("send")}>
              {AUTOPILOT_WORDS.letSend}
            </button>
          </div>
        ) : null}
        {error ? <ErrorNotice error={error} /> : null}
      </div>
    </li>
  );
}
