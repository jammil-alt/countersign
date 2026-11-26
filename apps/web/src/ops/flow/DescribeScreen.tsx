// A new build's first screen (docs/builder-plan.md §12.5 F5, docs/plan.md §1.170; design:
// docs/design/builder.html `describeHTML`): "What should it do?", its name and the operator's own
// words. Draft the workflow starts the build as the lab's New did (`opsStartBuild`, an agent build
// for everyone or one client) and drafts it at once from the words (`opsDraftBuildNow`, §1.165),
// then opens the draft's workflow in the builder as its list of steps, to edit there (owner,
// 2026-11-26: "if it goes from prompt to building the workflow, the verify step is redundant").
// List the steps myself starts the build with no draft (draft-now needs words) and opens Check the
// steps with an empty list to type into. Builds already open
// keep today's page (owner, 2026-11-21).
//
// The name may be left empty (owner, 2026-11-21: "let's create the name of the template with AI
// based on the description… make it editable"): once the words are written it is named from them
// (Draft's `build.name` field, docs/plan.md §1.168), in the Name field, where it can be changed.
// A name someone typed is never replaced.
import { assistRoutes } from "@countersign/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApiClient } from "../../api/useApi";
import { voiceFor } from "../../api/voice";
import { joinWords } from "../../ui/dictation";
import { ErrorNotice } from "../../ui/ErrorState";
import { Field, TextArea, TextInput } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Thinking } from "../../ui/motion";
import { Button, cx } from "../../ui/primitives";
import { VoiceButton, type VoiceLive } from "../../ui/voice";
import { OPS_PATHS } from "../paths";

/** What a new agent's describe screen is building: a template, or one client's agent. */
export type DescribeKind = "template" | "client";

/** The most the words may say (the draft-now route's limit). */
export const WORDS_MAX = 4000;

// DECISION (docs/plan.md §1.171): the name is made when the words are left, not as they are typed
// (one short call, not one per key), and only from 20 characters of words or more.
/** The fewest characters of words worth naming it from. */
const NAME_FROM_MIN = 20;

/** The model's name as a name: its first line, without quotation marks or a closing full stop. */
export function tidyName(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line
    .replace(/^["“'‘]+|["”'’]+$/g, "")
    .replace(/\.+$/, "")
    .trim()
    .slice(0, 200);
}

/** Router state Check the steps reads: the words the draft was made from, for its quote. */
export interface CheckStepsState {
  words: string;
}

/**
 * Router state the lab's New reads to open Describe again with the words ("Back to the
 * description"), and the build to draft in place when it has no draft yet.
 */
export interface DescribeAgainState {
  describe: {
    name: string;
    words: string;
    kind: DescribeKind;
    clientId?: string | undefined;
    buildId?: string | undefined;
  };
}

export function readDescribeAgain(state: unknown): DescribeAgainState["describe"] | null {
  const d = (state as Partial<DescribeAgainState> | null)?.describe;
  return d && typeof d.name === "string" && typeof d.words === "string" ? d : null;
}

const STEPS = ["Describe it", "Edit the steps", "Try and publish"] as const;

/** Where a new build is: 1 Describe it, 2 Edit the steps, 3 Try and publish (ds-step, in a row). */
export function FlowStepper({ at }: { at: 1 | 2 | 3 }) {
  return (
    <ol
      className="flex flex-wrap items-center gap-2"
      aria-label="Where you are"
      data-testid="flow-stepper"
    >
      {STEPS.map((s, i) => {
        const n = i + 1;
        return (
          <li
            key={s}
            aria-current={n === at ? "step" : undefined}
            className={cx(
              "ds-step rounded-sm",
              n < at
                ? "ds-step--done"
                : n === at
                  ? "ds-step--current font-medium"
                  : "ds-step--todo",
            )}
          >
            <span className="ds-step__mark font-sans figures">
              {n < at ? <Icon name="check" size={14} /> : n}
            </span>
            {s}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The wait while the steps are drafted (owner, 2026-11-21, staging feedback: "add animations to
 * show progress when you click the draft steps button").
 */
// DECISION: the draft is one call, so there are no stages to count. It shows the design system's
// Drafting loop, how long it has been, and what the call does in a sentence, never a bar or a
// list of stages that would only be guessed from the clock.
function Drafting() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <div
      className="flex w-full items-start gap-3 rounded-md border border-line bg-surface-subtle px-3.5 py-3"
      role="status"
      data-testid="flow-describe-drafting"
    >
      <Thinking state="drafting" className="mt-0.5 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
        <span className="flex items-baseline justify-between gap-3">
          <span className="font-medium text-ink">Reading it and drafting the steps</span>
          <span
            className="text-ink-muted tabular-nums"
            aria-hidden
            data-testid="flow-describe-clock"
          >
            {clock}
          </span>
        </span>
        <span className="text-ink-muted">
          It lists the steps in your order, picks a skill or a tool for each, and checks they fit
          together. This usually takes a minute or two; you can leave the page open.
        </span>
      </div>
    </div>
  );
}

export interface DescribeScreenProps {
  kind: DescribeKind;
  /** A client agent's client (required to start one: `blocked` says so until it's picked). */
  clientId?: string | null | undefined;
  /** Above the fields: the lab's choice of what it builds and for whom. */
  header?: ReactNode;
  /** Something above must be settled first (a client agent with no client): the buttons are off. */
  blocked?: boolean | undefined;
  initialName?: string | undefined;
  initialWords?: string | undefined;
  /** A build started before with no draft yet (List the steps myself): drafted in place. */
  buildId?: string | null | undefined;
  onCancel?: (() => void) | undefined;
}

const PLACEHOLDER: Record<DescribeKind, string> = {
  template: "Invoice intake",
  client: "Harbor Millwork's bill review",
};

export function DescribeScreen({
  kind,
  clientId,
  header,
  blocked = false,
  initialName = "",
  initialWords = "",
  buildId = null,
  onCancel,
}: DescribeScreenProps) {
  const api = useApiClient();
  const navigate = useNavigate();
  const [name, setName] = useState(initialName);
  const [words, setWords] = useState(initialWords);
  // The build once started here, so a second try after a failed draft drafts the same build.
  const [started, setStarted] = useState<string | null>(buildId);
  const [busy, setBusy] = useState<"draft" | "mine" | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Whose the name is: someone typed it (never replaced), or we made it from these words.
  const [typed, setTyped] = useState(!!initialName.trim());
  const [naming, setNaming] = useState(false);
  // While dictating: what the recorder is doing, shown under the words.
  const [live, setLive] = useState<VoiceLive | null>(null);
  const [nameFailed, setNameFailed] = useState(false);
  const namedFrom = useRef<string | null>(null);
  const namingNow = useRef<Promise<string> | null>(null);
  // What was typed while a name was being made: it wins over the name that comes back.
  const typedName = useRef<string | null>(initialName.trim() || null);
  const title = name.trim();
  const said = words.trim();
  const canStart = !blocked && busy === null;
  const canName = said.length >= NAME_FROM_MIN;

  /** Names it from the words, into the Name field. One call at a time; the same one is shared. */
  function nameIt(): Promise<string> {
    if (namingNow.current) return namingNow.current;
    const from = said;
    setNaming(true);
    setNameFailed(false);
    const call = api
      .call(assistRoutes.opsAssistDraft, {
        body: {
          field: "build.name",
          notes: from,
          context: kind === "client" && clientId ? { clientId } : {},
        },
      })
      .then((out) => {
        if (typedName.current) return typedName.current;
        const made = tidyName(out.text);
        if (!made) throw new Error("We couldn't name it from your words. Type a name.");
        namedFrom.current = from;
        setName(made);
        return made;
      })
      .finally(() => {
        namingNow.current = null;
        setNaming(false);
      });
    namingNow.current = call;
    return call;
  }

  /** Leaving the words: name it when nobody typed a name and these words haven't named it yet. */
  function nameOnBlur() {
    if (typed || blocked || started || !canName || namedFrom.current === said) return;
    // A failure here is quiet: the field says so, and a name can be typed.
    nameIt().catch(() => setNameFailed(true));
  }

  /** The name to start the build with: the one in the field, or one made from the words now. */
  async function ensureName(): Promise<string> {
    if (namingNow.current) return namingNow.current;
    if (title) return title;
    return nameIt();
  }

  async function ensureBuild(): Promise<string> {
    if (started) return started;
    const named = await ensureName();
    const out = await api.call(apiRoutes.opsStartBuild, {
      body: {
        kind: "agent",
        title: named,
        ...(kind === "client" && clientId ? { clientId } : {}),
      },
    });
    setStarted(out.build.id);
    return out.build.id;
  }

  async function draft() {
    setBusy("draft");
    setError(null);
    try {
      const id = await ensureBuild();
      const out = await api.call(apiRoutes.opsDraftBuildNow, {
        params: { id },
        body: { description: said },
      });
      const agentId = out.draft?.agentId ?? out.build.agentId;
      navigate(agentId ? OPS_PATHS.agentSteps(agentId) : OPS_PATHS.build(id));
    } catch (e) {
      setError(e);
      setBusy(null);
    }
  }

  async function listMine() {
    setBusy("mine");
    setError(null);
    try {
      const id = await ensureBuild();
      navigate(OPS_PATHS.buildCheck(id), { state: { words: said } satisfies CheckStepsState });
    } catch (e) {
      setError(e);
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="flow-describe">
      <FlowStepper at={1} />
      <div className="flex max-w-[62ch] flex-col gap-2">
        <h2 className="text-2xl font-medium text-ink">What should it do?</h2>
        <p className="text-base text-ink-muted">
          Tell it the way you would tell a new hire: how it starts, what happens in order, and where
          someone has to decide. The Builder drafts the workflow from it and opens its steps, ready
          to edit.
        </p>
      </div>
      <form
        className="flex flex-col gap-4 rounded-md border border-line bg-surface p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (canStart && said && (title || canName)) void draft();
        }}
      >
        {header}
        <Field
          label="Name"
          hint={
            naming ? (
              <span role="status" data-testid="flow-describe-naming">
                Naming it from your words
              </span>
            ) : nameFailed ? (
              "We couldn't name it from your words. Type a name."
            ) : typed ? undefined : title ? (
              "Named from your words. Change it if you like."
            ) : (
              "Leave it empty and we name it from your words. You can change it."
            )
          }
        >
          <TextInput
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              // Emptied, it is ours to name again; anything typed is theirs.
              setTyped(e.target.value.trim() !== "");
              typedName.current = e.target.value.trim() || null;
              namedFrom.current = null;
              setNameFailed(false);
            }}
            placeholder={PLACEHOLDER[kind]}
            maxLength={200}
            data-testid="flow-describe-name"
          />
        </Field>
        <Field
          label="In your words"
          hint="It doesn't have to cover every case. What you leave out gets a default you can change later."
        >
          <TextArea
            rows={8}
            className="w-full"
            maxLength={WORDS_MAX}
            value={words}
            onChange={(e) => setWords(e.target.value)}
            onBlur={nameOnBlur}
            placeholder="When a vendor invoice arrives by email, read it and match each line to our item list. If a line doesn't match, ask Dana which item it is. Then create the bill in QuickBooks."
            data-testid="flow-describe-words"
          />
        </Field>
        {live ? (
          <p className="text-sm text-ink-muted" role="status" data-testid="flow-describe-live">
            {live.status}
            {live.held ? ` ${live.held}` : ""}
          </p>
        ) : null}
        {error ? <ErrorNotice error={error} /> : null}
        <div className="flex min-h-9 flex-wrap items-center gap-2">
          {busy === "draft" ? (
            <Drafting />
          ) : (
            <>
              <Button
                type="submit"
                variant="primary"
                disabled={!canStart || !said || !(title || canName)}
                data-testid="flow-describe-draft"
              >
                Draft the workflow
              </Button>
              <Button
                variant="ghost"
                disabled={!canStart || !(title || canName)}
                working={busy === "mine"}
                onClick={() => void listMine()}
                data-testid="flow-describe-mine"
              >
                List the steps myself
              </Button>
              {/* Owner, 2026-11-21 (staging feedback: "add dictation to this"): say it instead of
                  typing it. The words are added to what is there, up to the draft's limit. */}
              <VoiceButton
                voice={voiceFor("ops", kind === "client" ? (clientId ?? null) : null)}
                disabled={busy !== null}
                testId="flow-describe-voice"
                onText={(spoken) => setWords((w) => joinWords(w, spoken).slice(0, WORDS_MAX))}
                onLive={setLive}
              />
              {onCancel ? (
                <Button variant="ghost" onClick={onCancel} data-testid="flow-describe-cancel">
                  Cancel
                </Button>
              ) : null}
            </>
          )}
        </div>
      </form>
    </div>
  );
}
