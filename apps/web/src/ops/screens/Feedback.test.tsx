// `/ops/feedback` and the client page's switch: the list with pins and pictures, resolve with a
// note, reopen; switching the portal's button on needs a reason.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, Reply, SANDBOX_DETAIL } from "../../test/fixtures";

const ID = "00000000-0000-4000-8000-0000000fb001";
const DEMO = "00000000-0000-4000-8000-00000000a002";
const item = (over: Record<string, unknown> = {}) => ({
  id: ID,
  surface: "portal",
  client: { id: DEMO, name: "Demo client" },
  from: { id: "u1", email: "admin@demo.example.com", name: "Demo admin" },
  comment: "Approve is hidden",
  path: "/inbox",
  viewport: { width: 1000, height: 500 },
  pin: { x: 250, y: 100 },
  target: 'button "Approve"',
  hasScreenshot: true,
  status: "open",
  createdAt: "2026-11-04T10:00:00.000Z",
  resolvedAt: null,
  resolvedBy: null,
  resolutionNote: null,
  ...over,
});

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("ops feedback", () => {
  it("lists open feedback with the pin on the picture, resolves with a note, reopens", async () => {
    let current = item();
    const bodies: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/feedback": ({ url }) => {
        const status = url.searchParams.get("status") ?? "open";
        return { items: status === "all" || status === current.status ? [current] : [] };
      },
      [`GET /api/ops/feedback/${ID}/screenshot`]: () => ({
        url: "/api/files/token",
        expiresAt: "2026-11-04T10:05:00.000Z",
      }),
      [`POST /api/ops/feedback/${ID}/resolve`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        current = item({
          status: "resolved",
          resolvedAt: "2026-11-04T11:00:00.000Z",
          resolvedBy: { id: "o", email: "operator@example.com", name: "Operator" },
          resolutionNote: "https://github.com/x/y/pull/1",
        });
        return { item: current };
      },
      [`POST /api/ops/feedback/${ID}/reopen`]: () => {
        current = item();
        return { item: current };
      },
    });
    renderAt("/ops/feedback", api);
    const card = await screen.findByTestId(`ops-feedback-item-${ID}`);
    expect(within(card).getByTestId("ops-feedback-status")).toHaveTextContent("Open");
    expect(within(card).getByTestId("ops-feedback-status")).toHaveClass("ds-pill--warning");
    expect(within(card).getByTestId("ops-feedback-client")).toHaveTextContent("Demo client");
    expect(within(card).getByTestId("ops-feedback-target")).toHaveTextContent('button "Approve"');
    const pin = await within(card).findByTestId("ops-feedback-picture-pin");
    expect(pin.style.left).toBe("25%");
    expect(pin.style.top).toBe("20%");
    await waitFor(() =>
      expect(within(card).getByRole("img")).toHaveAttribute("src", "/api/files/token"),
    );

    await userEvent.click(within(card).getByTestId("ops-feedback-resolve"));
    await userEvent.type(screen.getByTestId("ops-feedback-note"), "https://github.com/x/y/pull/1");
    await userEvent.click(screen.getByTestId("ops-feedback-resolve-confirm"));
    expect(bodies).toEqual([{ note: "https://github.com/x/y/pull/1" }]);
    await waitFor(() => expect(screen.queryByTestId(`ops-feedback-item-${ID}`)).toBeNull());

    await userEvent.click(screen.getByTestId("ops-feedback-filter-resolved"));
    const done = await screen.findByTestId(`ops-feedback-item-${ID}`);
    expect(within(done).getByTestId("ops-feedback-status")).toHaveClass("ds-pill--positive");
    expect(within(done).getByTestId("ops-feedback-resolution")).toHaveTextContent("Operator");
    await userEvent.click(within(done).getByTestId("ops-feedback-reopen"));
    await waitFor(() => expect(screen.queryByTestId(`ops-feedback-item-${ID}`)).toBeNull());
  });

  it("names back-office feedback and one with no spot", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/feedback": () => ({
        items: [
          item({ surface: "ops", client: null, pin: null, target: null, hasScreenshot: false }),
        ],
      }),
    });
    renderAt("/ops/feedback", api);
    const card = await screen.findByTestId(`ops-feedback-item-${ID}`);
    expect(within(card).getByTestId("ops-feedback-client")).toHaveTextContent("Back office");
    expect(within(card).getByTestId("ops-feedback-target")).toHaveTextContent("No particular spot");
    expect(within(card).getByTestId("ops-feedback-no-picture")).toBeInTheDocument();
  });
});

describe("client feedback switch", () => {
  it("needs a reason, then switches the portal's button on and shows who and why", async () => {
    let enabled = false;
    const changes: unknown[] = [];
    const sent: unknown[] = [];
    const client = SANDBOX_DETAIL.client.id;
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${client}`]: () => SANDBOX_DETAIL,
      [`GET /api/ops/clients/${client}/feedback`]: () => ({ enabled, changes }),
      [`PUT /api/ops/clients/${client}/feedback`]: ({ init }) => {
        const body = JSON.parse(String(init.body)) as { enabled: boolean; reason: string };
        if (!body.reason) return new Reply(400, { error: { code: "invalid_request" } });
        sent.push(body);
        enabled = body.enabled;
        changes.unshift({
          id: "c1",
          enabled,
          reason: body.reason,
          by: { id: "o", email: "operator@example.com", name: "Operator" },
          createdAt: "2026-11-04T10:00:00.000Z",
        });
        return { enabled, changes };
      },
    });
    renderAt(`/ops/clients/${client}`, api);
    const section = await screen.findByTestId("ops-client-feedback");
    expect(within(section).getByTestId("ops-client-feedback-state")).toHaveTextContent("Off");
    await userEvent.click(within(section).getByTestId("ops-client-feedback-toggle"));
    expect(await within(section).findByText("Give a reason.")).toBeInTheDocument();
    expect(sent).toEqual([]);
    await userEvent.type(within(section).getByTestId("ops-client-feedback-reason"), "Beta");
    await userEvent.click(within(section).getByTestId("ops-client-feedback-toggle"));
    await waitFor(() =>
      expect(within(section).getByTestId("ops-client-feedback-state")).toHaveTextContent("On"),
    );
    expect(sent).toEqual([{ enabled: true, reason: "Beta" }]);
    expect(within(section).getByTestId("ops-client-feedback-history")).toHaveTextContent(
      "Switched on by Operator",
    );
    expect(within(section).getByTestId("ops-client-feedback-toggle")).toHaveTextContent(
      "Switch off",
    );
  });
});
