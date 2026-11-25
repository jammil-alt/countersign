// Check the steps over a v5 draft (stream Q): the same screen, with lines as Do steps, a Fork as the
// decision, Ends that deliver declared outputs, a typed line matched with the Uses picker, core's
// checks listed as the steps builder lists them, and Build it saving the v5 workflow.
import type { steps } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { fakeApi } from "../../test/fixtures";
import { CheckSteps } from "./CheckSteps";
import {
  agentDetail,
  BUILD_ID,
  buildDetail,
  DRAFT_AGENT_ID,
  DRAFT_VERSION,
  draftBundle5,
  SAVED_VERSION,
  SESSION_ID,
  savedVersion,
  sessionDetail,
  sessionSave,
  sessionTurn,
  stepsCatalog,
} from "./checkFixtures";

const WORDS =
  "When a vendor invoice arrives, read it. If it is a duplicate, tell Dana. Then create the bill.";

function Landed() {
  const location = useLocation();
  return (
    <p data-testid="landed" data-state={JSON.stringify(location.state ?? null)}>
      {location.pathname}
      {location.search}
    </p>
  );
}

function ids() {
  let n = 0;
  return () => `n-${++n}`;
}

function renderCheck(api: ReturnType<typeof fakeApi>, words: string = WORDS) {
  render(
    <MemoryRouter initialEntries={[`/ops/lab/check/${BUILD_ID}`]}>
      <ApiProvider client={api.client}>
        <Routes>
          <Route
            path="/ops/lab/check/:id"
            element={<CheckSteps buildId={BUILD_ID} words={words} newId={ids()} />}
          />
          <Route path="*" element={<Landed />} />
        </Routes>
      </ApiProvider>
    </MemoryRouter>,
  );
  return userEvent.setup();
}

function routes(extra: Record<string, unknown> = {}) {
  const saved: { bundle: { workflows: { workflow: unknown }[] }; parentVersionId: string }[] = [];
  const turns: { text: string }[] = [];
  const api = fakeApi({
    [`GET /api/ops/builds/${BUILD_ID}`]: () =>
      buildDetail({ agentId: DRAFT_AGENT_ID, words: WORDS }),
    [`GET /api/ops/agents/${DRAFT_AGENT_ID}`]: () => agentDetail(draftBundle5()),
    ...stepsCatalog(),
    [`POST /api/ops/agents/${DRAFT_AGENT_ID}/versions`]: ({ init }: { init: RequestInit }) => {
      saved.push(JSON.parse(String(init.body)));
      return savedVersion();
    },
    "POST /api/ops/builder/sessions": () => sessionDetail(),
    [`POST /api/ops/builder/sessions/${SESSION_ID}/turns`]: ({ init }: { init: RequestInit }) => {
      turns.push(JSON.parse(String(init.body)));
      return sessionTurn();
    },
    [`POST /api/ops/builder/sessions/${SESSION_ID}/save`]: () => sessionSave(),
    ...extra,
  } as never);
  return { api, saved, turns };
}

const lineIds = () =>
  screen.getAllByTestId("flow-check-line").map((l) => l.getAttribute("data-step-id"));

describe("Check the steps over a v5 draft", () => {
  it("shows the draft as lines: Do steps by what they use, the Fork as a decision, the End and what it delivers", async () => {
    renderCheck(routes().api);
    await screen.findByTestId("flow-check");
    expect(screen.getByTestId("flow-check-summary")).toHaveTextContent(
      "The Builder read your description as 2 steps and 1 decision.",
    );
    expect(screen.getByTestId("flow-check-start-document")).toHaveAttribute("aria-pressed", "true");
    expect(lineIds()).toEqual(["s-read", "s-dup", "s-bill"]);
    const kinds = screen.getAllByTestId("flow-check-line-kind").map((k) => k.textContent);
    expect(kinds).toEqual(["Read a document", "Tell", "QuickBooks Online › Create a bill"]);
    const decision = screen.getByTestId("flow-check-decision");
    expect(within(decision).getByTestId("flow-check-condition")).toHaveValue(
      "the invoice is a duplicate",
    );
    // The main line's End, kept: it delivers the bill.
    const ends = screen.getAllByTestId("flow-check-end");
    expect(ends).toHaveLength(1);
    expect(within(ends[0] as HTMLElement).getByTestId("flow-check-end-output")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("flow-check-end-write")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("flow-check-way-out")).toHaveTextContent(
      "Ends on the main line: The bill in QuickBooks",
    );
    // Nothing is left to settle in this draft: no checks are listed.
    expect(screen.queryByTestId("publish-issues")).not.toBeInTheDocument();
    expect(screen.getByTestId("flow-check-build")).toBeEnabled();
  });

  it("lists a typed line as not built yet, then matches it to an action with its approver on", async () => {
    const { api, saved } = routes();
    const user = renderCheck(api);
    await screen.findByTestId("flow-check");
    await user.click(screen.getByTestId("flow-check-add-step"));
    await user.type(
      screen.getAllByTestId("flow-check-line-input").at(-1) as HTMLElement,
      "Email the vendor",
    );
    // A line typed here goes before the End; core's check says it isn't built yet.
    expect(lineIds()).toEqual(["s-read", "s-dup", "s-bill", "n-1"]);
    expect(await screen.findByTestId("publish-issues")).toHaveTextContent(
      "Not built yet: Email the vendor",
    );
    // Pick what it does: Rules, using Email › Send an email.
    const line = screen.getAllByTestId("flow-check-line").at(-1) as HTMLElement;
    await user.click(within(line).getByTestId("flow-check-line-match"));
    await user.click(within(line).getByRole("button", { name: "What it uses" }));
    await user.click(within(line).getByText("Email › Send an email"));
    expect(screen.getAllByTestId("flow-check-line-kind").at(-1)).toHaveTextContent(
      "Email › Send an email",
    );
    expect(screen.queryByTestId("publish-issues")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("flow-check-build"));
    expect(await screen.findByTestId("landed")).toHaveTextContent(
      "/ops/templates/invoice-intake/workflows/invoice-intake",
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]?.parentVersionId).toBe(DRAFT_VERSION);
    const w = saved[0]?.bundle.workflows[0]?.workflow as steps.Workflow;
    expect(w.schemaVersion).toBe(5);
    expect(w.steps.map((s) => s.id)).toEqual(["s-read", "s-dup", "s-bill", "n-1", "s-end"]);
    // A Send asks first (invariant 8).
    expect(w.steps[3]).toEqual({
      id: "n-1",
      kind: "do",
      name: "Email the vendor",
      input: {},
      doneBy: "rules",
      uses: { type: "action", action: "email.send" },
      checks: {
        approval: { required: "required", mode: "in_turn", ifNoAnswer: "stop", onReject: "stop" },
      },
    });
  });

  it("asks the Builder to fill a line left not built yet, from the saved version", async () => {
    const started: unknown[] = [];
    const { api, saved, turns } = routes({
      "POST /api/ops/builder/sessions": ({ init }: { init: RequestInit }) => {
        started.push(JSON.parse(String(init.body)));
        return sessionDetail();
      },
    });
    const user = renderCheck(api);
    await screen.findByTestId("flow-check");
    await user.click(screen.getByTestId("flow-check-add-step"));
    await user.type(
      screen.getAllByTestId("flow-check-line-input").at(-1) as HTMLElement,
      "Code each line to a job",
    );
    expect(screen.getAllByTestId("flow-check-line-kind").at(-1)).toHaveTextContent(
      "The Builder fills it",
    );
    await user.click(screen.getByTestId("flow-check-build"));
    await screen.findByTestId("landed");
    const w = saved[0]?.bundle.workflows[0]?.workflow as steps.Workflow;
    expect(w.steps[3]).toEqual({
      id: "n-1",
      kind: "do",
      name: "Code each line to a job",
      input: {},
      uses: { type: "missing", need: "Code each line to a job" },
    });
    expect(started).toEqual([
      { kind: "agent", agentId: DRAFT_AGENT_ID, fromVersionId: SAVED_VERSION },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toContain('"Code each line to a job"');
  });

  it("ends a path on an End, and waits on the operator until it delivers something", async () => {
    const { api } = routes();
    const user = renderCheck(api);
    await screen.findByTestId("flow-check");
    await user.selectOptions(
      screen.getAllByTestId("flow-check-path-end")[0] as HTMLElement,
      "stop",
    );
    const decision = screen.getByTestId("flow-check-decision");
    const pathEnd = within(decision).getByTestId("flow-check-end");
    expect(screen.getByTestId("flow-check-dead-end")).toHaveTextContent(
      "Waiting on you: Pick what this End delivers, or say why there is nothing to do.",
    );
    expect(screen.getByTestId("flow-check-build")).toBeDisabled();
    await user.click(within(pathEnd).getByTestId("flow-check-end-output"));
    await waitFor(() => expect(screen.getByTestId("flow-check-build")).toBeEnabled());
    expect(screen.queryByTestId("flow-check-dead-end")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("flow-check-way-out").map((w) => w.textContent)).toEqual([
      "·Ends on If the invoice is a duplicate: The bill in QuickBooks",
      "·Ends on the main line: The bill in QuickBooks",
    ]);
    // Rejoining takes the path's End away; the main line's stays.
    await user.selectOptions(screen.getAllByTestId("flow-check-path-end")[0] as HTMLElement, "on");
    expect(screen.getAllByTestId("flow-check-end")).toHaveLength(1);
  });

  it("declares an output from a card, which the main End delivers, and lists what it still needs", async () => {
    const { api } = routes();
    const user = renderCheck(api);
    await screen.findByTestId("flow-check");
    await user.click(screen.getByTestId("flow-check-end-handoff"));
    expect(screen.getByTestId("flow-check-end-handoff")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("flow-check-way-out")).toHaveTextContent(
      "Ends on the main line: The bill in QuickBooks, Hand off to another agent",
    );
    // The outputs editor is the steps builder's own.
    expect(
      within(screen.getByTestId("flow-check-outputs")).getByTestId("workflow-outputs"),
    ).toBeInTheDocument();
  });
  it("drafts a build with no draft from the lines' words", async () => {
    const asked: unknown[] = [];
    const api = fakeApi({
      [`GET /api/ops/builds/${BUILD_ID}`]: () => buildDetail(),
      [`POST /api/ops/builds/${BUILD_ID}/draft-now`]: ({ init }: { init: RequestInit }) => {
        asked.push(JSON.parse(String(init.body)));
        return buildDetail({ agentId: DRAFT_AGENT_ID });
      },
      ...stepsCatalog(),
    } as never);
    const user = renderCheck(api, "");
    await screen.findByTestId("flow-check");
    expect(screen.getByTestId("flow-check-summary")).toHaveTextContent(
      "Say how it starts, then list what happens",
    );
    expect(screen.queryByTestId("flow-check-quote")).toBeNull();
    // Nothing typed yet: nothing to build.
    expect(screen.getByTestId("flow-check-build")).toBeDisabled();
    // A document arrives, instead of a person starting it.
    await user.click(screen.getByTestId("flow-check-start-document"));
    await user.click(screen.getByTestId("flow-check-start-person"));
    await user.type(screen.getByTestId("flow-check-line-input"), "Read the invoice{Enter}");
    await user.type(
      screen.getAllByTestId("flow-check-line-input").at(-1) as HTMLElement,
      "Create the bill",
    );
    await user.click(screen.getByTestId("flow-check-build"));
    expect(await screen.findByTestId("landed")).toHaveTextContent(
      `/ops/agents/${DRAFT_AGENT_ID}/workflow`,
    );
    expect(asked).toEqual([
      {
        description: "It starts: When a document arrives. 1. Read the invoice. 2. Create the bill.",
      },
    ]);
  });

  it("goes back to the description with the words", async () => {
    const { api } = routes();
    const user = renderCheck(api);
    await screen.findByTestId("flow-check");
    await user.click(screen.getByTestId("flow-check-back"));
    const landed = await screen.findByTestId("landed");
    expect(landed).toHaveTextContent("/ops/lab?tab=drafts&new=template");
    expect(JSON.parse(landed.getAttribute("data-state") ?? "null")).toEqual({
      describe: { name: "Invoice intake", words: WORDS, kind: "template" },
    });
  });

  it("opens the workflow as it is on Start with a blank canvas", async () => {
    const { api } = routes();
    const user = renderCheck(api);
    await screen.findByTestId("flow-check");
    await user.click(screen.getByTestId("flow-check-blank"));
    expect(await screen.findByTestId("landed")).toHaveTextContent(/\/workflows\//);
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("POST"))).toBe(false));
  });
});
