// A change Mezonas asks to make to a connection, in the Inbox (Connectors C5,
// docs/connectors-plan.md §7.1, §7.2): the rows before → after in plain words, the reason, the
// agent it's for and who asked; a client admin approves or declines with an optional note back; one
// the connection changed since says Out of date and offers no Approve. A client user reads it. A
// change we made at once is a notice: what, why, under which go-ahead, closed with Done.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { changeRequest, connectionPage } from "../../test/connectors";
import { CLIENT_SESSION, fakeApi, Reply } from "../../test/fixtures";

const TENANT = CLIENT_SESSION.activeTenantId as string;
const ME = CLIENT_SESSION.user.id;
const ITEM = "00000000-0000-4000-8000-0000000c7a01";
const NOTICE = "00000000-0000-4000-8000-0000000c7a02";
const REQ = "00000000-0000-4000-8000-0000000c7a0f";
const CONN = "00000000-0000-4000-8000-0000000c7a11";
const BUYER = { id: "00000000-0000-4000-8000-0000000a7a01", name: "Buyer" };

const ROWS = [
  {
    kind: "level" as const,
    verb: "create" as const,
    entity: "purchaseorder",
    from: "off" as const,
    to: "approval" as const,
    direction: "looser" as const,
    label: "Create purchase orders: Off → Ask me first",
  },
  {
    kind: "level" as const,
    verb: "create" as const,
    entity: "vendor",
    from: "off" as const,
    to: "approval" as const,
    direction: "looser" as const,
    label: "Create vendors: Off → Ask me first",
  },
];
const REASON =
  "The Buyer sends the POs you approve to QuickBooks, and adds a vendor when a quote comes from someone new.";

const PAYLOAD = {
  requestId: REQ,
  connectionId: CONN,
  connector: "qbo",
  connectorName: "QuickBooks Online",
  rows: ROWS,
  reason: REASON,
  requestedBy: { id: "00000000-0000-4000-8000-00000000d0aa", name: "Ana" },
  forAgent: BUYER,
  expiresAt: "2026-12-04T10:00:00.000Z",
};

function item(o: Record<string, unknown> = {}) {
  return {
    id: ITEM,
    kind: "approval",
    title: "Mezonas asks to change QuickBooks access",
    payload: PAYLOAD,
    status: "open",
    runId: null,
    dueAt: null,
    createdAt: "2026-11-20T10:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
    service: null,
    batchKey: null,
    ...o,
  };
}

const request = (o: Partial<Parameters<typeof changeRequest>[0]> = {}) =>
  changeRequest({
    id: REQ,
    connectionId: CONN,
    rows: ROWS,
    reason: REASON,
    forAgent: BUYER,
    ...o,
  });

function renderAs(
  role: "client_admin" | "client_user",
  items: unknown[],
  routes: Parameters<typeof fakeApi>[0] = {},
) {
  const api = fakeApi({
    "GET /api/session": () => ({
      ...CLIENT_SESSION,
      tenants: [{ id: TENANT, name: "Hartley Millwork", role }],
    }),
    "GET /api/overview": () => new Reply(404, {}),
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/team": () => ({
      members: [
        {
          userId: ME,
          name: "Pat Lee",
          email: "pat@hartley.example.com",
          role,
          canSign: true,
          signs: [],
        },
      ],
      settings: { undoSeconds: 60 },
    }),
    "GET /api/inbox": ({ url }) =>
      url.searchParams.get("status") === "resolved" || url.searchParams.get("view") === "snoozed"
        ? { items: [] }
        : { items },
    "GET /api/portal/connection-requests": () => ({ requests: [request()] }),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={["/inbox"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

const body = (init: RequestInit) => JSON.parse(String(init.body));

describe("a change request in the Inbox", () => {
  it("shows the rows before → after, why, for which agent and who asked; nothing else to sign", async () => {
    renderAs("client_admin", [item()]);
    const card = await screen.findByTestId("inbox-connection-request");
    expect(card).toHaveTextContent("Mezonas asks to change QuickBooks Online access");
    expect(card).toHaveTextContent("For Buyer · asked by Ana, your Mezonas lead");
    expect(within(card).getByTestId("inbox-connection-request-state")).toHaveTextContent(
      "Waiting on you",
    );
    const rows = within(card).getByTestId("inbox-connection-request-rows");
    expect(rows).toHaveTextContent("Create purchase ordersOff→changes toAsk me first");
    expect(rows).toHaveTextContent("Create vendorsOff→changes toAsk me first");
    expect(within(card).getByTestId("inbox-connection-request-reason")).toHaveTextContent(REASON);
    expect(within(card).getByRole("link", { name: "Open QuickBooks Online" })).toHaveAttribute(
      "href",
      `/connectors/qbo?for=${BUYER.id}`,
    );
    // Answered on its own card only: no Sign, Reject or Not now of the Desk's.
    expect(screen.queryByTestId("desk-sign")).toBeNull();
    expect(screen.queryByTestId("desk-actions")).toBeNull();
  });

  it("approves with a note back", async () => {
    const posts: unknown[] = [];
    renderAs("client_admin", [item()], {
      [`POST /api/portal/connection-requests/${REQ}/approve`]: ({ init }) => {
        posts.push(body(init));
        return {
          request: request({ status: "approved" }),
          connection: connectionPage({ id: CONN }),
        };
      },
    });
    const card = await screen.findByTestId("inbox-connection-request");
    await userEvent.click(within(card).getByTestId("inbox-connection-request-add-note"));
    await userEvent.type(within(card).getByTestId("inbox-connection-request-note"), "Go ahead");
    await userEvent.click(within(card).getByTestId("inbox-connection-request-approve"));
    await waitFor(() => expect(posts).toEqual([{ note: "Go ahead" }]));
    expect(await within(card).findByTestId("inbox-connection-request-answered")).toHaveTextContent(
      "Approved by you just now. It shows in QuickBooks Online's history with the request.",
    );
  });

  it("declines: nothing changes, and the lead is told", async () => {
    const posts: unknown[] = [];
    renderAs("client_admin", [item()], {
      [`POST /api/portal/connection-requests/${REQ}/decline`]: ({ init }) => {
        posts.push(body(init));
        return { request: request({ status: "declined" }) };
      },
    });
    const card = await screen.findByTestId("inbox-connection-request");
    await userEvent.click(within(card).getByTestId("inbox-connection-request-decline"));
    await waitFor(() => expect(posts).toEqual([{}]));
    expect(await within(card).findByTestId("inbox-connection-request-answered")).toHaveTextContent(
      "Declined by you just now. Nothing changed; your lead is told.",
    );
  });

  it("says Out of date, with no Approve, when the connection changed since", async () => {
    renderAs("client_admin", [item()], {
      "GET /api/portal/connection-requests": () => ({ requests: [request({ outOfDate: true })] }),
    });
    const card = await screen.findByTestId("inbox-connection-request");
    expect(await within(card).findByTestId("inbox-connection-request-out-of-date")).toBeVisible();
    expect(within(card).getByTestId("inbox-connection-request-state")).toHaveTextContent(
      "Out of date",
    );
    expect(within(card).queryByTestId("inbox-connection-request-approve")).toBeNull();
  });

  it("turns Out of date when approving is refused as out of date", async () => {
    renderAs("client_admin", [item()], {
      [`POST /api/portal/connection-requests/${REQ}/approve`]: () =>
        new Reply(409, { error: { code: "out_of_date", message: "the connection changed" } }),
    });
    const card = await screen.findByTestId("inbox-connection-request");
    await userEvent.click(within(card).getByTestId("inbox-connection-request-approve"));
    expect(await within(card).findByTestId("inbox-connection-request-out-of-date")).toBeVisible();
    expect(within(card).queryByTestId("inbox-connection-request-approve")).toBeNull();
  });

  it("a client user reads it and can't answer", async () => {
    renderAs("client_user", [item()]);
    const card = await screen.findByTestId("inbox-connection-request");
    expect(within(card).queryByTestId("inbox-connection-request-approve")).toBeNull();
    expect(within(card).queryByTestId("inbox-connection-request-decline")).toBeNull();
    expect(within(card).getByTestId("inbox-connection-request-admin-only")).toHaveTextContent(
      "A client admin answers this.",
    );
  });

  it("shows one no longer open as answered, by whom", async () => {
    renderAs("client_admin", [
      item({
        status: "resolved",
        resolvedAt: "2026-11-20T11:00:00.000Z",
        resolvedBy: { id: ME, name: "Pat Lee" },
      }),
    ]);
    const card = await screen.findByTestId("inbox-connection-request");
    expect(within(card).getByTestId("inbox-connection-request-state")).toHaveTextContent(
      "Answered",
    );
    expect(within(card).getByTestId("inbox-connection-request-answered")).toHaveTextContent(
      "Answered by Pat Lee",
    );
    expect(within(card).queryByTestId("inbox-connection-request-approve")).toBeNull();
  });
});

describe("a change we made at once, in the Inbox", () => {
  it("says what changed, why and under which go-ahead, and closes with Done", async () => {
    const resolved: unknown[] = [];
    renderAs(
      "client_admin",
      [
        {
          ...item(),
          id: NOTICE,
          kind: "review",
          title: "Ana changed QuickBooks access",
          payload: {
            connectionId: CONN,
            connector: "qbo",
            connectorName: "QuickBooks Online",
            because: "authorized",
            rows: ROWS.slice(0, 1),
            reason: "The Buyer needs it to send POs.",
            changedBy: { id: "00000000-0000-4000-8000-00000000d0aa", name: "Ana" },
            authorization: {
              choice: "needs",
              until: null,
              setBy: ME,
              setAt: "2026-11-20T09:00:00.000Z",
            },
          },
        },
      ],
      {
        [`POST /api/inbox/${NOTICE}/resolve`]: ({ init }) => {
          resolved.push(body(init));
          return {
            item: {
              ...item(),
              id: NOTICE,
              kind: "review",
              status: "resolved",
              resolvedAt: "2026-11-20T12:00:00.000Z",
              resolvedBy: { id: ME, name: "Pat Lee" },
            },
          };
        },
      },
    );
    const notice = await screen.findByTestId("inbox-connection-notice");
    expect(notice).toHaveTextContent("Ana changed QuickBooks Online under your go-ahead.");
    expect(within(notice).getByTestId("inbox-connection-notice-rows")).toHaveTextContent(
      "Create purchase ordersOff→changes toAsk me first",
    );
    expect(notice).toHaveTextContent("The Buyer needs it to send POs.");
    expect(within(notice).getByTestId("inbox-connection-notice-authorization")).toHaveTextContent(
      /You let Mezonas make changes agents need on QuickBooks Online, /,
    );
    expect(
      within(notice).getByRole("link", { name: "Undo or change it on QuickBooks Online's page" }),
    ).toHaveAttribute("href", "/connectors/qbo");
    await userEvent.click(screen.getByTestId("desk-done"));
    await waitFor(() => expect(resolved).toHaveLength(1));
    expect(resolved[0]).toMatchObject({ decision: "approve" });
  });
});
