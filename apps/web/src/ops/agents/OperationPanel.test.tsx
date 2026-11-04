// The activation check follows a running test run (plan §1.16): while the live version's latest
// test run is going it says so and polls, and turns ready when the run passes, without a reload.
// Starting a test run from the panel makes it look again at once.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { AGENT_SUMMARY, FORK_BUNDLE, fakeApi, versionId } from "../../test/fixtures";
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
        <OperationPanel
          agent={AGENT}
          connections={[]}
          live={LIVE}
          liveBundle={FORK_BUNDLE}
          onChanged={() => {}}
        />
      </MemoryRouter>
    </ApiProvider>,
  );
  return { api, checks: () => n };
}

describe("activation and a running test run", () => {
  it("says a test run is going, polls it, and turns ready when it passes", async () => {
    renderPanel(["running", "running", "succeeded"]);
    expect(await screen.findByTestId("agent-activation-test-running")).toHaveTextContent(
      "A test run of v1 is going",
    );
    expect(screen.getByTestId("agent-activation-problems")).toBeInTheDocument();
    expect(
      await screen.findByTestId("agent-activation-ready", {}, { timeout: 6_000 }),
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
