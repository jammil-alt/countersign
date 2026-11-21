// The strip under the bar: a client's agent with an update out (its template and version, what it
// customized, the way to the merge screen for the update and for a promotion, Detach), a detached
// one with Relink, and a template (where it runs, how many are behind, Assign to a client: a fork,
// then that client's agent).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../../../api/useApi";
import { AGENT_DETAIL, AGENT_SUMMARY, fakeApi, versionId } from "../../../test/fixtures";
import { LineageStrip, type LineageStripProps } from "./LineageStrip";

const ID = AGENT_SUMMARY.id;
const TEMPLATE_ID = "00000000-0000-4000-8000-00000000f001";
const CLIENT_ID = "00000000-0000-4000-8000-00000000a002";
const FORK_ID = "00000000-0000-4000-8000-00000000b009";
const tv = (n: number) => `00000000-0000-4000-8000-0000000f${String(n).padStart(4, "0")}`;

const AGENT = { ...AGENT_SUMMARY, templateId: TEMPLATE_ID };
const TEMPLATE = {
  ...AGENT_SUMMARY,
  id: TEMPLATE_ID,
  tenantId: null,
  kind: "template" as const,
  slug: "clerk",
  name: "Clerk",
  templateId: null,
  liveVersionId: tv(4),
};
const templateVersion = (n: number, status: string) => ({
  ...(AGENT_DETAIL.versions[0] as (typeof AGENT_DETAIL.versions)[number]),
  id: tv(n),
  agentId: TEMPLATE_ID,
  version: n,
  status,
});
const TEMPLATE_DETAIL = {
  agent: TEMPLATE,
  versions: [templateVersion(4, "live"), templateVersion(3, "retired")],
};
const LIVE = { ...AGENT_DETAIL.live, basedOnTemplateVersionId: tv(3) };
const UPDATE = {
  available: true,
  behind: 1,
  baseVersionId: tv(3),
  templateLiveVersionId: tv(4),
  releaseNote: "Checks duplicates first",
};

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{`${loc.pathname}${loc.search}`}</p>;
}

function setup(props: LineageStripProps, routes: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi({
    [`GET /api/ops/agents/${ID}/customizations`]: () => ({
      changes: [{ kind: "changed", entity: "step:ask", path: "step:ask#/name" }],
      labels: {},
      base: null,
      version: null,
    }),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={["/builder"]}>
      <ApiProvider client={api.client}>
        <Routes>
          <Route path="/builder" element={<LineageStrip {...props} />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </ApiProvider>
    </MemoryRouter>,
  );
  return api;
}

describe("LineageStrip: a client's agent", () => {
  const customized = new Map<string, "changed" | "added">([
    ["ask", "changed"],
    ["tell", "changed"],
    ["pause", "added"],
  ]);

  it("names its template and version, what it customized, and the update to review", async () => {
    setup({
      agent: AGENT,
      detail: { live: LIVE, latest: LIVE, update: UPDATE },
      template: TEMPLATE_DETAIL,
      customized,
      customizations: <p data-testid="the-list">The list</p>,
    });
    expect(screen.getByTestId("flow-lineage-from")).toHaveTextContent(
      "From the template Clerk · v3",
    );
    expect(screen.getByRole("link", { name: "Clerk" })).toHaveAttribute(
      "href",
      "/ops/templates/clerk",
    );
    expect(screen.getByTestId("flow-lineage-update")).toHaveTextContent("Template v4 is out");
    const review = screen.getByTestId("flow-lineage-review-update");
    expect(review).toHaveTextContent("Review the update");
    expect(review).toHaveAttribute("href", `/ops/agents/${ID}/merge?mode=update`);

    // Customized opens the host's list under the strip, and closes it again.
    const opener = screen.getByTestId("flow-lineage-customized");
    expect(opener).toHaveTextContent("Customized: 2 steps changed, 1 added");
    expect(screen.queryByTestId("the-list")).toBeNull();
    await userEvent.click(opener);
    expect(screen.getByTestId("the-list")).toBeTruthy();
    await userEvent.click(opener);
    expect(screen.queryByTestId("the-list")).toBeNull();

    // The saved version differs from its base: it can be offered to the template.
    const promote = await screen.findByTestId("flow-lineage-promote");
    expect(promote).toHaveTextContent("Offer to the template");
    expect(promote).toHaveAttribute("href", `/ops/agents/${ID}/merge?mode=promote`);
  });

  it("offers nothing to the template or to review when it is the template as forked", async () => {
    const api = setup(
      {
        agent: AGENT,
        detail: { live: LIVE, latest: LIVE, update: { ...UPDATE, available: false, behind: 0 } },
        template: TEMPLATE_DETAIL,
        customized: new Map(),
      },
      {
        [`GET /api/ops/agents/${ID}/customizations`]: () => ({
          changes: [],
          labels: {},
          base: null,
          version: null,
        }),
      },
    );
    await waitFor(() => expect(api.calls).toContain(`GET /api/ops/agents/${ID}/customizations`));
    expect(screen.getByTestId("flow-lineage-same")).toHaveTextContent(
      "The steps are the template's",
    );
    expect(screen.queryByTestId("flow-lineage-update")).toBeNull();
    expect(screen.queryByTestId("flow-lineage-promote")).toBeNull();
  });

  it("detaches after a second press, and tells the host", async () => {
    const onChanged = vi.fn();
    const api = setup(
      {
        agent: AGENT,
        detail: { live: LIVE, latest: LIVE, update: UPDATE },
        template: TEMPLATE_DETAIL,
        onChanged,
      },
      { [`POST /api/ops/agents/${ID}/detach`]: () => ({ agent: { ...AGENT, linked: false } }) },
    );
    await userEvent.click(screen.getByTestId("flow-lineage-detach"));
    expect(api.calls).not.toContain(`POST /api/ops/agents/${ID}/detach`);
    await userEvent.click(screen.getByTestId("flow-lineage-detach-confirm"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.calls).toContain(`POST /api/ops/agents/${ID}/detach`);
  });

  it("says a detached agent takes no updates, and relinks it to a published version", async () => {
    const sent: unknown[] = [];
    const onChanged = vi.fn();
    setup(
      {
        agent: { ...AGENT, linked: false },
        detail: { live: LIVE, latest: LIVE, update: UPDATE },
        template: TEMPLATE_DETAIL,
        onChanged,
      },
      {
        [`POST /api/ops/agents/${ID}/relink`]: ({ init }) => {
          sent.push(JSON.parse(String(init.body)));
          return { agent: AGENT, version: AGENT_DETAIL.versions[0] };
        },
      },
    );
    expect(screen.getByTestId("flow-lineage-detached")).toHaveTextContent(
      "Detached: it takes no template updates",
    );
    // A detached agent is not told about updates it won't take.
    expect(screen.queryByTestId("flow-lineage-update")).toBeNull();
    await userEvent.click(screen.getByTestId("flow-lineage-relink"));
    await userEvent.click(screen.getByTestId("flow-lineage-relink-confirm"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(sent).toEqual([{ templateVersionId: tv(4) }]);
  });

  it("says so when it was written for the client from no template", () => {
    const api = setup({
      agent: AGENT_SUMMARY,
      detail: { live: AGENT_DETAIL.live, latest: AGENT_DETAIL.latest, update: null },
    });
    expect(screen.getByTestId("flow-lineage-from")).toHaveTextContent(
      "Written for this client, from no template.",
    );
    expect(api.calls).toEqual([]);
  });
});

describe("LineageStrip: a template", () => {
  const copy = (id: string, client: string, behind: number, linked = true) => ({
    agent: { ...AGENT, id, linked, tenantId: `${CLIENT_ID.slice(0, -1)}${id.slice(-1)}` },
    client: { id: `${CLIENT_ID.slice(0, -1)}${id.slice(-1)}`, name: client },
    version: 2,
    baseVersion: 3,
    behind,
    customizations: 0,
    conflicts: null,
  });
  const usedBy = {
    templateLiveVersion: 4,
    agents: [
      copy("00000000-0000-4000-8000-00000000b001", "Ionic Order", 1),
      copy("00000000-0000-4000-8000-00000000b002", "Doric Supply", 0),
      copy("00000000-0000-4000-8000-00000000b003", "Attic Works", 2),
    ],
  };
  const live = { ...AGENT_DETAIL.live, id: tv(4), agentId: TEMPLATE_ID, version: 4 };

  it("says where it runs and how many copies are behind, and opens the list", async () => {
    setup(
      { agent: TEMPLATE, detail: { live, latest: live, update: null } },
      { [`GET /api/ops/templates/${TEMPLATE_ID}/used-by`]: () => usedBy },
    );
    const runs = await screen.findByTestId("flow-lineage-runs");
    expect(runs).toHaveTextContent("Runs at 3 clients");
    expect(screen.getByTestId("flow-lineage-behind")).toHaveTextContent("2 behind");
    expect(screen.getByTestId("flow-lineage-from")).toHaveTextContent(
      "Publishing it changes no client's agent",
    );
    await userEvent.click(runs);
    const list = await screen.findByTestId("lab-used-by");
    expect(list).toHaveTextContent("Ionic Order's copy");
  });

  it("assigns it to a client: a fork, then that client's agent", async () => {
    const forks: unknown[] = [];
    const api = setup(
      { agent: TEMPLATE, detail: { live, latest: live, update: null } },
      {
        [`GET /api/ops/templates/${TEMPLATE_ID}/used-by`]: () => ({
          templateLiveVersion: 4,
          agents: [],
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
            agent: { ...AGENT, id: FORK_ID, tenantId: CLIENT_ID, slug: "clerk" },
            version: { ...AGENT_DETAIL.versions[1], id: versionId(9) },
          };
        },
      },
    );
    expect(await screen.findByTestId("flow-lineage-runs")).toHaveTextContent(
      "No client has it yet",
    );
    await userEvent.click(screen.getByTestId("flow-lineage-assign"));
    await screen.findByRole("option", { name: "Ionic Order" });
    await userEvent.click(screen.getByTestId("lab-assign-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent(
        `/ops/clients/${CLIENT_ID}/agents/clerk`,
      ),
    );
    expect(forks).toEqual([{ clientId: CLIENT_ID }]);
    expect(api.calls).toContain(`POST /api/ops/templates/${TEMPLATE_ID}/fork`);
  });

  it("asks for a published version before it can be assigned", async () => {
    setup(
      { agent: TEMPLATE, detail: { live: null, latest: live, update: null } },
      {
        [`GET /api/ops/templates/${TEMPLATE_ID}/used-by`]: () => ({
          templateLiveVersion: null,
          agents: [],
        }),
      },
    );
    expect(screen.getByTestId("flow-lineage-unpublished")).toHaveTextContent(
      "Publish it to assign it to a client",
    );
    expect(screen.queryByTestId("flow-lineage-assign")).toBeNull();
  });
});
