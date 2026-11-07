// `/settings/exports` (UI-3a): the admin downloads the accountant export (ZIP or CSV) and the audit
// log for a period; a period the API would refuse has no link; a client user is told only the admin
// downloads.
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";
import { lastMonth } from "./Exports";

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

describe("portal exports", () => {
  it("defaults to last month", () => {
    expect(lastMonth(new Date(2026, 10, 6))).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(lastMonth(new Date(2026, 0, 15))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("links each download to its period and format", async () => {
    const api = fakeApi({ "GET /api/session": () => CLIENT_SESSION });
    renderAt("/settings/exports", api);
    const { from, to } = lastMonth();
    const accountant = await screen.findByTestId("portal-export-accountant-download");
    expect(accountant).toHaveAttribute(
      "href",
      `/api/exports/accountant?from=${from}&to=${to}&format=zip`,
    );
    await userEvent.click(screen.getByTestId("portal-export-format-csv"));
    expect(accountant).toHaveAttribute(
      "href",
      `/api/exports/accountant?from=${from}&to=${to}&format=csv`,
    );
    expect(screen.getByTestId("portal-export-audit-download")).toHaveAttribute(
      "href",
      `/api/audit/export.csv?from=${from}&to=${to}`,
    );

    // The wrong way round: no link, and the reason.
    fireEvent.change(screen.getByTestId("portal-export-audit-from"), {
      target: { value: "2026-12-01" },
    });
    expect(screen.getByTestId("portal-export-audit-download")).not.toHaveAttribute("href");
    expect(screen.getByTestId("portal-export-audit-to-error")).toHaveTextContent(
      "The first day must come before the last.",
    );
    // Over a year.
    fireEvent.change(screen.getByTestId("portal-export-audit-from"), {
      target: { value: "2024-01-01" },
    });
    expect(screen.getByTestId("portal-export-audit-to-error")).toHaveTextContent(
      "A period is at most 366 days.",
    );
  });

  it("tells a client user only the admin downloads exports", async () => {
    const api = fakeApi({
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        tenants: [{ id: DEMO, name: "Demo client", role: "client_user" }],
      }),
    });
    renderAt("/settings/exports", api);
    expect(await screen.findByText("Only your admin can download exports.")).toBeInTheDocument();
    expect(screen.queryByTestId("portal-export-accountant-download")).toBeNull();
  });
});
