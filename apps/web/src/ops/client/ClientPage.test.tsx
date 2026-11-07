// The back-office client page (UI-3b): its frame and tabs, the Overview (figures, go-live stages,
// the lead and threads), the Agents tab, the Exports tab, and the clients list.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { AGENT_SUMMARY, fakeApi, OPERATOR_SESSION, SANDBOX_DETAIL } from "../../test/fixtures";
import { lastMonth } from "./ClientExports";

const CLIENT = SANDBOX_DETAIL.client.id;
const AGENT = AGENT_SUMMARY.id;
const OPERATOR = "00000000-0000-4000-8000-00000000d001";
const EXPORT = "00000000-0000-4000-8000-00000000e101";

const DETAIL = {
  ...SANDBOX_DETAIL,
  client: { ...SANDBOX_DETAIL.client, name: "Harbor Millwork", timezone: "America/Chicago" },
  agents: [
    AGENT_SUMMARY,
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
  it("opens on the Overview: figures, go-live stages, threads, and sets the lead", async () => {
    const leads: unknown[] = [];
    let lead: { userId: string; name: string; email: string } | null = null;
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${CLIENT}`]: () => DETAIL,
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
      "GET /api/ops/agents/00000000-0000-4000-8000-00000000b002/go-live": () => goLive("bench"),
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
    expect(within(page).getByText("1 of 2 agents live · America/Chicago")).toBeInTheDocument();
    const tabs = within(screen.getByTestId("ops-client-tabs")).getAllByRole("link");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Overview",
      "Agents",
      "Connections",
      "Messaging",
      "Knowledge",
      "Directory",
      "Documents",
      "Records",
      "Settings",
      "Exports",
    ]);
    expect(screen.getByTestId("ops-client-runs")).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/runs`,
    );

    expect(screen.getByTestId("ops-client-stat-live")).toHaveTextContent("1");
    expect(screen.getByTestId("ops-client-stat-connections")).toHaveTextContent("All connected");
    await waitFor(() =>
      expect(screen.getByTestId("ops-client-stat-waiting")).toHaveTextContent("Open escalations"),
    );
    expect(screen.getByTestId("ops-client-waiting")).toHaveTextContent("Baltic birch 3/4");

    const trial = await screen.findByTestId("ops-client-stage-material-costs");
    expect(await within(trial).findByText("Day 3 of 14 · 12 of 20 live runs")).toBeVisible();
    expect(within(trial).getByRole("progressbar")).toHaveAttribute(
      "aria-label",
      "Stage 2 of 4: Trial",
    );
    const bench = screen.getByTestId("ops-client-stage-collections");
    expect(await within(bench).findByText("Bench")).toBeInTheDocument();

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
    });
    renderAt(`/ops/clients/${CLIENT}/agents`, api);
    const list = await screen.findByTestId("ops-client-agents", {}, { timeout: 10_000 });
    const live = within(list).getByTestId("ops-agent-card-material-costs");
    expect(live).toHaveTextContent("Running");
    expect(live).toHaveTextContent("qbo");
    expect(within(live).getByRole("link", { name: /Material costs/ })).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/agents/material-costs`,
    );
    expect(within(list).getByTestId("ops-agent-card-collections")).toHaveTextContent("Not started");
    expect(screen.getByTestId("ops-client-agents-section")).toHaveTextContent(
      "1 live · 1 not live yet",
    );
    expect(screen.getByTestId("ops-client-new-agent")).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/agents/new`,
    );
  });

  it("starts a data export with a reason, and downloads the accountant export", async () => {
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
    renderAt(`/ops/clients/${CLIENT}/exports`, api);

    const table = await screen.findByTestId("ops-client-exports-table", {}, { timeout: 10_000 });
    const row = within(table).getByTestId(`ops-client-export-${EXPORT}`);
    expect(row).toHaveTextContent("Ready");
    expect(row).toHaveTextContent("2.3 MB");
    expect(within(row).getByTestId(`ops-client-export-download-${EXPORT}`)).toHaveAttribute(
      "href",
      "https://files.example.com/export.zip",
    );

    await userEvent.type(screen.getByTestId("ops-client-export-reason"), "Leaving us");
    await userEvent.click(screen.getByTestId("ops-client-export-start"));
    await waitFor(() => expect(started).toEqual([{ reason: "Leaving us" }]));

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
