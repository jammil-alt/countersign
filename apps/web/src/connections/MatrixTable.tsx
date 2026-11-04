// "What agents may do in each tool" (design screen 2): one row per connection, read / create /
// update / delete as auto, approval or off, plus the connector's scope. Edits collect in a draft
// and are saved together; a client admin is offered only the saved level or stricter.
import type { PermissionLevel, Verb } from "@countersign/core";
import { useState } from "react";
import { useI18n } from "../i18n/i18n";
import { formatValue } from "../inbox/change";
import { Select } from "../ui/forms";
import { Badge, Button, Card, cx, ErrorNotice } from "../ui/primitives";
import {
  allowedLevels,
  LEVEL_LABEL,
  levelTone,
  type MatrixEditor,
  VERB_LABEL,
  VERBS,
} from "./matrix";

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
  const { t } = useI18n();
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
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <h3 className="eyebrow text-ink-muted">{t("matrix.title")}</h3>
        {note ? <p className="text-sm text-ink-muted">{note}</p> : null}
      </div>
      {/* The Mezonas TableAnalytical layout (dt-ana), inside the card. */}
      <div className="dt dt-ana overflow-x-auto rounded-none border-0">
        <table>
          <thead>
            <tr className="dt-cols">
              <th>{t("matrix.tool")}</th>
              {VERBS.map((v) => (
                <th key={v}>{t(VERB_LABEL[v])}</th>
              ))}
              <th>{t("matrix.scope")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const edit = draft[row.id] ?? {};
              return (
                <tr key={row.id} data-testid={`matrix-row-${row.id}`}>
                  <td className="font-medium text-ink">{row.name}</td>
                  {VERBS.map((verb) => {
                    const saved = row.permissions[verb];
                    const current = edit[verb] ?? saved;
                    const options = editable ? allowedLevels(verb, saved, editor) : [];
                    return (
                      <td key={verb}>
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
                            {t(LEVEL_LABEL[current])}
                          </Badge>
                        )}
                      </td>
                    );
                  })}
                  <td className="text-ink">
                    {editable && editor === "operator" && isTextScope(row.permissions.scope) ? (
                      <input
                        aria-label={t("matrix.scopeFor", { name: row.name })}
                        data-testid="matrix-scope-input"
                        value={String(
                          (edit.scope as string | undefined) ?? row.permissions.scope ?? "",
                        )}
                        placeholder={t("matrix.everything")}
                        onChange={(e) => set(row, "scope", e.target.value || undefined)}
                        className="ds-input h-8 min-w-48 text-sm"
                      />
                    ) : row.permissions.scope === undefined ? (
                      <span className="text-ink-muted">{t("matrix.everything")}</span>
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
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
          <p className="text-sm text-ink-muted">
            {editor === "client_admin" ? t("matrix.tightenNote") : t("matrix.operatorNote")}
          </p>
          <div className="flex gap-2">
            <Button
              data-testid="matrix-changes-discard"
              variant="ghost"
              disabled={busy}
              onClick={() => setDraft({})}
            >
              {t("matrix.discard")}
            </Button>
            <Button
              data-testid="matrix-changes-save"
              variant="primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {t("matrix.save")}
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
  const { t } = useI18n();
  return (
    <Select
      aria-label={t(VERB_LABEL[verb])}
      data-testid={`matrix-${verb}-select`}
      value={value}
      onChange={(e) => onChange(e.target.value as PermissionLevel)}
      className={cx("h-8 w-32 text-sm", changed && "border-slate")}
    >
      {options.map((l) => (
        <option key={l} value={l}>
          {t(LEVEL_LABEL[l])}
        </option>
      ))}
    </Select>
  );
}
