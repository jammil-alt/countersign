// The activation check follows a running test run (plan §1.16): while the live version's latest
// test run is going it says so and polls, and turns ready when the run passes, without a reload.
// Starting a test run from the panel makes it look again at once. The test run's input is typed,
// the trigger's sample, or one of this client's recent events of the trigger's type.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import {
  AGENT_SUMMARY,
  FORK_BUNDLE,
  fakeApi,
  PROCESS_BUNDLE,
  versionId,
} from "../../test/fixtures";
import { OperationPanel } from "./OperationPanel";

const AGENT = { ...AGENT_SUMMARY, runStatus: "draft", status: "active" };
const RUN = "00000000-0000-4000-8000-0000000a9001";
const LIVE = {
  id: versionId(1),
  agentId: AGENT.id,
  version: 1,
  status: "live",
  bundleHash: "hash-1",
  changeNote: null,
  releaseNote: null,
  authorType: "operator",
  authorId: null,
  parentVersionId: null,
  basedOnTemplateVersionId: null,
  mergedFromVersionIds: null,
  createdAt: "2026-11-01T10:00:00.000Z",
};

function activation(status: string | null) {
  const passed = status === "succeeded";
  return {
    ready: passed,
    problems: passed ? [] : ["v1 has no passing test run on this client"],
    requiredConnectors: [],
    testRun: status ? { id: RUN, status, createdAt: "2026-11-04T10:00:00.000Z" } : null,
  };
}

function renderPanel(answers: (string | null)[]) {
  let n = 0;
  const api = fakeApi({
    [`GET /api/ops/agents/${AGENT.id}/activation`]: () =>
      activation(answers[Math.min(n++, answers.length - 1)] ?? null),
    [`POST /api/ops/agents/${AGENT.id}/versions/${LIVE.id}/test-run`]: () => ({
      runId: RUN,
      agentId: AGENT.id,
      versionId: LIVE.id,
    }),
  });
  render(
    <ApiProvider client={api.client}>
      <MemoryRouter>
        <OperationPanel agent={AGENT} live={LIVE} liveBundle={FORK_BUNDLE} onChanged={() => {}} />
      </MemoryRouter>
    </ApiProvider>,
  );
  return { api, checks: () => n };
}

describe("activation and a running test run", () => {
  it("keeps Retire's confirm, saying Retiring, until the server answers (1.8)", async () => {
    let answer: (v: unknown) => void = () => {};
    const { api } = renderPanel(["succeeded"]);
    api.on(`POST /api/ops/agents/${AGENT.id}/retire`, () => new Promise((r) => (answer = r)));
    await userEvent.click(await screen.findByTestId("agent-retire"));
    await userEvent.click(screen.getByTestId("agent-retire-confirm"));
    const confirm = screen.getByTestId("agent-retire-confirm");
    expect(confirm).toHaveTextContent("Retiring…");
    expect(confirm).toBeDisabled();
    expect(screen.queryByTestId("agent-operation-done")).toBeNull();
    answer({ agent: { ...AGENT, runStatus: "retired" } });
    expect(await screen.findByTestId("agent-operation-done")).toHaveTextContent("Retired");
  });

  it("says a test run is going, polls it, and turns ready when it passes", async () => {
    renderPanel(["running", "running", "succeeded"]);
    expect(await screen.findByTestId("agent-activation-test-running")).toHaveTextContent(
      "A test run of v1 is going",
    );
    expect(screen.getByTestId("agent-activation-problems")).toBeInTheDocument();
    expect(
      await screen.findByTestId("agent-activation-ready", {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("agent-activation-test-running")).not.toBeInTheDocument();
    expect(screen.getByTestId("agent-activate")).toBeEnabled();
  }, 10_000);

  it("does not poll when no test run is going, and says when the last one failed", async () => {
    const { checks } = renderPanel(["failed"]);
    expect(await screen.findByTestId("agent-activation-test-failed")).toHaveTextContent(
      "The last test run of v1 failed.",
    );
    await new Promise((r) => setTimeout(r, 2_500));
    expect(checks()).toBe(1);
  }, 10_000);

  it("checks again as soon as a test run starts from the panel", async () => {
    const { checks } = renderPanel([null, "queued"]);
    await screen.findByTestId("agent-activation-problems");
    expect(checks()).toBe(1);
    await userEvent.setup().click(screen.getByTestId("agent-test-run-start"));
    expect(await screen.findByTestId("agent-test-run-started")).toHaveTextContent(
      "Activation updates when it finishes.",
    );
    await waitFor(() => expect(checks()).toBeGreaterThanOrEqual(2));
    expect(await screen.findByTestId("agent-activation-test-running")).toBeInTheDocument();
  });
});

describe("the test run's input", () => {
  const DOC = "00000000-0000-4000-8000-0000000a8001";
  const EXTRACTION = "00000000-0000-4000-8000-0000000a8003";
  const payload = { documentId: DOC, extractionId: EXTRACTION, lineCount: 4, totalsValid: true };
  const BUNDLE = {
    ...FORK_BUNDLE,
    workflows: FORK_BUNDLE.workflows.map((w) => ({
      ...w,
      workflow: {
        ...w.workflow,
        trigger: { id: "t1", on: { type: "event", event: "document.extracted" } },
      },
    })),
  } as typeof FORK_BUNDLE;

  it("fills the input with the sample or one of this client's recent events, and runs it", async () => {
    const asked: string[] = [];
    let sent: unknown = null;
    const api = fakeApi({
      [`GET /api/ops/agents/${AGENT.id}/activation`]: () => activation(null),
      "GET /api/ops/catalog/events": () => ({
        events: [
          {
            type: "document.extracted",
            description: "A document's lines and totals were extracted.",
            subjectType: "document",
            payload: { type: "object" },
            sample: {
              documentId: "sample",
              extractionId: "sample",
              lineCount: 12,
              totalsValid: true,
            },
          },
        ],
      }),
      [`GET /api/ops/clients/${AGENT.tenantId}/events`]: ({ url }) => {
        asked.push(url.searchParams.get("type") ?? "");
        return {
          events: [
            {
              id: "00000000-0000-4000-8000-0000000e0001",
              type: "document.extracted",
              createdAt: "2026-11-04T10:00:00.000Z",
              payload,
              label: "northline-20418.pdf",
              vendorName: "Northline Panel Supply",
              total: { amount: "9742.3500", currency: "USD" },
            },
          ],
        };
      },
      [`POST /api/ops/agents/${AGENT.id}/versions/${LIVE.id}/test-run`]: ({ init }) => {
        sent = JSON.parse(String(init.body));
        return { runId: RUN, agentId: AGENT.id, versionId: LIVE.id };
      },
    });
    render(
      <ApiProvider client={api.client}>
        <MemoryRouter>
          <OperationPanel agent={AGENT} live={LIVE} liveBundle={BUNDLE} onChanged={() => {}} />
        </MemoryRouter>
      </ApiProvider>,
    );
    const source = await screen.findByTestId("agent-test-run-source");
    const option = await within(source).findByText(
      /^northline-20418\.pdf · Northline Panel Supply · \$9,742\.35 · /,
    );
    expect(asked).toEqual(["document.extracted"]);
    const user = userEvent.setup();
    const input = screen.getByTestId("agent-test-run-payload-input");
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", "{}");

    await user.selectOptions(source, "sample");
    expect(JSON.parse((input as HTMLTextAreaElement).value)).toMatchObject({ lineCount: 12 });

    await user.selectOptions(source, option.getAttribute("value") ?? "");
    expect(JSON.parse((input as HTMLTextAreaElement).value)).toEqual(payload);
    await user.click(screen.getByTestId("agent-test-run-start"));
    await waitFor(() => expect(sent).toEqual({ workflow: "new-bill", payload }));
  });

  // Wave 3b: a live v4 version (a process has `triggers`, no `trigger`) test-runs too, with the
  // recent events of its first event trigger.
  it("test-runs a live version that holds a process, from its event trigger's recent events", async () => {
    const asked: string[] = [];
    const api = fakeApi({
      [`GET /api/ops/agents/${AGENT.id}/activation`]: () => activation(null),
      "GET /api/ops/catalog/events": () => ({ events: [] }),
      [`GET /api/ops/clients/${AGENT.tenantId}/events`]: ({ url }) => {
        asked.push(url.searchParams.get("type") ?? "");
        return { events: [] };
      },
    });
    render(
      <ApiProvider client={api.client}>
        <MemoryRouter>
          <OperationPanel
            agent={AGENT}
            live={LIVE}
            liveBundle={PROCESS_BUNDLE}
            onChanged={() => {}}
          />
        </MemoryRouter>
      </ApiProvider>,
    );
    const source = await screen.findByTestId("agent-test-run-source");
    expect(await within(source).findByText("No bill.created events yet")).toBeInTheDocument();
    expect(asked).toEqual(["bill.created"]);
    expect(screen.getByTestId("agent-test-run-workflow-select")).toHaveValue("new-bill");
  });

  it("sends what was typed or pasted, with no extra brace, and stops invalid JSON", async () => {
    const sent: unknown[] = [];
    const api = fakeApi({
      [`GET /api/ops/agents/${AGENT.id}/activation`]: () => activation(null),
      [`POST /api/ops/agents/${AGENT.id}/versions/${LIVE.id}/test-run`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)).payload);
        return { runId: RUN, agentId: AGENT.id, versionId: LIVE.id };
      },
    });
    render(
      <ApiProvider client={api.client}>
        <MemoryRouter>
          <OperationPanel agent={AGENT} live={LIVE} liveBundle={FORK_BUNDLE} onChanged={() => {}} />
        </MemoryRouter>
      </ApiProvider>,
    );
    const user = userEvent.setup();
    const input = await screen.findByTestId("agent-test-run-payload-input");
    const start = screen.getByTestId("agent-test-run-start");

    // Typed into the empty box: `{{` is user-event's escape for one `{`.
    await user.click(input);
    await user.keyboard('{{"documentId": "d1"}');
    expect(input).toHaveValue('{"documentId": "d1"}');
    await user.click(start);
    await waitFor(() => expect(sent).toEqual([{ documentId: "d1" }]));

    // Pasted over everything in it.
    await user.clear(input);
    await user.click(input);
    await user.paste('{"documentId": "d2", "lineCount": 4}');
    expect(input).toHaveValue('{"documentId": "d2", "lineCount": 4}');
    await user.click(start);
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({ documentId: "d2", lineCount: 4 });

    // Not JSON: said at once, and nothing starts.
    await user.type(input, "}");
    expect(screen.getByText("The input must be JSON, e.g. {}.")).toBeInTheDocument();
    expect(start).toBeDisabled();

    // Blank is `{}`.
    await user.clear(input);
    expect(start).toBeEnabled();
    await user.click(start);
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]).toEqual({});
  });
});

describe("activate and pause", () => {
  function renderStatus(agent: typeof AGENT, check: () => unknown) {
    const api = fakeApi({
      [`GET /api/ops/agents/${AGENT.id}/activation`]: check,
      [`POST /api/ops/agents/${AGENT.id}/activate`]: () => ({
        agent: { ...agent, runStatus: "active" },
      }),
      [`POST /api/ops/agents/${AGENT.id}/pause`]: () => ({
        agent: { ...agent, runStatus: "paused" },
      }),
    });
    render(
      <ApiProvider client={api.client}>
        <MemoryRouter>
          {/* The screen's own copy of the agent never changes here: the chip must not wait on it. */}
          <OperationPanel agent={agent} live={LIVE} liveBundle={FORK_BUNDLE} onChanged={() => {}} />
        </MemoryRouter>
      </ApiProvider>,
    );
    return userEvent.setup();
  }

  it("shows Active as soon as activation succeeds, with no check still going", async () => {
    let checks = 0;
    const user = renderStatus(AGENT, () =>
      // The check after activating never answers.
      checks++ === 0 ? activation("succeeded") : new Promise(() => {}),
    );
    expect(await screen.findByTestId("agent-run-status")).toHaveTextContent("Draft");
    await user.click(await screen.findByTestId("agent-activate"));
    expect(await screen.findByTestId("agent-operation-done")).toHaveTextContent("Started");
    expect(screen.getByTestId("agent-run-status")).toHaveTextContent("Active");
    expect(screen.getByTestId("agent-pause")).toBeInTheDocument();
    expect(screen.queryByText("Checking activation…")).not.toBeInTheDocument();
  });

  it("shows Paused as soon as pausing succeeds", async () => {
    const user = renderStatus({ ...AGENT, runStatus: "active" }, () => activation("succeeded"));
    expect(await screen.findByTestId("agent-run-status")).toHaveTextContent("Active");
    await user.click(screen.getByTestId("agent-pause"));
    await waitFor(() => expect(screen.getByTestId("agent-run-status")).toHaveTextContent("Paused"));
    expect(screen.getByTestId("agent-activate")).toBeInTheDocument();
  });

  it("never says it is checking activation for an active agent", async () => {
    renderStatus({ ...AGENT, runStatus: "active" }, () => new Promise(() => {}));
    expect(await screen.findByTestId("agent-run-status")).toHaveTextContent("Active");
    expect(screen.queryByText("Checking activation…")).not.toBeInTheDocument();
  });
});
