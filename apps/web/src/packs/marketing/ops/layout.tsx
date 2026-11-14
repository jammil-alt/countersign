// The frame of a client's Marketing pages in the back office (docs/marketing-plan.md §4.7, §11):
// the client's name under "Marketing", the area's sub-navigation (a row that scrolls inside itself
// on a phone), and the page's own heading. Every screen in this folder renders inside it. The
// client's name comes from the frame's clients list, so the layout loads nothing of its own.
import type { ReactNode } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { useClientSummary } from "../../../ops/OpsLayout";
import { Select } from "../../../ui/forms";
import { Page } from "../../../ui/page";
import { buttonClass, EmptyState, PageHeader, Tabs, Tag } from "../../../ui/primitives";
import { PackGate } from "../../PackGate";
import { MARKETING_NAV, MARKETING_PATHS, sectionOf } from "./paths";

/** The client the page is for, from the route (`/ops/clients/:clientId/marketing/…`). */
export function useMarketingClientId(): string {
  const { clientId = "" } = useParams();
  return clientId;
}

export function MarketingLayout({
  title,
  subtitle,
  actions,
  testId,
  children,
}: {
  /** The page's own heading, e.g. "Pages". */
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  const clientId = useMarketingClientId();
  const client = useClientSummary(clientId);
  const { pathname } = useLocation();
  const at = sectionOf(pathname, clientId);
  // M44: the site and period chosen stay with the reader from page to page.
  const keep = useKeptQuery();
  return (
    <Page testId="marketing-page">
      <div>
        <PageHeader
          eyebrow={
            <Link to={MARKETING_PATHS.entry} className="hover:underline">
              Marketing
            </Link>
          }
          title={client?.name ?? "Marketing"}
          badge={client?.internal ? <Tag>Ours</Tag> : null}
        />
        <div data-testid="marketing-nav">
          <Tabs
            items={MARKETING_NAV.map((s) => ({
              to: `${MARKETING_PATHS[s.id](clientId)}${keep}`,
              label: s.label,
              end: true,
              active: s.id === at,
            }))}
          />
        </div>
      </div>
      <section data-testid={testId}>
        <PageHeader title={title} subtitle={subtitle} actions={actions} />
        <PackGate clientId={clientId} pack="marketing">
          {children}
        </PackGate>
      </section>
    </Page>
  );
}

/** A screen whose milestone hasn't come yet: its heading, and when it comes. */
export function ComingScreen({
  title,
  milestone,
  line,
  testId,
}: {
  title: string;
  /** e.g. "M44". */
  milestone: string;
  /** What the screen will show, in one plain line. */
  line: string;
  testId: string;
}) {
  return (
    <MarketingLayout title={title} testId={testId}>
      <div className="ds-empty" data-testid={`${testId}-coming`}>
        <p className="font-medium text-ink">Coming in {milestone}</p>
        <p className="text-ink-muted">{line}</p>
      </div>
    </MarketingLayout>
  );
}

// ── M44: what the read screens share (docs/plan.md §1.74) ──────────────────────────────────────
// The site and period picker (kept in the address, so a link or a reload keeps them), the line that
// says which days a report covers and how far they are counted, and the words for its figures.

/** A measured site, as the reports give it. */
export interface MarketingSite {
  id: string;
  domain: string;
  name: string;
  goals: string[];
  status: string;
  createdAt: string;
}

/** The band a median engaged time falls in. */
export interface MedianBand {
  band: number;
  fromSeconds: number;
  toSeconds: number | null;
}

export interface ReportRange {
  period: number | null;
  from: string;
  to: string;
  days: number;
  previous: { from: string; to: string };
  includesToday: boolean;
  dataThrough: string | null;
}

/** What every read report starts with. */
export interface RangedReport {
  site: MarketingSite | null;
  sites: MarketingSite[];
  range: ReportRange;
}

export const MARKETING_PERIODS = ["7", "28", "90"] as const;
const KEPT = ["site", "period"] as const;

/** `?site=…&period=…` from the current address, for links to the area's other pages. */
export function useKeptQuery(): string {
  const [params] = useSearchParams();
  const kept = new URLSearchParams();
  for (const k of KEPT) {
    const v = params.get(k);
    if (v) kept.set(k, v);
  }
  const s = kept.toString();
  return s ? `?${s}` : "";
}

/** A link's address with the kept site and period, and its own parameters. */
export function withKept(
  to: string,
  kept: string,
  extra: Record<string, string | null | undefined> = {},
): string {
  const [path = "", own = ""] = to.split("?");
  const params = new URLSearchParams(own);
  for (const [k, v] of new URLSearchParams(kept.replace(/^\?/, ""))) {
    if (!params.has(k)) params.set(k, v);
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v) params.set(k, v);
    else params.delete(k);
  }
  const s = params.toString();
  return s ? `${path}?${s}` : path;
}

/** The address's report query: the site, the period (28 days by default) and `own` parameters. */
export function useMarketingQuery(own: readonly string[] = []) {
  const [params, setParams] = useSearchParams();
  const period = MARKETING_PERIODS.find((p) => p === params.get("period")) ?? "28";
  const query: Record<string, string | undefined> = {
    site: params.get("site") ?? undefined,
    period,
  };
  for (const k of own) query[k] = params.get(k) ?? undefined;
  /** Sets (or, with null, clears) parameters, keeping the rest. */
  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  return { query, period, params, set };
}

/** Which site (when there are several) and which days: 7, 28 or 90 to yesterday. */
export function MarketingFilters({ sites }: { sites: readonly MarketingSite[] | undefined }) {
  const { query, period, set } = useMarketingQuery();
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="marketing-filters">
      {sites && sites.length > 1 ? (
        <Select
          aria-label="Site"
          className="w-56 max-w-full"
          value={query.site ?? sites[0]?.id ?? ""}
          onChange={(e) => set({ site: e.target.value })}
          data-testid="marketing-filter-site-select"
        >
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      ) : null}
      <fieldset className="ds-seg m-0">
        <legend className="sr-only">Days</legend>
        {MARKETING_PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={period === p}
            onClick={() => set({ period: p === "28" ? null : p })}
            data-testid={`marketing-filter-period-${p}`}
          >
            {p} days
          </button>
        ))}
      </fieldset>
    </div>
  );
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const YEAR_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** "Nov 7" (a `yyyy-mm-dd` day, read as UTC, as the reports count days). */
export const dayWords = (day: string, year = false) =>
  (year ? YEAR_FORMAT : DAY_FORMAT).format(new Date(`${day}T00:00:00Z`));

export const countWords = (n: number) => n.toLocaleString("en-US");

/** "12%" from a rate string ("0.1234"); "–" with nothing to divide by. */
export function percentWords(rate: string | null | undefined, digits = 0): string {
  if (rate === null || rate === undefined) return "–";
  return `${(Number(rate) * 100).toFixed(digits)}%`;
}

const secondsWords = (s: number) =>
  s < 60 ? `${s} s` : s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)} min ${s % 60} s`;

/** "30 s to 1 min", "under 10 s", "4 min or more"; "–" with nothing counted. */
export function bandWords(band: MedianBand | null | undefined): string {
  if (!band) return "–";
  if (band.fromSeconds === 0 && band.toSeconds !== null) {
    return `under ${secondsWords(band.toSeconds)}`;
  }
  if (band.toSeconds === null) return `${secondsWords(band.fromSeconds)} or more`;
  return `${secondsWords(band.fromSeconds)} to ${secondsWords(band.toSeconds)}`;
}

/** An engaged time to the second: "1 min 20 s". */
export const durationWords = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? "–" : secondsWords(Math.round(ms / 1000));

/** Shown beside a figure with fewer than 20 visits behind it. */
export function SmallSample({ testId }: { testId?: string }) {
  return (
    <span title="Fewer than 20 visits behind this figure" data-testid={testId ?? "marketing-small"}>
      <Tag>Small sample</Tag>
    </span>
  );
}

/** "Oct 11 to Nov 7, 2026, the last 28 days." and what isn't counted yet. */
export function RangeLine({ range }: { range: ReportRange }) {
  const notYet =
    range.dataThrough === null
      ? "Nothing is counted yet: a day's visits are counted the night after."
      : range.dataThrough < range.to
        ? `Days after ${dayWords(range.dataThrough)} are counted overnight.`
        : null;
  return (
    <p className="text-sm text-ink-muted" data-testid="marketing-range">
      {dayWords(range.from)} to {dayWords(range.to, true)}
      {range.period ? `, the last ${range.period} days` : ""}.{" "}
      {range.includesToday ? (
        <span data-testid="marketing-range-today">Today is partial: it is counted tonight. </span>
      ) : null}
      {notYet ? <span data-testid="marketing-range-pending">{notYet}</span> : null}
    </p>
  );
}

/** What every measured screen ends with: what we keep and what we never do. */
export function PrivacyFooter({ filtered }: { filtered?: number }) {
  return (
    <p className="text-sm text-ink-muted" data-testid="marketing-privacy">
      Measured without cookies. We keep no IP address or browser string, and a visit can't be
      followed past its day.
      {filtered !== undefined
        ? ` ${countWords(filtered)} requests from bots and scripts were left out.`
        : ""}
    </p>
  );
}

/** The client has no measured site yet (or the one asked for isn't theirs). */
export function NoSite({ clientId }: { clientId: string }) {
  return (
    <EmptyState
      testId="marketing-no-site"
      title="No site measured yet"
      line="Add the client's website, then paste its snippet into every page."
      action={{
        label: "Add a site",
        to: MARKETING_PATHS.sites(clientId),
        testId: "marketing-no-site-add",
      }}
    />
  );
}

/** A table that scrolls sideways inside itself on a phone, never the page. */
export function DataTable({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="dt dt-ana overflow-x-auto">
      <table data-testid={testId}>{children}</table>
    </div>
  );
}

/** A report's CSV, as a download link. */
export function CsvLink({ href, testId }: { href: string; testId: string }) {
  return (
    <a
      href={href}
      download
      className={buttonClass("secondary", undefined, "sm")}
      data-testid={testId}
    >
      Download CSV
    </a>
  );
}
