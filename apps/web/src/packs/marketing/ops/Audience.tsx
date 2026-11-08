// Audience (M44, docs/marketing-plan.md §4.7): where visitors are (a country table that opens into
// its regions, then a region's cities), when they read (day of the week by hour, in the client's
// own time zone), and on what (device, browser, operating system, language).
import { Columns, Loaded, Section } from "../../../ui/page";
import { Button, EmptyState } from "../../../ui/primitives";
import { marketingCsvHref, useMarketingReport } from "./api";
import {
  CsvLink,
  countWords,
  DataTable,
  durationWords,
  MarketingFilters,
  MarketingLayout,
  NoSite,
  PrivacyFooter,
  percentWords,
  type RangedReport,
  RangeLine,
  SmallSample,
  useMarketingClientId,
  useMarketingQuery,
} from "./layout";

interface PlaceRow {
  key: string | null;
  visits: number;
  goals: number;
  goalRate: string | null;
  bounceRate: string | null;
  medianEngagedMs: number | null;
  smallSample: boolean;
}

export interface AudienceReport extends RangedReport {
  level: "country" | "region" | "city";
  country: string | null;
  region: string | null;
  places: PlaceRow[];
  timeZone: string;
  heatmap: number[][];
  device: PlaceRow[];
  browser: PlaceRow[];
  os: PlaceRow[];
  language: PlaceRow[];
}

const COUNTRY_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
/** "US" → "United States"; an unknown code as it is. */
export function countryWords(code: string | null): string {
  if (!code || code === "unknown") return "Unknown";
  try {
    return COUNTRY_NAMES.of(code) ?? code;
  } catch {
    return code;
  }
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LEVEL_WORDS = { country: "Country", region: "Region", city: "City" } as const;

/** A heatmap cell's step on the design system's ramp (q1 to q5), against the busiest hour. */
export function heatStep(n: number, max: number): string {
  if (n === 0 || max === 0) return "";
  return `q${Math.min(5, Math.max(1, Math.ceil((n / max) * 5)))}`;
}

export function MarketingAudienceScreen() {
  const clientId = useMarketingClientId();
  const { query, set } = useMarketingQuery(["country", "region"]);
  const state = useMarketingReport<AudienceReport>(clientId, "audience", query);
  return (
    <MarketingLayout
      title="Audience"
      testId="marketing-audience"
      actions={<MarketingFilters sites={state.data?.sites} />}
    >
      <Loaded state={state}>
        {(r) =>
          !r.site ? (
            <NoSite clientId={clientId} />
          ) : (
            <div className="flex flex-col gap-6">
              <RangeLine range={r.range} />
              <Places r={r} set={set} />
              <Hours r={r} />
              <Columns count={2}>
                <Breakdown title="Device" rows={r.device} testId="marketing-audience-device" />
                <Breakdown title="Browser" rows={r.browser} testId="marketing-audience-browser" />
                <Breakdown title="Operating system" rows={r.os} testId="marketing-audience-os" />
                <Breakdown
                  title="Language"
                  rows={r.language}
                  testId="marketing-audience-language"
                />
              </Columns>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <PrivacyFooter />
                <CsvLink
                  href={marketingCsvHref(clientId, "audience", query)}
                  testId="marketing-audience-csv"
                />
              </div>
            </div>
          )
        }
      </Loaded>
    </MarketingLayout>
  );
}

function Places({
  r,
  set,
}: {
  r: AudienceReport;
  set: (changes: Record<string, string | null>) => void;
}) {
  const open = (key: string | null) => {
    const value = key ?? "unknown";
    if (r.level === "country") set({ country: value, region: null });
    else if (r.level === "region") set({ region: value });
  };
  return (
    <Section
      title="Where"
      testId="marketing-audience-places"
      action={
        r.country ? (
          <nav aria-label="Place" className="flex flex-wrap items-center gap-1 text-sm">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => set({ country: null, region: null })}
              data-testid="marketing-audience-all-countries"
            >
              All countries
            </Button>
            {r.region ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => set({ region: null })}
                data-testid="marketing-audience-country"
              >
                {countryWords(r.country)}
              </Button>
            ) : null}
          </nav>
        ) : null
      }
    >
      {r.places.length === 0 ? (
        <EmptyState line="No visits in these days." testId="marketing-audience-empty" />
      ) : (
        <DataTable testId="marketing-audience-places-table">
          <thead>
            <tr className="dt-cols">
              <th>
                {LEVEL_WORDS[r.level]}
                {r.region ? ` in ${r.region}` : r.country ? ` in ${countryWords(r.country)}` : ""}
              </th>
              <th className="n">Visits</th>
              <th className="n">Goal rate</th>
              <th className="n">Left at once</th>
              <th className="n">Median engaged</th>
            </tr>
          </thead>
          <tbody>
            {r.places.map((p) => {
              const name = r.level === "country" ? countryWords(p.key) : (p.key ?? "Not known");
              return (
                <tr key={p.key ?? "none"}>
                  <td>
                    {r.level === "city" ? (
                      name
                    ) : (
                      <button
                        type="button"
                        className="text-link hover:underline"
                        onClick={() => open(p.key)}
                        data-testid={`marketing-audience-open-${p.key ?? "unknown"}`}
                      >
                        {name}
                      </button>
                    )}
                    {p.smallSample ? (
                      <span className="ml-2">
                        <SmallSample />
                      </span>
                    ) : null}
                  </td>
                  <td className="n">{countWords(p.visits)}</td>
                  <td className="n">{percentWords(p.goalRate, 1)}</td>
                  <td className="n">{percentWords(p.bounceRate)}</td>
                  <td className="n">{durationWords(p.medianEngagedMs)}</td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}
    </Section>
  );
}

function Hours({ r }: { r: AudienceReport }) {
  const max = Math.max(0, ...r.heatmap.flat());
  return (
    <Section
      title="When"
      meta={`Visits by the hour they started, in the client's time zone (${r.timeZone})`}
      testId="marketing-audience-hours"
    >
      <div className="dt dt-heat">
        <div className="dt-scroll">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                {Array.from({ length: 24 }, (_, h) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: hours are positional.
                  <th key={h} className="n">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.heatmap.map((row, d) => (
                <tr key={WEEKDAYS[d]}>
                  <td className="rh">{WEEKDAYS[d]}</td>
                  {row.map((n, h) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: hours are positional.
                      key={h}
                      className={`h ${heatStep(n, max)}`}
                      title={`${WEEKDAYS[d]} ${h}:00, ${n} visits`}
                    >
                      {n || ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="dt-status">
          <span>Darker is busier; the busiest hour had {countWords(max)} visits.</span>
        </div>
      </div>
    </Section>
  );
}

function Breakdown({ title, rows, testId }: { title: string; rows: PlaceRow[]; testId: string }) {
  return (
    <Section title={title} testId={testId}>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">No visits.</p>
      ) : (
        <DataTable>
          <thead>
            <tr className="dt-cols">
              <th>{title}</th>
              <th className="n">Visits</th>
              <th className="n">Goal rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.key ?? "none"}>
                <td>{b.key ?? "Not known"}</td>
                <td className="n">{countWords(b.visits)}</td>
                <td className="n">{percentWords(b.goalRate, 1)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </Section>
  );
}
