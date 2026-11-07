// The client settings' Compliance and Retire client sections: HIPAA mode switches with no reason
// asked for and is held back while a vendor it needs isn't covered; vendors and the change log
// show; retiring needs the name typed again (no reason), shows the server's refusal, and then when
// the data can be purged.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";

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

function setup(
  section: "compliance" | "retire",
  handlers: Record<string, Parameters<typeof fakeApi>[0][string]>,
) {
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    [`GET /api/ops/clients/${DEMO}`]: () => ({
      client: { id: DEMO, name: "Demo client", timezone: "UTC", settings: {}, createdAt: "x" },
      agents: [],
      connections: [],
      members: [],
    }),
    ...handlers,
  });
  render(
    <MemoryRouter initialEntries={[`/ops/clients/${DEMO}/settings/${section}`]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("client compliance", () => {
  it("switches HIPAA mode on without a reason, and shows vendors and the change", async () => {
    let current = compliance();
    const sent: unknown[] = [];
    setup("compliance", {
      [`GET /api/ops/clients/${DEMO}/compliance`]: () => current,
      [`PUT /api/ops/clients/${DEMO}/compliance`]: ({ init }) => {
        const body = JSON.parse(String(init.body)) as { hipaa: boolean };
        sent.push(body);
        current = compliance({
          hipaa: body.hipaa,
          changes: [
            {
              id: "c1",
              setting: "compliance.hipaa",
              to: body.hipaa,
              // The server's default when no reason is given: not repeated in the log line.
              reason: "HIPAA mode switched on",
              by: { id: "o", email: "operator@example.com" },
              createdAt: "2026-11-05T10:00:00.000Z",
            },
          ],
        });
        return current;
      },
    });
    const card = await screen.findByTestId("ops-client-compliance", {}, { timeout: 10_000 });
    expect(await within(card).findByTestId("ops-client-hipaa-state")).toHaveTextContent("Off");
    expect(within(card).getByTestId("ops-client-processor-twilio")).toHaveTextContent(
      "TwilioNot covered",
    );
    expect(within(card).getByTestId("ops-client-processor-anthropic")).toHaveTextContent(
      "AnthropicCovered",
    );
    // No reason field.
    expect(within(card).queryByRole("textbox")).toBeNull();

    await userEvent.click(within(card).getByTestId("ops-client-hipaa-toggle"));
    await waitFor(() =>
      expect(within(card).getByTestId("ops-client-hipaa-state")).toHaveTextContent("On"),
    );
    expect(sent).toEqual([{ hipaa: true }]);
    const history = within(card).getByTestId("ops-client-compliance-history");
    expect(history).toHaveTextContent(/^HIPAA mode switched on by operator@example\.com on .+\.$/);
    expect(within(card).getByTestId("ops-client-hipaa-toggle")).toHaveTextContent("Switch off");
  });

  it("holds the switch back and says why while a vendor isn't covered", async () => {
    setup("compliance", {
      [`GET /api/ops/clients/${DEMO}/compliance`]: () =>
        compliance({
          readiness: { ready: false, problems: ["Neon has no signed BAA yet."] },
        }),
    });
    const card = await screen.findByTestId("ops-client-compliance", {}, { timeout: 10_000 });
    expect(await within(card).findByTestId("ops-client-hipaa-problems")).toHaveTextContent(
      "Neon has no signed BAA yet.",
    );
    expect(within(card).getByTestId("ops-client-hipaa-toggle")).toBeDisabled();
  });

  it("shows the server's refusal in the card", async () => {
    setup("compliance", {
      [`GET /api/ops/clients/${DEMO}/compliance`]: () => compliance(),
      [`PUT /api/ops/clients/${DEMO}/compliance`]: () =>
        new Reply(409, {
          error: { code: "not_covered", message: "Twilio is offered and has no signed BAA." },
        }),
    });
    const card = await screen.findByTestId("ops-client-compliance", {}, { timeout: 10_000 });
    await userEvent.click(await within(card).findByTestId("ops-client-hipaa-toggle"));
    expect(await within(card).findByTestId("ops-client-hipaa-error")).toHaveTextContent(
      "Twilio is offered and has no signed BAA.",
    );
    expect(within(card).getByTestId("ops-client-hipaa-state")).toHaveTextContent("Off");
  });
});

describe("retire client", () => {
  it("needs the name typed again, then shows when data can be purged", async () => {
    const sent: unknown[] = [];
    let refuse = true;
    setup("retire", {
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
    const section = await screen.findByTestId("ops-client-retire", {}, { timeout: 10_000 });
    expect(
      await within(section).findByText(/After 30 days we delete its files, then its records\./),
    ).toBeInTheDocument();
    const confirm = within(section).getByTestId("ops-client-retire-confirm");
    expect(confirm).toBeDisabled();
    // One field: the name. No reason.
    expect(within(section).getAllByRole("textbox")).toHaveLength(1);

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
    expect(sent).toEqual([{ confirmName: "Demo client" }, { confirmName: "Demo client" }]);
  });

  it("shows a retired client's dates instead of the button", async () => {
    setup("retire", {
      [`GET /api/ops/clients/${DEMO}/compliance`]: () =>
        compliance({
          retiredAt: "2026-11-01T10:00:00.000Z",
          purgeAfter: "2026-12-01T10:00:00.000Z",
        }),
    });
    const section = await screen.findByTestId("ops-client-retire", {}, { timeout: 10_000 });
    expect(await within(section).findByTestId("ops-client-retired")).toHaveTextContent(
      "data can be purged after",
    );
    expect(within(section).queryByTestId("ops-client-retire-confirm")).toBeNull();
  });
});
