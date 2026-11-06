// C1 The Table (`/`): each agent and what it is doing now, the week's figures, the latest step
// summaries, the top of the Desk with "Not now", the lead's note with a reply, and the
// supervisor's account check (docs/plan.md §1.28) with its findings. Never a bundle or a cost.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi, tableService, tableView } from "../../test/fixtures";
import { tomorrowMorning } from "./Table";

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
  figures: { runsDone: 38, changes: { automatic: 52, signed: 12 } },
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

describe("The Table", () => {
  it("shows each agent now, the week's figures, the latest work and what waits on you", async () => {
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview(),
      "GET /api/table": () => TABLE,
      "GET /api/access": () => ACCESS,
    });
    const { container } = renderAt("/", api);
    expect(
      await screen.findByRole("heading", { name: /^Good (morning|afternoon|evening), Dana$/ }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("table-week-line")).toHaveTextContent(
      "Your agents finished 38 runs this week. 5 things wait on you.",
    );

    const working = screen.getByTestId("table-working");
    expect(working).toHaveTextContent("1 running · 1 waiting on you · 1 setting up");
    const pia = within(working).getByTestId(`portal-service-${PIA}`);
    expect(pia).toHaveAttribute("href", `/agents/${PIA}`);
    expect(within(pia).getByTestId(`table-agent-state-${PIA}`)).toHaveTextContent("Running");
    expect(pia).toHaveTextContent("Match items to your catalog");
    expect(pia).toHaveTextContent("Step 3 of 6 · started");
    expect(within(pia).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "3");
    expect(pia).toHaveTextContent("9 runs done this week");
    // Its tools are the connections it is granted.
    expect(await within(pia).findByText("QuickBooks Online")).toBeInTheDocument();

    const cole = within(working).getByTestId(`portal-service-${COLE}`);
    expect(within(cole).getByTestId(`table-agent-state-${COLE}`)).toHaveAttribute(
      "data-state",
      "waiting",
    );
    expect(cole).toHaveTextContent("Waiting on you");
    expect(cole).toHaveTextContent("Overdue: $18,420.00");
    expect(cole).toHaveTextContent("waiting since");
    expect(within(working).getByText("Setting up")).toBeInTheDocument();

    expect(screen.getByTestId("table-stat-runs")).toHaveTextContent("38");
    expect(screen.getByTestId("table-stat-changes")).toHaveTextContent(
      "6452 automatic, 12 signed by you",
    );
    expect(screen.getByTestId("table-stat-waiting")).toHaveTextContent("5On your Desk");

    const latest = screen.getByTestId(`table-latest-${RUN}`);
    expect(within(latest).getByRole("link")).toHaveAttribute("href", `/runs/${RUN}`);
    expect(latest).toHaveTextContent('Pia Found Baltic birch 3/4" up 12% at Rugby Architectural');

    const desk = screen.getByTestId("table-desk");
    const first = within(desk).getByTestId(`table-desk-item-${ITEM}`);
    expect(first).toHaveTextContent("Due today");
    // The Table never signs: its main action opens the Desk.
    expect(within(first).getByRole("link", { name: "Review and sign" })).toHaveAttribute(
      "href",
      "/desk",
    );
    expect(
      within(within(desk).getByTestId(`table-desk-item-${ITEM_2}`)).getByRole("link", {
        name: "Open",
      }),
    ).toHaveAttribute("href", "/desk");
    expect(within(desk).getByRole("link", { name: "3 more on your Desk" })).toHaveAttribute(
      "href",
      "/desk",
    );

    expect(screen.getByTestId("table-lead")).toHaveTextContent(
      "Rugby raised birch prices twice this quarter.",
    );
    expect(screen.queryByText(/bundle|instructions|prompt|cost/i)).toBeNull();
    expect(container.textContent).not.toMatch(/costUsd/);
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

  it("says when nothing is going on yet", async () => {
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview(),
      "GET /api/table": () => tableView(),
    });
    renderAt("/", api);
    expect(await screen.findByText(/No services yet/)).toBeInTheDocument();
    expect(screen.getByTestId("table-week-line")).toHaveTextContent("Nothing waits on you.");
    expect(screen.getByTestId("table-latest")).toHaveTextContent("Nothing yet this week.");
    expect(screen.queryByTestId("table-lead")).toBeNull();
  });
});

describe("the Table's account check", () => {
  it("shows the latest check and the findings that need the client, with their steps", async () => {
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview({ summary: SUMMARY, findings: [FINDING] }),
      "GET /api/table": () => tableView(),
    });
    renderAt("/", api);
    const findings = await screen.findByTestId("portal-findings");
    expect(within(findings).getByText("What needs you now")).toBeInTheDocument();
    const card = within(findings).getByTestId(`portal-finding-${FINDING.id}`);
    expect(within(card).getByText(FINDING.title)).toBeInTheDocument();
    const steps = within(card)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(steps).toEqual(FINDING.steps);
    // A reminder says so in words (signal, with a word).
    expect(within(card).getByText("Reminder")).toBeInTheDocument();

    const health = screen.getByTestId("portal-health");
    expect(within(health).getByTestId("portal-health-state")).toHaveTextContent("Needs a look");
    expect(health).toHaveTextContent("12 runs in the last day · 1 did not finish");
    expect(health).toHaveTextContent("1 connection needs you");
    expect(health).toHaveTextContent("2 items wait for you");
  });

  it("says all is good, and shows nothing at all before the first check", async () => {
    const good = { ...SUMMARY, state: "good", runs: { total: 1, failed: 0 } };
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview({ summary: good, findings: [] }),
      "GET /api/table": () => tableView(),
    });
    const { unmount } = renderAt("/", api);
    expect(await screen.findByTestId("portal-health-state")).toHaveTextContent("All good");
    expect(screen.getByTestId("portal-health")).toHaveTextContent("1 run in the last day");
    expect(screen.queryByTestId("portal-findings")).not.toBeInTheDocument();
    unmount();

    // An API without the supervisor (or before its first check): no check on the Table.
    const none = fakeApi({
      ...base,
      "GET /api/overview": () => overview(undefined),
      "GET /api/table": () => tableView(),
    });
    renderAt("/", none);
    expect(await screen.findByTestId("table-desk")).toBeInTheDocument();
    expect(screen.queryByTestId("portal-health")).not.toBeInTheDocument();
    expect(screen.queryByTestId("portal-findings")).not.toBeInTheDocument();
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
    expect(await screen.findByText("Lo que le necesita ahora")).toBeInTheDocument();
    expect(screen.getByText("Revisión de la cuenta")).toBeInTheDocument();
    expect(screen.getByTestId("portal-health-state")).toHaveTextContent("Necesita atención");
    expect(screen.getByText("Recordatorio")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Revisar y firmar" })).toBeInTheDocument();
    expect(screen.getByText("Trabajando ahora")).toBeInTheDocument();
  });

  it("a finding on the Desk lists its steps and is closed with Done", async () => {
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
