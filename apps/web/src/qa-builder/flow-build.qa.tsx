// QA (flow and usability lens, 2026-11-19): the build page's lost work and double actions.
// Each test asserts the expected behaviour and fails while its defect is there.
import type { BuildDetail, BuildSummary } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { fakeApi, OPERATOR_SESSION } from "../test/fixtures";

await import("../ops/OpsApp");

const ID = "00000000-0000-4000-8000-0000000b0001";
const at = "2026-11-15T10:00:00.000Z";

const summary: BuildSummary = {
  id: ID,
  kind: "agent",
  title: "Invoice intake reviewer",
  client: null,
  phase: "intake",
  status: "open",
  agentId: null,
  skillId: null,
  testAgentId: null,
  testClient: null,
  openItems: 0,
  waitingOnClient: 0,
  createdBy: "Ann",
  createdAt: at,
  updatedAt: at,
  phaseAt: at,
  path: "new",
  templateId: null,
  promisedOn: null,
  origin: null,
  requirements: null,
  pipelineStage: "building",
  standing: "you",
  waitingOn: "operator",
  statusLine: "",
  stuck: false,
};

type Message = BuildDetail["messages"][number];

function intake(messages: Message[] = []): BuildDetail {
  return {
    build: {
      ...summary,
      brief: {
        goal: { text: "Check invoices against contracts", state: "confirmed" },
        trigger: { text: "An invoice is forwarded", state: "confirmed" },
        dataIn: { text: "Invoice PDFs", state: "confirmed" },
        dataOut: { text: "Review notes", state: "confirmed" },
      },
      fitgap: { rows: [], needsTrue: [], setup: [], decisions: [] },
      testPlan: { datasets: [] },
      qa: { accepted: {}, signedBy: null, signedAt: null, decision: null },
    },
    phases: [
      { phase: "intake", label: "Intake", state: "current" },
      { phase: "fitgap", label: "Fit-gap", state: "todo" },
      { phase: "draft", label: "Draft", state: "todo" },
      { phase: "poc", label: "POC test", state: "todo" },
      { phase: "client_test", label: "Client test", state: "todo" },
      { phase: "qa", label: "QA and go / no-go", state: "todo" },
    ],
    gate: { next: "fitgap", reasons: [] },
    messages,
    items: [],
    draft: null,
    poc: null,
    clientTest: null,
    qaChecks: [],
    events: [],
  };
}

const said = (id: string, role: "operator" | "builder", text: string): Message => ({
  id,
  phase: "intake",
  role,
  text,
  chips: [],
  changes: [],
  createdAt: at,
});

const common = {
  "GET /api/session": () => OPERATOR_SESSION,
  "GET /api/ops/clients": () => ({ clients: [] }),
  "GET /api/ops/counts": () => ({ needsUs: 0, clients: [] }),
};

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("QA flow: the build page", () => {
  // FLOW-1: IntakePanel resets its local brief from `detail.build.brief` on every new reference,
  // and every action (a chat turn, an item's state) answers with a new BuildDetail object.
  it("FLOW-1 keeps an unsaved brief edit when the operator sends a message to the Builder", async () => {
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => intake(),
      // The Builder answers without touching the brief: the brief is equal, a new object.
      [`POST /api/ops/builds/${ID}/turns`]: () =>
        intake([
          said("m1", "operator", "Is the goal clear?"),
          said("m2", "builder", "Yes. Anything else?"),
        ]),
    });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");
    const goal = within(view).getByTestId("build-brief-goal");
    await userEvent.type(goal, " every Monday for Harbor");
    expect(goal).toHaveValue("Check invoices against contracts every Monday for Harbor");

    await userEvent.type(within(view).getByTestId("build-input"), "Is the goal clear?");
    await userEvent.click(within(view).getByTestId("build-send"));
    expect(await within(view).findByText("Yes. Anything else?")).toBeInTheDocument();

    // Expected: what the operator typed in the brief (not yet saved) is still there.
    expect(within(view).getByTestId("build-brief-goal")).toHaveValue(
      "Check invoices against contracts every Monday for Harbor",
    );
  });

  // FLOW-2: the composer stays open while a phase move runs (it is off only while a chat turn
  // runs), and the turn's `finally` sets `busy` to null though the move is still on its way.
  it("FLOW-2 keeps Confirm off while its move runs, even after a chat turn sent meanwhile returns", async () => {
    const moves: unknown[] = [];
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => intake(),
      // The second look at the brief and the fit-gap take a minute or more.
      [`POST /api/ops/builds/${ID}/phase`]: ({ init }) => {
        moves.push(JSON.parse(String(init.body)));
        return new Promise(() => {});
      },
      [`POST /api/ops/builds/${ID}/turns`]: () =>
        intake([
          said("m1", "operator", "While you work: volume is 40 a week."),
          said("m2", "builder", "Noted."),
        ]),
    });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");
    await userEvent.click(within(view).getByTestId("build-confirm-brief"));
    await waitFor(() => expect(moves).toHaveLength(1));
    expect(within(view).getByTestId("build-confirm-brief")).toBeDisabled();

    // The operator adds a line while waiting: the box lets them send it.
    await userEvent.type(
      within(view).getByTestId("build-input"),
      "While you work: volume is 40 a week.",
    );
    await userEvent.click(within(view).getByTestId("build-send"));
    expect(await within(view).findByText("Noted.")).toBeInTheDocument();

    // Expected: the move hasn't answered, so Confirm is still off (no second move).
    expect(within(view).getByTestId("build-confirm-brief")).toBeDisabled();
  });

  // FLOW-3: the QA panel's Go live is off while `detail.gate.reasons` holds, but QaPanel never
  // renders those reasons (only `Next` and the client test panel do).
  it("FLOW-3 says why Go live is off once QA is signed", async () => {
    const base = intake();
    const qa: BuildDetail = {
      ...base,
      build: {
        ...base.build,
        phase: "qa",
        qa: { accepted: {}, signedBy: "Ann", signedAt: at, decision: null },
      },
      phases: base.phases.map((p) => ({
        ...p,
        state: p.phase === "qa" ? ("current" as const) : ("done" as const),
      })),
      gate: { next: null, reasons: ["1 open item is not done or put off."] },
      qaChecks: [
        {
          id: "tests",
          label: "Required test cases pass",
          state: "pass",
          detail: "3 of 3 pass",
          reason: null,
        },
      ],
    };
    const api = fakeApi({ ...common, [`GET /api/ops/builds/${ID}`]: () => qa });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");
    const decision = within(view).getByTestId("build-decision");
    expect(within(decision).getByTestId("build-go")).toBeDisabled();
    // Expected: the reason it can't go live is said beside the button.
    expect(decision).toHaveTextContent("1 open item is not done or put off.");
  });

  // FLOW-10: an open question's "Answer it" (and a try's "Wrong", PocPanel onAbout) calls
  // `setDraftText(\`About “${title}”: \`)` (BuildView.tsx:555, :582), replacing what the operator
  // had already typed in the conversation's box with no way to get it back.
  it("FLOW-10 keeps the words already in the box when an issue's Answer it is pressed", async () => {
    const ITEM = "00000000-0000-4000-8000-0000000b0101";
    const withQuestion: BuildDetail = {
      ...intake(),
      items: [
        {
          id: ITEM,
          phase: "intake",
          kind: "question",
          title: "How many invoices a week",
          detail: "",
          owner: "operator",
          state: "open",
          stepId: null,
          ref: {},
          key: "brief:volume",
          createdAt: at,
          resolvedAt: null,
        },
      ],
    };
    const api = fakeApi({ ...common, [`GET /api/ops/builds/${ID}`]: () => withQuestion });
    renderAt(`/ops/builds/${ID}`, api);
    const view = await screen.findByTestId("build-view");
    const box = within(view).getByTestId("build-input");
    await userEvent.type(box, "The approver is Dana in accounts payable, and");
    await userEvent.click(within(view).getByTestId(`build-item-${ITEM}-answer`));
    // Expected: what was typed is still in the box (the "About …" start added, not swapped in).
    expect(within(view).getByTestId("build-input")).toHaveValue(
      expect.stringContaining("The approver is Dana in accounts payable, and"),
    );
  });
});
