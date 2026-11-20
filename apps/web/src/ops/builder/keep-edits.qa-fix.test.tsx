// The workflow builder keeps its unsaved edits when a trigger is saved above it, and when the
// Builder answers a turn sent before them (BUILDER_QA.md, the flow lens of 2026-11-19: FLOW-6 and
// FLOW-9).
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AgentSummary } from "../../api/routes";
import { ApiProvider } from "../../api/useApi";
import {
  AGENT_DETAIL,
  AGENT_SUMMARY,
  type FORK_BUNDLE_INPUT,
  fakeApi,
  versionId,
} from "../../test/fixtures";
import { AgentScreen } from "../agents/AgentScreen";

type SavedBundle = { workflows: { slug: string; workflow: unknown }[] };

const ID = AGENT_SUMMARY.id;
const CLIENT = AGENT_SUMMARY.tenantId;
const BASE = `/ops/clients/${CLIENT}/agents/${AGENT_SUMMARY.slug}`;

const doc = (id: string, name: string) => ({
  ref: id,
  source: "builtin" as const,
  version: null,
  definition: {
    schemaVersion: 1 as const,
    id,
    name,
    description: name,
    category: "documents" as const,
    mode: "agent" as const,
    tools: [],
    input: { type: "object" },
    output: { type: "object" },
    settings: [],
    requiresConnectors: [],
    requiresPacks: [],
    producesAlerts: false,
  },
});

describe("the Workflow tab keeps the canvas's edits", () => {
  // FLOW-6: a trigger added or removed in "Starts when" is saved from the server's latest version
  // (TriggersScreen.tsx saveBundle, not the builder's working draft), and AgentScreen then remounts
  // the builder on the new version (`key={view.id}:${builderEpoch}`, AgentScreen.tsx:443). The
  // builder's unsaved edits are dropped: its history starts again from the new version, and the
  // draft kept on this device names the old version, so `restoredDraft` ignores it.
  it("keeps the builder's unsaved edits when a trigger is added above it", async () => {
    const latest = AGENT_DETAIL.latest;
    let detail = AGENT_DETAIL;
    const saves: { bundle: SavedBundle; parentVersionId: string }[] = [];
    const api = fakeApi({
      [`GET /api/ops/agents/${ID}`]: () => detail,
      [`GET /api/ops/agents/${ID}/skills`]: () => ({ skills: [] }),
      [`GET /api/ops/agents/${ID}/builder-catalog`]: () => ({
        skills: [
          doc("docs.extract", "Read a document"),
          doc("docs.find-support", "Find supporting document"),
        ],
        tools: [],
        connectors: [],
        automations: [],
      }),
      "GET /api/ops/catalog/events": () => ({ events: [] }),
      [`POST /api/ops/agents/${ID}/versions`]: ({ init }) => {
        const body = JSON.parse(String(init.body)) as { bundle: unknown };
        saves.push(JSON.parse(String(init.body)));
        const v3 = {
          ...latest,
          id: versionId(3),
          version: 3,
          parentVersionId: latest.id,
          changeNote: "Added a schedule trigger",
          bundle: body.bundle,
        };
        detail = {
          ...AGENT_DETAIL,
          versions: [{ ...v3, bundle: undefined }, ...AGENT_DETAIL.versions],
          latest: v3,
        } as unknown as typeof AGENT_DETAIL;
        return { version: { ...v3, bundle: undefined }, errors: [] };
      },
    });
    const agent: AgentSummary = AGENT_SUMMARY;
    render(
      <MemoryRouter initialEntries={[`${BASE}/workflows/new-bill`]}>
        <ApiProvider client={api.client}>
          <Routes>
            <Route
              path={`${BASE}/*`}
              element={<AgentScreen agentId={agent.id} base={BASE} clientName="Harbor Millwork" />}
            />
          </Routes>
        </ApiProvider>
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await screen.findByTestId("builder-canvas", {}, { timeout: 10_000 });

    // The operator deletes a step in the builder: an unsaved change.
    await user.click(screen.getByTestId("builder-step-read-select"));
    await user.click(screen.getByTestId("builder-inspector-delete"));
    expect(screen.queryByTestId("builder-step-read")).toBeNull();
    expect(screen.getByTestId("builder-unsaved")).toBeInTheDocument();

    // Then adds a schedule trigger in "Starts when", above the builder.
    const top = screen.getByTestId("agent-workflow-top");
    await user.click(within(top).getByTestId("triggers-add"));
    await user.click(screen.getByTestId("trigger-form-save"));
    expect(await screen.findByTestId("triggers-saved")).toHaveTextContent("saved v3 as a draft");
    // The builder opens again on the new version once the agent has reloaded with it.
    await waitFor(() =>
      expect(api.calls.filter((c) => c === `GET /api/ops/agents/${ID}`).length).toBeGreaterThan(1),
    );
    await screen.findByTestId("builder-canvas");
    await new Promise((r) => setTimeout(r, 200));

    // Expected: the deleted step is still deleted (or the change is still marked unsaved).
    expect(screen.queryByTestId("builder-step-read")).toBeNull();
    expect(screen.getByTestId("builder-unsaved")).toBeInTheDocument();

    // The builder's next save builds on the trigger's version: the trigger stays, the step goes.
    await user.click(screen.getByTestId("builder-save"));
    await waitFor(() => expect(saves).toHaveLength(2));
    const [withTrigger, next] = saves as [(typeof saves)[0], (typeof saves)[0]];
    expect(next.parentVersionId).toBe(versionId(3));
    const main = (b: SavedBundle) => b.workflows.find((w) => w.slug === "new-bill")?.workflow;
    const ids = (b: SavedBundle) => JSON.stringify(main(b));
    expect(ids(next.bundle)).not.toContain('"id":"read"');
    const triggerIds = (b: SavedBundle) => {
      const w = main(b) as { triggers?: { id: string }[]; moreTriggers?: { id: string }[] };
      return [...(w.triggers ?? []), ...(w.moreTriggers ?? [])].map((t) => t.id);
    };
    for (const t of triggerIds(withTrigger.bundle)) expect(triggerIds(next.bundle)).toContain(t);
  });

  // FLOW-9: the Builder's answer replaces the whole canvas (`take` → `onDraft` → `apply(() =>
  // next)`, BuilderPanel.tsx:118, WorkflowBuilder.tsx:1085). The canvas stays editable while the
  // Builder works (10 s to a minute), so a change the operator makes meanwhile is silently undone
  // when the answer lands: the draft it answers is the canvas as it was when the words were sent.
  it("keeps a canvas edit made while the Builder was working on a turn", async () => {
    const SESSION = "00000000-0000-4000-8000-0000000c5001";
    const latest = AGENT_DETAIL.latest;
    const bundle = latest.bundle as typeof FORK_BUNDLE_INPUT;
    const withoutUpdate = {
      ...bundle,
      workflows: bundle.workflows.map((w) => ({
        ...w,
        workflow: {
          ...w.workflow,
          steps: (w.workflow as { steps: { id: string }[] }).steps.filter((s) => s.id !== "update"),
        },
      })),
    };
    const session = (b: unknown, turns: unknown[] = []) => ({
      session: {
        id: SESSION,
        kind: "agent",
        clientId: CLIENT,
        clientName: "Harbor Millwork",
        agentId: ID,
        skillId: null,
        baseVersionId: latest.id,
        status: "open",
        bundle: b,
        errors: [],
        closest: [],
        createdAt: "2026-11-06T10:00:00.000Z",
        updatedAt: "2026-11-06T10:00:00.000Z",
      },
      turns,
    });
    const turn = {
      id: "00000000-0000-4000-8000-0000000c5102",
      seq: 2,
      role: "builder",
      text: "Removed the update step.",
      command: null,
      changes: [{ id: "step:update", label: "step “Update bill”", before: {}, undone: false }],
      questions: [],
      gaps: [],
      notes: [],
      errors: [],
      savedVersionId: null,
      costUsd: "0.01",
      undoneAt: null,
      createdAt: "2026-11-06T10:00:00.000Z",
    };
    let answer: (v: unknown) => void = () => {};
    const api = fakeApi({
      [`GET /api/ops/agents/${ID}`]: () => AGENT_DETAIL,
      [`GET /api/ops/agents/${ID}/skills`]: () => ({ skills: [] }),
      [`GET /api/ops/agents/${ID}/builder-catalog`]: () => ({
        skills: [
          doc("docs.extract", "Read a document"),
          doc("docs.find-support", "Find supporting document"),
        ],
        tools: [],
        connectors: [],
        automations: [],
      }),
      "GET /api/ops/catalog/events": () => ({ events: [] }),
      "POST /api/ops/builder/sessions": () => session(bundle),
      [`POST /api/ops/builder/sessions/${SESSION}/turns`]: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    render(
      <MemoryRouter initialEntries={[`${BASE}/workflows/new-bill`]}>
        <ApiProvider client={api.client}>
          <Routes>
            <Route
              path={`${BASE}/*`}
              element={<AgentScreen agentId={ID} base={BASE} clientName="Harbor Millwork" />}
            />
          </Routes>
        </ApiProvider>
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await screen.findByTestId("builder-canvas", {}, { timeout: 10_000 });
    await user.type(screen.getByTestId("builder-chat-composer-input"), "Drop the update step");
    await user.click(screen.getByTestId("builder-chat-composer-send"));
    await waitFor(() =>
      expect(api.calls).toContain(`POST /api/ops/builder/sessions/${SESSION}/turns`),
    );

    // While the Builder works, the operator deletes another step on the canvas.
    await user.click(screen.getByTestId("builder-step-read-select"));
    await user.click(screen.getByTestId("builder-inspector-delete"));
    expect(screen.queryByTestId("builder-step-read")).toBeNull();

    answer({ ...session(withoutUpdate, [turn]), turn });
    await waitFor(() => expect(screen.queryByTestId("builder-step-update")).toBeNull());

    // Expected: the operator's own deletion is still there (or the canvas was locked meanwhile).
    expect(screen.queryByTestId("builder-step-read")).toBeNull();
  });
});
