// One card on Your call (docs/plan.md §1.124.3; the prototype's `callList()`): the tag, the title
// linked to its item, the client and due date, Reggie's read and plan, why it needs a person (risk
// when critical), the draft with Edit, the options, the form, how sure Reggie is, and the buttons.
// Built on the design system's classes and tokens only; no colours of its own.
import { type TodoView, YOUR_CALL_WORDS } from "@countersign/core";
import { Link } from "react-router-dom";
import { cx } from "../../../ui/cx";
import { Icon } from "../../../ui/icons";
import { Due } from "../parts";

const W = YOUR_CALL_WORDS;

export interface CallCardProps {
  item: TodoView;
  focused: boolean;
  editing: boolean;
  draft: string;
  option: number;
  busy: boolean;
  pending: boolean;
  today: string;
  onDraft(text: string): void;
  onOption(n: number): void;
  onEdit(): void;
  onAct(): void;
  onLater(): void;
  onDone(): void;
  onUndo(): void;
  onFocus(): void;
}

export function CallCard(p: CallCardProps) {
  const t = p.item;
  const href = t.about?.href ?? null;
  return (
    <article
      className={cx(
        "ds-card grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]",
        t.critical && "mz-kcard--critical",
        p.focused && "border-slate",
      )}
      data-testid={`call-${t.id}`}
      data-focus={p.focused || undefined}
      onFocusCapture={p.onFocus}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div>
          <span className="ds-pill ds-pill--neutral ds-pill--sm">{t.tag}</span>
        </div>
        <h3 className="m-0 text-base font-medium">
          {href ? (
            <Link to={href} className="text-ink">
              {t.title}
            </Link>
          ) : (
            t.title
          )}
        </h3>
        <div className="flex flex-wrap items-center gap-3 text-sm text-ink-muted">
          {t.client ? <Link to={`/ops/clients/${t.client.id}`}>{t.client.name}</Link> : null}
          <span className="inline-flex items-center gap-1">
            {t.dueAt ? "Due " : null}
            <Due iso={t.dueAt} today={p.today} />
          </span>
        </div>
        {t.read ? (
          <>
            <span className="ds-ai mt-2">
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
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        {t.draft ? (
          <>
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
          </>
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
        ) : null}
        {t.sure ? <div className="text-xs text-ink-muted">{t.sure}</div> : null}
        {p.pending ? (
          <div className="flex items-center gap-2 text-sm" role="status">
            <span>{W.sending}</span>
            <button
              type="button"
              className="ds-btn ds-btn--secondary ds-btn--sm"
              onClick={p.onUndo}
            >
              {W.undo}
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {t.primary ? (
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
            )}
            {t.draft && t.editable ? (
              <button
                type="button"
                className="ds-btn ds-btn--secondary ds-btn--sm"
                onClick={p.onEdit}
              >
                {W.edit}
              </button>
            ) : null}
            {t.editable ? (
              <button
                type="button"
                className="ds-btn ds-btn--ghost ds-btn--sm"
                disabled={p.busy}
                onClick={p.onLater}
                data-testid="call-later"
              >
                {W.later}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
}
