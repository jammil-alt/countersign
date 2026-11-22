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

// QA (2026-11-22): an approval escalation is named by its oldest item, and lists its items.
const stuck = {
  kind: "approval",
  id: DEMO_ITEM,
  itemIds: [DEMO_ITEM],
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

/** Opens an item's row and returns its card in the side sheet. */
async function openItem(id: string): Promise<HTMLElement> {
  await userEvent.click(await screen.findByTestId(`ops-inbox-row-${id}-open`));
  const sheet = await screen.findByTestId("ops-inbox-sheet");
  return within(sheet).getByTestId(`inbox-item-${id}`);
}

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

    // Feedback (2026-11-15): each item is a compact row; the row opens its card in a side sheet.
    const demoRow = await screen.findByTestId(`ops-inbox-row-${DEMO_ITEM}`);
    expect(demoRow).toHaveTextContent(/Waiting on the client admin for/);
    expect(within(demoRow).getByTestId(`ops-inbox-row-${DEMO_ITEM}-status`)).toHaveTextContent(
      "Waiting",
    );
    expect(screen.queryByTestId(`inbox-item-${DEMO_ITEM}`)).toBeNull();
    const demo = await openItem(DEMO_ITEM);
    expect(within(demo).queryByTestId("inbox-item-approve")).toBeNull();
    expect(demo).toHaveTextContent(
      /Waiting on the client admin for [^.]+\. Only they can answer it\./,
    );
    await userEvent.click(screen.getByTestId("ops-inbox-sheet-close"));
    expect(screen.queryByTestId("ops-inbox-sheet")).toBeNull();
    const sandbox = await openItem(SANDBOX_ITEM);
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
    expect(
      await screen.findByText(
        "1 thing needs us: work blocked until we act. Your to-dos, builds and held runs are on Your call.",
      ),
    ).toBeInTheDocument();
    const card = await openItem(SANDBOX_ITEM);
    await userEvent.click(within(card).getByTestId("inbox-item-approve"));
    // The sheet stays open on what was just approved, with its Undo; the row is under Just resolved.
    const recent = await screen.findByTestId("ops-inbox-recent");
    expect(within(recent).getByTestId(`ops-inbox-row-${SANDBOX_ITEM}`)).toBeInTheDocument();
    const sheet = screen.getByTestId("ops-inbox-sheet");
    // Nothing needs us now: said once, where the urgency figures were.
    expect(
      await screen.findByText(
        "Nothing needs us. Your to-dos, builds and held runs are on Your call.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("ops-inbox-clear")).toBeInTheDocument();
    expect(screen.getAllByText("Nothing needs us")).toHaveLength(1);
    await userEvent.click(within(sheet).getByTestId("inbox-item-undo"));
    await waitFor(() => expect(undone).toEqual([SANDBOX_ITEM]));
    await waitFor(() => expect(screen.queryByTestId("ops-inbox-recent")).toBeNull());
    expect(await screen.findByTestId(`ops-inbox-row-${SANDBOX_ITEM}`)).toBeInTheDocument();
    // Undo puts it back in Needs us too (review of #257): the count is asked again.
    expect(
      await screen.findByText(
        "1 thing needs us: work blocked until we act. Your to-dos, builds and held runs are on Your call.",
      ),
    ).toBeInTheDocument();
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
    // Needs us: a stuck approval is a row that says what, on whom, why, and opens its item.
    const row = await screen.findByTestId(`ops-inbox-needs-${DEMO_ITEM}`);
    expect(row).toHaveTextContent("Bill clerk · Demo client");
    expect(row).toHaveTextContent(
      "Waiting for approval · client admin: Itemize bill 20418. Everyone who may approve it is still invited and hasn't signed in.",
    );
    expect(within(row).getByRole("link", { name: "Open item" })).toHaveAttribute(
      "href",
      `/ops/inbox?view=clients&client=${DEMO}&item=${DEMO_ITEM}`,
    );
    // The avatar leads the row; the chip carries the date the wait began.
    expect(row.firstElementChild).toHaveClass("ui-agentbadge");
    expect(within(row).getByTestId(`ops-inbox-needs-${DEMO_ITEM}-since`)).toHaveTextContent(
      /^Since 5 Nov, \d\d:\d\d$/,
    );
    // Urgency figures: it has waited days, so it is urgent, with its date; a level filters.
    const urgent = screen.getByTestId("ops-inbox-urgency-urgent");
    expect(urgent).toHaveTextContent("Urgent · Over 2 days");
    expect(urgent).toHaveTextContent(/Oldest since 5 Nov/);
    expect(screen.getByTestId("ops-inbox-urgency-high")).toHaveTextContent("None waiting");
    await userEvent.click(screen.getByTestId("ops-inbox-urgency-high"));
    await waitFor(() => expect(screen.queryByTestId(`ops-inbox-needs-${DEMO_ITEM}`)).toBeNull());
    expect(screen.getByTestId("ops-inbox-urgency")).toHaveTextContent("urgency High");
    await userEvent.click(screen.getByTestId("ops-inbox-urgency-high"));
    expect(await screen.findByTestId(`ops-inbox-needs-${DEMO_ITEM}`)).toBeInTheDocument();
    expect(
      screen.getByText(
        "1 thing needs us: work blocked until we act. Your to-dos, builds and held runs are on Your call.",
      ),
    ).toBeInTheDocument();
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
    await screen.findByTestId(`ops-inbox-row-${DEMO_ITEM}`);
    // Items for us aren't "waiting on clients".
    expect(screen.queryByTestId(`ops-inbox-row-${SANDBOX_ITEM}`)).toBeNull();
    const card = await openItem(DEMO_ITEM);
    // Nobody there can act on it, so it doesn't say only they can.
    expect(card).toHaveTextContent(
      /Waiting on the client admin for \d+ days\. Everyone who may approve it is still invited and hasn't signed in\./,
    );
    expect(card).not.toHaveTextContent("Only they can answer it.");
    expect(screen.getByTestId("ops-inbox-view-filter-clients")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(queries.at(-1)?.get("assigned")).toBe("all");
    expect(queries.at(-1)?.get("client")).toBe(DEMO);
    expect(screen.getByTestId("ops-inbox-client")).toBeInTheDocument();
  });

  it("hands its Needs us to the frame's badge, which asks for no counts of its own", async () => {
    // docs/audit-plan.md 2.3: Escalations and the frame count Needs us once.
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/inbox": () => ({ items: [], agents: [] }),
      "GET /api/ops/needs-us": () => ({ count: 1, escalations: [stuck] }),
      "GET /api/ops/counts": () => ({ needsUs: 1, clients: [] }),
    });
    const { unmount } = render(
      <MemoryRouter initialEntries={["/ops/inbox"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    await screen.findByTestId(`ops-inbox-needs-${DEMO_ITEM}`);
    await waitFor(() =>
      expect(screen.getByTestId("ops-nav-inbox")).toHaveTextContent("Escalations1"),
    );
    expect(api.calls).not.toContain("GET /api/ops/counts");
    expect(api.calls.filter((c) => c === "GET /api/ops/needs-us")).toHaveLength(1);
    unmount();

    // Narrowed to one client, its count is not the total: the frame asks for its own.
    render(
      <MemoryRouter initialEntries={[`/ops/inbox?client=${DEMO}`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    await screen.findByTestId(`ops-inbox-needs-${DEMO_ITEM}`);
    await waitFor(() => expect(api.calls).toContain("GET /api/ops/counts"));
  });

  it("keeps the list on screen, dimmed, while Resolved loads", async () => {
    // docs/audit-plan.md 1.8: a filter answers at once.
    let answer: (v: unknown) => void = () => {};
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/inbox": () => ({ items: [item(SANDBOX_ITEM, SANDBOX, true)], agents: [] }),
      "GET /api/ops/needs-us": () => NONE_NEED_US,
    });
    render(
      <MemoryRouter initialEntries={["/ops/inbox"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    await screen.findByTestId(`ops-inbox-row-${SANDBOX_ITEM}`);
    api.on("GET /api/ops/inbox", () => new Promise((resolve) => (answer = resolve)));
    await userEvent.click(screen.getByTestId("ops-inbox-filter-resolved"));
    expect(screen.getByTestId("ops-inbox-list")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId(`ops-inbox-row-${SANDBOX_ITEM}`)).toBeInTheDocument();
    answer({ items: [], agents: [] });
    expect(await screen.findByText("Nothing resolved yet")).toBeInTheDocument();

    // Back to Open: its stored answer shows at once, not dimmed, while it refreshes behind.
    api.on("GET /api/ops/inbox", () => new Promise(() => {}));
    await userEvent.click(screen.getByTestId("ops-inbox-filter-open"));
    const list = await screen.findByTestId("ops-inbox-list");
    expect(list).not.toHaveAttribute("aria-busy");
    expect(list).not.toHaveAttribute("inert");
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
    expect(await screen.findByTestId(`ops-inbox-row-${DEMO_ITEM}`)).toBeInTheDocument();
    expect(screen.getByTestId("ops-inbox-view-filter-clients")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(queries.at(-1)?.get("assigned")).toBe("all");
    expect(queries.at(-1)?.get("client")).toBe(DEMO);
  });

  // P-6 (docs/plan.md §1.68): a client's item is theirs; we step in only with a reason.
  it("steps in on a client's item with a reason, never on a request for a code", async () => {
    const sent: unknown[] = [];
    const CODE_ITEM = "00000000-0000-4000-8000-0000000f3103";
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/inbox": () => ({
        items: [
          item(DEMO_ITEM, DEMO, false),
          { ...item(CODE_ITEM, DEMO, false), kind: "request", subjectType: "access_release" },
        ],
        agents: [],
      }),
      "GET /api/ops/needs-us": () => NONE_NEED_US,
      [`POST /api/ops/clients/${DEMO}/inbox/${DEMO_ITEM}/step-in`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return {
          item: {
            id: DEMO_ITEM,
            status: "resolved",
            assigneeRole: "client_admin",
            assigneeUserId: null,
            resolvedAt: "2026-11-05T11:00:00.000Z",
            deliverAfter: null,
            steppedIn: { action: "approve", reason: "Away today", at: "2026-11-05T11:00:00.000Z" },
          },
        };
      },
    });
    render(
      <MemoryRouter initialEntries={["/ops/inbox?view=clients"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    await openItem(CODE_ITEM);
    expect(screen.queryByTestId(`step-in-${CODE_ITEM}-open`)).toBeNull();
    await userEvent.click(screen.getByTestId("ops-inbox-sheet-close"));
    await openItem(DEMO_ITEM);
    await userEvent.click(screen.getByTestId(`step-in-${DEMO_ITEM}-open`));
    const approve = screen.getByTestId(`step-in-${DEMO_ITEM}-approve`);
    expect(approve).toBeDisabled();
    await userEvent.type(screen.getByTestId(`step-in-${DEMO_ITEM}-reason`), "Away today");
    await userEvent.click(approve);
    await waitFor(() => expect(sent).toEqual([{ action: "approve", reason: "Away today" }]));
  });

  // QA (2026-11-22): "Open item" opens that item; a reminder about items isn't one.
  it("opens the item a link names, marks it in the list, and leaves out the supervisor's reminders", async () => {
    const OTHER_ITEM = "00000000-0000-4000-8000-0000000f3104";
    const REMINDER = "00000000-0000-4000-8000-0000000f3105";
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/inbox": () => ({
        items: [
          item(DEMO_ITEM, DEMO, false),
          { ...item(OTHER_ITEM, DEMO, false), title: "Add Dana Reyes to the directory" },
          {
            ...item(REMINDER, DEMO, false),
            kind: "review",
            subjectType: "supervisor_finding",
            title: "1 item is still waiting for you",
            payload: { fingerprint: "waiting_long" },
          },
        ],
        agents: [],
      }),
      "GET /api/ops/needs-us": () => ({
        count: 1,
        escalations: [{ ...stuck, itemIds: [DEMO_ITEM, OTHER_ITEM], runId: null }],
      }),
    });
    const { unmount } = render(
      <MemoryRouter initialEntries={[`/ops/inbox?view=clients&client=${DEMO}&item=${OTHER_ITEM}`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const sheet = await screen.findByTestId("ops-inbox-sheet");
    expect(within(sheet).getByTestId(`inbox-item-${OTHER_ITEM}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ops-inbox-row-${OTHER_ITEM}`)).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByTestId(`ops-inbox-row-${DEMO_ITEM}`)).not.toHaveAttribute("aria-current");
    expect(screen.queryByTestId(`ops-inbox-row-${REMINDER}`)).toBeNull();
    unmount();

    // Several of a client's items in one escalation: its link marks them all, opening none.
    render(
      <MemoryRouter initialEntries={[`/ops/inbox?view=clients&client=${DEMO}&stuck=${DEMO_ITEM}`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    for (const id of [DEMO_ITEM, OTHER_ITEM]) {
      expect(await screen.findByTestId(`ops-inbox-row-${id}`)).toHaveAttribute(
        "aria-current",
        "true",
      );
    }
    expect(screen.queryByTestId("ops-inbox-sheet")).toBeNull();
  });

  it("handles similar items together: ours with a decision each, a client's only by stepping in", async () => {
    const ids = [1, 2, 3].map((n) => `00000000-0000-4000-8000-0000000f330${n}`);
    const like = (id: string, n: number, mine: boolean) => ({
      ...item(id, mine ? SANDBOX : DEMO, mine),
      kind: "review",
      agentId: "00000000-0000-4000-8000-00000000b001",
      subjectType: "directory_suggestion",
      title: `Add person ${n} to the directory`,
    });
    const resolved: { id: string; body: unknown }[] = [];
    const steppedIn: { id: string; body: unknown }[] = [];
    const handlers: Record<string, (r: { url: URL; init: RequestInit }) => unknown> = {
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/needs-us": () => NONE_NEED_US,
    };
    for (const id of ids) {
      handlers[`POST /api/ops/inbox/${id}/resolve`] = ({ init }) => {
        resolved.push({ id, body: JSON.parse(String(init.body)) });
        return { item: { ...like(id, 0, true), status: "resolved" } };
      };
      handlers[`POST /api/ops/clients/${DEMO}/inbox/${id}/step-in`] = ({ init }) => {
        steppedIn.push({ id, body: JSON.parse(String(init.body)) });
        return {
          item: {
            id,
            status: "resolved",
            assigneeRole: "client_admin",
            assigneeUserId: null,
            resolvedAt: "2026-11-05T11:00:00.000Z",
            deliverAfter: null,
            steppedIn: { action: "approve", reason: "Asked us", at: "2026-11-05T11:00:00.000Z" },
          },
        };
      };
    }
    // Ours (the Sandbox's): approve the ticked ones, each with its own decision.
    const api = fakeApi({
      ...handlers,
      "GET /api/ops/inbox": () => ({
        items: ids.map((id, n) => like(id, n, true)),
        agents: [],
      }),
    });
    const { unmount } = render(
      <MemoryRouter initialEntries={["/ops/inbox"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const group = await screen.findByTestId(`ops-inbox-similar-${ids[0]}`);
    expect(group).toHaveTextContent('3 items like "Add person 0 to the directory"');
    await userEvent.click(within(group).getByRole("button", { name: "Handle together" }));
    const sheet = await screen.findByTestId("ops-inbox-bulk");
    await userEvent.click(within(sheet).getByTestId(`ops-inbox-bulk-${ids[2]}`));
    await userEvent.click(within(sheet).getByTestId("ops-inbox-bulk-approve"));
    await waitFor(() =>
      expect(resolved).toEqual([
        { id: ids[0], body: { decision: "approve" } },
        { id: ids[1], body: { decision: "approve" } },
      ]),
    );
    await waitFor(() => expect(screen.queryByTestId("ops-inbox-bulk")).toBeNull());
    unmount();

    // A client's: only with a reason, each through stepping in.
    api.on("GET /api/ops/inbox", () => ({
      items: ids.map((id, n) => like(id, n, false)),
      agents: [],
    }));
    render(
      <MemoryRouter initialEntries={["/ops/inbox?view=clients"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const theirs = await screen.findByTestId(`ops-inbox-similar-${ids[0]}`);
    expect(theirs).toHaveTextContent("the client's to answer");
    await userEvent.click(within(theirs).getByRole("button", { name: "Handle together" }));
    const reject = await screen.findByTestId("ops-inbox-bulk-reject");
    expect(reject).toHaveTextContent("Reject 3 for them");
    expect(reject).toBeDisabled();
    await userEvent.type(screen.getByTestId("ops-inbox-bulk-reason"), "Asked us");
    await userEvent.click(reject);
    await waitFor(() =>
      expect(steppedIn).toEqual(
        ids.map((id) => ({ id, body: { action: "reject", reason: "Asked us" } })),
      ),
    );
  });
});
