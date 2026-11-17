// Sales in the back office (docs/plan.md §1.124.2; docs/design/pipelines.html): All deals as one
// list with the prototype's KPIs and columns, filters and search; a pipeline's board with its
// stage totals; a new deal sent as a decimal string; and a deal's page: the stage stepper, a
// note on the timeline, terms, and set-up, which creates the client and its builds.
import type { DealDetail, DealSummary } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../../App";
import { fakeApi, OPERATOR_SESSION } from "../../../test/fixtures";

const at = "2026-11-17T09:00:00.000Z";
const CLIENT = "00000000-0000-4000-8000-00000000a001";
const LEAD = "00000000-0000-4000-8000-0000000d0001";
const GROW = "00000000-0000-4000-8000-0000000d0002";
const WON = "00000000-0000-4000-8000-0000000d0003";

function summary(over: Partial<DealSummary>): DealSummary {
  return {
    id: LEAD,
    kind: "new",
    client: null,
    company: "Ridgeline Dental Group",
    title: "Purchasing and Bookkeeping",
    description: "4 offices, about 300 supplier invoices a month.",
    stage: "lead",
    stageName: "Lead",
    likelihood: "0.1",
    agentCount: 2,
    mrr: "2400.0000",
    currency: "USD",
    weighted: "240.0000",
    renewal: false,
    outcome: "open",
    waitingOn: "operator",
    statusLine: "First reply",
    statusText: "First reply",
    stuck: false,
    held: null,
    standing: "you",
    late: false,
    nextStep: "First reply",
    nextDueOn: "2026-11-17",
    source: "site_form",
    origin: null,
    agreedMrr: null,
    stageAt: at,
    wonAt: null,
    closedAt: null,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

const lead = summary({});
const grow = summary({
  id: GROW,
  kind: "expansion",
  client: { id: CLIENT, name: "Hartley Millwork" },
  company: null,
  title: "Fuel cards by truck",
  description: "Asked about it in the trial.",
  stage: "pitch",
  stageName: "Pitch",
  likelihood: "0.4",
  agentCount: 1,
  mrr: "700.0000",
  weighted: "280.0000",
  waitingOn: "reggie",
  standing: "stalled",
  held: { reason: "Held: critical issue" },
  statusText: "Held: critical issue",
  nextDueOn: null,
  source: "reggie",
});
const won = summary({
  id: WON,
  company: "Northfield Builders",
  title: "Receipts by WhatsApp",
  stage: "live",
  stageName: "First agent live",
  likelihood: "1",
  agentCount: 1,
  mrr: "2200.0000",
  weighted: "2200.0000",
  outcome: "won",
  standing: "done",
  statusText: "Won Nov 3",
  wonAt: "2026-11-03T10:00:00.000Z",
  nextDueOn: null,
});

const kpis = {
  potential: "3100.0000",
  weighted: "520.0000",
  open: 2,
  openNew: 1,
  openExpansion: 1,
  agentsInPlay: 3,
  needYou: 1,
  lateOrStuck: 1,
  late: 0,
  wonThisMonth: "2200.0000",
  wonCount: 1,
};

const STAGES = [
  ["lead", "Lead", "0.1"],
  ["qualified", "Qualified", "0.25"],
  ["diagnostic", "Diagnostic", "0.4"],
  ["proposal", "Proposal and contract", "0.6"],
  ["setup", "Set up the account", "0.9"],
  ["live", "First agent live", "1"],
] as const;

function detail(over: Partial<DealDetail["deal"]> = {}): DealDetail {
  return {
    deal: {
      ...lead,
      agentsSold: [
        { name: "Purchasing", templateId: null },
        { name: "Bookkeeper", templateId: null },
      ],
      outcomeReason: null,
      checkBackOn: null,
      sourceDetail: null,
      evidence: [],
      agreedFrom: null,
      signedCopy: null,
      people: [
        {
          id: "00000000-0000-4000-8000-0000000e0001",
          name: "Karen Lowe",
          email: "karen@ridgeline.example.com",
          phone: null,
          role: "Office manager",
          isPrimary: true,
        },
      ],
      fileId: null,
      ...over,
    },
    activity: [
      {
        id: "00000000-0000-4000-8000-0000000f0001",
        kind: "system",
        actor: "operator",
        who: "Operator",
        subject: null,
        body: "Opened the deal.",
        sources: [],
        createdAt: at,
      },
    ],
    builds: [],
    now: null,
    stages: STAGES.map(([id, name, p]) => ({ id, name, p })),
  };
}

const common = {
  "GET /api/session": () => OPERATOR_SESSION,
  "GET /api/ops/counts": () => ({ needsUs: 0, clients: [] }),
  "GET /api/ops/clients": () => ({
    clients: [
      {
        id: CLIENT,
        name: "Hartley Millwork",
        timezone: "UTC",
        createdAt: at,
        agents: 0,
        openInbox: 0,
      },
    ],
  }),
  "GET /api/ops/deals": () => ({ deals: [lead, grow, won], kpis, today: "2026-11-17" }),
};

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("Sales", () => {
  it("lists all deals with the figures, filters and search", async () => {
    const api = fakeApi(common);
    renderAt("/ops/sales", api);
    const k = await screen.findByTestId("sales-kpis");
    expect(k).toHaveTextContent("Potential a month$3,100$520 weighted by stage");
    expect(k).toHaveTextContent("Open deals21 new · 1 expansion");
    expect(k).toHaveTextContent("Need you1");
    expect(k).toHaveTextContent("Won this month$2,2001 deal");
    // Tabs carry the open counts.
    const tabs = screen.getByRole("navigation", { name: "Sales" });
    expect(within(tabs).getByRole("link", { name: /All deals/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(tabs).getByRole("link", { name: /New accounts/ })).toHaveTextContent("1");
    // Open by default: the won deal is under Done.
    const table = screen.getByTestId("sales-table");
    expect(within(table).getByTestId(`sales-row-${LEAD}`)).toHaveTextContent(
      "Ridgeline Dental GroupLead",
    );
    expect(within(table).getByTestId(`sales-row-${LEAD}`)).toHaveTextContent(
      "Needs you · First reply",
    );
    expect(within(table).getByTestId(`sales-row-${LEAD}`)).toHaveTextContent("10% likely");
    expect(within(table).getByTestId(`sales-row-${LEAD}`)).toHaveTextContent("Today");
    expect(within(table).getByTestId(`sales-row-${GROW}`)).toHaveTextContent("+$700");
    expect(within(table).getByTestId(`sales-row-${GROW}`)).toHaveTextContent(
      "Held: critical issue",
    );
    expect(within(table).queryByTestId(`sales-row-${WON}`)).toBeNull();
    expect(screen.getByTestId("sales-status")).toHaveTextContent(
      "2 shown3 agents$3,100 a month open$520 weighted",
    );
    await userEvent.click(screen.getByTestId("sales-filters-done"));
    expect(screen.getByTestId(`sales-row-${WON}`)).toHaveTextContent("Won Nov 3");
    await userEvent.click(screen.getByTestId("sales-filters-open"));
    await userEvent.type(screen.getByTestId("sales-search"), "nothing like this");
    expect(screen.getByTestId("sales-empty")).toHaveTextContent("Nothing matches.");
    await userEvent.click(screen.getByRole("button", { name: "Clear the search and filters" }));
    expect(screen.getByTestId(`sales-row-${LEAD}`)).toBeInTheDocument();
  });

  it("opens a pipeline on its board, with each stage's totals", async () => {
    const api = fakeApi(common);
    renderAt("/ops/sales/grow", api);
    const heads = await screen.findByTestId("sales-board-heads");
    expect(within(heads).getByTestId("sales-head-pitch")).toHaveTextContent(
      "Pitch11 deal1 agent$700/mo",
    );
    expect(within(heads).getByTestId("sales-head-spotted")).toHaveTextContent(
      "0 deals0 agents$0/mo",
    );
    const board = screen.getByTestId("sales-board");
    const pitch = within(board).getByRole("region", { name: "Pitch" });
    expect(within(pitch).getByTestId(`sales-card-${GROW}`)).toHaveTextContent("Hartley Millwork");
    expect(within(pitch).getByTestId(`sales-card-${GROW}`)).toHaveTextContent("1 agent · +$700/mo");
    expect(screen.queryByTestId(`sales-card-${LEAD}`)).toBeNull();
  });

  it("adds a deal with its value as a decimal", async () => {
    const sent: unknown[] = [];
    const api = fakeApi({
      ...common,
      "POST /api/ops/deals": ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return detail();
      },
      [`GET /api/ops/deals/${LEAD}`]: () => detail(),
    });
    renderAt("/ops/sales", api);
    await userEvent.click(await screen.findByTestId("sales-new"));
    await userEvent.type(screen.getByTestId("sales-start-company"), "Ridgeline Dental Group");
    await userEvent.type(screen.getByTestId("sales-start-title"), "Purchasing and Bookkeeping");
    await userEvent.type(screen.getByTestId("sales-start-mrr"), "$2,400.50");
    await userEvent.clear(screen.getByTestId("sales-start-agents"));
    await userEvent.type(screen.getByTestId("sales-start-agents"), "2");
    await userEvent.type(screen.getByTestId("sales-start-person"), "Karen Lowe");
    await userEvent.click(screen.getByTestId("sales-start-go"));
    await waitFor(() =>
      expect(sent).toEqual([
        {
          kind: "new",
          title: "Purchasing and Bookkeeping",
          mrr: "2400.50",
          agentCount: 2,
          company: "Ridgeline Dental Group",
          people: [{ name: "Karen Lowe" }],
        },
      ]),
    );
    expect(await screen.findByTestId("deal-page")).toBeInTheDocument();
  });

  it("shows a deal and moves it, notes it and sets up the account", async () => {
    const moves: unknown[] = [];
    const notes: unknown[] = [];
    const setups: unknown[] = [];
    let current = detail();
    const api = fakeApi({
      ...common,
      [`GET /api/ops/deals/${LEAD}`]: () => current,
      [`PATCH /api/ops/deals/${LEAD}`]: ({ init }) => {
        const body = JSON.parse(String(init.body));
        moves.push(body);
        current = detail({
          stage: "proposal",
          stageName: "Proposal and contract",
          likelihood: "0.6",
        });
        return current;
      },
      [`POST /api/ops/deals/${LEAD}/activity`]: ({ init }) => {
        notes.push(JSON.parse(String(init.body)));
        return current;
      },
      [`POST /api/ops/deals/${LEAD}/setup`]: ({ init }) => {
        setups.push(JSON.parse(String(init.body)));
        return { clientId: CLIENT, buildIds: [] };
      },
    });
    renderAt(`/ops/deals/${LEAD}`, api);
    expect(await screen.findByTestId("deal-title")).toHaveTextContent("Ridgeline Dental Group");
    expect(screen.getByTestId("deal-standing")).toHaveTextContent("Needs you · First reply");
    expect(screen.getByTestId("deal-terms")).toHaveTextContent("Proposed$2,400 a month");
    expect(screen.getByTestId("deal-terms")).toHaveTextContent("By hand for now");
    expect(screen.getByTestId("deal-read")).toHaveTextContent("Reggie hasn't read this yet.");
    expect(screen.getByTestId("deal-people")).toHaveTextContent("Karen LoweMain contact");
    expect(screen.getByTestId("deal-details")).toHaveTextContent("FitsPurchasing, Bookkeeper");
    // Not yet at the proposal: no set-up.
    expect(screen.queryByTestId("deal-setup")).toBeNull();
    expect(screen.getByTestId("deal-stage-lead")).toHaveAttribute("aria-current", "step");

    // The composer opens on the internal note; the Email tab asks for a subject and sends.
    await userEvent.type(screen.getByTestId("deal-composer-text"), "Karen wants it by January.");
    await userEvent.click(screen.getByTestId("deal-composer-save"));
    await waitFor(() =>
      expect(notes).toEqual([{ kind: "note", body: "Karen wants it by January." }]),
    );
    await userEvent.click(screen.getByTestId("deal-composer-email"));
    expect(screen.getByTestId("deal-composer-subject")).toBeInTheDocument();
    expect(screen.getByTestId("deal-composer-save")).toHaveTextContent("Send");
    expect(screen.getByTestId("deal-composer-save")).toBeDisabled();

    await userEvent.click(screen.getByTestId("deal-stage-proposal"));
    await waitFor(() => expect(moves).toEqual([{ stage: "proposal" }]));
    await userEvent.click(await screen.findByTestId("deal-setup-open"));
    expect(screen.getByTestId("deal-setup-name")).toHaveValue("Ridgeline Dental Group");
    expect(screen.getByTestId("deal-setup-admin")).toHaveValue("karen@ridgeline.example.com");
    expect(screen.getByTestId("deal-setup-agent-1")).toHaveValue("Bookkeeper");
    expect(screen.getByTestId("deal-setup-go")).toHaveTextContent("Create the client and 2 builds");
    await userEvent.click(screen.getByTestId("deal-setup-go"));
    await waitFor(() =>
      expect(setups).toEqual([
        {
          name: "Ridgeline Dental Group",
          adminEmail: "karen@ridgeline.example.com",
          adminName: "Karen Lowe",
          agents: [
            { name: "Purchasing", templateId: null },
            { name: "Bookkeeper", templateId: null },
          ],
        },
      ]),
    );
  });

  it("closes a lost deal with Reggie's check-back", async () => {
    const outcomes: unknown[] = [];
    const api = fakeApi({
      ...common,
      [`GET /api/ops/deals/${LEAD}`]: () => detail(),
      [`POST /api/ops/deals/${LEAD}/outcome`]: ({ init }) => {
        outcomes.push(JSON.parse(String(init.body)));
        return detail({ outcome: "lost", standing: "done", statusText: "Lost Nov 17" });
      },
    });
    renderAt(`/ops/deals/${LEAD}`, api);
    await userEvent.click(await screen.findByTestId("deal-close"));
    await userEvent.selectOptions(screen.getByTestId("deal-outcome-kind"), "no");
    expect(screen.getByTestId("deal-outcome-go")).toBeDisabled();
    await userEvent.selectOptions(screen.getByTestId("deal-outcome-kind"), "lost");
    await userEvent.type(screen.getByTestId("deal-outcome-reason"), "Went with their accountant.");
    await userEvent.click(screen.getByTestId("deal-outcome-go"));
    await waitFor(() =>
      expect(outcomes).toEqual([{ outcome: "lost", reason: "Went with their accountant." }]),
    );
  });
});
