// The portal's overview with the supervisor (docs/plan.md §1.28): the latest account check and the
// open findings that need the client, each a title and plain steps, in the client's language;
// nothing when there is no check yet. A finding in the inbox shows its steps and one "Done".
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";

const FINDING = {
  id: "00000000-0000-4000-8000-0000000fd001",
  kind: "connection_signin",
  title: "Zoho CRM needs you to sign in again",
  steps: ["Go to Connections.", "Find Zoho CRM.", "Choose Reconnect and follow the steps."],
  createdAt: "2026-11-05T08:00:00.000Z",
  remindedAt: "2026-11-06T08:00:00.000Z",
};

const SUMMARY = {
  checkedAt: "2026-11-06T08:00:00.000Z",
  state: "attention",
  runs: { total: 12, failed: 1 },
  connections: { total: 3, needsAttention: 1 },
  waiting: { count: 2, oldestHours: 30 },
  agents: { active: 3, paused: 0 },
  openFindings: 1,
};

const overview = (health: unknown) => ({
  client: { id: "00000000-0000-4000-8000-00000000a002", name: "Demo client" },
  services: [],
  needsYou: { inbox: 1 },
  recentRuns: [],
  ...(health === undefined ? {} : { health }),
});

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const base = {
  "GET /api/session": () => CLIENT_SESSION,
  "GET /api/feedback/status": () => ({ enabled: false }),
};

describe("the overview's account check", () => {
  it("shows the latest check and the findings that need the client, with their steps", async () => {
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview({ summary: SUMMARY, findings: [FINDING] }),
    });
    renderAt("/", api);
    const findings = await screen.findByTestId("portal-findings");
    expect(within(findings).getByText("What needs you now")).toBeInTheDocument();
    const card = within(findings).getByTestId(`portal-finding-${FINDING.id}`);
    expect(within(card).getByText(FINDING.title)).toBeInTheDocument();
    const steps = within(card)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(steps).toEqual(FINDING.steps);
    // A reminder says so in words (signal, with a word).
    expect(within(card).getByText("Reminder")).toBeInTheDocument();

    const health = screen.getByTestId("portal-health");
    expect(within(health).getByTestId("portal-health-state")).toHaveTextContent("Needs a look");
    expect(health).toHaveTextContent("12 runs in the last day · 1 did not finish");
    expect(health).toHaveTextContent("1 connection needs you");
    expect(health).toHaveTextContent("2 items wait for you");
  });

  it("says all is good, and shows nothing at all before the first check", async () => {
    const good = { ...SUMMARY, state: "good", runs: { total: 1, failed: 0 } };
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview({ summary: good, findings: [] }),
    });
    const { unmount } = renderAt("/", api);
    expect(await screen.findByTestId("portal-health-state")).toHaveTextContent("All good");
    expect(screen.getByTestId("portal-health")).toHaveTextContent("1 run in the last day");
    expect(screen.queryByTestId("portal-findings")).not.toBeInTheDocument();
    unmount();

    // An API without the supervisor (or before its first check): the overview is as it was.
    const none = fakeApi({ ...base, "GET /api/overview": () => overview(undefined) });
    renderAt("/", none);
    expect(await screen.findByTestId("portal-needs-you")).toBeInTheDocument();
    expect(screen.queryByTestId("portal-health")).not.toBeInTheDocument();
    expect(screen.queryByTestId("portal-findings")).not.toBeInTheDocument();
  });

  it("reads in the client's language", async () => {
    const api = fakeApi({
      ...base,
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        language: { effective: "es", user: null, client: "es" },
      }),
      "GET /api/overview": () =>
        overview({
          summary: SUMMARY,
          findings: [{ ...FINDING, title: "Zoho CRM necesita que inicie sesión de nuevo" }],
        }),
    });
    renderAt("/", api);
    expect(await screen.findByText("Lo que le necesita ahora")).toBeInTheDocument();
    expect(screen.getByText("Revisión de la cuenta")).toBeInTheDocument();
    expect(screen.getByTestId("portal-health-state")).toHaveTextContent("Necesita atención");
    expect(screen.getByText("Recordatorio")).toBeInTheDocument();
  });

  it("a finding in the inbox lists its steps and is closed with Done", async () => {
    const item = {
      id: FINDING.id,
      kind: "review",
      title: FINDING.title,
      payload: {
        fingerprint: "connection_signin:x",
        finding: { kind: "connection_signin", steps: FINDING.steps, reminders: 0 },
      },
      status: "open",
      runId: null,
      dueAt: null,
      createdAt: FINDING.createdAt,
      resolvedAt: null,
      resolvedBy: null,
    };
    const sent: unknown[] = [];
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview({ summary: null, findings: [] }),
      "GET /api/inbox": () => ({ items: [item] }),
      [`POST /api/inbox/${FINDING.id}/resolve`]: async ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return { item: { ...item, status: "resolved", resolvedAt: FINDING.createdAt } };
      },
    });
    renderAt("/inbox", api);
    const steps = await screen.findByTestId("desk-steps");
    expect(within(steps).getAllByRole("listitem")).toHaveLength(3);
    // Nothing internal is listed as a fact: the fingerprint and the finding's state are plumbing.
    expect(screen.queryByText(/connection_signin:x/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("desk-sign")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("desk-done"));
    expect(sent).toEqual([{ decision: "approve" }]);
  });
});
