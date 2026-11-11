// `/settings/team` (UI-3a): the admin sees everyone with what they sign, who hasn't signed in, and
// invites (a refusal never says why); a client user reads the team and loads nothing of the admin's.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  it("lists the team with what each approves and invites someone", async () => {
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
    expect(viewer).toHaveTextContent("Doesn't approve. Can read everything.");

    const form = screen.getByTestId("portal-invite");
    await userEvent.type(within(form).getByTestId("portal-invite-email"), "buyer@demo.example.com");
    await userEvent.selectOptions(within(form).getByTestId("portal-invite-role"), "client_admin");
    await userEvent.click(within(form).getByTestId("portal-invite-send"));
    expect(await within(form).findByTestId("portal-invite-done")).toHaveTextContent(
      "Invited buyer@demo.example.com.",
    );
    expect(invites).toEqual([{ email: "buyer@demo.example.com", role: "client_admin" }]);
    // Or one of your own people, from the directory.
    expect(screen.getByTestId("portal-invite-directory")).toHaveAttribute("href", "/contacts");
    expect(screen.getByTestId("portal-invite-directory")).toHaveTextContent(
      "Invite from the directory",
    );
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

// R8 (docs/plan.md §1.86): each person's hours (their own week, or the business's) and away dates.
// The client admin changes anyone's; a client user only their own, as the routes allow.
const DANA = "00000000-0000-4000-8000-00000000d101";
const LEE = "00000000-0000-4000-8000-00000000d102";
const NINE_TO_SIX = [{ from: "08:00", to: "18:00" }];
const BUSINESS = {
  hours: {
    tz: "America/Chicago",
    week: {
      mon: NINE_TO_SIX,
      tue: NINE_TO_SIX,
      wed: NINE_TO_SIX,
      thu: NINE_TO_SIX,
      fri: NINE_TO_SIX,
    },
    usHolidays: true,
    closed: [],
  },
  isDefault: true,
};
const hoursTeam = {
  members: [
    {
      userId: DANA,
      name: "Dana Kim",
      email: "dana@demo.example.com",
      role: "client_admin",
      canSign: true,
      signs: [],
    },
    {
      userId: LEE,
      name: "Lee Park",
      email: "lee@demo.example.com",
      role: "client_user",
      canSign: true,
      signs: [],
    },
  ],
  settings: { undoSeconds: 30 },
};

describe("people's hours on the team", () => {
  it("shows the admin everyone's hours and saves a person's own week and away dates", async () => {
    const puts: { path: string; body: unknown }[] = [];
    let lee: unknown = null;
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview,
      "GET /api/team": () => hoursTeam,
      "GET /api/users": () => ({
        users: [
          {
            userId: DANA,
            email: "dana@demo.example.com",
            name: "Dana Kim",
            role: "client_admin",
            signedIn: true,
          },
          {
            userId: LEE,
            email: "lee@demo.example.com",
            name: "Lee Park",
            role: "client_user",
            signedIn: true,
          },
        ],
      }),
      "GET /api/settings/people-hours": () => ({
        business: BUSINESS,
        people: [
          {
            kind: "user",
            id: DANA,
            name: "Dana Kim",
            // Away today and for a long while after.
            hours: { away: [{ from: "2020-01-01", to: "2099-12-31" }] },
          },
          { kind: "user", id: LEE, name: "Lee Park", hours: lee },
        ],
      }),
      [`PUT /api/settings/people-hours/users/${LEE}`]: ({ url, init }) => {
        const body = JSON.parse(String(init.body));
        puts.push({ path: url.pathname, body });
        lee = body.hours;
        return { person: { kind: "user", id: LEE, name: "Lee Park", hours: lee } };
      },
    });
    renderAt("/settings/team", api);
    const dana = await screen.findByTestId("portal-team-dana@demo.example.com-hours");
    expect(dana).toHaveTextContent("Business hours");
    expect(dana).toHaveTextContent("Away until Dec 31, 2099");
    const row = screen.getByTestId("portal-team-lee@demo.example.com");
    expect(within(row).getByTestId("portal-team-lee@demo.example.com-hours")).toHaveTextContent(
      "Business hours",
    );

    await userEvent.click(within(row).getByTestId("portal-team-lee@demo.example.com-hours-toggle"));
    const editor = within(row).getByTestId("portal-team-lee@demo.example.com-hours-editor");
    expect(within(editor).getByText("No away dates.")).toBeInTheDocument();
    await userEvent.click(within(editor).getByRole("button", { name: "Change hours" }));
    // Their own week: the business's to start from, then Friday off.
    await userEvent.click(within(editor).getByRole("radio", { name: /Own hours/ }));
    const prefix = "portal-team-lee@demo.example.com-hours-editor";
    await userEvent.click(within(editor).getByTestId(`${prefix}-week-fri-open`));
    fireEvent.change(within(editor).getByTestId(`${prefix}-away-from`), {
      target: { value: "2026-12-21" },
    });
    fireEvent.change(within(editor).getByTestId(`${prefix}-away-to`), {
      target: { value: "2027-01-02" },
    });
    await userEvent.click(within(editor).getByTestId(`${prefix}-away-add`));
    await userEvent.click(within(editor).getByTestId(`${prefix}-save`));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      path: `/api/settings/people-hours/users/${LEE}`,
      body: {
        hours: {
          hours: {
            tz: "America/Chicago",
            week: { mon: NINE_TO_SIX, tue: NINE_TO_SIX, wed: NINE_TO_SIX, thu: NINE_TO_SIX },
            usHolidays: true,
            closed: [],
          },
          away: [{ from: "2026-12-21", to: "2027-01-02" }],
        },
      },
    });
    await waitFor(() =>
      expect(within(row).getByTestId("portal-team-lee@demo.example.com-hours")).toHaveTextContent(
        "Own hours",
      ),
    );
    expect(editor).toHaveTextContent("Dec 21, 2026 to Jan 2, 2027");
  });

  it("lets a client user change their own hours only, and back to the business's clears them", async () => {
    const puts: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        tenants: [{ id: DEMO, name: "Demo client", role: "client_user" }],
      }),
      "GET /api/overview": () => overview,
      "GET /api/team": () => hoursTeam,
      "GET /api/settings/business-hours": () => BUSINESS,
      "GET /api/settings/my-hours": () => ({
        person: {
          kind: "user",
          id: LEE,
          name: "Lee Park",
          hours: {
            hours: { ...BUSINESS.hours, week: { mon: NINE_TO_SIX } },
            away: [],
          },
        },
      }),
      "PUT /api/settings/my-hours": ({ init }) => {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        return { person: { kind: "user", id: LEE, name: "Lee Park", hours: body.hours } };
      },
    });
    renderAt("/settings/team", api);
    const mine = await screen.findByTestId("portal-my-hours");
    await waitFor(() => expect(mine).toHaveTextContent("Own hours"));
    expect(mine).toHaveTextContent("Mon8:00 AM to 6:00 PM");
    await userEvent.click(within(mine).getByRole("button", { name: "Change hours" }));
    await userEvent.click(within(mine).getByRole("radio", { name: /Business hours/ }));
    await userEvent.click(within(mine).getByTestId("portal-my-hours-editor-save"));
    await waitFor(() => expect(puts).toEqual([{ hours: null }]));
    // Nobody else's hours: the admin's list is never asked for.
    expect(api.calls).not.toContain("GET /api/settings/people-hours");
    expect(screen.queryByTestId("portal-team-dana@demo.example.com-hours-toggle")).toBeNull();
  });
});
