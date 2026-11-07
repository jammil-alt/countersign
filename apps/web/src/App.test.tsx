// The wired path end to end against a fake API shaped like apps/api: dev sign-in → back office
// clients → client → agent page with its versions, badges, workflow tab and the workflow builder.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "./App";
import {
  AGENT_DETAIL,
  CLIENT_SESSION,
  type FakeApi,
  fakeApi,
  OPERATOR_SESSION,
  Reply,
  SANDBOX_DETAIL,
} from "./test/fixtures";

function backend(): FakeApi & { signedInAs: () => string | null } {
  let signedIn: string | null = null;
  const api = fakeApi({
    "GET /api/session": () =>
      signedIn === "operator@example.com"
        ? OPERATOR_SESSION
        : signedIn
          ? CLIENT_SESSION
          : new Reply(401, { error: { code: "unauthenticated", message: "not signed in" } }),
    "POST /api/auth/dev/sign-in": ({ init }) => {
      signedIn = (JSON.parse(String(init.body)) as { email: string }).email;
      return { ok: true };
    },
    "GET /api/ops/clients": () => ({
      clients: [
        {
          id: "00000000-0000-4000-8000-00000000a001",
          name: "Sandbox",
          timezone: "UTC",
          createdAt: "2026-11-01T00:00:00.000Z",
          agents: 1,
          openInbox: 0,
        },
      ],
    }),
    "GET /api/ops/clients/00000000-0000-4000-8000-00000000a001": () => SANDBOX_DETAIL,
    "GET /api/ops/clients/00000000-0000-4000-8000-00000000a001/agents": () => ({
      agents: SANDBOX_DETAIL.agents,
    }),
    "GET /api/ops/agents/00000000-0000-4000-8000-00000000b001": () => AGENT_DETAIL,
    "GET /api/ops/agents/00000000-0000-4000-8000-00000000b001/builder-catalog": () => ({
      skills: [],
      tools: [],
      connectors: [],
    }),
    "GET /api/ops/catalog/events": () => ({ events: [] }),
    "GET /api/overview": () => ({
      client: { id: "00000000-0000-4000-8000-00000000a002", name: "Demo client" },
      services: [],
      needsYou: { inbox: 0 },
      recentRuns: [],
    }),
  });
  return { ...api, signedInAs: () => signedIn };
}

function renderApp(api: FakeApi, path = "/") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("app", () => {
  it("signs in as the operator and walks to an agent's workflow", async () => {
    const api = backend();
    api.on("GET /api/auth/dev/users", () => ({
      users: [
        {
          email: "operator@example.com",
          name: "Operator",
          operator: true,
          tenants: OPERATOR_SESSION.tenants,
        },
        {
          email: "admin@demo-client.example.com",
          name: "Demo admin",
          operator: false,
          tenants: [
            {
              id: "00000000-0000-4000-8000-00000000a002",
              name: "Demo client",
              role: "client_admin",
            },
          ],
        },
      ],
    }));
    renderApp(api);
    const user = userEvent.setup();

    const operator = await screen.findByTestId("signin-user-operator@example.com");
    expect(operator).toHaveTextContent("Operator · 2 clients");
    expect(screen.getByTestId("signin-user-admin@demo-client.example.com")).toHaveTextContent(
      "Client admin · Demo client",
    );
    await user.click(operator);
    expect(api.signedInAs()).toBe("operator@example.com");

    // Operators land in the back office's command center; a client opens from the sidebar.
    expect(await screen.findByTestId("ops-command")).toBeInTheDocument();
    await user.click(
      await screen.findByTestId("ops-nav-client-00000000-0000-4000-8000-00000000a001"),
    );
    // The client page opens on its Overview; its agents are on the Agents tab.
    await user.click(
      within(await screen.findByTestId("ops-client-tabs")).getByRole("link", { name: "Agents" }),
    );
    const card = await screen.findByTestId("ops-agent-card-material-costs");
    expect(within(card).getByText("Live")).toBeInTheDocument();
    await user.click(within(card).getByText("Material costs"));

    const badges = await screen.findByTestId("agent-version-badges");
    expect(badges).toHaveTextContent("Live · v1");
    expect(badges).toHaveTextContent("Draft · v2");
    const tabs = screen.getByRole("navigation", { name: "Sections" });
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Overview", "Workflow", "Triggers", "Runs", "Versions2", "Tests", "Settings"]);
    expect(screen.getByText(/How it works · 5 steps, 1 fork$/)).toBeInTheDocument();

    await user.click(within(tabs).getByRole("link", { name: /^Versions/ }));
    const versions = await screen.findByTestId("agent-versions");
    expect(within(versions).getByTestId("agent-version-1")).toHaveTextContent("Live");
    expect(within(versions).getByTestId("agent-version-2")).toHaveTextContent("Draft");

    // Opening the draft from the versions list shows its workflow.
    await user.click(within(versions).getByRole("link", { name: "v2" }));
    expect(await screen.findByTestId("agent-shown-version")).toHaveTextContent("v2 (draft)");
    expect(screen.getByTestId("step-list")).toBeInTheDocument();
    expect(screen.getByTestId("fork-confidence")).toBeInTheDocument();

    // The Workflow tab opens the builder on the latest version's first workflow.
    await user.click(within(tabs).getByRole("link", { name: "Workflow" }));
    const canvas = await screen.findByTestId("builder-canvas");
    expect(within(canvas).getByTestId("builder-step-confidence")).toBeInTheDocument();
    expect(screen.getByTestId("builder-version")).toHaveTextContent("Draft · v2");
    expect(screen.getByTestId("builder-workflow-new-bill-select")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("signs a client admin in by email when the API lists no users, landing in the portal", async () => {
    const api = backend();
    renderApp(api, "/");
    const user = userEvent.setup();
    await user.type(
      await screen.findByTestId("signin-email-input"),
      "admin@demo-client.example.com",
    );
    await user.click(screen.getByTestId("signin-email-submit"));
    expect(await screen.findByTestId("shell-portal")).toBeInTheDocument();
    expect(api.signedInAs()).toBe("admin@demo-client.example.com");
  });

  it("returns to the page that asked for sign-in", async () => {
    const api = backend();
    renderApp(api, "/ops/clients/00000000-0000-4000-8000-00000000a001");
    const user = userEvent.setup();
    await user.type(await screen.findByTestId("signin-email-input"), "operator@example.com");
    await user.click(screen.getByTestId("signin-email-submit"));
    expect(await screen.findByRole("heading", { level: 1, name: "Sandbox" })).toBeInTheDocument();
  });

  it("sends an old portal address on to its new home after sign-in", async () => {
    const api = backend();
    renderApp(api, "/inbox?status=open");
    const user = userEvent.setup();
    await user.type(
      await screen.findByTestId("signin-email-input"),
      "admin@demo-client.example.com",
    );
    await user.click(screen.getByTestId("signin-email-submit"));
    // `/inbox` is now Your Desk: the sidebar's Desk (its one link) is the current page.
    await waitFor(() =>
      expect(screen.getByTestId("portal-nav-desk")).toHaveAttribute("aria-current", "page"),
    );
    expect(screen.queryByTestId("shell-inbox")).toBeNull();
  });

  it("says when a version's bundle does not match the schema", async () => {
    const api = backend();
    api.on("GET /api/session", () => OPERATOR_SESSION);
    api.on("GET /api/ops/agents/00000000-0000-4000-8000-00000000b001", () => ({
      ...AGENT_DETAIL,
      live: { ...AGENT_DETAIL.live, bundle: { schemaVersion: 9 } },
    }));
    renderApp(
      api,
      "/ops/clients/00000000-0000-4000-8000-00000000a001/agents/material-costs/workflow",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/does not match the agent bundle/);
  });
});
