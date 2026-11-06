// "What agents may do in each tool" (design screen 2): one row per connection, read / create /
// update / delete as auto, approval or off, plus the connector's scope. Edits collect in a draft
// and are saved together; a client admin is offered only the saved level or stricter.
import type {
  EntityLevels,
  EntityPermissions,
  PermissionEntity,
  PermissionLevel,
  Verb,
} from "@countersign/core";
import { type ReactNode, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { formatValue } from "../inbox/change";
import { Select } from "../ui/forms";
import { Badge, Button, Card, cx, ErrorNotice } from "../ui/primitives";
import {
  allowedLevels,
  entityLevel,
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
  permissions: Record<Verb, PermissionLevel> & {
    scope?: unknown;
    entities?: EntityPermissions | undefined;
  };
  /** v0.12 W2-A: the connector's record types, shown as rows under the tool. */
  entities?: readonly PermissionEntity[] | undefined;
}

/**
 * A row's edit: only the verbs that changed, the scope when the operator changed it, and the
 * entities, whole, when any of them changed (v0.12 W2-A).
 */
export type MatrixRowEdit = Partial<Record<Verb, PermissionLevel>> & {
  scope?: unknown;
  entities?: EntityPermissions;
};

type Draft = Record<string, MatrixRowEdit>;

export function MatrixTable({
  rows,
  editor,
  onSave,
  note,
  bare,
}: {
  rows: MatrixRow[];
  editor: MatrixEditor;
  /** Saves one connection's edit; rejects with the API's error. */
  onSave?: (id: string, edit: MatrixRowEdit) => Promise<void>;
  /** The line at the top right ("Approval means the change waits in your inbox…"). */
  note?: string;
  /** Inside another card (the portal's Accounts page): no card and no title of its own. */
  bare?: boolean;
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

  // v0.12 W2-A: an entity's level or scope, kept in the edit as the row's whole `entities`.
  function setEntity(
    row: MatrixRow,
    entity: string,
    change: (levels: EntityLevels) => EntityLevels,
  ) {
    setDraft((d) => {
      const edit: MatrixRowEdit = { ...(d[row.id] ?? {}) };
      const saved = row.permissions.entities ?? {};
      const base = edit.entities ?? saved;
      const next: EntityPermissions = { ...base };
      const levels = change({ ...(Object.hasOwn(base, entity) ? base[entity] : {}) });
      if (Object.keys(levels).length === 0) delete next[entity];
      else next[entity] = levels;
      if (JSON.stringify(next) === JSON.stringify(saved)) delete edit.entities;
      else edit.entities = next;
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

  const Frame = bare ? BareFrame : Card;
  return (
    <Frame testId="matrix" className="overflow-hidden">
      {bare ? null : (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h3 className="eyebrow text-ink-muted">{t("matrix.title")}</h3>
          {note ? <p className="text-sm text-ink-muted">{note}</p> : null}
        </div>
      )}
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
            {rows.flatMap((row) => {
              const edit = draft[row.id] ?? {};
              return [
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
                </tr>,
                ...(row.entities ?? []).map((entity) => (
                  <EntityRow
                    key={`${row.id}:${entity.id}`}
                    row={row}
                    entity={entity}
                    edit={edit}
                    editor={editable ? editor : "viewer"}
                    onLevel={(verb, level) =>
                      setEntity(row, entity.id, (levels) => ({ ...levels, [verb]: level }))
                    }
                    onScope={(verb, scope) =>
                      setEntity(row, entity.id, (levels) => {
                        const scopes = { ...(levels.scope ?? {}) };
                        if (scope) scopes[verb] = scope;
                        else delete scopes[verb];
                        const { scope: _old, ...rest } = levels;
                        return Object.keys(scopes).length > 0 ? { ...rest, scope: scopes } : rest;
                      })
                    }
                  />
                )),
              ];
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
    </Frame>
  );
}

function BareFrame({
  children,
  className,
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className={className}>
      {children}
    </div>
  );
}

/**
 * v0.12 W2-A: one record type of a connection (docs/plan.md §1.44): per verb the level that applies
 * (the stricter of the verb's and the entity's own), and its scopes. A client admin is offered the
 * saved level or stricter, and may narrow to a scope where none is set; the operator any.
 */
function EntityRow({
  row,
  entity,
  edit,
  editor,
  onLevel,
  onScope,
}: {
  row: MatrixRow;
  entity: PermissionEntity;
  edit: MatrixRowEdit;
  editor: MatrixEditor;
  onLevel: (verb: Verb, level: PermissionLevel) => void;
  onScope: (verb: Verb, scope: string | undefined) => void;
}) {
  const { t } = useI18n();
  const saved = row.permissions;
  const current = { ...saved, ...edit, entities: edit.entities ?? saved.entities };
  const scopedVerbs = [...new Set((entity.scopes ?? []).map((s) => s.verb))];
  const own = (p: typeof saved, verb: Verb) => {
    const e = p.entities ?? {};
    return Object.hasOwn(e, entity.id) ? e[entity.id]?.scope?.[verb] : undefined;
  };
  return (
    <tr data-testid={`matrix-entity-${row.id}-${entity.id}`}>
      <td className="pl-8 text-ink-muted">{entity.label}</td>
      {VERBS.map((verb) => {
        if (!entity.verbs.includes(verb)) {
          return (
            <td key={verb} className="text-ink-muted">
              —
            </td>
          );
        }
        const savedLevel = entityLevel(saved, entity.id, verb);
        const level = entityLevel(current, entity.id, verb);
        const options = allowedLevels(verb, savedLevel, editor);
        return (
          <td key={verb}>
            {options.length > 1 ? (
              <LevelSelect
                verb={verb}
                value={level}
                options={options}
                testId={`matrix-entity-${entity.id}-${verb}-select`}
                changed={level !== savedLevel}
                onChange={(l) => onLevel(verb, l)}
              />
            ) : (
              <Badge tone={levelTone(level)} testId={`matrix-entity-${entity.id}-${verb}-level`}>
                {t(LEVEL_LABEL[level])}
              </Badge>
            )}
          </td>
        );
      })}
      <td className="text-ink">
        {scopedVerbs.length === 0 ? null : (
          <div className="flex flex-col gap-1">
            {scopedVerbs.map((verb) => {
              const savedScope = own(saved, verb);
              const value = own(current, verb);
              const scopes = (entity.scopes ?? []).filter((s) => s.verb === verb);
              // A client narrows to a scope where none is set; dropping one is the operator's.
              const choosing =
                editor === "operator" || (editor === "client_admin" && savedScope === undefined);
              const label = scopes.find((s) => s.id === value)?.label;
              return choosing ? (
                <Select
                  key={verb}
                  aria-label={`${entity.label} ${t(VERB_LABEL[verb])}`}
                  data-testid={`matrix-entity-${entity.id}-scope-select`}
                  value={value ?? ""}
                  onChange={(e) => onScope(verb, e.target.value || undefined)}
                  className={cx("h-8 min-w-40 text-sm", value !== savedScope && "border-slate")}
                >
                  <option value="">{t("matrix.everything")}</option>
                  {scopes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              ) : (
                <span key={verb} data-testid={`matrix-entity-${entity.id}-scope`}>
                  {label ?? <span className="text-ink-muted">{t("matrix.everything")}</span>}
                </span>
              );
            })}
          </div>
        )}
      </td>
    </tr>
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
  testId,
}: {
  verb: Verb;
  value: PermissionLevel;
  options: PermissionLevel[];
  changed: boolean;
  onChange: (level: PermissionLevel) => void;
  testId?: string;
}) {
  const { t } = useI18n();
  return (
    <Select
      aria-label={t(VERB_LABEL[verb])}
      data-testid={testId ?? `matrix-${verb}-select`}
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
