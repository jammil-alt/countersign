// docs/plan.md §1.122: the client admin gives a user some of the client's agents (on their row, or
// when inviting them), and a user limited to some agents gets a portal without the business's
// sections: no Accounts, Contacts, search or Sloan, and only their own settings.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const INVOICES = "00000000-0000-4000-8000-0000000000a1";
const COLLECTIONS = "00000000-0000-4000-8000-0000000000a2";
const BUYER = "00000000-0000-4000-8000-0000000000b1";
const agents = [
  { id: INVOICES, name: "Invoices" },
  { id: COLLECTIONS, name: "Collections" },
];

const overview = {
  client: { id: DEMO, name: "Demo client" },
  services: [],
  needsYou: { inbox: 0 },
  recentRuns: [],
};

const member = (email: string, role: string, agentIds: string[] | null = null) => ({
  userId: `u-${email}`,
  email,
  name: null,
  role,
  signedIn: true,
  canSign: true,
  agentIds,
});

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("access per person (§1.122)", () => {
  it("names each user's agents and changes them on their row", async () => {
    const users = [
      { ...member(CLIENT_SESSION.user.email, "client_admin"), userId: CLIENT_SESSION.user.id },
      { ...member("buyer@demo.example.com", "client_user", [INVOICES]), userId: BUYER },
    ];
    const patches: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview,
      "GET /api/team": () => ({ members: [], settings: { undoSeconds: 0 } }),
      "GET /api/users": () => ({ users, agents }),
      [`PATCH /api/users/${BUYER}`]: ({ init }) => {
        const body = JSON.parse(String(init.body));
        patches.push(body);
        const row = users[1] as ReturnType<typeof member>;
        row.agentIds = body.agentIds;
        return { member: row };
      },
    });
    renderAt("/settings/team", api);
    const row = await screen.findByTestId("portal-team-buyer@demo.example.com");
    expect(within(row).getByTestId("portal-team-buyer@demo.example.com-agents")).toHaveTextContent(
      "Works on Invoices.",
    );
    // Not on your own row.
    expect(
      screen.queryByTestId(`portal-team-${CLIENT_SESSION.user.email}-access-toggle`),
    ).toBeNull();

    await userEvent.click(
      within(row).getByTestId("portal-team-buyer@demo.example.com-access-toggle"),
    );
    const editor = await screen.findByTestId("portal-team-buyer@demo.example.com-access");
    await userEvent.click(
      within(editor).getByTestId(`portal-team-buyer@demo.example.com-access-agent-${COLLECTIONS}`),
    );
    await userEvent.click(
      within(editor).getByTestId("portal-team-buyer@demo.example.com-access-save"),
    );
    await waitFor(() =>
      expect(patches).toEqual([
        { role: "client_user", canSign: true, agentIds: [INVOICES, COLLECTIONS] },
      ]),
    );
    await waitFor(() =>
      expect(screen.getByTestId("portal-team-buyer@demo.example.com-agents")).toHaveTextContent(
        "Works on Invoices, Collections.",
      ),
    );
  });

  it("invites a user who works on only the agents picked", async () => {
    const invites: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview,
      "GET /api/team": () => ({ members: [], settings: { undoSeconds: 0 } }),
      "GET /api/users": () => ({
        users: [member(CLIENT_SESSION.user.email, "client_admin")],
        agents,
      }),
      "POST /api/users": ({ init }) => {
        const body = JSON.parse(String(init.body));
        invites.push(body);
        return {
          member: member(body.email, body.role, body.agentIds),
          email: { status: "sent", reason: null },
        };
      },
    });
    renderAt("/settings/team", api);
    const form = await screen.findByTestId("portal-invite");
    await userEvent.type(within(form).getByTestId("portal-invite-email"), "clerk@demo.example.com");
    await userEvent.click(within(form).getByTestId("portal-invite-some"));
    // "Only some" with none picked is not sent.
    await userEvent.click(within(form).getByTestId("portal-invite-send"));
    expect(invites).toEqual([]);
    await userEvent.click(within(form).getByTestId(`portal-invite-agent-${COLLECTIONS}`));
    await userEvent.click(within(form).getByTestId("portal-invite-send"));
    await waitFor(() =>
      expect(invites).toEqual([
        {
          email: "clerk@demo.example.com",
          role: "client_user",
          canSign: false,
          agentIds: [COLLECTIONS],
        },
      ]),
    );
  });

  it("an admin made a user starts from approvals off and agents to pick (QA PP3)", async () => {
    const OTHER = "00000000-0000-4000-8000-0000000000b2";
    const users = [
      { ...member(CLIENT_SESSION.user.email, "client_admin"), userId: CLIENT_SESSION.user.id },
      { ...member("boss@demo.example.com", "client_admin"), userId: OTHER },
    ];
    const patches: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview,
      "GET /api/team": () => ({ members: [], settings: { undoSeconds: 0 } }),
      "GET /api/users": () => ({ users, agents }),
      [`PATCH /api/users/${OTHER}`]: ({ init }) => {
        const body = JSON.parse(String(init.body));
        patches.push(body);
        return { member: { ...users[1], ...body } };
      },
    });
    renderAt("/settings/team", api);
    const id = "portal-team-boss@demo.example.com";
    const row = await screen.findByTestId(id);
    await userEvent.click(within(row).getByTestId(`${id}-access-toggle`));
    const editor = await screen.findByTestId(`${id}-access`);
    await userEvent.selectOptions(within(editor).getByTestId(`${id}-access-role`), "client_user");
    expect(within(editor).getByTestId(`${id}-access-can-sign`)).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(within(editor).getByTestId(`${id}-access-some`)).toHaveAttribute("aria-checked", "true");
    // Nothing picked yet: Save waits for a choice.
    expect(within(editor).getByTestId(`${id}-access-save`)).toBeDisabled();
    await userEvent.click(within(editor).getByTestId(`${id}-access-agent-${INVOICES}`));
    await userEvent.click(within(editor).getByTestId(`${id}-access-save`));
    await waitFor(() =>
      expect(patches).toEqual([{ role: "client_user", canSign: false, agentIds: [INVOICES] }]),
    );
  });

  it("gives a limited user their agents, their inbox and their own settings only", async () => {
    const api = fakeApi({
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        tenants: [{ id: DEMO, name: "Demo client", role: "client_user" }],
        assignedAgents: [INVOICES],
      }),
      "GET /api/overview": () => overview,
      "GET /api/team": () => ({ members: [], settings: { undoSeconds: 0 } }),
      "GET /api/settings/my-notifications": () => ({ channels: [] }),
    });
    renderAt("/settings", api);
    expect(await screen.findByTestId("portal-settings-nav-general")).toBeInTheDocument();
    expect(screen.getByTestId("portal-settings-nav-team")).toBeInTheDocument();
    for (const closed of ["approvals", "hours", "channels"]) {
      expect(screen.queryByTestId(`portal-settings-nav-${closed}`)).toBeNull();
    }
    expect(screen.queryByTestId("portal-nav-connectors")).toBeNull();
    expect(screen.queryByTestId("portal-nav-contacts")).toBeNull();
    expect(screen.queryByTestId("portal-nav-team")).toBeNull();
    expect(screen.queryByTestId("shell-ask-sloan")).toBeNull();
    expect(screen.getByTestId("portal-nav-runs")).toBeInTheDocument();
    expect(screen.getByTestId("portal-nav-inbox")).toBeInTheDocument();
    expect(api.calls).not.toContain("GET /api/search");
  });
});
