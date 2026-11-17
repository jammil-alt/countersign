// Talking through a build's issues (owner, 2026-11-17): the conversation is on one issue at a time
// (its focus), each Builder message says which issue it is about, and a change the Builder proposes
// is a card to agree or decline. Going back to an issue is a click on its name, on a message or in
// the Issues list; its thread is every message about it, however long ago.

import type { BuildIssue, BuildMessageView } from "@countersign/core";
import { Badge, Button, cx, type Tone } from "../../ui/primitives";

type Proposal = NonNullable<BuildMessageView["proposal"]>;

const PROPOSAL_WORDS: Record<Proposal["state"], { word: string; tone: Tone }> = {
  proposed: { word: "Waiting on you", tone: "warning" },
  agreed: { word: "Agreed and done", tone: "positive" },
  unchanged: { word: "Nothing changed", tone: "neutral" },
  declined: { word: "Not this", tone: "neutral" },
  undone: { word: "Undone", tone: "neutral" },
};

/** The Builder's proposed change: agree it (it's made, as you) or not; an agreed one can be undone. */
export function ProposalCard({
  proposal,
  live,
  busy,
  onDecide,
}: {
  proposal: Proposal;
  /** The build is open: the proposal can still be decided. */
  live: boolean;
  busy: boolean;
  onDecide(decide: "agree" | "decline" | "undo"): void;
}) {
  const words = PROPOSAL_WORDS[proposal.state];
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-line px-3 py-2.5"
      data-testid="build-proposal"
    >
      <p className="text-sm text-ink">
        <span className="text-ink-muted">Proposed: </span>
        {proposal.summary}
      </p>
      {proposal.action.do === "edit_draft" && proposal.state === "proposed" ? (
        <p className="text-xs text-ink-muted" data-testid="build-proposal-request">
          The change to the draft: {proposal.action.request}
        </p>
      ) : null}
      {proposal.result && proposal.state !== "proposed" ? (
        <p className="text-xs text-ink" data-testid="build-proposal-result">
          {proposal.result}
        </p>
      ) : null}
      {proposal.changes?.length ? (
        <details className="text-xs text-ink-muted" data-testid="build-proposal-changes">
          <summary className="cursor-pointer">What changed in the steps</summary>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono">
            {proposal.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {proposal.state === "proposed" && live ? (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => onDecide("agree")}
              data-testid="build-proposal-agree"
            >
              Agree
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => onDecide("decline")}
              data-testid="build-proposal-decline"
            >
              Not this
            </Button>
          </>
        ) : proposal.state === "agreed" && proposal.unresolved ? (
          // QA (2026-11-17): a change that didn't fix its issue never reads as done.
          <Badge tone="warning" testId="build-proposal-state">
            Changed, still open
          </Badge>
        ) : (
          <Badge tone={words.tone} testId="build-proposal-state">
            {words.word}
          </Badge>
        )}
        {proposal.undo && live ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onDecide("undo")}
            data-testid="build-proposal-undo"
          >
            Undo
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Which issue a message is about: a click takes the conversation back to it. */
export function AboutLink({
  issue,
  focused,
  onFocus,
}: {
  issue: BuildIssue;
  focused: boolean;
  onFocus(): void;
}) {
  return (
    <button
      type="button"
      className={cx(
        "self-start rounded-sm border px-2 py-0.5 text-left text-xs",
        focused
          ? "border-slate bg-slate-tint text-ink"
          : "border-line text-ink-muted hover:border-line-strong hover:text-ink",
      )}
      title={focused ? "The issue you're on" : "Go back to this issue"}
      aria-pressed={focused}
      onClick={onFocus}
      data-testid="build-about"
    >
      About: {issue.title}
    </button>
  );
}

/** Above the box: the issue the next message is about, its thread, and a way off it. */
export function FocusBar({
  issue,
  threadOnly,
  onThread,
  onClear,
}: {
  issue: BuildIssue;
  threadOnly: boolean;
  onThread(only: boolean): void;
  onClear(): void;
}) {
  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
      data-testid="build-focus"
    >
      <span className="min-w-0 text-ink">
        <span className="text-ink-muted">About: </span>
        <span className="font-medium">{issue.title}</span>
      </span>
      {issue.talk > 0 ? (
        <button
          type="button"
          className="ds-btn ds-btn--link text-xs"
          onClick={() => onThread(!threadOnly)}
          data-testid="build-focus-thread"
        >
          {threadOnly ? "Show the whole conversation" : "Show only this thread"}
        </button>
      ) : null}
      <button
        type="button"
        className="ds-btn ds-btn--link text-xs"
        onClick={onClear}
        data-testid="build-focus-clear"
      >
        Talk about something else
      </button>
    </div>
  );
}
