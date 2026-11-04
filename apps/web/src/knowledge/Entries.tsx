// FAQs and policies, as both surfaces show them (docs/plan.md §1.21): a list of entries, each
// editable in place, and a form to add one. The back office's Knowledge tab and the portal's
// Knowledge page pass their own routes in through `EntryActions`. Every save is a new version on
// the server; an edit from a version someone else has since changed is refused, and we say so.
import {
  KNOWLEDGE_BODY_MAX,
  KNOWLEDGE_TITLE_MAX,
  type KnowledgeEntry,
  type KnowledgeEntryKind,
} from "@countersign/core";
import { type FormEvent, type ReactNode, useState } from "react";
import { isApiError } from "../api/client";
import { Field, Select, TextArea, TextInput } from "../ui/forms";
import { Badge, Button, Card, EmptyState } from "../ui/primitives";

export interface EntryActions {
  create(input: { kind: KnowledgeEntryKind; title: string; body: string }): Promise<unknown>;
  edit(id: string, input: { title: string; body: string; baseVersion: number }): Promise<unknown>;
  archive(id: string, baseVersion: number): Promise<unknown>;
}

export const KIND_LABEL: Record<KnowledgeEntryKind, string> = { faq: "FAQ", policy: "Policy" };

export function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function saveError(error: unknown): string {
  if (isApiError(error) && error.status === 409) {
    return error.code === "archived"
      ? "This is already archived."
      : "Someone changed this since you opened it. Reload to see the latest, then try again.";
  }
  return "We couldn't save it. Try again.";
}

/** Who saved the current version: a name, or "us" for the operator on the portal. */
function byline(entry: KnowledgeEntry, us: string): string {
  const who = entry.updatedBy.name ?? (entry.updatedBy.role === "operator" ? us : "your team");
  return `Version ${entry.version} · ${who} · ${when(entry.updatedAt)}`;
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
      setError(saveError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} data-testid={testId}>
      {initial ? null : (
        <Field label="Type">
          <Select
            data-testid={`${testId}-kind`}
            value={kind}
            onChange={(e) => setKind(e.target.value as KnowledgeEntryKind)}
          >
            <option value="faq">FAQ: a question and its answer</option>
            <option value="policy">Policy: how things are done</option>
          </Select>
        </Field>
      )}
      <Field label={kind === "faq" ? "Question" : "Title"}>
        <TextInput
          data-testid={`${testId}-title`}
          value={title}
          maxLength={KNOWLEDGE_TITLE_MAX}
          placeholder={kind === "faq" ? "e.g. When do you deliver?" : "e.g. Returns"}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field label={kind === "faq" ? "Answer" : "Policy"}>
        <TextArea
          data-testid={`${testId}-body`}
          rows={6}
          value={body}
          maxLength={KNOWLEDGE_BODY_MAX}
          placeholder={
            kind === "faq"
              ? "e.g. We deliver on Tuesdays and Thursdays."
              : "e.g. Unused boards can be returned within 30 days."
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
          {busy ? "Saving…" : submitLabel}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
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
              submitLabel={entry.status === "archived" ? "Save and restore" : "Save"}
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
                  <p className="text-sm text-ink-muted">{byline(entry, us)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone="neutral">{KIND_LABEL[entry.kind]}</Badge>
                  {entry.status === "archived" ? <Badge tone="neutral">Archived</Badge> : null}
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
                  {entry.status === "archived" ? "Edit and restore" : "Edit"}
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
                        setArchiveError({ id: entry.id, message: saveError(err) });
                      }
                    }}
                  >
                    Archive
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
