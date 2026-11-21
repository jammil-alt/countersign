// A new build's first screen (docs/builder-plan.md §12.5 F5, docs/plan.md §1.170; design:
// docs/design/builder.html `describeHTML`): "What should it do?", its name and the operator's own
// words. Draft the steps starts the build as the lab's New did (`opsStartBuild`, an agent build for
// everyone or one client) and drafts it at once from the words (`opsDraftBuildNow`, §1.165), then
// opens Check the steps over that saved draft. List the steps myself starts the build with no
// draft (draft-now needs words) and opens Check the steps with an empty list. Builds already open
// keep today's page (owner, 2026-11-21).
//
// The name may be left empty (owner, 2026-11-21: "let's create the name of the template with AI
// based on the description… make it editable"): once the words are written it is named from them
// (Draft's `build.name` field, docs/plan.md §1.168), in the Name field, where it can be changed.
// A name someone typed is never replaced.
import { assistRoutes } from "@countersign/core";
import { type ReactNode, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApiClient } from "../../api/useApi";
import { ErrorNotice } from "../../ui/ErrorState";
import { Field, TextArea, TextInput } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Button, cx } from "../../ui/primitives";
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

const STEPS = ["Describe it", "Check the steps", "Build and try"] as const;

/** Where a new build is: 1 Describe it, 2 Check the steps, 3 Build and try (ds-step, in a row). */
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
      await api.call(apiRoutes.opsDraftBuildNow, {
        params: { id },
        body: { description: said },
      });
      navigate(OPS_PATHS.buildCheck(id), { state: { words: said } satisfies CheckStepsState });
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
          someone has to decide. The Builder turns it into steps you check before anything is built.
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
        {error ? <ErrorNotice error={error} /> : null}
        <div className="flex min-h-9 flex-wrap items-center gap-2">
          {busy === "draft" ? (
            <span
              className="flex items-center gap-2 text-sm text-ink-muted"
              role="status"
              data-testid="flow-describe-drafting"
            >
              <span aria-hidden className="size-1.5 rounded-full bg-line-strong" />
              Reading it and drafting the steps
            </span>
          ) : (
            <>
              <Button
                type="submit"
                variant="primary"
                disabled={!canStart || !said || !(title || canName)}
                data-testid="flow-describe-draft"
              >
                Draft the steps
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
