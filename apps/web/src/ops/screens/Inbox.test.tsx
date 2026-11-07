// The back-office inbox (Escalations): the operator resolves what the server marks as theirs
// (`resolvableByOperator`), which in the Sandbox is every item; elsewhere a client's own items only
// say who they wait on and for how long. "Needs us" also lists what isn't an item (a stuck
// approval, a failed run) with a link to it; "Waiting on clients" shows the clients' inboxes.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const SANDBOX = "00000000-0000-4000-8000-00000000a001";
const DEMO = "00000000-0000-4000-8000-00000000a002";
const SANDBOX_ITEM = "00000000-0000-4000-8000-0000000f3101";
const DEMO_ITEM = "00000000-0000-4000-8000-0000000f3102";
const DEMO_RUN = "00000000-0000-4000-8000-0000000f3201";

const NONE_NEED_US = { count: 0, escalations: [] };

const stuck = {
  kind: "approval",
  id: DEMO_RUN,
  client: { id: DEMO, name: "Demo client" },
  agent: { id: "00000000-0000-4000-8000-00000000b001", name: "Bill clerk", serviceName: null },
  runId: DEMO_RUN,
  title: "Itemize bill 20418",
  blockedSince: "2026-11-05T10:00:00.000Z",
  wait: {
    on: "client_admin",
    person: null,
    since: "2026-11-05T10:00:00.000Z",
    items: 1,
    nobodyToAct: "not_signed_in",
    emailOff: true,
  },
};

const item = (id: string, tenantId: string, resolvableByOperator: boolean) => ({
  id,
  tenantId,
  kind: "approval",
  agentId: null,
  runId: null,
  subjectType: null,
  subjectId: null,
  assigneeRole: "client_admin",
  assigneeUserId: null,
  title: "Is the record right now?",
  payload: {},
  status: "open",
  resolution: null,
  resolvedBy: null,
  dueAt: null,
  createdAt: "2026-11-05T10:00:00.000Z",
  resolvedAt: null,
  resolvableByOperator,
});

describe("escalations", () => {
  it("lets the operator answer the Sandbox's client-admin items, not a real client's", async () => {
    const resolved: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/inbox": () => ({
        items: [item(SANDBOX_ITEM, SANDBOX, true), item(DEMO_ITEM, DEMO, false)],
        agents: [],
      }),
      "GET /api/ops/needs-us": () => NONE_NEED_US,
      [`POST /api/ops/inbox/${SANDBOX_ITEM}/resolve`]: ({ init }) => {
        resolved.push(JSON.parse(String(init.body)));
        return { item: { ...item(SANDBOX_ITEM, SANDBOX, true), status: "resolved" } };
      },
    });
    render(
      <MemoryRouter initialEntries={["/ops/inbox"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );

    const sandbox = await screen.findByTestId(`inbox-item-${SANDBOX_ITEM}`);
    const demo = screen.getByTestId(`inbox-item-${DEMO_ITEM}`);
    expect(within(demo).queryByTestId("inbox-item-approve")).toBeNull();
    expect(demo).toHaveTextContent(
      /Waiting on the client admin for [^.]+\. Only they can answer it\./,
    );
    expect(sandbox).not.toHaveTextContent("Waiting on");
    await userEvent.click(within(sandbox).getByTestId("inbox-item-approve"));
    expect(resolved).toEqual([{ decision: "approve" }]);
  });

  it("keeps what we just approved on screen with Undo, and takes it back", async () => {
    const undone: string[] = [];
    let open = true;
    const later = new Date(Date.now() + 60_000).toISOString();
    const resolved = {
      ...item(SANDBOX_ITEM, SANDBOX, true),
      status: "resolved",
      resolvedBy: OPERATOR_SESSION.user.id,
      resolution: { decision: "approve" },
      resolvedAt: new Date().toISOString(),
      deliverAfter: later,
    };
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/inbox": () => ({
        items: open ? [item(SANDBOX_ITEM, SANDBOX, true)] : [],
        agents: [],
      }),
      "GET /api/ops/needs-us": () => ({
        count: open ? 1 : 0,
        escalations: open
          ? [
              {
                kind: "item",
                id: SANDBOX_ITEM,
                client: { id: SANDBOX, name: "Sandbox" },
                agent: null,
                runId: null,
                title: "Is the record right now?",
                blockedSince: "2026-11-05T10:00:00.000Z",
              },
            ]
          : [],
      }),
      [`POST /api/ops/inbox/${SANDBOX_ITEM}/resolve`]: () => {
        open = false;
        return { item: resolved };
      },
      [`POST /api/ops/inbox/${SANDBOX_ITEM}/undo`]: () => {
        undone.push(SANDBOX_ITEM);
        open = true;
        return {
          item: {
            id: SANDBOX_ITEM,
            status: "open",
            deliverAfter: null,
            snoozedUntil: null,
            batchKey: null,
            resolvedAt: null,
          },
        };
      },
    });
    render(
      <MemoryRouter initialEntries={["/ops/inbox"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Escalations" })).toBeInTheDocument();
    expect(await screen.findByText("1 thing needs us.")).toBeInTheDocument();
    const card = await screen.findByTestId(`inbox-item-${SANDBOX_ITEM}`);
    await userEvent.click(within(card).getByTestId("inbox-item-approve"));
    const recent = await screen.findByTestId("ops-inbox-recent");
    await userEvent.click(within(recent).getByTestId("inbox-item-undo"));
    await waitFor(() => expect(undone).toEqual([SANDBOX_ITEM]));
    await waitFor(() => expect(screen.queryByTestId("ops-inbox-recent")).toBeNull());
    expect(await screen.findByTestId(`inbox-item-${SANDBOX_ITEM}`)).toBeInTheDocument();
  });

  it("lists what else needs us, and what waits in a client's inbox, from the address", async () => {
    const queries: URLSearchParams[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/inbox": ({ url }) => {
        queries.push(url.searchParams);
        return {
          items:
            url.searchParams.get("assigned") === "all"
              ? [
                  { ...item(DEMO_ITEM, DEMO, false), runId: DEMO_RUN },
                  { ...item(SANDBOX_ITEM, DEMO, true), assigneeRole: "operator" },
                ]
              : [],
          agents: [],
        };
      },
      "GET /api/ops/needs-us": () => ({ count: 1, escalations: [stuck] }),
    });
    const { unmount } = render(
      <MemoryRouter initialEntries={["/ops/inbox"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    // Needs us: a stuck approval is a row that says what, on whom, why, and opens its run.
    const row = await screen.findByTestId(`ops-inbox-needs-${DEMO_RUN}`);
    expect(row).toHaveTextContent("Bill clerk · Demo client");
    expect(row).toHaveTextContent(
      "Waiting for approval · client admin: Itemize bill 20418. Everyone who may approve it is still invited and hasn't signed in.",
    );
    expect(within(row).getByRole("link", { name: "Open run" })).toHaveAttribute(
      "href",
      `/ops/runs/${DEMO_RUN}`,
    );
    expect(screen.getByText("1 thing needs us.")).toBeInTheDocument();
    // One "All clients" control on the page: the top bar's.
    expect(screen.queryByTestId("ops-inbox-client-select")).toBeNull();
    unmount();

    render(
      <MemoryRouter initialEntries={[`/ops/inbox?view=clients&client=${DEMO}`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const card = await screen.findByTestId(`inbox-item-${DEMO_ITEM}`);
    expect(card).toHaveTextContent(
      "Only they can answer it. Everyone who may approve it is still invited and hasn't signed in.",
    );
    // Items for us aren't "waiting on clients".
    expect(screen.queryByTestId(`inbox-item-${SANDBOX_ITEM}`)).toBeNull();
    expect(screen.getByTestId("ops-inbox-view-filter-clients")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(queries.at(-1)?.get("assigned")).toBe("all");
    expect(queries.at(-1)?.get("client")).toBe(DEMO);
    expect(screen.getByTestId("ops-inbox-client")).toBeInTheDocument();
  });

  it("opens a run page's link (assigned=all) on what waits on clients", async () => {
    const queries: URLSearchParams[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/inbox": ({ url }) => {
        queries.push(url.searchParams);
        return { items: [item(DEMO_ITEM, DEMO, false)], agents: [] };
      },
      "GET /api/ops/needs-us": () => NONE_NEED_US,
    });
    render(
      <MemoryRouter initialEntries={[`/ops/inbox?assigned=all&client=${DEMO}`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId(`inbox-item-${DEMO_ITEM}`)).toBeInTheDocument();
    expect(screen.getByTestId("ops-inbox-view-filter-clients")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(queries.at(-1)?.get("assigned")).toBe("all");
    expect(queries.at(-1)?.get("client")).toBe(DEMO);
  });
});
