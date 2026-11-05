// The back office's onboarding screens: the overview of what needs attention, a new client with its
// admin invited and approvals delegated, and the client's settings (approvals with a reason,
// invites with what became of the email, refusals in plain words).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const NEW = "00000000-0000-4000-8000-00000000a009";
const RUN = "00000000-0000-4000-8000-00000000f001";
const AGENT = "00000000-0000-4000-8000-00000000b001";

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const demo = { id: DEMO, name: "Demo client" };
const emptyOverview = {
  since: "2026-10-28T00:00:00.000Z",
  clients: 2,
  failedRuns: [],
  inbox: [],
  connections: [],
  updates: [],
  counts: { failedRuns: 0, inbox: 0, connections: 0, updates: 0 },
};

const member = (email: string, role: string, extra: Record<string, unknown> = {}) => ({
  userId: `u-${email}`,
  email,
  name: null,
  role,
  signedIn: null,
  ...extra,
});

const settings = (over: Record<string, unknown> = {}) => ({
  client: { id: DEMO, name: "Demo client", timezone: "America/Chicago", sandbox: false },
  approvals: { externalActions: "client_admin", changes: [] },
  notifications: { itemsWaiting: true, weeklyDigest: false },
  members: [
    member("operator@example.com", "operator"),
    member("admin@demo.example.com", "client_admin"),
  ],
  ...over,
});

const connections = {
  connections: [],
  offered: ["upload"],
  connectors: [
    {
      id: "upload",
      name: "Upload",
      description: "Files you upload or forward",
      icon: null,
      auth: "none",
      tools: [],
    },
  ],
  usedBy: {},
  sandbox: false,
};

describe("ops overview", () => {
  it("leads with how many things need you, and lists each kind with links", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({ clients: [] }),
      "GET /api/ops/overview": () => ({
        ...emptyOverview,
        failedRuns: [
          {
            id: RUN,
            client: demo,
            agent: { id: AGENT, slug: "material-costs", name: "Material costs" },
            workflowSlug: "new-bill",
            error: "QuickBooks refused the change",
            finishedAt: "2026-11-04T09:00:00.000Z",
            createdAt: "2026-11-04T08:59:00.000Z",
          },
        ],
        connections: [
          {
            id: "00000000-0000-4000-8000-00000000c001",
            client: demo,
            connector: "qbo",
            connectorName: "QuickBooks Online",
            status: "error",
            usedBy: ["Material costs"],
          },
        ],
        updates: [
          {
            agent: { id: AGENT, slug: "material-costs", name: "Material costs" },
            client: demo,
            template: { id: "t1", name: "Pia" },
            behind: 2,
            releaseNote: "Reads freight lines",
          },
        ],
        counts: { failedRuns: 3, inbox: 0, connections: 1, updates: 1 },
      }),
    });
    renderAt("/ops", api);
    expect(await screen.findByText("5 things need you across 2 clients.")).toBeInTheDocument();
    const failed = screen.getByTestId("ops-overview-failed");
    expect(within(failed).getByText("QuickBooks refused the change")).toBeInTheDocument();
    expect(within(failed).getByText("Showing 1 of 3.")).toBeInTheDocument();
    expect(
      within(failed).getByTestId(`ops-overview-run-${RUN}`).querySelector("a"),
    ).toHaveAttribute("href", `/ops/runs/${RUN}`);
    const conn = screen.getByTestId("ops-overview-connections");
    expect(within(conn).getByText("Sign-in failed")).toHaveClass("text-risk-ink");
    expect(within(conn).getByText("Used by Material costs")).toBeInTheDocument();
    const updates = screen.getByTestId("ops-overview-updates");
    expect(within(updates).getByText("2 versions behind")).toBeInTheDocument();
    expect(within(updates).getByRole("link")).toHaveAttribute(
      "href",
      `/ops/clients/${DEMO}/agents/material-costs/versions`,
    );
    // Nothing waits in the inbox, so there is no inbox block.
    expect(screen.queryByTestId("ops-overview-inbox")).toBeNull();
    expect(screen.getByTestId("ops-new-client")).toHaveAttribute("href", "/ops/clients/new");
  });

  it("says so when nothing needs you", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({ clients: [] }),
      "GET /api/ops/overview": () => emptyOverview,
    });
    renderAt("/ops", api);
    expect(await screen.findByText("Nothing needs you across 2 clients.")).toBeInTheDocument();
    expect(screen.getByTestId("ops-overview-clear")).toBeInTheDocument();
  });
});

describe("new client", () => {
  it("creates the client with its offer, approvals and admin, then shows the invite", async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/connectors": () => ({
        connectors: [
          {
            id: "upload",
            name: "Upload",
            description: "Files you upload or forward",
            icon: "upload",
            auth: "none",
            entities: [],
            tools: [],
          },
          {
            id: "zoho_crm",
            name: "Zoho CRM",
            description: "Leads and deals",
            icon: "zoho",
            auth: "oauth2",
            entities: [],
            tools: [],
          },
        ],
      }),
      "POST /api/ops/clients": ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return {
          client: {
            id: NEW,
            name: "Cabinet shop",
            timezone: "America/Chicago",
            createdAt: "2026-11-04T10:00:00.000Z",
            agents: 0,
            openInbox: 0,
          },
          admin: {
            member: member("owner@cabinets.example.com", "client_admin", { signedIn: false }),
            email: { status: "sent", reason: null },
          },
        };
      },
      [`GET /api/ops/clients/${NEW}`]: () => ({
        client: {
          id: NEW,
          name: "Cabinet shop",
          timezone: "America/Chicago",
          settings: {},
          createdAt: "x",
        },
        agents: [],
        connections: [],
        members: [],
      }),
      [`GET /api/ops/clients/${NEW}/settings`]: () =>
        settings({
          client: { id: NEW, name: "Cabinet shop", timezone: "America/Chicago", sandbox: false },
          approvals: { externalActions: "operator", changes: [] },
          members: [member("owner@cabinets.example.com", "client_admin", { signedIn: false })],
        }),
      [`GET /api/ops/clients/${NEW}/connections`]: () => connections,
    });
    renderAt("/ops/clients/new", api);
    // Name is required.
    await userEvent.click(await screen.findByTestId("new-client-create"));
    expect(screen.getByTestId("new-client-name-error")).toHaveTextContent(
      "Give the client a name.",
    );

    await userEvent.type(screen.getByTestId("new-client-name"), "Cabinet shop");
    const tz = screen.getByTestId("new-client-timezone");
    await userEvent.clear(tz);
    await userEvent.type(tz, "America/Chicago");
    await userEvent.click(await screen.findByTestId("new-client-offer-upload"));
    await userEvent.click(screen.getByTestId("new-client-approvals-operator"));
    // The client's language: English unless chosen; the six are offered by their own names.
    const language = screen.getByTestId("new-client-language");
    expect(language).toHaveValue("en");
    expect(within(language).getByRole("option", { name: "Deutsch" })).toBeInTheDocument();
    await userEvent.selectOptions(language, "es");
    await userEvent.type(
      screen.getByTestId("new-client-admin-email"),
      "owner@cabinets.example.com",
    );
    // The supervisor is offered, ticked (docs/plan.md §1.28).
    expect(screen.getByTestId("new-client-supervisor")).toBeChecked();
    await userEvent.click(screen.getByTestId("new-client-create"));

    const created = await screen.findByTestId("ops-client-created");
    expect(created).toHaveTextContent("Cabinet shop is set up.");
    expect(created).toHaveTextContent("We emailed owner@cabinets.example.com an invitation.");
    expect(bodies).toEqual([
      {
        name: "Cabinet shop",
        timezone: "America/Chicago",
        connectorsOffered: ["upload"],
        approvals: "operator",
        language: "es",
        supervisor: true,
        admin: { email: "owner@cabinets.example.com" },
      },
    ]);
    expect(screen.getByTestId("ops-client-members-owner@cabinets.example.com")).toHaveTextContent(
      "Invited",
    );
  });

  it("says why the admin can't be invited, and keeps the form", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/connectors": () => ({ connectors: [] }),
      "POST /api/ops/clients": () =>
        new Reply(409, { error: { code: "other_client", message: "x" } }),
    });
    renderAt("/ops/clients/new", api);
    await userEvent.type(await screen.findByTestId("new-client-name"), "Shop");
    await userEvent.type(screen.getByTestId("new-client-admin-email"), "admin@b.example.com");
    await userEvent.click(screen.getByTestId("new-client-create"));
    expect(await screen.findByTestId("new-client-admin-email-error")).toHaveTextContent(
      "That address belongs to another client.",
    );
    expect(screen.getByTestId("new-client-name")).toHaveValue("Shop");
  });
});

describe("client settings", () => {
  it("delegates approvals with a reason and shows the change", async () => {
    let current = settings();
    const bodies: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${DEMO}`]: () => ({
        client: { id: DEMO, name: "Demo client", timezone: "UTC", settings: {}, createdAt: "x" },
        agents: [],
        connections: [],
        members: [],
      }),
      [`GET /api/ops/clients/${DEMO}/settings`]: () => current,
      [`GET /api/ops/clients/${DEMO}/connections`]: () => connections,
      [`PATCH /api/ops/clients/${DEMO}/settings`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        current = settings({
          approvals: {
            externalActions: "operator",
            changes: [
              {
                id: "c1",
                from: "client_admin",
                to: "operator",
                reason: "Owner away in December",
                by: { id: "o", email: "operator@example.com", name: "Operator" },
                createdAt: "2026-11-04T10:00:00.000Z",
              },
            ],
          },
        });
        return current;
      },
    });
    renderAt(`/ops/clients/${DEMO}/settings`, api);
    const approvals = await screen.findByTestId("ops-client-settings-approvals");
    expect(screen.getByText(/approvals by their admin/)).toBeInTheDocument();
    expect(within(approvals).queryByTestId("ops-client-approvals-save")).toBeNull();
    await userEvent.click(within(approvals).getByTestId("ops-client-approvals-operator"));
    await userEvent.type(
      within(approvals).getByTestId("ops-client-approvals-reason"),
      "Owner away in December",
    );
    await userEvent.click(within(approvals).getByTestId("ops-client-approvals-save"));
    expect(await within(approvals).findByTestId("ops-client-approvals-history")).toHaveTextContent(
      "Changed to us by Operator",
    );
    expect(bodies).toEqual([{ approvals: "operator", reason: "Owner away in December" }]);
    expect(screen.getByText(/approvals by us/)).toBeInTheDocument();
    // The offering is shown, and changed on Connections.
    const offered = screen.getByTestId("ops-client-settings-offered");
    expect(await within(offered).findByText("Upload")).toBeInTheDocument();
    // Operators are the team serving the client, not its people.
    expect(screen.getByTestId("ops-client-team")).toHaveTextContent("operator@example.com");
    expect(screen.queryByTestId("ops-client-members-operator@example.com")).toBeNull();
  });

  it("invites someone and says what became of the email, or why it was refused", async () => {
    let refuse = false;
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${DEMO}`]: () => ({
        client: { id: DEMO, name: "Demo client", timezone: "UTC", settings: {}, createdAt: "x" },
        agents: [],
        connections: [],
        members: [],
      }),
      [`GET /api/ops/clients/${DEMO}/settings`]: () => settings(),
      [`GET /api/ops/clients/${DEMO}/connections`]: () => connections,
      [`POST /api/ops/clients/${DEMO}/invites`]: ({ init }) =>
        refuse
          ? new Reply(409, { error: { code: "is_operator", message: "x" } })
          : {
              member: member(JSON.parse(String(init.body)).email, "client_user"),
              email: { status: "failed", reason: "invitation_invalid" },
            },
    });
    renderAt(`/ops/clients/${DEMO}/settings`, api);
    const form = await screen.findByTestId("ops-client-invite");
    await userEvent.type(
      within(form).getByTestId("ops-client-invite-email"),
      "clerk@demo.example.com",
    );
    await userEvent.click(within(form).getByTestId("ops-client-invite-send"));
    expect(await within(form).findByTestId("ops-client-invite-done")).toHaveTextContent(
      "Invited clerk@demo.example.com, but the email didn't send.",
    );
    refuse = true;
    await userEvent.type(
      within(form).getByTestId("ops-client-invite-email"),
      "other-operator@example.com",
    );
    await userEvent.click(within(form).getByTestId("ops-client-invite-send"));
    await waitFor(() =>
      expect(within(form).getByTestId("ops-client-invite-email-error")).toHaveTextContent(
        "That address belongs to a Mezonas operator.",
      ),
    );
  });
});
