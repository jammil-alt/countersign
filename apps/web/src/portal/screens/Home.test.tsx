// C1 Home (`/`, was the Table; Review 1): the agents with their state, tools and last run, what
// needs you (the top of the Inbox with "Not now", and the supervisor's findings), the weekly
// summary when one was sent, the lead's note with a reply, and the latest work. Each count once,
// empty sections left out. Never a bundle or a cost.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi, tableService, tableView } from "../../test/fixtures";
import { tomorrowMorning } from "./Home";

const PIA = "00000000-0000-4000-8000-00000000b001";
const COLE = "00000000-0000-4000-8000-00000000b002";
const RUN = "00000000-0000-4000-8000-0000000f1001";
const ITEM = "00000000-0000-4000-8000-0000000e1001";
const ITEM_2 = "00000000-0000-4000-8000-0000000e1002";
const THREAD = "00000000-0000-4000-8000-0000000c1001";
const QBO = "00000000-0000-4000-8000-0000000a1001";

const FINDING = {
  id: "00000000-0000-4000-8000-0000000fd001",
  kind: "connection_signin",
  title: "Zoho CRM needs you to sign in again",
  steps: ["Go to Connections.", "Find Zoho CRM.", "Choose Reconnect and follow the steps."],
  createdAt: "2026-11-05T08:00:00.000Z",
  remindedAt: "2026-11-06T08:00:00.000Z",
};

const SUMMARY = {
  checkedAt: "2026-11-06T08:00:00.000Z",
  state: "attention",
  runs: { total: 12, failed: 1 },
  connections: { total: 3, needsAttention: 1 },
  waiting: { count: 2, oldestHours: 30 },
  agents: { active: 3, paused: 0 },
  openFindings: 1,
};

const overview = (health?: unknown) => ({
  client: { id: "00000000-0000-4000-8000-00000000a002", name: "Demo client" },
  services: [],
  needsYou: { inbox: 1 },
  recentRuns: [],
  ...(health === undefined ? {} : { health }),
});

const TABLE = tableView({
  services: [
    tableService(PIA, "Pia", {
      description: "Checks vendor invoices against your price history.",
      now: {
        runId: RUN,
        status: "running",
        step: { index: 3, total: 6, label: "Match items to your catalog" },
        since: "2026-11-06T09:08:00.000Z",
        waitingOnYou: false,
      },
      runsDone: 9,
      runs: { total: 10, succeeded: 9, failed: 0, cancelled: 0, waiting: 0, going: 1 },
    }),
    tableService(COLE, "Cole", {
      now: {
        runId: "00000000-0000-4000-8000-0000000f1002",
        status: "waiting",
        step: { index: 4, total: 5, label: "Sign the payment reminders" },
        since: "2026-11-06T08:00:00.000Z",
        waitingOnYou: true,
      },
      kpis: [{ key: "overdue", label: "Overdue", value: "$18,420.00" }],
    }),
    tableService("00000000-0000-4000-8000-00000000b003", "Remy", {
      stage: "bench",
      status: "draft",
    }),
  ],
  figures: {
    runsDone: 38,
    runs: { total: 41, succeeded: 38, failed: 0, cancelled: 0, waiting: 1, going: 2 },
    changes: { automatic: 52, signed: 12 },
  },
  recent: [
    {
      runId: RUN,
      service: { id: PIA, name: "Pia" },
      label: "Compare prices",
      summary: 'Found Baltic birch 3/4" up 12% at Rugby Architectural',
      sources: [],
      at: "2026-11-06T09:12:00.000Z",
    },
  ],
  desk: {
    open: 5,
    top: [
      {
        id: ITEM,
        kind: "external_action",
        title: "Send 3 payment reminders, $18,420 total",
        runId: null,
        dueAt: new Date().toISOString(),
        createdAt: "2026-11-06T08:00:00.000Z",
      },
      {
        id: ITEM_2,
        kind: "request",
        title: 'Is "CP/CP BB 3/4" the same item as Baltic birch 3/4"?',
        runId: RUN,
        dueAt: null,
        createdAt: "2026-11-06T08:30:00.000Z",
      },
    ],
  },
  lead: {
    id: "00000000-0000-4000-8000-00000000d009",
    name: "Ana Ruiz",
    message: {
      id: "00000000-0000-4000-8000-0000000c2001",
      text: "Rugby raised birch prices twice this quarter.",
      at: "2026-11-05T16:00:00.000Z",
    },
  },
});

const ACCESS = {
  items: [
    {
      connectionId: QBO,
      connector: "qbo",
      name: "QuickBooks Online",
      kind: "oauth",
      status: "active",
      externalAccountId: null,
      secret: { set: true, fields: [], updatedAt: null },
      credentialForm: false,
      matrix: { read: "auto", create: "approval", update: "approval", delete: "off" },
      tools: [],
      agents: [
        {
          agentId: PIA,
          name: "Pia",
          limits: {},
          effective: { read: "auto", create: "off", update: "approval", delete: "off" },
          tools: null,
          revoked: false,
          updatedAt: null,
        },
      ],
      browser: null,
      release: {
        mode: "off",
        person: null,
        channel: "email",
        window: "run",
        sentTo: null,
        updatedAt: null,
        live: [],
      },
    },
  ],
  setup: [],
  browserSites: [],
  canEdit: true,
  people: [],
};

const base = {
  "GET /api/session": () => ({
    ...CLIENT_SESSION,
    user: { ...CLIENT_SESSION.user, name: "Dana Kim" },
  }),
  "GET /api/feedback/status": () => ({ enabled: false }),
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

const WEEKLY = {
  table: {
    id: "00000000-0000-4000-8000-0000000d1001",
    weekStart: "2026-11-02",
    status: "sent",
    stats: {
      weekStart: "2026-11-02",
      from: "2026-11-02T00:00:00.000Z",
      to: "2026-11-09T00:00:00.000Z",
      runs: { done: 38, lastWeek: 31, change: 7, sources: [] },
      changes: { automatic: 20, signed: 11, sources: [] },
      signatures: { given: 11, sources: [] },
      documents: { read: 31, sources: [] },
      agents: [],
      computedAt: "2026-11-06T17:00:00.000Z",
    },
    note: "A quiet week: prices held, and two vendors sent their new lists.",
    noteBy: { id: "00000000-0000-4000-8000-00000000d009", name: "Ana Ruiz" },
    decisions: [],
    nextWeek: null,
    setup: { items: [] },
    sentAt: "2026-11-02T14:00:00.000Z",
    updatedAt: "2026-11-02T14:00:00.000Z",
  },
  weeks: ["2026-11-02"],
};

describe("Home", () => {
  it("shows each agent, what needs you, the latest work, and each count once", async () => {
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview(),
      "GET /api/table": () => TABLE,
      "GET /api/access": () => ACCESS,
      "GET /api/weekly": () => ({ table: null, weeks: [] }),
    });
    const { container } = renderAt("/", api);
    expect(
      await screen.findByRole("heading", { name: /^Good (morning|afternoon|evening), Dana$/ }),
    ).toBeInTheDocument();
    // One short line; what waits on you is said once, in "Needs you".
    expect(screen.getByTestId("home-week-line")).toHaveTextContent("38 runs finished this week.");
    expect(screen.getByTestId("home-week-line")).not.toHaveTextContent(/wait/);
    // No Weekly Table or Sloan buttons, no stat tiles; Add documents goes to upload.
    expect(screen.queryByRole("link", { name: "Open the Weekly Table" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Ask Sloan" })).toBeNull();
    expect(screen.queryByTestId("table-stat-waiting")).toBeNull();
    expect(screen.getByTestId("home-add-documents")).toHaveAttribute("href", "/upload");

    const agents = screen.getByTestId("home-agents");
    const pia = within(agents).getByTestId(`portal-service-${PIA}`);
    expect(pia).toHaveAttribute("href", `/agents/${PIA}`);
    expect(within(pia).getByTestId(`table-agent-state-${PIA}`)).toHaveTextContent("Working");
    expect(within(pia).getByTestId(`table-agent-now-${PIA}`)).toHaveTextContent(
      "Now: Match items to your catalog · Step 3 of 6",
    );
    // Its tools are the connections it is granted.
    expect(await within(pia).findByText("QuickBooks Online")).toBeInTheDocument();

    const cole = within(agents).getByTestId(`portal-service-${COLE}`);
    expect(within(cole).getByTestId(`table-agent-state-${COLE}`)).toHaveAttribute(
      "data-state",
      "waiting",
    );
    expect(within(cole).getByTestId(`table-agent-now-${COLE}`)).toHaveTextContent(
      /^Waiting on you since .+ · Overdue: \$18,420\.00$/,
    );
    expect(within(agents).getByText("Setting up")).toBeInTheDocument();

    const latest = screen.getByTestId(`table-latest-${RUN}`);
    expect(within(latest).getByRole("link")).toHaveAttribute("href", `/runs/${RUN}`);
    expect(latest).toHaveTextContent('Pia Found Baltic birch 3/4" up 12% at Rugby Architectural');

    const needs = screen.getByTestId("table-desk");
    expect(needs).toHaveTextContent("Needs you");
    const first = within(needs).getByTestId(`table-desk-item-${ITEM}`);
    expect(first).toHaveTextContent("Due today");
    // Home never approves: its main action opens the item in the Inbox.
    expect(within(first).getByRole("link", { name: "Review and approve" })).toHaveAttribute(
      "href",
      `/inbox?item=${ITEM}`,
    );
    expect(
      within(within(needs).getByTestId(`table-desk-item-${ITEM_2}`)).getByRole("link", {
        name: "Open",
      }),
    ).toHaveAttribute("href", `/inbox?item=${ITEM_2}`);
    expect(within(needs).getByRole("link", { name: "3 more in your inbox" })).toHaveAttribute(
      "href",
      "/inbox",
    );

    expect(screen.getByTestId("table-lead")).toHaveTextContent(
      "Rugby raised birch prices twice this quarter.",
    );
    // No weekly summary was sent: no card.
    expect(screen.queryByTestId("home-weekly")).toBeNull();
    expect(screen.queryByText(/bundle|instructions|prompt|cost/i)).toBeNull();
    expect(container.textContent).not.toMatch(/costUsd/);
  });

  it("shows the weekly summary when one was sent, linking to it", async () => {
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview(),
      "GET /api/table": () => TABLE,
      "GET /api/access": () => ACCESS,
      "GET /api/weekly": () => WEEKLY,
    });
    renderAt("/", api);
    const card = await screen.findByTestId("home-weekly");
    expect(card).toHaveTextContent("Your weekly summary");
    expect(card).toHaveTextContent("A quiet week");
    expect(card).toHaveTextContent("From Ana Ruiz, your Mezonas lead.");
    expect(within(card).getByTestId("home-weekly-open")).toHaveAttribute("href", "/weekly");
  });

  // QA round 1: a run waiting on an approval keeps status "running"; it is never shown as Running.
  it("shows a run waiting on your approval as waiting on you, never as running", async () => {
    const BILL = "00000000-0000-4000-8000-00000000b004";
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview(),
      "GET /api/table": () =>
        tableView({
          services: [
            tableService(BILL, "Bill clerk", {
              now: {
                runId: RUN,
                status: "running",
                step: null,
                since: "2026-11-05T23:44:00.000Z",
                waitingOnYou: true,
              },
              runs: { total: 1, succeeded: 0, failed: 0, cancelled: 0, waiting: 1, going: 0 },
              runsNow: { running: 0, waitingOnYou: 1 },
            }),
          ],
          figures: {
            runsDone: 0,
            runs: { total: 1, succeeded: 0, failed: 0, cancelled: 0, waiting: 1, going: 0 },
            changes: { automatic: 0, signed: 0 },
          },
        }),
      "GET /api/access": () => ({ ...ACCESS, items: [] }),
    });
    renderAt("/", api);
    const card = await screen.findByTestId(`portal-service-${BILL}`);
    expect(within(card).getByTestId(`table-agent-state-${BILL}`)).toHaveTextContent(
      "Waiting on you",
    );
    expect(within(card).getByTestId(`table-agent-now-${BILL}`)).toHaveTextContent(
      "Waiting on you since",
    );
    expect(card).not.toHaveTextContent(/Running|Working/);
    // Nothing finished this week: no week line at all.
    expect(screen.queryByTestId("home-week-line")).toBeNull();
  });

  it("puts an item off until tomorrow morning with Not now", async () => {
    const sent: unknown[] = [];
    let table = TABLE;
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview(),
      "GET /api/table": () => table,
      "GET /api/access": () => ACCESS,
      [`POST /api/inbox/${ITEM}/snooze`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        table = { ...TABLE, desk: { open: 4, top: TABLE.desk.top.slice(1) } };
        return {
          item: {
            id: ITEM,
            status: "open",
            deliverAfter: null,
            snoozedUntil: tomorrowMorning(),
            batchKey: null,
            resolvedAt: null,
          },
        };
      },
    });
    renderAt("/", api);
    await userEvent.click(await screen.findByTestId(`table-desk-later-${ITEM}`));
    await waitFor(() => expect(screen.queryByTestId(`table-desk-item-${ITEM}`)).toBeNull());
    expect(sent).toEqual([{ until: tomorrowMorning() }]);
    const until = new Date(tomorrowMorning());
    expect(until.getHours()).toBe(8);
    expect(until.getTime()).toBeGreaterThan(Date.now());
  });

  it("replies to the lead in the lead thread", async () => {
    const posted: unknown[] = [];
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview(),
      "GET /api/table": () => TABLE,
      "GET /api/access": () => ACCESS,
      "GET /api/threads": ({ url }) => {
        expect(url.searchParams.get("subject")).toBe("lead");
        return {
          lead: { name: "Ana Ruiz" },
          threads: [
            {
              id: THREAD,
              subject: "lead",
              service: null,
              startedBy: null,
              lastMessageAt: null,
              unread: 0,
              createdAt: "2026-11-01T00:00:00.000Z",
            },
          ],
        };
      },
      [`POST /api/threads/${THREAD}/messages`]: ({ init }) => {
        posted.push(JSON.parse(String(init.body)));
        return { messages: [] };
      },
    });
    renderAt("/", api);
    await userEvent.click(await screen.findByRole("button", { name: "Reply to Ana" }));
    await userEvent.type(screen.getByTestId("table-lead-text"), "Yes, bring options.");
    await userEvent.click(screen.getByTestId("table-lead-send"));
    expect(await screen.findByText("Sent. Ana answers in your messages.")).toBeInTheDocument();
    expect(posted).toEqual([{ text: "Yes, bring options." }]);
  });

  it("leaves out what is empty when nothing is going on yet", async () => {
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview(),
      "GET /api/table": () => tableView(),
    });
    renderAt("/", api);
    expect(await screen.findByText(/No agents yet/)).toBeInTheDocument();
    expect(screen.queryByTestId("home-week-line")).toBeNull();
    expect(screen.queryByTestId("table-desk")).toBeNull();
    expect(screen.queryByTestId("table-latest")).toBeNull();
    expect(screen.queryByTestId("table-lead")).toBeNull();
    expect(screen.queryByTestId("home-weekly")).toBeNull();
  });
});

describe("Home's account check", () => {
  it("lists the findings that need the client under Needs you, with their steps", async () => {
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview({ summary: SUMMARY, findings: [FINDING] }),
      "GET /api/table": () => tableView(),
    });
    renderAt("/", api);
    const card = await screen.findByTestId(`portal-finding-${FINDING.id}`);
    expect(screen.getByTestId("table-desk")).toContainElement(card);
    expect(within(card).getByText(FINDING.title)).toBeInTheDocument();
    const steps = within(card)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(steps).toEqual(FINDING.steps);
    // A reminder says so in words (signal, with a word).
    expect(within(card).getByText("Reminder")).toBeInTheDocument();
    // The daily check's counts repeat other pages: they are not on Home.
    expect(screen.queryByTestId("portal-health")).toBeNull();
  });

  it("shows no Needs you when nothing needs you", async () => {
    const good = { ...SUMMARY, state: "good", runs: { total: 1, failed: 0 } };
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview({ summary: good, findings: [] }),
      "GET /api/table": () => tableView(),
    });
    renderAt("/", api);
    expect(await screen.findByTestId("home-agents")).toBeInTheDocument();
    await waitFor(() => expect(api.calls).toContain("GET /api/overview"));
    expect(screen.queryByTestId("table-desk")).not.toBeInTheDocument();
  });

  it("reads in the client's language", async () => {
    const api = fakeApi({
      ...base,
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        language: { effective: "es", user: null, client: "es" },
      }),
      "GET /api/overview": () =>
        overview({
          summary: SUMMARY,
          findings: [{ ...FINDING, title: "Zoho CRM necesita que inicie sesión de nuevo" }],
        }),
      "GET /api/table": () => TABLE,
    });
    renderAt("/", api);
    expect(await screen.findByText("Sus agentes")).toBeInTheDocument();
    expect(screen.getByText("Le necesita")).toBeInTheDocument();
    expect(await screen.findByText("Recordatorio")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Revisar y aprobar" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Añadir documentos" })).toBeInTheDocument();
  });

  it("a finding in the Inbox lists its steps and is closed with Done", async () => {
    const item = {
      id: FINDING.id,
      kind: "review",
      title: FINDING.title,
      payload: {
        fingerprint: "connection_signin:x",
        finding: { kind: "connection_signin", steps: FINDING.steps, reminders: 0 },
      },
      status: "open",
      runId: null,
      dueAt: null,
      createdAt: FINDING.createdAt,
      resolvedAt: null,
      resolvedBy: null,
    };
    const sent: unknown[] = [];
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview({ summary: null, findings: [] }),
      "GET /api/inbox": () => ({ items: [item] }),
      [`POST /api/inbox/${FINDING.id}/resolve`]: async ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return { item: { ...item, status: "resolved", resolvedAt: FINDING.createdAt } };
      },
    });
    renderAt("/inbox", api);
    const steps = await screen.findByTestId("desk-steps");
    expect(within(steps).getAllByRole("listitem")).toHaveLength(3);
    // Nothing internal is listed as a fact: the fingerprint and the finding's state are plumbing.
    expect(screen.queryByText(/connection_signin:x/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("desk-sign")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("desk-done"));
    expect(sent).toEqual([{ decision: "approve" }]);
  });
});
