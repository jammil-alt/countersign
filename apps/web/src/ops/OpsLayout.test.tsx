// The back-office frame's counts (docs/audit-plan.md 2.3): asked again when the place changes
// (the first path segment after `/ops`), not on every move inside one place.
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { fakeApi, OPERATOR_SESSION } from "../test/fixtures";
import { opsPlace } from "./OpsLayout";

const RUN = "00000000-0000-4000-8000-00000000f001";
const RUN2 = "00000000-0000-4000-8000-00000000f002";

let go: (to: string) => void = () => {};
function Driver() {
  go = useNavigate();
  return null;
}

describe("the frame's counts", () => {
  it("names the place an address is in", () => {
    expect(opsPlace("/ops")).toBe("");
    expect(opsPlace("/ops/")).toBe("");
    expect(opsPlace("/ops/runs")).toBe("runs");
    expect(opsPlace(`/ops/runs/${RUN}`)).toBe("runs");
    expect(opsPlace("/ops/clients/x/agents/bill-clerk/versions")).toBe("clients");
  });

  it("asks again on a move to another place, not inside one", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({ clients: [] }),
      "GET /api/ops/counts": () => ({ needsUs: 2, clients: [] }),
      "GET /api/ops/runs": () => ({ runs: [], agents: [] }),
    });
    const counts = () => api.calls.filter((c) => c === "GET /api/ops/counts").length;
    render(
      <MemoryRouter initialEntries={["/ops/runs"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
          <Driver />
        </AppProviders>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("shell-inbox")).toHaveTextContent("2"));
    expect(counts()).toBe(1);

    // Runs → a run → another run: one place, no new ask.
    act(() => go(`/ops/runs/${RUN}`));
    act(() => go(`/ops/runs/${RUN2}`));
    act(() => go("/ops/runs"));
    await new Promise((r) => setTimeout(r, 50));
    expect(counts()).toBe(1);

    // Runs → Agent lab: another place, asked again.
    act(() => go("/ops/lab"));
    await waitFor(() => expect(counts()).toBe(2));
  });
});
