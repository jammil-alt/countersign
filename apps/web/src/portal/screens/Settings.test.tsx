// The portal's Settings: links to a client admin's team and exports, the stored email choices (emails start
// later), and who approves; a client user is told only the admin changes settings.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";

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
  // QA round 1: no "we don't send these yet" and no Save for nothing; Language stays.
  it("hides Notifications until we send these emails", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview,
      "GET /api/users": () => ({ users: [person("admin@demo.example.com", "client_admin")] }),
      "GET /api/settings/my-notifications": () => ({
        email: true,
        sms: false,
        canText: false,
        emailsOn: false,
      }),
    });
    renderAt("/settings", api);
    expect(await screen.findByText("1 person uses your portal.")).toBeInTheDocument();
    await waitFor(() => expect(api.calls).toContain("GET /api/settings/my-notifications"));
    expect(screen.queryByTestId("portal-settings-notifications")).toBeNull();
    expect(screen.queryByTestId("portal-settings-mine")).toBeNull();
    expect(screen.queryByRole("link", { name: "Notifications" })).toBeNull();
    expect(screen.getByTestId("portal-settings-language")).toBeInTheDocument();
  });

  it("links the team and exports, saves email choices and says who approves", async () => {
    const users = [person("admin@demo.example.com", "client_admin")];
    const patches: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview,
      "GET /api/users": () => ({ users }),
      "GET /api/settings": () => ({
        client: { id: DEMO, name: "Demo client", timezone: "UTC" },
        approvals: "operator",
        notifications: { itemsWaiting: true, weeklyDigest: true },
        emailsOn: true,
      }),
      "GET /api/settings/my-notifications": () => ({
        email: true,
        sms: false,
        canText: false,
        emailsOn: true,
      }),
      "PATCH /api/settings/notifications": ({ init }) => {
        const body = JSON.parse(String(init.body));
        patches.push(body);
        return { notifications: body };
      },
    });
    renderAt("/settings", api);
    expect(await screen.findByText("1 person uses your portal.")).toBeInTheDocument();
    // UI-3a: the team and the exports have their own pages.
    expect(screen.getByTestId("portal-settings-team-link")).toHaveAttribute(
      "href",
      "/settings/team",
    );
    expect(screen.getByTestId("portal-settings-exports-link")).toHaveAttribute(
      "href",
      "/settings/exports",
    );

    const emails = await screen.findByTestId("portal-settings-notifications");
    expect(within(emails).queryByTestId("portal-notifications-off")).toBeNull();
    const save = within(emails).getByTestId("portal-notifications-save");
    expect(save).toBeDisabled();
    await userEvent.click(within(emails).getByTestId("portal-notifications-weeklyDigest"));
    await userEvent.click(save);
    expect(await within(emails).findByText("Saved.")).toBeInTheDocument();
    expect(patches).toEqual([{ itemsWaiting: true, weeklyDigest: false }]);

    const approvals = screen.getByTestId("portal-settings-approvals");
    expect(approvals).toHaveTextContent("We approve changes to your tools on your behalf.");
    // The admin adds rules here; the matrix is on Accounts. Never "ask us" or "Connections".
    expect(approvals).toHaveTextContent("Add a rule below to choose who approves.");
    expect(approvals).not.toHaveTextContent("Connections");
    expect(within(approvals).getByRole("link", { name: "Accounts." })).toHaveAttribute(
      "href",
      "/accounts",
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
    expect(screen.getByTestId("portal-settings-approvals-member")).toHaveTextContent(
      "To change who approves, ask your admin.",
    );
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
    // Used and included say what they count: included is the month so far, and grows.
    await waitFor(() => expect(plan).toHaveTextContent("6,240 used of 10,000 included so far"));
    expect(within(plan).getByTestId("portal-settings-credits-help")).toHaveTextContent(
      "the included number grows through the month",
    );
    expect(within(plan).getByTestId("portal-settings-statements")).toHaveAttribute(
      "href",
      "/settings/billing",
    );
    const out = screen.getByTestId("portal-settings-credits-out");
    expect(await within(out).findByTestId("portal-credits-out-continue")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // The block counts extra credits, past the included ones.
    expect(out).toHaveTextContent("Credits past the included ones go on your next invoice.");
    expect(out).toHaveTextContent("another 2,500 extra credits");
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
