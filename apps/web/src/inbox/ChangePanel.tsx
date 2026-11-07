// The design's "Changes to your tools" panel body (screen 6): what the change does to the record,
// field by field. Only what changes is set out: the plain fields in one table (field, now, after
// this change), each list (a bill's lines, a record's files) as its own tables, now above after,
// with their totals. What stays the same is one line below ("Unchanged: Date Oct 28, 2026 · Total
// $9,742.35"). Generic: every tool renders through its declared display (core ToolDisplay), or
// the record's own fields when it declares none. Stacked, so it reads in a narrow pane and on a
// phone (QA round 1).
import type { ToolDisplay } from "@countersign/core";
import type { ReactNode } from "react";
import type { Formatters } from "../i18n/format";
import { useI18n } from "../i18n/i18n";
import { cx } from "../ui/primitives";
import {
  type ChangeField,
  type ChangeOptions,
  type ChangeValue,
  changeModel,
  type ItemView,
} from "./change";

export function ChangeTables({
  before,
  input,
  display,
  names,
  showIds,
}: {
  before: unknown;
  input: unknown;
  /** The tool's display spec, when it declares one. */
  display?: ToolDisplay | null | undefined;
  /** Names the server found for ids the before state leaves unnamed (ChangeDisplayView `names`). */
  names?: ChangeOptions["names"];
  /** The back office: an id nobody names shows as "#20". A client's card never shows one. */
  showIds?: boolean;
}) {
  const { t, fmt, locale } = useI18n();
  const model = changeModel(display, before, input, locale, {
    names,
    ...(showIds ? { showIds } : {}),
  });
  // A new record: everything it will have is new. An update: only what it changes.
  const changed = model.fields.filter((f) => model.create || f.changed);
  const unchanged = model.create ? [] : model.fields.filter((f) => !f.changed);
  const scalars = changed.filter((f) => !f.list);
  const lists = changed.filter((f) => f.list);
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="change">
      {model.create ? (
        <p className="text-sm text-ink-muted" data-testid="change-creates">
          {t("change.createsIt")}
        </p>
      ) : null}
      {scalars.length > 0 ? (
        <FieldsTable fields={scalars} create={model.create} />
      ) : changed.length === 0 ? (
        <p className="text-sm text-ink-muted" data-testid="change-nothing">
          {model.fields.length === 0 ? t("change.nothingRecorded") : t("change.noChange")}
        </p>
      ) : null}
      {lists.map((f) => (
        <ListField key={f.key} field={f} create={model.create} fold={!model.create && f.changed} />
      ))}
      {unchanged.length > 0 ? (
        <p className="text-sm text-ink-muted" data-testid="change-unchanged">
          <span className="font-medium text-ink">{t("change.unchanged")}</span>{" "}
          {unchanged.map((f, i) => (
            <span key={f.key} data-testid={`change-unchanged-${f.key}`}>
              {i > 0 ? " · " : null}
              {f.label}
              {f.list ? null : <span className="text-ink figures"> {valueText(f.now, fmt)}</span>}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

/** The plain fields the change sets: field, now, after this change (only after for a new record). */
function FieldsTable({ fields, create }: { fields: ChangeField[]; create: boolean }) {
  const { t, fmt } = useI18n();
  return (
    <div className="mz-sign__side overflow-x-auto" data-testid="change-fields">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line">
            <Th>{t("change.field")}</Th>
            {create ? null : <Th>{t("change.now")}</Th>}
            <Th>{create ? t("change.value") : t("change.after")}</Th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr
              key={f.key}
              data-testid={`change-row-${f.key}`}
              className="border-b border-line last:border-b-0"
            >
              <td className="px-1 py-2 align-top text-ink-muted">{f.label}</td>
              {create ? null : (
                <td
                  data-testid={`change-row-${f.key}-now`}
                  className="px-1 py-2 align-top break-words text-ink-muted figures"
                >
                  {valueText(f.now, fmt)}
                </td>
              )}
              <td
                data-testid={`change-row-${f.key}-after`}
                data-changed="true"
                className="px-1 py-2 align-top break-words font-medium text-ink figures"
              >
                <span className="rounded-sm bg-slate-tint px-1.5 py-0.5">
                  {valueText(f.after, fmt)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
