// C2 the agent page (`/agents/:id`): what it does, the run going now step by step, this month,
// what it can reach, its reports and history; the client admin pauses and resumes it (a pause we
// made is ours to lift); Run now starts a workflow from its form. Never a bundle or a cost.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi, Reply, tableService, tableView } from "../../test/fixtures";
import { formFields } from "./Agent";

const SVC = "00000000-0000-4000-8000-00000000b001";
const RUN = "00000000-0000-4000-8000-0000000f1001";
const OLD_RUN = "00000000-0000-4000-8000-0000000f1000";
const QBO = "00000000-0000-4000-8000-0000000a1001";
const NEW_RUN = "00000000-0000-4000-8000-0000000f1009";

const runs = (o: Partial<Record<string, number>> = {}) => ({
  total: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  waiting: 0,
  going: 0,
  ...o,
});

const DETAIL = {
  service: {
    id: SVC,
    name: "Pia",
    description: "Checks every vendor invoice against your price history.",
    status: "active",
    instructions: "never shown",
  },
  thisMonth: {
    from: "2026-11-01",
    to: "2026-11-04",
    runs: runs({ total: 2, succeeded: 1, waiting: 1 }),
    documentsRead: 3,
    actions: 1,
    costUsd: "0.4000",
  },
  recentRuns: [
    {
      id: OLD_RUN,
      service: { id: SVC, name: "Pia" },
      status: "succeeded",
      startedAt: "2026-11-03T10:00:00.000Z",
      finishedAt: "2026-11-03T10:03:00.000Z",
    },
  ],
  packs: [],
};

const TABLE = tableView({
  services: [
    tableService(SVC, "Pia", {
      now: {
        runId: RUN,
        status: "running",
        step: { index: 2, total: 3, label: "Match items" },
        since: "2026-11-06T09:08:00.000Z",
        waitingOnYou: false,
      },
    }),
  ],
  recent: [
    {
      runId: RUN,
      service: { id: SVC, name: "Pia" },
      label: "Read the invoice",
      summary: "Read 14 line items",
      sources: [],
      at: "2026-11-06T09:09:00.000Z",
    },
    {
      runId: OLD_RUN,
      service: { id: SVC, name: "Pia" },
      label: "Looked for the bill",
      summary: "Looked for the bill in QuickBooks",
      sources: [],
      at: "2026-11-03T10:01:00.000Z",
    },
    {
      runId: OLD_RUN,
      service: { id: SVC, name: "Pia" },
      label: "Checked the bill",
      summary: "Checked the bill against the invoice",
      sources: [],
      at: "2026-11-03T10:02:00.000Z",
    },
  ],
});

const RUN_VIEW = {
  run: {
    id: RUN,
    service: { id: SVC, name: "Pia" },
    status: "running",
    startedAt: "2026-11-06T09:08:00.000Z",
    finishedAt: null,
  },
  steps: [
    {
      id: "s1",
      label: "Read the invoice",
      status: "succeeded",
      summary: "14 of 14 read",
      sources: [],
      startedAt: "2026-11-06T09:08:00.000Z",
      finishedAt: "2026-11-06T09:09:00.000Z",
    },
    {
      id: "s2",
      label: "Match items",
      status: "running",
      summary: null,
      sources: [],
      startedAt: "2026-11-06T09:09:00.000Z",
      finishedAt: null,
    },
    {
      id: "s3",
      label: "Update item costs",
      status: "pending",
      summary: null,
      sources: [],
      startedAt: null,
      finishedAt: null,
    },
  ],
  approvals: [],
  actions: [],
};

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
          agentId: SVC,
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

const control = (pause: unknown = null) => ({
  services: [
    {
      id: SVC,
      name: "Pia",
      status: pause ? "paused" : "active",
      stage: "live",
      pause,
      accountAgent: false,
    },
  ],
});

const base = {
  "GET /api/session": () => ({ ...CLIENT_SESSION, lead: { name: "Ana Ruiz" } }),
  "GET /api/overview": () => new Reply(404, {}),
  "GET /api/feedback/status": () => ({ enabled: false }),
  [`GET /api/services/${SVC}`]: () => DETAIL,
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

describe("the agent page", () => {
  it("shows what it does, its run now, this month, what it can reach and its history", async () => {
    const api = fakeApi({
      ...base,
      "GET /api/table": () => TABLE,
      [`GET /api/runs/${RUN}`]: () => RUN_VIEW,
      "GET /api/access": () => ACCESS,
      "GET /api/controls": () => control(),
      [`GET /api/services/${SVC}/view`]: () => ({
        service: { id: SVC, name: "Pia" },
        kpis: [
          {
            id: "k1",
            label: "Overcharges caught",
            period: "month",
            format: "money",
            value: "3940.00",
            display: "$3,940.00",
            currency: "USD",
            sources: [],
            from: "2026-11-01",
            to: "2026-11-04",
          },
        ],
        panels: [],
      }),
    });
    const { container } = renderAt(`/agents/${SVC}`, api);
    expect(await screen.findByRole("heading", { name: "Pia" })).toBeInTheDocument();
    expect(screen.getByText(DETAIL.service.description)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("agent-state")).toHaveTextContent("Working"));
    expect(screen.getByTestId("agent-lead")).toHaveTextContent("Ana Ruiz");
    expect(screen.getByRole("link", { name: "Ask Sloan" })).toHaveAttribute("href", "/sloan");
    expect(screen.getByRole("link", { name: "Open the Weekly Table" })).toHaveAttribute(
      "href",
      "/weekly",
    );

    // Right now: the run's steps, done, current and still to do.
    const steps = await screen.findByTestId("agent-now-steps");
    const items = within(steps).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-state"))).toEqual(["done", "current", "todo"]);
    expect(items[0]).toHaveTextContent("14 of 14 read");
    expect(screen.getByTestId("agent-now")).toHaveTextContent("Step 2 of 3");
    expect(
      within(screen.getByTestId("agent-now")).getByRole("link", { name: "Open the run" }),
    ).toHaveAttribute("href", `/runs/${RUN}`);
    // Latest work: finished runs only (the live run is above), newest first.
    const latest = screen.getByTestId("agent-latest");
    expect(latest).not.toHaveTextContent("Read 14 line items");
    expect(latest.textContent?.indexOf("Checked the bill")).toBeLessThan(
      latest.textContent?.indexOf("Looked for the bill") ?? -1,
    );

    // This month: its KPIs, then runs, documents and changes.
    expect(await screen.findByTestId("agent-kpi-k1")).toHaveTextContent(
      "$3,940.00Overcharges caught",
    );
    expect(screen.getByTestId("portal-service-runs")).toHaveTextContent(
      "2Runs1 done, 1 waiting on you",
    );
    expect(screen.getByTestId("portal-service-documents")).toHaveTextContent("3");

    // What it can reach, verb by verb; changes are made on the vault page.
    const reach = await screen.findByTestId(`agent-reach-${QBO}`);
    expect(within(reach).getByTestId(`agent-reach-${QBO}-read`)).toHaveTextContent(
      "Read: on its own",
    );
    expect(within(reach).getByTestId(`agent-reach-${QBO}-update`)).toHaveTextContent(
      "Update: your sign",
    );
    expect(within(reach).getByTestId(`agent-reach-${QBO}-delete`)).toHaveTextContent("Delete: off");
    expect(
      within(screen.getByTestId("agent-reach")).getByRole("link", { name: "Change" }),
    ).toHaveAttribute("href", "/accounts#vault");

    const row = screen.getByTestId(`portal-service-run-${OLD_RUN}`);
    expect(within(row).getByRole("link")).toHaveAttribute("href", `/runs/${OLD_RUN}`);
    expect(row).toHaveTextContent("Took 3 min");
    expect(row).toHaveTextContent("Done");
    expect(
      within(screen.getByTestId("portal-service-reports")).getByRole("link", { name: "Activity" }),
    ).toHaveAttribute("href", `/reports?service=${SVC}`);
    // Never the bundle, the instructions or the cost.
    expect(container.textContent).not.toMatch(/0\.4000|never shown/);
  });

  // QA round 1: the header, Right now and History agree on a run waiting on your approval.
  it("shows a run waiting on your approval as waiting on you everywhere, with its wait apart", async () => {
    const waiting = {
      id: RUN,
      service: { id: SVC, name: "Pia" },
      status: "running",
      startedAt: "2026-11-05T23:44:00.000Z",
      finishedAt: null,
      waitingOnYou: true,
      waitedMs: 21 * 3_600_000,
    };
    const api = fakeApi({
      ...base,
      "GET /api/table": () =>
        tableView({
          services: [
            tableService(SVC, "Pia", {
              now: {
                runId: RUN,
                status: "running",
                step: { index: 3, total: 4, label: "Itemize the bill" },
                since: "2026-11-06T00:44:00.000Z",
                waitingOnYou: true,
              },
              runsNow: { running: 0, waitingOnYou: 1 },
            }),
          ],
        }),
      [`GET /api/services/${SVC}`]: () => ({
        ...DETAIL,
        recentRuns: [
          waiting,
          {
            ...DETAIL.recentRuns[0],
            startedAt: "2026-11-03T10:00:00.000Z",
            finishedAt: "2026-11-04T08:00:00.000Z",
            waitingOnYou: false,
            waitedMs: 21 * 3_600_000,
          },
        ],
      }),
      [`GET /api/runs/${RUN}`]: () => ({ ...RUN_VIEW, run: waiting }),
      "GET /api/access": () => ACCESS,
      "GET /api/controls": () => control(),
    });
    renderAt(`/agents/${SVC}`, api);
    await waitFor(() =>
      expect(screen.getByTestId("agent-state")).toHaveTextContent("Waiting on you"),
    );
    expect(await screen.findByTestId("agent-now-state")).toHaveTextContent("Waiting on you");
    const row = screen.getByTestId(`portal-service-run-${RUN}`);
    expect(within(row).getByTestId(`portal-service-run-${RUN}-state`)).toHaveAttribute(
      "data-state",
      "waiting",
    );
    expect(row).not.toHaveTextContent("Running");
    // Took is the working time: 22 h in all, 21 of them waiting on you.
    const old = screen.getByTestId(`portal-service-run-${OLD_RUN}`);
    expect(old).toHaveTextContent("Took 1 h");
    expect(old).toHaveTextContent("Waited 21 h on you");
  });

  it("still shows the agent when only its own route answers", async () => {
    const api = fakeApi(base);
    renderAt(`/services/${SVC}`, api);
    expect(await screen.findByRole("heading", { name: "Pia" })).toBeInTheDocument();
    expect(screen.getByTestId("agent-state")).toHaveTextContent("Ready");
    expect(screen.getByTestId("agent-now")).toHaveTextContent("Nothing running now.");
    expect(screen.queryByTestId("agent-reach")).toBeNull();
  });

  it("shows not found for an agent that isn't the client's", async () => {
    const api = fakeApi({
      ...base,
      [`GET /api/services/${SVC}`]: () =>
        new Reply(404, { error: { code: "not_found", message: "service not found" } }),
    });
    renderAt(`/agents/${SVC}`, api);
    expect(await screen.findByText("Not found.")).toBeInTheDocument();
  });

  it("lets the client admin pause it with a reason, and resume their own pause", async () => {
    const sent: { path: string; body: unknown }[] = [];
    let pause: unknown = null;
    const api = fakeApi({
      ...base,
      "GET /api/table": () => TABLE,
      "GET /api/controls": () => control(pause),
      [`POST /api/services/${SVC}/pause`]: ({ init }) => {
        const body = JSON.parse(String(init.body));
        sent.push({ path: "pause", body });
        pause = {
          side: "client",
          reason: body.reason,
          at: "2026-11-06T10:00:00.000Z",
          until: null,
          canResume: true,
        };
        return { service: control(pause).services[0] };
      },
      [`POST /api/services/${SVC}/resume`]: () => {
        sent.push({ path: "resume", body: null });
        pause = null;
        return { service: control().services[0] };
      },
    });
    renderAt(`/agents/${SVC}`, api);
    await userEvent.click(await screen.findByTestId("agent-pause"));
    expect(screen.getByTestId("agent-pause-confirm")).toBeDisabled();
    await userEvent.type(screen.getByTestId("agent-pause-reason"), "Year-end close");
    await userEvent.click(screen.getByTestId("agent-pause-confirm"));
    expect(await screen.findByTestId("agent-paused")).toHaveTextContent(
      "Paused by you: Year-end close",
    );
    await userEvent.click(screen.getByTestId("agent-resume"));
    await waitFor(() => expect(screen.queryByTestId("agent-paused")).toBeNull());
    expect(sent).toEqual([
      { path: "pause", body: { reason: "Year-end close" } },
      { path: "resume", body: null },
    ]);
  });

  it("doesn't offer to resume a pause we made", async () => {
    const api = fakeApi({
      ...base,
      "GET /api/controls": () =>
        control({
          side: "operator",
          reason: "Checking a vendor mapping",
          at: "2026-11-06T10:00:00.000Z",
          until: null,
          canResume: false,
        }),
    });
    renderAt(`/agents/${SVC}`, api);
    const notice = await screen.findByTestId("agent-paused");
    expect(notice).toHaveTextContent("Paused by us: Checking a vendor mapping");
    expect(notice).toHaveTextContent("We paused it. Ask your lead to resume it.");
    expect(screen.queryByTestId("agent-resume")).toBeNull();
    expect(screen.queryByTestId("agent-pause")).toBeNull();
  });

  it("gives a client user no pause, and never asks for the controls", async () => {
    const api = fakeApi({
      ...base,
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        tenants: [
          { id: CLIENT_SESSION.activeTenantId ?? "", name: "Demo client", role: "client_user" },
        ],
      }),
    });
    renderAt(`/agents/${SVC}`, api);
    await screen.findByRole("heading", { name: "Pia" });
    expect(screen.queryByTestId("agent-pause")).toBeNull();
    expect(api.calls).not.toContain("GET /api/controls");
  });

  it("starts a workflow from its form with Run now", async () => {
    const posted: unknown[] = [];
    const api = fakeApi({
      ...base,
      [`GET /api/services/${SVC}/run-forms`]: () => ({
        forms: [
          {
            workflow: "check-quote",
            label: "Check a quote",
            input: {
              type: "object",
              properties: { vendor: { type: "string", title: "Vendor" } },
              required: ["vendor"],
            },
          },
          // A form we can't draw yet is left out.
          {
            workflow: "bulk",
            label: "Bulk",
            input: { type: "object", properties: { rows: { type: "array" } } },
          },
        ],
      }),
      [`POST /api/services/${SVC}/workflows/check-quote/run`]: ({ init }) => {
        posted.push(JSON.parse(String(init.body)));
        return { runId: NEW_RUN };
      },
    });
    renderAt(`/agents/${SVC}`, api);
    const card = await screen.findByTestId("agent-run-now");
    expect(within(card).queryByText("Bulk")).toBeNull();
    await userEvent.type(within(card).getByRole("textbox", { name: "Vendor" }), "Rugby");
    await userEvent.click(within(card).getByTestId("agent-run-check-quote"));
    expect(await within(card).findByRole("link", { name: "Open the run" })).toHaveAttribute(
      "href",
      `/runs/${NEW_RUN}`,
    );
    expect(posted).toEqual([{ input: { vendor: "Rugby" } }]);
  });

  it("reads in the client's language", async () => {
    const api = fakeApi({
      ...base,
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        language: { effective: "de", user: "de", client: null },
      }),
      "GET /api/table": () => TABLE,
      "GET /api/access": () => ACCESS,
    });
    renderAt(`/agents/${SVC}`, api);
    await waitFor(() => expect(screen.getByTestId("agent-state")).toHaveTextContent("Arbeitet"));
    expect(await screen.findByTestId(`agent-reach-${QBO}-update`)).toHaveTextContent(
      "Ändern: mit Ihrer Unterschrift",
    );
    expect(screen.getByText("Verlauf")).toBeInTheDocument();
  });
});

describe("run forms", () => {
  it("draws plain fields and leaves out anything else", () => {
    expect(formFields({})).toEqual([]);
    expect(
      formFields({
        properties: {
          a: { type: "string" },
          b: { type: "integer", title: "Count" },
          c: { type: "boolean" },
          d: { enum: ["x", "y"] },
        },
        required: ["b"],
      }),
    ).toEqual([
      { key: "a", label: "a", kind: "text", choices: [], required: false },
      { key: "b", label: "Count", kind: "number", choices: [], required: true },
      { key: "c", label: "c", kind: "boolean", choices: [], required: false },
      { key: "d", label: "d", kind: "choice", choices: ["x", "y"], required: false },
    ]);
    expect(formFields({ properties: { rows: { type: "array" } } })).toBeNull();
  });
});
