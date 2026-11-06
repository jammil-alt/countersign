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
}: {
  before: unknown;
  input: unknown;
  /** The tool's display spec, when it declares one. */
  display?: ToolDisplay | null | undefined;
}) {
  const { t, locale } = useI18n();
  const model = changeModel(display, before, input, locale);
  const scalars = model.fields.filter((f) => !f.list);
  const lists = model.fields.filter((f) => f.list);
  return (
    <div className="flex flex-col gap-3">
      {scalars.length > 0 || lists.length === 0 ? (
        <div className="mz-sign__change">
          <Side
            testId="change-now"
            title={t("change.now")}
            fields={scalars}
            pick="now"
            empty={model.create ? t("change.createsIt") : t("change.nothingRecorded")}
            hideAll={model.create}
          />
          <Side
            testId="change-after"
            title={t("change.after")}
            fields={scalars}
            pick="after"
            empty={t("change.noFields")}
          />
        </div>
      ) : null}
      {lists.map((f) => (
        <ListField key={f.key} field={f} create={model.create} />
      ))}
    </div>
  );
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

/** A list field (lines, files, records): its own now and after tables, stacked. */
function ListField({ field, create }: { field: ChangeField; create: boolean }) {
  const { t } = useI18n();
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
        value={create ? { type: "none" } : field.now}
        side="now"
        empty={create ? t("change.createsIt") : t("change.noneYet")}
      />
      <ListSide
        testId={`change-${field.key}-after`}
        title={t("change.after")}
        value={field.after}
        side="after"
        empty={t("change.noneYet")}
      />
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
