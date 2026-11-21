// Try it on the chart (docs/builder-plan.md §12.4, F3): the bar starts a try with today's routes
// (a build's own try in suite mode, else a test run of the version), reads the run back until it
// ends, and hands the host one mark per step.
import type { BuildDetail, BuildTryView } from "@countersign/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

function build(tries: BuildTryView[] = []): BuildDetail {
  return {
    build: {
      id: BUILD,
      kind: "agent",
      title: "Invoice intake",
      client: null,
      phase: "poc",
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
    // No file yet: the bar asks for one.
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
