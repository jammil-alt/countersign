// The Marketing area's read screens in the back office (M44, docs/plan.md §1.74): each renders its
// report and its empty state, sends its query (the period, the site, its own parameters) to the
// report, marks small samples and days not counted yet, and links into the screen that opens a
// figure. Sites adds and changes a site, shows its snippet and, for the Sandbox only, fills sample
// traffic. The client settings' switch marks a client as one of ours.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../../App";
import { fakeApi, OPERATOR_SESSION, opsClientSettings, Reply } from "../../../test/fixtures";
import { bandWords, percentWords, withKept } from "./layout";
import { MARKETING_PATHS } from "./paths";
import {
  audienceReport,
  CAMPAIGN,
  CLIENT,
  EMPTY_OVERVIEW,
  journeysReport,
  overviewReport,
  pageReport,
  pagesReport,
  SITE,
  SITE_2,
  SITE_ROW,
  sitesReport,
  sourcesReport,
  VISIT,
  visitReport,
  visitsReport,
} from "./ReadScreens.fixtures";
import { parseGoals } from "./Sites";

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{`${pathname}${search}`}</span>;
}

const clientRow = (sandbox = false) => ({
  id: CLIENT,
  name: "Mezonas",
  timezone: "America/Chicago",
  createdAt: "2026-11-01T00:00:00.000Z",
  agents: 0,
  openInbox: 0,
  needsUs: 0,
  waitingRuns: 0,
  sandbox,
  internal: true,
});

const REPORT = (name: string) => `GET /api/ops/clients/${CLIENT}/reports/marketing/${name}`;
const ACTION = (name: string) => `POST /api/ops/clients/${CLIENT}/packs/marketing/actions/${name}`;

/** Renders the app at `path` with each report's body; records each report's query string. */
function renderAt(
  path: string,
  reports: Record<string, unknown | ((url: URL) => unknown)>,
  extra: Record<string, (req: { url: URL; init: RequestInit }) => unknown> = {},
  sandbox = false,
) {
  const seen: Record<string, string[]> = {};
  const handlers: Record<string, (req: { url: URL; init: RequestInit }) => unknown> = {
    "GET /api/session": () => OPERATOR_SESSION,
    "GET /api/ops/clients": () => ({ clients: [clientRow(sandbox)] }),
    ...extra,
  };
  for (const [name, body] of Object.entries(reports)) {
    handlers[REPORT(name)] = ({ url }) => {
      if (!seen[name]) seen[name] = [];
      seen[name].push(url.search);
      return { report: typeof body === "function" ? (body as (u: URL) => unknown)(url) : body };
    };
  }
  const api = fakeApi(handlers);
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
        <LocationProbe />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, seen };
}

describe("the read screens' words", () => {
  it("say a band, a rate and keep the site and period on links", () => {
    expect(bandWords({ band: 0, fromSeconds: 0, toSeconds: 10 })).toBe("under 10 s");
    expect(bandWords({ band: 2, fromSeconds: 30, toSeconds: 60 })).toBe("30 s to 1 min");
    expect(bandWords({ band: 5, fromSeconds: 240, toSeconds: null })).toBe("4 min or more");
    expect(bandWords(null)).toBe("–");
    expect(percentWords("0.1234", 1)).toBe("12.3%");
    expect(percentWords(null)).toBe("–");
    expect(withKept("/a?path=%2F", "?site=s&period=7", { goal: "yes", page: null })).toBe(
      "/a?path=%2F&site=s&period=7&goal=yes",
    );
    expect(parseGoals("hero-talk, contact-email hero-talk")).toEqual([
      "hero-talk",
      "contact-email",
    ]);
  });
});

describe("Overview", () => {
  it("shows the period's figures against the days before, with links into them", async () => {
    const { seen } = renderAt(MARKETING_PATHS.overview(CLIENT), { overview: overviewReport() });
    const kpis = await screen.findByTestId("marketing-overview-kpis");
    expect(within(kpis).getByTestId("marketing-overview-visits")).toHaveTextContent("1,540");
    expect(within(kpis).getByTestId("marketing-overview-visits")).toHaveTextContent(
      "Up 330 on the days before",
    );
    expect(within(kpis).getByTestId("marketing-overview-goals")).toHaveAttribute(
      "href",
      `${MARKETING_PATHS.visits(CLIENT)}?goal=yes`,
    );
    expect(within(kpis).getByTestId("marketing-overview-engaged")).toHaveTextContent(
      "30 s to 1 min",
    );
    expect(screen.getByRole("link", { name: "/how-it-works" })).toHaveAttribute(
      "href",
      MARKETING_PATHS.page(CLIENT, "/how-it-works"),
    );
    const sources = screen.getByTestId("marketing-overview-sources");
    expect(within(sources).getByTestId("marketing-small")).toHaveTextContent("Small sample");
    expect(screen.getByTestId("marketing-privacy")).toHaveTextContent("1,830 requests from bots");
    expect(screen.getByTestId("marketing-overview-csv")).toHaveAttribute(
      "href",
      `/api/ops/clients/${CLIENT}/reports/marketing/overview/csv?period=28`,
    );
    expect(seen.overview).toEqual(["?period=28"]);
  });

  it("asks for another period and site, and keeps them on the area's links", async () => {
    const user = userEvent.setup();
    const two = { ...SITE_ROW, id: SITE_2, name: "Second site" };
    const { seen } = renderAt(MARKETING_PATHS.overview(CLIENT), {
      overview: overviewReport({ sites: [SITE_ROW, two] }),
    });
    await user.click(await screen.findByTestId("marketing-filter-period-7"));
    await waitFor(() => expect(seen.overview).toContain("?period=7"));
    await user.selectOptions(screen.getByTestId("marketing-filter-site-select"), SITE_2);
    await waitFor(() => expect(seen.overview).toContain(`?site=${SITE_2}&period=7`));
    const nav = screen.getByTestId("marketing-nav");
    expect(within(nav).getByRole("link", { name: "Pages" })).toHaveAttribute(
      "href",
      `${MARKETING_PATHS.pages(CLIENT)}?site=${SITE_2}&period=7`,
    );
  });

  it("marks today and days not counted yet", async () => {
    renderAt(MARKETING_PATHS.overview(CLIENT), {
      overview: overviewReport({
        range: {
          ...overviewReport().range,
          includesToday: true,
          to: "2026-11-08",
          dataThrough: "2026-11-06",
        },
      }),
    });
    expect(await screen.findByTestId("marketing-range-today")).toHaveTextContent(
      "Today is partial",
    );
    expect(screen.getByTestId("marketing-range-pending")).toHaveTextContent(
      "Days after Nov 6 are counted overnight.",
    );
  });

  it("says how to start when there's no site, and when there are no visits", async () => {
    renderAt(MARKETING_PATHS.overview(CLIENT), { overview: EMPTY_OVERVIEW });
    expect(await screen.findByTestId("marketing-no-site")).toHaveTextContent(
      "No site measured yet",
    );
    expect(screen.getByTestId("marketing-no-site-add")).toHaveAttribute(
      "href",
      MARKETING_PATHS.sites(CLIENT),
    );
  });

  it("says when the days had no visits", async () => {
    renderAt(MARKETING_PATHS.overview(CLIENT), {
      overview: overviewReport({
        daily: overviewReport().daily.map((d) => ({ ...d, visits: 0 })),
        pages: [],
        sources: [],
      }),
    });
    expect(await screen.findByTestId("marketing-overview-empty")).toHaveTextContent(
      "No visits in these days",
    );
  });
});

describe("Pages", () => {
  it("lists each page with its figures, small samples marked", async () => {
    renderAt(MARKETING_PATHS.pages(CLIENT), { pages: pagesReport() });
    const table = await screen.findByTestId("marketing-pages-table");
    const home = within(table).getByTestId("marketing-pages-open-/").closest("tr") as HTMLElement;
    expect(home).toHaveTextContent("33%");
    expect(home).toHaveTextContent("30 s to 1 min");
    expect(home).toHaveTextContent("75%");
    const privacy = within(table)
      .getByTestId("marketing-pages-open-/privacy")
      .closest("tr") as HTMLElement;
    expect(within(privacy).getByTestId("marketing-small")).toBeInTheDocument();
    expect(privacy).toHaveTextContent("Under a quarter");
  });

  it("says when nothing was read", async () => {
    renderAt(MARKETING_PATHS.pages(CLIENT), { pages: { ...pagesReport(), pages: [] } });
    expect(await screen.findByTestId("marketing-pages-empty")).toBeInTheDocument();
  });
});

describe("A page in depth", () => {
  it("asks for its path and shows reach, time, where readers came from and went, and clicks", async () => {
    const { seen } = renderAt(MARKETING_PATHS.page(CLIENT, "/how-it-works"), {
      page: pageReport(),
    });
    expect(await screen.findByTestId("marketing-page-detail-kpis")).toHaveTextContent("700");
    expect(seen.page).toEqual(["?period=28&path=%2Fhow-it-works"]);
    expect(screen.getByTestId("marketing-page-detail-reach")).toHaveTextContent("57%");
    expect(screen.getByTestId("marketing-page-detail-engaged")).toHaveTextContent("1 to 2 min");
    expect(screen.getByTestId("marketing-page-detail-from")).toHaveTextContent(
      "Arrived from news.ycombinator.com (referral)",
    );
    expect(screen.getByTestId("marketing-page-detail-next")).toHaveTextContent("Left the site");
    expect(screen.getByTestId("marketing-page-detail-next")).toHaveTextContent("Reached a goal");
    expect(screen.getByTestId("marketing-page-detail-clicks")).toHaveTextContent("hero-talkGoal");
    expect(screen.getByTestId("marketing-page-detail-visits")).toHaveAttribute(
      "href",
      `${MARKETING_PATHS.visits(CLIENT)}?path=%2Fhow-it-works`,
    );
  });

  it("says when nobody read it", async () => {
    renderAt(MARKETING_PATHS.page(CLIENT, "/gone"), {
      page: { ...pageReport("/gone"), page: null },
    });
    expect(await screen.findByTestId("marketing-page-detail-empty")).toBeInTheDocument();
  });
});

describe("Sources", () => {
  it("groups sources and opens a campaign by its links", async () => {
    const user = userEvent.setup();
    const { seen } = renderAt(MARKETING_PATHS.sources(CLIENT), {
      sources: (url: URL) =>
        sourcesReport(url.searchParams.get("campaign") ? { campaign: CAMPAIGN } : {}),
    });
    const table = await screen.findByTestId("marketing-sources-table");
    expect(within(table).getByTestId("marketing-sources-row-referral")).toHaveTextContent(
      "Other sites",
    );
    expect(
      within(table).getByTestId("marketing-sources-row-referral/reddit.com"),
    ).toHaveTextContent("Small sample");
    await user.click(within(table).getByTestId("marketing-sources-open-campaign/newsletter-nov"));
    await waitFor(() => expect(seen.sources).toContain("?period=28&campaign=newsletter-nov"));
    const card = await screen.findByTestId("marketing-sources-campaign");
    expect(within(card).getByTestId("marketing-sources-campaign-links")).toHaveTextContent("lead");
    expect(card).toHaveTextContent("Source newsletter, medium email");
  });

  it("opens another site in depth", async () => {
    const user = userEvent.setup();
    const { seen } = renderAt(MARKETING_PATHS.sources(CLIENT), { sources: sourcesReport() });
    await user.click(
      await screen.findByTestId("marketing-sources-open-referral/news.ycombinator.com"),
    );
    await waitFor(() => expect(seen.sources).toContain("?period=28&referrer=news.ycombinator.com"));
  });
});

describe("Journeys", () => {
  it("shows the best path, the common paths and the funnel", async () => {
    renderAt(MARKETING_PATHS.journeys(CLIENT), { journeys: journeysReport() });
    expect(await screen.findByTestId("marketing-journeys-best")).toHaveTextContent(
      "/ → /how-it-works",
    );
    expect(screen.getByTestId("marketing-journeys-paths")).toHaveTextContent(
      "/ → /a → /b → /c → … → /z",
    );
    expect(screen.getByTestId("marketing-journeys-paths")).toHaveTextContent(
      "30 other paths, 700 visits",
    );
    expect(screen.getByTestId("marketing-journeys-funnel")).toHaveTextContent("3.3%");
  });

  it("says when there were no visits", async () => {
    renderAt(MARKETING_PATHS.journeys(CLIENT), { journeys: { ...journeysReport(), visits: 0 } });
    expect(await screen.findByTestId("marketing-journeys-empty")).toBeInTheDocument();
  });
});

describe("Audience", () => {
  it("shows countries, the hours in the client's time zone and the devices, and opens a country", async () => {
    const user = userEvent.setup();
    const { seen } = renderAt(MARKETING_PATHS.audience(CLIENT), {
      audience: (url: URL) =>
        url.searchParams.get("country")
          ? audienceReport({ level: "region", country: "US", places: [] })
          : audienceReport(),
    });
    const places = await screen.findByTestId("marketing-audience-places-table");
    expect(places).toHaveTextContent("United States");
    expect(places).toHaveTextContent("Unknown");
    expect(screen.getByTestId("marketing-audience-hours")).toHaveTextContent("America/Chicago");
    expect(screen.getByTestId("marketing-audience-hours").querySelectorAll("td.q5")).toHaveLength(
      1,
    );
    expect(screen.getByTestId("marketing-audience-device")).toHaveTextContent("desktop");
    await user.click(within(places).getByTestId("marketing-audience-open-US"));
    await waitFor(() => expect(seen.audience).toContain("?period=28&country=US"));
    expect(await screen.findByTestId("marketing-audience-all-countries")).toBeInTheDocument();
  });
});

describe("Visits", () => {
  it("lists visits by day only, filters them and pages through", async () => {
    const user = userEvent.setup();
    const { seen } = renderAt(`${MARKETING_PATHS.visits(CLIENT)}?source=referral`, {
      visits: (url: URL) => visitsReport({ page: Number(url.searchParams.get("page") ?? "1") }),
    });
    expect(await screen.findByTestId("marketing-visits-total")).toHaveTextContent(
      "120 visits, 3 reached a goal.",
    );
    expect(seen.visits?.[0]).toBe("?period=28&source=referral");
    const table = screen.getByTestId("marketing-visits-table");
    const open = within(table).getByTestId(`marketing-visits-open-${VISIT}`);
    expect(open).toHaveTextContent("Nov 6");
    expect(open).toHaveAttribute("href", `${MARKETING_PATHS.visit(CLIENT, VISIT)}?day=2026-11-06`);
    expect(table).toHaveTextContent("Austin, Texas, United States");
    expect(table.textContent).not.toMatch(/\d{1,2}:\d{2}/);

    await user.selectOptions(screen.getByTestId("marketing-visits-filter-goal"), "yes");
    await waitFor(() => expect(seen.visits).toContain("?period=28&source=referral&goal=yes"));
    await user.click(screen.getByTestId("marketing-visits-next"));
    await waitFor(() =>
      expect(seen.visits).toContain("?period=28&source=referral&goal=yes&page=2"),
    );
    await user.type(screen.getByTestId("marketing-visits-filter-country"), "us{Enter}");
    await waitFor(() => expect(seen.visits?.at(-1)).toContain("country=US"));
    await user.click(screen.getByTestId("marketing-visits-filter-clear"));
    await waitFor(() => expect(seen.visits?.at(-1)).toBe("?period=28"));
  });

  it("says when no visit matches", async () => {
    renderAt(MARKETING_PATHS.visits(CLIENT), {
      visits: visitsReport({ total: 0, visits: [], pages: 1 }),
    });
    expect(await screen.findByTestId("marketing-visits-empty")).toBeInTheDocument();
  });
});

describe("A visit", () => {
  it("shows its steps in order, a goal marked, and no time of day", async () => {
    const { seen } = renderAt(`${MARKETING_PATHS.visit(CLIENT, VISIT)}?day=2026-11-06`, {
      visit: visitReport(),
    });
    expect(await screen.findByTestId("marketing-visit-step-1")).toHaveTextContent(
      "Read /how-it-works: 1 min 5 s engaged, read to 75%",
    );
    expect(screen.getByTestId("marketing-visit-step-4")).toHaveTextContent("Clicked hero-talk");
    expect(screen.getByTestId("marketing-visit-step-4")).toHaveTextContent("Goal");
    expect(screen.getByRole("heading", { name: "A visit on Nov 6, 2026" })).toBeInTheDocument();
    expect(screen.getByTestId("marketing-visit").textContent).not.toMatch(/\d{1,2}:\d{2}/);
    expect(seen.visit).toEqual([`?day=2026-11-06&visit=${VISIT}`]);
  });

  it("gives the summary once the steps are past their 90 days, and says when there's no such visit", async () => {
    renderAt(`${MARKETING_PATHS.visit(CLIENT, VISIT)}?day=2026-11-06`, {
      visit: visitReport({ steps: null }),
    });
    expect(await screen.findByTestId("marketing-visit-no-steps")).toHaveTextContent(
      "/how-it-works → /",
    );
  });

  it("asks for nothing without a day", async () => {
    const { seen } = renderAt(MARKETING_PATHS.visit(CLIENT, VISIT), { visit: visitReport() });
    expect(await screen.findByTestId("marketing-visit-missing")).toBeInTheDocument();
    expect(seen.visit).toBeUndefined();
  });
});

describe("Sites", () => {
  it("shows each site, its snippet, and changes its goals and status", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    renderAt(
      MARKETING_PATHS.sites(CLIENT),
      { sites: sitesReport() },
      {
        [ACTION("update-site")]: ({ init }) => {
          bodies.push(JSON.parse(String(init.body)));
          return { result: { site: SITE_ROW } };
        },
      },
    );
    const t = `marketing-sites-${SITE}`;
    expect(await screen.findByTestId(`${t}-figures`)).toHaveTextContent(
      "380 visits in the last 7 days. Counted to Nov 7.",
    );
    await user.click(screen.getByTestId(`${t}-snippet-toggle`));
    expect(screen.getByTestId(`${t}-snippet-code`)).toHaveTextContent(
      `${window.location.origin}/api/in/marketing/${CLIENT}/${SITE}`,
    );
    await user.click(screen.getByTestId(`${t}-edit`));
    const goals = screen.getByTestId(`${t}-goals`);
    await user.clear(goals);
    await user.type(goals, "Bad Goal");
    expect(screen.getByTestId(`${t}-save`)).toBeDisabled();
    await user.clear(goals);
    await user.type(goals, "hero-talk, contact-email");
    await user.click(screen.getByTestId(`${t}-save`));
    await user.click(screen.getByTestId(`${t}-switch`));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies).toEqual([
      { siteId: SITE, name: "mezonas.com", goals: ["hero-talk", "contact-email"] },
      { siteId: SITE, status: "off" },
    ]);
    expect(screen.queryByTestId("marketing-sites-sample")).toBeNull();
    expect(screen.queryByTestId("marketing-sites-held")).toBeNull();
  });

  it("says measurement is held for a client in HIPAA mode (M50)", async () => {
    renderAt(MARKETING_PATHS.sites(CLIENT), {
      sites: { ...sitesReport(), measurementHeld: true },
    });
    expect(await screen.findByTestId("marketing-sites-held")).toHaveTextContent(
      "This client is in HIPAA mode, so nothing its sites send is stored.",
    );
  });

  it("adds a site, and says why one was refused", async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderAt(
      MARKETING_PATHS.sites(CLIENT),
      { sites: { sites: [] } },
      {
        [ACTION("add-site")]: () =>
          ++calls === 1
            ? new Reply(422, {
                error: "refused",
                message: "example.com is already measured for this client",
              })
            : { result: { site: SITE_ROW } },
      },
    );
    expect(await screen.findByTestId("marketing-sites-empty")).toBeInTheDocument();
    await user.type(screen.getByTestId("marketing-sites-add-domain"), "example.com");
    await user.click(screen.getByTestId("marketing-sites-add-save"));
    expect(
      await screen.findByText("example.com is already measured for this client"),
    ).toBeInTheDocument();
    await user.click(screen.getByTestId("marketing-sites-add-save"));
    expect(await screen.findByText("Added. Show its snippet to measure it.")).toBeInTheDocument();
  });

  it("fills the Sandbox with sample traffic", async () => {
    const user = userEvent.setup();
    renderAt(
      MARKETING_PATHS.sites(CLIENT),
      { sites: sitesReport() },
      { [ACTION("sample-traffic")]: () => ({ result: { sample: { days: 28, visits: 1901 } } }) },
      true,
    );
    await user.click(await screen.findByTestId("marketing-sites-sample-fill"));
    expect(await screen.findByTestId("marketing-sites-sample-note")).toHaveTextContent(
      "Filled 28 days with 1,901 sample visits.",
    );
  });
});

describe("the client settings' switch for one of ours", () => {
  it("marks a client as ours, with a reason", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const settings = opsClientSettings(CLIENT, "Mezonas");
    renderAt(
      `/ops/clients/${CLIENT}/settings`,
      {},
      {
        [`GET /api/ops/clients/${CLIENT}`]: () => ({
          client: {
            id: CLIENT,
            name: "Mezonas",
            timezone: "UTC",
            settings: {},
            createdAt: "2026-11-01T00:00:00.000Z",
          },
          agents: [],
          connections: [],
          members: [],
        }),
        [`GET /api/ops/clients/${CLIENT}/settings`]: () => settings,
        [`PATCH /api/ops/clients/${CLIENT}/settings`]: ({ init }) => {
          bodies.push(JSON.parse(String(init.body)));
          return { ...settings, client: { ...settings.client, internal: true } };
        },
      },
    );
    const card = await screen.findByTestId("ops-client-settings-internal");
    expect(within(card).getByTestId("ops-client-settings-internal-state")).toHaveTextContent(
      "A client",
    );
    await user.type(
      within(card).getByTestId("ops-client-settings-internal-reason"),
      "Mezonas itself",
    );
    await user.click(within(card).getByTestId("ops-client-settings-internal-save"));
    await waitFor(() =>
      expect(within(card).getByTestId("ops-client-settings-internal-state")).toHaveTextContent(
        "Ours",
      ),
    );
    expect(bodies).toEqual([{ internal: true, reason: "Mezonas itself" }]);
  });
});
