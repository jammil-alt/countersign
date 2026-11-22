// Go live (docs/setup-plan.md §7; docs/plan.md §1.185, SU6): pick the agent (with one, it opens),
// read its scope in your words (what it does, reads and may change, who signs and answers, your
// choices, what is still open), sign it (the client admin), then what happens next. Signing never
// starts the trial: the lead does, and every change waits for a signature until you say otherwise
// (invariant 8). Read from `/api/getting-started` and the scope route: the client's own words only.
import { type GettingStartedView, gettingStartedRoutes, type ScopeView } from "@countersign/core";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useApi, useApiClient } from "../../../api/useApi";
import type { PlainKey } from "../../../i18n/catalog";
import { useI18n } from "../../../i18n/i18n";
import { Loaded } from "../../../ui/page";
import { Badge, Button, Card, ErrorNotice } from "../../../ui/primitives";
import { PORTAL_PATHS } from "../../paths";
import { ChapterFrame } from "./ChapterFrame";

export function LiveChapterScreen() {
  const { agentId } = useParams();
  const overview = useApi(gettingStartedRoutes.portalGettingStarted);
  return (
    <ChapterFrame chapter="live">
      <Loaded state={overview}>{(view) => <Live view={view} agentId={agentId ?? null} />}</Loaded>
    </ChapterFrame>
  );
}

const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Live({ view, agentId }: { view: GettingStartedView; agentId: string | null }) {
  const { t } = useI18n();
  const picked = agentId ?? (view.agents.length === 1 ? (view.agents[0]?.agentId ?? null) : null);
  const leadName = view.lead?.name ?? null;
  if (!picked && view.agents.length === 0) {
    return <p className="text-ink-muted">{t("setup.live.none")}</p>;
  }
  return (
    <div className="flex flex-col gap-6" data-testid="start-live">
      {view.agents.length > 1 ? (
        <nav className="flex flex-col gap-2" aria-label={t("setup.live.pick")}>
          {picked ? null : <p className="text-ink-muted">{t("setup.live.pick")}</p>}
          <Card>
            {view.agents.map((a) => {
              const unsigned = a.left.some((l) => l.key === "scope");
              const current = a.agentId === picked;
              return (
                <Link
                  key={a.agentId}
                  to={PORTAL_PATHS.startLive(a.agentId)}
                  aria-current={current ? "page" : undefined}
                  className={
                    current
                      ? "flex items-center justify-between gap-3 border-t border-line bg-surface-subtle px-5 py-3 first:border-t-0"
                      : "flex items-center justify-between gap-3 border-t border-line px-5 py-3 first:border-t-0 hover:bg-surface-subtle"
                  }
                  data-testid={`start-live-agent-${a.agentId}`}
                >
                  <span className="text-ink">{a.name}</span>
                  <Badge tone={unsigned ? "warning" : "positive"}>
                    {unsigned ? t("setup.live.toSign") : t("setup.live.signed")}
                  </Badge>
                </Link>
              );
            })}
          </Card>
        </nav>
      ) : null}
      {picked ? <ScopeLoader key={picked} agentId={picked} leadName={leadName} /> : null}
    </div>
  );
}

function ScopeLoader({ agentId, leadName }: { agentId: string; leadName: string | null }) {
  const state = useApi(gettingStartedRoutes.portalSetupScope, { params: { id: agentId } });
  return <Loaded state={state}>{(d) => <Scope initial={d.scope} leadName={leadName} />}</Loaded>;
}

const ROWS: { key: keyof ScopeView; label: PlainKey }[] = [
  { key: "does", label: "setup.live.does" },
  { key: "reads", label: "setup.live.reads" },
  { key: "changes", label: "setup.live.changes" },
  { key: "signs", label: "setup.live.signs" },
  { key: "answers", label: "setup.live.answers" },
  { key: "choices", label: "setup.live.choices" },
  { key: "open", label: "setup.live.open" },
];

function Scope({ initial, leadName }: { initial: ScopeView; leadName: string | null }) {
  const i18n = useI18n();
  const { t } = i18n;
  const lead = leadName ?? t("setup.live.yourLead");
  const api = useApiClient();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setView(initial), [initial]);

  async function sign() {
    setBusy(true);
    setError(null);
    try {
      const out = await api.call(gettingStartedRoutes.portalSetupScopeSign, {
        params: { id: view.agentId },
      });
      setView(out.scope);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const signedNow = view.signed !== null && view.signed.version === view.version;
  const body = signedNow
    ? t("setup.live.signedBy", {
        name: view.signed?.byName ?? "",
        date: i18n.fmt.date(view.signed?.at ?? new Date().toISOString()),
        lead: capFirst(lead),
      })
    : view.canSign
      ? `${
          view.signed
            ? `${t("setup.live.signedOlder", { version: String(view.signed.version) })} `
            : ""
        }${t("setup.live.signBody", { lead })}`
      : t("setup.live.adminSigns", { lead });

  return (
    <div className="flex flex-col gap-6">
      <Card pad testId="start-live-scope">
        <p className="ds-eyebrow mb-4">
          {t("setup.live.eyebrow", { agent: view.name, version: String(view.version) })}
        </p>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-[11rem_minmax(0,1fr)]">
          {ROWS.map((row) => {
            const value = view[row.key];
            const lines = Array.isArray(value) ? (value as string[]) : [String(value)];
            return (
              <div key={row.key} className="contents" data-testid={`start-live-${row.key}`}>
                <dt className="text-sm text-ink-muted">{t(row.label)}</dt>
                <dd className="text-ink">
                  {lines.length === 0 ? (
                    <span className="text-ink-muted">{t("setup.live.nothing")}</span>
                  ) : lines.length === 1 ? (
                    lines[0]
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {lines.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </Card>

      <article className="mz-sign" data-testid="start-live-sign">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {signedNow ? (
            <Badge tone="positive" testId="start-live-signed">
              {t("setup.live.signed")}
            </Badge>
          ) : (
            <Badge tone="warning" testId="start-live-waiting">
              {view.canSign ? t("setup.live.waiting") : t("setup.live.waitingAdmin")}
            </Badge>
          )}
          <span className="ds-eyebrow">{t("setup.live.yourScope")}</span>
        </div>
        <h3 className="mz-sign__title">{t("setup.live.ready", { agent: view.name })}</h3>
        <p className="mz-sign__body" data-testid="start-live-sign-body">
          {body}
        </p>
        {error ? <ErrorNotice error={error} /> : null}
        <div className="mz-sign__foot">
          {leadName ? (
            <span className="mz-person mz-person--lead">
              {t("setup.live.checkedBy", { lead: leadName })}
            </span>
          ) : (
            <span />
          )}
          {view.canSign ? (
            <Button
              variant="primary"
              working={busy}
              onClick={() => void sign()}
              data-testid="start-live-sign-button"
            >
              {t("setup.live.sign")}
            </Button>
          ) : null}
        </div>
      </article>

      <section data-testid="start-live-next">
        <h2 className="type-subheading mb-3 text-ink">{t("setup.live.next")}</h2>
        <ol className="flex flex-col gap-4 border-l border-line pl-4">
          {[
            {
              when: t("setup.live.next.today"),
              what: t("setup.live.next.todayBody"),
              now: !signedNow,
            },
            {
              when: t("setup.live.next.start"),
              what: t("setup.live.next.startBody", { lead: capFirst(lead) }),
              now: signedNow,
            },
            {
              when: t("setup.live.next.trial", { days: String(view.trialDays) }),
              what: t("setup.live.next.trialBody"),
              now: false,
            },
            {
              when: t("setup.live.next.checkin"),
              what: t("setup.live.next.checkinBody", { lead }),
              now: false,
            },
            {
              when: t("setup.live.next.after"),
              what: t("setup.live.next.afterBody"),
              now: false,
            },
          ].map((step) => (
            <li
              key={step.when}
              className={step.now ? "-ml-[17px] border-l-2 border-slate pl-[15px]" : undefined}
            >
              <p className="text-sm font-medium text-ink">{step.when}</p>
              <p className="text-sm text-ink-muted">{step.what}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
