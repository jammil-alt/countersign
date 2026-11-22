// Your call in the back office (docs/plan.md §1.124.3; docs/design/pipelines.html `yourCall()`):
// the KPIs, Yours as compact cards that open a side sheet with Reggie's read, plan, why and draft;
// the keys; Do it waits five seconds for Undo before a draft goes; Later; the kind chips and
// search, and the empty states; Reggie's list with Take it; Done today with Flag; and the sidebar's
// places.
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

function setup(opts: { empty?: boolean } = {}) {
  const acted: unknown[] = [];
  const taken: string[] = [];
  const flagged: string[] = [];
  const snoozed: string[] = [];
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    "GET /api/ops/clients": () => ({ clients: [] }),
    "GET /api/ops/counts": () => ({ needsUs: 4, clients: [] }),
    "GET /api/ops/todos": ({ url }) => {
      const out = list(url.searchParams.get("owner") ?? "operator");
      return opts.empty && out.items === yours ? { ...out, items: [] } : out;
    },
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
  it("leads a to-do to the page where it is done", async () => {
    // QA (2026-11-22): "Record Susana Test's agreed price" had only Later and Done; the terms
    // form is on the deal's page.
    const DEAL = "00000000-0000-4000-8000-0000000d0e01";
    const price = todo({
      kind: "sales",
      tag: "New account",
      title: "Record Susana Test's agreed price",
      about: { kind: "deal", id: DEAL, href: `/ops/deals/${DEAL}` },
      read: null,
      plan: [],
      why: { head: "The deal moved on without an agreed price", detail: "" },
      sure: null,
      draft: null,
      primary: null,
      urgency: null,
    });
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({ clients: [] }),
      "GET /api/ops/counts": () => ({ needsUs: 0, clients: [] }),
      "GET /api/ops/todos": ({ url }) => {
        const out = list(url.searchParams.get("owner") ?? "operator");
        return out.items === yours ? { ...out, items: [price] } : { ...out, items: [] };
      },
      "GET /api/ops/todos/done-today": () => ({ groups: [], count: 0 }),
    });
    render(
      <MemoryRouter initialEntries={["/ops/call"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const card = await screen.findByTestId(`call-${T1}`);
    await userEvent.click(within(card).getByTestId("call-open"));
    const sheet = await screen.findByTestId("call-sheet");
    const open = within(sheet).getByTestId("call-open-record");
    expect(open).toHaveTextContent("Open the deal");
    expect(open).toHaveAttribute("href", `/ops/deals/${DEAL}`);
    expect(within(sheet).getByTestId("call-later")).toBeInTheDocument();
    expect(within(sheet).getByTestId("call-done")).toBeInTheDocument();
  });

  it("shows the KPIs and Yours as compact cards; one opens a sheet with Reggie's read, plan, why and draft", async () => {
    setup();
    const page = await screen.findByTestId("ops-call");
    expect(within(page).getByRole("heading", { level: 1, name: "Your call" })).toBeInTheDocument();
    const kpis = await within(page).findByTestId("work-kpis");
    expect(kpis).toHaveTextContent("Need you2");
    expect(kpis).toHaveTextContent("1 due today");
    expect(kpis).toHaveTextContent("Reggie is on1");
    expect(kpis).toHaveTextContent("Questions this week23");
    expect(kpis).toHaveTextContent("Median answer 18 min");
    // The card is compact: tag, title, client, due, the why word, and the one button.
    const card = await screen.findByTestId(`call-${T1}`);
    expect(card).toHaveTextContent("Issue · high");
    expect(card).toHaveTextContent("Hartley Millwork");
    expect(within(card).getByTestId("call-why-word")).toHaveTextContent(
      "Changes how an agent works",
    );
    expect(within(card).getByTestId("call-act")).toHaveTextContent("Approve and send");
    expect(card).not.toHaveTextContent("Reggie's read");
    expect(within(card).queryByTestId("call-draft")).toBeNull();
    expect(within(card).queryByTestId("call-later")).toBeNull();
    // Opened, the sheet has everything and the decisions.
    await userEvent.click(within(card).getByTestId("call-open"));
    const sheet = await screen.findByTestId("call-sheet");
    expect(sheet).toHaveTextContent("Reggie's read");
    expect(within(sheet).getByTestId("call-plan")).toHaveTextContent("Re-check the 11 held bills.");
    expect(within(sheet).getByTestId("call-why")).toHaveTextContent("Changes how an agent works.");
    expect(within(sheet).getByTestId("call-draft")).toHaveTextContent("the bills are right");
    expect(within(sheet).getByRole("link", { name: /Ferguson bills/ })).toHaveAttribute(
      "href",
      `/ops/issues/${ISSUE}`,
    );
    expect(within(sheet).getByTestId("call-act")).toHaveTextContent("Approve and send");
    expect(within(sheet).getByTestId("call-later")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    await userEvent.click(within(sheet).getByTestId("call-sheet-close"));
    expect(screen.queryByTestId("call-sheet")).toBeNull();
    // An escalation is read from its own screen: no Later, its button opens it.
    const esc = screen.getByTestId(`call-${T2}`);
    expect(within(esc).getByTestId("call-act")).toHaveTextContent("Open");
    await userEvent.click(within(esc).getByTestId("call-open"));
    const escSheet = await screen.findByTestId("call-sheet");
    expect(within(escSheet).queryByTestId("call-later")).toBeNull();
    // Its main button already opens it: no second way.
    expect(within(escSheet).queryByTestId("call-open-record")).toBeNull();
    await userEvent.keyboard("{Escape}");
    // The sidebar: Your call with its count, and Work's places.
    expect(await screen.findByTestId("ops-nav-call")).toHaveTextContent("2");
    expect(screen.getByTestId("ops-nav-sales")).toHaveAttribute("href", "/ops/sales");
    expect(screen.getByTestId("ops-nav-build")).toHaveAttribute("href", "/ops/build");
    expect(screen.getByTestId("ops-nav-autopilot")).toHaveAttribute("href", "/ops/autopilot");
  });

  // Staging QA (2026-11-22): switching lists emptied the page to a spinner (the counts read 0 and
  // the scroll went back to the top). The page stays: the KPIs, the lists' counts and the last
  // rows, dimmed, until the other list answers.
  it("keeps the page while another list loads", async () => {
    const { api } = setup();
    await screen.findByTestId(`call-${T1}`);
    let answer: () => void = () => {};
    api.on("GET /api/ops/todos", ({ url }) => {
      const owner = url.searchParams.get("owner") ?? "operator";
      if (owner !== "reggie") return list(owner);
      return new Promise<TodoList>((done) => {
        answer = () => done(list("reggie"));
      });
    });
    await userEvent.click(screen.getByTestId("call-tab-reggie"));
    expect(screen.getByTestId("call-tab-reggie")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("work-kpis")).toHaveTextContent("Need you2");
    expect(screen.getByTestId("call-tab-you")).toHaveTextContent("Yours (2)");
    expect(screen.getByTestId("call-tab-reggie")).toHaveTextContent("(1)");
    const results = screen.getByTestId("call-results");
    expect(results).toHaveAttribute("aria-busy", "true");
    expect(within(results).getByText("Approve the fix for Hartley's Ferguson bills")).toBeVisible();
    await act(async () => answer());
    expect(await screen.findByText("Chase Alder's requirements")).toBeInTheDocument();
    expect(screen.getByTestId("call-results")).not.toHaveAttribute("aria-busy");
    expect(screen.queryByText("Approve the fix for Hartley's Ferguson bills")).toBeNull();
  });

  it("lets the kind chips wrap in the bar instead of cutting them off", async () => {
    setup();
    await screen.findByTestId(`call-${T1}`);
    const chips = within(screen.getByTestId("call-bar")).getByTestId("work-filters");
    expect(chips).toHaveClass("ds-filters", "ui-filters--wrap");
  });

  it("filters by kind and search, and clears them", async () => {
    setup();
    await screen.findByTestId(`call-${T1}`);
    await userEvent.click(screen.getByTestId("work-filter-other"));
    expect(screen.queryByTestId(`call-${T1}`)).toBeNull();
    expect(screen.getByTestId(`call-${T2}`)).toBeInTheDocument();
    // Sales has none of yours: the empty state says so, where the work is, and shows all again.
    await userEvent.click(screen.getByTestId("work-filter-sales"));
    const none = screen.getByTestId("call-nomatch");
    expect(none).toHaveTextContent("No deals need you");
    expect(none).toHaveTextContent("Reggie is on 1 thing, and 0 wait on clients.");
    await userEvent.click(within(none).getByTestId("call-show-all"));
    expect(screen.getByTestId(`call-${T1}`)).toBeInTheDocument();
    expect(screen.getByTestId(`call-${T2}`)).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Search" }), "nothing like it");
    expect(screen.getByTestId("call-nomatch")).toHaveTextContent(
      "Nothing of yours matches “nothing like it”",
    );
    await userEvent.click(screen.getByRole("button", { name: "Show all 2" }));
    expect(screen.getByTestId(`call-${T1}`)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search" })).toHaveValue("");
  });

  it("says you're clear when nothing needs you", async () => {
    setup({ empty: true });
    const empty = await screen.findByTestId("call-empty");
    expect(empty).toHaveTextContent("You're clear");
    expect(empty).toHaveTextContent("Reggie is on 1 thing.");
    await userEvent.click(within(empty).getByTestId("call-see-reggie"));
    expect(await screen.findByTestId("call-reggie")).toHaveTextContent(
      "Chase Alder's requirements",
    );
  });

  it("J and K move between cards, O and Enter open the sheet, E edits, S does it", async () => {
    const s = setup();
    await screen.findByTestId(`call-${T1}`);
    expect(screen.getByTestId(`call-${T1}`)).toHaveAttribute("data-focus", "true");
    await userEvent.keyboard("j");
    expect(screen.getByTestId(`call-${T2}`)).toHaveAttribute("data-focus", "true");
    expect(screen.getByTestId(`call-${T1}`)).not.toHaveAttribute("data-focus");
    await userEvent.keyboard("k");
    expect(screen.getByTestId(`call-${T1}`)).toHaveAttribute("data-focus", "true");
    await userEvent.keyboard("o");
    let sheet = await screen.findByTestId("call-sheet");
    expect(sheet).toHaveTextContent("Ferguson bills");
    // J in the sheet: the sheet follows.
    await userEvent.keyboard("j");
    expect(await screen.findByTestId("call-sheet")).toHaveTextContent(
      "An invoice we couldn't read",
    );
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("call-sheet")).toBeNull();
    // Enter on the focused card opens it.
    await userEvent.keyboard("k");
    await userEvent.keyboard("{Enter}");
    sheet = await screen.findByTestId("call-sheet");
    expect(sheet).toHaveTextContent("Ferguson bills");
    await userEvent.keyboard("{Escape}");
    // E opens the sheet with the draft to edit.
    await userEvent.keyboard("e");
    sheet = await screen.findByTestId("call-sheet");
    expect(within(sheet).getByTestId("call-draft-edit")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    // S does it from the list: the card waits five seconds with Undo.
    await userEvent.keyboard("s");
    expect(within(screen.getByTestId(`call-${T1}`)).getByRole("status")).toHaveTextContent(
      "Sending in 5 seconds.",
    );
    await userEvent.click(
      within(screen.getByTestId(`call-${T1}`)).getByRole("button", { name: "Undo" }),
    );
    expect(s.acted).toEqual([]);
  });

  it("waits five seconds before a draft goes, sends the edited words, and Undo stops it", async () => {
    const s = setup();
    await userEvent.click(within(await screen.findByTestId(`call-${T1}`)).getByTestId("call-open"));
    const card = await screen.findByTestId("call-sheet");
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
    // Done with it: the sheet closes.
    await waitFor(() => expect(screen.queryByTestId("call-sheet")).toBeNull());
    expect(await screen.findByTestId("call-toast")).toHaveTextContent("Sent.");
  });

  it("Later snoozes a to-do", async () => {
    const s = setup();
    await userEvent.click(within(await screen.findByTestId(`call-${T1}`)).getByTestId("call-open"));
    await userEvent.click(
      within(await screen.findByTestId("call-sheet")).getByTestId("call-later"),
    );
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
