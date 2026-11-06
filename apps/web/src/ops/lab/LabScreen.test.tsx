// O2 Agent lab: templates, drafts and client-only agents; the chosen template's lineage (merges
// to review, changes to promote), workflow, client view and test bench; assigning it to a client.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { AGENT_DETAIL, AGENT_SUMMARY, fakeApi, versionId } from "../../test/fixtures";
import { LabScreen } from "./LabScreen";

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

function setup(path = "/ops/lab") {
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
          <Route path="/ops/lab" element={<LabScreen />} />
          <Route path="*" element={null} />
        </Routes>
        <Probe />
      </ApiProvider>
    </MemoryRouter>,
  );
  return { api, forks, user: userEvent.setup() };
}

describe("LabScreen", () => {
  it("lists the templates and shows the first one's lineage, workflow, client view and tests", async () => {
    setup();
    const card = await screen.findByTestId("lab-template-purchasing");
    expect(card).toHaveTextContent("Purchasing");
    expect(card).toHaveTextContent("v1");
    expect(card).toHaveTextContent("3 clients · 1 behind");
    expect(card).toHaveTextContent("Invoice and quote price checks");
    expect(screen.getByTestId("lab-tab-templates")).toHaveTextContent("Templates · 1");
    expect(screen.getByTestId("lab-tab-drafts")).toHaveTextContent("Drafts · 1");
    expect(screen.getByTestId("lab-tab-client")).toHaveTextContent("Client-only · 1");

    const detail = screen.getByTestId("lab-detail");
    expect(within(detail).getByText("Published v1")).toBeInTheDocument();
    expect(within(detail).getByTestId("lab-edit")).toHaveTextContent("Edit draft v2");

    const row = await screen.findByTestId(`lab-used-by-${FORK_ID}`);
    expect(row).toHaveTextContent("Ionic Order · Purchasing");
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

    expect(await screen.findByTestId("lab-steps")).toHaveTextContent("Find supporting document");
    expect(await screen.findByTestId("lab-client-view")).toHaveTextContent(
      "materials · pack report",
    );
    expect(screen.getByTestId("lab-tests-summary")).toHaveTextContent("42 of 44 pass");
    expect(screen.getByTestId("lab-tests-summary")).toHaveTextContent("97.1%");
  });

  it("shows drafts and client-only agents", async () => {
    const { user } = setup();
    await user.click(await screen.findByTestId("lab-tab-drafts"));
    expect(screen.getByTestId("lab-template-card-receipts")).toHaveTextContent(
      "0 clients · testing",
    );
    await user.click(screen.getByTestId("lab-tab-client"));
    expect(screen.getByTestId("lab-client-only-job-costing")).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT_ID}/agents/job-costing`,
    );
  });

  it("assigns a template to a client and opens the new agent", async () => {
    const { forks, user } = setup();
    await user.click(await screen.findByTestId("lab-assign"));
    await screen.findByRole("option", { name: "Ionic Order" });
    await user.click(screen.getByTestId("lab-assign-confirm"));
    expect(forks).toEqual([{ clientId: CLIENT_ID }]);
    expect(await screen.findByTestId("location")).toHaveTextContent(
      `/ops/clients/${CLIENT_ID}/agents/purchasing`,
    );
  });
});
