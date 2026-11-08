// Search (M45, docs/plan.md §1.75): a site's Search Console and Bing figures for the last 28 days
// the data covers, against the 28 before: impressions, clicks, click-through rate and position;
// the top queries and pages; the searches close to page one (positions 8 to 20); and the pages
// losing ground with the query that fell most. Every figure says the day the data runs to, and
// anything with fewer than 20 impressions is marked a small sample. The sources card says where
// each provider's figures come from and lets the operator point a site at one of the client's
// connections (the client admin enters the keys in the portal). Queries are what people searched
// for, shown as text.
import { type ReactNode, useState } from "react";
import { useApiClient } from "../../../api/useApi";
import { Delta, KpiStrip, StatTile } from "../../../ui/figures";
import { Icon } from "../../../ui/icons";
import {
  Button,
  buttonClass,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  SectionLabel,
  Tag,
} from "../../../ui/primitives";
import { dayLabel } from "../../../usage/format";
import { marketingCsvHref, runMarketingAction, useMarketingReport } from "./api";
import { MarketingLayout, useMarketingClientId } from "./layout";

type Provider = "google" | "bing";

interface Totals {
  impressions: number;
  clicks: number;
  ctr: string | null;
  position: number | null;
  smallSample: boolean;
}

interface SourceState {
  id: string;
  provider: Provider;
  connected: boolean;
  dataRunsTo: string | null;
  lastImportedAt: string | null;
  lastError: string | null;
}

export interface SearchReport {
  site: { id: string; domain: string; name: string } | null;
  provider: Provider | null;
  sources: SourceState[];
  dataRunsTo: string | null;
  period: { from: string; to: string };
  previous: { from: string; to: string };
  cappedToData: boolean;
  totals: Totals;
  previousTotals: Totals;
  daily: { day: string; impressions: number; clicks: number }[];
  queries: (Totals & { query: string; previousPosition: number | null; topPage: string | null })[];
  pages: (Totals & { path: string })[];
  closeToPageOne: {
    query: string;
    position: number;
    previousPosition: number | null;
    impressions: number;
    topPage: string | null;
    smallSample: boolean;
  }[];
  losingGround: {
    path: string;
    position: number;
    previousPosition: number;
    clicks: number;
    previousClicks: number;
    query: { query: string; position: number; previousPosition: number } | null;
  }[];
}

export interface SearchSourcesReport {
  sites: { id: string; domain: string; name: string }[];
  sources: {
    id: string;
    siteId: string;
    provider: Provider;
    connectionId: string | null;
    dataRunsTo: string | null;
    lastImportedAt: string | null;
    lastError: string | null;
  }[];
  connections: { id: string; provider: Provider; status: string; property: string | null }[];
}

const PROVIDER_NAME: Record<Provider, string> = { google: "Search Console", bing: "Bing" };
const PROVIDERS: Provider[] = ["google", "bing"];

const nf = new Intl.NumberFormat("en-US");
const day = (d: string | null | undefined) => (d ? dayLabel(d) : "–");
const pct = (rate: string | null) =>
  rate === null
    ? "–"
    : new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(
        Number(rate),
      );
const place = (p: number | null) => (p === null ? "–" : p.toFixed(1));

function SmallSample({ on }: { on: boolean }) {
  return on ? (
    <span className="text-ink-muted" title="Fewer than 20 impressions">
      {" "}
      · small sample
    </span>
  ) : null;
}

/** "Up 1.2 places": a lower position is better, so a fall in the number is up. */
function PositionChange({ now, before }: { now: number | null; before: number | null }) {
  if (now === null || before === null) return <span className="text-ink-muted">–</span>;
  return (
    <Delta
      now={before}
      before={now}
      words={(d, by) => (d === "same" ? "Same" : `${d === "up" ? "Up" : "Down"} ${by.toFixed(1)}`)}
    />
  );
}

function Sources({
  clientId,
  siteId,
  onChanged,
}: {
  clientId: string;
  siteId: string | null;
  onChanged: () => void;
}) {
  const api = useApiClient();
  const state = useMarketingReport<SearchSourcesReport>(
    clientId,
    "search-sources",
    siteId ? { site: siteId } : {},
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  if (state.loading && !state.data) return <Loading />;
  if (state.error) return <ErrorNotice error={state.error} onRetry={state.reload} />;
  const data = state.data;
  if (!data || !siteId) return null;
  const act = async (key: string, action: string, body: Record<string, unknown>) => {
    setBusy(key);
    setProblem(null);
    try {
      await runMarketingAction(api, clientId, action, body);
      state.reload();
      onChanged();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title="Where the figures come from" testId="marketing-search-sources" pad>
      <div className="flex flex-col gap-4">
        {PROVIDERS.map((provider) => {
          const source = data.sources.find((s) => s.siteId === siteId && s.provider === provider);
          const conns = data.connections.filter((c) => c.provider === provider);
          const choice = picked[provider] ?? conns[0]?.id ?? "";
          return (
            <div
              key={provider}
              className="flex flex-col gap-1"
              data-testid={`marketing-search-source-${provider}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{PROVIDER_NAME[provider]}</span>
                {source?.connectionId ? (
                  <Tag>Connected</Tag>
                ) : (
                  <span className="text-ink-muted">Not set up</span>
                )}
              </div>
              {source?.connectionId ? (
                <p className="text-sm text-ink-muted">
                  Figures run to {day(source.dataRunsTo)}
                  {source.lastImportedAt
                    ? ` · imported ${day(source.lastImportedAt.slice(0, 10))}`
                    : ""}
                </p>
              ) : null}
              {source?.lastError ? (
                <p
                  className="text-sm ui-tone-risk"
                  data-testid={`marketing-search-error-${provider}`}
                >
                  Last import: {source.lastError}
                </p>
              ) : null}
              {conns.length === 0 ? (
                <p className="text-sm text-ink-muted">
                  No {PROVIDER_NAME[provider]} connection yet. Offer it to the client, and its admin
                  enters the key under Connections in the portal.
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {source?.connectionId ? (
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      data-testid={`marketing-search-import-${provider}`}
                      onClick={() =>
                        act(`import-${provider}`, "import-search", { siteId, provider })
                      }
                    >
                      Build again from what's synced
                    </Button>
                  ) : (
                    <>
                      <select
                        className="ds-select"
                        aria-label={`${PROVIDER_NAME[provider]} connection`}
                        value={choice}
                        data-testid={`marketing-search-connection-${provider}-select`}
                        onChange={(e) => setPicked({ ...picked, [provider]: e.target.value })}
                      >
                        {conns.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.property ?? PROVIDER_NAME[provider]} ({c.status})
                          </option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!choice || busy !== null}
                        data-testid={`marketing-search-source-${provider}-save`}
                        onClick={() =>
                          act(`set-${provider}`, "set-search-source", {
                            siteId,
                            provider,
                            connectionId: choice,
                          })
                        }
                      >
                        Use for this site
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {problem ? (
          <p className="text-sm ui-tone-risk" role="alert">
            {problem}
          </p>
        ) : null}
        <p className="text-sm text-ink-muted">
          We read each one every night, final figures only: Google's stop two or three days back.
        </p>
      </div>
    </Card>
  );
}

function Table<T>({
  title,
  testId,
  rows,
  empty,
  head,
  row,
}: {
  title: string;
  testId: string;
  rows: readonly T[];
  empty: string;
  head: readonly (string | [string, "n"])[];
  row: (r: T) => ReactNode;
}) {
  return (
    <section>
      <SectionLabel>{title}</SectionLabel>
      {rows.length === 0 ? (
        <EmptyState testId={`${testId}-empty`}>{empty}</EmptyState>
      ) : (
        <div className="dt dt-ana">
          <div className="dt-scroll">
            <table data-testid={testId}>
              <thead>
                <tr className="dt-cols">
                  {head.map((h) =>
                    typeof h === "string" ? (
                      <th key={h}>{h}</th>
                    ) : (
                      <th key={h[0]} className="n">
                        {h[0]}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>{rows.map(row)}</tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

export function MarketingSearchScreen() {
  const clientId = useMarketingClientId();
  const [provider, setProvider] = useState<Provider | "">("");
  const [site, setSite] = useState("");
  const query = { site: site || undefined, provider: provider || undefined };
  const state = useMarketingReport<SearchReport>(clientId, "search", query);
  const data = state.data;
  return (
    <MarketingLayout
      title="Search"
      subtitle="What people searched for when your site showed up on Google and Bing."
      testId="marketing-search"
      actions={
        <a
          href={marketingCsvHref(clientId, "search", query)}
          download
          className={buttonClass("secondary")}
          data-testid="marketing-search-csv-download"
        >
          <Icon name="upload" size={16} className="ds-icon rotate-180" />
          Download queries
        </a>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="ds-seg" data-testid="marketing-search-provider">
          {(
            [
              ["", "Both"],
              ["google", "Google"],
              ["bing", "Bing"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value || "both"}
              type="button"
              aria-pressed={provider === value}
              data-testid={`marketing-search-provider-${value || "both"}-select`}
              onClick={() => setProvider(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {data?.site ? <SiteNames site={data.site} /> : null}
        <SitePicker clientId={clientId} value={site || data?.site?.id || ""} onChange={setSite} />
      </div>

      {state.loading && !data ? <Loading /> : null}
      {state.error ? <ErrorNotice error={state.error} onRetry={state.reload} /> : null}
      {data && !data.site ? (
        <EmptyState
          title="No site yet"
          line="Add the client's website under Sites, then point it at its Search Console and Bing connections here."
          testId="marketing-search-no-site"
        />
      ) : null}
      {data?.site ? (
        <>
          <p className="text-sm text-ink-muted" data-testid="marketing-search-runs-to">
            {data.dataRunsTo
              ? `Figures run to ${day(data.dataRunsTo)}. ${day(data.period.from)} to ${day(data.period.to)}, against the ${nf.format(daysIn(data.period))} days before.`
              : "No search figures yet: they come in the night after a source is set up."}
            {data.cappedToData ? " The period asked for runs past the data, so it ends there." : ""}
          </p>
          <KpiStrip testId="marketing-search-totals">
            <StatTile
              label="Impressions"
              value={nf.format(data.totals.impressions)}
              note={`${nf.format(data.previousTotals.impressions)} before${data.totals.smallSample ? " · small sample" : ""}`}
            />
            <StatTile
              label="Clicks"
              value={nf.format(data.totals.clicks)}
              note={`${nf.format(data.previousTotals.clicks)} before`}
            />
            <StatTile
              label="Click-through"
              value={pct(data.totals.ctr)}
              note={`${pct(data.previousTotals.ctr)} before`}
            />
            <StatTile
              label="Average position"
              value={place(data.totals.position)}
              mark={
                <PositionChange now={data.totals.position} before={data.previousTotals.position} />
              }
              note={`${place(data.previousTotals.position)} before`}
            />
          </KpiStrip>
          <p className="text-sm text-ink-muted">
            Totals count every search, including the ones Google keeps private; the lists below
            leave those out, so they don't add up to the totals.
          </p>

          <Table
            title="Close to page one"
            testId="marketing-search-near"
            rows={data.closeToPageOne}
            empty="No searches at positions 8 to 20 in this period."
            head={["Search", ["Position", "n"], ["Change", "n"], ["Impressions", "n"], "Page"]}
            row={(q) => (
              <tr key={q.query} data-testid="marketing-search-near-row">
                <td className="dt-who">
                  <b>{q.query}</b>
                  <SmallSample on={q.smallSample} />
                </td>
                <td className="n">{place(q.position)}</td>
                <td className="n">
                  <PositionChange now={q.position} before={q.previousPosition} />
                </td>
                <td className="n">{nf.format(q.impressions)}</td>
                <td>{q.topPage ?? "–"}</td>
              </tr>
            )}
          />

          <Table
            title="Losing ground"
            testId="marketing-search-losing"
            rows={data.losingGround}
            empty="No page fell a place or more against the period before."
            head={[
              "Page",
              ["Position", "n"],
              ["Before", "n"],
              ["Clicks", "n"],
              "Search that fell most",
            ]}
            row={(p) => (
              <tr key={p.path} data-testid="marketing-search-losing-row">
                <td className="dt-who">
                  <b>{p.path}</b>
                </td>
                <td className="n">{place(p.position)}</td>
                <td className="n">{place(p.previousPosition)}</td>
                <td className="n">
                  {nf.format(p.clicks)}{" "}
                  <span className="text-ink-muted">from {nf.format(p.previousClicks)}</span>
                </td>
                <td>
                  {p.query
                    ? `${p.query.query} (${place(p.query.previousPosition)} to ${place(p.query.position)})`
                    : "–"}
                </td>
              </tr>
            )}
          />

          <Table
            title="Searches"
            testId="marketing-search-queries"
            rows={data.queries}
            empty="No searches in this period."
            head={[
              "Search",
              ["Impressions", "n"],
              ["Clicks", "n"],
              ["Click-through", "n"],
              ["Position", "n"],
              "Page",
            ]}
            row={(q) => (
              <tr key={q.query} data-testid="marketing-search-query-row">
                <td className="dt-who">
                  <b>{q.query}</b>
                  <SmallSample on={q.smallSample} />
                </td>
                <td className="n">{nf.format(q.impressions)}</td>
                <td className="n">{nf.format(q.clicks)}</td>
                <td className="n">{pct(q.ctr)}</td>
                <td className="n">{place(q.position)}</td>
                <td>{q.topPage ?? "–"}</td>
              </tr>
            )}
          />

          <Table
            title="Pages"
            testId="marketing-search-pages"
            rows={data.pages}
            empty="No pages showed up in search in this period."
            head={[
              "Page",
              ["Impressions", "n"],
              ["Clicks", "n"],
              ["Click-through", "n"],
              ["Position", "n"],
            ]}
            row={(p) => (
              <tr key={p.path} data-testid="marketing-search-page-row">
                <td className="dt-who">
                  <b>{p.path}</b>
                  <SmallSample on={p.smallSample} />
                </td>
                <td className="n">{nf.format(p.impressions)}</td>
                <td className="n">{nf.format(p.clicks)}</td>
                <td className="n">{pct(p.ctr)}</td>
                <td className="n">{place(p.position)}</td>
              </tr>
            )}
          />

          <Sources clientId={clientId} siteId={data.site.id} onChanged={state.reload} />
        </>
      ) : null}
    </MarketingLayout>
  );
}

const daysIn = (p: { from: string; to: string }) =>
  Math.round((Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / 86_400_000) +
  1;

function SiteNames({ site }: { site: { domain: string } }) {
  return <span className="text-sm text-ink-muted">{site.domain}</span>;
}

/** A choice of the client's sites, shown only when there is more than one. */
function SitePicker({
  clientId,
  value,
  onChange,
}: {
  clientId: string;
  value: string;
  onChange: (site: string) => void;
}) {
  const sources = useMarketingReport<SearchSourcesReport>(clientId, "search-sources");
  const sites = sources.data?.sites ?? [];
  if (sites.length < 2) return null;
  return (
    <select
      className="ds-select"
      aria-label="Site"
      value={value}
      data-testid="marketing-search-site-select"
      onChange={(e) => onChange(e.target.value)}
    >
      {sites.map((s) => (
        <option key={s.id} value={s.id}>
          {s.domain}
        </option>
      ))}
    </select>
  );
}
