// B6 (docs/builder-plan.md §8): the client's charter, a policy's tags, and how our agents work, as
// both surfaces show them. The back office drafts the charter from onboarding's facts; the client
// admin confirms it or edits it in the portal. Agents read only its latest confirmed version, so a
// draft waiting on the client says which version they follow meanwhile. The charter and policies
// are the client's own words and stay as written; our words are in the reader's language.
import {
  GOVERNANCE_TAGS,
  type GovernanceTag,
  HOW_AGENTS_WORK,
  type KnowledgeEntry,
} from "@countersign/core";
import { type ReactNode, useState } from "react";
import type { PlainKey } from "../i18n/catalog";
import { useI18n } from "../i18n/i18n";
import { Badge, Button, Card, EmptyState } from "../ui/primitives";

/** The message key of a tag's words. */
export const tagKey = (tag: string): PlainKey => `governance.tag.${tag}` as PlainKey;

const isTag = (t: string): t is GovernanceTag => (GOVERNANCE_TAGS as readonly string[]).includes(t);

/** What a policy covers, as small neutral pills. */
export function TagList({ tags, testId }: { tags: readonly string[]; testId?: string }) {
  const { t } = useI18n();
  const known = tags.filter(isTag);
  if (known.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2" data-testid={testId}>
      {known.map((tag) => (
        <Badge key={tag} tone="neutral">
          {t(tagKey(tag))}
        </Badge>
      ))}
    </div>
  );
}

/** Pick what a policy covers: the standard topics and the business areas. */
export function TagPicker({
  value,
  onChange,
  testId,
}: {
  value: readonly string[];
  onChange: (tags: GovernanceTag[]) => void;
  testId: string;
}) {
  const { t } = useI18n();
  const chosen = new Set(value);
  return (
    <fieldset className="ds-field" data-testid={testId}>
      <legend className="text-sm leading-tight font-medium text-ink">{t("knowledge.tags")}</legend>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
        {GOVERNANCE_TAGS.map((tag) => (
          <label key={tag} className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="size-4 accent-[var(--slate)]"
              data-testid={`${testId}-${tag}`}
              checked={chosen.has(tag)}
              onChange={(e) => {
                const next = new Set(chosen);
                if (e.target.checked) next.add(tag);
                else next.delete(tag);
                onChange(GOVERNANCE_TAGS.filter((x) => next.has(x)));
              }}
            />
            {t(tagKey(tag))}
          </label>
        ))}
      </div>
      <span className="ds-help mt-1 text-sm">{t("knowledge.tagsHint")}</span>
    </fieldset>
  );
}

/** The client's active charter among the entries, if any. */
export function charterOf(entries: readonly KnowledgeEntry[]): KnowledgeEntry | null {
  return entries.find((e) => e.tier === "charter" && e.status === "active") ?? null;
}

/**
 * The charter's card: its text, whether it is confirmed (and which version agents follow while a
 * newer one waits), and the surface's buttons.
 */
export function CharterCard({
  entry,
  audience,
  area,
  actions,
  none,
}: {
  entry: KnowledgeEntry | null;
  /** The portal asks the client admin; the back office waits for them. */
  audience: "ops" | "portal";
  /** testid prefix. */
  area: string;
  /** Buttons beside the text (Confirm and Edit in the portal; Draft, Edit and History in ours). */
  actions?: ReactNode;
  /** What shows when there is no charter yet. */
  none: ReactNode;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  if (!entry) {
    return (
      <div data-testid={`${area}-charter-none`}>
        <EmptyState>{none}</EmptyState>
        {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    );
  }
  const confirmed = entry.confirmed;
  const following =
    !confirmed && entry.inUseVersion !== null && entry.inUseVersion !== undefined
      ? entry.inUseVersion
      : null;
  return (
    <Card className="p-5" testId={`${area}-charter`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="font-medium text-ink">{entry.title}</p>
        {confirmed ? (
          <Badge tone="positive" testId={`${area}-charter-status`}>
            {t("knowledge.charter.confirmed")}
          </Badge>
        ) : audience === "portal" ? (
          // Gold means waiting on you, always with a word.
          <Badge tone="warning" testId={`${area}-charter-status`}>
            {t("knowledge.charter.waiting")}
          </Badge>
        ) : (
          <Badge tone="neutral" testId={`${area}-charter-status`}>
            Waiting for the client to confirm
          </Badge>
        )}
      </div>
      <p className="mt-1 text-sm text-ink-muted" data-testid={`${area}-charter-line`}>
        {confirmed
          ? t("knowledge.charter.confirmedLine", {
              who: confirmed.by ?? t("knowledge.yourTeam"),
              date: i18n.fmt.date(confirmed.at),
            })
          : audience === "portal"
            ? t("knowledge.charter.waitingLine")
            : "The client admin confirms it in the portal. Agents follow it once they do."}
        {following !== null
          ? ` ${
              audience === "portal"
                ? t("knowledge.charter.inUse", { version: String(following) })
                : `Agents follow version ${following} meanwhile.`
            }`
          : null}
      </p>
      <p className="mt-3 whitespace-pre-wrap text-ink" data-testid={`${area}-charter-body`}>
        {entry.body}
      </p>
      {actions ? <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div> : null}
    </Card>
  );
}

/** "How Mezonas agents work": the guardrails in plain words, read only. */
export function HowAgentsWork({ testId }: { testId: string }) {
  const { t } = useI18n();
  return (
    <Card className="p-5" testId={testId}>
      <p className="font-medium text-ink">{t("howAgentsWork.title")}</p>
      <p className="mt-1 text-sm text-ink-muted">{t("howAgentsWork.intro")}</p>
      <ul className="mt-3 flex flex-col gap-3">
        {HOW_AGENTS_WORK.points.map((p) => (
          <li key={p.id}>
            <p className="text-sm font-medium text-ink">
              {t(`howAgentsWork.${p.id}.title` as PlainKey)}
            </p>
            <p className="text-sm text-ink-muted">{t(`howAgentsWork.${p.id}.body` as PlainKey)}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** A button that runs once at a time and says when it failed. */
export function ActionButton({
  label,
  busyLabel,
  failed,
  run,
  testId,
  variant,
  detail,
}: {
  label: string;
  busyLabel: string;
  failed: string;
  run: () => Promise<void>;
  testId: string;
  variant?: "primary" | undefined;
  /** Add the server's reason (the back office, in English); the portal says only `failed`. */
  detail?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        size="sm"
        {...(variant ? { variant } : {})}
        data-testid={testId}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await run();
          } catch (err) {
            setError(
              detail && err instanceof Error && err.message ? `${failed} ${err.message}` : failed,
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? busyLabel : label}
      </Button>
      {error ? (
        <span className="ds-error text-sm" data-testid={`${testId}-error`}>
          {error}
        </span>
      ) : null}
    </>
  );
}
