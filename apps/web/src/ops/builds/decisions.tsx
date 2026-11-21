// Decisions on a build (docs/builder-plan.md §4): every decision the Builder made to get the normal
// case running, beside the issues and known risks. Each says what was decided, why, its starting
// value and its kind; a high-risk one nobody has looked at says "Check" (it holds the client test).
// Owner (2026-11-21): "We can't close these." Each row is closed out where it is: Confirm it, say
// what it should be (the Builder rewrites it), ask about it, or, by its kind, ask each client or
// give it to a person on each run. Undo takes a look back to "Never discussed".

import {
  type BuildDetail,
  DECISION_CATEGORY_WORDS,
  DECISION_KIND_WORDS,
  DECISION_STATUS_WORDS,
  type Decision,
  type DecisionStatus,
  decisionUnreviewed,
} from "@countersign/core";
import { useState } from "react";
import type { CallOptions } from "../../api/client";
import { apiRoutes } from "../../api/routes";
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

type StatusAct = (
  route: typeof apiRoutes.opsBuildDecisionStatus,
  opts: CallOptions<typeof apiRoutes.opsBuildDecisionStatus>,
) => Promise<boolean>;

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
  // The ones to check first, then the first few; the one the conversation is on always shows.
  const rows = useFirstRows(
    [...decisions.filter(decisionUnreviewed), ...decisions.filter((d) => !decisionUnreviewed(d))],
    {
      keep: (d) => `decision:${d.id}` === focus || d.id === changing?.id,
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
