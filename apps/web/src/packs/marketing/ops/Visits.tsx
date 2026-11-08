// Visits (M44, docs/marketing-plan.md §4.7): the visits behind a number, filtered by source, entry
// page, a page read, country and goal (the address carries the filters, so every figure elsewhere
// links here), fifty to a page. A visit shows its day, never its time of day, and a day's visits are
// in no meaningful order.
import { Link } from "react-router-dom";
import { Field, Select, TextInput } from "../../../ui/forms";
import { Loaded } from "../../../ui/page";
import { Button, EmptyState } from "../../../ui/primitives";
import { countryWords } from "./Audience";
import { marketingCsvHref, useMarketingReport } from "./api";
import {
  CsvLink,
  countWords,
  DataTable,
  dayWords,
  durationWords,
  MarketingFilters,
  MarketingLayout,
  NoSite,
  PrivacyFooter,
  type RangedReport,
  RangeLine,
  SmallSample,
  useKeptQuery,
  useMarketingClientId,
  useMarketingQuery,
  withKept,
} from "./layout";
import { sourceWords } from "./Overview";
import { MARKETING_PATHS } from "./paths";

export interface VisitRow {
  day: string;
  visit: string;
  entryPath: string;
  exitPath: string;
  pages: string[];
  views: number;
  engagedMs: number;
  source: string;
  sourceGroup: string;
  sourceName: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  device: string;
  reachedGoal: boolean;
  goal: string | null;
  bounced: boolean;
}

export interface VisitsReport extends RangedReport {
  day: string | null;
  total: number;
  goals: number;
  smallSample: boolean;
  page: number;
  pageSize: number;
  pages: number;
  visits: VisitRow[];
}

export const VISIT_FILTERS = ["source", "entry", "path", "country", "goal", "day", "page"] as const;

/** "Austin, Texas, United States". */
export function placeWords(v: Pick<VisitRow, "country" | "region" | "city">): string {
  return (
    [v.city, v.region, v.country ? countryWords(v.country) : null].filter(Boolean).join(", ") ||
    "Unknown"
  );
}

export function MarketingVisitsScreen() {
  const clientId = useMarketingClientId();
  const { query, set } = useMarketingQuery(VISIT_FILTERS);
  const state = useMarketingReport<VisitsReport>(clientId, "visits", query);
  return (
    <MarketingLayout
      title="Visits"
      testId="marketing-visits"
      actions={<MarketingFilters sites={state.data?.sites} />}
    >
      <Filters query={query} set={set} />
      <Loaded state={state}>
        {(r) =>
          !r.site ? (
            <NoSite clientId={clientId} />
          ) : (
            <VisitsBody clientId={clientId} r={r} set={set} query={query} />
          )
        }
      </Loaded>
    </MarketingLayout>
  );
}

function Filters({
  query,
  set,
}: {
  query: Record<string, string | undefined>;
  set: (changes: Record<string, string | null>) => void;
}) {
  const any = VISIT_FILTERS.some((k) => k !== "page" && query[k]);
  // A typed filter applies when the field is left (or Enter is pressed), not on every key.
  const clean = (name: string, value: string) => {
    const v = value.trim();
    return (name === "country" ? v.toUpperCase() : v) || null;
  };
  const text = (name: "source" | "entry" | "path" | "country", label: string, hint: string) => (
    <Field label={label} className="min-w-0 flex-1 basis-40">
      <TextInput
        key={`${name}:${query[name] ?? ""}`}
        defaultValue={query[name] ?? ""}
        placeholder={hint}
        onBlur={(e) => {
          const v = clean(name, e.target.value);
          if (v !== (query[name] ?? null)) set({ [name]: v, page: null });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") set({ [name]: clean(name, e.currentTarget.value), page: null });
        }}
        data-testid={`marketing-visits-filter-${name}`}
      />
    </Field>
  );
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3" data-testid="marketing-visits-filters">
      {text("source", "Source", "search/google")}
      {text("entry", "Entered on", "/")}
      {text("path", "Read", "/pricing")}
      {text("country", "Country", "US")}
      <Field label="Goal" className="basis-36">
        <Select
          value={query.goal ?? ""}
          onChange={(e) => set({ goal: e.target.value || null, page: null })}
          data-testid="marketing-visits-filter-goal"
        >
          <option value="">Any</option>
          <option value="yes">Reached a goal</option>
          <option value="no">No goal</option>
        </Select>
      </Field>
      {any ? (
        <Button
          variant="ghost"
          onClick={() =>
            set({
              source: null,
              entry: null,
              path: null,
              country: null,
              goal: null,
              day: null,
              page: null,
            })
          }
          data-testid="marketing-visits-filter-clear"
        >
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

function VisitsBody({
  clientId,
  r,
  set,
  query,
}: {
  clientId: string;
  r: VisitsReport;
  set: (changes: Record<string, string | null>) => void;
  query: Record<string, string | undefined>;
}) {
  const kept = useKeptQuery();
  return (
    <div className="flex flex-col gap-4">
      <RangeLine range={r.range} />
      <p className="text-ink" data-testid="marketing-visits-total">
        {countWords(r.total)} visits{r.day ? ` on ${dayWords(r.day)}` : ""}, {countWords(r.goals)}{" "}
        reached a goal.
        {r.smallSample && r.total > 0 ? (
          <span className="ml-2">
            <SmallSample />
          </span>
        ) : null}
      </p>
      {r.visits.length === 0 ? (
        <EmptyState
          testId="marketing-visits-empty"
          title="No visits match"
          line="Try fewer filters or a longer period."
        />
      ) : (
        <DataTable testId="marketing-visits-table">
          <thead>
            <tr className="dt-cols">
              <th>Day</th>
              <th>Entered on</th>
              <th className="n">Pages</th>
              <th className="n">Engaged</th>
              <th>Source</th>
              <th>Place</th>
              <th>Device</th>
              <th>Goal</th>
            </tr>
          </thead>
          <tbody>
            {r.visits.map((v) => (
              <tr key={`${v.day}:${v.visit}`}>
                <td className="whitespace-nowrap">
                  <Link
                    to={withKept(MARKETING_PATHS.visit(clientId, v.visit), kept, { day: v.day })}
                    className="text-link hover:underline"
                    data-testid={`marketing-visits-open-${v.visit}`}
                  >
                    {dayWords(v.day)}
                  </Link>
                </td>
                <td className="max-w-[14rem] break-all">{v.entryPath}</td>
                <td className="n">{v.views}</td>
                <td className="n whitespace-nowrap">{durationWords(v.engagedMs)}</td>
                <td>{sourceWords(v.sourceGroup, v.sourceName)}</td>
                <td>{placeWords(v)}</td>
                <td>{v.device}</td>
                <td>{v.goal ?? (v.bounced ? "Left at once" : "–")}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {r.pages > 1 ? (
        <nav
          className="flex flex-wrap items-center gap-3"
          aria-label="Pages of visits"
          data-testid="marketing-visits-pager"
        >
          <Button
            size="sm"
            disabled={r.page <= 1}
            onClick={() => set({ page: r.page - 1 > 1 ? String(r.page - 1) : null })}
            data-testid="marketing-visits-prev"
          >
            Newer
          </Button>
          <span className="text-sm text-ink-muted">
            Page {r.page} of {r.pages}
          </span>
          <Button
            size="sm"
            disabled={r.page >= r.pages}
            onClick={() => set({ page: String(r.page + 1) })}
            data-testid="marketing-visits-next"
          >
            Older
          </Button>
        </nav>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PrivacyFooter />
        <CsvLink href={marketingCsvHref(clientId, "visits", query)} testId="marketing-visits-csv" />
      </div>
    </div>
  );
}
