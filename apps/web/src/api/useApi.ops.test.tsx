// The operator's client switch, on the real path (the top bar's picker): the next client's page
// never shows the last client's answers (docs/audit-plan.md 1.2, the store under useApi).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { fakeApi, OPERATOR_SESSION, SANDBOX_DETAIL } from "../test/fixtures";

const ALPHA = "00000000-0000-4000-8000-0000000aa001";
const BETA = "00000000-0000-4000-8000-0000000aa002";
const row = (id: string, name: string) => ({
  id,
  name,
  timezone: "UTC",
  createdAt: "2026-11-01T00:00:00.000Z",
  agents: 0,
  openInbox: 0,
  needsUs: 0,
  waitingRuns: 0,
});
const detail = (id: string, name: string) => ({
  ...SANDBOX_DETAIL,
  client: { ...SANDBOX_DETAIL.client, id, name },
  agents: [],
});

afterEach(() => sessionStorage.clear());

describe("the operator's client picker and the store", () => {
  it("never shows the last client's answers on the next client's page", async () => {
    let releaseBeta: () => void = () => {};
    const betaAnswered = new Promise<void>((r) => {
      releaseBeta = r;
    });
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({
        clients: [row(ALPHA, "Alpha Works"), row(BETA, "Beta Mill")],
      }),
      "GET /api/ops/counts": () => ({ needsUs: 0, clients: [] }),
      [`GET /api/ops/clients/${ALPHA}`]: () => detail(ALPHA, "Alpha Works"),
      [`GET /api/ops/clients/${BETA}`]: async () => {
        await betaAnswered;
        return detail(BETA, "Beta Mill");
      },
    });
    render(
      <MemoryRouter initialEntries={[`/ops/clients/${ALPHA}`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { level: 1, name: "Alpha Works" });
    await userEvent.selectOptions(await screen.findByTestId("ops-client-switcher"), BETA);
    // Beta's page is open and its answer not in yet: nothing of Alpha's page shows under it.
    await waitFor(() => expect(api.calls).toContain(`GET /api/ops/clients/${BETA}`));
    expect(screen.queryByRole("heading", { level: 1, name: "Alpha Works" })).toBeNull();
    releaseBeta();
    expect(await screen.findByRole("heading", { level: 1, name: "Beta Mill" })).toBeTruthy();
  });
});
