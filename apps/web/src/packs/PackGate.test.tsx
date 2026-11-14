import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../App";
import { fakeApi } from "../test/fixtures";
import { PackGate } from "./PackGate";

const CLIENT = "00000000-0000-4000-8000-0000000000c1";

const pack = (id: string, name: string, enabled: boolean) => ({
  id,
  name,
  description: "",
  enabled,
  enabledAt: enabled ? "2026-11-01T00:00:00Z" : null,
  screens: [],
});

function renderGate(enabled: boolean) {
  const api = fakeApi({
    [`GET /api/ops/clients/${CLIENT}/packs`]: () => ({
      packs: [pack("materials", "Materials", enabled)],
    }),
  });
  render(
    <MemoryRouter>
      <AppProviders client={api.client}>
        <PackGate clientId={CLIENT} pack="materials">
          <p data-testid="report">The report</p>
        </PackGate>
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("PackGate", () => {
  it("says the pack is off, with the way to the Packs tab, instead of the report", async () => {
    renderGate(false);
    expect(await screen.findByTestId("pack-off-materials")).toHaveTextContent(
      "Materials is off for this client",
    );
    expect(screen.getByTestId("pack-off-materials-open")).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/packs`,
    );
    expect(screen.queryByTestId("report")).toBeNull();
  });

  it("shows the report when the pack is on", async () => {
    renderGate(true);
    expect(await screen.findByTestId("report")).toBeInTheDocument();
    expect(screen.queryByTestId("pack-off-materials")).toBeNull();
  });
});
