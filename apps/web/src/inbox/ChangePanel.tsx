// The design's "Changes to your tools" panel body (screen 6), as the SignCard's before and after
// (mz-sign__change): NOW on the left, AFTER THIS CHANGE on the right, field by field, with the
// changed values marked. Lists (a bill's lines, a record's files) read as small tables, now above
// after, with their totals. Generic: every tool renders through its declared display (core
// ToolDisplay), or the record's own fields when it declares none.
import type { ToolDisplay } from "@countersign/core";
import type { ReactNode } from "react";
import type { Formatters } from "../i18n/format";
import { useI18n } from "../i18n/i18n";
import { cx } from "../ui/primitives";
import { type ChangeField, type ChangeValue, changeModel, type ItemView } from "./change";

export function ChangeTables({
  before,
  input,
  display,
  showUnchanged = false,
}: {
  before: unknown;
  input: unknown;
  /** The tool's display spec, when it declares one. */
  display?: ToolDisplay | null | undefined;
  /**
   * Show the fields and lines the change leaves as they are beside the rest. By default only what
   * differs shows, and the rest folds under "N fields unchanged".
   */
  showUnchanged?: boolean;
}) {
  const { t, locale } = useI18n();
  const model = changeModel(display, before, input, locale);
  // A new record has nothing "now": every field is part of the change.
  const all = showUnchanged || model.create;
  const changed = model.fields.filter((f) => all || f.changed);
  const unchanged = model.fields.filter((f) => !all && !f.changed);
  // Nothing differs (a write that leaves the record as it is): show it whole, as before.
  const shown = changed.length > 0 ? changed : model.fields;
  const folded = changed.length > 0 ? unchanged : [];
  return (
    <div className="flex flex-col gap-3">
      <Fields fields={shown} create={model.create} foldLines={!all} />
      {folded.length > 0 ? (
        <details data-testid="change-unchanged" className="text-sm">
          <summary className="cursor-pointer text-ink-muted">
            {t("change.unchanged", { count: folded.length })}
          </summary>
          <div className="mt-3">
            <Fields fields={folded} create={model.create} foldLines={false} prefix="change-same" />
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** Fields as the two-sided grid (plain values) and their own tables (lists). */
function Fields({
  fields,
  create,
  foldLines,
  prefix = "change",
}: {
  fields: ChangeField[];
  create: boolean;
  foldLines: boolean;
  /** Test ids: `change-now-row-<key>`, or `change-same-…` for the folded fields. */
  prefix?: string;
}) {
  const { t } = useI18n();
  const scalars = fields.filter((f) => !f.list);
  const lists = fields.filter((f) => f.list);
  return (
    <div className="flex flex-col gap-3">
      {scalars.length > 0 || lists.length === 0 ? (
        <div className="mz-sign__change">
          <Side
            testId={`${prefix}-now`}
            title={t("change.now")}
            fields={scalars}
            pick="now"
            empty={create ? t("change.createsIt") : t("change.nothingRecorded")}
            hideAll={create}
          />
          <Side
            testId={`${prefix}-after`}
            title={t("change.after")}
            fields={scalars}
            pick="after"
            empty={t("change.noFields")}
          />
        </div>
      ) : null}
      {lists.map((f) => (
        <ListField key={f.key} field={f} create={create} fold={foldLines && f.changed} />
      ))}
    </div>
  );
}

/** A list side with only the given items; the lines' total stays the whole list's unless dropped. */
function only(value: ChangeValue, keep: (item: ItemView) => boolean, total = true): ChangeValue {
  if (value.type === "lines") {
    return { ...value, items: value.items.filter(keep), total: total ? value.total : null };
  }
  return value.type === "files" ? { ...value, items: value.items.filter(keep) } : value;
}

/** A date-only value ("2026-10-28") read at local noon, so no time zone moves it a day. */
function dateText(value: string, fmt: Formatters): string {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value;
  return Number.isNaN(Date.parse(iso)) ? value : fmt.date(iso);
}

/** A field's value as text in the reader's locale. */
export function valueText(v: ChangeValue, fmt: Formatters): string {
  switch (v.type) {
    case "none":
      return "—";
    case "text":
      return v.text;
    case "money":
      return fmt.money(v.amount, v.currency);
    case "number":
      return fmt.figure(v.value);
    case "date":
      return dateText(v.value, fmt);
    case "lines":
    case "files":
    case "table":
      return "";
  }
}

function Side({
  testId,
  title,
  fields,
  pick,
  empty,
  hideAll,
}: {
  testId: string;
  title: string;
  fields: ChangeField[];
  pick: "now" | "after";
  empty: string;
  hideAll?: boolean;
}) {
  const { t, fmt } = useI18n();
  const shown = hideAll ? [] : fields;
  return (
    <section data-testid={testId} aria-label={title} className="mz-sign__side">
      <h4 className="eyebrow mb-1.5 text-ink-muted">{title}</h4>
      {shown.length === 0 ? (
        <p className="text-sm text-ink-muted">{empty}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              <th className="px-1 py-1.5 text-left text-xs font-medium text-ink-muted">
                {t("change.field")}
              </th>
              <th className="px-1 py-1.5 text-right text-xs font-medium text-ink-muted">
                {t("change.value")}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((f) => {
              const marked = pick === "after" && f.changed;
              return (
                <tr
                  key={f.key}
                  data-testid={`${testId}-row-${f.key}`}
                  data-changed={marked ? "true" : undefined}
                  className="border-b border-line last:border-b-0"
                >
                  <td className="px-1 py-2 align-top text-ink">{f.label}</td>
                  <td
                    className={cx(
                      "px-1 py-2 text-right align-top break-words text-ink figures",
                      marked && "bg-slate-tint px-2 font-medium",
                    )}
                  >
                    {valueText(f[pick], fmt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * A list field (lines, files, records): its own now and after tables, stacked. With `fold`, only
 * the lines the change removes (now) and adds (after) show; the lines it keeps fold beneath.
 */
function ListField({
  field,
  create,
  fold,
}: {
  field: ChangeField;
  create: boolean;
  fold: boolean;
}) {
  const { t } = useI18n();
  const marked = (i: ItemView) => i.marked;
  const kept = fold ? only(field.after, (i) => !i.marked, false) : null;
  const keptCount =
    kept && (kept.type === "lines" || kept.type === "files") ? kept.items.length : 0;
  return (
    <section
      data-testid={`change-${field.key}`}
      aria-label={field.label}
      className="flex flex-col gap-2"
    >
      <h4 className="text-sm font-medium text-ink">{field.label}</h4>
      <ListSide
        testId={`change-${field.key}-now`}
        title={t("change.now")}
        value={create ? { type: "none" } : fold ? only(field.now, marked) : field.now}
        side="now"
        empty={create ? t("change.createsIt") : t("change.noneYet")}
      />
      <ListSide
        testId={`change-${field.key}-after`}
        title={t("change.after")}
        value={fold ? only(field.after, marked) : field.after}
        side="after"
        empty={t("change.noneYet")}
      />
      {kept && keptCount > 0 ? (
        <details data-testid={`change-${field.key}-unchanged`} className="text-sm">
          <summary className="cursor-pointer text-ink-muted">
            {t("change.linesUnchanged", { count: keptCount })}
          </summary>
          <div className="mt-2">
            <ListSide
              testId={`change-${field.key}-kept`}
              title={field.label}
              value={kept}
              side="after"
              empty={t("change.noneYet")}
            />
          </div>
        </details>
      ) : null}
    </section>
  );
}

function ListSide({
  testId,
  title,
  value,
  side,
  empty,
}: {
  testId: string;
  title: string;
  value: ChangeValue;
  side: "now" | "after";
  empty: string;
}) {
  const { t, fmt } = useI18n();
  const count =
    value.type === "lines" || value.type === "files"
      ? value.items.length
      : value.type === "table"
        ? value.rows.length
        : 0;
  return (
    <div data-testid={testId} className="mz-sign__side overflow-x-auto">
      <h5 className="eyebrow mb-1.5 text-ink-muted">{title}</h5>
      {count === 0 ? (
        <p className="text-sm text-ink-muted">{empty}</p>
      ) : value.type === "lines" ? (
        <LinesTable testId={testId} value={value} side={side} />
      ) : value.type === "files" ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              <Th>{t("change.files.name")}</Th>
              <Th right>{t("change.files.size")}</Th>
            </tr>
          </thead>
          <tbody>
            {value.items.map((f, i) => (
              <ItemRow
                // biome-ignore lint/suspicious/noArrayIndexKey: a list is shown once, never reordered.
                key={i}
                testId={`${testId}-item-${i}`}
                item={f}
                side={side}
              >
                <td className="px-1 py-2 align-top break-words text-ink">
                  {f.description ?? "—"}
                  <Marker item={f} side={side} />
                </td>
                <td className="px-1 py-2 text-right align-top text-ink figures">
                  {f.size === null ? "—" : fmt.bytes(f.size)}
                </td>
              </ItemRow>
            ))}
          </tbody>
        </table>
      ) : value.type === "table" ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line">
              {value.columns.map((c) => (
                <Th key={c}>{c}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {value.rows.map((r, i) => (
              <tr
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id of their own.
                key={i}
                data-testid={`${testId}-item-${i}`}
                className="border-b border-line last:border-b-0"
              >
                {r.map((cell, j) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells line up with the columns.
                    key={j}
                    className="px-1 py-2 align-top break-words text-ink"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function LinesTable({
  testId,
  value,
  side,
}: {
  testId: string;
  value: Extract<ChangeValue, { type: "lines" }>;
  side: "now" | "after";
}) {
  const { t, fmt } = useI18n();
  const priced = value.items.some((l) => l.qty !== null || l.unitPrice !== null);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line">
          <Th>{t("change.lines.description")}</Th>
          <Th>{t("change.lines.bookedTo")}</Th>
          {priced ? <Th right>{t("change.lines.qtyPrice")}</Th> : null}
          <Th right>{t("change.lines.amount")}</Th>
        </tr>
      </thead>
      <tbody>
        {value.items.map((l, i) => (
          <ItemRow
            // biome-ignore lint/suspicious/noArrayIndexKey: a list is shown once, never reordered.
            key={i}
            testId={`${testId}-item-${i}`}
            item={l}
            side={side}
          >
            <td className="px-1 py-2 align-top break-words text-ink">
              {l.description ?? "—"}
              <Marker item={l} side={side} />
            </td>
            <td className="px-1 py-2 align-top break-words text-ink-muted">{l.ref ?? "—"}</td>
            {priced ? (
              <td className="px-1 py-2 text-right align-top whitespace-nowrap text-ink-muted figures">
                {l.qty !== null && l.unitPrice !== null
                  ? `${fmt.figure(l.qty)} × ${fmt.unitPrice(l.unitPrice, value.currency)}`
                  : l.qty !== null
                    ? fmt.figure(l.qty)
                    : "—"}
              </td>
            ) : null}
            <td className="px-1 py-2 text-right align-top whitespace-nowrap text-ink figures">
              {fmt.money(l.amount, value.currency)}
            </td>
          </ItemRow>
        ))}
      </tbody>
      {value.total !== null ? (
        <tfoot>
          <tr data-testid={`${testId}-total`} className="border-t border-line">
            <td className="px-1 py-2 font-medium text-ink" colSpan={priced ? 3 : 2}>
              {t("change.lines.total")}
            </td>
            <td className="px-1 py-2 text-right font-medium whitespace-nowrap text-ink figures">
              {fmt.money(value.total, value.currency)}
            </td>
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}

function Th({ children, right }: { children: string; right?: boolean }) {
  return (
    <th
      className={cx(
        "px-1 py-1.5 text-xs font-medium text-ink-muted",
        right ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

/** A line or file row: what the change adds is marked; what it removes reads struck through. */
function ItemRow({
  testId,
  item,
  side,
  children,
}: {
  testId: string;
  item: ItemView;
  side: "now" | "after";
  children: ReactNode;
}) {
  const added = side === "after" && item.marked;
  const removed = side === "now" && item.marked;
  return (
    <tr
      data-testid={testId}
      data-changed={added ? "true" : undefined}
      data-removed={removed ? "true" : undefined}
      className={cx(
        "border-b border-line last:border-b-0",
        added && "bg-slate-tint font-medium",
        removed && "text-ink-muted line-through",
      )}
    >
      {children}
    </tr>
  );
}

/** The word behind the marking, for screen readers. */
function Marker({ item, side }: { item: ItemView; side: "now" | "after" }) {
  const { t } = useI18n();
  if (!item.marked) return null;
  return (
    <span className="sr-only">{` (${side === "after" ? t("change.item.added") : t("change.item.removed")})`}</span>
  );
}
