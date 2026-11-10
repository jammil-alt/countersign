// "Reset sign-in methods" on a client's People (docs/plan.md §1.83): operator only, a reason
// required, confirmed in the page, then said in plain words; not offered for someone who has never
// signed in.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const ANA = "00000000-0000-4000-8000-00000000d010";

const member = (userId: string, email: string, extra: Record<string, unknown> = {}) => ({
  userId,
  email,
  name: null,
  role: "client_user",
  signedIn: true,
  ...extra,
});

describe("resetting a person's sign-in methods", () => {
  it("asks for a reason, confirms in the page and says what happens next", async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${DEMO}`]: () => ({
        client: { id: DEMO, name: "Demo client", timezone: "UTC", settings: {}, createdAt: "x" },
        agents: [],
        connections: [],
        members: [],
      }),
      [`GET /api/ops/clients/${DEMO}/settings`]: () => ({
        client: { id: DEMO, name: "Demo client", timezone: "UTC", sandbox: false, internal: false },
        approvals: { externalActions: "client_admin", changes: [] },
        notifications: { itemsWaiting: true, weeklyDigest: false },
        members: [
          member(ANA, "ana@demo.example.com", { name: "Ana" }),
          member("00000000-0000-4000-8000-00000000d011", "new@demo.example.com", {
            signedIn: false,
          }),
        ],
      }),
      [`POST /api/ops/users/${ANA}/second-factor/reset`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return { reset: true, methodsRemoved: 2 };
      },
    });
    render(
      <MemoryRouter initialEntries={[`/ops/clients/${DEMO}/settings/people`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const user = userEvent.setup();

    const row = await screen.findByTestId(
      "ops-client-members-ana@demo.example.com",
      {},
      { timeout: 10_000 },
    );
    // Someone who has never signed in has nothing to reset.
    expect(screen.queryByTestId("ops-client-reset-sign-in-new@demo.example.com")).toBeNull();
    await user.click(within(row).getByTestId("ops-client-reset-sign-in-ana@demo.example.com"));

    const dialog = screen.getByRole("dialog", { name: "Reset sign-in methods" });
    expect(dialog).toHaveTextContent("We remove Ana's authenticator app, phone numbers and");
    // A reason is required: nothing is sent without one.
    await user.click(within(dialog).getByRole("button", { name: "Reset" }));
    expect(dialog).toHaveTextContent("Say why you're resetting them.");
    expect(bodies).toEqual([]);

    await user.type(within(dialog).getByLabelText(/^Reason/), "Lost their phone");
    await user.click(within(dialog).getByRole("button", { name: "Reset" }));
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "Done: they'll set up a method at their next sign-in.",
    );
    expect(bodies).toEqual([{ reason: "Lost their phone" }]);

    await user.click(
      within(dialog).getByTestId("ops-client-reset-sign-in-ana@demo.example.com-dialog-close"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
