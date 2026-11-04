// One inbox item as a card, per kind (ARCHITECTURE §11), shared by the back office's and the
// portal's inboxes. An external action shows the tool, the record and "now / after this change";
// approvals approve or reject; a person's question takes an answer. Resolving calls the surface's
// resolve route (passed in), which resumes the waiting run.
import type { ResolveBody } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { z } from "zod";
import { SourceLinks } from "../records/SourceLinks";
import { shortTime } from "../runs/format";
import { Icon } from "../ui/icons";
import { Badge, Button, ErrorNotice, Tag, type Tone } from "../ui/primitives";
import { ChangeTables } from "./ChangePanel";
import { changeTarget, connectorName, connectorOf, fieldLabel, formatValue } from "./change";

export type ResolveInput = z.input<typeof ResolveBody>;

export interface InboxCardItem {
  id: string;
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  status: string;
  runId: string | null;
  dueAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

const KIND_LABEL: Record<string, string> = {
  external_action: "Change",
  approval: "Approval",
  request: "Question",
  review: "Review",
  extraction_review: "Check",
  change_request: "Request",
};

/** Payload keys that are plumbing, not something a person reads. */
const PLUMBING = new Set([
  // Shown as Receipts that open their record pages.
  "sources",
  "tool",
  "verb",
  "connector",
  "connectionId",
  "input",
  "before",
  "stepId",
  "onReject",
  "actionId",
  "escalated",
  "nodeId",
  "mode",
  "testRun",
]);

/** "Approved by Ana", "Answered", "Declined by Ben": how an item was resolved. */
export function outcomeText(
  kind: string,
  approved: boolean | null | undefined,
  byName: string | null | undefined,
): string {
  const verb =
    kind === "request"
      ? approved === false
        ? "Declined"
        : "Answered"
      : approved === true
        ? "Approved"
        : approved === false
          ? "Rejected"
          : "Resolved";
  return byName ? `${verb} by ${byName}` : verb;
}

/** What the run asked a person, as label/value pairs (free-form payloads of person steps). */
export function payloadFacts(payload: Record<string, unknown>): [string, string][] {
  return Object.entries(payload)
    .filter(([k, v]) => !PLUMBING.has(k) && v !== undefined)
    .map(([k, v]) => [fieldLabel(k), formatValue(v)]);
}

function statusBadge(item: InboxCardItem, outcome: string | null): { label: string; tone: Tone } {
  if (item.status === "expired") return { label: "Expired", tone: "neutral" };
  // Resolved by a person (approved, answered): copper; rejected or declined stays neutral.
  if (item.status === "resolved") {
    const declined = /^(Rejected|Declined)/.test(outcome ?? "");
    return { label: outcome ?? "Resolved", tone: declined ? "neutral" : "person" };
  }
  // Open items wait on you: signal, with a word.
  if (item.kind === "external_action") return { label: "Needs approval", tone: "warning" };
  if (item.kind === "request") return { label: "Needs an answer", tone: "warning" };
  return { label: "Waiting", tone: "warning" };
}

export function InboxCard({
  item,
  context,
  runHref,
  recordHref,
  connectorNames,
  onResolve,
  waitingOn,
  outcome,
  testId,
}: {
  item: InboxCardItem;
  /** "Record keeping · Client A": who asks, for whom. */
  context?: string | null;
  runHref?: string | null;
  /** The record page for a source id (payload `sources`, invariant 10), in this surface. */
  recordHref?: ((id: string) => string) | null;
  connectorNames?: Record<string, string>;
  /** Null when this person can't resolve it (it is someone else's), or it is not open. */
  onResolve: ((body: ResolveInput) => Promise<void>) | null;
  /** Why there are no buttons on an open item ("Waiting on the client admin"). */
  waitingOn?: string | null;
  /** How it was resolved ("Approved by Ana"). */
  outcome?: string | null;
  testId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [answer, setAnswer] = useState("");
  const open = item.status === "open";
  const badge = statusBadge(item, outcome ?? null);
  const isChange = item.kind === "external_action";
  const tool = typeof item.payload.tool === "string" ? item.payload.tool : null;
  const connector =
    typeof item.payload.connector === "string"
      ? item.payload.connector
      : tool
        ? connectorOf(tool)
        : null;
  const toolName = connector ? connectorName(connector, connectorNames) : null;
  const target = isChange ? changeTarget(item.payload.before, item.payload.input) : null;
  const facts = isChange ? [] : payloadFacts(item.payload);
  const sources = Array.isArray(item.payload.sources)
    ? item.payload.sources.filter((x): x is string => typeof x === "string")
    : [];

  async function resolve(body: ResolveInput) {
    if (!onResolve) return;
    setBusy(true);
    setError(null);
    try {
      await onResolve(body);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    // The Mezonas SignCard (mz-sign): one decision per card, what changes before and after, the
    // run behind it as a Receipt, then the decision.
    <article data-testid={testId ?? `inbox-item-${item.id}`} className="mz-sign">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={badge.tone} testId="inbox-item-status">
            {badge.label}
          </Badge>
          <Tag>{KIND_LABEL[item.kind] ?? item.kind}</Tag>
        </div>
        <span className="text-sm text-ink-muted">
          {[context, shortTime(item.createdAt)].filter(Boolean).join(" · ")}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="mz-sign__title text-lg leading-6 font-medium">
          {isChange && toolName ? `${toolName} · ${target ?? item.title}` : item.title}
        </h3>
        {isChange ? (
          <p className="text-sm text-ink-muted">
            {tool ? item.title.replace(` (${tool})`, "") : item.title}
            {tool ? <span className="ml-2 reference">{tool}</span> : null}
          </p>
        ) : null}
      </div>

      {isChange ? (
        <ChangeTables before={item.payload.before} input={item.payload.input} />
      ) : facts.length > 0 ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ink-muted">{k}</dt>
              <dd className="break-words text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {item.kind === "request" && open && onResolve ? (
        <label className="ds-field" htmlFor={`answer-${item.id}`}>
          <span className="text-sm font-medium text-ink">Your answer</span>
          <textarea
            id={`answer-${item.id}`}
            data-testid="inbox-item-answer-input"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={2}
            className="ds-textarea text-base"
          />
        </label>
      ) : null}

      {runHref || (recordHref && sources.length > 0) ? (
        <div className="mz-sign__receipts">
          {runHref ? (
            <Link to={runHref} className="mz-receipt" data-testid="inbox-item-run-open">
              <Icon name="worksheet" size={14} className="ds-icon" />
              View run
            </Link>
          ) : null}
          {recordHref ? (
            <SourceLinks ids={sources} href={recordHref} testId="inbox-item-sources" />
          ) : null}
        </div>
      ) : null}

      {error ? <ErrorNotice error={error} /> : null}

      <footer className="mz-sign__foot">
        <p className="text-sm text-ink-muted">
          {open
            ? onResolve
              ? isChange
                ? "Nothing changes in the tool until you sign."
                : item.dueAt
                  ? `Waits until ${shortTime(item.dueAt)}.`
                  : null
              : (waitingOn ?? null)
            : outcome
              ? `${outcome}${item.resolvedAt ? ` · ${shortTime(item.resolvedAt)}` : ""}`
              : null}
        </p>
        {open && onResolve ? (
          <Actions
            kind={item.kind}
            busy={busy}
            toolName={toolName}
            answer={answer}
            onResolve={(b) => void resolve(b)}
          />
        ) : null}
      </footer>
    </article>
  );
}

function Actions({
  kind,
  busy,
  toolName,
  answer,
  onResolve,
}: {
  kind: string;
  busy: boolean;
  toolName: string | null;
  answer: string;
  onResolve: (body: ResolveInput) => void;
}) {
  if (kind === "change_request") {
    return <span className="text-sm text-ink-muted">Handled in the requests queue.</span>;
  }
  if (kind === "request") {
    return (
      <div className="flex gap-2">
        <Button
          data-testid="inbox-item-decline"
          variant="ghost"
          disabled={busy}
          onClick={() => onResolve({ decision: "reject" })}
        >
          Decline
        </Button>
        <Button
          data-testid="inbox-item-answer-send"
          variant="primary"
          disabled={busy || answer.trim().length === 0}
          onClick={() => onResolve({ decision: "approve", answer: answer.trim() })}
        >
          Send answer
        </Button>
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <Button
        data-testid="inbox-item-reject"
        variant="ghost"
        disabled={busy}
        onClick={() => onResolve({ decision: "reject" })}
      >
        Reject
      </Button>
      <Button
        data-testid="inbox-item-approve"
        variant="primary"
        className="font-semibold"
        disabled={busy}
        onClick={() => onResolve({ decision: "approve" })}
      >
        {/* Approving an action is always "Sign" (brand book). */}
        {kind === "external_action" && toolName ? `Sign and update ${toolName}` : "Sign"}
      </Button>
    </div>
  );
}
