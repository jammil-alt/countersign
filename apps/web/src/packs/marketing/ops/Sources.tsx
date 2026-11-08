// Sources (M44, docs/marketing-plan.md §4.7): where visits came from, by group (direct, search,
// social, referral, campaign) with each group's names, against the days before. A campaign opens by
// its links (`utm_content`) and landing pages; a referring site opens in depth, set beside the
// whole site.
import { Link } from "react-router-dom";
import { KpiStrip, StatTile } from "../../../ui/figures";
import { Loaded, Section } from "../../../ui/page";
import { Button, Card, EmptyState } from "../../../ui/primitives";
import { marketingCsvHref, useMarketingReport } from "./api";
import {
  bandWords,
  CsvLink,
  countWords,
  DataTable,
  dayWords,
  MarketingFilters,
  MarketingLayout,
  type MedianBand,
  NoSite,
  PrivacyFooter,
  percentWords,
  type RangedReport,
  RangeLine,
  SmallSample,
  useKeptQuery,
  useMarketingClientId,
  useMarketingQuery,
  withKept,
} from "./layout";
import { MARKETING_PATHS } from "./paths";

interface SourceRow {
  key: string;
  group: string;
  name: string | null;
  visits: number;
  previousVisits: number;
  goals: number;
  goalRate: string | null;
  bounces: number;
  bounceRate: string | null;
  medianEngaged: MedianBand | null;
  smallSample: boolean;
}

export interface SourcesReport extends RangedReport {
  groups: (SourceRow & { names: SourceRow[] })[];
  campaign: {
    name: string;
    utmSource: string | null;
    utmMedium: string | null;
    visits: number;
    goals: number;
    goalRate: string | null;
    smallSample: boolean;
    days: { day: string; visits: number; goals: number }[];
    links: {
      content: string | null;
      path: string;
      visits: number;
      goals: number;
      goalRate: string | null;
      bounceRate: string | null;
      smallSample: boolean;
    }[];
  } | null;
  referrer: {
    host: string;
    group: string | null;
    visits: number;
    goals: number;
    goalRate: string | null;
    bounceRate: string | null;
    smallSample: boolean;
    site: { visits: number; goalRate: string | null; bounceRate: string | null };
    landedOn: { path: string; visits: number; goals: number }[];
    addresses: { path: string | null; visits: number }[];
    addressesFrom: string;
  } | null;
}

const GROUP_WORDS: Record<string, string> = {
  direct: "Direct",
  search: "Search",
  social: "Social",
  referral: "Other sites",
  campaign: "Campaigns",
  internal: "Within the site",
};

export function MarketingSourcesScreen() {
  const clientId = useMarketingClientId();
  const { query, set } = useMarketingQuery(["campaign", "referrer"]);
  const state = useMarketingReport<SourcesReport>(clientId, "sources", query);
  return (
    <MarketingLayout
      title="Sources"
      testId="marketing-sources"
      actions={<MarketingFilters sites={state.data?.sites} />}
    >
      <Loaded state={state}>
        {(r) =>
          !r.site ? (
            <NoSite clientId={clientId} />
          ) : (
            <div className="flex flex-col gap-6">
              <RangeLine range={r.range} />
              {r.campaign ? (
                <CampaignCard
                  c={r.campaign}
                  onClose={() => set({ campaign: null })}
                  clientId={clientId}
                />
              ) : null}
              {r.referrer ? (
                <ReferrerCard
                  f={r.referrer}
                  onClose={() => set({ referrer: null })}
                  clientId={clientId}
                />
              ) : null}
              {r.groups.length === 0 ? (
                <EmptyState
                  testId="marketing-sources-empty"
                  title="No visits in these days"
                  line="Sources show here the day after the first visit."
                />
              ) : (
                <SourceTable
                  r={r}
                  clientId={clientId}
                  open={(s) =>
                    s.group === "campaign"
                      ? set({ campaign: s.name, referrer: null })
                      : set({ referrer: s.name, campaign: null })
                  }
                />
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <PrivacyFooter />
                <CsvLink
                  href={marketingCsvHref(clientId, "sources", query)}
                  testId="marketing-sources-csv"
                />
              </div>
            </div>
          )
        }
      </Loaded>
    </MarketingLayout>
  );
}

function SourceTable({
  r,
  clientId,
  open,
}: {
  r: SourcesReport;
  clientId: string;
  open: (s: SourceRow) => void;
}) {
  const kept = useKeptQuery();
  const row = (s: SourceRow, named: boolean) => {
    // A campaign opens by its name; another site by its host (a referral's name is its host).
    const canOpen = named && s.name && (s.group === "campaign" || s.group === "referral");
    return (
      <tr key={s.key} data-testid={`marketing-sources-row-${s.key}`}>
        <td className={named ? "pl-6" : "font-medium text-ink"}>
          {named ? (
            canOpen ? (
              <button
                type="button"
                className="text-link hover:underline"
                onClick={() => open(s)}
                data-testid={`marketing-sources-open-${s.key}`}
              >
                {s.name}
              </button>
            ) : (
              <span>{s.name ?? "No name"}</span>
            )
          ) : (
            (GROUP_WORDS[s.group] ?? s.group)
          )}
          {s.smallSample ? (
            <span className="ml-2">
              <SmallSample />
            </span>
          ) : null}
        </td>
        <td className="n">
          <Link
            to={withKept(MARKETING_PATHS.visits(clientId), kept, { source: s.key })}
            className="text-link hover:underline"
          >
            {countWords(s.visits)}
          </Link>
        </td>
        <td className="n text-ink-muted">{countWords(s.previousVisits)}</td>
        <td className="n">{percentWords(s.goalRate, 1)}</td>
        <td className="n">{percentWords(s.bounceRate)}</td>
        <td className="whitespace-nowrap">{bandWords(s.medianEngaged)}</td>
      </tr>
    );
  };
  return (
    <DataTable testId="marketing-sources-table">
      <thead>
        <tr className="dt-cols">
          <th>Source</th>
          <th className="n">Visits</th>
          <th className="n">Days before</th>
          <th className="n">Goal rate</th>
          <th className="n">Left at once</th>
          <th>Median engaged</th>
        </tr>
      </thead>
      <tbody>
        {r.groups.flatMap((g) => [
          row(g, false),
          ...g.names.filter((n) => n.name !== null).map((n) => row(n, true)),
        ])}
      </tbody>
    </DataTable>
  );
}

function CampaignCard({
  c,
  onClose,
  clientId,
}: {
  c: NonNullable<SourcesReport["campaign"]>;
  onClose: () => void;
  clientId: string;
}) {
  const kept = useKeptQuery();
  return (
    <Card
      title={`Campaign: ${c.name}`}
      meta={
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          data-testid="marketing-sources-campaign-close"
        >
          Close
        </Button>
      }
      testId="marketing-sources-campaign"
    >
      <div className="ui-card__body flex flex-col gap-4">
        <p className="text-sm text-ink-muted">
          {[c.utmSource && `Source ${c.utmSource}`, c.utmMedium && `medium ${c.utmMedium}`]
            .filter(Boolean)
            .join(", ") || "No source or medium tags."}{" "}
          {c.days.length > 0
            ? `First visit in these days: ${dayWords(c.days[0]?.day ?? "")}.`
            : "No visits in these days."}
        </p>
        <KpiStrip>
          <StatTile
            label="Visits"
            value={countWords(c.visits)}
            note={c.smallSample ? <SmallSample /> : undefined}
          />
          <StatTile
            label="Goals"
            value={countWords(c.goals)}
            note={`${percentWords(c.goalRate, 1)} of visits`}
          />
        </KpiStrip>
        <DataTable testId="marketing-sources-campaign-links">
          <thead>
            <tr className="dt-cols">
              <th>Link (utm_content)</th>
              <th>Landed on</th>
              <th className="n">Visits</th>
              <th className="n">Goal rate</th>
              <th className="n">Left at once</th>
            </tr>
          </thead>
          <tbody>
            {c.links.map((l) => (
              <tr key={`${l.content}:${l.path}`}>
                <td>{l.content ?? "No tag"}</td>
                <td className="break-all">
                  <Link
                    to={withKept(MARKETING_PATHS.page(clientId, l.path), kept)}
                    className="text-link hover:underline"
                  >
                    {l.path}
                  </Link>
                </td>
                <td className="n">{countWords(l.visits)}</td>
                <td className="n">{percentWords(l.goalRate, 1)}</td>
                <td className="n">{percentWords(l.bounceRate)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </div>
    </Card>
  );
}

function ReferrerCard({
  f,
  onClose,
  clientId,
}: {
  f: NonNullable<SourcesReport["referrer"]>;
  onClose: () => void;
  clientId: string;
}) {
  const kept = useKeptQuery();
  return (
    <Card
      title={f.host}
      meta={
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          data-testid="marketing-sources-referrer-close"
        >
          Close
        </Button>
      }
      testId="marketing-sources-referrer"
    >
      <div className="ui-card__body flex flex-col gap-4">
        <KpiStrip>
          <StatTile
            label="Visits"
            value={countWords(f.visits)}
            note={
              f.smallSample ? <SmallSample /> : `${countWords(f.site.visits)} on the whole site`
            }
          />
          <StatTile
            label="Goal rate"
            value={percentWords(f.goalRate, 1)}
            note={`${percentWords(f.site.goalRate, 1)} on the whole site`}
          />
          <StatTile
            label="Left at once"
            value={percentWords(f.bounceRate)}
            note={`${percentWords(f.site.bounceRate)} on the whole site`}
          />
        </KpiStrip>
        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="Landed on">
            <DataTable>
              <thead>
                <tr className="dt-cols">
                  <th>Page</th>
                  <th className="n">Visits</th>
                  <th className="n">Goals</th>
                </tr>
              </thead>
              <tbody>
                {f.landedOn.map((l) => (
                  <tr key={l.path}>
                    <td className="break-all">
                      <Link
                        to={withKept(MARKETING_PATHS.page(clientId, l.path), kept)}
                        className="text-link hover:underline"
                      >
                        {l.path}
                      </Link>
                    </td>
                    <td className="n">{countWords(l.visits)}</td>
                    <td className="n">{countWords(l.goals)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </Section>
          <Section title="Linked from" meta={`Since ${dayWords(f.addressesFrom)}: kept 90 days`}>
            {f.addresses.length === 0 ? (
              <p className="text-sm text-ink-muted">No addresses kept for these days.</p>
            ) : (
              <DataTable>
                <thead>
                  <tr className="dt-cols">
                    <th>Their page</th>
                    <th className="n">Visits</th>
                  </tr>
                </thead>
                <tbody>
                  {f.addresses.map((a) => (
                    <tr key={a.path ?? "none"}>
                      <td className="break-all">{a.path ?? "Not given"}</td>
                      <td className="n">{countWords(a.visits)}</td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Section>
        </div>
      </div>
    </Card>
  );
}
