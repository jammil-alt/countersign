import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import {
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

const escalation = (id: string, tenantId: string) => ({
  id,
  tenantId,
  kind: "approval",
  agentId: null,
  runId: null,
  subjectType: null,
  subjectId: null,
  assigneeRole: "operator",
  assigneeUserId: null,
  title: "Check the match",
  payload: {},
  status: "open",
  resolution: null,
  resolvedBy: null,
  dueAt: null,
  createdAt: "2026-11-05T10:00:00.000Z",
  resolvedAt: null,
  resolvableByOperator: true,
});

const clientRow = (id: string, name: string) => ({
  id,
  name,
  timezone: "UTC",
  createdAt: "2026-11-01T00:00:00.000Z",
  agents: 1,
  openInbox: 0,
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
});

describe("back office layout", () => {
  it("has the top bar, client switcher, escalations and the prototype's sidebar", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({
        clients: [clientRow(SANDBOX, "Sandbox"), clientRow(DEMO, "Demo client")],
      }),
      "GET /api/ops/inbox": () => ({
        items: [
          escalation("00000000-0000-4000-8000-0000000f0001", DEMO),
          escalation("00000000-0000-4000-8000-0000000f0002", DEMO),
        ],
        agents: [],
      }),
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

    const nav = screen.getByRole("complementary", { name: "Navigation" });
    expect(within(nav).getByTestId("ops-nav-home")).toHaveAttribute("href", "/ops");
    for (const label of [
      "Command center",
      "Escalations",
      "Runs",
      "Agent lab",
      "Skills and automations",
      "Connectors",
      "Usage and billing",
      "Feedback",
      // Kept reachable under More.
      "Requests",
      "Billing",
      "Website logins",
      "Audit log",
    ]) {
      expect(within(nav).getByText(label)).toBeInTheDocument();
    }
    // Each client with what needs us; the selected one is the current page.
    expect(within(nav).getByTestId(`ops-nav-client-${DEMO}`)).toHaveTextContent("Demo client2");
    expect(within(nav).getByTestId(`ops-nav-client-${SANDBOX}`)).toHaveTextContent("Sandbox0");
    expect(within(nav).getByTestId(`ops-nav-client-${SANDBOX}`)).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByTestId("ops-nav-clients")).toHaveTextContent("All 2 clients");
    // The selected client's own pages and agents.
    expect(within(nav).getByTestId("ops-nav-connections")).toHaveAttribute(
      "href",
      `/ops/clients/${SANDBOX}/connections`,
    );
    const agent = await within(nav).findByTestId("ops-nav-agent-material-costs");
    expect(agent).toHaveAttribute("href", `/ops/clients/${SANDBOX}/agents/material-costs`);
    expect(within(agent).getByText("Purchasing")).toBeInTheDocument();
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
    expect(screen.getAllByText("No agents yet.").length).toBeGreaterThan(0);
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
        agents: [...SANDBOX_DETAIL.agents, second],
      }),
    });
    renderAt(`/ops/clients/${SANDBOX}/agents/material-costs`, api);
    const switcher = (await screen.findByTestId("agent-switcher")) as HTMLSelectElement;
    expect(switcher.value).toBe("material-costs");
    expect([...switcher.options].map((o) => o.text)).toEqual(["Material costs", "Bill clerk"]);
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

  it("switches between agents from an agent's page", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () =>
        overview([service(SERVICE, "Material costs"), service(SERVICE_2, "Bill clerk")]),
    });
    renderAt(`/agents/${SERVICE}`, api);
    const switcher = (await screen.findByTestId("agent-switcher")) as HTMLSelectElement;
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
