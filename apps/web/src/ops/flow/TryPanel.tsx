// Try it on the chart (docs/builder-plan.md §12.4, F3; design: startTry and 06-try.png): the bar at
// the top of the chart while the draft runs once on a real example. It starts the try with today's
// routes, unchanged: a build in suite mode tries its draft as the build page's Try card does
// (`opsBuildTry`, a document uploaded to the Sandbox or an input); anything else is a test run of
// the version (`opsTestRun`, as the builder's test-run panel starts one: a template in the Sandbox
// or the client chosen, a client's agent at its own client). It reads the run back
// (`GET /api/ops/runs/:id`) until it ends and hands the host one mark per step. Nothing is written:
// a test run records its writes as "would have done".
// Owner, 2026-11-22 (docs/plan.md §1.185: "select one step or multiple… wherever you start it
// should allow you to add the relevant data… it then runs through the steps and we see the output
// of each step… until the last step selected"): a try may run some of the top-level steps. The
// bar asks which (all, or a first and a last), and for a start further down, for the output of
// each earlier step the picked ones read (from the last try here, else an example of its shape).
// Under the bar, every step that ran, with its output.
// Owner, 2026-11-22 (docs/plan.md §1.186: "how do we create data?… have the AI make up data to
// feed through it and watch the run"): "Make up data" fills the boxes (what started the run, each
// earlier step's output) with data made up from the draft's shapes, to read over and run.
import {
  assistRoutes,
  type BuildDetail,
  processes,
  TEST_DATA_NOTES_MAX,
  type TypingContext,
} from "@countersign/core";
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { isApiError } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import type { UploadResponse } from "../../api/upload";
import { useApi, useApiClient } from "../../api/useApi";
import { ErrorNotice } from "../../ui/ErrorState";
import { Select, TextArea, TextInput } from "../../ui/forms";
import { Button, buttonClass } from "../../ui/primitives";
import { JSON_INPUT_PROPS, parsePayload } from "../agents/TestPayload";
import type { PickedRecord } from "../builds/RecordPick";
import { tryUpload } from "../builds/TryCard";
import { type TryRun, tryEnded, tryMarks, tryOutcome } from "./tryMarks";
import type { Process, TryMark } from "./types";

/**
 * What a try runs on: a file, the trigger's payload as JSON (`made`: made up here), or one of the
 * Sandbox's records (a build's try only, docs/open.md G3).
 */
export type TryInput =
  | { file: File }
  | { payload: unknown; made?: boolean }
  | { record: PickedRecord };

// The Sandbox's records load only when the picker opens (docs/open.md G3).
const RecordPick = lazy(() =>
  import("../builds/RecordPick").then((m) => ({ default: m.RecordPick })),
);

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
  /** The registries' view, to say what a range of steps reads. Absent: every try runs all steps. */
  ctx?: TypingContext | undefined;
  /** The top-level step open on the chart, to start the choice of steps from. */
  startAt?: string | null | undefined;
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
  !input
    ? ""
    : "file" in input
      ? input.file.name
      : "record" in input
        ? input.record.label
        : input.made
          ? "made-up data"
          : "your input";

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
  ctx,
  startAt = null,
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
  // The Sandbox's records are open to pick one (a build's try, docs/open.md G3).
  const [picking, setPicking] = useState(false);
  // ── Some of the steps (§1.185) ──
  const top = process.steps;
  // DECISION (owner, 2026-11-22: "I tried using it and was not able to"): a template with an open
  // build is in suite mode, where §1.185 offered no choice of steps, so the choice was missing
  // where the owner builds. It is offered there too. A try of every step stays the build's own
  // (kept as a case); a try of some of them is a test run of the draft at the build's Sandbox,
  // since part of a run can't be a case to keep.
  const canPick = ctx !== undefined && top.length > 1;
  const startsAt = startAt && top.some((s) => s.id === startAt) ? startAt : null;
  const [some, setSome] = useState(canPick && startsAt !== null);
  const [from, setFrom] = useState<string>(startsAt ?? top[0]?.id ?? "");
  const [to, setTo] = useState<string>(startsAt ?? top.at(-1)?.id ?? "");
  // What the tester typed for an earlier step's output, by step id; else the default below.
  const [typed, setTyped] = useState<Record<string, string>>({});
  // The last run read here: its rows, shown under the bar and used to fill what a later try needs.
  const [last, setLast] = useState<TryRun | null>(null);
  const range = canPick && some ? { from, to } : null;
  const needs = useMemo(
    () => (canPick && some && ctx ? processes.rangeNeeds(process, ctx, { from, to }) : null),
    [process, ctx, canPick, some, from, to],
  );
  const midway = range !== null && range.from !== top[0]?.id;
  const asksTrigger = !midway || needs?.trigger === true;
  /** An earlier step's output to start from: typed, else the last try's, else an example. */
  const givenText = (id: string): string => {
    if (typed[id] !== undefined) return typed[id];
    const row = last?.steps.filter((r) => r.nodeId === id && r.status === "succeeded").at(-1);
    if (row && row.output !== undefined && row.output !== null) {
      return JSON.stringify(row.output, null, 2);
    }
    const step = top.find((x) => x.id === id);
    const schema = step && ctx ? processes.stepOutputSchema(step, ctx) : undefined;
    return JSON.stringify(processes.sampleFromSchema(schema) ?? {}, null, 2);
  };
  const givenFrom = (id: string): string =>
    typed[id] !== undefined
      ? "As you wrote it."
      : last?.steps.some((r) => r.nodeId === id && r.status === "succeeded")
        ? "From the last try here."
        : "An example of its shape. Change it to what you want to test.";
  // ── Made-up data (§1.186) ──
  const canMake = ctx !== undefined;
  const [notes, setNotes] = useState("");
  const [making, setMaking] = useState(false);
  const [makeError, setMakeError] = useState<unknown>(null);
  // What the last making left out (an example of its shape is in the box instead); null: none made.
  const [made, setMade] = useState<string[] | null>(null);
  const makeGen = useRef(0);
  async function makeUp() {
    makeGen.current += 1;
    const mine = makeGen.current;
    setMaking(true);
    setMakeError(null);
    setBad(null);
    try {
      const out = await api.call(assistRoutes.opsAssistTestData, {
        params: { id: agent.id },
        body: {
          process,
          workflow,
          ...(range ? { range } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      });
      if (makeGen.current !== mine) return;
      if (out.trigger !== undefined) setText(JSON.stringify(out.trigger, null, 2));
      setTyped((was) => ({
        ...was,
        ...Object.fromEntries(
          Object.entries(out.given).map(([id, data]) => [id, JSON.stringify(data, null, 2)]),
        ),
      }));
      setMade(out.missing);
    } catch (e) {
      if (makeGen.current === mine) setMakeError(e);
    } finally {
      if (makeGen.current === mine) setMaking(false);
    }
  }
  const caseRef = useRef<string | null>(null);
  // Each try has its number: an older try's answers are dropped once another starts.
  const gen = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const marksRef = useRef(onMarks);
  marksRef.current = onMarks;
  // The step ids of the try going on, when it runs some of the steps (given ones included).
  const ran = useRef<ReadonlySet<string> | null>(null);
  const sentRange = useRef<processes.TestRange | null>(null);

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
      setLast(run);
      // A step outside the ones picked wasn't skipped by the run: it was never part of the test.
      const inside = ran.current;
      const marks = tryMarks(run, process).map((m) =>
        inside && !inside.has(m.stepId)
          ? { ...m, status: "skipped" as const, summary: "Not part of this test" }
          : m,
      );
      marksRef.current(marks);
      setOutcome(
        inside && run.run.status === "succeeded"
          ? "It ran the steps you picked. Nothing was written."
          : tryOutcome(run, marks),
      );
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
      if (suite && !sentRange.current) {
        const before = new Set((suite.poc?.tries ?? []).map((t) => t.caseId));
        let body:
          | { caseId: string }
          | { documentId: string; workflow: string }
          | { record: { kind: PickedRecord["kind"]; id: string }; workflow: string }
          | {
              input: unknown;
              workflow: string;
            };
        if (again && caseRef.current) body = { caseId: caseRef.current };
        else if ("file" in next) {
          const documentId = await uploaded(next.file);
          if (!documentId) return;
          body = { documentId, workflow };
        } else if ("record" in next) {
          body = { record: { kind: next.record.kind, id: next.record.id }, workflow };
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
        if ("record" in next) throw new Error("A record is tried from a build's draft only.");
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
            // A build's draft is tried where the build tries it: its Sandbox.
            ...(agent.kind === "template" && (clientId || (suite ? sandboxId : null))
              ? { clientId: (clientId || sandboxId) as string }
              : {}),
            ...(sentRange.current ? { range: sentRange.current } : {}),
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
  /** The range to send with the next try, or false when what was given doesn't read. */
  const setRange = (): boolean => {
    if (!range || !needs) {
      ran.current = null;
      sentRange.current = null;
      return true;
    }
    const given: Record<string, unknown> = {};
    for (const e of needs.earlier) {
      const parsed = parsePayload(givenText(e.id));
      if (!parsed.ok) {
        setBad(`The output of “${e.name}” isn't valid JSON.`);
        return false;
      }
      given[e.id] = parsed.value;
    }
    ran.current = new Set([...needs.picked.flatMap((x) => x.ids), ...Object.keys(given)]);
    sentRange.current = { from: range.from, to: range.to, given };
    return true;
  };
  const fromInput = () => {
    // A start further down that reads nothing of the trigger needs no input of its own.
    const parsed = asksTrigger ? parsePayload(text) : { ok: true as const, value: {} };
    if (!parsed.ok) {
      setBad("That isn't valid JSON.");
      return;
    }
    if (!setRange()) return;
    void begin({ payload: parsed.value, ...(made ? { made: true } : {}) }, false);
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
            if (f && setRange()) void begin({ file: f }, false);
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
              {midway ? null : filePicker("Choose a file", true)}
              {suite && fileClient ? (
                <Button
                  size="sm"
                  aria-expanded={picking}
                  onClick={() => setPicking((x) => !x)}
                  data-testid="flow-try-pick-record"
                >
                  {picking ? "Close the records" : "Pick a record"}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={done} data-testid="flow-try-done">
                Done
              </Button>
            </div>
          </div>
          {suite && fileClient && picking ? (
            <Suspense fallback={<p className="text-ink-muted">Loading the records…</p>}>
              <RecordPick
                clientId={fileClient}
                busy={false}
                onPick={(record) => {
                  setPicking(false);
                  void begin({ record }, false);
                }}
              />
            </Suspense>
          ) : null}
          {canPick ? (
            <div className="flex flex-col gap-2" data-testid="flow-try-range">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="font-medium text-ink">Which steps</span>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    className="accent-slate"
                    name={`${fileId}-steps`}
                    checked={!some}
                    data-testid="flow-try-all"
                    onChange={() => {
                      setSome(false);
                      setMade(null);
                    }}
                  />
                  All of them
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    className="accent-slate"
                    name={`${fileId}-steps`}
                    checked={some}
                    data-testid="flow-try-some"
                    onChange={() => {
                      setSome(true);
                      setMade(null);
                    }}
                  />
                  Some of them
                </label>
                {some ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <Select
                      aria-label="The first step to run"
                      className="h-8 w-auto text-sm"
                      data-testid="flow-try-from"
                      value={from}
                      onChange={(e) => {
                        const next = e.target.value;
                        setFrom(next);
                        setMade(null);
                        // The last step never comes before the first.
                        const i = top.findIndex((x) => x.id === next);
                        if (top.findIndex((x) => x.id === to) < i) setTo(next);
                      }}
                    >
                      {top.map((x, i) => (
                        <option key={x.id} value={x.id}>
                          From {i + 1} · {x.name}
                        </option>
                      ))}
                    </Select>
                    <Select
                      aria-label="The last step to run"
                      className="h-8 w-auto text-sm"
                      data-testid="flow-try-to"
                      value={to}
                      onChange={(e) => {
                        setTo(e.target.value);
                        setMade(null);
                      }}
                    >
                      {top.map((x, i) =>
                        i < top.findIndex((y) => y.id === from) ? null : (
                          <option key={x.id} value={x.id}>
                            to {i + 1} · {x.name}
                          </option>
                        ),
                      )}
                    </Select>
                  </span>
                ) : null}
              </div>
              {some ? (
                <span className="text-ink-muted">
                  A decision or a loop is tested whole. The run ends after the last step picked.
                </span>
              ) : null}
              {needs?.problems.map((problem) => (
                <p key={problem} className="text-risk" data-testid="flow-try-range-problem">
                  {problem}
                </p>
              ))}
              {needs && needs.earlier.length > 0 ? (
                <div className="flex flex-col gap-2" data-testid="flow-try-given">
                  <span className="font-medium text-ink">What these steps start from</span>
                  {needs.earlier.map((e) => (
                    // biome-ignore lint/a11y/noLabelWithoutControl: the box is the label's child.
                    <label key={e.id} className="flex flex-col gap-1">
                      <span className="text-ink">
                        The output of “{e.name}”
                        <span className="text-ink-muted">
                          {" "}
                          · read by “{e.readBy.join("”, “")}” · {givenFrom(e.id)}
                        </span>
                      </span>
                      <TextArea
                        {...JSON_INPUT_PROPS}
                        data-testid={`flow-try-given-${e.id}`}
                        rows={4}
                        value={givenText(e.id)}
                        className="font-mono text-xs"
                        onChange={(ev) => setTyped({ ...typed, [e.id]: ev.target.value })}
                      />
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {asksTrigger ? (
            <TextArea
              {...JSON_INPUT_PROPS}
              aria-label={midway ? "What started the run (JSON)" : "Or give an input (JSON)"}
              data-testid="flow-try-input"
              rows={4}
              value={text}
              className="font-mono text-xs"
              onChange={(e) => setText(e.target.value)}
            />
          ) : null}
          {canMake && (asksTrigger || (needs?.earlier.length ?? 0) > 0) ? (
            <div className="flex flex-col gap-1.5" data-testid="flow-try-make">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">No data yet?</span>
                <TextInput
                  aria-label="What the made-up data should look like (optional)"
                  placeholder="Optional: a $640 lumber bill, a late payment"
                  className="h-8 min-w-[220px] flex-1 text-sm"
                  data-testid="flow-try-make-notes"
                  maxLength={TEST_DATA_NOTES_MAX}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={making || (needs?.problems.length ?? 0) > 0}
                  onClick={() => void makeUp()}
                  data-testid="flow-try-make-go"
                >
                  {making ? "Making it up" : made ? "Make up other data" : "Make up data"}
                </Button>
              </div>
              {made ? (
                <span className="text-ink-muted" data-testid="flow-try-made">
                  Made up from the shapes these steps read; none of it is a client's. Read it over
                  and change what you like, then run it. A made-up id matches no stored record, so a
                  step that looks one up won't find it: for a document, choose a file.
                  {made.length > 0
                    ? ` We couldn't make up ${made.join(", ").toLowerCase()}: an example of its shape is there instead.`
                    : ""}
                </span>
              ) : null}
              {makeError ? (
                // The model's failure in our words; a refusal (HIPAA, the allowance) in its own.
                isApiError(makeError) && makeError.code === "draft_failed" ? (
                  <p className="text-risk" role="alert" data-testid="flow-try-make-failed">
                    We couldn't make up the data. Try again.
                  </p>
                ) : (
                  <ErrorNotice error={makeError} />
                )
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-ink-muted">
              {!asksTrigger
                ? "These steps read nothing of what started the run."
                : midway
                  ? "What started the run, as JSON: a picked step reads it."
                  : fileClient
                    ? "Or give an input as JSON."
                    : "Give an input as JSON."}
            </span>
            <Button
              size="sm"
              onClick={fromInput}
              disabled={(needs?.problems.length ?? 0) > 0}
              data-testid="flow-try-input-start"
            >
              {range ? "Test these steps" : "Try it on this input"}
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
          {canPick && !going ? (
            <div>
              <button
                type="button"
                className="ds-btn ds-btn--link"
                data-testid="flow-try-choose"
                onClick={() => {
                  stop();
                  setPhase("choose");
                }}
              >
                Test other steps
              </button>
            </div>
          ) : null}
          {last && last.steps.length > 0 ? <StepOutputs run={last} process={process} /> : null}
        </>
      )}
    </div>
  );
}

/** What a row's status reads as, in a word. */
const ROW_WORD: Record<string, string> = {
  succeeded: "Done",
  failed: "Failed",
  skipped: "Skipped",
  waiting: "Waiting",
  running: "Running",
};

/** How much of an output is drawn: the rest is on the run's page. */
const OUTPUT_MAX_CHARS = 20_000;

/**
 * Every step the try ran, in the order it ran them, each with its output (owner, 2026-11-22: "we
 * see the output of each step"). A step in a loop has a row for each time round.
 */
function StepOutputs({ run, process }: { run: TryRun; process: Process }) {
  const names = useMemo(
    () => new Map(processes.allSteps(process).map((l) => [l.step.id, l.step.name])),
    [process],
  );
  const rows = run.steps.slice(0, 100);
  return (
    <div className="flex flex-col gap-1.5" data-testid="flow-try-steps">
      <span className="font-medium text-ink">What each step did</span>
      {rows.map((row) => {
        const text =
          row.output === undefined || row.output === null
            ? null
            : JSON.stringify(row.output, null, 2);
        return (
          <details
            key={row.id}
            className="rounded-sm border border-line bg-surface"
            data-testid={`flow-try-step-${row.nodeId}`}
          >
            <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-2 px-3 py-1.5">
              <span className="font-medium text-ink">{names.get(row.nodeId) ?? row.nodeId}</span>
              <span className="font-mono text-xs text-ink-muted">
                {ROW_WORD[row.status] ?? row.status}
              </span>
              {row.summary ? <span className="text-ink-muted">{row.summary}</span> : null}
            </summary>
            <pre className="max-h-64 overflow-auto border-t border-line px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap text-ink">
              {text === null
                ? "No output."
                : text.length > OUTPUT_MAX_CHARS
                  ? `${text.slice(0, OUTPUT_MAX_CHARS)}\n… the rest is on the test run's page.`
                  : text}
            </pre>
          </details>
        );
      })}
      {run.steps.length > rows.length ? (
        <span className="text-ink-muted">
          {run.steps.length - rows.length} more are on the test run's page.
        </span>
      ) : null}
    </div>
  );
}
