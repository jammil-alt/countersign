// `/settings/team` (UI-3a): the admin sees everyone with what they sign, who hasn't signed in, and
// invites (a refusal never says why); a client user reads the team and loads nothing of the admin's.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi, Reply } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";

const overview = {
  client: { id: DEMO, name: "Demo client" },
  services: [],
  needsYou: { inbox: 0 },
  recentRuns: [],
};

const person = (email: string, role: string, signedIn: boolean | null = null) => ({
  userId: `u-${email}`,
  email,
  name: null,
  role,
  signedIn,
});

const team = {
  members: [
    {
      userId: "u-admin@demo.example.com",
      name: "Dana Kim",
      email: "admin@demo.example.com",
      role: "client_admin",
      canSign: true,
      signs: ["Bills over $5,000"],
    },
    {
      userId: "u-viewer@demo.example.com",
      name: null,
      email: "viewer@demo.example.com",
      role: "client_user",
      canSign: false,
      signs: [],
    },
  ],
  settings: { undoSeconds: 30 },
};

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("portal team", () => {
  it("lists the team with what each signs and invites someone", async () => {
    const users = [
      person("admin@demo.example.com", "client_admin"),
      person("viewer@demo.example.com", "client_user", false),
    ];
    const invites: unknown[] = [];
    let unavailable = false;
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview,
      "GET /api/team": () => team,
      "GET /api/users": () => ({ users }),
      "POST /api/users": ({ init }) => {
        if (unavailable) return new Reply(409, { error: { code: "unavailable", message: "x" } });
        const body = JSON.parse(String(init.body));
        invites.push(body);
        const added = person(body.email, body.role, false);
        users.push(added);
        return { member: added, email: { status: "not_sent", reason: "dev_sign_in" } };
      },
    });
    renderAt("/settings/team", api);
    expect(await screen.findByText("2 people use your portal.")).toBeInTheDocument();
    const admin = screen.getByTestId("portal-team-admin@demo.example.com");
    expect(admin).toHaveTextContent("Admin");
    await waitFor(() => expect(admin).toHaveTextContent("Bills over $5,000"));
    const viewer = screen.getByTestId("portal-team-viewer@demo.example.com");
    expect(viewer).toHaveTextContent("Invited");
    expect(viewer).toHaveTextContent("Doesn't sign. Can read everything.");

    const form = screen.getByTestId("portal-invite");
    await userEvent.type(within(form).getByTestId("portal-invite-email"), "buyer@demo.example.com");
    await userEvent.selectOptions(within(form).getByTestId("portal-invite-role"), "client_admin");
    await userEvent.click(within(form).getByTestId("portal-invite-send"));
    expect(await within(form).findByTestId("portal-invite-done")).toHaveTextContent(
      "Invited buyer@demo.example.com.",
    );
    expect(invites).toEqual([{ email: "buyer@demo.example.com", role: "client_admin" }]);
    expect(await screen.findByTestId("portal-team-buyer@demo.example.com")).toBeInTheDocument();
    expect(screen.getByText("3 people use your portal.")).toBeInTheDocument();

    // A refusal never says why (it could be about another client).
    unavailable = true;
    await userEvent.type(
      within(form).getByTestId("portal-invite-email"),
      "someone@else.example.com",
    );
    await userEvent.click(within(form).getByTestId("portal-invite-send"));
    await waitFor(() =>
      expect(within(form).getByTestId("portal-invite-email-error")).toHaveTextContent(
        "That address can't be invited here.",
      ),
    );
  });

  it("lets a client user read the team, without the admin's list or invites", async () => {
    const api = fakeApi({
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        tenants: [{ id: DEMO, name: "Demo client", role: "client_user" }],
      }),
      "GET /api/overview": () => overview,
      "GET /api/team": () => team,
    });
    renderAt("/settings/team", api);
    expect(await screen.findByTestId("portal-team-admin@demo.example.com")).toHaveTextContent(
      "Bills over $5,000",
    );
    expect(screen.queryByTestId("portal-invite")).toBeNull();
    expect(api.calls).not.toContain("GET /api/users");
  });
});
