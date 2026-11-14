// Security and compliance (§1.100): the overview's frameworks and figures, the register filtered
// by framework, the vendors with their BAA, a client's summary for its IT team, and the audit log's
// move from Utilities.
import { CONTROLS, FRAMEWORKS } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const ACME = "00000000-0000-4000-8000-00000000a002";
const CLINIC = "00000000-0000-4000-8000-00000000a003";

const OVERVIEW = {
  covered: ["cloudflare", "neon"],
  clients: [
    {
      id: ACME,
      name: "Acme Supply",
      tier: "standard",
      sandbox: false,
      retiredAt: null,
      purgeAfter: null,
      admins: 2,
      users: 5,
      lastSignInAt: "2026-11-12T15:00:00.000Z",
    },
    {
      id: CLINIC,
      name: "Northside Clinic",
      tier: "regulated",
      sandbox: false,
      retiredAt: null,
      purgeAfter: null,
      admins: 1,
      users: 0,
      lastSignInAt: null,
    },
  ],
  audit30d: { events: 1234, refused: 7 },
  generatedAt: "2026-11-14T12:00:00.000Z",
};

function renderAt(path: string) {
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    "GET /api/ops/security": () => OVERVIEW,
    "GET /api/ops/audit": () => ({ events: [], nextBefore: null }),
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("Security and compliance", () => {
  it("shows each framework's progress, the figures and what's still open", async () => {
    renderAt("/ops/security");
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByTestId("ops-nav-security")).toHaveAttribute("aria-current", "page");
    for (const f of FRAMEWORKS) {
      expect(screen.getByTestId(`ops-security-framework-${f}`)).toBeInTheDocument();
    }
    const figures = await screen.findByTestId("ops-security-figures");
    expect(within(figures).getByText("1 regulated, 1 standard")).toBeInTheDocument();
    expect(within(figures).getByText(`2 of ${15}`)).toBeInTheDocument();
    expect(within(figures).getByText("1,234")).toBeInTheDocument();
    const open = screen.getByTestId("ops-security-open");
    const notInPlace = CONTROLS.filter((c) => c.status !== "in_place");
    expect(within(open).getAllByRole("row")).toHaveLength(notInPlace.length + 1);
  });

  it("filters the register by framework, in the URL", async () => {
    renderAt("/ops/security/controls");
    expect(await screen.findByRole("heading", { name: "Controls" })).toBeInTheDocument();
    expect(screen.getByTestId("ops-control-VEN-4")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("ops-security-framework-filter-pci"));
    await waitFor(() => expect(screen.queryByTestId("ops-control-VEN-4")).toBeNull());
    const pciControls = CONTROLS.filter((c) => (c.maps.pci?.length ?? 0) > 0);
    for (const c of pciControls) expect(screen.getByTestId(`ops-control-${c.id}`)).toBeVisible();
    expect(
      within(screen.getByTestId("ops-control-DAT-5")).getByTestId("ops-control-maps"),
    ).toHaveTextContent("PCI DSS 3.2.1, 12.8.1");
  });

  it("lists the vendors and which have a signed BAA", async () => {
    renderAt("/ops/security/vendors");
    const neon = await screen.findByTestId("ops-security-vendor-neon");
    expect(within(neon).getByText("Signed")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("ops-security-vendor-anthropic")).getByText("Not signed"),
    ).toBeInTheDocument();
  });

  it("gives a client's IT team a summary, with only covered vendors for a regulated client", async () => {
    renderAt(`/ops/security/clients/${CLINIC}`);
    expect(await screen.findByRole("heading", { name: "Northside Clinic" })).toBeInTheDocument();
    expect(screen.getByTestId("security-print")).toBeInTheDocument();
    const vendors = screen.getByTestId("ops-security-client-vendors");
    expect(within(vendors).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByTestId("ops-control-VEN-3")).toBeInTheDocument();
  });

  it("leaves regulated-only controls out of a standard client's summary", async () => {
    renderAt(`/ops/security/clients/${ACME}`);
    expect(await screen.findByRole("heading", { name: "Acme Supply" })).toBeInTheDocument();
    expect(screen.queryByTestId("ops-control-VEN-3")).toBeNull();
    expect(screen.getByTestId("ops-control-ISO-1")).toBeInTheDocument();
  });

  it("keeps the audit log's old Utilities address working", async () => {
    renderAt("/ops/utilities/audit");
    expect(await screen.findByRole("heading", { name: "Audit log" })).toBeInTheDocument();
    expect(screen.getByTestId("security-tabs")).toBeInTheDocument();
  });
});
