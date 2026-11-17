// Your call in the back office (docs/plan.md §1.124.3; docs/design/pipelines.html `yourCall()`):
// the KPIs, Yours as cards with Reggie's read, plan, why and draft; Do it waits five seconds for
// Undo before a draft goes; Later; the kind chips and search; Reggie's list with Take it; Done
// today with Flag; and the sidebar's places.
import type { DoneToday, TodoList, TodoView } from "@countersign/core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../../../App";
import { fakeApi, OPERATOR_SESSION } from "../../../test/fixtures";

const at = "2026-11-17T09:00:00.000Z";
const CLIENT = "00000000-0000-4000-8000-00000000a001";
const ISSUE = "00000000-0000-4000-8000-0000000e0001";
const T1 = "00000000-0000-4000-8000-0000000f0001";
const T2 = "00000000-0000-4000-8000-0000000f0002";
const T3 = "00000000-0000-4000-8000-0000000f0003";
const PLAY = "00000000-0000-4000-8000-0000000f0009";

function todo(over: Partial<TodoView>): TodoView {
  return {
    id: T1,
    source: "todo",
    owner: "operator",
    ownerUser: null,
    kind: "issues",
    tag: "Issue · high",
    title: "Approve the fix for Hartley's Ferguson bills",
    detail: "",
    client: { id: CLIENT, name: "Hartley Millwork" },
    about: { kind: "issue", id: ISSUE, href: `/ops/issues/${ISSUE}` },
    dueAt: "2026-11-17T23:59:59.000Z",
    state: "open",
    snoozedUntil: null,
    read: "Ferguson raised copper fittings 4% on Nov 1.",
    plan: ["Reply to Dana with what happened (draft).", "Re-check the 11 held bills."],
    why: { head: "Changes how an agent works", detail: "Updating Pia's prices is a new version." },
    sure: "Sure: the 11 bills all differ by 3.8% to 4.2%.",
    draft: { to: "To Hartley Millwork", text: "Hi Dana, the bills are right.", channel: "portal" },
    form: null,
    options: null,
    primary: { label: "Approve and send", kind: "send_reply" },
    alt: null,
    critical: false,
    urgency: "high",
    editable: true,
    createdAt: at,
    ...over,
  };
}

const yours = [
  todo({}),
  todo({
    id: T2,
    source: "escalation",
    kind: "other",
    tag: "Escalation",
    title: "An invoice we couldn't read",
    read: null,
    plan: [],
    why: { head: "Waiting on us", detail: "An agent brought this to a person." },
    sure: null,
    draft: null,
    primary: { label: "Open", kind: "open" },
    about: { kind: "inbox", id: T2, href: "/ops/inbox" },
    editable: false,
    urgency: null,
  }),
];
const reggies = [
  todo({
    id: T3,
    owner: "reggie",
    tag: "Agent build",
    kind: "builds",
    title: "Chase Alder's requirements",
    about: null,
    draft: null,
    primary: null,
  }),
];

function list(owner: string): TodoList {
  return {
    items: owner === "reggie" ? reggies : owner === "client" ? [] : yours,
    counts: {
      yours: 2,
      reggie: 1,
      client: 0,
      doneToday: 1,
      dueToday: 1,
      criticalHeld: 0,
      lateClient: 0,
      questionsWeek: 23,
      medianAnswerMinutes: 18,
    },
    holds: [],
    today: "2026-11-17",
  };
}

const doneToday: DoneToday = {
  groups: [
    {
      flow: "issues",
      name: "Issues",
      rows: [
        {
          id: PLAY,
          at,
          summary: "Told Hartley we have issue #1042.",
          sent: true,
          edited: false,
          client: { id: CLIENT, name: "Hartley Millwork" },
          href: `/ops/issues/${ISSUE}`,
          flagged: false,
        },
      ],
    },
  ],
  count: 1,
};

function setup() {
  const acted: unknown[] = [];
  const taken: string[] = [];
  const flagged: string[] = [];
  const snoozed: string[] = [];
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    "GET /api/ops/clients": () => ({ clients: [] }),
    "GET /api/ops/counts": () => ({ needsUs: 4, clients: [] }),
    "GET /api/ops/todos": ({ url }) => list(url.searchParams.get("owner") ?? "operator"),
    [`POST /api/ops/todos/${T1}/act`]: ({ init }) => {
      acted.push(JSON.parse(String(init.body)));
      return { todo: { ...yours[0], state: "done" }, done: "Sent.", href: null };
    },
    [`POST /api/ops/todos/${T1}/snooze`]: () => {
      snoozed.push(T1);
      return { ...yours[0], state: "snoozed" };
    },
    [`POST /api/ops/todos/${T3}/take`]: () => {
      taken.push(T3);
      return { ...reggies[0], owner: "operator" };
    },
    "GET /api/ops/todos/done-today": () => doneToday,
    [`POST /api/ops/play-log/${PLAY}/flag`]: () => {
      flagged.push(PLAY);
      return { ok: true };
    },
  });
  render(
    <MemoryRouter initialEntries={["/ops/call"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, acted, taken, flagged, snoozed };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Your call", () => {
  it("shows the KPIs and Yours as cards, with Reggie's read, plan, why and draft", async () => {
    setup();
    const page = await screen.findByTestId("ops-call");
    expect(within(page).getByRole("heading", { level: 1, name: "Your call" })).toBeInTheDocument();
    const kpis = await within(page).findByTestId("work-kpis");
    expect(kpis).toHaveTextContent("Need you2");
    expect(kpis).toHaveTextContent("1 due today");
    expect(kpis).toHaveTextContent("Reggie is on1");
    expect(kpis).toHaveTextContent("Questions this week23");
    expect(kpis).toHaveTextContent("Median answer 18 min");
    const card = await screen.findByTestId(`call-${T1}`);
    expect(card).toHaveTextContent("Issue · high");
    expect(card).toHaveTextContent("Reggie's read");
    expect(within(card).getByTestId("call-plan")).toHaveTextContent("Re-check the 11 held bills.");
    expect(within(card).getByTestId("call-why")).toHaveTextContent("Changes how an agent works.");
    expect(within(card).getByTestId("call-draft")).toHaveTextContent("the bills are right");
    expect(within(card).getByRole("link", { name: /Ferguson bills/ })).toHaveAttribute(
      "href",
      `/ops/issues/${ISSUE}`,
    );
    // An escalation is read from its own screen: no Later, its button opens it.
    const esc = screen.getByTestId(`call-${T2}`);
    expect(within(esc).queryByTestId("call-later")).toBeNull();
    expect(within(esc).getByTestId("call-act")).toHaveTextContent("Open");
    // The sidebar: Your call with its count, and Work's places.
    expect(await screen.findByTestId("ops-nav-call")).toHaveTextContent("2");
    expect(screen.getByTestId("ops-nav-sales")).toHaveAttribute("href", "/ops/sales");
    expect(screen.getByTestId("ops-nav-build")).toHaveAttribute("href", "/ops/build");
    expect(screen.getByTestId("ops-nav-autopilot")).toHaveAttribute("href", "/ops/autopilot");
  });

  it("filters by kind and search, and clears them", async () => {
    setup();
    await screen.findByTestId(`call-${T1}`);
    await userEvent.click(screen.getByTestId("work-filter-other"));
    expect(screen.queryByTestId(`call-${T1}`)).toBeNull();
    expect(screen.getByTestId(`call-${T2}`)).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Search" }), "nothing like it");
    expect(screen.getByText("Nothing matches.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear the filters" }));
    expect(screen.getByTestId(`call-${T1}`)).toBeInTheDocument();
  });

  it("waits five seconds before a draft goes, sends the edited words, and Undo stops it", async () => {
    const s = setup();
    const card = await screen.findByTestId(`call-${T1}`);
    await userEvent.click(within(card).getByRole("button", { name: "Edit" }));
    const box = within(card).getByTestId("call-draft-edit");
    await userEvent.clear(box);
    await userEvent.type(box, "Hi Dana, we're on it.");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await userEvent.click(within(card).getByTestId("call-act"));
    expect(within(card).getByRole("status")).toHaveTextContent("Sending in 5 seconds.");
    // Undo: nothing goes.
    await userEvent.click(within(card).getByRole("button", { name: "Undo" }));
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(s.acted).toEqual([]);
    // Again, and let it go.
    await userEvent.click(within(card).getByTestId("call-act"));
    await act(async () => {
      vi.advanceTimersByTime(5100);
    });
    await waitFor(() => expect(s.acted).toEqual([{ draftText: "Hi Dana, we're on it." }]));
    expect(await screen.findByTestId("call-toast")).toHaveTextContent("Sent.");
  });

  it("Later snoozes a to-do", async () => {
    const s = setup();
    const card = await screen.findByTestId(`call-${T1}`);
    await userEvent.click(within(card).getByTestId("call-later"));
    await waitFor(() => expect(s.snoozed).toEqual([T1]));
  });

  it("lists Reggie's as a table, and Take it makes one yours", async () => {
    const s = setup();
    await screen.findByTestId(`call-${T1}`);
    await userEvent.click(screen.getByTestId("call-tab-reggie"));
    const table = await screen.findByTestId("call-reggie");
    expect(table).toHaveTextContent("Chase Alder's requirements");
    expect(table).toHaveTextContent("Agent build");
    await userEvent.click(within(table).getByTestId(`call-take-${T3}`));
    await waitFor(() => expect(s.taken).toEqual([T3]));
  });

  it("shows what Reggie did today, and a flag goes on the play's record", async () => {
    const s = setup();
    await screen.findByTestId(`call-${T1}`);
    await userEvent.click(screen.getByTestId("call-tab-done"));
    const done = await screen.findByTestId("call-done-today");
    expect(done).toHaveTextContent("Told Hartley we have issue #1042.");
    expect(done).toHaveTextContent("Sent");
    await userEvent.click(within(done).getByTestId(`call-flag-${PLAY}`));
    await waitFor(() => expect(s.flagged).toEqual([PLAY]));
  });
});
