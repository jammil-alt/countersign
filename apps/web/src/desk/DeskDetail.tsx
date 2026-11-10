// The Desk's open item (docs/design/prototype.html `#C3-Desk`, the SignCard on the right): what the
// agent asks, what changes before and after, the receipts, then the decision: Not now, Reject,
// Edit, Sign (or the answer, the code, "Done"). A batch (one step's changes) is signed together or
// in part. After a signature the card stays, with Undo while the undo window lasts. Every decision
// goes through the API's own routes; the screen never signs by itself (invariant 8).
import {
  EDITABLE_KINDS,
  isPlainObject,
  type LocalizedText,
  pickLocalized,
  type ToolDisplay,
} from "@countersign/core";
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApiClient } from "../api/useApi";
import type { PlainKey } from "../i18n/catalog";
import { type I18n, useI18n } from "../i18n/i18n";
import { ChangeTables } from "../inbox/ChangePanel";
import { changeHeading, connectorName, connectorOf } from "../inbox/change";
import {
  accountChangeFacts,
  findingSteps,
  isAccountChangeItem,
  payloadFacts,
  quickAnswers,
  type ResolveInput,
  suggestionFacts,
} from "../inbox/InboxCard";
import { LateAnswer } from "../inbox/LateAnswer";
import { packReviewCard } from "../packs/reviews";
import { PORTAL_PATHS } from "../portal/paths";
import { ReleaseCodeEntry } from "../portal/screens/AccessRelease";
import { SourceLinks } from "../records/SourceLinks";
import { BeforeAfter } from "../ui/activity";
import { AgentBadge } from "../ui/badges";
import { Field, TextArea, TextInput } from "../ui/forms";
import { Icon } from "../ui/icons";
import { Button, cx, ErrorNotice } from "../ui/primitives";
import { StatusChip } from "../ui/status";
import {
  type DeskEntry,
  type DeskItem,
  isBatch,
  isSnoozed,
  needOf,
  signedInput,
  snoozeTimes,
  undoable,
  undoLeft,
  withState,
} from "./model";
import { DeskWorksheet } from "./Worksheet";

/** What this person did on the card, for its words after ("Approved by you"). */
type Decision = "signed" | "rejected" | "answered" | "declined" | "done" | "snoozed";

/** Payload keys the Desk shows in its own way, never as a raw fact. */
const DESK_PLUMBING = new Set([
  "whyApproval",
  "edited",
  "choices",
  "undos",
  "snoozes",
  "directorySuggestion",
  "accountChange",
  "accessRelease",
]);

export function DeskDetail({
  entry,
  canSign,
  onChanged,
}: {
  entry: DeskEntry;
  /** False for a viewer: they see the card, never its buttons (the API refuses them too). */
  canSign: boolean;
  /** After any action: the lists and the shell's Desk count reload. */
  onChanged: () => void;
}) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const api = useApiClient();
  const [items, setItems] = useState(entry.items);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState("");
  // A batch: which of its changes the person is signing (all, to begin with).
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(entry.items.map((i) => i.id)));
  const now = useNow(items.some((i) => undoable(i, Date.now())));

  const lead = items[0] as DeskItem;
  const batch = isBatch({ key: entry.key, items });
  const open = items.some((i) => i.status === "open");
  const need = needOf(lead);
  // A pack's review (e.g. the Materials match review) brings its own card and its own finish.
  const ReviewCard = lead.kind === "external_action" ? null : packReviewCard(lead.payload);
  const agent = lead.service?.name ?? null;
  const tool = typeof lead.payload.tool === "string" ? lead.payload.tool : null;
  const toolName = lead.display?.connectorName ?? (tool ? connectorName(connectorOf(tool)) : null);
  const heading = (item: DeskItem) =>
    item.kind === "external_action" && typeof item.payload.tool === "string"
      ? changeHeading(
          item.display ?? null,
          item.payload.tool,
          item.payload.before,
          signedInput(item.payload),
          i18n.locale,
        )
      : null;
  const leadHeading = heading(lead);
  const title = batch
    ? t("desk.batch.title", { count: items.length, what: leadHeading?.connector ?? lead.title })
    : (leadHeading?.title ?? lead.title);
  const snoozedNow = open && isSnoozed(lead, now);
  const inWindow = items.filter((i) => undoable(i, now));
  // A decision was made here (a batch may keep open items: they wait as their own entries).
  const settled = decision !== null && decision !== "snoozed";

  async function act(run: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const resolveOne = (body: ResolveInput, after: Decision) =>
    act(async () => {
      if (isAccountChangeItem(lead)) {
        await api.call(apiRoutes.portalResolveAccountChange, {
          params: { id: lead.id },
          body: {
            decision: body.decision ?? "approve",
            ...(body.note ? { note: body.note } : {}),
          },
        });
        setItems([{ ...lead, status: "resolved", resolvedAt: new Date().toISOString() }]);
      } else {
        const res = await api.call(apiRoutes.portalResolveInbox, {
          params: { id: lead.id },
          body,
        });
        setItems([res.item]);
      }
      setDecision(after);
    });

  const resolveBatch = (decide: "approve" | "reject") =>
    act(async () => {
      const ids = items.filter((i) => ticked.has(i.id) && i.status === "open").map((i) => i.id);
      const res = await api.call(apiRoutes.portalBatchResolve, {
        body: {
          batchKey: lead.batchKey as string,
          approve: decide === "approve" ? ids : [],
          reject: decide === "reject" ? ids : [],
        },
      });
      const states = new Map(res.items.map((s) => [s.id, s]));
      setItems((cur) =>
        cur.map((i) => {
          const s = states.get(i.id);
          return s ? withState(i, s) : i;
        }),
      );
      setDecision(decide === "approve" ? "signed" : "rejected");
    });

  const snooze = (until: Date) =>
    act(async () => {
      const states = await Promise.all(
        items
          .filter((i) => i.status === "open")
          .map((i) =>
            api.call(apiRoutes.portalSnoozeInbox, {
              params: { id: i.id },
              body: { until: until.toISOString() },
            }),
          ),
      );
      const byId = new Map(states.map((s) => [s.item.id, s.item]));
      setItems((cur) =>
        cur.map((i) => {
          const s = byId.get(i.id);
          return s ? withState(i, s) : i;
        }),
      );
      setPicking(false);
      setDecision("snoozed");
    });

  const undo = () =>
    act(async () => {
      const states = await Promise.all(
        inWindow.map((i) => api.call(apiRoutes.portalUndoInbox, { params: { id: i.id } })),
      );
      const byId = new Map(states.map((s) => [s.item.id, s.item]));
      setItems((cur) =>
        cur.map((i) => {
          const s = byId.get(i.id);
          return s ? withState(i, s) : i;
        }),
      );
      setDecision(null);
    });

  const tickedOpen = items.filter((i) => ticked.has(i.id) && i.status === "open").length;
  const openCount = items.filter((i) => i.status === "open").length;
  const sources = Array.isArray(lead.payload.sources)
    ? lead.payload.sources.filter((x): x is string => typeof x === "string")
    : [];
  const editable = !batch && open && canSign ? editableFields(lead, i18n) : [];

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <article
        data-testid="desk-detail"
        aria-labelledby="desk-detail-title"
        className="overflow-hidden rounded-lg border border-line bg-surface"
      >
        <Band
          item={lead}
          open={open && !settled}
          snoozed={snoozedNow || decision === "snoozed"}
          agent={agent}
        />
        <div className="flex flex-col gap-4 p-6 max-sm:p-4">
          <div className="flex items-start gap-3">
            {agent ? <AgentBadge name={agent} seed={lead.service?.id} /> : null}
            <div className="min-w-0">
              <h2 id="desk-detail-title" className="type-heading text-ink">
                {title}
              </h2>
              <p className="text-sm text-ink-muted">{agent}</p>
            </div>
          </div>

          {batch ? (
            <BatchList
              items={items}
              ticked={ticked}
              canTick={open && canSign && !busy}
              onTick={(id, on) =>
                setTicked((cur) => {
                  const next = new Set(cur);
                  if (on) next.add(id);
                  else next.delete(id);
                  return next;
                })
              }
              heading={heading}
            />
          ) : editing ? (
            <EditForm
              item={lead}
              fields={editable}
              busy={busy}
              onCancel={() => setEditing(false)}
              onSave={(input) =>
                act(async () => {
                  const res = await api.call(apiRoutes.portalEditInbox, {
                    params: { id: lead.id },
                    body: { input },
                  });
                  setItems([
                    {
                      ...withState(lead, res.item),
                      payload: {
                        ...lead.payload,
                        edited: { input: res.edited.input, at: res.edited.at },
                      },
                    },
                  ]);
                  setEditing(false);
                })
              }
            />
          ) : ReviewCard ? (
            <ReviewCard
              itemId={lead.id}
              surface="portal"
              open={open && !settled}
              onResolve={canSign ? (body) => resolveOne(body, "answered") : null}
            />
          ) : (
            <ItemBody item={lead} heading={leadHeading} />
          )}

          {/* R5: an answer after we went ahead, and the undo a late no is offered (§1.86). */}
          <LateAnswer
            testId="desk-late"
            payload={lead.payload}
            surface="portal"
            onUndo={
              canSign
                ? async () => {
                    const out = await api.call(apiRoutes.portalUndoChange, {
                      params: { id: lead.id },
                    });
                    onChanged();
                    return out;
                  }
                : null
            }
          />

          {/* P-6: we passed this to you, and why (docs/plan.md §1.68). */}
          {open && lead.steppedIn?.action === "reassign" ? (
            <p className="text-sm text-copper-ink" data-testid="desk-passed">
              {t("desk.passedToYou", { reason: lead.steppedIn.reason })}
            </p>
          ) : null}

          {/* P-6: a message waiting for approval: its approver may change it first. */}
          {!batch && open && !settled && canSign && messageOf(lead) !== null ? (
            <MessageEdit
              item={lead}
              busy={busy}
              onSave={(message) =>
                act(async () => {
                  const res = await api.call(apiRoutes.portalEditInbox, {
                    params: { id: lead.id },
                    body: { input: { message } },
                  });
                  const sent = String(res.edited.input.message ?? message);
                  setItems([
                    {
                      ...withState(lead, res.item),
                      payload: withMessage(lead.payload, sent),
                    },
                  ]);
                })
              }
            />
          ) : null}

          {need === "code" && open ? (
            <ReleaseCodeEntry inboxItemId={lead.id} onDone={onChanged} />
          ) : null}

          {need === "answer" &&
          open &&
          canSign &&
          !ReviewCard &&
          !quickAnswers(lead.payload, i18n.locale) ? (
            <label className="ds-field" htmlFor={`desk-answer-${lead.id}`}>
              <span className="text-sm font-medium text-ink">{t("inbox.yourAnswer")}</span>
              <TextArea
                id={`desk-answer-${lead.id}`}
                data-testid="desk-answer-input"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                rows={3}
              />
            </label>
          ) : null}

          {lead.runId || sources.length > 0 ? (
            <div className="mz-sign__receipts">
              {lead.runId ? (
                <Link to={`/runs/${lead.runId}`} className="mz-receipt">
                  <Icon name="worksheet" size={14} className="ds-icon" />
                  {t("inbox.viewRun")}
                </Link>
              ) : null}
              <SourceLinks ids={sources} href={(id) => `/records/${id}`} testId="desk-sources" />
            </div>
          ) : null}

          {error ? <ErrorNotice error={error} /> : null}

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            {decision === "snoozed" ? (
              <p className="text-sm text-ink-muted" data-testid="desk-snoozed">
                {lead.snoozedUntil
                  ? t("desk.snoozedUntil", { time: fmt.time(lead.snoozedUntil) })
                  : t("desk.band.later")}
              </p>
            ) : open && !settled && !editing ? (
              <>
                <p className="text-sm text-ink-muted">
                  {!canSign
                    ? t("desk.viewer")
                    : snoozedNow && lead.snoozedUntil
                      ? t("desk.snoozedUntil", { time: fmt.time(lead.snoozedUntil) })
                      : need === "sign"
                        ? t("inbox.nothingChangesUntilSign")
                        : lead.dueAt
                          ? t("inbox.waitsUntil", { time: fmt.time(lead.dueAt) })
                          : null}
                </p>
                {canSign ? (
                  <div className="flex flex-wrap justify-end gap-2" data-testid="desk-actions">
                    {picking ? (
                      <SnoozeChoices
                        busy={busy}
                        onPick={snooze}
                        onCancel={() => setPicking(false)}
                      />
                    ) : (
                      <>
                        {need !== "code" ? (
                          <Button
                            data-testid="desk-not-now"
                            disabled={busy}
                            onClick={() => setPicking(true)}
                          >
                            {t("desk.notNow")}
                          </Button>
                        ) : null}
                        {ReviewCard ? null : (
                          <Decide
                            need={need}
                            lead={lead}
                            batch={batch}
                            busy={busy}
                            toolName={toolName}
                            answer={answer}
                            ticked={tickedOpen}
                            total={openCount}
                            canEdit={editable.length > 0}
                            onEdit={() => setEditing(true)}
                            onResolve={resolveOne}
                            onBatch={resolveBatch}
                          />
                        )}
                      </>
                    )}
                  </div>
                ) : null}
              </>
            ) : !open || settled ? (
              <Outcome
                items={items}
                decision={decision}
                now={now}
                busy={busy}
                inWindow={inWindow}
                onUndo={undo}
              />
            ) : null}
          </footer>
        </div>
      </article>
      <DeskWorksheet item={lead} agent={agent} />
    </div>
  );
}

/** The band on top: "Waiting on you · Pia drafted this at 8:05 · due 17:00", or what was done. */
function Band({
  item,
  open,
  snoozed,
  agent,
}: {
  item: DeskItem;
  open: boolean;
  snoozed: boolean;
  agent: string | null;
}) {
  const { t, fmt } = useI18n();
  if (open && !snoozed) {
    const parts = [
      needOf(item) === "answer" ? t("desk.band.answer") : t("common.waitingOnYou"),
      agent
        ? t("desk.band.drafted", { agent, time: fmt.time(item.createdAt) })
        : t("desk.band.came", { time: fmt.time(item.createdAt) }),
      item.dueAt ? t("desk.band.due", { time: fmt.time(item.dueAt) }) : null,
    ];
    return (
      <div
        data-testid="desk-band"
        className="flex items-center gap-2 border-b border-line bg-signal-tint px-6 py-2.5 text-sm text-signal-ink max-sm:px-4"
      >
        <Icon name="sign" size={16} />
        <span>{parts.filter(Boolean).join(" · ")}</span>
      </div>
    );
  }
  // Set aside is nobody's decision yet: neutral. Done is a person's sign-off: copper (brand book).
  const later = open && snoozed;
  return (
    <div
      data-testid="desk-band"
      className={cx(
        "flex items-center gap-2 border-b border-line px-6 py-2.5 text-sm max-sm:px-4",
        later ? "bg-surface-subtle text-ink-muted" : "bg-copper-tint text-copper-ink",
      )}
    >
      <Icon name={later ? "calendar" : "check"} size={16} />
      <span>
        {later
          ? t("desk.band.later")
          : item.resolvedAt
            ? t("desk.band.resolvedAt", { time: fmt.time(item.resolvedAt) })
            : t("inbox.outcome.resolved")}
      </span>
    </div>
  );
}

/** One item's content: the change's before and after, the question, the facts, the steps. */
function ItemBody({
  item,
  heading,
}: {
  item: DeskItem;
  heading: ReturnType<typeof changeHeading> | null;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  if (item.kind === "external_action") {
    const edited = isPlainObject(item.payload.edited);
    return (
      <div className="flex flex-col gap-3">
        {heading?.description ? (
          <p className="text-ink" data-testid="desk-description">
            {heading.description}
          </p>
        ) : null}
        {edited ? (
          <p className="text-sm text-copper-ink" data-testid="desk-edited">
            {t("desk.edited")}
          </p>
        ) : null}
        <ChangeTables
          before={item.payload.before}
          input={signedInput(item.payload)}
          display={item.display?.tool}
          names={item.display?.names}
        />
      </div>
    );
  }
  const change = accountChangeFacts(item.payload, i18n);
  if (change) {
    const [now, after] = change;
    return (
      <BeforeAfter
        testId="desk-account-change"
        before={<span className="whitespace-pre-line">{now?.[1]}</span>}
        after={<span className="whitespace-pre-line">{after?.[1]}</span>}
        afterLabel={t("desk.afterYouSign")}
      />
    );
  }
  const facts =
    suggestionFacts(item.payload, i18n) ??
    payloadFacts(
      Object.fromEntries(Object.entries(item.payload).filter(([k]) => !DESK_PLUMBING.has(k))),
    );
  const steps = findingSteps(item.payload);
  return (
    <div className="flex flex-col gap-3">
      {facts.length > 0 ? (
        <dl
          className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm max-sm:grid-cols-1"
          data-testid="desk-facts"
        >
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ink-muted">{k}</dt>
              <dd className="break-words whitespace-pre-line text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {steps && steps.length > 0 ? (
        <div className="flex flex-col gap-1.5" data-testid="desk-steps">
          <span className="text-sm font-medium text-ink">{t("inbox.findingSteps")}</span>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-ink">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

/** A batch: each change on its own line, ticked to sign, with its before and after on demand. */
function BatchList({
  items,
  ticked,
  canTick,
  onTick,
  heading,
}: {
  items: DeskItem[];
  ticked: Set<string>;
  canTick: boolean;
  onTick: (id: string, on: boolean) => void;
  heading: (item: DeskItem) => ReturnType<typeof changeHeading> | null;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-ink">{t("desk.batch.lead", { count: items.length })}</p>
      <ul className="overflow-hidden rounded-md border border-line" data-testid="desk-batch">
        {items.map((item) => {
          const h = heading(item);
          return (
            <li key={item.id} className="border-b border-line last:border-b-0">
              <div className="flex items-start gap-3 px-4 py-3">
                {item.status === "open" ? (
                  // biome-ignore lint/a11y/useSemanticElements: the design system's Checkbox is a button with role=checkbox.
                  <button
                    type="button"
                    role="checkbox"
                    className="ds-choice mt-0.5 disabled:opacity-60"
                    data-testid={`desk-batch-tick-${item.id}`}
                    aria-label={t("desk.batch.include", { what: h?.title ?? item.title })}
                    aria-checked={ticked.has(item.id)}
                    disabled={!canTick}
                    onClick={() => onTick(item.id, !ticked.has(item.id))}
                  >
                    <span className="ds-check">{ticked.has(item.id) ? "✓" : ""}</span>
                  </button>
                ) : (
                  <ResolvedMark item={item} />
                )}
                <details className="min-w-0 flex-1">
                  <summary className="cursor-pointer text-sm font-medium text-ink">
                    {h?.title ?? item.title}
                  </summary>
                  <div className="mt-3">
                    <ChangeTables
                      before={item.payload.before}
                      input={signedInput(item.payload)}
                      display={item.display?.tool}
                      names={item.display?.names}
                    />
                  </div>
                </details>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ResolvedMark({ item }: { item: DeskItem }) {
  const { t } = useI18n();
  return (
    <StatusChip state={item.status === "resolved" ? "person" : "idle"} className="shrink-0">
      {item.status === "resolved" ? t("inbox.outcome.resolved") : t("common.expired")}
    </StatusChip>
  );
}

/** The decision buttons for what the item needs. Sign is always the person's click. */
function Decide({
  need,
  lead,
  batch,
  busy,
  toolName,
  answer,
  ticked,
  total,
  canEdit,
  onEdit,
  onResolve,
  onBatch,
}: {
  need: ReturnType<typeof needOf>;
  lead: DeskItem;
  batch: boolean;
  busy: boolean;
  toolName: string | null;
  answer: string;
  ticked: number;
  total: number;
  canEdit: boolean;
  onEdit: () => void;
  onResolve: (body: ResolveInput, after: Decision) => void;
  onBatch: (decide: "approve" | "reject") => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  if (need === "code") return null;
  if (need === "request") {
    return (
      <Link to={PORTAL_PATHS.requests} className="ds-btn ds-btn--primary">
        {t("desk.openRequests")}
      </Link>
    );
  }
  if (need === "done") {
    return (
      <Button
        variant="primary"
        data-testid="desk-done"
        disabled={busy}
        onClick={() => onResolve({ decision: "approve" }, "done")}
      >
        {t("inbox.findingDone")}
      </Button>
    );
  }
  if (need === "answer") {
    const choices = quickAnswers(lead.payload, i18n.locale);
    return (
      <>
        <Button
          variant="ghost"
          data-testid="desk-decline"
          disabled={busy}
          onClick={() => onResolve({ decision: "reject" }, "declined")}
        >
          {t("inbox.decline")}
        </Button>
        {choices ? (
          choices.map((c) => (
            <Button
              key={c.value}
              variant="primary"
              data-testid={`desk-choice-${c.value}`}
              disabled={busy}
              onClick={() => onResolve({ decision: "approve", answer: c.value }, "answered")}
            >
              {c.label}
            </Button>
          ))
        ) : (
          <Button
            variant="primary"
            data-testid="desk-answer-send"
            disabled={busy || answer.trim().length === 0}
            onClick={() => onResolve({ decision: "approve", answer: answer.trim() }, "answered")}
          >
            {t("inbox.sendAnswer")}
          </Button>
        )}
      </>
    );
  }
  if (batch) {
    return (
      <>
        <Button
          variant="ghost"
          data-testid="desk-reject"
          disabled={busy || ticked === 0}
          onClick={() => onBatch("reject")}
        >
          {ticked === total
            ? t("desk.batch.rejectAll")
            : t("desk.batch.rejectSome", { count: ticked })}
        </Button>
        <Button
          variant="primary"
          data-testid="desk-sign"
          disabled={busy || ticked === 0}
          onClick={() => onBatch("approve")}
        >
          {ticked === total
            ? t("desk.batch.signAll", { count: total })
            : t("desk.batch.signSome", { count: ticked, total })}
        </Button>
      </>
    );
  }
  return (
    <>
      <Button
        variant="ghost"
        data-testid="desk-reject"
        disabled={busy}
        onClick={() => onResolve({ decision: "reject" }, "rejected")}
      >
        {t("inbox.reject")}
      </Button>
      {canEdit ? (
        <Button data-testid="desk-edit" disabled={busy} onClick={onEdit}>
          {t("desk.edit")}
        </Button>
      ) : null}
      <Button
        variant="primary"
        data-testid="desk-sign"
        disabled={busy}
        onClick={() => onResolve({ decision: "approve" }, "signed")}
      >
        {lead.kind === "external_action" && toolName
          ? t("inbox.signAndUpdate", { tool: toolName })
          : t("inbox.sign")}
      </Button>
    </>
  );
}

/** "Not now": later today, tomorrow at 8:00, Monday at 8:00. The API may bring it back sooner. */
function SnoozeChoices({
  busy,
  onPick,
  onCancel,
}: {
  busy: boolean;
  onPick: (until: Date) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const times = snoozeTimes(new Date());
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="desk-snooze">
      <span className="text-sm text-ink-muted">{t("desk.snooze.until")}</span>
      <Button
        size="sm"
        disabled={busy}
        onClick={() => onPick(times.later)}
        data-testid="desk-snooze-later"
      >
        {t("desk.snooze.later")}
      </Button>
      <Button
        size="sm"
        disabled={busy}
        onClick={() => onPick(times.tomorrow)}
        data-testid="desk-snooze-tomorrow"
      >
        {t("desk.snooze.tomorrow")}
      </Button>
      <Button
        size="sm"
        disabled={busy}
        onClick={() => onPick(times.monday)}
        data-testid="desk-snooze-monday"
      >
        {t("desk.snooze.monday")}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
        {t("common.cancel")}
      </Button>
    </div>
  );
}

/** After a decision: who did what, and Undo while the window lasts. */
function Outcome({
  items,
  decision,
  now,
  busy,
  inWindow,
  onUndo,
}: {
  items: DeskItem[];
  decision: Decision | null;
  now: number;
  busy: boolean;
  inWindow: DeskItem[];
  onUndo: () => void;
}) {
  const { t, fmt } = useI18n();
  const lead = items[0] as DeskItem;
  const done = items.filter((i) => i.status === "resolved").length;
  const words: Record<Exclude<Decision, "snoozed">, PlainKey> = {
    signed: "desk.outcome.signed",
    rejected: "desk.outcome.rejected",
    answered: "desk.outcome.answered",
    declined: "desk.outcome.declined",
    done: "desk.outcome.done",
  };
  const text: ReactNode =
    decision && decision !== "snoozed"
      ? items.length > 1
        ? t("desk.outcome.batch", { count: done, total: items.length })
        : t(words[decision])
      : lead.steppedIn && lead.steppedIn.action !== "reassign"
        ? // P-6: we stepped in, on your behalf, and why (§1.68).
          t("desk.steppedIn", { reason: lead.steppedIn.reason })
        : lead.resolvedBy?.name
          ? t("inbox.outcome.resolvedBy", { name: lead.resolvedBy.name })
          : lead.status === "expired"
            ? t("common.expired")
            : t("inbox.outcome.resolved");
  const left = inWindow.length > 0 ? Math.max(...inWindow.map((i) => undoLeft(i, now))) : 0;
  const declined = decision === "rejected" || decision === "declined";
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip
          state={lead.status === "expired" || declined ? "idle" : "person"}
          testId="desk-outcome"
        >
          {text}
        </StatusChip>
        {lead.resolvedAt ? (
          <span className="text-sm text-ink-muted">{fmt.time(lead.resolvedAt)}</span>
        ) : null}
      </div>
      {left > 0 ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-ink-muted" data-testid="desk-undo-left">
            {t("desk.undoLeft", { count: left })}
          </span>
          <Button variant="ghost" data-testid="desk-undo" disabled={busy} onClick={onUndo}>
            {t("inbox.undo")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

interface EditableField {
  key: string;
  label: string;
  kind: (typeof EDITABLE_KINDS)[number];
}

/**
 * The fields a person may change before signing: the tool's display marks them `editable`, set
 * from a top-level input field (the API checks the edit again and refuses anything else).
 */
// DECISION: only top-level input fields are offered (every editable field the connectors declare
// today is one); a nested path stays the agent's, so the form never writes a computed key path.
function editableFields(item: DeskItem, { locale }: I18n): EditableField[] {
  if (item.kind !== "external_action") return [];
  const display: ToolDisplay | null | undefined = item.display?.tool;
  const out: EditableField[] = [];
  for (const f of display?.fields ?? []) {
    if (f.editable !== true || !f.after?.startsWith("input.")) continue;
    const kind = (EDITABLE_KINDS as readonly string[]).includes(f.kind)
      ? (f.kind as EditableField["kind"])
      : null;
    const path = f.after.split(".").slice(1);
    if (!kind || path.length !== 1) continue;
    out.push({
      key: path[0] as string,
      label: pickLocalized(f.label as LocalizedText, locale),
      kind,
    });
  }
  return out;
}

function EditForm({
  item,
  fields,
  busy,
  onCancel,
  onSave,
}: {
  item: DeskItem;
  fields: EditableField[];
  busy: boolean;
  onCancel: () => void;
  onSave: (input: Record<string, unknown>) => void;
}) {
  const { t } = useI18n();
  const base = signedInput(item.payload);
  const original = isPlainObject(base) ? base : {};
  const [values, setValues] = useState<Map<string, string>>(
    () =>
      new Map(
        fields.map((f) => {
          const v = Object.hasOwn(original, f.key) ? original[f.key] : undefined;
          return [f.key, v === undefined || v === null ? "" : String(v)];
        }),
      ),
  );
  const kinds = new Map(fields.map((f) => [f.key, f.kind]));
  function edited(): Record<string, unknown> {
    const parse = (key: string, text: string): unknown =>
      kinds.get(key) === "number" && typeof original[key] === "number" ? Number(text) : text;
    const changed = [...values.entries()].map(([k, v]) => [k, parse(k, v)] as const);
    const keys = new Set(changed.map(([k]) => k));
    return Object.fromEntries([
      ...Object.entries(original).filter(([k]) => !keys.has(k)),
      ...changed,
    ]);
  }
  return (
    <form
      data-testid="desk-edit-form"
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(edited());
      }}
    >
      <p className="text-sm text-ink-muted">{t("desk.editHint")}</p>
      {fields.map((f) => (
        <Field key={f.key} label={f.label}>
          {f.kind === "text" && (values.get(f.key) ?? "").length > 80 ? (
            <TextArea
              rows={5}
              data-testid={`desk-edit-${f.key}`}
              value={values.get(f.key) ?? ""}
              onChange={(e) => setValues((cur) => new Map(cur).set(f.key, e.target.value))}
            />
          ) : (
            <TextInput
              data-testid={`desk-edit-${f.key}`}
              inputMode={f.kind === "money" || f.kind === "number" ? "decimal" : undefined}
              value={values.get(f.key) ?? ""}
              onChange={(e) => setValues((cur) => new Map(cur).set(f.key, e.target.value))}
            />
          )}
        </Field>
      ))}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <button
          type="submit"
          className="ds-btn ds-btn--primary"
          disabled={busy}
          data-testid="desk-edit-save"
        >
          {t("desk.editSave")}
        </button>
      </div>
    </form>
  );
}

/** The time, ticking each second while `live` (an undo window is open), else fixed. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return live ? now : Date.now();
}

// ── P-6: changing a message before approving it (docs/plan.md §1.68) ──────────────────────────────

/** The text a message waiting for approval will send, or null for any other item. */
function messageOf(item: DeskItem): string | null {
  if (item.kind !== "approval" || typeof item.payload.reachOutId !== "string") return null;
  for (const key of ["converse", "reachOut"] as const) {
    const v = item.payload[key];
    if (isPlainObject(v) && typeof v.message === "string") return v.message;
  }
  return null;
}

function withMessage(payload: DeskItem["payload"], message: string): DeskItem["payload"] {
  const out: Record<string, unknown> = { ...payload, edited: { message } };
  for (const key of ["converse", "reachOut"] as const) {
    const v = payload[key];
    if (isPlainObject(v)) out[key] = { ...v, message };
  }
  return out;
}

function MessageEdit({
  item,
  busy,
  onSave,
}: {
  item: DeskItem;
  busy: boolean;
  onSave: (message: string) => void;
}) {
  const { t } = useI18n();
  const current = messageOf(item) ?? "";
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(current);
  const edited = isPlainObject(item.payload.edited);
  return (
    <div className="flex flex-col gap-2" data-testid="desk-message">
      {edited ? (
        <p className="text-sm text-copper-ink" data-testid="desk-message-edited">
          {t("desk.messageEdited")}
        </p>
      ) : null}
      {editing ? (
        <>
          <TextArea
            data-testid="desk-message-input"
            aria-label={t("desk.editMessage")}
            value={text}
            maxLength={1600}
            rows={4}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="desk-message-save"
              variant="primary"
              disabled={busy || text.trim().length === 0}
              onClick={() => {
                onSave(text.trim());
                setEditing(false);
              }}
            >
              {t("desk.editMessageSave")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </>
      ) : (
        <div>
          <Button
            data-testid="desk-message-edit"
            disabled={busy}
            onClick={() => {
              setText(current);
              setEditing(true);
            }}
          >
            {t("desk.editMessage")}
          </Button>
        </div>
      )}
    </div>
  );
}
