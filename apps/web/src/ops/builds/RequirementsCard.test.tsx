// A build's Requirements request reads its agent's card from the client's intake (docs/plan.md
// §1.149.2; cases-plan §3.2): answered of total, what's still needed to start and who has it.
import type { OpsIntakeSummary, OpsIntakeView } from "@countersign/core";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";
import { intakeForTemplate, RequirementsCard } from "./RequirementsCard";

const CLIENT = "00000000-0000-4000-8000-00000000a002";
const T = "00000000-0000-4000-8000-0000000f00a1";
const I1 = "00000000-0000-4000-8000-0000000f0001";

const summary = (over: Partial<OpsIntakeSummary> = {}): OpsIntakeSummary => ({
  id: I1,
  client: { id: CLIENT, name: "Acme" },
  fileId: null,
  dealId: null,
  status: "open",
  covers: { general: true, areas: [], templateIds: [T] },
  startMode: "point",
  people: 2,
  answered: 3,
  total: 9,
  sendAt: null,
  createdAt: "2026-11-17T10:00:00.000Z",
  updatedAt: "2026-11-17T10:00:00.000Z",
  ...over,
});

const view: OpsIntakeView = {
  intake: { ...summary(), leadNote: "", lead: null },
  guide: {
    version: 1,
    sections: [],
    totals: { known: 0, toConfirm: 0, toAsk: 0, later: 0, tools: 0, minutes: 0 },
  },
  people: [],
  answers: [],
  progress: [
    {
      sectionKey: `agent:${T}`,
      answered: 7,
      total: 12,
      notSure: 1,
      missing: [
        { fieldKey: "tool.qbo", label: "Connect QuickBooks", who: "Mark Lee" },
        { fieldKey: "agent.x.tol", label: "How far off can a price be?", who: null },
      ],
      decision: "start",
    },
  ],
  events: [],
};

describe("the build's Requirements request", () => {
  it("picks the newest open intake that asks the template's card", () => {
    const old = summary({ id: "a", createdAt: "2026-11-01T00:00:00.000Z" });
    const newer = summary({ id: "b", createdAt: "2026-11-10T00:00:00.000Z" });
    const done = summary({ id: "c", status: "done", createdAt: "2026-11-15T00:00:00.000Z" });
    const other = summary({ id: "d", covers: { general: true, areas: [], templateIds: [] } });
    expect(intakeForTemplate([old, newer, done, other], T)?.id).toBe("b");
    expect(intakeForTemplate([done], T)?.id).toBe("c");
    expect(intakeForTemplate([other], T)).toBeNull();
  });

  it("shows the card's progress, what's missing and who has it", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/intakes": () => ({ intakes: [summary()] }),
      [`GET /api/ops/intakes/${I1}`]: () => view,
    });
    render(
      <MemoryRouter>
        <AppProviders client={api.client}>
          <RequirementsCard clientId={CLIENT} templateId={T} />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("build-requirements-progress")).toHaveTextContent(
      "7 of 12 answered",
    );
    const missing = screen.getByTestId("build-requirements-missing");
    expect(missing).toHaveTextContent("Connect QuickBooks");
    expect(missing).toHaveTextContent("Mark Lee has it");
    expect(screen.getByTestId("build-requirements")).toHaveTextContent(
      "They chose to start with it.",
    );
  });

  it("says when no intake asks for the agent", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/intakes": () => ({ intakes: [] }),
    });
    render(
      <MemoryRouter>
        <AppProviders client={api.client}>
          <RequirementsCard clientId={CLIENT} templateId={T} />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("build-requirements")).toHaveTextContent(
      "No intake asks for this agent yet",
    );
  });
});
