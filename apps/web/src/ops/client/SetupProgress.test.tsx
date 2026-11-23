// The Setup tab's Progress (docs/setup-plan.md §8; docs/plan.md §1.206, SU6): the KPI boxes, the
// board with who each cell waits on, Waiting on with Nudge and its result, the change asks linked
// to their request, the runbook, Do it on a call saving the open intake's answers, and Start trial
// off while anything holds it, else the existing Turn on.
import type { OpsIntakeView, OpsSetupBoard, TurnOnAnswer } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { AGENT_SUMMARY, fakeApi, OPERATOR_SESSION, SANDBOX_DETAIL } from "../../test/fixtures";

const SLOW = 15_000;
const CLIENT = SANDBOX_DETAIL.client.id;
const BILLS = AGENT_SUMMARY.id;
const CONTRACTS = "00000000-0000-4000-8000-00000000b002";
const DANA = "00000000-0000-4000-8000-00000000d002";
const ISSUE = "00000000-0000-4000-8000-0000000e0001";
const INTAKE = "00000000-0000-4000-8000-0000000f0001";

const DETAIL = {
  ...SANDBOX_DETAIL,
  client: { ...SANDBOX_DETAIL.client, name: "Hartley Millwork" },
  agents: [
    { ...AGENT_SUMMARY, name: "Bill clerk", stage: "bench" },
    { ...AGENT_SUMMARY, id: CONTRACTS, slug: "contracts", name: "Vendor contracts" },
  ],
};

const cells = (over: Record<string, Partial<OpsSetupBoard["agents"][number]["cells"][number]>>) =>
  (["business", "tools", "people", "see", "live"] as const).map((chapter) => ({
    chapter,
    state: "done" as const,
    waitingOn: null,
    note: null,
    ...over[chapter],
  }));

const BOARD: OpsSetupBoard = {
  client: { id: CLIENT, name: "Hartley Millwork" },
  agents: [
    {
      agentId: BILLS,
      name: "Bill clerk",
      stage: "bench",
      version: 4,
      cells: cells({
        tools: { state: "open", waitingOn: "Dana Ruiz", note: "Connect Gmail" },
        live: { state: "open", waitingOn: "Dana Ruiz", note: "Sign the scope" },
      }),
      holds: ["Connect Gmail (Dana Ruiz)", "Sign the scope (Dana Ruiz)"],
    },
    {
      agentId: CONTRACTS,
      name: "Vendor contracts",
      stage: "bench",
      version: 2,
      cells: cells({ see: { state: "not_needed" } }),
      holds: [],
    },
  ],
  waiting: [
    {
      userId: DANA,
      name: "Dana Ruiz",
      items: ["Bill clerk: Connect Gmail", "Bill clerk: Sign the scope"],
      lastSeenAt: "2026-11-21T15:00:00.000Z",
    },
  ],
  asks: [
    {
      requestId: ISSUE,
      number: 12,
      agentId: BILLS,
      agentName: "Bill clerk",
      stepId: "code",
      text: "Freight should go to overhead, not the job.",
      byName: "Dana Ruiz",
      at: "2026-11-21T16:00:00.000Z",
    },
  ],
  runbook: [
    { key: "invite", day: 0, label: "Invite sent", at: "2026-11-20T10:00:00.000Z", state: "done" },
    {
      key: "kickoff",
      day: 2,
      label: "Kickoff call, 30 minutes: the walkthrough and a try",
      at: "2026-11-22T10:00:00.000Z",
      state: "now",
    },
    {
      key: "trial",
      day: 3,
      label: "Scope signed, Start trial",
      at: "2026-11-23T10:00:00.000Z",
      state: "next",
    },
    { key: "checkin", day: 10, label: "Trial check-in", at: null, state: "next" },
    { key: "live", day: 17, label: "Sign-off and live", at: null, state: "next" },
  ],
  intakeId: INTAKE,
};

const field = (key: string, label: string, kind: "text" | "number") => ({
  key,
  sectionKey: "general",
  alsoIn: [],
  label,
  kind,
  hint: "",
  requiredToStart: false,
  state: "to_ask" as const,
  weThink: null,
  fileSection: null,
  connector: null,
  origin: "core" as const,
});

const INTAKE_VIEW: OpsIntakeView = {
  intake: {
    id: INTAKE,
    client: { id: CLIENT, name: "Hartley Millwork" },
    fileId: null,
    dealId: null,
    status: "open",
    covers: { general: true, areas: [], templateIds: [] },
    startMode: "point",
    people: 1,
    answered: 1,
    total: 3,
    sendAt: null,
    createdAt: "2026-11-20T10:00:00.000Z",
    updatedAt: "2026-11-20T10:00:00.000Z",
    leadNote: "",
    lead: null,
  },
  guide: {
    version: 1,
    sections: [
      {
        key: "general",
        kind: "general",
        area: null,
        templateId: null,
        title: "How you work",
        intro: "",
        fields: [
          field("general.approver", "Who approves payments and changes?", "text"),
          field("general.bills", "How many bills a month?", "number"),
          field("general.done", "What do you use for books?", "text"),
        ],
      },
    ],
    totals: { known: 0, toConfirm: 0, toAsk: 3, later: 0, tools: 0, minutes: 5 },
  },
  people: [],
  answers: [
    {
      fieldKey: "general.done",
      value: "QuickBooks Online",
      state: "answered",
      source: "form",
      by: null,
      at: "2026-11-21T10:00:00.000Z",
    },
  ],
  progress: [],
  events: [],
};

function setup(board: OpsSetupBoard = BOARD) {
  const sent: { route: string; body: unknown }[] = [];
  const preview: TurnOnAnswer = {
    agentId: CONTRACTS,
    clientId: CLIENT,
    clientName: "Hartley Millwork",
    versionId: "00000000-0000-4000-8000-0000000c0002",
    version: 2,
    started: false,
    stage: "bench",
    items: [],
  };
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    [`GET /api/ops/clients/${CLIENT}`]: () => DETAIL,
    "GET /api/ops/clients": () => ({ clients: [] }),
    [`GET /api/ops/clients/${CLIENT}/setup`]: () => board,
    [`POST /api/ops/clients/${CLIENT}/setup/nudge`]: ({ init }) => {
      sent.push({ route: "nudge", body: JSON.parse(String(init.body)) });
      return sent.filter((s) => s.route === "nudge").length === 1
        ? { sent: true, reason: null }
        : { sent: false, reason: "already_today" };
    },
    [`GET /api/ops/intakes/${INTAKE}`]: () => INTAKE_VIEW,
    [`POST /api/ops/intakes/${INTAKE}/call-answers`]: ({ init }) => {
      const body = JSON.parse(String(init.body));
      sent.push({ route: "call", body });
      return { saved: body.answers.length };
    },
    [`GET /api/ops/agents/${CONTRACTS}/turn-on`]: () => preview,
    [`POST /api/ops/agents/${CONTRACTS}/turn-on`]: () => {
      sent.push({ route: "turn-on", body: null });
      return { ...preview, agentId: CONTRACTS, started: true, stage: "trial" };
    },
  });
  render(
    <MemoryRouter initialEntries={[`/ops/clients/${CLIENT}/progress`]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, sent };
}

describe("the Setup tab's Progress", () => {
  it(
    "shows the KPIs, the board with who each cell waits on, the asks and the runbook",
    async () => {
      setup();
      const kpis = await screen.findByTestId("ops-setup-kpis", {}, { timeout: 10_000 });
      expect(kpis).toHaveTextContent("Agents in setup2");
      expect(kpis).toHaveTextContent("Waiting on the client2");
      expect(kpis).toHaveTextContent("Change asks1");
      expect(kpis).toHaveTextContent("Trial targetNov 23");

      const board = screen.getByTestId("ops-setup-board");
      expect(
        within(board)
          .getAllByRole("columnheader")
          .map((h) => h.textContent),
      ).toEqual(["Agent", "Business", "Tools", "People", "See it work", "Go live"]);
      expect(screen.getByTestId(`ops-setup-row-${BILLS}`)).toHaveTextContent("v4 · on the bench");
      const tools = screen.getByTestId(`ops-setup-cell-${BILLS}-tools`);
      expect(tools).toHaveTextContent("Waiting on Dana Ruiz");
      expect(tools).toHaveTextContent("Connect Gmail");
      expect(screen.getByTestId(`ops-setup-cell-${BILLS}-business`)).toHaveTextContent("Done");
      expect(screen.getByTestId(`ops-setup-cell-${CONTRACTS}-see`)).toHaveTextContent("Not needed");

      const ask = screen.getByTestId(`ops-setup-ask-${ISSUE}`);
      expect(ask).toHaveAttribute("href", `/ops/issues/${ISSUE}`);
      expect(ask).toHaveTextContent("#12 · Bill clerk · step code");
      expect(ask).toHaveTextContent("Freight should go to overhead, not the job.");

      const runbook = screen.getByTestId("ops-setup-runbook");
      expect(runbook).toHaveTextContent("Next: kickoff, planned day 2");
      expect(within(runbook).getAllByRole("listitem")).toHaveLength(5);
      expect(screen.getByTestId("ops-setup-runbook-kickoff")).toHaveAttribute("data-state", "now");
      expect(screen.getByTestId("ops-setup-runbook-invite")).toHaveTextContent(
        "Day 0 · Nov 20 · done",
      );
    },
    SLOW,
  );

  it(
    "nudges a person and says what happened",
    async () => {
      const { sent } = setup();
      const row = await screen.findByTestId(`ops-setup-waiting-${DANA}`, {}, { timeout: 10_000 });
      expect(row).toHaveTextContent("Dana Ruiz · 2 things");
      expect(row).toHaveTextContent("Bill clerk: Connect Gmail, Bill clerk: Sign the scope");
      expect(row).toHaveTextContent("Last here Nov 21");
      await userEvent.click(within(row).getByTestId("ops-setup-nudge"));
      expect(await within(row).findByTestId("ops-setup-nudge-result")).toHaveTextContent(
        "Nudged. Dana Ruiz gets an email from you listing what's left.",
      );
      expect(sent).toEqual([{ route: "nudge", body: { userId: DANA } }]);
      expect(within(row).getByTestId("ops-setup-nudge")).toBeDisabled();
    },
    SLOW,
  );

  it(
    "keeps Start trial off while anything holds it, and turns on an agent nothing holds",
    async () => {
      const { sent } = setup();
      const held = await screen.findByTestId(`ops-setup-start-${BILLS}`, {}, { timeout: 10_000 });
      expect(within(held).getByTestId("ops-setup-start-trial")).toBeDisabled();
      expect(within(held).getByTestId("ops-setup-holds")).toHaveTextContent(
        "Connect Gmail (Dana Ruiz)Sign the scope (Dana Ruiz)",
      );
      const ready = screen.getByTestId(`ops-setup-start-${CONTRACTS}`);
      expect(ready).toHaveTextContent("Nothing holds it.");
      await userEvent.click(within(ready).getByTestId("ops-setup-start-trial"));
      const sheet = await screen.findByTestId("flow-turn-on");
      await waitFor(() => expect(within(sheet).getByTestId("flow-turn-on-start")).toBeEnabled());
      await userEvent.click(within(sheet).getByTestId("flow-turn-on-start"));
      expect(await screen.findByTestId("flow-turn-on-started")).toHaveTextContent(
        "It's in its trial at Hartley Millwork.",
      );
      expect(sent.filter((s) => s.route === "turn-on")).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "saves the intake's open questions from a call",
    async () => {
      const { sent } = setup();
      const toggle = await screen.findByTestId("ops-setup-call-switch", {}, { timeout: 10_000 });
      expect(toggle).toHaveAttribute("aria-checked", "false");
      await userEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-checked", "true");
      expect(screen.getByTestId("ops-setup-on-call")).toHaveTextContent(
        'Answers you give show to them as "From our call: please check"',
      );
      const form = await screen.findByTestId("ops-setup-call");
      // Answered by the client already: not asked again.
      expect(within(form).queryByText("What do you use for books?")).toBeNull();
      await userEvent.type(
        within(form).getByTestId("ops-setup-call-input-general.approver"),
        "Luis signs over $5,000",
      );
      await userEvent.type(within(form).getByTestId("ops-setup-call-input-general.bills"), "330");
      await userEvent.click(within(form).getByTestId("ops-setup-call-save"));
      await waitFor(() =>
        expect(sent.find((s) => s.route === "call")?.body).toEqual({
          answers: [
            { fieldKey: "general.approver", value: "Luis signs over $5,000" },
            { fieldKey: "general.bills", value: 330 },
          ],
        }),
      );
      expect(await within(form).findByTestId("ops-setup-call-saved")).toHaveTextContent(
        'Saved 2 answers. They show to the client as "From our call: please check".',
      );
    },
    SLOW,
  );

  it(
    "says when no agent is being set up",
    async () => {
      setup({ ...BOARD, agents: [], waiting: [], asks: [], intakeId: null });
      expect(
        await screen.findByTestId("ops-setup-none", {}, { timeout: 10_000 }),
      ).toHaveTextContent("No agent is being set up for Hartley Millwork.");
      expect(screen.getByTestId("ops-setup-call-switch")).toBeDisabled();
    },
    SLOW,
  );
});
