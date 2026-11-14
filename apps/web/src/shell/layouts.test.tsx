import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import {
  AGENT_DETAIL,
  CLIENT_SESSION,
  fakeApi,
  OPERATOR_SESSION,
  Reply,
  SANDBOX_DETAIL,
  tableService,
  tableView,
} from "../test/fixtures";

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const SANDBOX = "00000000-0000-4000-8000-00000000a001";
const DEMO = "00000000-0000-4000-8000-00000000a002";
const SERVICE = "00000000-0000-4000-8000-00000000b001";
const SERVICE_2 = "00000000-0000-4000-8000-00000000b002";

const overview = (services: unknown[] = [], inbox = 0) => ({
  client: { id: DEMO, name: "Demo client" },
  services,
  needsYou: { inbox },
  recentRuns: [],
});

const service = (id: string, name: string, status = "active") => ({
  id,
  name,
  description: "Keeps bills itemized.",
  status,
});

/** `GET /api/services/:id`: what the agent page's header needs. */
const serviceDetail = (id: string, name: string) => ({
  service: { id, name, description: null, status: "active" },
  thisMonth: {
    from: "2026-11-01",
    to: "2026-11-07",
    runs: { total: 0, succeeded: 0, failed: 0, cancelled: 0, waiting: 0, going: 0 },
    documentsRead: 0,
    actions: 0,
  },
  recentRuns: [],
  packs: [],
});

const clientRow = (id: string, name: string, needsUs = 0) => ({
  id,
  name,
  timezone: "UTC",
  createdAt: "2026-11-01T00:00:00.000Z",
  agents: 1,
  openInbox: needsUs,
  needsUs,
  waitingRuns: 0,
});

/** GET /api/ops/counts for these clients' Needs us. */
const counts = (...rows: [string, number][]) => ({
  needsUs: rows.reduce((n, [, c]) => n + c, 0),
  clients: rows.map(([id, needsUs]) => ({ id, needsUs, waitingRuns: 0 })),
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
  sessionStorage.clear();
});

describe("back office layout", () => {
  it("has the top bar, client switcher, escalations and the prototype's sidebar", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({
        // What needs us, counted per client by the API (UI cleanup, stream A): the badges read it.
        clients: [clientRow(SANDBOX, "Sandbox"), clientRow(DEMO, "Demo client", 2)],
      }),
      // The badges (§1.84): what needs us, counted per client by the API.
      "GET /api/ops/counts": () => counts([SANDBOX, 0], [DEMO, 2]),
      [`GET /api/ops/clients/${SANDBOX}`]: () => SANDBOX_DETAIL,
    });
    renderAt(`/ops/clients/${SANDBOX}`, api);

    const shell = await screen.findByTestId("shell-ops");
    // The product is Mezonas: its logo names it; the code name never shows.
    expect(within(shell).getByRole("img", { name: "Mezonas" })).toBeInTheDocument();
    expect(within(shell).queryByText(/Countersign|Platform name/)).toBeNull();
    expect(screen.getByTestId("shell-search")).toHaveTextContent(
      "Find a client, agent, run or record",
    );
    const escalations = screen.getByTestId("shell-inbox");
    expect(escalations).toHaveAttribute("href", "/ops/inbox");
    await waitFor(() => expect(escalations).toHaveTextContent("Escalations2"));
    // The operator is a Mezonas person: their avatar is the lead's copper one.
    expect(screen.getByTestId("shell-avatar")).toHaveTextContent("O");
    expect(screen.getByTestId("shell-avatar")).toHaveClass("mz-lead");

    const switcher = screen.getByTestId("ops-client-switcher") as HTMLSelectElement;
    expect(switcher.value).toBe(SANDBOX);
    expect([...switcher.options].map((o) => o.text)).toEqual([
      "All clients",
      "Sandbox",
      "Demo client",
    ]);

    // Places only: Home, Escalations, Runs, Clients, Reggie (§1.101), Build, Business, and Utilities.
    const nav = screen.getByRole("complementary", { name: "Navigation" });
    expect(within(nav).getByTestId("ops-nav-home")).toHaveAttribute("href", "/ops");
    expect(within(nav).getByTestId("ops-nav-home")).toHaveTextContent("Home");
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent?.replace(/\d+$/, "")),
    ).toEqual([
      "Home",
      "Escalations",
      "Runs",
      "Clients",
      "Reggie",
      "Agent lab",
      // R8: skills, tools, connectors and the other banks are in the Library.
      "Library",
      "Packs",
      "Usage and billing",
      "Marketing",
      // Feedback, the audit queue (wave 6), the audit log and requests are tabs of Utilities;
      // website logins are in the Library (R8).
      "Utilities",
    ]);
    // Billing is under Usage and billing, not Utilities.
    expect(within(nav).queryByText("Billing")).toBeNull();
    // Clients is one link, current on a client's page; no client or agent rows.
    expect(within(nav).getByTestId("ops-nav-clients")).toHaveAttribute("href", "/ops/clients");
    expect(within(nav).getByTestId("ops-nav-clients")).toHaveAttribute("aria-current", "page");
    expect(within(nav).queryByTestId(`ops-nav-client-${SANDBOX}`)).toBeNull();
    expect(within(nav).queryByTestId("ops-nav-connections")).toBeNull();
    expect(within(nav).queryByTestId("ops-nav-agent-material-costs")).toBeNull();
  });

  it("keeps the picked client on a page of its own, and on pages with no client", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({
        clients: [clientRow(SANDBOX, "Sandbox"), clientRow(DEMO, "Demo client")],
      }),
      [`GET /api/ops/clients/${DEMO}`]: () => ({
        ...SANDBOX_DETAIL,
        client: { ...SANDBOX_DETAIL.client, id: DEMO, name: "Demo client" },
        agents: [],
      }),
    });
    const { unmount } = renderAt("/ops/lab", api);
    const switcher = (await screen.findByTestId("ops-client-switcher")) as HTMLSelectElement;
    await waitFor(() => expect(switcher.options.length).toBe(3));
    expect(switcher.value).toBe("");
    await userEvent.selectOptions(switcher, DEMO);
    await screen.findByRole("heading", { level: 1, name: "Demo client" });
    unmount();

    // A page with no client of its own (Agent lab) shows the last pick, in this tab's session.
    renderAt("/ops/lab", api);
    const again = (await screen.findByTestId("ops-client-switcher")) as HTMLSelectElement;
    await waitFor(() => expect(again.value).toBe(DEMO));
    // "All clients" forgets it.
    await userEvent.selectOptions(again, "");
    await waitFor(() => expect(again.value).toBe(""));
    expect(sessionStorage.getItem("mezonas.ops.client")).toBeNull();
  });

  it("keeps the badges fresh from the counts alone, and loads the clients list once", async () => {
    let needs = 2;
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({
        clients: [clientRow(SANDBOX, "Sandbox"), clientRow(DEMO, "Demo client")],
      }),
      "GET /api/ops/counts": () => counts([SANDBOX, 0], [DEMO, needs]),
      [`GET /api/ops/clients/${DEMO}`]: () => ({
        ...SANDBOX_DETAIL,
        client: { ...SANDBOX_DETAIL.client, id: DEMO, name: "Demo client" },
        agents: [],
      }),
    });
    renderAt("/ops/lab", api);
    const escalations = await screen.findByTestId("shell-inbox");
    await waitFor(() => expect(escalations).toHaveTextContent("Escalations2"));
    // The picker's list is names only (§1.84): its counts come from GET /api/ops/counts.
    expect(api.calls).not.toContain("GET /api/ops/needs-us");

    // A page change asks for the counts again; the list is not loaded again.
    needs = 5;
    await userEvent.selectOptions(await screen.findByTestId("ops-client-switcher"), DEMO);
    await screen.findByRole("heading", { level: 1, name: "Demo client" });
    await waitFor(() => expect(escalations).toHaveTextContent("Escalations5"));
    expect(api.calls.filter((c) => c === "GET /api/ops/clients")).toHaveLength(1);
    // The client's own page reads its Needs us from those counts.
    await waitFor(() =>
      expect(screen.getByTestId("ops-client-needs-us")).toHaveTextContent("Needs us 5"),
    );
  });

  it("opens a client from the switcher", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${DEMO}`]: () => ({
        ...SANDBOX_DETAIL,
        client: { ...SANDBOX_DETAIL.client, id: DEMO, name: "Demo client" },
        agents: [],
      }),
    });
    renderAt("/ops", api);
    const switcher = await screen.findByTestId("ops-client-switcher");
    await userEvent.selectOptions(switcher, DEMO);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Demo client" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/^No agents yet\./).length).toBeGreaterThan(0);
    expect(switcher).toHaveValue(DEMO);
  });

  it("switches between a client's agents from an agent's page", async () => {
    const second = {
      ...SANDBOX_DETAIL.agents[0],
      id: SERVICE_2,
      slug: "bill-clerk",
      name: "Bill clerk",
    };
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${SANDBOX}`]: () => ({
        ...SANDBOX_DETAIL,
        agents: [...SANDBOX_DETAIL.agents, { ...second, serviceName: "Bills" }],
      }),
      [`GET /api/ops/clients/${SANDBOX}/agents`]: () => ({ agents: SANDBOX_DETAIL.agents }),
      [`GET /api/ops/agents/${AGENT_DETAIL.agent.id}`]: () => AGENT_DETAIL,
      [`GET /api/ops/agents/${AGENT_DETAIL.agent.id}/skills`]: () => ({ skills: [] }),
    });
    renderAt(`/ops/clients/${SANDBOX}/agents/material-costs`, api);
    // The switcher is in the agent's own header, after its client, not on a bar of its own.
    const crumbs = await screen.findByTestId("agent-bar-crumbs");
    const switcher = (await within(crumbs).findByTestId("agent-switcher")) as HTMLSelectElement;
    expect(switcher.value).toBe("material-costs");
    // Each agent by the name the client knows it by.
    expect([...switcher.options].map((o) => o.text)).toEqual(["Material costs", "Bills"]);
  });

  it("sends a client user who opens /ops to the portal, without loading the back office", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview(),
    });
    renderAt(`/ops/clients/${DEMO}`, api);
    expect(await screen.findByTestId("shell-portal")).toBeInTheDocument();
    expect(screen.queryByTestId("shell-ops")).toBeNull();
    expect(api.calls.some((c) => c.includes("/api/ops/"))).toBe(false);
  });
});

describe("portal layout", () => {
  // QA round 1: nothing pops in late. The Inbox's count keeps its place while it loads.
  it("holds the Inbox count's place while it loads", async () => {
    let answer: (v: unknown) => void = () => {};
    const later = new Promise((resolve) => {
      answer = resolve;
    });
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => later,
      "GET /api/table": () => tableView(),
    });
    renderAt("/runs", api);
    const nav = await screen.findByRole("complementary", { name: "Navigation" });
    expect(
      within(within(nav).getByTestId("portal-nav-inbox")).getByTestId("count-slot"),
    ).toBeTruthy();
    // The top bar's Inbox keeps its count's place too.
    expect(within(screen.getByTestId("shell-inbox")).getByTestId("count-slot")).toBeTruthy();

    answer(overview([{ ...service(SERVICE, "Material costs"), stage: "live" }], 1));
    await waitFor(() =>
      expect(
        within(within(nav).getByTestId("portal-nav-inbox")).queryByTestId("count-slot"),
      ).toBeNull(),
    );
    expect(within(nav).getByTestId("portal-nav-inbox")).toHaveTextContent("1");
  });

  it("shows the client's name, the Inbox count, no switcher, and places only in the sidebar", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview([service(SERVICE, "Material costs")], 3),
      "GET /api/table": () =>
        tableView({
          services: [
            tableService(SERVICE, "Material costs", { description: "Keeps bills itemized." }),
          ],
          desk: { open: 3, top: [] },
        }),
    });
    renderAt("/", api);

    const shell = await screen.findByTestId("shell-portal");
    expect(within(shell).getByTestId("portal-client-name")).toHaveTextContent("Demo client");
    expect(screen.queryByTestId("ops-client-switcher")).toBeNull();
    expect(screen.getByTestId("shell-search")).toHaveTextContent(
      "Search your agents, runs, records and people",
    );
    const inbox = screen.getByTestId("shell-inbox");
    expect(inbox).toHaveAttribute("href", "/inbox");
    await waitFor(() => expect(inbox).toHaveTextContent("Inbox3"));
    // The signed-in client is the self avatar (ink), not the lead's copper.
    expect(screen.getByTestId("shell-avatar")).toHaveClass("ds-avatar--self");

    // Review 1: the sidebar lists places (Home, Inbox, Runs, Accounts, Contacts), Settings at its
    // foot; no agents, no "Your business", no "More", no Sloan card.
    const nav = screen.getByRole("complementary", { name: "Navigation" });
    const links = within(nav)
      .getAllByRole("link")
      .map((a) => [a.getAttribute("data-testid"), a.getAttribute("href")]);
    expect(links).toEqual([
      ["portal-nav-home", "/"],
      ["portal-nav-inbox", "/inbox"],
      ["portal-nav-runs", "/runs"],
      ["portal-nav-accounts", "/accounts"],
      ["portal-nav-contacts", "/contacts"],
      ["portal-nav-settings", "/settings"],
    ]);
    expect(within(nav).getByTestId("portal-nav-home")).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByTestId("portal-nav-inbox")).toHaveTextContent("Inbox3");
    expect(within(nav).queryByTestId("portal-nav-sloan")).toBeNull();
    expect(within(nav).queryByTestId(`portal-nav-agent-${SERVICE}`)).toBeNull();
    // No lead set: no lead row.
    expect(screen.queryByTestId("portal-lead")).toBeNull();

    // The agents are on Home.
    const card = await screen.findByTestId(`portal-service-${SERVICE}`);
    expect(within(card).getByText("Keeps bills itemized.")).toBeInTheDocument();
    // Its state in the status model: live and idle is Ready (never "Active").
    expect(within(card).getByText("Ready")).toBeInTheDocument();
  });

  it("names the client's Mezonas lead in copper, once: in the avatar menu with Settings", async () => {
    const api = fakeApi({
      "GET /api/session": () => ({ ...CLIENT_SESSION, lead: { name: "Ana Ruiz" } }),
      "GET /api/overview": () => overview(),
    });
    renderAt("/", api);
    await userEvent.click(await screen.findByTestId("shell-avatar"));
    const menu = screen.getByTestId("shell-user-menu");
    const lead = within(menu).getByTestId("portal-lead");
    expect(lead).toHaveTextContent("Ana Ruiz");
    expect(lead).toHaveTextContent("Your Mezonas lead");
    expect(lead.querySelector(".mz-lead")).toHaveTextContent("AR");
    expect(screen.getAllByTestId("portal-lead")).toHaveLength(1);
    expect(within(menu).getByTestId("shell-menu-settings")).toHaveAttribute("href", "/settings");
  });

  it("gives a client user the same places, and keeps their own settings", async () => {
    const api = fakeApi({
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        tenants: [{ id: DEMO, name: "Demo client", role: "client_user" }],
      }),
      "GET /api/overview": () => overview(),
      "GET /api/table": () => tableView(),
    });
    renderAt("/", api);
    await screen.findByTestId("shell-portal");
    // Settings holds everyone's own notifications and language; the company's are the admin's.
    expect(screen.getByTestId("portal-nav-settings")).toHaveAttribute("href", "/settings");
    // Client users read Contacts too (its people and organizations).
    expect(screen.getByTestId("portal-nav-contacts")).toHaveAttribute("href", "/contacts");
    expect(await screen.findByText(/No agents yet/)).toBeInTheDocument();
  });

  it("offers Ask Sloan beside the Inbox, saying what Sloan is", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview(),
    });
    renderAt("/", api);
    const ask = await screen.findByTestId("shell-ask-sloan");
    expect(ask).toHaveAttribute("href", "/sloan");
    expect(ask).toHaveTextContent("Ask Sloan");
    expect(ask).toHaveAttribute("title", "Your account agent: ask about your agents' work");
    // Its name starts with the words it shows, so it reads the same with the badge alone.
    expect(ask.getAttribute("aria-label")).toMatch(/^Ask Sloan\. /);
    // It sits in the top bar, before the Inbox.
    const inbox = screen.getByTestId("shell-inbox");
    expect(ask.compareDocumentPosition(inbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("switches between agents from an agent's page", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () =>
        overview([service(SERVICE, "Material costs"), service(SERVICE_2, "Bill clerk")]),
      [`GET /api/services/${SERVICE}`]: () => serviceDetail(SERVICE, "Material costs"),
      [`GET /api/services/${SERVICE_2}`]: () => serviceDetail(SERVICE_2, "Bill clerk"),
    });
    renderAt(`/agents/${SERVICE}`, api);
    // The switcher is in the agent page's header, after its eyebrow, like a breadcrumb.
    const switcher = (await screen.findByTestId("agent-switcher")) as HTMLSelectElement;
    expect(switcher.closest(".ui-crumbs")).not.toBeNull();
    expect(switcher.value).toBe(SERVICE);
    await userEvent.selectOptions(switcher, SERVICE_2);
    await waitFor(() =>
      expect((screen.getByTestId("agent-switcher") as HTMLSelectElement).value).toBe(SERVICE_2),
    );
  });

  it("folds the sidebar behind the menu button", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview(),
    });
    renderAt("/", api);
    const menu = await screen.findByTestId("shell-menu");
    const sidebar = screen.getByRole("complementary", { name: "Navigation" });
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(sidebar).not.toHaveAttribute("data-open");
    await userEvent.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    expect(sidebar).toHaveAttribute("data-open", "true");
    // Opening a page closes it.
    await userEvent.click(within(sidebar).getByTestId("portal-nav-runs"));
    await waitFor(() => expect(sidebar).not.toHaveAttribute("data-open"));
  });

  it("folds to a rail of icons on a wide screen, each named in a tooltip", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(min-width: 768px)",
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    try {
      const api = fakeApi({
        "GET /api/session": () => CLIENT_SESSION,
        "GET /api/overview": () => overview(),
      });
      renderAt("/", api);
      // Collapse is at the sidebar's foot, as in Anchor; the top bar's menu button is the phone's.
      const sidebar = await screen.findByRole("complementary", { name: "Navigation" });
      const toggle = within(sidebar).getByTestId("sidebar-collapse");
      expect(toggle).toHaveAccessibleName("Collapse");
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      await userEvent.click(toggle);
      expect(sidebar).toHaveAttribute("data-collapsed", "true");
      expect(localStorage.getItem("mezonas.sidebar")).toBe("collapsed");
      expect(toggle).toHaveAccessibleName("Expand");
      expect(toggle).toHaveAttribute("aria-expanded", "false");

      // The words stay for screen readers; hovering an icon names it beside it.
      const runs = within(sidebar).getByTestId("portal-nav-runs");
      expect(runs).toHaveAccessibleName("Runs");
      await userEvent.hover(runs);
      expect(screen.getByTestId("sidebar-tip")).toHaveTextContent("Runs");
      await userEvent.unhover(sidebar);
      expect(screen.queryByTestId("sidebar-tip")).toBeNull();

      await userEvent.click(toggle);
      expect(sidebar).not.toHaveAttribute("data-collapsed");
      expect(localStorage.getItem("mezonas.sidebar")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the theme the person picks, and goes back to the system's", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview(),
    });
    renderAt("/", api);
    await userEvent.click(await screen.findByTestId("shell-avatar"));
    expect(screen.getByTestId("shell-theme-system")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByTestId("shell-theme-dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("mezonas.theme")).toBe("dark");
    expect(screen.getByTestId("shell-theme-dark")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByTestId("shell-theme-system"));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("mezonas.theme")).toBeNull();
  });

  it("sends an operator who opens the portal to /ops", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({ clients: [] }),
    });
    renderAt("/", api);
    expect(await screen.findByTestId("shell-ops")).toBeInTheDocument();
  });

  it("signs out to the sign-in screen", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview(),
      "POST /api/auth/sign-out": () => ({ ok: true, redirectTo: null }),
    });
    renderAt("/", api);
    await userEvent.click(await screen.findByTestId("shell-avatar"));
    api.on("GET /api/session", () => new Reply(401, { error: { code: "unauthenticated" } }));
    await userEvent.click(screen.getByTestId("shell-sign-out"));
    await waitFor(() => expect(screen.getByText("Sign in to Mezonas")).toBeInTheDocument());
    expect(api.calls).toContain("POST /api/auth/sign-out");
  });
});

describe("tabTitle", () => {
  it("leads with what is waiting, then the place, then Mezonas", async () => {
    const { tabTitle } = await import("./Shell");
    expect(tabTitle("Back office", undefined)).toBe("Back office · Mezonas");
    expect(tabTitle("Harbor Millwork", 3)).toBe("(3) Harbor Millwork · Mezonas");
    expect(tabTitle("Harbor Millwork", 0)).toBe("Harbor Millwork · Mezonas");
    expect(tabTitle(null, undefined)).toBe("Mezonas");
  });
});
