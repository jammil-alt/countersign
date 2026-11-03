// "What agents may do in each tool" (design screen 2): one row per connection, read / create /
// update / delete as auto, approval or off, plus the connector's scope. Edits collect in a draft
// and are saved together; a client admin is offered only the saved level or stricter.
import type { PermissionLevel, Verb } from "@countersign/core";
import { useState } from "react";
import { formatValue } from "../inbox/change";
import { Badge, Button, Card, cx, ErrorNotice } from "../ui/primitives";
import { allowedLevels, LEVEL_LABEL, levelTone, type MatrixEditor, VERBS } from "./matrix";

export interface MatrixRow {
  /** The connection id. */
  id: string;
  name: string;
  permissions: Record<Verb, PermissionLevel> & { scope?: unknown };
}

/** A row's edit: only the verbs that changed, and the scope when the operator changed it. */
export type MatrixRowEdit = Partial<Record<Verb, PermissionLevel>> & { scope?: unknown };

type Draft = Record<string, MatrixRowEdit>;

export function MatrixTable({
  rows,
  editor,
  onSave,
  note,
}: {
  rows: MatrixRow[];
  editor: MatrixEditor;
  /** Saves one connection's edit; rejects with the API's error. */
  onSave?: (id: string, edit: MatrixRowEdit) => Promise<void>;
  /** The line at the top right ("Approval means the change waits in your inbox…"). */
  note?: string;
}) {
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const editable = editor !== "viewer" && onSave !== undefined;
  const dirty = Object.values(draft).some((e) => Object.keys(e).length > 0);

  function set(row: MatrixRow, key: Verb | "scope", value: unknown) {
    setDraft((d) => {
      const edit: MatrixRowEdit = { ...(d[row.id] ?? {}) };
      const unchanged =
        key === "scope"
          ? (value ?? "") === (row.permissions.scope ?? "")
          : value === row.permissions[key];
      if (unchanged) delete edit[key];
      else (edit as Record<string, unknown>)[key] = value;
      return { ...d, [row.id]: edit };
    });
  }

  async function save() {
    if (!onSave) return;
    setBusy(true);
    setError(null);
    try {
      for (const [id, edit] of Object.entries(draft)) {
        if (Object.keys(edit).length > 0) await onSave(id, edit);
      }
      setDraft({});
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card testId="matrix" className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge px-4 py-3">
        <h3 className="label-caps text-secondary">What agents may do in each tool</h3>
        {note ? <p className="text-sm text-secondary">{note}</p> : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-subtle text-left">
              <th className="label-caps px-4 py-2 font-medium text-secondary">Tool</th>
              {VERBS.map((v) => (
                <th key={v} className="label-caps px-3 py-2 font-medium text-secondary">
                  {v}
                </th>
              ))}
              <th className="label-caps px-4 py-2 font-medium text-secondary">Scope</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const edit = draft[row.id] ?? {};
              return (
                <tr
                  key={row.id}
                  data-testid={`matrix-row-${row.id}`}
                  className="border-t border-divider"
                >
                  <td className="px-4 py-2.5 font-medium text-primary">{row.name}</td>
                  {VERBS.map((verb) => {
                    const saved = row.permissions[verb];
                    const current = edit[verb] ?? saved;
                    const options = editable ? allowedLevels(verb, saved, editor) : [];
                    return (
                      <td key={verb} className="px-3 py-2.5">
                        {options.length > 1 ? (
                          <LevelSelect
                            verb={verb}
                            value={current}
                            options={options}
                            changed={edit[verb] !== undefined}
                            onChange={(l) => set(row, verb, l)}
                          />
                        ) : (
                          <Badge tone={levelTone(current)} testId={`matrix-${verb}-level`}>
                            {LEVEL_LABEL[current]}
                          </Badge>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-4 py-2.5 text-body">
                    {editable && editor === "operator" && isTextScope(row.permissions.scope) ? (
                      <input
                        aria-label={`Scope for ${row.name}`}
                        data-testid="matrix-scope-input"
                        value={String(
                          (edit.scope as string | undefined) ?? row.permissions.scope ?? "",
                        )}
                        placeholder="Everything the connection reaches"
                        onChange={(e) => set(row, "scope", e.target.value || undefined)}
                        className="h-8 w-full min-w-48 rounded-sm border border-control bg-card px-2 text-sm"
                      />
                    ) : row.permissions.scope === undefined ? (
                      <span className="text-secondary">Everything the connection reaches</span>
                    ) : (
                      formatValue(row.permissions.scope)
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {error ? (
        <div className="px-4 pt-3">
          <ErrorNotice error={error} />
        </div>
      ) : null}
      {editable && dirty ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-edge px-4 py-3">
          <p className="text-sm text-secondary">
            {editor === "client_admin"
              ? "You can tighten these yourself. Only your operator can loosen them again."
              : "Changes apply to the next tool call, and are logged."}
          </p>
          <div className="flex gap-2">
            <Button
              data-testid="matrix-changes-discard"
              variant="ghost"
              disabled={busy}
              onClick={() => setDraft({})}
            >
              Discard
            </Button>
            <Button
              data-testid="matrix-changes-save"
              variant="primary"
              disabled={busy}
              onClick={() => void save()}
            >
              Save permissions
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function isTextScope(scope: unknown): boolean {
  return scope === undefined || typeof scope === "string";
}

function LevelSelect({
  verb,
  value,
  options,
  changed,
  onChange,
}: {
  verb: Verb;
  value: PermissionLevel;
  options: PermissionLevel[];
  changed: boolean;
  onChange: (level: PermissionLevel) => void;
}) {
  return (
    <select
      aria-label={verb}
      data-testid={`matrix-${verb}-select`}
      value={value}
      onChange={(e) => onChange(e.target.value as PermissionLevel)}
      className={cx(
        "label-caps h-7 rounded-sm border bg-card px-1.5",
        changed ? "border-action text-primary" : "border-control text-body",
      )}
    >
      {options.map((l) => (
        <option key={l} value={l}>
          {LEVEL_LABEL[l]}
        </option>
      ))}
    </select>
  );
}
