// The go-live stage on a client agent's page (ARCHITECTURE §10.9): the trial in numbers, and a move
// forward that waits for a reason while a move back doesn't.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { AGENT_SUMMARY, FORK_BUNDLE, fakeApi } from "../../test/fixtures";
import { GoLivePanel } from "./GoLivePanel";

const AGENT = { ...AGENT_SUMMARY, kind: "client" as const, runStatus: "active", status: "active" };

const TRIAL = {
  stage: "trial",
  writes: true,
  trial: {
    startedAt: "2026-11-01T10:00:00.000Z",
    minDays: 14,
    minRuns: 25,
    days: 5,
    runs: 9,
    daysMetAt: "2026-11-15T10:00:00.000Z",
    ready: false,
  },
  signoff: null,
  skipped: [],
  rejections: [],
  pause: null,
};

describe("the go-live panel", () => {
  it("shows the trial in numbers and needs a reason to move forward", async () => {
    const moves: unknown[] = [];
    const api = fakeApi({
      [`GET /api/ops/agents/${AGENT.id}/go-live`]: () => ({ goLive: TRIAL }),
      [`GET /api/ops/clients/${AGENT.tenantId}/events`]: () => ({ events: [] }),
      [`POST /api/ops/agents/${AGENT.id}/stage`]: ({ init }) => {
        moves.push(JSON.parse(String(init.body)));
        return { goLive: { ...TRIAL, stage: "live", trial: null } };
      },
    });
    render(
      <ApiProvider client={api.client}>
        <MemoryRouter>
          <GoLivePanel agent={AGENT} liveBundle={FORK_BUNDLE} onChanged={() => {}} />
        </MemoryRouter>
      </ApiProvider>,
    );
    expect(await screen.findByTestId("agent-stage")).toHaveTextContent("Trial");
    expect(screen.getByTestId("agent-trial-progress")).toHaveTextContent(
      "5 days of 14, 9 finished runs of 25",
    );
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId("agent-stage-select"), "live");
    expect(screen.getByTestId("agent-stage-move")).toBeDisabled();
    await user.type(screen.getByTestId("agent-stage-reason-input"), "Ran with us for a month");
    await user.click(screen.getByTestId("agent-stage-move"));
    expect(moves).toEqual([{ to: "live", reason: "Ran with us for a month" }]);
    // Back needs no reason.
    await user.selectOptions(screen.getByTestId("agent-stage-select"), "bench");
    expect(screen.getByTestId("agent-stage-move")).toBeEnabled();
  });
});
