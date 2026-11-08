// The back office's Marketing area shell (docs/plan.md §1.73): the sidebar's entry opens our own
// client with the pack on (one: straight there; several: a choice; none: how to set it up), each
// page renders in the area's frame with its sub-navigation, and the API helpers pass a report's
// query parameters.
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../../App";
import { fakeApi, OPERATOR_SESSION } from "../../../test/fixtures";
import { cleanQuery, marketingCsvHref, useMarketingReport } from "./api";
import { marketingClients } from "./Entry";
import { MARKETING_NAV, MARKETING_PATHS, sectionOf } from "./paths";

const OURS = "00000000-0000-4000-8000-00000000a011";
const OURS_2 = "00000000-0000-4000-8000-00000000a012";
const OTHER = "00000000-0000-4000-8000-00000000a013";

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{`${pathname}${search}`}</span>;
}

const row = (id: string, name: string, internal = false) => ({
  id,
  name,
  timezone: "America/Chicago",
  createdAt: "2026-11-01T00:00:00.000Z",
  agents: 0,
  openInbox: 0,
  needsUs: 0,
  waitingRuns: 0,
  sandbox: false,
  internal,
});

function marketingPack(enabled: string[], all: { id: string; name: string }[]) {
  return {
    packs: [
      {
        id: "marketing",
        name: "Marketing",
        version: "0.1.0",
        description: "",
        templates: [],
        screens: [],
        clients: all.map((c) => ({
          ...c,
          enabled: enabled.includes(c.id),
          enabledAt: enabled.includes(c.id) ? "2026-11-08T00:00:00.000Z" : null,
        })),
      },
    ],
  };
}

function renderAt(path: string, clients: ReturnType<typeof row>[], enabled: string[]) {
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    "GET /api/ops/clients": () => ({ clients }),
    "GET /api/ops/packs": () => marketingPack(enabled, clients),
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
        <LocationProbe />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("the Marketing entry", () => {
  it("chooses our own client with the pack on", () => {
    const ours = new Set([OURS]);
    expect(marketingClients([{ id: OURS, name: "Mezonas" }], ours).open).toBe(OURS);
    const both = marketingClients(
      [
        { id: OURS, name: "Mezonas" },
        { id: OURS_2, name: "Mezonas (staging copy)" },
      ],
      new Set([OURS, OURS_2]),
    );
    expect(both.open).toBeNull();
    expect(both.ours.map((c) => c.id)).toEqual([OURS, OURS_2]);
    const none = marketingClients([{ id: OTHER, name: "Acme" }], ours);
    expect([none.open, none.ours.length, none.others.map((c) => c.id)]).toEqual([null, 0, [OTHER]]);
  });

  it("is in the sidebar, and goes straight to our client's overview", async () => {
    renderAt("/ops/marketing", [row(OURS, "Mezonas", true), row(OTHER, "Acme")], [OURS, OTHER]);
    const nav = await screen.findByRole("complementary", { name: "Navigation" });
    expect(within(nav).getByTestId("ops-nav-marketing")).toHaveAttribute("href", "/ops/marketing");
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(MARKETING_PATHS.overview(OURS)),
    );
    expect(await screen.findByTestId("marketing-overview-coming")).toHaveTextContent(
      "Coming in M44",
    );
    expect(await screen.findByRole("heading", { name: "Mezonas" })).toBeInTheDocument();
  });

  it("offers a choice when several of ours have it on", async () => {
    renderAt(
      "/ops/marketing",
      [row(OURS, "Mezonas", true), row(OURS_2, "Mezonas two", true)],
      [OURS, OURS_2],
    );
    const choice = await screen.findByTestId("marketing-entry-choice");
    expect(within(choice).getByTestId(`marketing-entry-open-${OURS_2}`)).toHaveAttribute(
      "href",
      MARKETING_PATHS.overview(OURS_2),
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/ops/marketing");
  });

  it("says how to set it up when none of ours has it on", async () => {
    renderAt("/ops/marketing", [row(OURS, "Mezonas", true), row(OTHER, "Acme")], [OTHER]);
    expect(await screen.findByTestId("marketing-entry-none")).toHaveTextContent(
      "Mark our client as one of ours in its settings",
    );
    expect(screen.getByTestId("marketing-entry-packs")).toHaveAttribute("href", "/ops/packs");
    expect(
      within(screen.getByTestId("marketing-entry-others")).getByText("Acme"),
    ).toBeInTheDocument();
  });
});

describe("a client's Marketing pages", () => {
  it.each(MARKETING_NAV.map((s) => s.id))("%s has its frame and sub-navigation", async (id) => {
    renderAt(MARKETING_PATHS[id](OURS), [row(OURS, "Mezonas", true)], [OURS]);
    const nav = await screen.findByTestId("marketing-nav");
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(MARKETING_NAV.map((s) => s.label));
    const current = links.find((l) => l.getAttribute("href") === MARKETING_PATHS[id](OURS));
    expect(current?.className).toContain("border-slate");
    expect(await screen.findByText(/^Coming in M4\d$/)).toBeInTheDocument();
  });

  it("sends the area's own address to its overview", async () => {
    renderAt(MARKETING_PATHS.base(OURS), [row(OURS, "Mezonas", true)], [OURS]);
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(MARKETING_PATHS.overview(OURS)),
    );
  });

  it("puts a page in depth under its list's section", () => {
    expect(sectionOf(MARKETING_PATHS.page(OURS, "/pricing").split("?")[0] ?? "", OURS)).toBe(
      "pages",
    );
    expect(sectionOf(MARKETING_PATHS.visit(OURS, "ab12"), OURS)).toBe("visits");
    expect(sectionOf(MARKETING_PATHS.report(OURS, OTHER), OURS)).toBe("reports");
    expect(sectionOf(MARKETING_PATHS.base(OURS), OURS)).toBe("overview");
  });
});

function ReportProbe({ query }: { query: Record<string, string | undefined> }) {
  const r = useMarketingReport<{ ok: boolean }>(OURS, "overview", query);
  return <span data-testid="probe">{r.data ? "loaded" : "waiting"}</span>;
}

describe("the area's API helpers", () => {
  it("send a report's query parameters, leaving unset ones out", async () => {
    const seen: string[] = [];
    const api = fakeApi({
      [`GET /api/ops/clients/${OURS}/reports/marketing/overview`]: ({ url }) => {
        seen.push(url.search);
        return { report: { ok: true } };
      },
    });
    render(
      <MemoryRouter>
        <AppProviders client={api.client}>
          <ReportProbe query={{ site: OTHER, from: "2026-11-01", to: undefined }} />
        </AppProviders>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("loaded"));
    expect(seen).toEqual([`?site=${OTHER}&from=2026-11-01`]);
    expect(cleanQuery({ a: "", b: null, c: 3 })).toEqual({ c: "3" });
    expect(marketingCsvHref(OURS, "pages", { site: OTHER })).toBe(
      `/api/ops/clients/${OURS}/reports/marketing/pages/csv?site=${OTHER}`,
    );
  });
});
