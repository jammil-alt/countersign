// Report bodies for the read screens' tests (M44), shaped as packs/marketing's reports answer them.
import type { AudienceReport } from "./Audience";
import type { JourneysReport } from "./Journeys";
import type { OverviewReport, Totals } from "./Overview";
import type { PageReport } from "./PageDetail";
import type { PagesReport } from "./Pages";
import type { SitesReport } from "./Sites";
import type { SourcesReport } from "./Sources";
import type { VisitReport } from "./Visit";
import type { VisitRow, VisitsReport } from "./Visits";

export const CLIENT = "00000000-0000-4000-8000-00000000a011";
export const SITE = "00000000-0000-4000-8000-00000000b001";
export const SITE_2 = "00000000-0000-4000-8000-00000000b002";
export const VISIT = "0123456789abcdef0123456789abcdef";

export const SITE_ROW = {
  id: SITE,
  domain: "mezonas.com",
  name: "mezonas.com",
  goals: ["hero-talk"],
  status: "on",
  createdAt: "2026-11-01T10:00:00.000Z",
};

const range = (over: Partial<OverviewReport["range"]> = {}): OverviewReport["range"] => ({
  period: 28,
  from: "2026-10-11",
  to: "2026-11-07",
  days: 28,
  previous: { from: "2026-09-13", to: "2026-10-10" },
  includesToday: false,
  dataThrough: "2026-11-07",
  ...over,
});

const base = (over: Partial<OverviewReport["range"]> = {}) => ({
  site: SITE_ROW,
  sites: [SITE_ROW],
  range: range(over),
});

const totals = (visits: number, goals: number): Totals => ({
  visits,
  views: visits * 2,
  goals,
  bounces: Math.round(visits / 3),
  goalRate: visits ? (goals / visits).toFixed(4) : null,
  bounceRate: visits ? (Math.round(visits / 3) / visits).toFixed(4) : null,
  medianEngaged: visits ? { band: 2, fromSeconds: 30, toSeconds: 60 } : null,
  smallSample: visits < 20,
});

export function overviewReport(over: Partial<OverviewReport> = {}): OverviewReport {
  return {
    ...base(),
    totals: totals(1540, 41),
    previousTotals: totals(1210, 30),
    daily: Array.from({ length: 28 }, (_, i) => ({
      day: `2026-${i < 21 ? "10" : "11"}-${String(i < 21 ? 11 + i : i - 20).padStart(2, "0")}`,
      visits: 40 + i,
      goals: i % 3,
      built: true,
    })),
    pages: [
      { path: "/", views: 1200, entries: 900, goals: 30, smallSample: false },
      { path: "/how-it-works", views: 700, entries: 400, goals: 8, smallSample: false },
    ],
    sources: [
      { source: "direct", group: "direct", name: null, visits: 600, goals: 20, smallSample: false },
      {
        source: "referral/news.ycombinator.com",
        group: "referral",
        name: "news.ycombinator.com",
        visits: 12,
        goals: 0,
        smallSample: true,
      },
    ],
    filtered: 1830,
    ...over,
  };
}

export const EMPTY_OVERVIEW: OverviewReport = {
  ...overviewReport(),
  site: null,
  sites: [],
};

export function pagesReport(): PagesReport {
  return {
    ...base(),
    pages: [
      {
        path: "/",
        views: 1200,
        entries: 900,
        exits: 400,
        exitRate: "0.3333",
        goals: 30,
        formSeen: 120,
        medianEngaged: { band: 2, fromSeconds: 30, toSeconds: 60 },
        halfReadTo: 3,
        smallSample: false,
      },
      {
        path: "/privacy",
        views: 9,
        entries: 1,
        exits: 7,
        exitRate: "0.7778",
        goals: 0,
        formSeen: 0,
        medianEngaged: { band: 0, fromSeconds: 0, toSeconds: 10 },
        halfReadTo: 0,
        smallSample: true,
      },
    ],
  };
}

export function pageReport(path = "/how-it-works"): PageReport {
  return {
    ...base(),
    path,
    page: {
      path,
      views: 700,
      entries: 400,
      exits: 300,
      exitRate: "0.4286",
      goals: 8,
      formSeen: 0,
      medianEngaged: { band: 3, fromSeconds: 60, toSeconds: 120 },
      halfReadTo: 2,
      smallSample: false,
    },
    reach: [
      { quarter: 1, views: 600, share: "0.8571" },
      { quarter: 2, views: 400, share: "0.5714" },
      { quarter: 3, views: 200, share: "0.2857" },
      { quarter: 4, views: 90, share: "0.1286" },
    ],
    engaged: [100, 120, 150, 180, 100, 50],
    clicks: [
      { target: "hero-talk", clicks: 14, position: 12 },
      { target: "nav-home", clicks: 80, position: 0 },
    ],
    cameFrom: [
      { kind: "source", key: "referral/news.ycombinator.com", visits: 200 },
      { kind: "page", key: "/", visits: 300 },
    ],
    wentNext: [
      { kind: "left", key: null, visits: 280 },
      { kind: "page", key: "/", visits: 200 },
      { kind: "goal", key: null, visits: 8 },
    ],
  };
}

const source = (
  key: string,
  visits: number,
  over: Partial<SourcesReport["groups"][number]> = {},
) => {
  const [group = key, name = null] = key.split(/\/(.*)/);
  return {
    key,
    group,
    name: name || null,
    visits,
    previousVisits: Math.round(visits * 0.8),
    goals: Math.round(visits / 40),
    goalRate: (Math.round(visits / 40) / visits).toFixed(4),
    bounces: Math.round(visits / 3),
    bounceRate: "0.3333",
    medianEngaged: { band: 2, fromSeconds: 30, toSeconds: 60 },
    smallSample: visits < 20,
    ...over,
  };
};

export function sourcesReport(over: Partial<SourcesReport> = {}): SourcesReport {
  return {
    ...base(),
    groups: [
      { ...source("direct", 600), names: [source("direct", 600)] },
      {
        ...source("referral", 212),
        names: [source("referral/news.ycombinator.com", 200), source("referral/reddit.com", 12)],
      },
      {
        ...source("campaign", 63),
        names: [source("campaign/newsletter-nov", 63)],
      },
    ],
    campaign: null,
    referrer: null,
    ...over,
  };
}

export const CAMPAIGN: NonNullable<SourcesReport["campaign"]> = {
  name: "newsletter-nov",
  utmSource: "newsletter",
  utmMedium: "email",
  visits: 63,
  goals: 5,
  goalRate: "0.0794",
  smallSample: false,
  days: [{ day: "2026-11-03", visits: 30, goals: 3 }],
  links: [
    {
      content: "lead",
      path: "/guides/month-end-close",
      visits: 35,
      goals: 3,
      goalRate: "0.0857",
      bounceRate: "0.2000",
      smallSample: false,
    },
    {
      content: "footer",
      path: "/",
      visits: 9,
      goals: 0,
      goalRate: "0.0000",
      bounceRate: "0.4444",
      smallSample: true,
    },
  ],
};

export function journeysReport(): JourneysReport {
  const path = (pages: string[], visits: number, goals: number, longer = false) => ({
    pages,
    longer,
    visits,
    goals,
    goalRate: (goals / visits).toFixed(4),
    smallSample: visits < 20,
  });
  return {
    ...base(),
    visits: 1540,
    smallSample: false,
    paths: [
      path(["/"], 500, 3),
      path(["/", "/how-it-works"], 300, 12),
      path(["/", "/a", "/b", "/c", "/z"], 40, 4, true),
    ],
    other: { paths: 30, visits: 700 },
    best: path(["/", "/how-it-works"], 300, 12),
    leaves: [{ path: "/", visits: 1200, left: 400, leftRate: "0.3333" }],
    lastPage: [{ path: "/", visits: 30 }],
    funnel: [
      { entry: "/", landed: 900, sawForm: 200, goals: 30, goalRate: "0.0333", smallSample: false },
    ],
  };
}

const place = (key: string | null, visits: number) => ({
  key,
  visits,
  goals: 2,
  goalRate: (2 / visits).toFixed(4),
  bounceRate: "0.3000",
  medianEngagedMs: 45_000,
  smallSample: visits < 20,
});

export function audienceReport(over: Partial<AudienceReport> = {}): AudienceReport {
  const heatmap = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  (heatmap[0] as number[])[15] = 40;
  (heatmap[2] as number[])[9] = 10;
  return {
    ...base(),
    level: "country",
    country: null,
    region: null,
    places: [place("US", 1100), place("CA", 80), place(null, 4)],
    timeZone: "America/Chicago",
    heatmap,
    device: [place("desktop", 900), place("phone", 600)],
    browser: [place("Chrome", 1000)],
    os: [place("Windows", 700)],
    language: [place("en-US", 1200)],
    ...over,
  };
}

export const VISIT_ROW: VisitRow = {
  day: "2026-11-06",
  visit: VISIT,
  entryPath: "/how-it-works",
  exitPath: "/",
  pages: ["/how-it-works", "/"],
  views: 2,
  engagedMs: 95_000,
  source: "referral/news.ycombinator.com",
  sourceGroup: "referral",
  sourceName: "news.ycombinator.com",
  country: "US",
  region: "Texas",
  city: "Austin",
  device: "desktop",
  reachedGoal: true,
  goal: "hero-talk",
  bounced: false,
};

export function visitsReport(over: Partial<VisitsReport> = {}): VisitsReport {
  return {
    ...base(),
    day: null,
    total: 120,
    goals: 3,
    smallSample: false,
    page: 1,
    pageSize: 50,
    pages: 3,
    visits: [VISIT_ROW],
    ...over,
  };
}

export function visitReport(over: Partial<VisitReport> = {}): VisitReport {
  return {
    site: SITE_ROW,
    sites: [SITE_ROW],
    day: "2026-11-06",
    visit: {
      ...VISIT_ROW,
      browser: "Chrome",
      os: "Windows",
      language: "en-US",
      referrerHost: "news.ycombinator.com",
      utmCampaign: null,
      utmContent: null,
      clicks: 2,
      sawForm: false,
    },
    steps: [
      {
        kind: "view",
        path: "/how-it-works",
        engagedMs: 65_000,
        scroll: 3,
        target: null,
        position: null,
        goal: false,
        form: null,
      },
      {
        kind: "click",
        path: "/how-it-works",
        engagedMs: null,
        scroll: null,
        target: "nav-home",
        position: 0,
        goal: false,
        form: null,
      },
      {
        kind: "view",
        path: "/",
        engagedMs: 30_000,
        scroll: 1,
        target: null,
        position: null,
        goal: false,
        form: null,
      },
      {
        kind: "click",
        path: "/",
        engagedMs: null,
        scroll: null,
        target: "hero-talk",
        position: 12,
        goal: true,
        form: null,
      },
    ],
    ...over,
  };
}

export function sitesReport(over: Partial<SitesReport["sites"][number]> = {}): SitesReport {
  return {
    sites: [
      {
        ...SITE_ROW,
        lastEventDay: "2026-11-08",
        dataThrough: "2026-11-07",
        visitsLast7: 380,
        ...over,
      },
    ],
  };
}
