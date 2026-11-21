// Try it on the chart (docs/builder-plan.md §12.4, F3; design: startTry and 06-try.png): the bar at
// the top of the chart while the draft runs once on a real example. It starts the try with today's
// routes, unchanged: a build in suite mode tries its draft as the build page's Try card does
// (`opsBuildTry`, a document uploaded to the Sandbox or an input); anything else is a test run of
// the version (`opsTestRun`, as the builder's test-run panel starts one: a template in the Sandbox
// or the client chosen, a client's agent at its own client). It reads the run back
// (`GET /api/ops/runs/:id`) until it ends and hands the host one mark per step. Nothing is written:
// a test run records its writes as "would have done".
import type { BuildDetail } from "@countersign/core";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import type { UploadResponse } from "../../api/upload";
import { useApi, useApiClient } from "../../api/useApi";
import { ErrorNotice } from "../../ui/ErrorState";
import { TextArea } from "../../ui/forms";
import { Button, buttonClass } from "../../ui/primitives";
import { JSON_INPUT_PROPS, parsePayload } from "../agents/TestPayload";
import { tryUpload } from "../builds/TryCard";
import { type TryRun, tryEnded, tryMarks, tryOutcome } from "./tryMarks";
import type { Process, TryMark } from "./types";

/** What a try runs on: a file, or the trigger's payload as JSON. */
export type TryInput = { file: File } | { payload: unknown };

export interface TryPanelProps {
  /** The process on the chart: the marks are for its steps. */
  process: Process;
  /** The agent the chart shows. */
  agent: { id: string; kind: "template" | "client"; tenantId: string | null };
  /** The workflow (its slug) the chart shows: the one the try runs. */
  workflow: string;
  /** The version a test run runs; `prepare` is called first when given. */
  versionId?: string | null;
  /** Saves unsaved changes as a draft and answers the version to run (as the test-run panel does). */
  prepare?: () => Promise<string | null>;
  /** A build's draft: in suite mode the try is the build's own (`opsBuildTry`). */
  build?: BuildDetail | null;
  /** A template's client to run on (none: the Sandbox). */
  clientId?: string | null;
  /** The trigger's sample payload, to start the input from. */
  sample?: unknown;
  /** Start at once on this (the host's file picker); else the bar asks for a file or an input. */
  first?: TryInput;
  /** The marks so far, every time they change; [] when a new try starts. */
  onMarks(marks: TryMark[]): void;
  /** Done: the host takes the bar and the marks away. */
  onDone(): void;
  /** The build as a build try answered it, for the host to show. */
  onBuild?(detail: BuildDetail): void;
  /** The Sandbox upload (tests pass their own). */
  upload?: (file: File, clientId: string) => Promise<UploadResponse>;
  /** How often the run is read while it goes (ms). */
  pollMs?: number;
}

type Phase = "choose" | "starting" | "running" | "ended" | "error";

/** How long the bar follows a run before it hands over to the run's page. */
const FOLLOW_MS = 15 * 60_000;

const label = (input: TryInput | null) =>
  !input ? "" : "file" in input ? input.file.name : "your input";

export function TryPanel({
  process,
  agent,
  workflow,
  versionId,
  prepare,
  build,
  clientId = null,
  sample,
  first,
  onMarks,
  onDone,
  onBuild,
  upload = tryUpload,
  pollMs = 2000,
}: TryPanelProps) {
  const api = useApiClient();
  const fileId = useId();
  const suite = build?.poc?.mode === "suite" ? build : null;
  // A test run reads the Sandbox (a template with no client chosen) or the agent's own client; a
  // file can be uploaded only to the Sandbox.
  const clients = useApi(
    apiRoutes.opsClients,
    suite ? null : { query: { view: "names" }, life: "catalog" },
  );
  const sandboxId = suite
    ? (suite.poc?.trySandbox?.id ?? null)
    : (clients.data?.clients.find((c) => c.sandbox)?.id ?? null);
  const runsAt = suite
    ? sandboxId
    : agent.kind === "template"
      ? clientId || sandboxId
      : agent.tenantId;
  const fileClient = runsAt && runsAt === sandboxId ? runsAt : null;

  const [phase, setPhase] = useState<Phase>(first ? "starting" : "choose");
  const [input, setInput] = useState<TryInput | null>(first ?? null);
  const [text, setText] = useState(sample === undefined ? "" : JSON.stringify(sample, null, 2));
  const [bad, setBad] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const caseRef = useRef<string | null>(null);
  // Each try has its number: an older try's answers are dropped once another starts.
  const gen = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const marksRef = useRef(onMarks);
  marksRef.current = onMarks;

  const stop = () => {
    gen.current += 1;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      timer.current = setTimeout(resolve, ms);
    });

  /** Reads the run until it ends, handing on its marks each time. */
  async function follow(id: string, mine: number) {
    const until = Date.now() + FOLLOW_MS;
    for (;;) {
      const run: TryRun = await api.call(apiRoutes.opsRun, { params: { id } });
      if (gen.current !== mine) return;
      const marks = tryMarks(run, process);
      marksRef.current(marks);
      setOutcome(tryOutcome(run, marks));
      if (tryEnded(run.run)) {
        setPhase("ended");
        return;
      }
      if (Date.now() > until) {
        setOutcome("It is still going. Open the test run to follow it.");
        setPhase("ended");
        return;
      }
      await wait(run.run.status === "waiting" ? pollMs * 5 : pollMs);
      if (gen.current !== mine) return;
    }
  }

  /** A build's try: the run it started, once the build has one for it. */
  async function buildRun(d: BuildDetail, before: ReadonlySet<string>, mine: number) {
    let detail = d;
    for (;;) {
      const tries = detail.poc?.tries ?? [];
      const t = caseRef.current
        ? tries.find((x) => x.caseId === caseRef.current)
        : tries.find((x) => !before.has(x.caseId));
      if (!t) throw new Error("The try didn't start. Try again.");
      caseRef.current = t.caseId;
      if (t.runId) return t.runId;
      if (t.status === "error") throw new Error(t.why ?? "The try couldn't run.");
      if (t.status === "done") return null;
      await wait(pollMs);
      if (gen.current !== mine) return null;
      detail = await api.call(apiRoutes.opsBuild, { params: { id: detail.build.id } });
      if (gen.current !== mine) return null;
      onBuild?.(detail);
    }
  }

  async function begin(next: TryInput, again: boolean) {
    stop();
    const mine = gen.current;
    setInput(next);
    setPhase("starting");
    setError(null);
    setBad(null);
    setRunId(null);
    setOutcome(null);
    marksRef.current([]);
    if (!again) caseRef.current = null;
    try {
      let id: string | null;
      if (suite) {
        const before = new Set((suite.poc?.tries ?? []).map((t) => t.caseId));
        let body:
          | { caseId: string }
          | { documentId: string; workflow: string }
          | {
              input: unknown;
              workflow: string;
            };
        if (again && caseRef.current) body = { caseId: caseRef.current };
        else if ("file" in next) {
          const documentId = await uploaded(next.file);
          if (!documentId) return;
          body = { documentId, workflow };
        } else body = { input: next.payload, workflow };
        const d = await api.call(apiRoutes.opsBuildTry, { params: { id: suite.build.id }, body });
        if (gen.current !== mine) return;
        onBuild?.(d);
        id = await buildRun(d, before, mine);
      } else {
        const vid = prepare ? await prepare() : (versionId ?? null);
        if (gen.current !== mine) return;
        if (!vid) throw new Error("Save the draft first, then try it.");
        let payload: unknown;
        if ("file" in next) {
          const doc = await uploadedDoc(next.file);
          if (!doc) return;
          // The payload `document.received` carries (as a build's try sends it).
          payload = {
            documentId: doc.id,
            source: doc.source,
            filename: doc.filename,
            mimeType: doc.mimeType,
          };
        } else payload = next.payload;
        const res = await api.call(apiRoutes.opsTestRun, {
          params: { id: agent.id, vid },
          body: {
            workflow,
            payload,
            ...(agent.kind === "template" && clientId ? { clientId } : {}),
          },
        });
        id = res.runId;
      }
      if (gen.current !== mine) return;
      if (!id) {
        setOutcome("It ran. Its result is on the build.");
        setPhase("ended");
        return;
      }
      setRunId(id);
      setPhase("running");
      await follow(id, mine);
    } catch (e) {
      if (gen.current !== mine) return;
      setError(e);
      setPhase("error");
    }
  }

  async function uploadedDoc(file: File) {
    if (!fileClient) {
      setBad("A file can be tried in the Sandbox only. Give an input instead.");
      setPhase("choose");
      return null;
    }
    const out = await upload(file, fileClient);
    const r = out.results[0];
    if (r?.kind !== "document" || !r.document) {
      setBad(r?.error ?? "That file can't be tried: use a PDF or an image.");
      setPhase("choose");
      return null;
    }
    return r.document;
  }

  async function uploaded(file: File) {
    return (await uploadedDoc(file))?.id ?? null;
  }

  // The host's first file starts the try at once; the try stops when the bar goes away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the bar opens.
  useEffect(() => {
    if (first) void begin(first, false);
    return stop;
  }, []);

  const done = () => {
    stop();
    onDone();
  };
  const fromInput = () => {
    const parsed = parsePayload(text);
    if (!parsed.ok) {
      setBad("That isn't valid JSON.");
      return;
    }
    void begin({ payload: parsed.value }, false);
  };
  const going = phase === "starting" || phase === "running";
  const filePicker = (words: string, primary = false) =>
    fileClient ? (
      <label
        htmlFor={fileId}
        className={buttonClass(primary ? "primary" : "secondary", "cursor-pointer", "sm")}
        data-testid="flow-try-file"
      >
        {words}
        <input
          id={fileId}
          type="file"
          hidden
          accept="application/pdf,image/*"
          data-testid="flow-try-file-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void begin({ file: f }, false);
          }}
        />
      </label>
    ) : null;

  return (
    <div
      data-testid="flow-try"
      className="flex flex-col gap-3 rounded-md border border-slate bg-slate-tint px-3.5 py-3 text-sm"
    >
      {phase === "choose" ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-[240px] flex-1 flex-col gap-1">
              <span className="font-medium text-ink">Try it on a real example</span>
              <span className="text-ink-muted">Reading real data. Nothing is written.</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {filePicker("Choose a file", true)}
              <Button size="sm" variant="ghost" onClick={done} data-testid="flow-try-done">
                Done
              </Button>
            </div>
          </div>
          <TextArea
            {...JSON_INPUT_PROPS}
            aria-label="Or give an input (JSON)"
            data-testid="flow-try-input"
            rows={4}
            value={text}
            className="font-mono text-xs"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-ink-muted">
              {fileClient ? "Or give an input as JSON." : "Give an input as JSON."}
            </span>
            <Button size="sm" onClick={fromInput} data-testid="flow-try-input-start">
              Try it on this input
            </Button>
          </div>
          {bad ? (
            <p className="text-risk" data-testid="flow-try-bad">
              {bad}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-[240px] flex-1 flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">
                  {going ? "Trying it on" : "Tried it on"}
                </span>
                <span
                  className="rounded-sm border border-line-strong bg-surface px-2 py-0.5 font-mono text-xs text-ink"
                  data-testid="flow-try-on"
                >
                  {label(input)}
                </span>
              </span>
              <span className="text-ink-muted" data-testid="flow-try-said">
                {going
                  ? "Reading real data. Nothing is written."
                  : phase === "ended"
                    ? (outcome ?? "Nothing was written.")
                    : "It couldn't run. Nothing was written."}
              </span>
              {phase === "running" && outcome ? (
                <span className="text-ink" data-testid="flow-try-waiting">
                  {outcome}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {filePicker("Use another file")}
              <Button
                size="sm"
                disabled={!input || phase === "starting"}
                onClick={() => input && void begin(input, true)}
                data-testid="flow-try-again"
              >
                Try again
              </Button>
              <Button size="sm" variant="ghost" onClick={done} data-testid="flow-try-done">
                Done
              </Button>
            </div>
          </div>
          {runId ? (
            <Link
              to={`/ops/runs/${runId}`}
              className="text-sm font-medium text-link underline"
              data-testid="flow-try-run"
            >
              Open the test run
            </Link>
          ) : null}
          {phase === "error" ? <ErrorNotice error={error} /> : null}
        </>
      )}
    </div>
  );
}
