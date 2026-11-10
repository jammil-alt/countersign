// `/settings/hours` (R8, docs/plan.md §1.86): the client admin changes the week (stretches, closed
// days), US holidays and closed dates and saves them in one PUT; the zone is shown, never sent;
// overlapping hours can't be saved; a client user reads the hours and changes nothing.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";

const DEMO = CLIENT_SESSION.activeTenantId as string;
const NINE_TO_SIX = [{ from: "08:00", to: "18:00" }];

const DEFAULT = {
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

const overview = {
  client: { id: DEMO, name: "Demo client" },
  services: [],
  needsYou: { inbox: 0 },
  recentRuns: [],
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

function asRole(role: "client_admin" | "client_user", locale = "en") {
  return {
    ...CLIENT_SESSION,
    tenants: [{ id: DEMO, name: "Demo client", role }],
    language: { effective: locale, user: locale, client: null },
  };
}

describe("business hours in the portal", () => {
  it("lets the client admin change the week, holidays and closed dates, and saves them at once", async () => {
    const puts: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => asRole("client_admin"),
      "GET /api/overview": () => overview,
      "GET /api/settings/business-hours": () => DEFAULT,
      "PUT /api/settings/business-hours": ({ init }) => {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        return { hours: { tz: "America/Chicago", ...body }, isDefault: false };
      },
    });
    renderAt("/settings/hours", api);
    const card = await screen.findByTestId("portal-business-hours");
    // The default week, in the client's zone, which is shown and not editable here.
    expect(within(card).getByTestId("portal-business-hours-default")).toHaveTextContent("Default");
    expect(within(card).getByTestId("portal-business-hours-zone")).toHaveTextContent(
      "Time zone: America/Chicago",
    );
    expect(screen.getByTestId("portal-business-hours-zone-ask")).toHaveTextContent("ask us.");
    const save = within(card).getByTestId("portal-business-hours-save");
    expect(save).toBeDisabled();

    // Friday closes at noon; Saturday opens with the hours of the day before it.
    fireEvent.change(within(card).getByTestId("portal-business-hours-week-fri-0-to"), {
      target: { value: "12:00" },
    });
    await userEvent.click(within(card).getByTestId("portal-business-hours-week-sat-open"));
    expect(within(card).getByTestId("portal-business-hours-week-sat-0-from")).toHaveValue("08:00");
    expect(within(card).getByTestId("portal-business-hours-week-sat-0-to")).toHaveValue("12:00");
    // Monday gets a second stretch, in the evening.
    await userEvent.click(within(card).getByTestId("portal-business-hours-week-mon-add"));
    expect(within(card).getByTestId("portal-business-hours-week-mon-1-from")).toHaveValue("19:00");
    // Wednesday is closed.
    await userEvent.click(within(card).getByTestId("portal-business-hours-week-wed-open"));
    expect(within(card).getByTestId("portal-business-hours-week-wed")).toHaveTextContent("Closed");
    // Open on US holidays, closed on Christmas Eve.
    await userEvent.click(within(card).getByTestId("portal-business-hours-us-holidays"));
    fireEvent.change(within(card).getByTestId("portal-business-hours-closed-input"), {
      target: { value: "2026-12-24" },
    });
    await userEvent.click(within(card).getByTestId("portal-business-hours-closed-add"));
    expect(within(card).getByTestId("portal-business-hours-closed-2026-12-24")).toHaveTextContent(
      "Dec 24, 2026",
    );

    await userEvent.click(save);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      week: {
        mon: [
          { from: "08:00", to: "18:00" },
          { from: "19:00", to: "21:00" },
        ],
        tue: NINE_TO_SIX,
        thu: NINE_TO_SIX,
        fri: [{ from: "08:00", to: "12:00" }],
        sat: [{ from: "08:00", to: "12:00" }],
      },
      usHolidays: false,
      closed: ["2026-12-24"],
    });
    expect(await within(card).findByText("Saved.")).toBeInTheDocument();
    expect(within(card).queryByTestId("portal-business-hours-default")).toBeNull();
    // Back to the default week in one step.
    await userEvent.click(within(card).getByTestId("portal-business-hours-use-default"));
    expect(within(card).getByTestId("portal-business-hours-week-sat")).toHaveTextContent("Closed");
  });

  it("won't save hours that end before they start or overlap", async () => {
    const api = fakeApi({
      "GET /api/session": () => asRole("client_admin"),
      "GET /api/overview": () => overview,
      "GET /api/settings/business-hours": () => DEFAULT,
    });
    renderAt("/settings/hours", api);
    const card = await screen.findByTestId("portal-business-hours");
    await userEvent.click(within(card).getByTestId("portal-business-hours-week-tue-add"));
    fireEvent.change(within(card).getByTestId("portal-business-hours-week-tue-1-from"), {
      target: { value: "17:00" },
    });
    expect(within(card).getByTestId("portal-business-hours-problem")).toHaveTextContent(
      "Tuesday: the hours overlap.",
    );
    expect(within(card).getByTestId("portal-business-hours-save")).toBeDisabled();
    fireEvent.change(within(card).getByTestId("portal-business-hours-week-tue-1-from"), {
      target: { value: "22:00" },
    });
    expect(within(card).getByTestId("portal-business-hours-problem")).toHaveTextContent(
      "Tuesday: each closing time must be after its opening time.",
    );
    expect(api.calls).not.toContain("PUT /api/settings/business-hours");
  });

  it("shows a client user the hours, read-only, in their language", async () => {
    const api = fakeApi({
      "GET /api/session": () => asRole("client_user", "es"),
      "GET /api/overview": () => overview,
      "GET /api/settings/business-hours": () => ({
        ...DEFAULT,
        hours: { ...DEFAULT.hours, closed: ["2026-12-24"] },
      }),
    });
    renderAt("/settings/hours", api);
    const card = await screen.findByTestId("portal-business-hours");
    const week = within(card).getByTestId("portal-business-hours-summary-week");
    expect(week).toHaveTextContent("lun a vie");
    expect(week).toHaveTextContent("Cerrado");
    expect(within(card).getByTestId("portal-business-hours-summary-holidays")).toHaveTextContent(
      "Cerrado en los feriados federales de EE. UU.",
    );
    expect(within(card).queryByTestId("portal-business-hours-save")).toBeNull();
    expect(screen.getByTestId("portal-business-hours-read-only")).toHaveTextContent(
      "Solo su administrador puede cambiar esto.",
    );
    expect(
      within(screen.getByRole("navigation", { name: "Secciones" })).getByRole("link", {
        name: "Horario laboral",
      }),
    ).toBeInTheDocument();
  });
});
