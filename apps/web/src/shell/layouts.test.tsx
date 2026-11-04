import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION, Reply, SANDBOX_DETAIL } from "../test/fixtures";

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const overview = (services: unknown[] = [], inbox = 0) => ({
  client: { id: "00000000-0000-4000-8000-00000000a002", name: "Demo client" },
  services,
  needsYou: { inbox },
  recentRuns: [],
});

describe("back office layout", () => {
  it("has the header, client switcher and the client's sidebar", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients/00000000-0000-4000-8000-00000000a001": () => SANDBOX_DETAIL,
    });
    renderAt("/ops/clients/00000000-0000-4000-8000-00000000a001", api);

    const shell = await screen.findByTestId("shell-ops");
    // The product is Mezonas: its logo names it; the code name never shows.
    expect(within(shell).getByRole("img", { name: "Mezonas" })).toBeInTheDocument();
    expect(within(shell).queryByText(/Countersign|Platform name/)).toBeNull();
    expect(screen.getByTestId("shell-command-bar")).toBeDisabled();
    expect(screen.getByTestId("shell-inbox")).toHaveAttribute("href", "/ops/inbox");
    // The operator is a Mezonas person: their avatar is the lead's copper one.
    expect(screen.getByTestId("shell-avatar")).toHaveTextContent("O");
    expect(screen.getByTestId("shell-avatar")).toHaveClass("mz-lead");

    const switcher = screen.getByTestId("ops-client-switcher") as HTMLSelectElement;
    expect(switcher.value).toBe("00000000-0000-4000-8000-00000000a001");
    expect([...switcher.options].map((o) => o.text)).toEqual([
      "All clients",
      "Sandbox",
      "Demo client",
    ]);

    const nav = screen.getByRole("complementary", { name: "Navigation" });
    expect(within(nav).getByTestId("ops-nav-home")).toHaveAttribute(
      "href",
      "/ops/clients/00000000-0000-4000-8000-00000000a001",
    );
    // The current page is the selected nav item (Sidebar: aria-current, slate-tint).
    expect(within(nav).getByTestId("ops-nav-home")).toHaveAttribute("aria-current", "page");
    for (const label of ["Inbox", "Templates", "Skills", "Connections", "Runs", "Settings"]) {
      expect(within(nav).getByText(label)).toBeInTheDocument();
    }
    expect(within(nav).getByText("Build")).toBeInTheDocument();
    const agent = await within(nav).findByTestId("ops-nav-agent-material-costs");
    expect(agent).toHaveAttribute(
      "href",
      "/ops/clients/00000000-0000-4000-8000-00000000a001/agents/material-costs",
    );
    expect(within(agent).getByText("Purchasing")).toBeInTheDocument();
  });

  it("switches client from the header", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({ clients: [] }),
      "GET /api/ops/clients/00000000-0000-4000-8000-00000000a002": () => ({
        ...SANDBOX_DETAIL,
        client: {
          ...SANDBOX_DETAIL.client,
          id: "00000000-0000-4000-8000-00000000a002",
          name: "Demo client",
        },
        agents: [],
      }),
    });
    renderAt("/ops", api);
    const switcher = await screen.findByTestId("ops-client-switcher");
    await userEvent.selectOptions(switcher, "00000000-0000-4000-8000-00000000a002");
    expect(await screen.findByRole("heading", { name: "Demo client" })).toBeInTheDocument();
    expect(screen.getByText("No agents yet.")).toBeInTheDocument();
  });

  it("sends a client user who opens /ops to the portal, without loading the back office", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview(),
    });
    renderAt("/ops/clients/00000000-0000-4000-8000-00000000a002", api);
    expect(await screen.findByTestId("shell-portal")).toBeInTheDocument();
    expect(screen.queryByTestId("shell-ops")).toBeNull();
    expect(api.calls.some((c) => c.includes("/api/ops/"))).toBe(false);
  });
});

describe("portal layout", () => {
  it("shows the client's name, inbox count, no switcher, and the portal sidebar", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () =>
        overview(
          [
            {
              id: "00000000-0000-4000-8000-00000000b001",
              name: "Material costs",
              description: "Keeps bills itemized.",
              status: "active",
            },
          ],
          3,
        ),
    });
    renderAt("/", api);

    const shell = await screen.findByTestId("shell-portal");
    expect(within(shell).getByTestId("portal-client-name")).toHaveTextContent("Demo client");
    expect(screen.queryByTestId("ops-client-switcher")).toBeNull();
    const inbox = screen.getByTestId("shell-inbox");
    expect(inbox).toHaveAttribute("href", "/inbox");
    await waitFor(() => expect(inbox).toHaveTextContent("Inbox3"));
    // The signed-in client is the self avatar (ink), not the lead's copper.
    expect(screen.getByTestId("shell-avatar")).toHaveClass("ds-avatar--self");
    const nav = screen.getByRole("complementary", { name: "Navigation" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual([
      "Overview",
      "Inbox",
      "Runs",
      "Reports",
      "Connections",
      "Requests",
      "Contacts",
      "People",
      "Settings",
    ]);

    const service = await screen.findByTestId(
      "portal-service-00000000-0000-4000-8000-00000000b001",
    );
    expect(within(service).getByText("Material costs")).toBeInTheDocument();
    expect(within(service).getByText("Keeps bills itemized.")).toBeInTheDocument();
    expect(screen.getByTestId("portal-needs-you")).toHaveTextContent("3");
  });

  it("hides Settings from a client user", async () => {
    const api = fakeApi({
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        tenants: [
          { id: "00000000-0000-4000-8000-00000000a002", name: "Demo client", role: "client_user" },
        ],
      }),
      "GET /api/overview": () => overview(),
    });
    renderAt("/", api);
    await screen.findByTestId("shell-portal");
    expect(screen.queryByTestId("portal-nav-settings")).toBeNull();
    expect(screen.queryByTestId("portal-nav-contacts")).toBeNull();
    expect(await screen.findByText(/No services yet/)).toBeInTheDocument();
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
