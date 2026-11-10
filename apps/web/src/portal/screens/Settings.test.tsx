// The portal's Settings, one section at a time (Review 1): General (your notifications and
// language, the team's emails, what Sloan is), Approvals (who approves, who approves what, the undo
// window), Team, and the admin's Billing, Exports, Conversations and Voice samples. A client user has
// General, Approvals and Team.
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

describe("portal settings", () => {
  it("lists its sections, saves email choices, and says who approves under Approvals", async () => {
    const patches: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview,
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
      "GET /api/team": () => ({
        members: [
          {
            userId: "u1",
            email: "admin@demo.example.com",
            name: "Dana Kim",
            role: "client_admin",
            canSign: true,
            signs: ["Every change no rule sends to someone else."],
          },
        ],
        settings: { undoSeconds: 60 },
      }),
      "GET /api/approver-rules": () => ({
        rules: [],
        revision: 1,
        canTighten: true,
        people: [],
        services: [],
        connectors: [],
        history: [],
      }),
    });
    renderAt("/settings", api);
    const nav = await screen.findByRole("navigation", { name: "Sections" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => [l.textContent, l.getAttribute("href")]),
    ).toEqual([
      ["General", "/settings"],
      ["Approvals", "/settings/approvals"],
      ["Team", "/settings/team"],
      // R8
      ["Business hours", "/settings/hours"],
      ["Channels", "/settings/channels"],
      ["Billing", "/settings/billing"],
      ["Exports", "/settings/exports"],
      ["Conversations", "/settings/conversations"],
      ["Voice samples", "/settings/voice"],
      // P-8
      ["US texting", "/settings/texting"],
    ]);
    // Sloan, in a few words, where it is offered.
    expect(screen.getByTestId("portal-settings-sloan")).toHaveTextContent(
      "Sloan is your account agent.",
    );

    const emails = await screen.findByTestId("portal-settings-notifications");
    const save = within(emails).getByTestId("portal-notifications-save");
    expect(save).toBeDisabled();
    await userEvent.click(within(emails).getByTestId("portal-notifications-weeklyDigest"));
    await userEvent.click(save);
    expect(await within(emails).findByText("Saved.")).toBeInTheDocument();
    expect(patches).toEqual([{ itemsWaiting: true, weeklyDigest: false }]);

    // Approvals: who approves, who approves what, and the undo window (moved from the Inbox).
    await userEvent.click(within(nav).getByRole("link", { name: "Approvals" }));
    expect(await screen.findByTestId("portal-settings-approvals")).toHaveTextContent(
      "We approve changes to your tools on your behalf.",
    );
    const team = await screen.findByTestId("desk-team");
    expect(team).toHaveTextContent("Who approves what");
    expect(within(team).getByTestId("desk-undo-window")).toHaveValue("60");
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
    const nav = await screen.findByRole("navigation", { name: "Sections" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["General", "Approvals", "Team", "Business hours", "Channels"]);
    const mine = await screen.findByTestId("portal-settings-mine");
    // No phone with consent: texts can't be turned on.
    expect(within(mine).getByTestId("portal-mine-sms")).toBeDisabled();
    await userEvent.click(within(mine).getByTestId("portal-mine-email"));
    await waitFor(() => expect(puts).toEqual([{ email: false, sms: false }]));
    expect(screen.getByTestId("portal-settings-language")).toBeInTheDocument();
    await userEvent.click(within(nav).getByRole("link", { name: "Approvals" }));
    expect(await screen.findByTestId("portal-settings-approvals-member")).toHaveTextContent(
      "To change who approves, ask your admin.",
    );
    expect(api.calls).not.toContain("GET /api/users");
    expect(api.calls).not.toContain("GET /api/settings");
    expect(api.calls).not.toContain("GET /api/billing");
  });

  it("shows the admin this month's credits and saves what happens when they run out, in Billing", async () => {
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
    renderAt("/settings/billing", api);
    // Billing: what happens when credits run out, then the month so far and statements.
    expect(await screen.findByTestId("portal-billing-meter")).toBeInTheDocument();
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
