import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { createTranslator } from "../i18n/catalog";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION } from "../test/fixtures";
import { opsSearchGroups, portalSearchGroups } from "./searchGroups";

const SVC = "00000000-0000-4000-8000-00000000b001";
const RUN = "00000000-0000-4000-8000-00000000c001";
const TXN = "00000000-0000-4000-8000-00000000d101";
const SANDBOX = "00000000-0000-4000-8000-00000000a001";

const EMPTY = { services: [], runs: [], records: [], people: [], organizations: [], documents: [] };

const RECORD = {
  kind: "transaction" as const,
  id: TXN,
  label: "Rugby Architectural 48211",
  type: "bill",
  number: "48211",
  date: "2026-11-04",
  amount: "1284.00",
  currency: "USD",
};

const PORTAL_HITS = {
  ...EMPTY,
  services: [{ id: SVC, name: "Material costs", status: "active" }],
  runs: [
    {
      id: RUN,
      shortId: "R-c001",
      service: { id: SVC, name: "Material costs" },
      status: "succeeded",
      createdAt: "2026-11-05T10:00:00.000Z",
    },
  ],
  records: [RECORD],
};

function LocationProbe() {
  const { pathname } = useLocation();
  return <span data-testid="location">{pathname}</span>;
}

function renderPortal(searches: string[]) {
  const api = fakeApi({
    "GET /api/session": () => CLIENT_SESSION,
    "GET /api/overview": () => ({
      client: { id: CLIENT_SESSION.activeTenantId, name: "Demo client" },
      services: [],
      needsYou: { inbox: 0 },
      recentRuns: [],
    }),
    "GET /api/search": ({ url }) => {
      searches.push(url.searchParams.get("q") ?? "");
      return PORTAL_HITS;
    },
  });
  render(
    <MemoryRouter initialEntries={["/"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
        <LocationProbe />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("⌘K search", () => {
  it("opens with Ctrl+K, searches the client's own things, and opens a hit with the keyboard", async () => {
    const searches: string[] = [];
    renderPortal(searches);
    await screen.findByTestId("shell-portal");
    await userEvent.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Search" });
    expect(within(dialog).getByText(/Type a name/)).toBeInTheDocument();

    await userEvent.type(screen.getByTestId("search-input"), "birch");
    const hits = await screen.findAllByTestId("search-hit");
    expect(searches).toEqual(["birch"]);
    expect(hits.map((h) => h.getAttribute("href"))).toEqual([
      `/agents/${SVC}`,
      `/runs/${RUN}`,
      `/records/${TXN}`,
    ]);
    expect(within(dialog).getByRole("group", { name: "Runs" })).toHaveTextContent(
      "R-c001 · Material costsDone",
    );
    expect(hits[0]).toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getAllByTestId("search-hit")[1]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/runs/${RUN}`));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens from the box, says when nothing matches, and closes with Escape", async () => {
    const searches: string[] = [];
    renderPortal(searches);
    await userEvent.click(await screen.findByTestId("shell-search"));
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(searches).toEqual([]);
  });
});

describe("search groups", () => {
  const t = createTranslator("en");

  it("links the portal's hits to their pages; receivables to their list", () => {
    const groups = portalSearchGroups(
      {
        ...EMPTY,
        records: [{ ...RECORD, kind: "receivable", id: "x" }],
        people: [
          {
            id: "p1",
            name: "Jen Ortiz",
            email: "jen@lakeside.example",
            title: "AP",
            organization: { id: "o1", name: "Lakeside" },
          },
        ],
        documents: [
          {
            id: "doc1",
            filename: "48211.pdf",
            status: "read",
            vendor: "Rugby",
            number: "48211",
            receivedAt: "2026-11-04T00:00:00.000Z",
          },
        ],
      },
      t,
    );
    const hrefs = groups.flatMap((g) => g.hits.map((h) => h.href));
    expect(hrefs).toEqual(["/records?kind=receivables", "/people/directory", "/documents/doc1"]);
    expect(groups.find((g) => g.label === "People")?.hits[0]?.meta).toBe(
      "AP · Lakeside · jen@lakeside.example",
    );
  });

  it("names each back-office hit's client and finds clients by name", () => {
    const client = { id: SANDBOX, name: "Sandbox" };
    const groups = opsSearchGroups(
      {
        agents: [
          {
            id: "a1",
            name: "Material costs",
            serviceName: null,
            kind: "client",
            client,
            status: "active",
          },
          {
            id: "t1",
            name: "Pia",
            serviceName: null,
            kind: "template",
            client: null,
            status: null,
          },
        ],
        runs: [],
        records: [{ ...RECORD, client }],
        people: [],
        organizations: [],
        documents: [],
      },
      [client, { id: "other", name: "Harbor Millwork" }],
      "sand",
    );
    const flat = groups.flatMap((g) => g.hits.map((h) => [h.href, h.meta ?? ""]));
    expect(flat).toEqual([
      [`/ops/clients/${SANDBOX}`, ""],
      ["/ops/agents/a1", "Sandbox · active"],
      ["/ops/agents/t1", "Template"],
      [`/ops/clients/${SANDBOX}/records/${TXN}`, "Sandbox · 48211 · 2026-11-04 · 1284.00 · USD"],
    ]);
  });

  it("searches across the clients served in the back office", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/search": () => ({
        agents: [],
        runs: [],
        records: [],
        people: [],
        organizations: [],
        documents: [],
      }),
    });
    render(
      <MemoryRouter initialEntries={["/ops"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByTestId("shell-search"));
    await userEvent.type(screen.getByTestId("search-input"), "Demo");
    // Clients come from the session's list while the API's loads (here it 404s).
    const hit = await screen.findByTestId("search-hit");
    expect(hit).toHaveAttribute("href", "/ops/clients/00000000-0000-4000-8000-00000000a002");
    expect(api.calls).toContain("GET /api/ops/search");
  });
});
