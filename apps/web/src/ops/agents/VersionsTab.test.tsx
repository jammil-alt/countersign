// The versions view: history with status badges and notes, a version's diff as sentences, publish
// a draft (and the reasons a publish is refused), roll back with a confirmation; a client agent's
// lineage and customizations; a template's "Used by".
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { AgentSummary, VersionSummary } from "../../api/routes";
import { ApiProvider } from "../../api/useApi";
import { AGENT_DETAIL, AGENT_SUMMARY, fakeApi, Reply, versionId } from "../../test/fixtures";
import { VersionsTab } from "./VersionsTab";

const ID = AGENT_SUMMARY.id;
const TEMPLATE_ID = "00000000-0000-4000-8000-00000000f001";
const TEMPLATE_V1 = "00000000-0000-4000-8000-0000000f0001";

const BASE_VERSION: VersionSummary = AGENT_DETAIL.versions[1] as VersionSummary;

const v = (n: number, status: string, extra: Partial<VersionSummary> = {}): VersionSummary => ({
  ...BASE_VERSION,
  id: versionId(n),
  version: n,
  status,
  changeNote: `Change ${n}`,
  parentVersionId: n > 1 ? versionId(n - 1) : null,
  ...extra,
});

const VERSIONS = [v(3, "draft"), v(2, "live"), v(1, "retired")];

function diffReply(n: number) {
  return {
    from: n > 1 ? v(n - 1, "retired") : null,
    to: v(n, "draft"),
    changes:
      n === 3
        ? [
            {
              kind: "changed",
              entity: "bundle",
              path: "bundle#/definition/instructions",
              before: "Itemize bills.",
              after: "Itemize every bill.",
            },
            {
              kind: "added",
              entity: "step:notify",
              path: "step:notify",
              after: { id: "notify", kind: "notify", name: "Tell purchasing" },
            },
          ]
        : n === 2
          ? [
              {
                kind: "changed",
                entity: "step:ask",
                path: "step:ask#/timeout",
                before: "2 days",
                after: "1 day",
              },
            ]
          : [],
    labels: { "step:ask": "Ask Jammil" },
  };
}

function setup({
  agent = { ...AGENT_SUMMARY, liveVersionId: versionId(2) },
  routes = {},
}: {
  agent?: AgentSummary;
  routes?: Record<string, Parameters<typeof fakeApi>[0][string]>;
} = {}) {
  const api = fakeApi({
    ...Object.fromEntries(
      [1, 2, 3].map((n) => [
        `GET /api/ops/agents/${ID}/versions/${versionId(n)}/diff`,
        () => diffReply(n),
      ]),
    ),
    ...routes,
  });
  const onChanged = vi.fn();
  render(
    <MemoryRouter>
      <ApiProvider client={api.client}>
        <VersionsTab
          agent={agent}
          versions={VERSIONS}
          liveId={agent.liveVersionId}
          base="/ops/clients/x/agents/material-costs"
          update={null}
          onChanged={onChanged}
        />
      </ApiProvider>
    </MemoryRouter>,
  );
  return { api, onChanged, user: userEvent.setup() };
}

describe("VersionsTab", () => {
  it("lists versions newest first with status, notes and actions, and the newest one's diff", async () => {
    setup();
    const table = screen.getByTestId("agent-versions");
    const rows = within(table).getAllByTestId(/^agent-version-\d+$/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "agent-version-3",
      "agent-version-2",
      "agent-version-1",
    ]);
    expect(rows[0]).toHaveTextContent("Draft");
    expect(rows[1]).toHaveTextContent("Live");
    expect(rows[2]).toHaveTextContent("Retired");
    expect(rows[0]).toHaveTextContent("Change 3");
    // A draft publishes; an older version rolls back; the live one has neither.
    expect(
      within(rows[0] as HTMLElement).getByTestId("agent-version-3-publish"),
    ).toBeInTheDocument();
    expect(
      within(rows[2] as HTMLElement).getByTestId("agent-version-1-rollback"),
    ).toBeInTheDocument();
    expect(
      within(rows[1] as HTMLElement).queryByRole("button", { name: /Publish|Roll back/ }),
    ).toBeNull();

    const diff = await screen.findByTestId("agent-version-diff-changes");
    expect(
      within(diff)
        .getAllByTestId("change-line")
        .map((l) => l.textContent),
    ).toEqual([
      "ChangedInstructions changedItemize bills. to Itemize every bill.",
      "AddedAdded notify step “Tell purchasing”",
    ]);
    expect(screen.getByTestId("agent-version-diff")).toHaveTextContent(
      "What v3 changed · against v2",
    );
  });

  it("shows another version's diff when its change note is clicked", async () => {
    const { user } = setup();
    await user.click(screen.getByTestId("agent-version-2-diff"));
    const diff = await screen.findByText("Step “Ask Jammil”: timeout changed");
    expect(diff).toBeInTheDocument();
    await user.click(screen.getByTestId("agent-version-1-diff"));
    expect(
      await screen.findByText(/The first version: nothing to compare against/),
    ).toBeInTheDocument();
  });

  it("publishes a draft", async () => {
    let published = false;
    const { user, onChanged } = setup({
      routes: {
        [`POST /api/ops/agents/${ID}/versions/${versionId(3)}/publish`]: () => {
          published = true;
          return { version: v(3, "live") };
        },
      },
    });
    await user.click(screen.getByTestId("agent-version-3-publish"));
    expect(await screen.findByTestId("agent-versions-done")).toHaveTextContent("v3 is live.");
    expect(published).toBe(true);
    expect(onChanged).toHaveBeenCalled();
  });

  it("says why a publish is refused", async () => {
    const { user, onChanged } = setup({
      routes: {
        [`POST /api/ops/agents/${ID}/versions/${versionId(3)}/publish`]: () =>
          new Reply(422, {
            error: {
              code: "invalid_bundle",
              message: "v3 does not validate",
              details: [
                {
                  stepId: "update",
                  field: "approval.required",
                  code: "connection_requires_approval",
                  message: "this connection requires approval for updates",
                },
              ],
            },
          }),
      },
    });
    await user.click(screen.getByTestId("agent-version-3-publish"));
    const error = await screen.findByTestId("agent-versions-error");
    expect(error).toHaveTextContent("v3 does not validate");
    expect(error).toHaveTextContent("Step update: this connection requires approval for updates");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("rolls back only after a confirmation", async () => {
    const sent: unknown[] = [];
    const { user, onChanged } = setup({
      routes: {
        [`POST /api/ops/agents/${ID}/rollback`]: ({ init }) => {
          sent.push(JSON.parse(String(init.body)));
          return { version: v(4, "live", { changeNote: "Rollback to v1" }) };
        },
        [`GET /api/ops/agents/${ID}/versions/${versionId(4)}/diff`]: () => diffReply(1),
      },
    });
    await user.click(screen.getByTestId("agent-version-1-rollback"));
    expect(sent).toEqual([]);
    await user.click(screen.getByTestId("agent-version-1-rollback-confirm"));
    expect(await screen.findByTestId("agent-versions-done")).toHaveTextContent(
      "Rolled back: v4 is a copy of v1 and is live.",
    );
    expect(sent).toEqual([{ versionId: versionId(1) }]);
    expect(onChanged).toHaveBeenCalled();
  });

  it("keeps the rollback's confirm, saying Rolling back, until the server answers (1.8)", async () => {
    let answer: (v: unknown) => void = () => {};
    const { user } = setup({
      routes: {
        [`POST /api/ops/agents/${ID}/rollback`]: () => new Promise((r) => (answer = r)),
        [`GET /api/ops/agents/${ID}/versions/${versionId(4)}/diff`]: () => diffReply(1),
      },
    });
    await user.click(screen.getByTestId("agent-version-1-rollback"));
    await user.click(screen.getByTestId("agent-version-1-rollback-confirm"));
    const confirm = screen.getByTestId("agent-version-1-rollback-confirm");
    expect(confirm).toHaveTextContent("Rolling back…");
    expect(confirm).toBeDisabled();
    expect(screen.queryByTestId("agent-versions-done")).toBeNull();
    answer({ version: v(4, "live", { changeNote: "Rollback to v1" }) });
    expect(await screen.findByTestId("agent-versions-done")).toHaveTextContent("Rolled back");
    expect(screen.queryByTestId("agent-version-1-rollback-confirm")).toBeNull();
  });

  it("on a client agent, shows its template base, the update waiting and its customizations", async () => {
    const forked = {
      ...AGENT_SUMMARY,
      templateId: TEMPLATE_ID,
      liveVersionId: versionId(2),
    };
    const api = fakeApi({
      [`GET /api/ops/agents/${ID}/versions/${versionId(3)}/diff`]: () => diffReply(3),
      [`GET /api/ops/agents/${TEMPLATE_ID}`]: () => ({
        ...AGENT_DETAIL,
        agent: {
          ...AGENT_SUMMARY,
          id: TEMPLATE_ID,
          kind: "template",
          tenantId: null,
          name: "Purchasing clerk",
        },
        versions: [
          { ...AGENT_DETAIL.versions[1], id: TEMPLATE_V1, agentId: TEMPLATE_ID, version: 1 },
        ],
      }),
      [`GET /api/ops/agents/${ID}/customizations`]: () => ({
        base: { ...AGENT_DETAIL.versions[1], id: TEMPLATE_V1, agentId: TEMPLATE_ID, version: 1 },
        version: v(2, "live"),
        changes: [
          {
            kind: "changed",
            entity: "skill:docs.extract",
            path: "skill:docs.extract#/settings/min_confidence",
            before: 0.8,
            after: 0.95,
          },
        ],
        labels: { "skill:docs.extract": "docs.extract" },
      }),
    });
    render(
      <MemoryRouter>
        <ApiProvider client={api.client}>
          <VersionsTab
            agent={forked}
            versions={VERSIONS.map((x) => ({ ...x, basedOnTemplateVersionId: TEMPLATE_V1 }))}
            liveId={versionId(2)}
            base="/ops/clients/x/agents/material-costs"
            update={{
              available: true,
              behind: 2,
              baseVersionId: TEMPLATE_V1,
              templateLiveVersionId: null,
              releaseNote: "Asks before big changes",
            }}
            onChanged={() => {}}
          />
        </ApiProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Based on template “Purchasing clerk” v1")).toBeInTheDocument();
    expect(screen.getByTestId("agent-lineage-update")).toHaveTextContent(
      "Update available · 2 versions behind",
    );
    expect(screen.getByTestId("agent-lineage")).toHaveTextContent(
      "Release note: Asks before big changes",
    );
    expect(within(screen.getByTestId("agent-version-2")).getByText("v1")).toBeInTheDocument();
    const custom = await screen.findByTestId("agent-customizations-changes");
    expect(custom).toHaveTextContent("Skill docs.extract: setting min_confidence changed");
    expect(custom).toHaveTextContent("0.8 to 0.95");
    expect(screen.getByTestId("agent-customizations")).toHaveTextContent("v2 against template v1");
  });

  it("on a template, lists the client agents using it", async () => {
    const template: AgentSummary = {
      ...AGENT_SUMMARY,
      kind: "template" as const,
      tenantId: null,
      liveVersionId: versionId(2),
    };
    setup({
      agent: template,
      routes: {
        [`GET /api/ops/templates/${ID}/used-by`]: () => ({
          templateLiveVersion: 2,
          agents: [
            {
              agent: {
                ...AGENT_SUMMARY,
                id: "00000000-0000-4000-8000-00000000b009",
                slug: "costs",
                serviceName: "Costs",
              },
              client: { id: "00000000-0000-4000-8000-00000000a009", name: "Millwork" },
              version: 3,
              baseVersion: 1,
              behind: 1,
              customizations: 4,
              conflicts: 2,
            },
          ],
        }),
      },
    });
    const row = await screen.findByTestId("template-used-by-costs");
    expect(row).toHaveTextContent("Costs");
    expect(row).toHaveTextContent("Millwork");
    expect(row).toHaveTextContent("v1");
    expect(row).toHaveTextContent("1 behind");
    expect(
      within(row)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["CostsMillwork · running", "v1", "1 behind", "4", "2 conflicts"]);
    expect(screen.getByTestId("template-used-by")).toHaveTextContent("Used by · 1 client agent");
    expect(screen.queryByTestId("agent-customizations")).not.toBeInTheDocument();
  });
});
