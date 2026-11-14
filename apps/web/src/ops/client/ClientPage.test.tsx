// The back-office client page: its frame and five tabs (Data and Setup with a switch between
// their pages), the Overview (what waits, go-live stages, runs, the lead and threads), the Agents
// tab, Settings' Exports section, every old address, and the clients list.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { AGENT_SUMMARY, fakeApi, OPERATOR_SESSION, SANDBOX_DETAIL } from "../../test/fixtures";
import { supervisorLine } from "../screens/ClientHealth";
import { lastMonth } from "./ClientExports";
import { clientPageOf } from "./ClientFrame";

const CLIENT = SANDBOX_DETAIL.client.id;
const AGENT = AGENT_SUMMARY.id;
const OPERATOR = "00000000-0000-4000-8000-00000000d001";
const EXPORT = "00000000-0000-4000-8000-00000000e101";

const DETAIL = {
  ...SANDBOX_DETAIL,
  client: { ...SANDBOX_DETAIL.client, name: "Harbor Millwork", timezone: "America/Chicago" },
  agents: [
    { ...AGENT_SUMMARY, stage: "trial" },
    {
      ...AGENT_SUMMARY,
      id: "00000000-0000-4000-8000-00000000b002",
      slug: "collections",
      name: "Collections",
      liveVersionId: null,
      runStatus: "draft",
      bindings: {},
    },
  ],
  connections: [
    {
      id: "00000000-0000-4000-8000-00000000c001",
      tenantId: CLIENT,
      connector: "qbo",
      status: "connected",
      externalAccountId: null,
      config: {},
      permissions: { read: "auto", create: "approval", update: "approval", delete: "off" },
      lastSyncAt: null,
      connectedBy: null,
      createdAt: "2026-11-01T00:00:00.000Z",
    },
  ],
  members: [
    { userId: OPERATOR, email: "ana@mezonas.com", name: "Ana Ruiz", role: "operator" },
    {
      userId: "00000000-0000-4000-8000-00000000d002",
      email: "dana@harbor.example.com",
      name: "Dana",
      role: "client_admin",
    },
  ],
};

/** Each agent's work at a glance (`activity` on GET /api/ops/clients/:id). */
const ACTIVITY = [
  {
    agentId: AGENT,
    runs7d: 13,
    waitingRuns: 1,
    lastRun: {
      id: "00000000-0000-4000-8000-0000000f0001",
      status: "running",
      at: "2026-11-05T15:00:00.000Z",
      waiting: true,
    },
    perDay: Array.from({ length: 14 }, (_, i) => ({ runs: i % 3, failed: 0 })),
  },
  {
    agentId: "00000000-0000-4000-8000-00000000b002",
    runs7d: 0,
    waitingRuns: 0,
    lastRun: null,
    perDay: Array.from({ length: 14 }, () => ({ runs: 0, failed: 0 })),
  },
];

const goLive = (stage: string, extra: Record<string, unknown> = {}) => ({
  goLive: {
    stage,
    writes: true,
    trial: null,
    signoff: null,
    skipped: [],
    rejections: [],
    pause: null,
    ...extra,
  },
});

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("the client page", () => {
  it("keeps its header still across the tabs and loads the client once (1.4)", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${CLIENT}`]: () => ({ ...DETAIL, activity: ACTIVITY }),
      "GET /api/ops/clients": () => ({ clients: [] }),
      "GET /api/ops/inbox": () => ({ items: [], agents: [] }),
    });
    renderAt(`/ops/clients/${CLIENT}`, api);
    const title = await screen.findByRole("heading", { level: 1, name: "Harbor Millwork" });
    const tabs = within(screen.getByTestId("ops-client-tabs"));
    for (const tab of ["Agents", "Data", "Setup", "Packs", "Settings", "Overview"]) {
      await user.click(tabs.getByRole("link", { name: tab }));
      // The same heading element: the frame was not remounted.
      expect(screen.getByRole("heading", { level: 1, name: "Harbor Millwork" })).toBe(title);
    }
    // A tab's own intro and buttons still reach the frame's header (Agents' New agent).
    await user.click(tabs.getByRole("link", { name: "Agents" }));
    expect(await screen.findByTestId("ops-client-new-agent")).toBeInTheDocument();
    expect(api.calls.filter((c) => c === `GET /api/ops/clients/${CLIENT}`)).toHaveLength(1);
  });

  it("opens on the Overview: what waits, go-live stages, threads, and sets the lead", async () => {
    const leads: unknown[] = [];
    let lead: { userId: string; name: string; email: string } | null = null;
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${CLIENT}`]: () => ({ ...DETAIL, activity: ACTIVITY }),
      // The frame's clients list: Needs us and runs waiting per client.
      "GET /api/ops/clients": () => ({
        clients: [
          {
            id: CLIENT,
            name: "Harbor Millwork",
            timezone: "America/Chicago",
            createdAt: "2026-11-01T00:00:00.000Z",
            agents: 2,
            openInbox: 3,
            needsUs: 2,
            waitingRuns: 1,
          },
        ],
      }),
      // The sidebar counts every client's; the Overview asks for this client's.
      "GET /api/ops/inbox": ({ url }) => {
        if (url.searchParams.get("client") !== CLIENT) return { items: [], agents: [] };
        return {
          items: [
            {
              id: "00000000-0000-4000-8000-00000000f101",
              tenantId: CLIENT,
              kind: "review",
              agentId: AGENT,
              runId: null,
              subjectType: null,
              subjectId: null,
              assigneeRole: "operator",
              assigneeUserId: null,
              title: "Is CP/CP BB 3/4 the same item as Baltic birch 3/4?",
              payload: {},
              status: "open",
              resolution: null,
              resolvedBy: null,
              dueAt: null,
              createdAt: "2026-11-05T09:00:00.000Z",
              resolvedAt: null,
              resolvableByOperator: true,
            },
          ],
          agents: [],
        };
      },
      [`GET /api/ops/clients/${CLIENT}/health`]: () => ({
        supervisor: null,
        summary: null,
        findings: [],
      }),
      [`GET /api/ops/agents/${AGENT}/go-live`]: () =>
        goLive("trial", {
          trial: {
            startedAt: "2026-11-01T00:00:00.000Z",
            minDays: 14,
            minRuns: 20,
            days: 3,
            runs: 12,
            daysMetAt: "2026-11-15T00:00:00.000Z",
            ready: false,
          },
        }),
      "GET /api/ops/agents/00000000-0000-4000-8000-00000000b002/go-live": () =>
        goLive("bench", { liveVersion: false }),
      [`GET /api/ops/clients/${CLIENT}/threads`]: () => ({
        lead,
        threads: [
          {
            id: "00000000-0000-4000-8000-00000000f201",
            clientId: CLIENT,
            subjectType: "agent",
            subjectId: AGENT,
            title: "Baltic birch prices",
            status: "open",
            createdBy: null,
            agent: { id: AGENT, slug: "material-costs", name: "Material costs" },
            lastMessageAt: "2026-11-05T10:00:00.000Z",
            unread: 2,
            createdAt: "2026-11-04T10:00:00.000Z",
          },
        ],
      }),
      [`PUT /api/ops/clients/${CLIENT}/lead`]: ({ init }) => {
        const body = JSON.parse(String(init.body)) as { userId: string | null };
        leads.push(body);
        lead = { userId: OPERATOR, name: "Ana Ruiz", email: "ana@mezonas.com" };
        return { lead };
      },
    });
    renderAt(`/ops/clients/${CLIENT}`, api);

    const page = await screen.findByTestId("ops-client-page", {}, { timeout: 10_000 });
    expect(await within(page).findByRole("heading", { name: "Harbor Millwork" })).toBeVisible();
    // The slim KPI line: live means switched on and at the live stage (the trial agent is named
    // as such), its runs in 7 days, what needs us and what waits for approval.
    expect(within(page).getByTestId("ops-client-line")).toHaveTextContent(
      "0 of 2 agents live · 1 in trial · 13 live runs in 7 days · America/Chicago",
    );
    expect(within(page).getByTestId("ops-client-needs-us")).toHaveTextContent("Needs us 2");
    expect(within(page).getByTestId("ops-client-approvals")).toHaveTextContent(
      "1 waiting for approval",
    );
    const tabs = within(screen.getByTestId("ops-client-tabs")).getAllByRole("link");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Overview",
      "Agents",
      "Data",
      "Setup",
      "Packs",
      "Settings",
    ]);
    expect(tabs.map((t) => t.getAttribute("href"))).toEqual([
      `/ops/clients/${CLIENT}`,
      `/ops/clients/${CLIENT}/agents`,
      `/ops/clients/${CLIENT}/documents`,
      `/ops/clients/${CLIENT}/connections`,
      `/ops/clients/${CLIENT}/packs`,
      `/ops/clients/${CLIENT}/settings`,
    ]);
    // The client's runs: the Runs page filtered to it, from the Overview.
    expect(screen.getByTestId("ops-client-runs")).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/runs`,
    );
    // No figure tiles: the summary opens short.
    expect(screen.queryByTestId("ops-client-stat-live")).toBeNull();
    expect(await screen.findByTestId("ops-client-waiting")).toHaveTextContent("Baltic birch 3/4");
    // How many are live is the header's line, not repeated here.
    expect(screen.getByTestId("ops-client-go-live")).not.toHaveTextContent("of 2 live");
    // Billing is in Settings.
    expect(screen.queryByTestId("ops-client-billing")).toBeNull();

    const trial = await screen.findByTestId("ops-client-stage-material-costs");
    expect(await within(trial).findByText("Day 3 of 14 · 12 of 20 live runs")).toBeVisible();
    expect(within(trial).getByRole("progressbar")).toHaveAttribute(
      "aria-label",
      "Stage 2 of 4: Trial",
    );
    // Its work at a glance: runs in 7 days, the last run, what waits, and its 14 days; waiting
    // for approval, its accent is gold.
    expect(within(trial).getByTestId("ops-client-activity-material-costs")).toHaveTextContent(
      /^13 live runs in 7 days · Last run .+1 run waiting for approval$/,
    );
    expect(trial).toHaveAttribute("data-tone", "signal");
    expect(within(trial).getByTestId("ops-client-spark-material-costs")).toBeInTheDocument();
    const bench = screen.getByTestId("ops-client-stage-collections");
    expect(await within(bench).findByText("Bench")).toBeInTheDocument();
    // No live version yet: it says so, rather than "goes straight to live" (fix 2).
    expect(await within(bench).findByTestId("ops-client-stage-note")).toHaveTextContent(
      "No live version yet · test runs only",
    );
    expect(within(bench).getByTestId("ops-client-activity-collections")).toHaveTextContent(
      "No runs yet",
    );
    expect(bench).not.toHaveAttribute("data-tone");

    const threads = await screen.findByTestId("ops-client-threads");
    expect(await within(threads).findByText("Baltic birch prices")).toBeVisible();
    expect(within(threads).getAllByText("2 unread").length).toBeGreaterThan(0);

    const card = screen.getByTestId("ops-client-lead");
    expect(await within(card).findByText(/No lead yet/)).toBeVisible();
    await userEvent.selectOptions(within(card).getByTestId("ops-client-lead-choice"), OPERATOR);
    await userEvent.click(within(card).getByTestId("ops-client-lead-save"));
    await waitFor(() => expect(leads).toEqual([{ userId: OPERATOR, reason: "" }]));
    expect(await within(card).findByText("ana@mezonas.com")).toBeVisible();
  });

  it("lists the client's agents on the Agents tab, each opening its page", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${CLIENT}`]: () => DETAIL,
      "GET /api/connectors": () => ({
        connectors: [
          {
            id: "qbo",
            name: "QuickBooks Online",
            description: "",
            icon: "qbo",
            auth: "oauth2",
            entities: [],
            tools: [],
          },
        ],
      }),
    });
    renderAt(`/ops/clients/${CLIENT}/agents`, api);
    const list = await screen.findByTestId("ops-client-agents", {}, { timeout: 10_000 });
    const live = within(list).getByTestId("ops-agent-card-material-costs");
    expect(live).toHaveTextContent("Running");
    // Its tools by name, never the connector's id.
    expect(await within(live).findByText("QuickBooks Online")).toBeInTheDocument();
    expect(live).not.toHaveTextContent("qbo");
    expect(within(live).getByRole("link", { name: /Material costs/ })).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/agents/material-costs`,
    );
    expect(within(list).getByTestId("ops-agent-card-collections")).toHaveTextContent("Not started");
    // How many are live is said once, in the frame's line.
    expect(screen.getByTestId("ops-client-agents-section")).not.toHaveTextContent("not live yet");
    expect(screen.getByTestId("ops-client-new-agent")).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/agents/new`,
    );
  });

  it("starts a data export from Settings (no reason asked for), and downloads the accountant export", async () => {
    const started: unknown[] = [];
    const exports = [
      {
        id: EXPORT,
        status: "ready",
        requestedAt: "2026-11-02T10:00:00.000Z",
        requestedBy: { id: OPERATOR, email: "ana@mezonas.com" },
        reason: "Asked for by the client",
        finishedAt: "2026-11-02T10:05:00.000Z",
        files: 14,
        sizeBytes: 2_400_000,
        error: null,
        download: {
          url: "https://files.example.com/export.zip",
          filename: "harbor-export.zip",
          expiresAt: "2026-11-02T10:10:00.000Z",
        },
      },
    ];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${CLIENT}`]: () => DETAIL,
      [`GET /api/ops/clients/${CLIENT}/exports`]: () => ({
        exports,
        retiredAt: null,
        exportableUntil: null,
      }),
      [`POST /api/ops/clients/${CLIENT}/exports`]: ({ init }) => {
        started.push(JSON.parse(String(init.body)));
        return { ...exports[0], id: "00000000-0000-4000-8000-00000000e102", status: "running" };
      },
    });
    // The old Exports tab's address opens the Exports section of Settings.
    renderAt(`/ops/clients/${CLIENT}/exports`, api);

    const table = await screen.findByTestId("ops-client-exports-table", {}, { timeout: 10_000 });
    expect(
      within(screen.getByTestId("ops-client-settings-nav")).getByRole("link", { name: "Exports" }),
    ).toHaveAttribute("aria-current", "page");
    expect(table).not.toHaveTextContent("Asked for by the client");
    const row = within(table).getByTestId(`ops-client-export-${EXPORT}`);
    expect(row).toHaveTextContent("Ready");
    expect(row).toHaveTextContent("2.3 MB");
    expect(within(row).getByTestId(`ops-client-export-download-${EXPORT}`)).toHaveAttribute(
      "href",
      "https://files.example.com/export.zip",
    );

    expect(screen.queryByTestId("ops-client-export-reason")).toBeNull();
    await userEvent.click(screen.getByTestId("ops-client-export-start"));
    await waitFor(() => expect(started).toEqual([{}]));

    const { from, to } = lastMonth();
    const download = screen.getByTestId("ops-client-accountant-download");
    expect(download).toHaveAttribute(
      "href",
      `/api/ops/clients/${CLIENT}/exports/accountant?from=${from}&to=${to}&format=zip`,
    );
    await userEvent.selectOptions(screen.getByTestId("ops-client-accountant-format"), "csv");
    expect(screen.getByTestId("ops-client-accountant-download").getAttribute("href")).toContain(
      "format=csv",
    );
    const fromInput = screen.getByTestId("ops-client-accountant-from");
    await userEvent.clear(fromInput);
    await userEvent.type(fromInput, "2099-01-01");
    expect(screen.getByTestId("ops-client-accountant-problem")).toHaveTextContent(
      "The first day comes after the last.",
    );
    expect(screen.queryByTestId("ops-client-accountant-download")).toBeNull();
  });
});

describe("the client page's tabs and addresses", () => {
  it("knows which tab and page an address is on", () => {
    const at = (rest: string) => clientPageOf(`/ops/clients/${CLIENT}${rest}`, CLIENT);
    expect(at("")).toEqual({ tab: "overview", page: "" });
    expect(at("/agents")).toEqual({ tab: "agents", page: "agents" });
    expect(at("/records/abc")).toEqual({ tab: "data", page: "records" });
    expect(at("/documents")).toEqual({ tab: "data", page: "documents" });
    expect(at("/knowledge")).toEqual({ tab: "setup", page: "knowledge" });
    expect(at("/settings/people")).toEqual({ tab: "settings", page: "settings" });
    expect(at("/exports")).toEqual({ tab: "settings", page: "settings" });
  });

  it("shows Setup's switch on each of its pages, the page's own current", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${CLIENT}`]: () => DETAIL,
    });
    renderAt(`/ops/clients/${CLIENT}/directory`, api);
    const pages = await screen.findByTestId("ops-client-setup-pages", {}, { timeout: 10_000 });
    expect(
      within(pages)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Connections", "Messaging", "Directory", "Knowledge"]);
    expect(within(pages).getByRole("link", { name: "Directory" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const tabs = within(screen.getByTestId("ops-client-tabs")).getAllByRole("link");
    expect(tabs.find((t) => t.textContent === "Setup")?.className).toContain("border-slate");
    expect(screen.queryByTestId("ops-client-data-pages")).toBeNull();
  });

  it.each([
    ["data", "ops-client-data-pages", "Documents"],
    ["setup", "ops-client-setup-pages", "Connections"],
  ])("sends /%s to its first page", async (old, pagesId, first) => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${CLIENT}`]: () => DETAIL,
    });
    renderAt(`/ops/clients/${CLIENT}/${old}`, api);
    const pages = await screen.findByTestId(pagesId, {}, { timeout: 10_000 });
    expect(within(pages).getByRole("link", { name: first })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});

describe("the clients list", () => {
  it("totals the clients and opens each one's page", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/clients": () => ({
        clients: [
          {
            id: CLIENT,
            name: "Harbor Millwork",
            timezone: "America/Chicago",
            createdAt: "2026-03-01T00:00:00.000Z",
            agents: 3,
            openInbox: 2,
            needsUs: 1,
            waitingRuns: 1,
            runs24h: { total: 6, failed: 2 },
          },
          {
            id: "00000000-0000-4000-8000-00000000a002",
            name: "Sandbox",
            timezone: "UTC",
            createdAt: "2026-01-01T00:00:00.000Z",
            agents: 1,
            openInbox: 0,
            sandbox: true,
          },
        ],
      }),
    });
    renderAt("/ops/clients", api);
    const page = await screen.findByTestId("ops-clients-page", {}, { timeout: 10_000 });
    // One count per meaning, the same the sidebar's badges and the command center read.
    expect(
      await within(page).findByText(
        "2 clients · 4 agents · 1 needs us · 1 run waiting for approval",
      ),
    ).toBeVisible();
    // Cards first: the last day's runs and failures, coloured by the worst state.
    const card = within(page).getByTestId(`ops-client-card-${CLIENT}`);
    expect(card).toHaveAttribute("data-tone", "risk");
    expect(within(card).getByTestId(`ops-client-${CLIENT}-state`)).toHaveTextContent("Failed runs");
    expect(within(card).getByTestId(`ops-client-agents-${CLIENT}`)).toHaveTextContent("3Agents");
    expect(within(card).getByTestId(`ops-client-runs-${CLIENT}`)).toHaveTextContent("6Runs 24h");
    const failed = within(card).getByTestId(`ops-client-failed-${CLIENT}`);
    expect(failed).toHaveClass("ui-clientkpi--risk");
    expect(failed.getAttribute("href")).toContain("statuses=failed");
    expect(within(card).getByTestId(`ops-client-needs-${CLIENT}`)).toHaveClass(
      "ui-clientkpi--signal",
    );

    await userEvent.click(within(page).getByTestId("ops-clients-view-table"));
    const table = within(page).getByTestId("ops-clients-table");
    expect(within(table).getByTestId(`ops-client-${CLIENT}`)).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}`,
    );
    const needs = within(table).getByTestId(`ops-client-needs-${CLIENT}`);
    expect(within(needs).getByRole("link", { name: "1" })).toHaveAttribute(
      "href",
      `/ops/inbox?client=${CLIENT}`,
    );
    const waiting = within(table).getByTestId(`ops-client-waiting-${CLIENT}`);
    expect(within(waiting).getByRole("link", { name: "1" })).toHaveAttribute(
      "href",
      `/ops/runs?clients=${CLIENT}&statuses=waiting&mode=live`,
    );
    expect(within(table).getByText("Sandbox", { selector: "span" })).toBeInTheDocument();
    expect(within(page).getByTestId("ops-new-client")).toHaveAttribute("href", "/ops/clients/new");
  });
});

describe("the client's supervisor in words (fix 3 of the design pass)", () => {
  it("reads well whatever it is called", () => {
    expect(supervisorLine("Supervisor")).toBe(
      "The supervisor checks this client's runs, connections, logins, codes and waiting items every day. It changes nothing.",
    );
    expect(supervisorLine("the supervisor")).toMatch(/^The supervisor checks/);
    expect(supervisorLine("Sloan")).toMatch(/^Sloan, the supervisor, checks this client's runs/);
    expect(supervisorLine("Supervisor")).not.toMatch(/Supervisor, this client's supervisor/);
  });
});
