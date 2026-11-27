// Try it on a step-model workflow (feedback, 2026-11-26: "where are we supposed to test a workflow
// or a step? The Try button is gone"). The v4 builder's Try panel went with it (#707); this is the
// step builder's: the draft is saved, then run once as a test run (`opsTestRun`: a template in the
// Sandbox or the client picked, a client's agent at its own client), read back until it ends, and
// each step's result is handed to the chart and the list. A test run never writes: what it would
// change or send is recorded as proposed.
// DECISION: a JSON input started from the trigger's sample, and every step of the workflow.
// Owner, 2026-11-26 ("we used to have the feature that created required data to start the flow… a
// PDF receipt, or a JSON, whatever it needs"): Make up data fills the input from the trigger's
// shape (`opsAssistTestData`); where the trigger carries a document, it makes up a document (a
// receipt, an invoice), kept in the Sandbox as a PDF, and the input names it.
import {
  assistRoutes,
  steps as stepModel,
  TEST_DATA_NOTES_MAX,
  TEST_DATA_VARIATIONS,
  type TestDataVariationId,
} from "@countersign/core";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../../api/client";
import { apiRoutes } from "../../../api/routes";
import { sandboxUploadPath, uploadFiles } from "../../../api/upload";
import { useApiClient } from "../../../api/useApi";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Select, TextArea, TextInput } from "../../../ui/forms";
import { Icon } from "../../../ui/icons";
import { Badge, Button } from "../../../ui/primitives";
import { JSON_INPUT_PROPS, parsePayload } from "../../agents/TestPayload";
import type { TryMark } from "../../flow/types";
import { useOpsClients } from "../../OpsLayout";
import { OPS_PATHS } from "../../paths";
import { parseNodeId } from "../../run/checklist";
import { findStep, walk } from "./model";
import {
  FromField,
  type LiveMessage,
  LiveRunNotes,
  messageOn,
  useLiveRun,
  useTrySender,
} from "./TrySender";
import type { Workflow } from "./types";

export type TryRun = ResponseOf<typeof apiRoutes.opsRun>;
type Row = TryRun["steps"][number];

const POLL_MS = 1500;
/** How long the panel follows a run before it says to open it. */
const FOLLOW_MS = 5 * 60_000;

export function tryEnded(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** A row the test run recorded and never made: a write or a send it proposed. */
function wouldHave(row: Row, run: TryRun): boolean {
  if (row.status !== "succeeded") return false;
  const out = row.output && typeof row.output === "object" ? (row.output as object) : {};
  if ((out as { wouldHaveDone?: unknown }).wouldHaveDone === true) return true;
  return run.actions.some((a) => a.stepRunId === row.id && a.status === "proposed");
}

const RANK: Record<TryMark["status"], number> = {
  skipped: 0,
  did: 1,
  would: 2,
  waiting: 3,
  failed: 4,
};

/** One mark per step of the workflow that has a row: the worst of its rows (a loop runs it often). */
export function tryMarks(run: TryRun, workflow: Workflow): TryMark[] {
  const out = new Map<string, TryMark>();
  for (const row of run.steps) {
    const { stepId } = parseNodeId(row.nodeId);
    if (!findStep(workflow, stepId)) continue;
    const said = row.summary?.trim() || undefined;
    let mark: TryMark | null = null;
    switch (row.status) {
      case "succeeded":
        mark = wouldHave(row, run)
          ? {
              stepId,
              status: "would",
              summary: said ?? "Would have done this. Nothing was written.",
            }
          : { stepId, status: "did", summary: said ?? "Done" };
        break;
      case "failed":
        mark = { stepId, status: "failed", summary: said ?? errorWords(run) ?? "It failed here" };
        break;
      case "waiting":
        mark = { stepId, status: "waiting", summary: said ?? "Waiting for a person" };
        break;
      case "skipped":
      case "cancelled":
        mark = { stepId, status: "skipped", summary: said ?? "Skipped" };
        break;
    }
    if (!mark) continue;
    const was = out.get(stepId);
    if (!was || RANK[mark.status] >= RANK[was.status]) out.set(stepId, mark);
  }
  return [...out.values()];
}

function errorWords(run: TryRun): string | null {
  const e = run.run.error as unknown;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const said =
      (e as { reason?: unknown; message?: unknown }).reason ?? (e as { message?: unknown }).message;
    if (typeof said === "string" && said) return said;
  }
  return null;
}

function outcome(run: TryRun, marks: readonly TryMark[]): string {
  const n = (s: TryMark["status"]) => marks.filter((m) => m.status === s).length;
  switch (run.run.status) {
    case "succeeded": {
      const would = n("would");
      return would
        ? `It ran to the end. ${would} ${would === 1 ? "step" : "steps"} would have written or sent: nothing was.`
        : "It ran to the end. Nothing was written.";
    }
    case "failed":
      return `It stopped: ${errorWords(run) ?? "a step failed"}.`;
    case "cancelled":
      return "It was cancelled.";
    case "waiting":
      return "It is waiting for a person. Open the test run to answer it.";
    default:
      return "It is running…";
  }
}

/**
 * Owner, 2026-11-27: whether the workflow has people a test could ask: a Contact step, a person's
 * step, or a change or send that waits for approval.
 */
export function hasPeople(workflow: Pick<Workflow, "steps">): boolean {
  return walk(workflow).some(({ step }) => {
    if (step.kind !== "do") return false;
    if (step.doneBy === "contact" || step.doneBy === "person") return true;
    return step.uses?.type === "action" && step.checks?.approval?.required !== "not_required";
  });
}

const CHECK_WORDS: Record<string, string> = {
  email: "check your email",
  sms: "check your texts",
  whatsapp: "check WhatsApp",
  call: "check your phone",
};

/**
 * What a test run with people in it waits on you for, in words: an approval or a decision in Your
 * call, or your answer to a Contact step's message. Null when it waits on nothing of yours.
 */
export function waitingOnYou(
  run: TryRun,
  workflow: Workflow,
): { words: string; yourCall: boolean } | null {
  if (run.run.status !== "waiting") return null;
  if (run.inbox.some((i) => i.status === "open")) {
    return { words: "Waiting for you to approve in Your call", yourCall: true };
  }
  for (const row of run.steps) {
    if (row.status !== "waiting" || row.nodeType !== "conversation") continue;
    const step = findStep(workflow, parseNodeId(row.nodeId).stepId)?.step;
    const channel = step?.kind === "do" ? (step.contact?.channel ?? "email") : "email";
    return { words: `Waiting for your answer: ${CHECK_WORDS[channel]}`, yourCall: false };
  }
  return null;
}

const MARK_TONE: Record<TryMark["status"], "positive" | "warning" | "risk" | "neutral"> = {
  did: "positive",
  would: "positive",
  waiting: "warning",
  failed: "risk",
  skipped: "neutral",
};
const MARK_WORD: Record<TryMark["status"], string> = {
  did: "Did",
  would: "Would do",
  waiting: "Waiting",
  failed: "Failed",
  skipped: "Skipped",
};

export interface TryPanelProps {
  agent: { id: string; kind: "template" | "client"; tenantId: string | null };
  workflow: Workflow;
  /** The workflow's slug: the one the test run runs. */
  slug: string;
  /** The trigger's sample payload, to start the input from. */
  sample: unknown;
  /** The workflow's name, for making up data. */
  name: string;
  /**
   * What the trigger carries: values (made up as JSON), a stored document (made up as a PDF, or
   * one of yours), or a stored message and its attachments (an email made up, with PDFs or yours).
   */
  triggerKind: "json" | "document" | "message";
  /** Saves unsaved changes as a draft; answers the version to run, or null when saving failed. */
  prepare(): Promise<string | null>;
  /** Each step's result, for the chart and the list; [] clears them. */
  onMarks(marks: TryMark[]): void;
  onSelect(stepId: string): void;
  onClose(): void;
}

export function TryPanel(props: TryPanelProps) {
  const api = useApiClient();
  const clients = useOpsClients();
  const [text, setText] = useState(() =>
    props.sample === undefined ? "{}" : JSON.stringify(props.sample, null, 2),
  );
  const sandbox = clients?.find((c) => c.sandbox)?.id ?? null;
  const [clientId, setClientId] = useState<string | null>(null);
  const where = clientId ?? sandbox;
  const [phase, setPhase] = useState<"choose" | "starting" | "running" | "ended" | "error">(
    "choose",
  );
  const [error, setError] = useState<unknown>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [last, setLast] = useState<TryRun | null>(null);
  const gen = useRef(0);
  const marksRef = useRef(props.onMarks);
  marksRef.current = props.onMarks;
  const parsed = parsePayload(text);
  // ── Made-up data ──
  const [notes, setNotes] = useState("");
  // Cases to try (owner, 2026-11-26: "create an invoice that does not match the vendor so that we
  // can see different cases of a flow"): picked here, added to the words above.
  const [variations, setVariations] = useState<readonly TestDataVariationId[]>([]);
  const [making, setMaking] = useState(false);
  const [makeError, setMakeError] = useState<unknown>(null);
  const [made, setMade] = useState<
    | { kind: "json"; missing: boolean }
    | { kind: "document"; filename: string; clientId: string }
    | {
        kind: "message";
        subject: string;
        from: string;
        files: string[];
        /** For Run it live: the same message. */
        live: LiveMessage;
      }
    | null
  >(null);
  // Files of yours for the try (owner, 2026-11-26: "allow me to upload a document too"), kept in
  // the Sandbox quietly as a try's upload is: the document the trigger names, or a message's files.
  const [mine, setMine] = useState<{ id: string; filename: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileField = useId();
  const kind = props.triggerKind;
  const notesField = useId();
  // ── Which steps (owner, 2026-11-26: "the whole flow, or from step x to y") ──
  const top = props.workflow.steps.filter((s) => s.kind !== "end");
  const [which, setWhich] = useState<"all" | "some">("all");
  const [from, setFrom] = useState<string>(() => top[0]?.id ?? "");
  const [to, setTo] = useState<string>(() => top.at(-1)?.id ?? "");
  const [givenText, setGivenText] = useState<Record<string, string>>({});
  const range = which === "some" ? { from, to } : null;
  const needs = range ? stepModel.stepRangeNeeds(props.workflow, range) : null;
  const given: Record<string, unknown> = {};
  let givenBad: string | null = null;
  for (const e of needs?.earlier ?? []) {
    const p = parsePayload(givenText[e.id] ?? "{}");
    if (p.ok) given[e.id] = p.value;
    else givenBad = e.name;
  }
  const rangeProblem = needs?.problems[0] ?? null;
  const fromField = useId();
  const toField = useId();
  // A made-up document is kept in the Sandbox only (the API refuses one for a client's agent,
  // unless the agent is the Sandbox's own).
  const inSandbox = props.agent.kind === "client" && !!sandbox && props.agent.tenantId === sandbox;
  // People in this test (owner, 2026-11-27): in the Sandbox, "Ask me" sends its messages to you
  // and waits for your answers and approvals (written changes still never are).
  const askable = hasPeople(props.workflow);
  const runsInSandbox =
    props.agent.kind === "template" ? !!sandbox && where === sandbox : inSandbox;
  const [people, setPeople] = useState<"ask_me" | "skip">("ask_me");
  const peopleNow = askable && runsInSandbox ? people : "skip";
  const peopleField = useId();
  const canMake = !(kind !== "json" && props.agent.kind === "client" && !inSandbox);
  // Who a made-up message is from, and Run it live in the Sandbox (owner, 2026-11-27).
  const forMessage = kind === "message" && canMake && !!sandbox;
  const sender = useTrySender({
    sandbox,
    on: messageOn(props.workflow),
    enabled: forMessage,
  });
  const liveMessage: LiveMessage | null = !forMessage
    ? null
    : made?.kind === "message"
      ? made.live
      : mine.length > 0
        ? {
            subject: null,
            text: "",
            documentIds: mine.map((m) => m.id),
            contactId: null,
            channel: null,
          }
        : null;
  const live = useLiveRun({
    agent: props.agent,
    sandbox,
    message: liveMessage,
    resolve: sender.resolve,
    enabled: !!liveMessage,
  });
  async function upload(files: File[]) {
    if (!sandbox || files.length === 0) return;
    setUploading(true);
    setMakeError(null);
    try {
      const out = await uploadFiles(files, undefined, `${sandboxUploadPath(sandbox)}?for=try`);
      const docs = out.results.flatMap((r) =>
        r.kind === "document" && r.document
          ? [
              {
                id: r.document.id,
                filename: r.document.filename,
                source: r.document.source,
                mimeType: r.document.mimeType,
              },
            ]
          : [],
      );
      const refused = out.results.find((r) => r.kind !== "document" || !r.document);
      if (refused)
        setMakeError(
          new Error(refused.error ?? "That file can't be tried: use a PDF or an image."),
        );
      setClientId(sandbox);
      if (kind === "document") {
        const d = docs[0];
        if (!d) return;
        setMine([{ id: d.id, filename: d.filename }]);
        // The payload `document.received` carries, as a try's upload sends it.
        setText(
          JSON.stringify(
            { documentId: d.id, source: d.source, filename: d.filename, mimeType: d.mimeType },
            null,
            2,
          ),
        );
        setMade(null);
      } else {
        setMine((was) =>
          [...was, ...docs.map((d) => ({ id: d.id, filename: d.filename }))].slice(0, 5),
        );
        setMade(null);
      }
    } catch (e) {
      setMakeError(e);
    } finally {
      setUploading(false);
    }
  }
  async function makeUp() {
    setMaking(true);
    setMakeError(null);
    try {
      const who = forMessage ? await sender.resolve() : null;
      const out = await api.call(assistRoutes.opsAssistTestData, {
        params: { id: props.agent.id },
        body: {
          workflow: props.workflow,
          name: props.name,
          ...(who ? { fromContactId: who.contactId, channel: who.channel } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(variations.length > 0 ? { variations: [...variations] } : {}),
          ...(kind === "message" && mine.length > 0 ? { attach: mine.map((m) => m.id) } : {}),
        },
      });
      setText(JSON.stringify(out.trigger, null, 2));
      if (out.message) {
        // The email and its files are in the Sandbox: the try runs there.
        setClientId(out.message.clientId);
        setMade({
          kind: "message",
          subject: out.message.subject,
          from: out.message.from,
          files: out.message.attachments.map((a) => a.filename),
          live: {
            subject: out.message.subject,
            text: out.message.text ?? "",
            documentIds: out.message.attachments.map((a) => a.id),
            contactId: out.message.contactId ?? null,
            channel: out.message.channel ?? null,
          },
        });
      } else if (out.document) {
        // The document is in the Sandbox: the try runs there.
        setClientId(out.document.clientId);
        setMade({
          kind: "document",
          filename: out.document.filename,
          clientId: out.document.clientId,
        });
      } else setMade({ kind: "json", missing: out.missing });
    } catch (e) {
      setMakeError(e);
    } finally {
      setMaking(false);
    }
  }
  const clientField = useId();
  const inputField = useId();

  // Closing the panel stops following the run (it goes on on the server).
  useEffect(
    () => () => {
      gen.current += 1;
    },
    [],
  );

  const marks = useMemo(() => (last ? tryMarks(last, props.workflow) : []), [last, props.workflow]);
  const waiting = last ? waitingOnYou(last, props.workflow) : null;

  async function start() {
    if (!parsed.ok) return;
    gen.current += 1;
    const mine = gen.current;
    setPhase("starting");
    setError(null);
    setRunId(null);
    setLast(null);
    marksRef.current([]);
    try {
      const vid = await props.prepare();
      if (gen.current !== mine) return;
      if (!vid) {
        setPhase("choose");
        return;
      }
      const res = await api.call(apiRoutes.opsTestRun, {
        params: { id: props.agent.id, vid },
        body: {
          workflow: props.slug,
          payload: parsed.value,
          ...(range
            ? {
                range: {
                  ...(from ? { from } : {}),
                  ...(to ? { to } : {}),
                  ...(Object.keys(given).length > 0 ? { given } : {}),
                },
              }
            : {}),
          ...(props.agent.kind === "template" && where ? { clientId: where } : {}),
          ...(peopleNow === "ask_me" ? { people: "ask_me" as const } : {}),
        },
      });
      if (gen.current !== mine) return;
      setRunId(res.runId);
      setPhase("running");
      // With people in the test, a wait for you is followed until you answer.
      const asking = peopleNow === "ask_me";
      const until = Date.now() + FOLLOW_MS;
      let refresh = false;
      for (;;) {
        const run: TryRun = await api.call(apiRoutes.opsRun, {
          params: { id: res.runId },
          refresh,
        });
        refresh = true;
        if (gen.current !== mine) return;
        setLast(run);
        marksRef.current(tryMarks(run, props.workflow));
        if (
          tryEnded(run.run.status) ||
          (run.run.status === "waiting" && !asking) ||
          Date.now() > until
        ) {
          setPhase("ended");
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (gen.current !== mine) return;
      }
    } catch (e) {
      if (gen.current !== mine) return;
      setError(e);
      setPhase("error");
    }
  }

  const order = walk(props.workflow).map((l) => l.step);
  const busy = phase === "starting" || phase === "running";

  return (
    <aside aria-label="Try it" data-testid="steps-try" className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex flex-col gap-1">
          <span className="eyebrow text-ink-muted">Test run</span>
          <h2 className="type-subheading text-ink">Try it</h2>
          <p className="text-sm text-ink-muted">
            Runs this draft once on an example. It never writes to a tool: what it would change is
            shown as proposed. It sends only to you, when you ask it to.
          </p>
        </div>
        <Button
          variant="ghost"
          className="ds-btn--icon shrink-0"
          aria-label="Close"
          data-testid="steps-try-close"
          onClick={props.onClose}
        >
          <Icon name="close" size={20} />
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        {props.agent.kind === "template" ? (
          <div className="flex flex-col gap-1 text-sm text-ink">
            <label htmlFor={clientField}>Run it at</label>
            <Select
              id={clientField}
              data-testid="steps-try-client"
              value={where ?? ""}
              onChange={(e) => setClientId(e.target.value || null)}
            >
              {(clients ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.sandbox ? " (Sandbox)" : ""}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <section
          className="flex flex-col gap-2"
          data-testid="steps-try-which"
          aria-label="Which steps"
        >
          <span className="text-sm text-ink">Which steps</span>
          <fieldset className="ds-seg self-start" aria-label="Which steps">
            <button
              type="button"
              aria-pressed={which === "all"}
              data-testid="steps-try-all"
              onClick={() => setWhich("all")}
            >
              The whole workflow
            </button>
            <button
              type="button"
              aria-pressed={which === "some"}
              data-testid="steps-try-some"
              onClick={() => setWhich("some")}
            >
              From one step to another
            </button>
          </fieldset>
          {which === "some" ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1 text-sm text-ink">
                <label htmlFor={fromField}>From</label>
                <Select
                  id={fromField}
                  data-testid="steps-try-from"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                >
                  {top.map((s, i) => (
                    <option key={s.id} value={s.id}>
                      {i + 1}. {s.name.trim() || "A step"}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1 text-sm text-ink">
                <label htmlFor={toField}>To</label>
                <Select
                  id={toField}
                  data-testid="steps-try-to"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                >
                  {top.map((s, i) => (
                    <option key={s.id} value={s.id}>
                      {i + 1}. {s.name.trim() || "A step"}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          ) : null}
          {rangeProblem ? (
            <p className="text-sm text-risk-ink" data-testid="steps-try-range-problem">
              {rangeProblem.charAt(0).toUpperCase() + rangeProblem.slice(1)}.
            </p>
          ) : null}
          {(needs?.earlier ?? []).map((e) => (
            <div key={e.id} className="flex flex-col gap-1 text-sm text-ink">
              <label htmlFor={`given-${e.id}`}>What “{e.name}” gave</label>
              <span className="text-xs text-ink-muted">
                It isn't run in this test, and “{e.readBy[0]}” reads it. As JSON.
              </span>
              <TextArea
                {...JSON_INPUT_PROPS}
                id={`given-${e.id}`}
                data-testid={`steps-try-given-${e.id}`}
                rows={4}
                className="font-mono text-xs"
                value={givenText[e.id] ?? "{}"}
                onChange={(ev) => setGivenText((was) => ({ ...was, [e.id]: ev.target.value }))}
              />
            </div>
          ))}
          {givenBad ? (
            <p className="text-sm text-risk-ink">What “{givenBad}” gave isn't valid JSON.</p>
          ) : null}
        </section>
        {askable ? (
          <section
            className="flex flex-col gap-2"
            data-testid="steps-try-people"
            aria-labelledby={peopleField}
          >
            <span id={peopleField} className="text-sm text-ink">
              People in this test
            </span>
            <fieldset className="ds-seg self-start" aria-label="People in this test">
              <button
                type="button"
                aria-pressed={peopleNow === "ask_me"}
                disabled={!runsInSandbox || busy}
                data-testid="steps-try-people-ask"
                onClick={() => setPeople("ask_me")}
              >
                Ask me
              </button>
              <button
                type="button"
                aria-pressed={peopleNow === "skip"}
                disabled={busy}
                data-testid="steps-try-people-skip"
                onClick={() => setPeople("skip")}
              >
                Skip them
              </button>
            </fieldset>
            <p className="text-xs text-ink-muted" data-testid="steps-try-people-words">
              {!runsInSandbox ? (
                "Ask me works in the Sandbox only. Here, nobody is sent anything and approvals read as given."
              ) : peopleNow === "ask_me" ? (
                <>
                  You stand in for everyone: its messages go to you, and it waits for your answers
                  and approvals. Approved changes are still not written. They go to your email and
                  your phone from the Sandbox's people, or{" "}
                  <Link
                    className="text-slate underline"
                    to={`${OPS_PATHS.client(sandbox as string)}/records`}
                  >
                    where the Sandbox's Records page says
                  </Link>
                  .
                </>
              ) : (
                "Nobody is sent anything: messages are written and shown, and approvals read as given."
              )}
            </p>
          </section>
        ) : null}
        <div className="flex flex-col gap-1 text-sm text-ink">
          <label htmlFor={inputField}>What starts it</label>
          <span className="text-xs text-ink-muted">
            The trigger's input as JSON, started from its example. Change it to try another case.
          </span>
          <TextArea
            {...JSON_INPUT_PROPS}
            id={inputField}
            data-testid="steps-try-input"
            rows={8}
            className="font-mono text-xs"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        {!parsed.ok ? <p className="text-sm text-risk-ink">That isn't valid JSON.</p> : null}
        <section
          className="flex flex-col gap-2 border border-line p-3"
          data-testid="steps-try-make"
          aria-label="Make up data"
        >
          <span className="text-sm font-medium text-ink">No data yet?</span>
          {canMake ? (
            <>
              <label htmlFor={notesField} className="text-xs text-ink-muted">
                {kind === "message"
                  ? "We make up the email that starts it, with receipts or invoices attached as PDFs, kept in the Sandbox. Say what it should be, or attach your own files."
                  : kind === "document"
                    ? "We make up a document for it to read (a receipt, an invoice), kept in the Sandbox as a PDF. Say what it should be, or use your own file."
                    : "We make up what starts it from the trigger's shape. Say what it should look like, or leave it to us."}
              </label>
              <TextInput
                id={notesField}
                data-testid="steps-try-notes"
                maxLength={TEST_DATA_NOTES_MAX}
                placeholder={
                  kind === "message"
                    ? "An employee sends two receipts from a site visit"
                    : kind === "document"
                      ? "A $236 lumber receipt from a hardware store"
                      : "A $640 lumber bill, over the approval limit"
                }
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <fieldset className="flex flex-col gap-1.5" data-testid="steps-try-variations">
                <legend className="mb-1 text-xs text-ink-muted">
                  A case to try (pick any). In the Sandbox, made-up data uses its own vendors,
                  people and items, or misses them on purpose.
                </legend>
                <div className="flex flex-wrap gap-1.5">
                  {TEST_DATA_VARIATIONS.filter(
                    (v) => kind === "message" || v.id !== "stranger",
                  ).map((v) => {
                    const on = variations.includes(v.id);
                    return (
                      <button
                        key={v.id}
                        type="button"
                        aria-pressed={on}
                        data-testid={`steps-try-variation-${v.id}`}
                        title={v.words}
                        className={
                          on
                            ? "ds-pill border border-slate bg-slate-tint px-2.5 py-1 text-xs text-ink"
                            : "ds-pill border border-line px-2.5 py-1 text-xs text-ink hover:border-line-strong"
                        }
                        onClick={() =>
                          setVariations((was) =>
                            on ? was.filter((x) => x !== v.id) : [...was, v.id].slice(0, 5),
                          )
                        }
                      >
                        {v.label}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              {forMessage ? <FromField sender={sender} disabled={making || busy} /> : null}
              {kind !== "json" && sandbox ? (
                <div className="flex flex-col gap-1 text-xs text-ink-muted">
                  <label htmlFor={fileField}>
                    {kind === "message"
                      ? "Or attach your own files (PDF or image, up to 5): we write the email around them."
                      : "Or use your own file (a PDF or an image)."}
                  </label>
                  <input
                    id={fileField}
                    type="file"
                    data-testid="steps-try-file"
                    accept="application/pdf,image/*"
                    multiple={kind === "message"}
                    disabled={uploading || making || busy}
                    className="text-xs text-ink"
                    onChange={(e) => {
                      const files = [...(e.target.files ?? [])];
                      e.target.value = "";
                      void upload(files);
                    }}
                  />
                  {mine.length > 0 ? (
                    <span data-testid="steps-try-mine">
                      {kind === "document" ? "Using " : "Attached: "}
                      {mine.map((m) => m.filename).join(", ")}
                      {kind === "message" ? (
                        <>
                          {" "}
                          <button type="button" className="underline" onClick={() => setMine([])}>
                            Clear
                          </button>
                        </>
                      ) : null}
                    </span>
                  ) : null}
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  data-testid="steps-try-make-up"
                  working={making || uploading}
                  disabled={making || uploading || busy}
                  onClick={() => void makeUp()}
                >
                  {kind === "message"
                    ? mine.length > 0
                      ? "Write the email around them"
                      : made
                        ? "Make up another email"
                        : "Make up an email"
                    : kind === "document"
                      ? made
                        ? "Make up another document"
                        : "Make up a document"
                      : made
                        ? "Make up other data"
                        : "Make up data"}
                </Button>
                {made?.kind === "message" ? (
                  <span className="text-xs text-ink-muted" data-testid="steps-try-made">
                    {made.live.channel === "sms"
                      ? `Made a text from ${made.from}`
                      : made.live.channel === "whatsapp"
                        ? `Made a WhatsApp message from ${made.from}`
                        : `Made “${made.subject}” from ${made.from}`}
                    {made.files.length > 0
                      ? `, with ${made.files.join(", ")}`
                      : ", with nothing attached"}
                    , in the Sandbox. Run the test to read it.
                  </span>
                ) : made?.kind === "document" ? (
                  <span className="text-xs text-ink-muted" data-testid="steps-try-made">
                    Made {made.filename}, in the Sandbox. Run the test to read it.
                  </span>
                ) : made?.kind === "json" ? (
                  <span className="text-xs text-ink-muted" data-testid="steps-try-made">
                    {made.missing
                      ? "We couldn't make it up: the box holds an example of its shape instead."
                      : "Made up. Read it over, change what you like, then run the test."}
                  </span>
                ) : null}
              </div>
              {makeError ? <ErrorNotice error={makeError} /> : null}
            </>
          ) : (
            <p className="text-xs text-ink-muted">
              A made-up document or email is kept in the Sandbox only. Try the template there, or
              run this on what the client sent.
            </p>
          )}
        </section>
        {liveMessage ? <LiveRunNotes live={live} templateId={props.agent.id} /> : null}
        {error ? <ErrorNotice error={error} /> : null}
        {last ? (
          <section className="flex flex-col gap-2" data-testid="steps-try-result">
            {waiting ? (
              <p className="text-sm text-ink" data-testid="steps-try-waiting">
                <Badge tone="warning">Waiting</Badge> {waiting.words}
                {waiting.yourCall ? (
                  <>
                    {" "}
                    <Link className="text-slate underline" to={OPS_PATHS.escalations}>
                      Open Your call
                    </Link>
                  </>
                ) : null}
                .
              </p>
            ) : (
              <p className="text-sm text-ink" data-testid="steps-try-outcome">
                {phase === "running" ? "It is running…" : outcome(last, marks)}
              </p>
            )}
            <ul className="flex flex-col divide-y divide-line border border-line">
              {order
                .map((s) => ({ s, m: marks.find((m) => m.stepId === s.id) }))
                .filter((x) => x.m)
                .map(({ s, m }) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-surface-muted"
                      onClick={() => props.onSelect(s.id)}
                    >
                      <Badge tone={MARK_TONE[m?.status ?? "skipped"]}>
                        {MARK_WORD[m?.status ?? "skipped"]}
                      </Badge>
                      <span className="flex min-w-0 flex-col">
                        <span className="text-sm text-ink">{s.name.trim() || "A step"}</span>
                        {m?.summary ? (
                          <span className="text-xs text-ink-muted">{m.summary}</span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
        <Button
          variant="primary"
          size="sm"
          data-testid="steps-try-run"
          working={busy}
          disabled={
            busy ||
            !parsed.ok ||
            !!rangeProblem ||
            !!givenBad ||
            (props.agent.kind === "template" && !where)
          }
          onClick={() => void start()}
        >
          {last ? "Run it again" : "Run the test"}
        </Button>
        {liveMessage ? (
          <Button
            size="sm"
            data-testid="steps-try-live-run"
            working={live.busy}
            disabled={live.busy || busy || making || !live.target}
            onClick={() => void live.run()}
          >
            Run it live in the Sandbox
          </Button>
        ) : null}
        {runId ? (
          <Link
            className="text-sm text-slate underline"
            data-testid="steps-try-open"
            to={`${OPS_PATHS.runs}/${runId}`}
          >
            Open the test run
          </Link>
        ) : null}
      </div>
    </aside>
  );
}
