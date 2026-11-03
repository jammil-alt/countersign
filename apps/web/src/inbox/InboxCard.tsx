// One inbox item as a card, per kind (ARCHITECTURE §11), shared by the back office's and the
// portal's inboxes. An external action shows the tool, the record and "now / after this change";
// approvals approve or reject; a person's question takes an answer. Resolving calls the surface's
// resolve route (passed in), which resumes the waiting run.
import type { ResolveBody } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { z } from "zod";
import { shortTime } from "../runs/format";
import { Badge, Button, Card, cx, ErrorNotice, type Tone } from "../ui/primitives";
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
  if (item.status === "resolved") return { label: outcome ?? "Resolved", tone: "positive" };
  if (item.kind === "external_action") return { label: "Needs approval", tone: "accent" };
  if (item.kind === "request") return { label: "Needs an answer", tone: "accent" };
  return { label: "Waiting", tone: "accent" };
}

export function InboxCard({
  item,
  context,
  runHref,
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
    <Card testId={testId ?? `inbox-item-${item.id}`} className="overflow-hidden">
      <header className="flex items-start justify-between gap-4 border-b border-edge px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{KIND_LABEL[item.kind] ?? item.kind}</Badge>
            <h3 className="font-semibold text-primary">
              {isChange && toolName ? `${toolName} · ${target ?? item.title}` : item.title}
            </h3>
          </div>
          <p className="mt-1 text-sm text-secondary">
            {[context, shortTime(item.createdAt)].filter(Boolean).join(" · ")}
            {runHref ? (
              <>
                {" · "}
                <Link
                  to={runHref}
                  className="text-link underline"
                  data-testid="inbox-item-run-open"
                >
                  View run
                </Link>
              </>
            ) : null}
          </p>
        </div>
        <Badge tone={badge.tone} testId="inbox-item-status">
          {badge.label}
        </Badge>
      </header>

      {isChange ? (
        <>
          <p className="px-4 pt-3 text-sm text-body">
            {tool ? item.title.replace(` (${tool})`, "") : item.title}
            {tool ? <span className="ml-2 font-mono text-xs text-secondary">{tool}</span> : null}
          </p>
          <ChangeTables before={item.payload.before} input={item.payload.input} />
        </>
      ) : facts.length > 0 ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 px-4 py-3 text-sm">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-secondary">{k}</dt>
              <dd className="break-words text-primary">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {item.kind === "request" && open && onResolve ? (
        <div className="px-4 pb-1 pt-2">
          <label className="block text-sm text-secondary" htmlFor={`answer-${item.id}`}>
            Your answer
          </label>
          <textarea
            id={`answer-${item.id}`}
            data-testid="inbox-item-answer-input"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-sm border border-control bg-card px-3 py-2 text-[15px] text-primary"
          />
        </div>
      ) : null}

      {error ? (
        <div className="px-4 pt-2">
          <ErrorNotice error={error} />
        </div>
      ) : null}

      <footer
        className={cx(
          "flex flex-wrap items-center justify-between gap-3 px-4 py-3",
          (isChange || facts.length > 0) && "border-t border-edge",
        )}
      >
        <p className="text-sm text-secondary">
          {open
            ? onResolve
              ? isChange
                ? "Nothing changes in the tool until you approve."
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
    </Card>
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
    return <span className="text-sm text-secondary">Handled in the requests queue.</span>;
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
        disabled={busy}
        onClick={() => onResolve({ decision: "approve" })}
      >
        {kind === "external_action" && toolName ? `Approve and update ${toolName}` : "Approve"}
      </Button>
    </div>
  );
}
