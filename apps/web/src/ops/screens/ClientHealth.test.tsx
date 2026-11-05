// The client page's Health section (docs/plan.md §1.28): add the supervisor when the client has
// none; its latest check; each open finding with its audience, the operator's details and note,
// and the client admin's plain steps.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../App";
import { fakeApi } from "../../test/fixtures";
import { ClientHealthSection } from "./ClientHealth";

const CLIENT = "00000000-0000-4000-8000-00000000a002";
const SUPERVISOR = {
  id: "00000000-0000-4000-8000-0000000a5001",
  slug: "supervisor",
  name: "Account check",
  runStatus: "draft",
  liveVersionId: "00000000-0000-4000-8000-0000000a5101",
};

const finding = (over: Record<string, unknown>) => ({
  id: "00000000-0000-4000-8000-0000000fd001",
  audience: "operator",
  kind: "run_failed",
  title: "Record keeping failed at update: refused",
  fingerprint: "run_failed:a:fix-record:update",
  status: "open",
  createdAt: "2026-11-05T08:00:00.000Z",
  resolvedAt: null,
  remindedAt: null,
  reminders: 0,
  occurrences: 2,
  details: null,
  note: null,
  steps: [],
  sources: [],
  ...over,
});

function renderSection(api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter>
      <AppProviders client={api.client}>
        <ClientHealthSection clientId={CLIENT} />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("the client's health in the back office", () => {
  it("adds the supervisor to a client that has none", async () => {
    let added = false;
    const api = fakeApi({
      [`GET /api/ops/clients/${CLIENT}/health`]: () => ({
        supervisor: added ? SUPERVISOR : null,
        summary: null,
        findings: [],
      }),
      [`POST /api/ops/clients/${CLIENT}/supervisor`]: () => {
        added = true;
        return { supervisor: SUPERVISOR, created: true };
      },
    });
    renderSection(api);
    await userEvent.click(await screen.findByTestId("ops-client-add-supervisor"));
    await waitFor(() =>
      expect(screen.getByTestId("ops-client-supervisor-state")).toHaveTextContent(
        "Not active yet: draft",
      ),
    );
    expect(api.calls).toContain(`POST /api/ops/clients/${CLIENT}/supervisor`);
    expect(screen.getByText("No daily check yet. It runs at 08:00 their time.")).toBeVisible();
  });

  it("lists each open finding: the operator's details and note, the client's steps", async () => {
    const api = fakeApi({
      [`GET /api/ops/clients/${CLIENT}/health`]: () => ({
        supervisor: { ...SUPERVISOR, runStatus: "active" },
        summary: {
          checkedAt: "2026-11-06T08:00:00.000Z",
          state: "attention",
          runs: { total: 9, failed: 2 },
          connections: { total: 2, needsAttention: 0 },
          waiting: { count: 1, oldestHours: 4 },
          agents: { active: 2, paused: 0 },
          openFindings: 1,
        },
        findings: [
          finding({
            details: {
              agentName: "Record keeping",
              version: 3,
              stepId: "update",
              error: "refused: update is off on the testkit connection",
            },
            note: "Update is switched off on the testkit connection.",
          }),
          finding({
            id: "00000000-0000-4000-8000-0000000fd002",
            audience: "client_admin",
            title: "Record keeping could not finish its work",
            steps: ["Nothing for you to do yet: we have the details and are on it."],
            reminders: 1,
          }),
        ],
      }),
    });
    renderSection(api);
    const op = await screen.findByTestId("ops-finding-00000000-0000-4000-8000-0000000fd001");
    expect(within(op).getByText("Us")).toBeInTheDocument();
    expect(within(op).getByText("update")).toBeInTheDocument();
    expect(within(op).getByText("3")).toBeInTheDocument();
    expect(within(op).getByText("refused: update is off on the testkit connection")).toBeVisible();
    expect(within(op).getByText("Update is switched off on the testkit connection.")).toBeVisible();
    expect(within(op).getByText("seen 2×")).toBeInTheDocument();
    const cl = screen.getByTestId("ops-finding-00000000-0000-4000-8000-0000000fd002");
    expect(within(cl).getByText("Client admin")).toBeInTheDocument();
    expect(within(cl).getByRole("listitem")).toHaveTextContent("Nothing for you to do yet");
    expect(within(cl).getByText("reminded 1×")).toBeInTheDocument();
    expect(screen.getByTestId("ops-client-supervisor-state")).toHaveTextContent("Watching");
    expect(screen.getByTestId("ops-client-health-summary")).toHaveTextContent(
      "9 live runs in a day, 2 failed",
    );
  });
});
