// Try it on the chart (docs/builder-plan.md §12.4, F3): the panel starts a try with today's routes
// (a build's own try in suite mode, else a test run of the version), reads the run back until it
// ends, and hands the host one mark per step.
import type { BuildDetail, BuildTryView } from "@countersign/core";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../../App";
import type { UploadResponse } from "../../api/upload";
import { fakeApi, OPERATOR_SESSION, PROCESS_BUNDLE } from "../../test/fixtures";
import { TryPanel, type TryPanelProps } from "./TryPanel";
import type { Process, TryMark } from "./types";

const PROCESS = PROCESS_BUNDLE.workflows[0]?.workflow as Process;
const BUILD = "00000000-0000-4000-8000-0000000b0001";
const AGENT = "00000000-0000-4000-8000-0000000a0001";
const VERSION = "00000000-0000-4000-8000-0000000e0001";
const SANDBOX = "00000000-0000-4000-8000-00000000a0ff";
const TRY = "00000000-0000-4000-8000-0000000c0002";
const DOC = "00000000-0000-4000-8000-0000000d0001";
const RUN = "00000000-0000-4000-8000-0000000f1001";
const at = "2026-11-21T10:00:00.000Z";

const PHASES = ["intake", "fitgap", "draft", "poc", "client_test", "qa"] as const;

function build(tries: BuildTryView[] = [], phase: (typeof PHASES)[number] = "poc"): BuildDetail {
  return {
    build: {
      id: BUILD,
      kind: "agent",
      title: "Invoice intake",
      client: null,
      phase,
      status: "open",
      agentId: AGENT,
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
      flow: "phases",
      templateId: null,
      promisedOn: null,
      origin: null,
      requirements: null,
      pipelineStage: "building",
      standing: "you",
      waitingOn: "operator",
      statusLine: "",
      stuck: false,
      brief: {},
      fitgap: { rows: [], needsTrue: [], setup: [], decisions: [] },
      testPlan: { datasets: [] },
      qa: { accepted: {}, signedBy: null, signedAt: null, decision: null },
    },
    phases: PHASES.map((phase, i) => ({
      phase,
      label: phase,
      state: i < 3 ? "done" : i === 3 ? "current" : "todo",
    })),
    gate: { next: "client_test", reasons: [] },
    messages: [],
    items: [],
    draft: {
      agentId: AGENT,
      skillId: null,
      sessionId: null,
      versionId: VERSION,
      version: 2,
      live: false,
      steps: [],
      problems: [],
    },
    poc: {
      mode: "suite",
      cases: 0,
      required: 0,
      latest: null,
      failures: [],
      tries,
      trySandbox: { id: SANDBOX, name: "Sandbox" },
      testRuns: null,
      passed: false,
      detail: "",
    },
    clientTest: null,
    qaChecks: [],
    events: [],
  } as BuildDetail;
}

const row = (id: string, nodeId: string, nodeType: string, status: string, extra = {}) => ({
  id,
  nodeId,
  nodeType,
  skillRef: null,
  status,
  input: null,
  output: null,
  summary: null,
  costUsd: "0",
  tokensIn: 0,
  tokensOut: 0,
  startedAt: at,
  finishedAt: null,
  ...extra,
});

function run(status: string, steps: ReturnType<typeof row>[]) {
  return {
    run: {
      id: RUN,
      tenantId: SANDBOX,
      agentId: AGENT,
      agentVersionId: VERSION,
      workflowSlug: "new-bill",
      mode: "test",
      status,
      trigger: {},
      costUsd: "0",
      error: null,
      startedAt: at,
      finishedAt: null,
      createdAt: at,
    },
    steps,
    toolCalls: [],
    actions: [],
    inbox: [],
    agent: null,
    version: 2,
    workflow: null,
  };
}

const going = run("running", [
  row("00000000-0000-4000-8000-000000002001", "find", "skill", "succeeded", {
    summary: "Found 1 document",
  }),
]);
const ended = run("succeeded", [
  row("00000000-0000-4000-8000-000000002001", "find", "skill", "succeeded", {
    summary: "Found 1 document",
  }),
  row("00000000-0000-4000-8000-000000002002", "confidence", "if", "succeeded"),
  row("00000000-0000-4000-8000-000000002003", "update", "action", "succeeded", {
    output: { wouldHaveDone: true },
    summary: "Would update bill (test run, not written)",
  }),
]);

const common = {
  "GET /api/session": () => OPERATOR_SESSION,
  "GET /api/ops/clients": () => ({ clients: [] }),
};

function show(api: ReturnType<typeof fakeApi>, props: Partial<TryPanelProps> = {}) {
  const marks: TryMark[][] = [];
  const onDone = vi.fn();
  render(
    <MemoryRouter>
      <AppProviders client={api.client}>
        <TryPanel
          process={PROCESS}
          agent={{ id: AGENT, kind: "template", tenantId: null }}
          workflow="new-bill"
          versionId={VERSION}
          onMarks={(m) => marks.push(m)}
          onDone={onDone}
          pollMs={5}
          {...props}
        />
      </AppProviders>
    </MemoryRouter>,
  );
  return { marks, onDone };
}

afterEach(() => cleanup());

describe("TryPanel", () => {
  it("test-runs the version on an input, follows the run and marks each step", async () => {
    const bodies: unknown[] = [];
    let reads = 0;
    const api = fakeApi({
      ...common,
      [`POST /api/ops/agents/${AGENT}/versions/${VERSION}/test-run`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return { runId: RUN, agentId: AGENT, versionId: VERSION };
      },
      [`GET /api/ops/runs/${RUN}`]: () => {
        reads += 1;
        return reads === 1 ? going : ended;
      },
    });
    const { marks, onDone } = show(api, { first: { payload: { billId: "b1" } } });
    expect(await screen.findByTestId("flow-try-on")).toHaveTextContent("your input");
    await waitFor(() =>
      expect(screen.getByTestId("flow-try-said")).toHaveTextContent(
        "It ran to the end. 1 change would have been made; nothing was written.",
      ),
    );
    expect(screen.getByTestId("flow-try")).toHaveTextContent("Tried it on");
    expect(bodies).toEqual([{ workflow: "new-bill", payload: { billId: "b1" } }]);
    // A new try starts with no marks; the first read marks what ran so far, the last every step.
    expect(marks[0]).toEqual([]);
    expect(marks[1]).toEqual([{ stepId: "find", status: "did", summary: "Found 1 document" }]);
    expect(marks.at(-1)?.map((m) => [m.stepId, m.status])).toEqual([
      ["find", "did"],
      ["confidence", "did"],
      ["ask", "skipped"],
      ["update", "would"],
    ]);
    expect(screen.getByTestId("flow-try-run")).toHaveAttribute("href", `/ops/runs/${RUN}`);
    // Nothing more is read once it has ended.
    const after = reads;
    await new Promise((r) => setTimeout(r, 30));
    expect(reads).toBe(after);
    await userEvent.click(screen.getByTestId("flow-try-done"));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  // Owner, 2026-11-22 (docs/plan.md §1.185): "select one step or multiple… wherever you start it
  // should allow you to add the relevant data… we see the output of each step".
  it("tests some of the steps: asks for what they read from before, and shows each step's output", async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({
      ...common,
      [`POST /api/ops/agents/${AGENT}/versions/${VERSION}/test-run`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return { runId: RUN, agentId: AGENT, versionId: VERSION };
      },
      [`GET /api/ops/runs/${RUN}`]: () =>
        run("succeeded", [
          row("00000000-0000-4000-8000-000000002001", "find", "skill", "succeeded", {
            output: { confidence: 0.5 },
            summary: "given for this test, not run",
          }),
          row("00000000-0000-4000-8000-000000002002", "confidence", "if", "succeeded", {
            output: { path: "low" },
          }),
        ]),
    });
    // Opened with the decision selected on the chart: the choice starts from that one step.
    const { marks } = show(api, { ctx: {}, startAt: "confidence" });
    const user = userEvent.setup();
    expect(await screen.findByTestId("flow-try-some")).toBeChecked();
    expect(screen.getByTestId("flow-try-from")).toHaveValue("confidence");
    expect(screen.getByTestId("flow-try-to")).toHaveValue("confidence");
    // It reads the step before it, so that step's output is asked for; the trigger's isn't.
    const given = screen.getByTestId("flow-try-given-find");
    expect(screen.getByTestId("flow-try-given")).toHaveTextContent(
      "The output of “Find supporting document” · read by “Match confidence”",
    );
    expect(screen.queryByTestId("flow-try-input")).toBeNull();
    await user.clear(given);
    await user.type(given, '{{"confidence": 0.5}');
    await user.click(screen.getByTestId("flow-try-input-start"));

    await waitFor(() =>
      expect(screen.getByTestId("flow-try-said")).toHaveTextContent(
        "It ran the steps you picked. Nothing was written.",
      ),
    );
    expect(bodies).toEqual([
      {
        workflow: "new-bill",
        payload: {},
        range: { from: "confidence", to: "confidence", given: { find: { confidence: 0.5 } } },
      },
    ]);
    // The step after the last picked was never part of it.
    expect(marks.at(-1)?.find((m) => m.stepId === "update")).toEqual({
      stepId: "update",
      status: "skipped",
      summary: "Not part of this test",
    });
    // Every step that ran, with its output.
    const steps = screen.getByTestId("flow-try-steps");
    expect(steps).toHaveTextContent("What each step did");
    expect(screen.getByTestId("flow-try-step-find")).toHaveTextContent(
      "Find supporting documentDonegiven for this test, not run",
    );
    expect(screen.getByTestId("flow-try-step-confidence")).toHaveTextContent('"path": "low"');

    // Back to the choice: all of them asks for the trigger's input again, and sends no range.
    await user.click(screen.getByTestId("flow-try-choose"));
    await user.click(screen.getByTestId("flow-try-all"));
    expect(screen.getByTestId("flow-try-input")).toBeInTheDocument();
    expect(screen.queryByTestId("flow-try-given")).toBeNull();
    await user.click(screen.getByTestId("flow-try-input-start"));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ workflow: "new-bill", payload: {} });
  });

  // Owner, 2026-11-22 (docs/plan.md §1.186): "how do we create data?… have the AI make up data to
  // feed through it and watch the run".
  it("makes up data for the steps picked, fills the boxes with it, and runs on it", async () => {
    const asked: unknown[] = [];
    const bodies: unknown[] = [];
    const api = fakeApi({
      ...common,
      [`POST /api/ops/agents/${AGENT}/test-data`]: ({ init }) => {
        asked.push(JSON.parse(String(init.body)));
        return { given: { find: { confidence: 0.42, documentId: "made-up" } }, missing: [] };
      },
      [`POST /api/ops/agents/${AGENT}/versions/${VERSION}/test-run`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return { runId: RUN, agentId: AGENT, versionId: VERSION };
      },
      [`GET /api/ops/runs/${RUN}`]: () =>
        run("succeeded", [
          row("00000000-0000-4000-8000-000000002002", "confidence", "if", "succeeded", {
            output: { path: "low" },
          }),
        ]),
    });
    show(api, { ctx: {}, startAt: "confidence" });
    const user = userEvent.setup();
    expect(await screen.findByTestId("flow-try-make")).toHaveTextContent("No data yet?");
    expect(screen.queryByTestId("flow-try-made")).toBeNull();
    await user.type(screen.getByTestId("flow-try-make-notes"), "a weak match");
    await user.click(screen.getByTestId("flow-try-make-go"));

    // The draft, the steps picked and the notes are asked of; the answer fills the box.
    await waitFor(() =>
      expect(screen.getByTestId("flow-try-given-find")).toHaveValue(
        JSON.stringify({ confidence: 0.42, documentId: "made-up" }, null, 2),
      ),
    );
    expect(asked).toEqual([
      {
        process: PROCESS,
        workflow: "new-bill",
        range: { from: "confidence", to: "confidence" },
        notes: "a weak match",
      },
    ]);
    expect(screen.getByTestId("flow-try-given")).toHaveTextContent("As you wrote it.");
    expect(screen.getByTestId("flow-try-made")).toHaveTextContent(
      "A made-up id matches no stored record",
    );
    expect(screen.getByTestId("flow-try-make-go")).toHaveTextContent("Make up other data");

    await user.click(screen.getByTestId("flow-try-input-start"));
    expect(await screen.findByTestId("flow-try-on")).toHaveTextContent("made-up data");
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      workflow: "new-bill",
      payload: {},
      range: {
        from: "confidence",
        to: "confidence",
        given: { find: { confidence: 0.42, documentId: "made-up" } },
      },
    });
  });

  it("makes up what starts the run for a try of every step, and says when it can't", async () => {
    let fail = true;
    const api = fakeApi({
      ...common,
      [`POST /api/ops/agents/${AGENT}/test-data`]: () => {
        if (fail) throw new Error("no");
        return {
          trigger: { documentId: "made-up" },
          given: {},
          missing: ["What started the run"],
        };
      },
    });
    show(api, { ctx: {} });
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("flow-try-make-go"));
    expect(await within(screen.getByTestId("flow-try-make")).findByRole("alert")).toBeVisible();
    expect(screen.getByTestId("flow-try-make-go")).toBeEnabled();
    expect(screen.queryByTestId("flow-try-made")).toBeNull();
    fail = false;
    await user.click(screen.getByTestId("flow-try-make-go"));
    await waitFor(() =>
      expect(screen.getByTestId("flow-try-input")).toHaveValue(
        JSON.stringify({ documentId: "made-up" }, null, 2),
      ),
    );
    expect(screen.getByTestId("flow-try-made")).toHaveTextContent(
      "We couldn't make up what started the run: an example of its shape is there instead.",
    );
  });

  it("offers no choice of steps without the registries' view", async () => {
    const api = fakeApi({ ...common });
    show(api);
    expect(await screen.findByTestId("flow-try-input")).toBeInTheDocument();
    expect(screen.queryByTestId("flow-try-range")).toBeNull();
  });

  // Owner, 2026-11-22: the choice was missing on a template with an open build, where it is built.
  it("tests some of a build's draft as a test run at the build's Sandbox, not as a kept try", async () => {
    const bodies: unknown[] = [];
    const tries = vi.fn(() => build([]));
    const api = fakeApi({
      ...common,
      [`POST /api/ops/builds/${BUILD}/tries`]: tries,
      [`POST /api/ops/agents/${AGENT}/versions/${VERSION}/test-run`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return { runId: RUN, agentId: AGENT, versionId: VERSION };
      },
      [`GET /api/ops/runs/${RUN}`]: () =>
        run("succeeded", [
          row("00000000-0000-4000-8000-000000002001", "find", "skill", "succeeded", {
            output: { confidence: 0.5 },
            summary: "given for this test, not run",
          }),
          row("00000000-0000-4000-8000-000000002002", "confidence", "if", "succeeded"),
        ]),
    });
    show(api, { build: build([]), ctx: {}, startAt: "confidence" });
    const user = userEvent.setup();
    expect(await screen.findByTestId("flow-try-some")).toBeChecked();
    const given = screen.getByTestId("flow-try-given-find");
    await user.clear(given);
    await user.type(given, '{{"confidence": 0.5}');
    await user.click(screen.getByTestId("flow-try-input-start"));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      workflow: "new-bill",
      payload: {},
      clientId: SANDBOX,
      range: { from: "confidence", to: "confidence", given: { find: { confidence: 0.5 } } },
    });
    expect(tries).not.toHaveBeenCalled();
  });

  // S6.3: in the Draft phase the build keeps no tries ("examples are tried in the POC test").
  it("tries every step of a build's draft before its POC test as a test run at the Sandbox", async () => {
    const bodies: unknown[] = [];
    const tries = vi.fn(() => build([]));
    const api = fakeApi({
      ...common,
      [`POST /api/ops/builds/${BUILD}/tries`]: tries,
      [`POST /api/ops/agents/${AGENT}/versions/${VERSION}/test-run`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return { runId: RUN, agentId: AGENT, versionId: VERSION };
      },
      [`GET /api/ops/runs/${RUN}`]: () => ended,
    });
    show(api, { build: build([], "draft"), first: { payload: { billId: "b1" } } });
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      workflow: "new-bill",
      payload: { billId: "b1" },
      clientId: SANDBOX,
    });
    expect(tries).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("flow-try-said")).toHaveTextContent("It ran to the end."),
    );
    // A record is picked for the POC's kept tries only.
    expect(screen.queryByTestId("flow-try-pick-record")).toBeNull();
  });

  it("tries a build's draft on a file through the build, and again on the same try", async () => {
    const bodies: unknown[] = [];
    const tried: BuildTryView = {
      caseId: TRY,
      name: "Try: invoice-1042.pdf",
      status: "running",
      output: null,
      why: null,
      runId: RUN,
      current: true,
      at,
    };
    const api = fakeApi({
      ...common,
      [`POST /api/ops/builds/${BUILD}/tries`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return build([tried]);
      },
      [`GET /api/ops/runs/${RUN}`]: () => ended,
    });
    const upload = vi.fn(
      async (file: File): Promise<UploadResponse> =>
        ({
          results: [
            {
              filename: file.name,
              kind: "document" as const,
              document: {
                id: DOC,
                source: "upload",
                filename: file.name,
                mimeType: "application/pdf",
                sizeBytes: 10,
                status: "received",
                pageCount: 1,
                transactionId: null,
                receivedAt: at,
                vendorName: null,
                invoiceNumber: null,
                total: null,
                match: null,
              },
              created: true,
              purchases: null,
              error: null,
            },
          ],
        }) as UploadResponse,
    );
    const onBuild = vi.fn();
    const { marks } = show(api, { build: build(), upload, onBuild });
    // No file yet: the panel asks for one.
    expect(screen.getByTestId("flow-try")).toHaveTextContent("Try it on a real example");
    await userEvent.upload(
      screen.getByTestId("flow-try-file-input"),
      new File(["%PDF"], "invoice-1042.pdf", { type: "application/pdf" }),
    );
    expect(await screen.findByTestId("flow-try-on")).toHaveTextContent("invoice-1042.pdf");
    expect(upload).toHaveBeenCalledWith(expect.any(File), SANDBOX);
    await waitFor(() => expect(screen.getByTestId("flow-try")).toHaveTextContent("Tried it on"));
    expect(bodies).toEqual([{ documentId: DOC, workflow: "new-bill" }]);
    expect(onBuild).toHaveBeenCalled();
    expect(marks.at(-1)?.find((m) => m.stepId === "update")?.status).toBe("would");

    // Try again runs the same try on the latest version.
    await userEvent.click(screen.getByTestId("flow-try-again"));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ caseId: TRY });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  // docs/open.md G3: a build's try on one of the Sandbox's records.
  it("tries a build's draft on a record picked from the Sandbox", async () => {
    const BILL = "00000000-0000-4000-8000-0000000d0009";
    const bodies: unknown[] = [];
    const api = fakeApi({
      ...common,
      [`GET /api/ops/clients/${SANDBOX}/records`]: () => ({
        counts: { transactions: 0, vendors: 0, items: 0, receivables: 1 },
        lastSyncAt: null,
        sources: [],
        total: 1,
        offset: 0,
        limit: 8,
        page: {
          kind: "receivables",
          rows: [
            {
              id: BILL,
              docNumber: "1007",
              customer: { name: "Acme", organizationId: null },
              txnDate: "2026-11-01",
              dueDate: null,
              total: "90.00",
              balance: "90.00",
              currency: "USD",
              status: "open",
              syncedAt: at,
              sourceId: SANDBOX,
            },
          ],
        },
      }),
      [`POST /api/ops/builds/${BUILD}/tries`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return build([
          {
            caseId: TRY,
            name: "Try: invoice 1007 to Acme",
            status: "running",
            output: null,
            why: null,
            runId: RUN,
            current: true,
            at,
          },
        ]);
      },
      [`GET /api/ops/runs/${RUN}`]: () => ended,
    });
    show(api, { build: build() });
    await userEvent.click(screen.getByTestId("flow-try-pick-record"));
    await userEvent.selectOptions(await screen.findByTestId("build-try-record-kind"), "receivable");
    await userEvent.click(await screen.findByTestId(`build-try-record-${BILL}`));
    expect(await screen.findByTestId("flow-try-on")).toHaveTextContent("invoice 1007 · to Acme");
    await waitFor(() => expect(screen.getByTestId("flow-try")).toHaveTextContent("Tried it on"));
    expect(bodies).toEqual([{ record: { kind: "receivable", id: BILL }, workflow: "new-bill" }]);
  });

  it("asks for valid JSON, and offers no file where the run can't read one", async () => {
    const api = fakeApi({ ...common });
    show(api, { agent: { id: AGENT, kind: "client", tenantId: "someone-else" } });
    expect(screen.queryByTestId("flow-try-file")).toBeNull();
    await userEvent.type(screen.getByTestId("flow-try-input"), "not json");
    await userEvent.click(screen.getByTestId("flow-try-input-start"));
    expect(screen.getByTestId("flow-try-bad")).toHaveTextContent("That isn't valid JSON.");
  });

  it("says why when the try can't start", async () => {
    const api = fakeApi({ ...common });
    show(api, { versionId: null, first: { payload: {} } });
    expect(await screen.findByTestId("flow-try-said")).toHaveTextContent(
      "It couldn't run. Nothing was written.",
    );
    expect(screen.getByTestId("flow-try")).toHaveTextContent("Save the draft first, then try it.");
  });
});
