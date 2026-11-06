// One inbox item as a card, per kind (ARCHITECTURE §11), shared by the back office's and the
// portal's inboxes. An external action shows the tool, the record and "now / after this change";
// approvals approve or reject; a person's question takes an answer. Resolving calls the surface's
// resolve route (passed in), which resumes the waiting run.
import {
  type ChangeDisplayView,
  DirectorySuggestionChange,
  isPlainObject,
  type Locale,
  type LocalizedText,
  pickLocalized,
  type ResolveBody,
} from "@countersign/core";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import type { z } from "zod";
import { directoryFieldName, directoryValue } from "../directory/DirectoryPanel";
import type { PlainKey } from "../i18n/catalog";
import { EN, type I18n, useI18n } from "../i18n/i18n";
import { SourceLinks } from "../records/SourceLinks";
import { shortTime } from "../runs/format";
import { Icon } from "../ui/icons";
import { Badge, Button, ErrorNotice, Tag, type Tone } from "../ui/primitives";
import { ChangeTables } from "./ChangePanel";
import { changeHeading, connectorName, connectorOf, fieldLabel, formatValue } from "./change";

export type ResolveInput = z.input<typeof ResolveBody>;

export interface InboxCardItem {
  id: string;
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  /** An external action's card: the connector's name and the tool's display (from the API). */
  display?: ChangeDisplayView | null | undefined;
  status: string;
  runId: string | null;
  dueAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
  /** v0.12 W1-D: approved and inside its undo window until then. */
  deliverAfter?: string | null | undefined;
}

/** v0.12 W1-D: a question's quick answers (`payload.choices`), or null. */
function quickAnswers(
  payload: Record<string, unknown>,
  locale: Locale,
): { value: string; label: string }[] | null {
  const raw = payload.choices;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: { value: string; label: string }[] = [];
  for (const c of raw) {
    if (typeof c !== "object" || c === null) return null;
    const { value, label } = c as { value?: unknown; label?: unknown };
    if (typeof value !== "string") return null;
    const text =
      typeof label === "string" || (typeof label === "object" && label !== null)
        ? pickLocalized(label as LocalizedText, locale)
        : value;
    out.push({ value, label: text });
  }
  return out;
}

const KIND_LABEL: Record<string, PlainKey> = {
  external_action: "inbox.kind.external_action",
  approval: "inbox.kind.approval",
  request: "inbox.kind.request",
  review: "inbox.kind.review",
  extraction_review: "inbox.kind.extraction_review",
  change_request: "inbox.kind.change_request",
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
  "accessRelease",
  // A finding's fingerprint and its state (docs/plan.md §1.28): the steps show as a list.
  "fingerprint",
  "finding",
]);

/** A finding's plain steps for the client admin (`payload.finding.steps`), if it has them. */
export function findingSteps(payload: Record<string, unknown>): string[] | null {
  const f = payload.finding;
  if (typeof f !== "object" || f === null) return null;
  const steps = (f as { steps?: unknown }).steps;
  return Array.isArray(steps) ? steps.filter((x): x is string => typeof x === "string") : null;
}

/** An item about an issue the supervisor keeps (it carries a fingerprint): resolved with "Done". */
function isFinding(item: InboxCardItem): boolean {
  return typeof item.payload.fingerprint === "string" && item.kind === "review";
}

/** "Approved by Ana", "Answered", "Declined by Ben": how an item was resolved. */
export function outcomeText(
  kind: string,
  approved: boolean | null | undefined,
  byName: string | null | undefined,
  { t }: Pick<I18n, "t"> = EN,
): string {
  const verb =
    kind === "request"
      ? approved === false
        ? "declined"
        : "answered"
      : approved === true
        ? "approved"
        : approved === false
          ? "rejected"
          : "resolved";
  if (!byName) return t(`inbox.outcome.${verb}`);
  return t(`inbox.outcome.${verb}By`, { name: byName });
}

/** What the run asked a person, as label/value pairs (free-form payloads of person steps). */
export function payloadFacts(payload: Record<string, unknown>): [string, string][] {
  return Object.entries(payload)
    .filter(([k, v]) => !PLUMBING.has(k) && v !== undefined)
    .map(([k, v]) => [fieldLabel(k), formatValue(v)]);
}

/**
 * An agent's directory suggestion (plan §1.27) in plain words: why, and each field it would set.
 * What the agent wrote is data, shown as text.
 */
function suggestionFacts(payload: Record<string, unknown>, i18n: I18n): [string, string][] | null {
  const s = payload.directorySuggestion;
  if (!isPlainObject(s)) return null;
  const change = DirectorySuggestionChange.safeParse(s.change);
  if (!change.success) return null;
  const c = change.data;
  const fields =
    c.action === "add_person"
      ? c.person
      : c.action === "add_organization"
        ? c.organization
        : c.changes;
  const facts: [string, string][] = [];
  if (typeof s.reason === "string") facts.push([i18n.t("directory.suggestions.why"), s.reason]);
  for (const [k, v] of Object.entries(fields)) {
    facts.push([directoryFieldName(k, i18n), directoryValue(v, i18n)]);
  }
  if (s.changesAddress === true) {
    facts.push([
      i18n.t("directory.import.changesAddress"),
      i18n.t("directory.suggestions.address"),
    ]);
  }
  return facts;
}

function statusBadge(
  item: InboxCardItem,
  outcome: string | null,
  { t }: Pick<I18n, "t">,
): { label: string; tone: Tone } {
  if (item.status === "expired") return { label: t("common.expired"), tone: "neutral" };
  // Resolved by a person (approved, answered): copper; rejected or declined stays neutral.
  if (item.status === "resolved") {
    // The outcome is outcomeText's: "Rejected by Ana" starts with "Rejected" in every language
    // (the message files keep the "…By" forms starting with the plain word).
    const declined = [t("inbox.outcome.rejected"), t("inbox.outcome.declined")].some((w) =>
      (outcome ?? "").startsWith(w),
    );
    return { label: outcome ?? t("inbox.outcome.resolved"), tone: declined ? "neutral" : "person" };
  }
  // Open items wait on you: signal, with a word.
  if (item.kind === "external_action") {
    return { label: t("inbox.status.needsApproval"), tone: "warning" };
  }
  if (typeof item.payload.accessRelease === "object" && item.payload.accessRelease !== null) {
    return { label: t("release.needsCode"), tone: "warning" };
  }
  if (item.kind === "request") return { label: t("inbox.status.needsAnswer"), tone: "warning" };
  return { label: t("common.waiting"), tone: "warning" };
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
  renderRelease,
  showToolId,
  testId,
  onUndo,
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
  /**
   * A request for a human release code (docs/plan.md §1.26) is answered only with the code, never
   * by a click: the surface that lets its person enter one renders it here.
   */
  renderRelease?: ((item: InboxCardItem) => ReactNode) | null;
  /** The back office names the tool by its id as well; clients never see tool ids. */
  showToolId?: boolean;
  testId?: string;
  /** v0.12 W1-D: takes back an approval inside its undo window; null where nobody may. */
  onUndo?: (() => Promise<void>) | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [answer, setAnswer] = useState("");
  const i18n = useI18n();
  const { t } = i18n;
  const open = item.status === "open";
  const choices = item.kind === "request" ? quickAnswers(item.payload, i18n.locale) : null;
  const undoable =
    !open &&
    !!onUndo &&
    !!item.deliverAfter &&
    new Date(item.deliverAfter).getTime() > Date.now();
  const badge = statusBadge(item, outcome ?? null, i18n);
  const isChange = item.kind === "external_action";
  const isRelease =
    typeof item.payload.accessRelease === "object" && item.payload.accessRelease !== null;
  const tool = typeof item.payload.tool === "string" ? item.payload.tool : null;
  const connector =
    typeof item.payload.connector === "string"
      ? item.payload.connector
      : tool
        ? connectorOf(tool)
        : null;
  // The connector by its name ("QuickBooks"): from the API's display, else the names passed in.
  const toolName = item.display?.connectorName
    ? item.display.connectorName
    : connector
      ? connectorName(connector, connectorNames)
      : null;
  const heading =
    isChange && tool
      ? changeHeading(
          toolName ? { connectorName: toolName, tool: item.display?.tool ?? null } : null,
          tool,
          item.payload.before,
          item.payload.input,
          i18n.locale,
        )
      : null;
  const facts = isChange ? [] : (suggestionFacts(item.payload, i18n) ?? payloadFacts(item.payload));
  const steps = findingSteps(item.payload);
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
          <Tag>{KIND_LABEL[item.kind] ? t(KIND_LABEL[item.kind] as PlainKey) : item.kind}</Tag>
        </div>
        <span className="text-sm text-ink-muted">
          {[context, shortTime(item.createdAt, undefined, i18n)].filter(Boolean).join(" · ")}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="mz-sign__title text-lg leading-6 font-medium">
          {heading ? heading.title : item.title}
        </h3>
        {isChange ? (
          <p className="text-sm text-ink-muted" data-testid="inbox-item-description">
            {heading?.description ?? (tool ? item.title.replace(` (${tool})`, "") : item.title)}
            {tool && showToolId ? <span className="ml-2 reference">{tool}</span> : null}
          </p>
        ) : null}
      </div>

      {isChange ? (
        <ChangeTables
          before={item.payload.before}
          input={item.payload.input}
          display={item.display?.tool}
        />
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

      {steps && steps.length > 0 ? (
        <div className="flex flex-col gap-1.5" data-testid="inbox-item-steps">
          <span className="text-sm font-medium text-ink">{t("inbox.findingSteps")}</span>
          <ol className="list-decimal flex flex-col gap-1 pl-5 text-ink">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}

      {isRelease && open && renderRelease ? renderRelease(item) : null}

      {item.kind === "request" && open && onResolve && !isRelease && !choices ? (
        <label className="ds-field" htmlFor={`answer-${item.id}`}>
          <span className="text-sm font-medium text-ink">{t("inbox.yourAnswer")}</span>
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
              {t("inbox.viewRun")}
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
                ? t("inbox.nothingChangesUntilSign")
                : item.dueAt
                  ? t("inbox.waitsUntil", { time: shortTime(item.dueAt, undefined, i18n) })
                  : null
              : (waitingOn ?? null)
            : outcome
              ? `${outcome}${item.resolvedAt ? ` · ${shortTime(item.resolvedAt, undefined, i18n)}` : ""}`
              : null}
        </p>
        {undoable ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-ink-muted">{t("inbox.undoWindow")}</span>
            <Button
              data-testid="inbox-item-undo"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (!onUndo) return;
                setBusy(true);
                setError(null);
                onUndo()
                  .catch(setError)
                  .finally(() => setBusy(false));
              }}
            >
              {t("inbox.undo")}
            </Button>
          </div>
        ) : null}
        {open && onResolve && !isRelease && choices ? (
          <div className="flex flex-wrap gap-2" data-testid="inbox-item-choices">
            {choices.map((c) => (
              <Button
                key={c.value}
                data-testid={`inbox-item-choice-${c.value}`}
                variant="primary"
                disabled={busy}
                onClick={() => void resolve({ decision: "approve", answer: c.value })}
              >
                {c.label}
              </Button>
            ))}
          </div>
        ) : open && onResolve && !isRelease ? (
          <Actions
            kind={item.kind}
            finding={isFinding(item)}
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
  finding,
  busy,
  toolName,
  answer,
  onResolve,
}: {
  kind: string;
  /** A supervisor finding: one "Done" once the person has taken the steps. */
  finding: boolean;
  busy: boolean;
  toolName: string | null;
  answer: string;
  onResolve: (body: ResolveInput) => void;
}) {
  const { t } = useI18n();
  if (kind === "change_request") {
    return (
      <Link to="/ops/requests" className="text-sm text-link underline">
        {t("inbox.openRequestsQueue")}
      </Link>
    );
  }
  if (finding) {
    return (
      <Button
        data-testid="inbox-item-done"
        variant="primary"
        disabled={busy}
        onClick={() => onResolve({ decision: "approve" })}
      >
        {t("inbox.findingDone")}
      </Button>
    );
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
          {t("inbox.decline")}
        </Button>
        <Button
          data-testid="inbox-item-answer-send"
          variant="primary"
          disabled={busy || answer.trim().length === 0}
          onClick={() => onResolve({ decision: "approve", answer: answer.trim() })}
        >
          {t("inbox.sendAnswer")}
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
        {t("inbox.reject")}
      </Button>
      <Button
        data-testid="inbox-item-approve"
        variant="primary"
        className="font-semibold"
        disabled={busy}
        onClick={() => onResolve({ decision: "approve" })}
      >
        {/* Approving an action is always "Sign" (brand book). */}
        {kind === "external_action" && toolName
          ? t("inbox.signAndUpdate", { tool: toolName })
          : t("inbox.sign")}
      </Button>
    </div>
  );
}
