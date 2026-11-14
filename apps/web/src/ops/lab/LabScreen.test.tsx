// O2 Agent lab: a gallery of templates (first), drafts and client-only agents, as cards or a list,
// with a status filter and a plain-words search, each opening its own page; and the template's
// panels on that page: its lineage (merges to review, changes to promote), client view and
// Assign to a client.
import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { AGENT_DETAIL, AGENT_SUMMARY, fakeApi, versionId } from "../../test/fixtures";
import { LabScreen, useSlow } from "./LabScreen";
import { AssignToClient, ClientViewCard, WhereItRuns } from "./TemplateParts";

const TEMPLATE_ID = "00000000-0000-4000-8000-00000000f001";
const DRAFT_ID = "00000000-0000-4000-8000-00000000f002";
const FORK_ID = "00000000-0000-4000-8000-00000000b002";
const CLIENT_ID = "00000000-0000-4000-8000-00000000a002";

const labAgent = (id: string, slug: string, name: string, live: number | null, latest: number) => ({
  id,
  slug,
  name,
  kind: "template" as const,
  liveVersion: live,
  latestVersion: latest,
  latestVersionId: versionId(latest),
  liveVersionId: live ? versionId(live) : null,
});

const noTests = { cases: 0, live: null, latest: null };

const LAB = {
  published: [
    {
      agent: labAgent(TEMPLATE_ID, "purchasing", "Purchasing", 1, 2),
      clients: 3,
      behind: 1,
      maxBehind: 1,
      tests: {
        cases: 44,
        live: null,
        latest: {
          id: "00000000-0000-4000-8000-00000000d001",
          clientId: null,
          targetKind: "template",
          targetId: TEMPLATE_ID,
          versionId: versionId(2),
          version: 2,
          status: "done",
          total: 44,
          passed: 42,
          failed: 2,
          metrics: { passRate: 0.95, precision: 0.971, costPerCase: "0.11" },
          costUsd: "4.84",
          startedBy: null,
          createdAt: "2026-11-05T10:00:00.000Z",
          finishedAt: "2026-11-05T10:05:00.000Z",
        },
      },
    },
  ],
  drafts: [
    {
      agent: labAgent(DRAFT_ID, "card-receipts", "Card receipts", null, 1),
      clients: 0,
      behind: 0,
      maxBehind: 0,
      tests: noTests,
    },
  ],
  clientOnly: [
    {
      agent: { ...labAgent(FORK_ID, "job-costing", "Job costing", 1, 1), kind: "client" as const },
      client: { id: CLIENT_ID, name: "Ionic Order" },
    },
  ],
};

const TEMPLATE = {
  ...AGENT_SUMMARY,
  id: TEMPLATE_ID,
  kind: "template" as const,
  tenantId: null,
  slug: "purchasing",
  name: "Purchasing",
  role: "Invoice and quote price checks",
  bindings: {},
};

const USED_BY = {
  templateLiveVersion: 1,
  agents: [
    {
      agent: {
        ...AGENT_SUMMARY,
        id: FORK_ID,
        name: "Pia",
        templateId: TEMPLATE_ID,
        serviceName: "Purchasing",
      },
      client: { id: CLIENT_ID, name: "Ionic Order" },
      version: 3,
      baseVersion: 1,
      behind: 1,
      customizations: 2,
      conflicts: 0,
    },
  ],
};

function Probe() {
  const { pathname } = useLocation();
  return <span data-testid="location">{pathname}</span>;
}

function setup(path = "/ops/lab", page: React.ReactNode = <LabScreen />) {
  const forks: unknown[] = [];
  const api = fakeApi({
    "GET /api/ops/lab": () => LAB,
    "GET /api/ops/templates": () => ({ templates: [TEMPLATE] }),
    [`GET /api/ops/agents/${TEMPLATE_ID}`]: () => ({ ...AGENT_DETAIL, agent: TEMPLATE }),
    [`GET /api/ops/templates/${TEMPLATE_ID}/used-by`]: () => USED_BY,
    [`GET /api/ops/agents/${TEMPLATE_ID}/client-view`]: () => ({
      agent: { id: TEMPLATE_ID, kind: "template", tenantId: null },
      versionId: versionId(1),
      clientView: {
        kpis: [],
        panels: [
          { id: "price-watch", kind: "pack_report", pack: "materials", report: "price-watch" },
        ],
      },
      values: null,
    }),
    "GET /api/ops/clients": () => ({
      clients: [
        {
          id: CLIENT_ID,
          name: "Ionic Order",
          timezone: "UTC",
          createdAt: "2026-11-01T00:00:00.000Z",
          agents: 1,
          openInbox: 0,
        },
      ],
    }),
    [`POST /api/ops/templates/${TEMPLATE_ID}/fork`]: ({ init }) => {
      forks.push(JSON.parse(String(init.body)));
      return {
        agent: { ...AGENT_SUMMARY, id: FORK_ID, tenantId: CLIENT_ID, slug: "purchasing" },
        version: AGENT_DETAIL.versions[1],
      };
    },
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <ApiProvider client={api.client}>
        <Routes>
          <Route path="/ops/lab" element={page} />
          <Route path="*" element={null} />
        </Routes>
        <Probe />
      </ApiProvider>
    </MemoryRouter>,
  );
  return { api, forks, user: userEvent.setup() };
}

describe("useSlow", () => {
  // "Where it runs" never finished on staging: a panel still loading after 8 s says so, with Retry.
  it("turns true once loading lasts 8 s, and false when it stops", () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(({ loading }) => useSlow(loading), {
        initialProps: { loading: true },
      });
      expect(result.current).toBe(false);
      act(() => vi.advanceTimersByTime(8_000));
      expect(result.current).toBe(true);
      rerender({ loading: false });
      expect(result.current).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LabScreen", () => {
  it("starts with the templates as cards, each opening its own page", async () => {
    setup();
    const card = await screen.findByTestId("lab-template-purchasing");
    expect(card).toHaveAttribute("href", "/ops/templates/purchasing");
    expect(card).toHaveTextContent("Purchasing");
    expect(card).toHaveTextContent("Invoice and quote price checks");
    expect(card).toHaveTextContent("v1 · draft v2");
    // Its figures: clients, behind, and the latest test run (42 of 44 pass, so it reads failing).
    expect(card).toHaveTextContent("Clients3");
    expect(card).toHaveTextContent("Behind1");
    expect(card).toHaveTextContent("Tests42/44");
    expect(screen.getByTestId("lab-template-purchasing-state")).toHaveTextContent("Tests failing");
    expect(screen.getByTestId("lab-tab-templates")).toHaveTextContent("Templates · 1");
    expect(screen.getByTestId("lab-tab-drafts")).toHaveTextContent("Drafts · 1");
    expect(screen.getByTestId("lab-tab-client")).toHaveTextContent("Client-only · 1");
    expect(screen.getByTestId("lab-tab-all")).toHaveTextContent("All · 3");
    // Only templates at first: no detail panel beside them any more.
    expect(screen.queryByTestId("lab-template-card-receipts")).toBeNull();
    expect(screen.queryByTestId("lab-detail")).toBeNull();
  });

  it("shows drafts and client-only agents in their tabs", async () => {
    const { user } = setup();
    await user.click(await screen.findByTestId("lab-tab-drafts"));
    expect(screen.getByTestId("lab-template-card-receipts-state")).toHaveTextContent("Draft");
    expect(screen.getByTestId("lab-template-card-receipts")).toHaveTextContent("Draft v1");
    await user.click(screen.getByTestId("lab-tab-client"));
    const client = screen.getByTestId("lab-client-only-job-costing");
    expect(client).toHaveAttribute("href", `/ops/clients/${CLIENT_ID}/agents/job-costing`);
    expect(client).toHaveTextContent("Client-only · Ionic Order");
  });

  it("searches in plain words across every agent: a client, a state, a name", async () => {
    const { user } = setup("/ops/lab?tab=all");
    const search = await screen.findByTestId("lab-search");
    await user.type(search, "ionic");
    expect(screen.getByTestId("lab-client-only-job-costing")).toBeInTheDocument();
    expect(screen.queryByTestId("lab-template-purchasing")).toBeNull();

    await user.clear(search);
    await user.type(search, "behind purch");
    expect(screen.getByTestId("lab-template-purchasing")).toBeInTheDocument();
    expect(screen.queryByTestId("lab-client-only-job-costing")).toBeNull();

    await user.clear(search);
    await user.type(search, "nothing like this");
    expect(screen.getByText("No agent matches")).toBeInTheDocument();
    await user.click(screen.getByTestId("lab-clear"));
    expect(search).toHaveValue("");
    expect(screen.getByTestId("lab-template-card-receipts")).toBeInTheDocument();
  });

  it("filters by status", async () => {
    const { user } = setup("/ops/lab?tab=all");
    await user.selectOptions(await screen.findByTestId("lab-status"), "unused");
    expect(screen.getByTestId("lab-template-card-receipts")).toBeInTheDocument();
    expect(screen.queryByTestId("lab-template-purchasing")).toBeNull();
    await user.selectOptions(screen.getByTestId("lab-status"), "failing");
    expect(screen.getByTestId("lab-template-purchasing")).toBeInTheDocument();
    expect(screen.queryByTestId("lab-template-card-receipts")).toBeNull();
  });

  it("shows a list and opens an agent from anywhere on its row", async () => {
    const { user } = setup();
    await user.click(await screen.findByTestId("lab-view-list"));
    const row = screen.getByTestId("lab-template-purchasing-row");
    expect(row).toHaveTextContent("Template");
    expect(row).toHaveTextContent("42/44");
    await user.click(within(row).getByText("Template"));
    expect(screen.getByTestId("location")).toHaveTextContent("/ops/templates/purchasing");
    window.localStorage.removeItem("mezonas.lab.view");
  });
});

describe("a template's panels on its page", () => {
  it("lists its client copies with merges to review and changes to promote, and its client view", async () => {
    setup(
      "/ops/lab",
      <>
        <WhereItRuns templateId={TEMPLATE_ID} />
        <ClientViewCard agentId={TEMPLATE_ID} />
      </>,
    );
    const row = await screen.findByTestId(`lab-used-by-${FORK_ID}`);
    expect(row).toHaveTextContent("Ionic Order's copy · Purchasing");
    expect(row).toHaveTextContent("2 client changes");
    expect(row).toHaveTextContent("1 behind");
    expect(within(row).getByTestId(`lab-used-by-${FORK_ID}-merge`)).toHaveAttribute(
      "href",
      `/ops/agents/${FORK_ID}/merge?mode=update`,
    );
    expect(within(row).getByTestId(`lab-used-by-${FORK_ID}-promote`)).toHaveAttribute(
      "href",
      `/ops/agents/${FORK_ID}/merge?mode=promote`,
    );
    expect(await screen.findByTestId("lab-client-view")).toHaveTextContent(
      "materials · pack report",
    );
  });

  it("assigns a template to a client and opens the new agent", async () => {
    const { forks, user } = setup(
      "/ops/lab",
      <AssignToClient templateId={TEMPLATE_ID} version={1} />,
    );
    await user.click(await screen.findByTestId("lab-assign"));
    await screen.findByRole("option", { name: "Ionic Order" });
    await user.click(screen.getByTestId("lab-assign-confirm"));
    expect(forks).toEqual([{ clientId: CLIENT_ID }]);
    expect(await screen.findByTestId("location")).toHaveTextContent(
      `/ops/clients/${CLIENT_ID}/agents/purchasing`,
    );
  });
});
