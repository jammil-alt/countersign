// One item on Your call (docs/plan.md §1.124.3; the prototype's `callList()`), in two parts. The
// card is compact: the tag, the title, the client and due date, the one word for why it needs a
// person (signal, or risk when critical), and the main button at the right edge. Clicking it (or O
// or Enter) opens the side sheet with everything: Reggie's read and plan, why, the draft with Edit,
// the options, the form, how sure Reggie is, and the decision buttons.
// Built on the design system's classes and tokens only; no colours of its own.
// DECISION (owner, 2026-11-20): "more compact cards … then open them in a side modal with all the
// details and decisions". The card keeps one button so S still reads at a glance; Edit and Later
// live in the sheet, where the draft is.
import { type TodoView, YOUR_CALL_WORDS } from "@countersign/core";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cx } from "../../../ui/cx";
import { Icon } from "../../../ui/icons";
import { SheetSection, SideSheet } from "../../../ui/sheet";
import { Due } from "../parts";

const W = YOUR_CALL_WORDS;

/** What the card and the sheet share: the item and its decision. */
interface DecisionProps {
  item: TodoView;
  busy: boolean;
  pending: boolean;
  onAct(): void;
  onDone(): void;
  onUndo(): void;
}

export interface CallCardProps extends DecisionProps {
  focused: boolean;
  today: string;
  onOpen(): void;
  onFocus(): void;
}

/** The compact card in the list. */
export function CallCard(p: CallCardProps) {
  const t = p.item;
  return (
    <article
      className={cx(
        "ds-card relative flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 hover:border-line-strong",
        t.critical && "mz-kcard--critical",
        p.focused && "border-slate",
      )}
      data-testid={`call-${t.id}`}
      data-focus={p.focused || undefined}
      onFocusCapture={p.onFocus}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="ds-pill ds-pill--neutral ds-pill--sm shrink-0">{t.tag}</span>
          {/* The title is the card's button: its ::after covers the card, so a click anywhere
              opens the sheet, and the links and buttons over it keep their own clicks. */}
          <button
            type="button"
            className="line-clamp-2 min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left text-sm font-medium text-ink after:absolute after:inset-0 hover:underline"
            onClick={p.onOpen}
            aria-haspopup="dialog"
            data-testid="call-open"
          >
            {t.title}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
          {t.client ? (
            <Link to={`/ops/clients/${t.client.id}`} className="relative">
              {t.client.name}
            </Link>
          ) : null}
          <span className="inline-flex items-center gap-1">
            {t.dueAt ? "Due " : null}
            <Due iso={t.dueAt} today={p.today} />
          </span>
          {t.why ? (
            <span
              className={cx(
                "ds-pill ds-pill--sm",
                t.critical ? "ds-pill--risk" : "ds-pill--warning",
              )}
              data-testid="call-why-word"
            >
              {t.why.head}
            </span>
          ) : null}
        </div>
      </div>
      <div className="relative ml-auto shrink-0">
        <Decision {...p} />
      </div>
    </article>
  );
}

/** The main button (Do it, Open, Done), or "Sending in 5 seconds" with Undo while a draft waits. */
function Decision(p: DecisionProps) {
  const t = p.item;
  if (p.pending) {
    return (
      <div className="flex items-center gap-2 text-sm" role="status">
        <span>{W.sending}</span>
        <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" onClick={p.onUndo}>
          {W.undo}
        </button>
      </div>
    );
  }
  return t.primary ? (
    <button
      type="button"
      className="ds-btn ds-btn--primary ds-btn--sm"
      disabled={p.busy}
      onClick={p.onAct}
      data-testid="call-act"
    >
      {t.primary.label}
    </button>
  ) : (
    <button
      type="button"
      className="ds-btn ds-btn--primary ds-btn--sm"
      disabled={p.busy}
      onClick={p.onDone}
      data-testid="call-done"
    >
      Done
    </button>
  );
}

export interface CallSheetProps extends DecisionProps {
  editing: boolean;
  draft: string;
  option: number;
  today: string;
  onDraft(text: string): void;
  onOption(n: number): void;
  onEdit(): void;
  onLater(): void;
  onClose(): void;
  /** A failed decision, shown in the sheet (the page's notice is behind it). */
  notice?: ReactNode;
}

/** Everything about one item, and its decisions, in the side sheet. */
export function CallSheet(p: CallSheetProps) {
  const t = p.item;
  const href = t.about?.href ?? null;
  const footer = (
    <div className="flex w-full flex-wrap items-center justify-end gap-2">
      {!p.pending && t.editable ? (
        <button
          type="button"
          className="ds-btn ds-btn--ghost ds-btn--sm mr-auto"
          disabled={p.busy}
          onClick={p.onLater}
          data-testid="call-later"
        >
          {W.later}
        </button>
      ) : null}
      {!p.pending && t.draft && t.editable ? (
        <button
          type="button"
          className="ds-btn ds-btn--secondary ds-btn--sm"
          aria-pressed={p.editing}
          onClick={p.onEdit}
        >
          {W.edit}
        </button>
      ) : null}
      <Decision {...p} />
    </div>
  );
  return (
    <SideSheet
      testId="call-sheet"
      onClose={p.onClose}
      eyebrow={
        <div>
          <span className="ds-pill ds-pill--neutral ds-pill--sm">{t.tag}</span>
        </div>
      }
      title={
        href ? (
          <Link to={href} className="text-ink hover:underline">
            {t.title}
          </Link>
        ) : (
          t.title
        )
      }
      footer={footer}
    >
      <div className="flex flex-col gap-5">
        {p.notice}
        <div className="flex flex-wrap items-center gap-3 text-sm text-ink-muted">
          {t.client ? <Link to={`/ops/clients/${t.client.id}`}>{t.client.name}</Link> : null}
          <span className="inline-flex items-center gap-1">
            {t.dueAt ? "Due " : null}
            <Due iso={t.dueAt} today={p.today} />
          </span>
        </div>
        {t.read || t.detail || t.plan.length ? (
          <section className="flex flex-col gap-2">
            {t.read ? (
              <>
                <span className="ds-ai">
                  <i />
                  {W.readHead}
                </span>
                <p className="m-0 text-sm">{t.read}</p>
              </>
            ) : t.detail ? (
              <p className="m-0 text-sm">{t.detail}</p>
            ) : null}
            {t.plan.length ? (
              <ol className="m-0 flex list-none flex-col gap-1 p-0 text-sm" data-testid="call-plan">
                {t.plan.map((step, n) => (
                  <li key={step} className="flex gap-2">
                    <span className="text-ink-muted tabular-nums">{n + 1}</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            ) : null}
          </section>
        ) : null}
        {t.why ? (
          <div
            className={cx(
              "flex items-start gap-2 rounded-sm border px-3 py-2 text-sm",
              t.critical
                ? "border-risk bg-risk-tint text-risk-ink"
                : "border-line bg-surface-subtle text-ink",
            )}
            data-testid="call-why"
          >
            <Icon name="alert" size={16} />
            <span>
              <b className="font-medium">{t.why.head}.</b> {t.why.detail}
            </span>
          </div>
        ) : null}
        {t.draft ? (
          <SheetSection label={W.draftHead}>
            <div className="text-xs text-ink-muted">{t.draft.to}</div>
            {p.editing ? (
              <textarea
                className="ds-textarea w-full"
                rows={8}
                value={p.draft}
                onChange={(e) => p.onDraft(e.target.value)}
                aria-label="Draft"
                data-testid="call-draft-edit"
              />
            ) : (
              <div
                className="whitespace-pre-wrap rounded-sm border border-line bg-surface-subtle p-3 text-sm"
                data-testid="call-draft"
              >
                {p.draft}
              </div>
            )}
          </SheetSection>
        ) : null}
        {t.form ? (
          <div className="rounded-sm border border-line p-3 text-sm">
            <div className="font-medium">{t.form.title}</div>
            <div className="mb-2 text-xs text-ink-muted">
              {t.form.to}
              {t.form.due ? ` · ${t.form.due}` : ""}
            </div>
            {t.form.questions.map((q) => (
              <div key={q} className="py-0.5 text-xs">
                {q}
              </div>
            ))}
            {t.form.prefilled ? (
              <div className="mt-1 text-xs text-ink-muted">
                + {t.form.prefilled} answered from what we know
              </div>
            ) : null}
          </div>
        ) : null}
        {t.options?.length ? (
          <SheetSection label={W.optionsHead}>
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0 text-sm">
              <legend className="sr-only">Options</legend>
              {t.options.map((o, n) => (
                <label key={o} className="flex items-start gap-2">
                  <input
                    type="radio"
                    name={`opt-${t.id}`}
                    checked={p.option === n}
                    onChange={() => p.onOption(n)}
                  />
                  {o}
                </label>
              ))}
            </fieldset>
          </SheetSection>
        ) : null}
        {t.sure ? <div className="text-xs text-ink-muted">{t.sure}</div> : null}
      </div>
    </SideSheet>
  );
}
