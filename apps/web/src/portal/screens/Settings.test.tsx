// The portal's Settings: a client admin's people and invites, the stored email choices (emails start
// later), and who approves; a client user is told only the admin changes settings.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi, Reply } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const overview = {
  client: { id: DEMO, name: "Demo client" },
  services: [],
  needsYou: { inbox: 0 },
  recentRuns: [],
};

const person = (email: string, role: string) => ({
  userId: `u-${email}`,
  email,
  name: null,
  role,
  signedIn: null,
});

describe("portal settings", () => {
  it("lists people, invites one, saves email choices and says who approves", async () => {
    const users = [person("admin@demo.example.com", "client_admin")];
    const patches: unknown[] = [];
    const invites: unknown[] = [];
    let unavailable = false;
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview,
      "GET /api/users": () => ({ users }),
      "POST /api/users": ({ init }) => {
        if (unavailable) return new Reply(409, { error: { code: "unavailable", message: "x" } });
        const body = JSON.parse(String(init.body));
        invites.push(body);
        const added = person(body.email, body.role);
        users.push(added);
        return { member: added, email: { status: "not_sent", reason: "dev_sign_in" } };
      },
      "GET /api/settings": () => ({
        client: { id: DEMO, name: "Demo client", timezone: "UTC" },
        approvals: "operator",
        notifications: { itemsWaiting: true, weeklyDigest: true },
        emailsOn: false,
      }),
      "PATCH /api/settings/notifications": ({ init }) => {
        const body = JSON.parse(String(init.body));
        patches.push(body);
        return { notifications: body };
      },
    });
    renderAt("/settings", api);
    expect(await screen.findByText("1 person uses your portal.")).toBeInTheDocument();
    expect(screen.getByTestId("portal-users-admin@demo.example.com")).toHaveTextContent("Admin");

    const form = screen.getByTestId("portal-invite");
    await userEvent.type(within(form).getByTestId("portal-invite-email"), "buyer@demo.example.com");
    await userEvent.selectOptions(within(form).getByTestId("portal-invite-role"), "client_admin");
    await userEvent.click(within(form).getByTestId("portal-invite-send"));
    expect(await within(form).findByTestId("portal-invite-done")).toHaveTextContent(
      "Invited buyer@demo.example.com.",
    );
    expect(invites).toEqual([{ email: "buyer@demo.example.com", role: "client_admin" }]);
    expect(await screen.findByTestId("portal-users-buyer@demo.example.com")).toBeInTheDocument();
    expect(screen.getByText("2 people use your portal.")).toBeInTheDocument();

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

    const emails = screen.getByTestId("portal-settings-notifications");
    expect(within(emails).getByTestId("portal-notifications-off")).toHaveTextContent(
      "Emails start soon",
    );
    const save = within(emails).getByTestId("portal-notifications-save");
    expect(save).toBeDisabled();
    await userEvent.click(within(emails).getByTestId("portal-notifications-weeklyDigest"));
    await userEvent.click(save);
    expect(await within(emails).findByText("Saved.")).toBeInTheDocument();
    expect(patches).toEqual([{ itemsWaiting: true, weeklyDigest: false }]);

    expect(screen.getByTestId("portal-settings-approvals")).toHaveTextContent(
      "We approve changes to your tools on your behalf.",
    );
  });

  it("gives a client user their own notifications and language, and loads nothing of the admin's", async () => {
    const puts: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        tenants: [{ id: DEMO, name: "Demo client", role: "client_user" }],
      }),
      "GET /api/overview": () => overview,
      "GET /api/settings/my-notifications": () => ({
        email: true,
        sms: false,
        canText: false,
        emailsOn: true,
      }),
      "PUT /api/settings/my-notifications": ({ init }) => {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        return { ...body, canText: false, emailsOn: true };
      },
    });
    renderAt("/settings", api);
    expect(await screen.findByTestId("portal-settings-admin-only")).toHaveTextContent(
      "Only your admin can change settings.",
    );
    const mine = await screen.findByTestId("portal-settings-mine");
    // No phone with consent: texts can't be turned on.
    expect(within(mine).getByTestId("portal-mine-sms")).toBeDisabled();
    await userEvent.click(within(mine).getByTestId("portal-mine-email"));
    await waitFor(() => expect(puts).toEqual([{ email: false, sms: false }]));
    expect(screen.getByTestId("portal-settings-language")).toBeInTheDocument();
    expect(api.calls).not.toContain("GET /api/users");
    expect(api.calls).not.toContain("GET /api/settings");
    expect(api.calls).not.toContain("GET /api/billing");
  });

  it("shows the admin this month's credits and saves what happens when they run out", async () => {
    const puts: unknown[] = [];
    let onCreditsOut = "continue";
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview,
      "GET /api/billing": () => ({
        setUp: true,
        monthSoFar: {
          period: { start: "2026-11-01", end: "2026-11-30", through: "2026-11-06" },
          daysInMonth: 30,
          lines: [],
          creditsIncluded: 10000,
          creditsUsed: 6240,
          extraCredits: 0,
          creditPrice: { amount: "0.0100", currency: "USD" },
          total: { amount: "0.00", currency: "USD" },
        },
        paymentProblem: false,
        statements: [],
      }),
      "GET /api/billing/credits-out": () => ({
        onCreditsOut,
        creditBlock: 2500,
        pausedForCredits: [],
      }),
      "PUT /api/billing/credits-out": ({ init }) => {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        onCreditsOut = body.onCreditsOut;
        return { onCreditsOut, creditBlock: 2500, pausedForCredits: [] };
      },
    });
    renderAt("/settings", api);
    const plan = await screen.findByTestId("portal-settings-plan");
    await waitFor(() => expect(plan).toHaveTextContent("6,240 of 10,000 used"));
    expect(within(plan).getByTestId("portal-settings-statements")).toHaveAttribute(
      "href",
      "/settings/billing",
    );
    const out = screen.getByTestId("portal-settings-credits-out");
    expect(await within(out).findByTestId("portal-credits-out-continue")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(out).toHaveTextContent("another 2,500 credits");
    await userEvent.click(within(out).getByTestId("portal-credits-out-pause"));
    expect(puts).toEqual([{ onCreditsOut: "pause" }]);
    await waitFor(() =>
      expect(within(out).getByTestId("portal-credits-out-pause")).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
  });
});
