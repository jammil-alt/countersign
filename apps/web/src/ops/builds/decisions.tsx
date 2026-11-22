// Decisions on a build (docs/builder-plan.md §4): every decision the Builder made to get the normal
// case running, beside the issues and known risks. Each says what was decided, why, its starting
// value and its kind; a high-risk one nobody has looked at says "Check" (it holds the client test).
// Owner (2026-11-21): "We can't close these." Each row is closed out where it is: Confirm it, say
// what it should be (the Builder rewrites it), ask about it, or, by its kind, ask each client or
// give it to a person on each run. Undo takes a look back to "Never discussed".
// docs/open.md G4: Edit changes its words here, without the conversation: it is marked changed,
// by the operator, as the Builder's rewrite marks it.

import {
  type BuildDetail,
  DECISION_CATEGORY_WORDS,
  DECISION_KIND_WORDS,
  DECISION_STATUS_WORDS,
  type Decision,
  type DecisionStatus,
  decisionUnreviewed,
} from "@countersign/core";
import { useId, useState } from "react";
import type { CallOptions } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { TextArea, TextInput } from "../../ui/forms";
import { Badge, Button, Card, cx, Tag, type Tone } from "../../ui/primitives";
import type { Voice } from "../../ui/voice";
import { ReplyBox } from "./closeout";
import { type Fold, useFirstRows } from "./fold";
import { ShortText } from "./short";
import { plural, TO_BUILDER } from "./words";

const STATUS_TONE: Record<DecisionStatus, Tone> = {
  never_discussed: "neutral",
  discussed: "accent",
  confirmed: "positive",
  changed: "person",
};

type DecisionRoute =
  | typeof apiRoutes.opsBuildDecisionStatus
  | typeof apiRoutes.opsBuildDecisionWords;
type StatusAct = <R extends DecisionRoute>(route: R, opts: CallOptions<R>) => Promise<boolean>;

/** The words being edited on one row. */
interface Editing {
  id: string;
  what: string;
  value: string;
  why: string;
}

export function DecisionsCard({
  detail,
  focus,
  onTalk,
  onSay,
  voice,
  busy,
  act,
  fold,
}: {
  detail: BuildDetail;
  /** Folds the card (the page keeps it, so its jump link can open it). */
  fold?: Fold | undefined;
  /** The issue the conversation is on (`decision:<id>` for a decision). */
  focus: string | null;
  /** Puts the conversation on a decision. */
  onTalk?: ((key: string) => void) | undefined;
  /** Says something to the Builder about a decision (`decision:<id>`), as the conversation does. */
  onSay?: ((text: string, key: string) => Promise<boolean>) | undefined;
  /** Dictation for the "Change it" box. */
  voice?: Voice | undefined;
  busy: boolean;
  act: StatusAct;
}) {
  const id = detail.build.id;
  const decisions = detail.build.fitgap.decisions;
  const editable = detail.build.status === "open";
  const high = decisions.filter((d) => d.risk === "high").length;
  const toCheck = decisions.filter(decisionUnreviewed).length;
  // The one "Change it" box open (its decision's id) and its words.
  const [changing, setChanging] = useState<{ id: string; text: string } | null>(null);
  // The one row whose words are being edited here (docs/open.md G4).
  const [editing, setEditing] = useState<Editing | null>(null);
  const formId = useId();
  // The ones to check first, then the first few; the one the conversation is on always shows.
  const rows = useFirstRows(
    [...decisions.filter(decisionUnreviewed), ...decisions.filter((d) => !decisionUnreviewed(d))],
    {
      keep: (d) => `decision:${d.id}` === focus || d.id === changing?.id || d.id === editing?.id,
      noun: "decisions",
      testId: "build-decisions-more",
    },
  );
  // Acting on a row keeps the card open, though its last check is done (its default is shut).
  const setStatus = (d: Decision, status: "never_discussed" | "discussed" | "confirmed") => {
    fold?.hold();
    return act(apiRoutes.opsBuildDecisionStatus, {
      params: { id, decisionId: d.id },
      body: { status },
    });
  };
  /**
   * Words to the Builder in the decision's thread. One nobody had looked at is marked discussed
   * first, so the Builder's rewrite of it reads as "Changed" (core `mergeDecisions`).
   */
  // DECISION (owner, 2026-11-21): asking the Builder to change a decision is a look at it, so a
  // never-discussed row is marked discussed before the words go; Ask about it marks nothing.
  const toBuilder = async (d: Decision, text: string): Promise<boolean> => {
    if (!onSay) return false;
    fold?.hold();
    if (d.status === "never_discussed" && !(await setStatus(d, "discussed"))) return false;
    return onSay(text, `decision:${d.id}`);
  };
  const saveWords = async (e: Editing) => {
    fold?.hold();
    const done = await act(apiRoutes.opsBuildDecisionWords, {
      params: { id, decisionId: e.id },
      body: { what: e.what.trim(), why: e.why.trim(), value: e.value.trim() || null },
    });
    if (done) setEditing(null);
  };
  const change = async (d: Decision, typed: string) => {
    setChanging(null);
    if (!(await toBuilder(d, TO_BUILDER.change(d.what, typed))))
      setChanging((now) => now ?? { id: d.id, text: typed });
  };
  return (
    <Card
      testId="build-decisions"
      title="Decisions"
      fold={fold}
      meta={
        <span className="flex flex-wrap items-center gap-1.5" data-testid="build-decisions-meta">
          <Badge tone="neutral">{plural(decisions.length, "decision")}</Badge>
          {high > 0 ? <Badge tone="neutral">{high} high risk</Badge> : null}
          {toCheck > 0 ? <Badge tone="warning">{toCheck} to check</Badge> : null}
        </span>
      }
    >
      {decisions.length === 0 ? (
        <p className="px-6 py-5 text-sm text-ink-muted">
          No decisions yet. The Builder writes down each one it makes from the fit-gap on.
        </p>
      ) : (
        <>
          <ul className="flex flex-col" aria-label="Decisions">
            {rows.shown.map((d) => {
              const key = `decision:${d.id}`;
              const check = decisionUnreviewed(d);
              const looked = d.status === "confirmed" || d.status === "discussed";
              const say = editable ? onSay : undefined;
              return (
                <li
                  key={d.id}
                  className={cx(
                    "flex min-w-0 flex-col gap-1.5 border-b border-line px-4 py-3 last:border-b-0 sm:px-5",
                    focus === key && "bg-slate-tint",
                  )}
                  data-testid={`build-decision-${d.id}`}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    {check ? (
                      <Badge tone="warning" testId={`build-decision-${d.id}-check`}>
                        Check
                      </Badge>
                    ) : d.risk === "high" ? (
                      <Tag>High risk</Tag>
                    ) : null}
                    <span className="min-w-0 font-medium break-words text-ink">{d.what}</span>
                  </span>
                  {d.value ? (
                    <p className="text-sm break-words text-ink">
                      <span className="text-ink-muted">Starts at: </span>
                      {d.value}
                    </p>
                  ) : null}
                  {d.why ? <ShortText text={d.why} className="text-sm text-ink-muted" /> : null}
                  {d.risk === "high" && d.category ? (
                    <p className="text-xs text-ink-muted">
                      High risk: {DECISION_CATEGORY_WORDS[d.category].toLowerCase()}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
                    <Tag tone={d.kind === "decision_point" ? "person" : "neutral"}>
                      {DECISION_KIND_WORDS[d.kind]}
                    </Tag>
                    <Badge tone={STATUS_TONE[d.status]} testId={`build-decision-${d.id}-status`}>
                      {DECISION_STATUS_WORDS[d.status]}
                    </Badge>
                    {d.by && d.status !== "never_discussed" ? <span>By {d.by}</span> : null}
                    {editable && looked ? (
                      <button
                        type="button"
                        className="ds-btn ds-btn--link text-xs"
                        disabled={busy}
                        onClick={() => void setStatus(d, "never_discussed")}
                        data-testid={`build-decision-${d.id}-undo`}
                      >
                        Undo
                      </button>
                    ) : null}
                  </div>
                  {editable ? (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span className="flex flex-wrap items-center gap-2">
                        {d.status === "confirmed" ? null : (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => void setStatus(d, "confirmed")}
                            data-testid={`build-decision-${d.id}-confirm`}
                          >
                            Confirm
                          </Button>
                        )}
                        {editing?.id !== d.id ? (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              setChanging(null);
                              setEditing({
                                id: d.id,
                                what: d.what,
                                value: d.value ?? "",
                                why: d.why,
                              });
                            }}
                            data-testid={`build-decision-${d.id}-edit`}
                          >
                            Edit
                          </Button>
                        ) : null}
                        {say && changing?.id !== d.id ? (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => setChanging({ id: d.id, text: "" })}
                            data-testid={`build-decision-${d.id}-change`}
                          >
                            Change it…
                          </Button>
                        ) : null}
                        {say && d.kind === "client_setup" ? (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => void toBuilder(d, TO_BUILDER.askEachClient(d.what))}
                            data-testid={`build-decision-${d.id}-each-client`}
                          >
                            Ask each client
                          </Button>
                        ) : null}
                        {say && d.kind === "decision_point" ? (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => void toBuilder(d, TO_BUILDER.personDecides(d.what))}
                            data-testid={`build-decision-${d.id}-person`}
                          >
                            A person decides each run
                          </Button>
                        ) : null}
                      </span>
                      {onTalk ? (
                        <button
                          type="button"
                          className="ds-btn ds-btn--link text-xs"
                          aria-pressed={focus === key}
                          onClick={() => onTalk(key)}
                          data-testid={`build-decision-${d.id}-ask`}
                        >
                          {focus === key ? "Talking about it" : "Ask about it"}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {editing?.id === d.id ? (
                    <form
                      className="flex flex-col gap-2 rounded-md border border-line bg-surface-subtle px-3 py-2.5"
                      data-testid={`build-decision-${d.id}-edit-form`}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveWords(editing);
                      }}
                    >
                      <label
                        className="flex flex-col gap-1 text-sm"
                        htmlFor={`${formId}-${d.id}-what`}
                      >
                        <span className="text-ink-muted">The decision</span>
                        <TextArea
                          rows={2}
                          maxLength={300}
                          value={editing.what}
                          onChange={(e) => setEditing({ ...editing, what: e.target.value })}
                          id={`${formId}-${d.id}-what`}
                          data-testid={`build-decision-${d.id}-edit-what`}
                        />
                      </label>
                      <label
                        className="flex flex-col gap-1 text-sm"
                        htmlFor={`${formId}-${d.id}-value`}
                      >
                        <span className="text-ink-muted">Starts at (optional)</span>
                        <TextInput
                          maxLength={300}
                          value={editing.value}
                          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                          id={`${formId}-${d.id}-value`}
                          data-testid={`build-decision-${d.id}-edit-value`}
                        />
                      </label>
                      <label
                        className="flex flex-col gap-1 text-sm"
                        htmlFor={`${formId}-${d.id}-why`}
                      >
                        <span className="text-ink-muted">Why</span>
                        <TextArea
                          rows={2}
                          maxLength={500}
                          value={editing.why}
                          onChange={(e) => setEditing({ ...editing, why: e.target.value })}
                          id={`${formId}-${d.id}-why`}
                          data-testid={`build-decision-${d.id}-edit-why`}
                        />
                      </label>
                      <p className="text-xs text-ink-muted">
                        Saved as changed by you. The Builder follows the new words from its next
                        turn.
                      </p>
                      <span className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="primary"
                          type="submit"
                          disabled={busy || editing.what.trim() === ""}
                          data-testid={`build-decision-${d.id}-edit-save`}
                        >
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditing(null)}
                          data-testid={`build-decision-${d.id}-edit-cancel`}
                        >
                          Cancel
                        </Button>
                      </span>
                    </form>
                  ) : null}
                  {changing?.id === d.id ? (
                    <ReplyBox
                      label={`What should it be: ${d.what}`}
                      placeholder="What should it be? The Builder rewrites the decision."
                      send="Send"
                      value={changing.text}
                      onChange={(text) => setChanging({ id: d.id, text })}
                      onSend={(text) => void change(d, text)}
                      onCancel={() => setChanging(null)}
                      voice={voice}
                      busy={busy}
                      testId={`build-decision-${d.id}-change-box`}
                      assist={{
                        field: "build.decision.change",
                        ref: `decision:${d.id}`,
                        context: {
                          buildId: id,
                          clientId: detail.build.client?.id ?? detail.build.testClient?.id,
                        },
                      }}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
          {rows.more}
        </>
      )}
    </Card>
  );
}
