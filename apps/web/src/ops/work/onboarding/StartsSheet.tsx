// Saved starts (docs/cases-plan.md §4.3; docs/plan.md §1.125): Sign up now's and Invite's presets,
// each a name, what it covers, the lead's note and how the client starts. A few come seeded
// (General only, one per area, one per template, Just the account). Add, change, archive and
// restore; nothing is deleted.
// DECISION (§1.125, stream screens): the starts list is a side sheet opened from Sales' header
// ("Starts", beside Sign up now), not a page in Autopilot: starts are Sales' presets, and a sheet
// needs no new route.
import { type Covers, EMPTY_COVERS, type SalesStartView, type StartMode } from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../../api/routes";
import { useApi, useApiClient } from "../../../api/useApi";
import { cx } from "../../../ui/cx";
import { ErrorNotice } from "../../../ui/ErrorState";
import { Field, TextArea, TextInput } from "../../../ui/forms";
import { Button, Loading } from "../../../ui/primitives";
import { SideSheet } from "../../../ui/sheet";
import { CoversPicker, StartModePicker } from "./parts";
import { coversLine, START_MODE_WORDS } from "./words";

export function StartsSheet({ onClose }: { onClose(): void }) {
  const [archived, setArchived] = useState(false);
  const list = useApi(apiRoutes.opsStarts, {
    query: { archived: archived ? "true" : "false" },
    keep: true,
  });
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const starts = list.data?.starts ?? [];
  return (
    <SideSheet
      title="Starts"
      eyebrow={
        <span className="text-sm text-ink-muted">What Sign up now and Invite begin from</span>
      }
      onClose={onClose}
      testId="starts"
      wide
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <Button
            variant="ghost"
            aria-pressed={archived}
            onClick={() => setArchived((a) => !a)}
            data-testid="starts-archived"
          >
            {archived ? "Show what's offered" : "Show archived too"}
          </Button>
          <Button variant="primary" onClick={() => setEditing("new")} data-testid="starts-new">
            New start
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {editing === "new" ? (
          <StartForm
            onDone={() => {
              setEditing(null);
              list.reload();
            }}
            onCancel={() => setEditing(null)}
          />
        ) : null}
        {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
        {list.loading && !list.data ? <Loading /> : null}
        {list.data && starts.length === 0 ? (
          <p className="m-0 text-sm text-ink-muted">No starts yet.</p>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-3 p-0" data-testid="starts-list">
          {starts.map((s) =>
            editing === s.id ? (
              <li key={s.id}>
                <StartForm
                  start={s}
                  onDone={() => {
                    setEditing(null);
                    list.reload();
                  }}
                  onCancel={() => setEditing(null)}
                />
              </li>
            ) : (
              <StartRow
                key={s.id}
                start={s}
                onEdit={() => setEditing(s.id)}
                onChanged={list.reload}
              />
            ),
          )}
        </ul>
      </div>
    </SideSheet>
  );
}

function StartRow({
  start: s,
  onEdit,
  onChanged,
}: {
  start: SalesStartView;
  onEdit(): void;
  onChanged(): void;
}) {
  const api = useApiClient();
  const [error, setError] = useState<unknown>(null);
  async function archive(on: boolean) {
    setError(null);
    try {
      await api.call(apiRoutes.opsUpdateStart, { params: { id: s.id }, body: { archived: on } });
      onChanged();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <li
      className={cx("ds-card flex flex-col gap-2 p-4", s.archived && "opacity-60")}
      data-testid={`start-${s.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="block font-medium text-ink">{s.name}</span>
          <span className="block text-sm text-ink-muted">
            {coversLine(s.covers)} · {START_MODE_WORDS[s.startMode]}
          </span>
        </div>
        <span className="flex flex-wrap items-center gap-2">
          {s.seeded ? <span className="ds-tag">From Mezonas</span> : null}
          {s.archived ? <span className="ds-tag">Archived</span> : null}
        </span>
      </div>
      {s.note ? <p className="m-0 line-clamp-2 text-sm text-ink-muted">{s.note}</p> : null}
      {error ? <ErrorNotice error={error} /> : null}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className="ds-btn ds-btn--link text-sm"
          onClick={onEdit}
          data-testid={`start-${s.id}-edit`}
        >
          Change
        </button>
        <button
          type="button"
          className="ds-btn ds-btn--link text-sm"
          onClick={() => void archive(!s.archived)}
          data-testid={`start-${s.id}-archive`}
        >
          {s.archived ? "Offer it again" : "Archive"}
        </button>
      </div>
    </li>
  );
}

function StartForm({
  start,
  onDone,
  onCancel,
}: {
  start?: SalesStartView;
  onDone(): void;
  onCancel(): void;
}) {
  const api = useApiClient();
  const [name, setName] = useState(start?.name ?? "");
  const [covers, setCovers] = useState<Covers>(start?.covers ?? EMPTY_COVERS);
  const [note, setNote] = useState(start?.note ?? "");
  const [startMode, setStartMode] = useState<StartMode>(start?.startMode ?? "point");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), covers, note: note.trim(), startMode };
      if (start) {
        await api.call(apiRoutes.opsUpdateStart, { params: { id: start.id }, body });
      } else {
        await api.call(apiRoutes.opsCreateStart, { body });
      }
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="ds-card flex flex-col gap-4 p-4"
      data-testid="start-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void save();
      }}
    >
      <Field label="Name" hint='Such as "Purchasing starter"'>
        <TextInput
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          data-testid="start-name"
        />
      </Field>
      <CoversPicker value={covers} onChange={setCovers} testId="start-cover" />
      <Field
        label="Your note"
        hint="Opens the email and their Getting started page. Your name is filled in when it's sent."
      >
        <TextArea
          rows={3}
          value={note}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
          data-testid="start-note"
        />
      </Field>
      <StartModePicker value={startMode} onChange={setStartMode} testId="start-mode" />
      {error ? <ErrorNotice error={error} /> : null}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={busy || !name.trim()}
          data-testid="start-save"
        >
          {start ? "Save" : "Add the start"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
