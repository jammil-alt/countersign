// FAQs and policies, as both surfaces show them (docs/plan.md §1.21): a list of entries, each
// editable in place, and a form to add one. The back office's Knowledge tab and the portal's
// Knowledge page pass their own routes in through `EntryActions`. Every save is a new version on
// the server; an edit from a version someone else has since changed is refused, and we say so.
// Words in the reader's language (docs/plan.md §1.18; English in the back office); the entries'
// titles and bodies are the client's own words and stay as written.
import {
  KNOWLEDGE_BODY_MAX,
  KNOWLEDGE_TITLE_MAX,
  type KnowledgeEntry,
  type KnowledgeEntryKind,
} from "@countersign/core";
import { type FormEvent, type ReactNode, useState } from "react";
import { isApiError } from "../api/client";
import type { PlainKey } from "../i18n/catalog";
import { type I18n, useI18n } from "../i18n/i18n";
import { Field, Select, TextArea, TextInput } from "../ui/forms";
import { Badge, Button, Card, EmptyState } from "../ui/primitives";

export interface EntryActions {
  create(input: { kind: KnowledgeEntryKind; title: string; body: string }): Promise<unknown>;
  edit(id: string, input: { title: string; body: string; baseVersion: number }): Promise<unknown>;
  archive(id: string, baseVersion: number): Promise<unknown>;
}

export const KIND_LABEL: Record<KnowledgeEntryKind, string> = { faq: "FAQ", policy: "Policy" };

const KIND_KEY: Record<KnowledgeEntryKind, PlainKey> = {
  faq: "knowledge.kind.faq",
  policy: "knowledge.kind.policy",
};

export function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function saveError(error: unknown, t: I18n["t"]): string {
  if (isApiError(error) && error.status === 409) {
    return error.code === "archived"
      ? t("knowledge.problem.archived")
      : t("knowledge.problem.changed");
  }
  return t("knowledge.problem.failed");
}

/** Who saved the current version: a name, or "us" for the operator on the portal. */
function byline(entry: KnowledgeEntry, us: string, i18n: I18n): string {
  const who =
    entry.updatedBy.name ??
    (entry.updatedBy.role === "operator" ? us : i18n.t("knowledge.yourTeam"));
  return i18n.t("knowledge.byline", {
    version: String(entry.version),
    who,
    date: i18n.fmt.date(entry.updatedAt),
  });
}

export function EntryForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  testId,
}: {
  initial?: KnowledgeEntry;
  submitLabel: string;
  onSubmit: (values: { kind: KnowledgeEntryKind; title: string; body: string }) => Promise<void>;
  onCancel?: () => void;
  testId: string;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState<KnowledgeEntryKind>(initial?.kind ?? "faq");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = title.trim().length > 0 && body.trim().length > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ kind, title: title.trim(), body: body.trim() });
      if (!initial) {
        setTitle("");
        setBody("");
      }
    } catch (err) {
      setError(saveError(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} data-testid={testId}>
      {initial ? null : (
        <Field label={t("knowledge.type")}>
          <Select
            data-testid={`${testId}-kind`}
            value={kind}
            onChange={(e) => setKind(e.target.value as KnowledgeEntryKind)}
          >
            <option value="faq">{t("knowledge.type.faq")}</option>
            <option value="policy">{t("knowledge.type.policy")}</option>
          </Select>
        </Field>
      )}
      <Field label={kind === "faq" ? t("knowledge.question") : t("knowledge.entryTitle")}>
        <TextInput
          data-testid={`${testId}-title`}
          value={title}
          maxLength={KNOWLEDGE_TITLE_MAX}
          placeholder={
            kind === "faq" ? t("knowledge.placeholder.question") : t("knowledge.placeholder.title")
          }
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field label={kind === "faq" ? t("knowledge.answer") : t("knowledge.policy")}>
        <TextArea
          data-testid={`${testId}-body`}
          rows={6}
          value={body}
          maxLength={KNOWLEDGE_BODY_MAX}
          placeholder={
            kind === "faq" ? t("knowledge.placeholder.answer") : t("knowledge.placeholder.policy")
          }
          onChange={(e) => setBody(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="primary"
          data-testid={`${testId}-save`}
          disabled={busy || !ready}
        >
          {busy ? t("knowledge.saving") : submitLabel}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
        ) : null}
        {error ? (
          <span className="ds-error text-sm" data-testid={`${testId}-error`}>
            {error}
          </span>
        ) : null}
      </div>
    </form>
  );
}

export function EntryList({
  entries,
  actions,
  onChanged,
  us,
  area,
  empty,
  extra,
}: {
  entries: KnowledgeEntry[];
  actions: EntryActions;
  onChanged: () => void;
  /** What the operator is called in bylines: "Mezonas" in the back office, "us" on the portal. */
  us: string;
  /** testid prefix. */
  area: string;
  empty: ReactNode;
  /** More controls on each card (the back office's history). */
  extra?: (entry: KnowledgeEntry) => ReactNode;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [editing, setEditing] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<{ id: string; message: string } | null>(null);

  if (entries.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="flex flex-col gap-4" data-testid={`${area}-entries`}>
      {entries.map((entry) => (
        <Card key={entry.id} testId={`${area}-entry-${entry.id}`} className="p-5">
          {editing === entry.id ? (
            <EntryForm
              initial={entry}
              submitLabel={
                entry.status === "archived" ? t("knowledge.saveAndRestore") : t("common.save")
              }
              testId={`${area}-edit`}
              onCancel={() => setEditing(null)}
              onSubmit={async (v) => {
                await actions.edit(entry.id, {
                  title: v.title,
                  body: v.body,
                  baseVersion: entry.version,
                });
                setEditing(null);
                onChanged();
              }}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-ink" data-testid={`${area}-entry-title`}>
                    {entry.title}
                  </p>
                  <p className="text-sm text-ink-muted">{byline(entry, us, i18n)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone="neutral">{t(KIND_KEY[entry.kind])}</Badge>
                  {entry.status === "archived" ? (
                    <Badge tone="neutral">{t("knowledge.archived")}</Badge>
                  ) : null}
                </div>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-ink">{entry.body}</p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  data-testid={`${area}-entry-edit`}
                  onClick={() => {
                    setArchiveError(null);
                    setEditing(entry.id);
                  }}
                >
                  {entry.status === "archived"
                    ? t("knowledge.editAndRestore")
                    : t("knowledge.edit")}
                </Button>
                {entry.status === "active" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid={`${area}-entry-archive`}
                    onClick={async () => {
                      setArchiveError(null);
                      try {
                        await actions.archive(entry.id, entry.version);
                        onChanged();
                      } catch (err) {
                        setArchiveError({ id: entry.id, message: saveError(err, t) });
                      }
                    }}
                  >
                    {t("knowledge.archive")}
                  </Button>
                ) : null}
                {extra?.(entry)}
                {archiveError?.id === entry.id ? (
                  <span className="ds-error text-sm">{archiveError.message}</span>
                ) : null}
              </div>
            </>
          )}
        </Card>
      ))}
    </div>
  );
}
