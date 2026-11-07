// The Desk's list (docs/design/prototype.html `#C3-Desk`, left column): entries by day ("Today",
// "Yesterday", a date), each with its agent, what kind of ask it is, when, and a chip that says in
// a word what it needs: Sign and Enter code in gold (waiting on you), Answer neutral, Done green.
import type { ReactNode } from "react";
import type { PlainKey } from "../i18n/catalog";
import { type I18n, useI18n } from "../i18n/i18n";
import { changeHeading } from "../inbox/change";
import { KIND_LABEL } from "../inbox/InboxCard";
import { AgentBadge } from "../ui/badges";
import { cx } from "../ui/primitives";
import { type ChipState, StatusChip } from "../ui/status";
import {
  byDay,
  type DeskEntry,
  type DeskItem,
  isBatch,
  isSnoozed,
  leadOf,
  needOf,
  signedInput,
  timeOf,
} from "./model";

/** An entry's title: the change as the client knows it, or the item's own title. */
export function entryTitle(entry: DeskEntry, { t, locale }: Pick<I18n, "t" | "locale">): string {
  const lead = leadOf(entry);
  const heading =
    lead.kind === "external_action" && typeof lead.payload.tool === "string"
      ? changeHeading(
          lead.display ?? null,
          lead.payload.tool,
          lead.payload.before,
          signedInput(lead.payload),
          locale,
        )
      : null;
  if (isBatch(entry)) {
    return t("desk.batch.title", {
      count: entry.items.length,
      what: heading?.connector ?? lead.title,
    });
  }
  return heading?.title ?? lead.title;
}

const NEED_CHIP: Record<ReturnType<typeof needOf>, { state: ChipState; key: PlainKey }> = {
  sign: { state: "waiting", key: "desk.chip.sign" },
  code: { state: "waiting", key: "desk.chip.code" },
  done: { state: "waiting", key: "desk.chip.todo" },
  answer: { state: "idle", key: "desk.chip.answer" },
  request: { state: "idle", key: "desk.chip.request" },
};

/**
 * An entry's accent (design pass), the colour of its chip: gold while it waits on you, green once
 * done; none for answers, requests, set-aside and expired items.
 */
export function entryTone(item: DeskItem, now: Date): "signal" | "positive" | undefined {
  if (item.status === "resolved") return "positive";
  if (item.status === "expired" || isSnoozed(item, now.getTime())) return undefined;
  return NEED_CHIP[needOf(item)].state === "waiting" ? "signal" : undefined;
}

function Chip({ item, now }: { item: DeskItem; now: Date }): ReactNode {
  const { t, fmt } = useI18n();
  if (item.status === "resolved") {
    return <StatusChip state="done">{t("desk.chip.done")}</StatusChip>;
  }
  if (item.status === "expired") {
    return <StatusChip state="idle">{t("common.expired")}</StatusChip>;
  }
  if (isSnoozed(item, now.getTime()) && item.snoozedUntil) {
    return (
      <StatusChip state="idle">
        {t("desk.chip.back", { time: fmt.time(item.snoozedUntil) })}
      </StatusChip>
    );
  }
  const chip = NEED_CHIP[needOf(item)];
  return <StatusChip state={chip.state}>{t(chip.key)}</StatusChip>;
}

export function DeskList({
  entries,
  selected,
  onSelect,
  now,
  empty,
  heading,
  testId,
}: {
  entries: readonly DeskEntry[];
  selected: string | null;
  onSelect: (entry: DeskEntry) => void;
  now: Date;
  /** Shown when there are no entries. */
  empty?: ReactNode;
  /** Instead of the day ("Done this week"). */
  heading?: ReactNode;
  testId?: string;
}) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  if (entries.length === 0) {
    return empty ? (
      <p className="px-5 py-4 text-sm text-ink-muted" data-testid={testId}>
        {empty}
      </p>
    ) : null;
  }
  const days = heading ? [{ day: "", first: "", entries: [...entries] }] : byDay(entries, now);
  return (
    <div data-testid={testId}>
      {days.map((d) => (
        <div key={d.day || "all"}>
          <p className="eyebrow border-b border-line px-5 py-2.5 text-ink-muted">
            {heading ??
              (d.day === "today"
                ? t("desk.day.today")
                : d.day === "yesterday"
                  ? t("desk.day.yesterday")
                  : fmt.date(d.first))}
          </p>
          <ul>
            {d.entries.map((e) => {
              const lead = leadOf(e);
              const agent = lead.service?.name ?? null;
              const kind = KIND_LABEL[lead.kind];
              const meta = [
                agent,
                isBatch(e)
                  ? t("desk.batch.count", { count: e.items.length })
                  : kind
                    ? t(kind)
                    : null,
                fmt.time(timeOf(lead)),
              ].filter(Boolean);
              const on = selected === e.key;
              return (
                <li key={e.key} className="border-b border-line">
                  <button
                    type="button"
                    data-testid={`desk-entry-${lead.id}`}
                    aria-current={on ? "true" : undefined}
                    onClick={() => onSelect(e)}
                    data-tone={entryTone(lead, now)}
                    className={cx(
                      "ui-accent ui-accent--left flex w-full flex-col gap-1.5 px-5 py-3.5 text-left",
                      on ? "bg-slate-tint" : "hover:bg-surface-subtle",
                    )}
                  >
                    {/* The chip wraps below when the agent and time need the room. */}
                    <span className="flex w-full flex-wrap items-center gap-2">
                      {agent ? <AgentBadge name={agent} seed={lead.service?.id} size="sm" /> : null}
                      <span className="min-w-32 flex-1 truncate text-sm text-ink-muted">
                        {meta.join(" · ")}
                      </span>
                      <Chip item={lead} now={now} />
                    </span>
                    <span className="text-sm font-medium text-ink">{entryTitle(e, i18n)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
