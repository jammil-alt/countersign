// The client settings' Compliance card: HIPAA mode needs a reason and is held back while a vendor
// it needs isn't covered; vendors and the change log show; retiring needs a reason and the name
// typed again, shows the server's refusal, and then when the data can be purged.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";

const SETTINGS = {
  client: { id: DEMO, name: "Demo client", timezone: "UTC", sandbox: false },
  approvals: { externalActions: "client_admin", changes: [] },
  notifications: { itemsWaiting: true, weeklyDigest: false },
  members: [],
};

const compliance = (over: Record<string, unknown> = {}) => ({
  clientId: DEMO,
  hipaa: false,
  readiness: { ready: true, problems: [] },
  processors: [
    { id: "cloudflare", name: "Cloudflare", covered: true },
    { id: "anthropic", name: "Anthropic", covered: true },
    { id: "twilio", name: "Twilio", covered: false },
  ],
  retiredAt: null,
  purgeAfter: null,
  changes: [],
  ...over,
});

function setup(handlers: Record<string, Parameters<typeof fakeApi>[0][string]>) {
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    [`GET /api/ops/clients/${DEMO}`]: () => ({
      client: { id: DEMO, name: "Demo client", timezone: "UTC", settings: {}, createdAt: "x" },
      agents: [],
      connections: [],
      members: [],
    }),
    [`GET /api/ops/clients/${DEMO}/settings`]: () => SETTINGS,
    [`GET /api/ops/clients/${DEMO}/connections`]: () => ({
      connections: [],
      offered: [],
      connectors: [],
      usedBy: {},
      sandbox: false,
    }),
    ...handlers,
  });
  render(
    <MemoryRouter initialEntries={[`/ops/clients/${DEMO}/settings`]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("client compliance", () => {
  it("switches HIPAA mode on with a reason, and shows vendors and the change", async () => {
    let current = compliance();
    const sent: unknown[] = [];
    setup({
      [`GET /api/ops/clients/${DEMO}/compliance`]: () => current,
      [`PUT /api/ops/clients/${DEMO}/compliance`]: ({ init }) => {
        const body = JSON.parse(String(init.body)) as { hipaa: boolean; reason: string };
        sent.push(body);
        current = compliance({
          hipaa: body.hipaa,
          changes: [
            {
              id: "c1",
              setting: "compliance.hipaa",
              to: body.hipaa,
              reason: body.reason,
              by: { id: "o", email: "operator@example.com" },
              createdAt: "2026-11-05T10:00:00.000Z",
            },
          ],
        });
        return current;
      },
    });
    const card = await screen.findByTestId("ops-client-compliance");
    expect(await within(card).findByTestId("ops-client-hipaa-state")).toHaveTextContent("Off");
    expect(within(card).getByTestId("ops-client-processor-twilio")).toHaveTextContent(
      "TwilioNot covered",
    );
    expect(within(card).getByTestId("ops-client-processor-anthropic")).toHaveTextContent(
      "AnthropicCovered",
    );

    await userEvent.click(within(card).getByTestId("ops-client-hipaa-toggle"));
    expect(await within(card).findByText("Give a reason.")).toBeInTheDocument();
    expect(sent).toEqual([]);

    await userEvent.type(within(card).getByTestId("ops-client-hipaa-reason"), "Clinic records");
    await userEvent.click(within(card).getByTestId("ops-client-hipaa-toggle"));
    await waitFor(() =>
      expect(within(card).getByTestId("ops-client-hipaa-state")).toHaveTextContent("On"),
    );
    expect(sent).toEqual([{ hipaa: true, reason: "Clinic records" }]);
    expect(within(card).getByTestId("ops-client-compliance-history")).toHaveTextContent(
      "HIPAA mode switched on by operator@example.com",
    );
    expect(within(card).getByTestId("ops-client-compliance-history")).toHaveTextContent(
      "Clinic records",
    );
    expect(within(card).getByTestId("ops-client-hipaa-toggle")).toHaveTextContent("Switch off");
  });

  it("holds the switch back and says why while a vendor isn't covered", async () => {
    setup({
      [`GET /api/ops/clients/${DEMO}/compliance`]: () =>
        compliance({
          readiness: { ready: false, problems: ["Neon has no signed BAA yet."] },
        }),
    });
    const card = await screen.findByTestId("ops-client-compliance");
    expect(await within(card).findByTestId("ops-client-hipaa-problems")).toHaveTextContent(
      "Neon has no signed BAA yet.",
    );
    expect(within(card).getByTestId("ops-client-hipaa-toggle")).toBeDisabled();
    expect(within(card).getByTestId("ops-client-hipaa-reason")).toBeDisabled();
  });

  it("shows the server's refusal in the card", async () => {
    setup({
      [`GET /api/ops/clients/${DEMO}/compliance`]: () => compliance(),
      [`PUT /api/ops/clients/${DEMO}/compliance`]: () =>
        new Reply(409, {
          error: { code: "not_covered", message: "Twilio is offered and has no signed BAA." },
        }),
    });
    const card = await screen.findByTestId("ops-client-compliance");
    await userEvent.type(await within(card).findByTestId("ops-client-hipaa-reason"), "Clinic");
    await userEvent.click(within(card).getByTestId("ops-client-hipaa-toggle"));
    expect(await within(card).findByTestId("ops-client-hipaa-error")).toHaveTextContent(
      "Twilio is offered and has no signed BAA.",
    );
    expect(within(card).getByTestId("ops-client-hipaa-state")).toHaveTextContent("Off");
  });
});

describe("retire client", () => {
  it("needs a reason and the name typed again, then shows when data can be purged", async () => {
    const sent: unknown[] = [];
    let refuse = true;
    setup({
      [`GET /api/ops/clients/${DEMO}/compliance`]: () => compliance(),
      [`POST /api/ops/clients/${DEMO}/retire`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        if (refuse) {
          refuse = false;
          return new Reply(409, {
            error: { code: "runs_going", message: "Two runs are still going. Try again soon." },
          });
        }
        return compliance({
          retiredAt: "2026-11-05T10:00:00.000Z",
          purgeAfter: "2026-12-05T10:00:00.000Z",
        });
      },
    });
    const section = await screen.findByTestId("ops-client-retire");
    expect(section).toHaveTextContent("After 30 days we delete its files, then its records.");
    const confirm = within(section).getByTestId("ops-client-retire-confirm");
    expect(confirm).toBeDisabled();

    await userEvent.type(within(section).getByTestId("ops-client-retire-reason"), "Contract ended");
    await userEvent.type(within(section).getByTestId("ops-client-retire-name"), "Demo");
    expect(confirm).toBeDisabled();
    await userEvent.type(within(section).getByTestId("ops-client-retire-name"), " client");
    expect(confirm).toBeEnabled();

    await userEvent.click(confirm);
    expect(await within(section).findByTestId("ops-client-retire-error")).toHaveTextContent(
      "Two runs are still going.",
    );
    await userEvent.click(within(section).getByTestId("ops-client-retire-confirm"));
    const retired = await within(section).findByTestId("ops-client-retired");
    expect(retired).toHaveTextContent(/^Retired on .+; data can be purged after .+\.$/);
    expect(within(section).queryByTestId("ops-client-retire-confirm")).toBeNull();
    expect(sent).toEqual([
      { reason: "Contract ended", confirmName: "Demo client" },
      { reason: "Contract ended", confirmName: "Demo client" },
    ]);
  });

  it("shows a retired client's dates instead of the button", async () => {
    setup({
      [`GET /api/ops/clients/${DEMO}/compliance`]: () =>
        compliance({
          retiredAt: "2026-11-01T10:00:00.000Z",
          purgeAfter: "2026-12-01T10:00:00.000Z",
        }),
    });
    const section = await screen.findByTestId("ops-client-retire");
    expect(await within(section).findByTestId("ops-client-retired")).toHaveTextContent(
      "data can be purged after",
    );
    expect(within(section).queryByTestId("ops-client-retire-confirm")).toBeNull();
  });
});
