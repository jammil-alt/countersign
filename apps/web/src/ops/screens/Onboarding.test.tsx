// The back office's onboarding screens: a new client with its
// admin invited and approvals delegated (it opens on the client's People), and the client's
// settings, one section at a time (approvals with no reason asked for, invites with what became of
// the email, refusals in plain words).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const NEW = "00000000-0000-4000-8000-00000000a009";

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

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
      available: true,
      tools: [],
    },
  ],
  usedBy: {},
  sandbox: false,
};

/** One connector of the back office's catalog (`GET /api/ops/connectors`). */
function catalogConnector(
  id: string,
  name: string,
  description: string,
  over: Record<string, unknown> = {},
) {
  return {
    id,
    name,
    description,
    icon: id,
    auth: "none",
    status: "live",
    statusSource: "deployment",
    testOnly: false,
    note: "",
    available: true,
    clientsConnected: 0,
    tools: [],
    permissionEntities: [],
    errors: { toolCalls: 0, connections: 0 },
    defaultAccess: {
      matrix: { read: "auto", create: "approval", update: "approval", delete: "off" },
      source: "platform",
    },
    waiting: [],
    updatedAt: null,
    ...over,
  };
}

describe("new client", () => {
  it("lists the tools to offer without the testkit, and a failure in plain words only", async () => {
    let fail = true;
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/connectors": () =>
        fail
          ? new Reply(403, {
              error: { code: "tenant_forbidden", message: "choose a client first" },
            })
          : {
              connectors: [
                catalogConnector("zoho_crm", "Zoho CRM", "Leads and deals"),
                catalogConnector("testkit", "Testkit", "For tests", { testOnly: true }),
              ],
            },
    });
    renderAt("/ops/clients/new", api);
    const card = await screen.findByTestId("new-client-connectors");
    const alert = await within(card).findByRole("alert");
    expect(alert).toHaveTextContent("You don't have access to this.");
    // The server's code is for support, never part of the words.
    expect(alert).not.toHaveTextContent("tenant_forbidden");
    expect(alert).toHaveAttribute("data-error-code", "tenant_forbidden");
    fail = false;
    await userEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("new-client-offer-zoho_crm")).toBeInTheDocument();
    expect(screen.queryByTestId("new-client-offer-testkit")).toBeNull();
  });

  it("creates the client with its offer, approvals and admin, then shows the invite", async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      // The back office's catalog: the portal's /api/connectors needs a client, which a new one
      // doesn't have yet. The testkit is never offered to a real client.
      "GET /api/ops/connectors": () => ({
        connectors: [
          catalogConnector("upload", "Upload", "Files you upload or forward"),
          catalogConnector("zoho_crm", "Zoho CRM", "Leads and deals"),
          catalogConnector("testkit", "Testkit", "For tests", { testOnly: true }),
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
      "GET /api/ops/connectors": () => ({ connectors: [] }),
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
  it("delegates approvals and shows the change", async () => {
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
                reason: "",
                by: { id: "o", email: "operator@example.com", name: "Operator" },
                createdAt: "2026-11-04T10:00:00.000Z",
              },
            ],
          },
        });
        return current;
      },
    });
    renderAt(`/ops/clients/${DEMO}/settings/approvals`, api);
    const approvals = await screen.findByTestId(
      "ops-client-settings-approvals",
      {},
      { timeout: 10_000 },
    );
    expect(within(approvals).getByText("Approvals by their admin")).toBeInTheDocument();
    expect(within(approvals).queryByTestId("ops-client-approvals-save")).toBeNull();
    await userEvent.click(within(approvals).getByTestId("ops-client-approvals-operator"));
    // No reason asked for.
    expect(within(approvals).queryByTestId("ops-client-approvals-reason")).toBeNull();
    await userEvent.click(within(approvals).getByTestId("ops-client-approvals-save"));
    expect(await within(approvals).findByTestId("ops-client-approvals-history")).toHaveTextContent(
      "Changed to us by Operator",
    );
    expect(bodies).toEqual([{ approvals: "operator" }]);
    expect(within(approvals).getByText("Approvals by us")).toBeInTheDocument();
    // The section list, one section at a time: People isn't on this page.
    const nav = screen.getByTestId("ops-client-settings-nav");
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual([
      "General",
      "Approvals",
      "People",
      "Billing",
      "Compliance",
      "Exports",
      "Retire client",
    ]);
    expect(within(nav).getByRole("link", { name: "Approvals" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByTestId("ops-client-settings-people")).toBeNull();
  });

  it("lists the client's people apart from the team serving it", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${DEMO}`]: () => ({
        client: { id: DEMO, name: "Demo client", timezone: "UTC", settings: {}, createdAt: "x" },
        agents: [],
        connections: [],
        members: [],
      }),
      [`GET /api/ops/clients/${DEMO}/settings`]: () => settings(),
    });
    renderAt(`/ops/clients/${DEMO}/settings/people`, api);
    // Operators are the team serving the client, not its people.
    expect(await screen.findByTestId("ops-client-team", {}, { timeout: 10_000 })).toHaveTextContent(
      "operator@example.com",
    );
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
    renderAt(`/ops/clients/${DEMO}/settings/people`, api);
    const form = await screen.findByTestId("ops-client-invite", {}, { timeout: 10_000 });
    // Or one of the client's own people, from its directory.
    expect(screen.getByTestId("ops-client-invite-directory")).toHaveAttribute(
      "href",
      `/ops/clients/${DEMO}/directory`,
    );
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
