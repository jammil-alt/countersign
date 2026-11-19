// builder-plan.md B0 and B1 on the build page: a failing case says why; the page reads the build
// again every 5 seconds while the tests run and stops once they're done; the draft is tried on a
// document or an input, and the result is kept (Right) or sent to the Builder (Wrong). Making the
// cases with the model stays, as the secondary way.
import type { BuildDetail, BuildPocView, BuildTryView } from "@countersign/core";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";
import { plainLines } from "./TryCard";

await import("../OpsApp");

const ID = "00000000-0000-4000-8000-0000000b0001";
const AGENT = "00000000-0000-4000-8000-0000000a0001";
const VERSION = "00000000-0000-4000-8000-0000000e0001";
const SANDBOX = "00000000-0000-4000-8000-00000000a0ff";
const CASE = "00000000-0000-4000-8000-0000000c0001";
const TRY = "00000000-0000-4000-8000-0000000c0002";
const DOC = "00000000-0000-4000-8000-0000000d0001";
const at = "2026-11-19T10:00:00.000Z";

const PHASES = ["intake", "fitgap", "draft", "poc", "client_test", "qa"] as const;

function poc(over: Partial<BuildPocView> = {}): BuildPocView {
  return {
    mode: "suite",
    cases: 1,
    required: 1,
    latest: null,
    failures: [],
    tries: [],
    trySandbox: { id: SANDBOX, name: "Sandbox" },
    testRuns: null,
    passed: false,
    detail: "The test cases haven't run yet.",
    ...over,
  };
}

function detail(p: BuildPocView = poc()): BuildDetail {
  return {
    build: {
      id: ID,
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
    gate: { next: "client_test", reasons: [p.detail] },
    messages: [],
    items: [],
    draft: {
      agentId: AGENT,
      skillId: null,
      sessionId: null,
      versionId: VERSION,
      version: 2,
      live: false,
      problems: [],
    },
    poc: p,
    clientTest: null,
    qaChecks: [],
    events: [],
  };
}

const latest = (status: string) => ({
  id: "00000000-0000-4000-8000-0000000f0001",
  status,
  total: 1,
  passed: 0,
  failed: status === "done" ? 1 : 0,
  at,
  current: true,
});

const tried = (over: Partial<BuildTryView> = {}): BuildTryView => ({
  caseId: TRY,
  name: "Try: invoice-1042.pdf",
  status: "done",
  output: { extract: { vendor: "Northline", total: "418.20" }, review: { verdict: "ok" } },
  why: null,
  runId: null,
  current: true,
  at,
  ...over,
});

const common = {
  "GET /api/session": () => OPERATOR_SESSION,
  "GET /api/ops/clients": () => ({ clients: [] }),
  "GET /api/ops/counts": () => ({ needsUs: 0, clients: [] }),
};

function renderBuild(api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[`/ops/builds/${ID}`]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

describe("the POC test on the build page", () => {
  it("says why a failing case fails", async () => {
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () =>
        detail(
          poc({
            latest: latest("done"),
            failures: [
              {
                caseId: CASE,
                name: "Northline 20418",
                status: "fail",
                runId: null,
                why: 'total: expected "418.20", got "418.02"',
              },
            ],
          }),
        ),
    });
    renderBuild(api);
    expect(await screen.findByTestId(`build-poc-why-${CASE}`)).toHaveTextContent(
      'total: expected "418.20", got "418.02"',
    );
  });

  it("reads the build again every 5 seconds while the tests run, and stops when they're done", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let current = detail(poc({ latest: latest("running"), detail: "The test cases are running." }));
    const api = fakeApi({ ...common, [`GET /api/ops/builds/${ID}`]: () => current });
    const reads = () => api.calls.filter((c) => c === `GET /api/ops/builds/${ID}`).length;
    renderBuild(api);
    await screen.findByTestId("build-poc-detail");
    expect(reads()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await waitFor(() => expect(reads()).toBe(2));
    // Done now: the next read shows it, and no more follow.
    current = detail(poc({ latest: latest("done"), detail: "1 required case doesn't pass." }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await waitFor(() =>
      expect(screen.getByTestId("build-poc-detail")).toHaveTextContent("1 required case"),
    );
    const after = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(reads()).toBe(after);
  });

  it("tries an input, keeps a right result, and sends a wrong one to the conversation", async () => {
    const sent: unknown[] = [];
    const decided: unknown[] = [];
    let current = detail();
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => current,
      [`POST /api/ops/builds/${ID}/tries`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        current = detail(poc({ tries: [tried()] }));
        return current;
      },
      [`POST /api/ops/builds/${ID}/tries/${TRY}`]: ({ init }) => {
        decided.push(JSON.parse(String(init.body)));
        current = detail(poc({ cases: 2, required: 2 }));
        return current;
      },
    });
    renderBuild(api);
    const card = await screen.findByTestId("build-try");
    expect(card).toHaveTextContent("Try it on a document");
    // Model-made cases are still there, as the secondary way.
    expect(screen.getByTestId("build-make-cases")).toHaveClass("ds-btn--ghost");

    // Not JSON: said, nothing sent.
    await userEvent.type(within(card).getByTestId("build-try-input"), "not json");
    await userEvent.click(within(card).getByTestId("build-try-run"));
    expect(within(card).getByTestId("build-try-bad")).toHaveTextContent("That isn't valid JSON.");
    expect(sent).toEqual([]);

    await userEvent.clear(within(card).getByTestId("build-try-input"));
    await userEvent.type(within(card).getByTestId("build-try-input"), '{{"documentId": "abc"}');
    await userEvent.click(within(card).getByTestId("build-try-run"));
    await waitFor(() => expect(sent).toEqual([{ input: { documentId: "abc" } }]));

    // What the agent would do, in plain view, waiting on the operator's word.
    const row = await screen.findByTestId(`build-try-${TRY}`);
    expect(row).toHaveTextContent("Right or wrong?");
    const output = within(row).getByTestId(`build-try-output-${TRY}`);
    expect(output).toHaveTextContent("extract.vendor");
    expect(output).toHaveTextContent("Northline");
    expect(output).toHaveTextContent("418.20");

    // Wrong: the conversation's box starts with what it's about.
    await userEvent.click(within(row).getByTestId(`build-try-wrong-${TRY}`));
    expect(screen.getByTestId("build-input")).toHaveValue("About “Try: invoice-1042.pdf”: ");

    // Right: kept as a test case.
    await userEvent.click(within(row).getByTestId(`build-try-keep-${TRY}`));
    await waitFor(() => expect(decided).toEqual([{ decide: "keep" }]));
    await waitFor(() => expect(screen.queryByTestId(`build-try-${TRY}`)).toBeNull());
  });

  it("uploads a document to the Sandbox quietly and tries it", async () => {
    const uploads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        uploads.push(String(input));
        return new Response(
          JSON.stringify({
            results: [
              {
                filename: "invoice-1042.pdf",
                kind: "document",
                document: {
                  id: DOC,
                  filename: "invoice-1042.pdf",
                  mimeType: "application/pdf",
                  sizeBytes: 10,
                  source: "upload",
                  status: "stored",
                  receivedAt: at,
                  pageCount: null,
                  transactionId: null,
                  vendorName: null,
                  invoiceNumber: null,
                  total: null,
                },
                created: true,
                purchases: null,
                error: null,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const sent: unknown[] = [];
    let current = detail();
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => current,
      [`POST /api/ops/builds/${ID}/tries`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        current = detail(poc({ tries: [tried({ status: "running", output: null })] }));
        return current;
      },
    });
    renderBuild(api);
    const card = await screen.findByTestId("build-try");
    expect(card).toHaveTextContent("It goes to Sandbox, where the tests run.");
    await userEvent.upload(
      within(card).getByTestId("build-try-file"),
      new File(["%PDF"], "invoice-1042.pdf", { type: "application/pdf" }),
    );
    await waitFor(() => expect(sent).toEqual([{ documentId: DOC }]));
    expect(uploads).toEqual([`/api/ops/clients/${SANDBOX}/uploads?for=try`]);
    const row = await screen.findByTestId(`build-try-${TRY}`);
    expect(row).toHaveTextContent("Running");
    expect(within(row).queryByTestId(`build-try-keep-${TRY}`)).toBeNull();
  });

  it("offers to try an older or stopped try again, and to discard it", async () => {
    const sent: unknown[] = [];
    const decided: unknown[] = [];
    let current = detail(
      poc({
        tries: [tried({ status: "error", output: null, why: "the run stopped: no workflow" })],
      }),
    );
    const api = fakeApi({
      ...common,
      [`GET /api/ops/builds/${ID}`]: () => current,
      [`POST /api/ops/builds/${ID}/tries`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return current;
      },
      [`POST /api/ops/builds/${ID}/tries/${TRY}`]: ({ init }) => {
        decided.push(JSON.parse(String(init.body)));
        current = detail();
        return current;
      },
    });
    renderBuild(api);
    const row = await screen.findByTestId(`build-try-${TRY}`);
    expect(within(row).getByTestId(`build-try-why-${TRY}`)).toHaveTextContent("no workflow");
    expect(within(row).queryByTestId(`build-try-keep-${TRY}`)).toBeNull();
    await userEvent.click(within(row).getByTestId(`build-try-again-${TRY}`));
    await waitFor(() => expect(sent).toEqual([{ caseId: TRY }]));
    await userEvent.click(within(row).getByTestId(`build-try-discard-${TRY}`));
    await waitFor(() => expect(decided).toEqual([{ decide: "discard" }]));
  });
});

describe("plainLines", () => {
  it("lists a result's fields by path, plainly", () => {
    expect(plainLines({ a: { b: "x", c: 2 }, d: [], e: null, f: [{ g: true }] })).toEqual([
      { path: "a.b", text: "x" },
      { path: "a.c", text: "2" },
      { path: "d", text: "none" },
      { path: "e", text: "nothing" },
      { path: "f.0.g", text: "true" },
    ]);
    expect(plainLines("same")).toEqual([{ path: "Result", text: "same" }]);
    expect(plainLines({ x: "y".repeat(500) })[0]?.text).toHaveLength(160);
  });
});
