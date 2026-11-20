// Connectors C5 (docs/connectors-plan.md §3.2): What agents can do on a connection, in two groups as
// Claude's connectors show them: Read (On or Off) and Change (Ask me first or Off; On its own only
// where it is already set). A row per record type and verb, each folding open to the tools behind
// it and the agents that use it. Delete never appears. A client admin changes rows (each click is
// saved); a client user reads them.
import type { AccessRowView, PermissionLevel } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { isApiError } from "../../api/client";
import { useI18n } from "../../i18n/i18n";
import { Icon } from "../../ui/icons";
import { Badge, cx, ErrorNotice, Tag } from "../../ui/primitives";
import { PORTAL_PATHS } from "../paths";
import { groupEdit, groupLevel, type MatrixEditInput, rowEdit } from "./edit";
import { levelKey } from "./words";

const ORDER: PermissionLevel[] = ["auto", "approval", "off"];

export function rowKey(r: Pick<AccessRowView, "verb" | "entity">): string {
  return `${r.verb}-${r.entity ?? "all"}`;
}

/** The levels a row offers: what the viewer may set, and the level it has now. */
function offered(row: Pick<AccessRowView, "level" | "choices">): PermissionLevel[] {
  return ORDER.filter((l) => l === row.level || row.choices.includes(l));
}

/** The refused rows of a 422 `not_allowed`, in the API's words, when it sent them. */
function refusedWords(e: unknown): string[] {
  if (!isApiError(e) || e.status !== 422) return [];
  // The API's error body: { error: { code, message, details: { refused: [{ row, reason }] } } }.
  const body = e.body as { error?: { details?: { refused?: { reason?: unknown }[] } } } | undefined;
  return (body?.error?.details?.refused ?? [])
    .map((r) => r.reason)
    .filter((r): r is string => typeof r === "string");
}

export function AccessGroups({
  read,
  change,
  mayEdit,
  forAgentId,
  onSave,
  testId,
}: {
  read: AccessRowView[];
  change: AccessRowView[];
  /** A client admin on a connected tool; else the rows are words. */
  mayEdit: boolean;
  /** `?for=`: that agent's needs come first in the rows' tags. */
  forAgentId?: string | null;
  /** Saves an edit; the page shows the connection as the API answers. */
  onSave?: (edit: MatrixEditInput) => Promise<void>;
  testId?: string;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const all = [...read, ...change];
  const editable = mayEdit && !!onSave;

  async function save(edit: MatrixEditInput) {
    if (!onSave) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(edit);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const refused = refusedWords(error);
  return (
    <div className="flex flex-col gap-6" data-testid={testId}>
      <Group
        name="read"
        title={t("connectors.read.title")}
        help={t("connectors.read.help")}
        empty={t("connectors.read.none")}
        rows={read}
        all={all}
        editable={editable}
        busy={busy}
        forAgentId={forAgentId ?? null}
        onSave={save}
      />
      <Group
        name="change"
        title={t("connectors.change.title")}
        help={t("connectors.change.help")}
        empty={t("connectors.change.none")}
        side={t("connectors.change.deleteOff")}
        rows={change}
        all={all}
        editable={editable}
        busy={busy}
        forAgentId={forAgentId ?? null}
        onSave={save}
      />
      {change.length > 0 ? (
        <p className="text-sm text-ink-muted">{t("connectors.change.aloneNote")}</p>
      ) : null}
      {error ? (
        refused.length > 0 ? (
          <ul className="ds-banner flex-col gap-1 text-sm" data-testid="access-refused">
            {refused.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : (
          <ErrorNotice error={error} />
        )
      ) : null}
    </div>
  );
}

function Group({
  name,
  title,
  help,
  empty,
  side,
  rows,
  all,
  editable,
  busy,
  forAgentId,
  onSave,
}: {
  name: "read" | "change";
  title: string;
  help: string;
  empty: string;
  side?: string;
  rows: AccessRowView[];
  all: AccessRowView[];
  editable: boolean;
  busy: boolean;
  forAgentId: string | null;
  onSave: (edit: MatrixEditInput) => Promise<void>;
}) {
  const level = groupLevel(rows);
  const verb = name === "read" ? "read" : "create";
  const groupChoices: PermissionLevel[] = name === "read" ? ["auto", "off"] : ["approval", "off"];
  return (
    <section data-testid={`access-group-${name}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-t-md border border-b-0 border-line bg-surface-subtle px-4 py-3">
        <div className="min-w-0">
          <h3 className="type-subheading text-ink">{title}</h3>
          <p className="text-sm text-ink-muted">{help}</p>
        </div>
        {editable && rows.length > 0 ? (
          <Seg
            label={title}
            levels={groupChoices}
            verb={verb}
            pressed={level}
            disabled={busy}
            testId={`access-group-${name}-control`}
            onPick={(l) => void onSave(groupEdit(all, rows, l))}
          />
        ) : side ? (
          <span className="text-sm text-ink-muted">{side}</span>
        ) : null}
      </div>
      <div className="overflow-hidden rounded-b-md border border-line bg-surface">
        {rows.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-muted">{empty}</p>
        ) : (
          rows.map((r) => (
            <Row
              key={rowKey(r)}
              row={r}
              editable={editable}
              busy={busy}
              forAgentId={forAgentId}
              onPick={(l) => void onSave(rowEdit(all, r, l))}
            />
          ))
        )}
      </div>
      {editable && side ? <p className="mt-2 text-sm text-ink-muted">{side}</p> : null}
    </section>
  );
}

function Row({
  row,
  editable,
  busy,
  forAgentId,
  onPick,
}: {
  row: AccessRowView;
  editable: boolean;
  busy: boolean;
  forAgentId: string | null;
  onPick: (level: PermissionLevel) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const key = rowKey(row);
  // The picked agent first: "Buyer needs this".
  const needers = [...row.neededBy].sort(
    (a, b) => Number(b.id === forAgentId) - Number(a.id === forAgentId),
  );
  const toolsLine =
    row.tools.length === 1
      ? (row.tools[0]?.id ?? "")
      : t("connectors.row.tools", { count: row.tools.length });
  return (
    <div
      className="border-t border-line first:border-t-0"
      data-testid={`access-row-${key}`}
      data-needed={needers.length > 0 ? "true" : undefined}
    >
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          data-testid={`access-row-${key}-open`}
        >
          <Icon
            name={open ? "chevron-down" : "chevron-right"}
            size={16}
            className="mt-0.5 shrink-0 text-ink-muted"
          />
          <span className="min-w-0">
            <span className="block font-medium text-ink">{row.label}</span>
            {row.tools.length > 0 ? (
              <span className="block font-mono text-xs text-ink-muted">{toolsLine}</span>
            ) : null}
            {row.scope ? (
              <span className="block text-sm text-ink-muted">
                {t("connectors.row.scope", { scope: row.scope.label })}
              </span>
            ) : null}
          </span>
        </button>
        {needers.length > 0 ? (
          <Badge tone="warning" testId={`access-row-${key}-needed`}>
            {t("connectors.row.needs", { names: needers.map((a) => a.name).join(", ") })}
          </Badge>
        ) : row.usedBy.length > 0 ? (
          <Tag testId={`access-row-${key}-used`}>{row.usedBy.map((a) => a.name).join(", ")}</Tag>
        ) : null}
        {editable ? (
          <Seg
            label={row.label}
            levels={offered(row)}
            verb={row.verb}
            pressed={row.level}
            disabled={busy}
            testId={`access-row-${key}-control`}
            onPick={(l) => {
              if (l !== row.level) onPick(l);
            }}
          />
        ) : (
          <Badge testId={`access-row-${key}-level`}>{t(levelKey(row.verb, row.level))}</Badge>
        )}
      </div>
      {open ? (
        <div
          className="flex flex-col gap-3 border-t border-line bg-surface-subtle px-4 py-3 pl-10 text-sm"
          data-testid={`access-row-${key}-detail`}
        >
          <div>
            <h4 className="eyebrow mb-1 text-ink-muted">{t("connectors.row.toolsTitle")}</h4>
            {row.tools.length === 0 ? (
              <p className="text-ink-muted">{t("connectors.row.noTools")}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {row.tools.map((tool) => (
                  <li key={tool.id} className="flex flex-wrap gap-x-3">
                    <span className="text-ink">{tool.description}</span>
                    <span className="font-mono text-xs text-ink-muted">{tool.id}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h4 className="eyebrow mb-1 text-ink-muted">{t("connectors.row.agentsTitle")}</h4>
            {row.usedBy.length === 0 && row.neededBy.length === 0 ? (
              <p className="text-ink-muted">{t("connectors.row.noAgents")}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {row.usedBy.map((a) => (
                  <li key={`u-${a.id}`}>
                    <Link className="text-link hover:underline" to={PORTAL_PATHS.agent(a.id)}>
                      {a.name}
                    </Link>{" "}
                    <span className="text-ink-muted">{t("connectors.row.uses")}</span>
                  </li>
                ))}
                {row.neededBy.map((a) => (
                  <li key={`n-${a.id}`}>
                    <Link className="text-link hover:underline" to={PORTAL_PATHS.agent(a.id)}>
                      {a.name}
                    </Link>{" "}
                    <span className="text-signal-ink">{t("connectors.row.needsIt")}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The design system's segmented control: one button per level, the current one pressed. */
function Seg({
  label,
  levels,
  verb,
  pressed,
  disabled,
  testId,
  onPick,
}: {
  label: string;
  levels: PermissionLevel[];
  verb: AccessRowView["verb"];
  pressed: PermissionLevel | null;
  disabled: boolean;
  testId: string;
  onPick: (level: PermissionLevel) => void;
}) {
  const { t } = useI18n();
  return (
    <fieldset
      className={cx("ds-seg shrink-0", disabled && "opacity-70")}
      data-testid={testId}
      disabled={disabled}
    >
      <legend className="sr-only">{label}</legend>
      {levels.map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={pressed === l}
          data-testid={`${testId}-${l}`}
          className="whitespace-nowrap"
          onClick={() => onPick(l)}
        >
          {t(levelKey(verb, l))}
        </button>
      ))}
    </fieldset>
  );
}
