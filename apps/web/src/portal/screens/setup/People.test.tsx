// Getting started's overview and Your people (docs/setup-plan.md §2, §4.2; docs/plan.md §1.199):
// each agent's line of what is left with who it waits on, the chapters; a seat's "We think" said
// yes to, a seat changed with a backup, a viewer refused in words, and Looks right.
import type { GettingStartedView, PeopleChapterView } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../../App";
import { CLIENT_SESSION, fakeApi, Reply } from "../../../test/fixtures";

const SLOW = 15_000;
const AGENT = "00000000-0000-4000-8000-0000000a0001";
const DANA = "00000000-0000-4000-8000-00000000d001";
const LUIS = "00000000-0000-4000-8000-00000000d002";
const MARK = "00000000-0000-4000-8000-00000000d003";

const OVERVIEW: GettingStartedView = {
  agents: [
    {
      agentId: AGENT,
      name: "Bill clerk",
      description: "Reads bills and makes draft bills in QuickBooks.",
      stage: "bench",
      left: [
        {
          key: "seat:bill-approver",
          chapter: "people",
          label: "Approves bills",
          who: { userId: DANA, name: "Dana Ruiz", me: true },
        },
        {
          key: "tool:gmail",
          chapter: "tools",
          label: "Connect Gmail",
          who: { userId: MARK, name: "Mark Lee", me: false },
        },
      ],
    },
  ],
  chapters: [
    { key: "business", state: "done", done: 6, total: 6 },
    { key: "tools", state: "open", done: 1, total: 2 },
    { key: "people", state: "open", done: 1, total: 2 },
    { key: "see", state: "not_started", done: 0, total: 1 },
    { key: "live", state: "not_started", done: 0, total: 1 },
  ],
  lead: { name: "Ana Navarro" },
  minutesLeft: 4,
};

const member = (userId: string, name: string, over = {}) => ({
  userId,
  name,
  email: `${name.split(" ")[0]?.toLowerCase()}@hartley.example.com`,
  role: "client_user" as const,
  canSign: true,
  joined: true,
  me: false,
  ...over,
});

function people(over: Partial<PeopleChapterView> = {}): PeopleChapterView {
  return {
    seats: [
      {
        role: "bill-approver",
        label: "Approves bills over $5,000",
        kind: "signs",
        description: "",
        required: true,
        agents: [{ id: AGENT, name: "Bill clerk" }],
        userIds: [],
        backupUserIds: [],
        contactIds: [],
        weThink: { userIds: [LUIS], from: "Luis signs anything over five grand" },
        filled: false,
      },
      {
        role: "job-codes",
        label: "Answers questions about job codes",
        kind: "answers",
        description: "",
        required: false,
        agents: [{ id: AGENT, name: "Bill clerk" }],
        userIds: [MARK],
        backupUserIds: [],
        contactIds: [],
        weThink: null,
        filled: true,
      },
    ],
    members: [
      member(DANA, "Dana Ruiz", { role: "client_admin", me: true }),
      member(LUIS, "Luis Ortega", { joined: false }),
      member(MARK, "Mark Lee"),
    ],
    contacts: [],
    canEdit: true,
    confirmed: null,
    ...over,
  };
}

function setup(path: string, view = people()) {
  const sent: { route: string; body: unknown }[] = [];
  let current = view;
  const api = fakeApi({
    "GET /api/session": () => CLIENT_SESSION,
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/intake": () => ({ intake: null }),
    "GET /api/setup": () => ({ agents: [] }),
    "GET /api/getting-started": () => OVERVIEW,
    "GET /api/getting-started/people": () => ({ people: current }),
    "PUT /api/getting-started/people/bill-approver": ({ init }) => {
      const body = JSON.parse(String(init.body));
      sent.push({ route: "seat", body });
      current = people({
        seats: current.seats.map((s) =>
          s.role === "bill-approver"
            ? {
                ...s,
                ...body,
                backupUserIds: body.backupUserIds ?? [],
                weThink: null,
                filled: true,
              }
            : s,
        ),
      });
      return { people: current };
    },
    "POST /api/getting-started/people/confirm": () => {
      sent.push({ route: "confirm", body: null });
      current = { ...current, confirmed: { byName: "Dana Ruiz", at: "2026-11-22T10:00:00.000Z" } };
      return { people: current };
    },
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, sent };
}

describe("Getting started's overview", () => {
  it("shows each agent's line of what is left, who it waits on, and the chapters", async () => {
    setup("/start");
    const agent = await screen.findByTestId(`start-agent-${AGENT}`);
    expect(agent).toHaveTextContent("Bill clerk");
    expect(agent).toHaveTextContent("2 left");
    expect(within(agent).getByTestId("start-left-seat:bill-approver")).toHaveTextContent(
      "Approves bills · you",
    );
    expect(within(agent).getByTestId("start-left-tool:gmail")).toHaveTextContent(
      "Connect Gmail · Mark Lee",
    );
    expect(within(agent).getByTestId("start-left-seat:bill-approver")).toHaveAttribute(
      "href",
      "/getting-started/people",
    );
    expect(screen.getByTestId("start-chapter-business")).toHaveTextContent("Done");
    expect(screen.getByTestId("start-chapter-tools")).toHaveTextContent("1 of 2");
    expect(screen.getByTestId("start-chapter-see")).toHaveTextContent("Not started");
    expect(screen.getByTestId("start-minutes")).toHaveTextContent("About 4 minutes left");
  });
});

describe("Your people", () => {
  it(
    "says yes to what we think, then Looks right",
    async () => {
      const { sent } = setup("/getting-started/people");
      const seat = await screen.findByTestId("start-seat-bill-approver");
      expect(within(seat).getByTestId("start-seat-bill-approver-we-think")).toHaveTextContent(
        "We think: Luis Ortega, from your answer “Luis signs anything over five grand”.",
      );
      expect(seat).toHaveTextContent("To check");
      await userEvent.click(within(seat).getByRole("button", { name: "Yes" }));
      await waitFor(() => expect(sent[0]).toEqual({ route: "seat", body: { userIds: [LUIS] } }));
      await waitFor(() => expect(seat).toHaveTextContent("Checked"));
      // Luis hasn't signed in yet: said in words.
      expect(seat).toHaveTextContent("Invited, hasn't signed in yet");
      await userEvent.click(screen.getByTestId("start-people-looks-right"));
      expect(await screen.findByTestId("start-people-confirmed")).toHaveTextContent(
        "Checked by Dana Ruiz",
      );
    },
    SLOW,
  );

  it(
    "changes a seat that signs, with a backup",
    async () => {
      const { sent } = setup("/getting-started/people");
      const seat = await screen.findByTestId("start-seat-bill-approver");
      await userEvent.click(within(seat).getByRole("button", { name: "Change" }));
      const editor = await screen.findByTestId("start-seat-bill-approver-editor");
      await userEvent.click(within(editor).getByRole("button", { name: "Remove Luis Ortega" }));
      await userEvent.selectOptions(screen.getByTestId("start-seat-bill-approver-add"), DANA);
      await userEvent.selectOptions(screen.getByTestId("start-seat-bill-approver-backup"), MARK);
      await userEvent.click(screen.getByTestId("start-seat-bill-approver-save"));
      await waitFor(() =>
        expect(sent[0]).toEqual({
          route: "seat",
          body: { userIds: [DANA], backupUserIds: [MARK] },
        }),
      );
    },
    SLOW,
  );

  it(
    "explains a viewer can't approve",
    async () => {
      const { api } = setup("/getting-started/people");
      api.on(
        "PUT /api/getting-started/people/bill-approver",
        () =>
          new Reply(422, {
            error: { code: "not_a_signer", message: "That person can only view." },
          }),
      );
      const seat = await screen.findByTestId("start-seat-bill-approver");
      await userEvent.click(within(seat).getByRole("button", { name: "Yes" }));
      expect(await screen.findByText(/can view only, so they can't approve/)).toBeInTheDocument();
    },
    SLOW,
  );

  it("reads only, for someone who isn't the admin", async () => {
    setup("/getting-started/people", people({ canEdit: false }));
    const seat = await screen.findByTestId("start-seat-bill-approver");
    expect(screen.getByText("Your admin fills these seats.")).toBeInTheDocument();
    expect(within(seat).queryByRole("button", { name: "Yes" })).toBeNull();
    expect(screen.queryByTestId("start-people-looks-right")).toBeNull();
  });
});
