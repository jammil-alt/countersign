// Check the steps (F5): the saved draft as lines, edited in place (ids kept), Build it saving the
// right bundle as a new version and asking the Builder once to fill the lines typed by hand; a
// build with no draft drafted from the lines' words; Back to the description with the words.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { fakeApi, Reply } from "../../test/fixtures";
import { CheckSteps } from "./CheckSteps";
import {
  agentDetail,
  BUILD_ID,
  buildDetail,
  DRAFT_AGENT_ID,
  DRAFT_VERSION,
  draftProcess,
  SAVED_VERSION,
  SESSION_ID,
  savedVersion,
  sessionDetail,
  sessionSave,
  sessionTurn,
} from "./checkFixtures";

const WORDS =
  "When a vendor invoice arrives, read the invoice. If the invoice is a duplicate, tell Dana. Then create the bill.";

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

function renderCheck(api: ReturnType<typeof fakeApi>, words: string | undefined = WORDS) {
  render(
    <MemoryRouter initialEntries={[`/ops/builds/${BUILD_ID}/check`]}>
      <ApiProvider client={api.client}>
        <Routes>
          <Route
            path="/ops/builds/:id/check"
            element={<CheckSteps buildId={BUILD_ID} words={words} newId={ids()} />}
          />
          <Route path="*" element={<Landed />} />
        </Routes>
      </ApiProvider>
    </MemoryRouter>,
  );
  return userEvent.setup();
}

const drafted = () => ({
  [`GET /api/ops/builds/${BUILD_ID}`]: () => buildDetail({ agentId: DRAFT_AGENT_ID, words: WORDS }),
  [`GET /api/ops/agents/${DRAFT_AGENT_ID}`]: () => agentDetail(),
});

describe("Check the steps", () => {
  it("shows the saved draft as lines: how it starts, the steps and a decision with its paths", async () => {
    renderCheck(fakeApi(drafted()));
    await screen.findByTestId("flow-check");
    expect(screen.getByTestId("flow-stepper")).toHaveTextContent("Check the steps");
    expect(screen.getByTestId("flow-check-summary")).toHaveTextContent(
      "The Builder read your description as 2 steps and 1 decision.",
    );
    expect(screen.getByTestId("flow-check-quote")).toHaveTextContent("When a vendor invoice");
    expect(screen.getByTestId("flow-check-start-document")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("flow-check-start-words")).toHaveValue("When a document arrives");
    const lines = screen.getAllByTestId("flow-check-line");
    expect(lines.map((l) => l.getAttribute("data-step-id"))).toEqual(["s-read", "s-dup", "s-bill"]);
    expect(within(lines[0] as HTMLElement).getByTestId("flow-check-line-input")).toHaveValue(
      "Read the invoice",
    );
    expect(within(lines[0] as HTMLElement).getByTestId("flow-check-line-kind")).toHaveTextContent(
      "Skill",
    );
    const decision = within(lines[1] as HTMLElement).getByTestId("flow-check-decision");
    expect(within(decision).getByTestId("flow-check-condition")).toHaveValue(
      "the invoice is a duplicate",
    );
    expect(within(decision).getByTestId("flow-check-line-input")).toHaveValue("Tell Dana");
    // The If path and the otherwise both come back to the steps below.
    expect(
      within(decision)
        .getAllByTestId("flow-check-path-end")
        .map((s) => (s as HTMLSelectElement).value),
    ).toEqual(["on", "on"]);
    expect(within(decision).getByTestId("flow-check-after-together")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("flow-check-blank")).toBeInTheDocument();
  });

  it("saves the edited bundle on Build it, asks the Builder once to fill the lines typed by hand, then opens the workflow", async () => {
    const saved: unknown[] = [];
    const started: unknown[] = [];
    const turns: unknown[] = [];
    const api = fakeApi({
      ...drafted(),
      [`POST /api/ops/agents/${DRAFT_AGENT_ID}/versions`]: ({ init }) => {
        saved.push(JSON.parse(String(init.body)));
        return savedVersion();
      },
      "POST /api/ops/builder/sessions": ({ init }) => {
        started.push(JSON.parse(String(init.body)));
        return sessionDetail();
      },
      [`POST /api/ops/builder/sessions/${SESSION_ID}/turns`]: ({ init }) => {
        turns.push(JSON.parse(String(init.body)));
        return sessionTurn();
      },
      [`POST /api/ops/builder/sessions/${SESSION_ID}/save`]: () => sessionSave(),
    });
    const user = renderCheck(api);
    await screen.findByTestId("flow-check");
    // Rename the first line.
    const first = screen.getAllByTestId("flow-check-line-input")[0] as HTMLElement;
    await user.clear(first);
    await user.type(first, "Read each invoice");
    // The duplicate path ends there.
    await user.selectOptions(
      screen.getAllByTestId("flow-check-path-end")[0] as HTMLElement,
      "stop",
    );
    // A line typed by hand at the bottom.
    await user.click(screen.getByTestId("flow-check-add-step"));
    const inputs = screen.getAllByTestId("flow-check-line-input");
    await user.type(inputs.at(-1) as HTMLElement, "Code each line to a job");
    expect(screen.getAllByTestId("flow-check-line-kind").at(-1)).toHaveTextContent(
      "The Builder fills it",
    );
    // It starts on a schedule.
    await user.click(screen.getByTestId("flow-check-start-schedule"));
    await user.click(screen.getByTestId("flow-check-build"));
    expect(await screen.findByTestId("landed")).toHaveTextContent(
      "/ops/templates/invoice-intake/workflows/invoice-intake",
    );

    const expected = draftProcess();
    expect(saved).toHaveLength(1);
    const body = saved[0] as {
      bundle: { workflows: { workflow: unknown }[] };
      parentVersionId: string;
    };
    expect(body.parentVersionId).toBe(DRAFT_VERSION);
    expect(body.bundle.workflows[0]?.workflow).toEqual({
      ...expected,
      triggers: [{ id: "t-doc", on: { type: "schedule", cron: "0 7 * * 1-5" } }],
      steps: [
        { ...expected.steps[0], name: "Read each invoice" },
        {
          ...expected.steps[1],
          paths: [
            {
              ...(expected.steps[1] as { paths: object[] }).paths[0],
              steps: [
                (expected.steps[1] as { paths: { steps: object[] }[] }).paths[0]?.steps[0],
                { id: "n-1", kind: "stop", name: "Stop here", status: "succeeded" },
              ],
            },
          ],
        },
        expected.steps[2],
        {
          id: "n-2",
          kind: "missing",
          name: "Code each line to a job",
          need: "Code each line to a job",
        },
      ],
    });
    // The Builder is asked once, from the saved version, about the line typed by hand.
    expect(started).toEqual([
      { kind: "agent", agentId: DRAFT_AGENT_ID, fromVersionId: SAVED_VERSION },
    ]);
    expect(turns).toHaveLength(1);
    expect((turns[0] as { text: string }).text).toContain('"Code each line to a job"');
    expect(api.calls).toContain(`POST /api/ops/builder/sessions/${SESSION_ID}/save`);
  });

  it("turns a line typed with If into a decision, and carries on to the chart when the Builder fails", async () => {
    const saved: unknown[] = [];
    const api = fakeApi({
      ...drafted(),
      [`POST /api/ops/agents/${DRAFT_AGENT_ID}/versions`]: ({ init }) => {
        saved.push(JSON.parse(String(init.body)));
        return savedVersion();
      },
      "POST /api/ops/builder/sessions": () =>
        new Reply(502, { error: { code: "builder_failed", message: "the Builder failed" } }),
    });
    const user = renderCheck(api);
    await screen.findByTestId("flow-check");
    await user.click(screen.getByTestId("flow-check-add-step"));
    const input = screen.getAllByTestId("flow-check-line-input").at(-1) as HTMLElement;
    await user.type(input, "If the total is over $5,000, ask Dana{Enter}");
    expect(screen.getAllByTestId("flow-check-decision")).toHaveLength(2);
    expect(screen.getAllByTestId("flow-check-condition").at(-1)).toHaveValue(
      "the total is over $5,000",
    );
    // Remove the read line.
    await user.click(screen.getAllByTestId("flow-check-line-remove")[0] as HTMLElement);
    expect(screen.getAllByTestId("flow-check-line")).toHaveLength(3);
    await user.click(screen.getByTestId("flow-check-build"));
    expect(await screen.findByTestId("landed")).toHaveTextContent(
      "/ops/templates/invoice-intake/workflows/invoice-intake",
    );
    const steps = (
      saved[0] as {
        bundle: { workflows: { workflow: { steps: { id: string; kind: string }[] } }[] };
      }
    ).bundle.workflows[0]?.workflow.steps;
    expect(steps?.map((s) => s.kind)).toEqual(["if", "write", "if"]);
    expect(steps?.[0]?.id).toBe("s-dup");
  });

  it("drafts a build with no draft from the lines' words", async () => {
    const asked: unknown[] = [];
    const api = fakeApi({
      [`GET /api/ops/builds/${BUILD_ID}`]: () => buildDetail(),
      [`POST /api/ops/builds/${BUILD_ID}/draft-now`]: ({ init }) => {
        asked.push(JSON.parse(String(init.body)));
        return buildDetail({ agentId: DRAFT_AGENT_ID });
      },
    });
    const user = renderCheck(api, "");
    await screen.findByTestId("flow-check");
    expect(screen.getByTestId("flow-check-summary")).toHaveTextContent(
      "Say how it starts, then list what happens",
    );
    expect(screen.queryByTestId("flow-check-quote")).toBeNull();
    // Nothing typed yet: nothing to build.
    expect(screen.getByTestId("flow-check-build")).toBeDisabled();
    await user.click(screen.getByTestId("flow-check-start-document"));
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
    const user = renderCheck(fakeApi(drafted()));
    await screen.findByTestId("flow-check");
    await user.click(screen.getByTestId("flow-check-back"));
    const landed = await screen.findByTestId("landed");
    expect(landed).toHaveTextContent("/ops/lab?tab=drafts&new=template");
    expect(JSON.parse(landed.getAttribute("data-state") ?? "null")).toEqual({
      describe: { name: "Invoice intake", words: WORDS, kind: "template" },
    });
  });

  it("opens the workflow as it is on Start with a blank canvas", async () => {
    const api = fakeApi(drafted());
    const user = renderCheck(api);
    await screen.findByTestId("flow-check");
    await user.click(screen.getByTestId("flow-check-blank"));
    expect(await screen.findByTestId("landed")).toHaveTextContent(
      "/ops/templates/invoice-intake/workflows/invoice-intake",
    );
    await waitFor(() => expect(api.calls.some((c) => c.startsWith("POST"))).toBe(false));
  });
});
