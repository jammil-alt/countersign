// Getting started's setup checklists (docs/builder-plan.md §6, B4): a card per agent with what it
// needs from the client before its trial and before go-live: connect a tool (the Accounts page's
// own flow), answer a question, send a file, confirm a decision. The client admin answers here;
// others see where things stand. Read from and written to `/api/setup`: the items' own words and
// who did them, never the agent's version (invariant 11). Answers are the client's words: data.
import {
  type PortalSetupAgent,
  type SetupGuard,
  type SetupRowView,
  setupRoutes,
} from "@countersign/core";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { attachToMessage } from "../../api/upload";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { useSession } from "../../session/session";
import { Select, TextInput } from "../../ui/forms";
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  PageHeader,
  SectionLabel,
  Tag,
} from "../../ui/primitives";

const GUARD: Record<SetupGuard, "start.setup.beforeTrial" | "start.setup.beforeLive"> = {
  setup: "start.setup.beforeTrial",
  trial: "start.setup.beforeTrial",
  live: "start.setup.beforeLive",
};

/**
 * Every agent with a checklist, under the intake's cards. With none: `empty` once read (nothing
 * while it loads). With no intake open, `header` puts the page's title above them.
 */
export function SetupChecklists({
  header = false,
  empty = null,
}: {
  header?: boolean;
  empty?: ReactNode;
}) {
  const { t } = useI18n();
  const state = useApi(setupRoutes.portalSetup);
  const [agents, setAgents] = useState<PortalSetupAgent[] | null>(null);
  const list = agents ?? state.data?.agents ?? [];
  if (list.length === 0) return state.data || state.error ? empty : null;
  const replace = (next: PortalSetupAgent) =>
    setAgents(list.map((a) => (a.agentId === next.agentId ? next : a)));
  return (
    <section className="flex flex-col gap-4" data-testid="start-setup">
      {header ? <PageHeader title={t("start.title")} /> : null}
      <div>
        <h2 className="text-lg text-ink">{t("start.setup.title")}</h2>
        <p className="text-ink-muted">{t("start.setup.intro")}</p>
      </div>
      {list.map((a) => (
        <AgentSetup key={a.agentId} agent={a} onChanged={replace} />
      ))}
    </section>
  );
}

function AgentSetup({
  agent,
  onChanged,
}: {
  agent: PortalSetupAgent;
  onChanged(next: PortalSetupAgent): void;
}) {
  const { t } = useI18n();
  const session = useSession();
  const isAdmin =
    (session.tenants.find((c) => c.id === session.activeTenantId) ?? session.tenants[0])?.role ===
    "client_admin";
  const { setup } = agent;
  const waiting = setup.holds.trial || setup.holds.live;
  return (
    <Card className="p-5" testId={`start-setup-${agent.agentId}`}>
      <SectionLabel>
        <span className="flex flex-wrap items-center gap-2">
          {agent.name}
          <Badge tone={setup.done === setup.total ? "positive" : "neutral"}>
            {t("start.setup.count", { done: String(setup.done), total: String(setup.total) })}
          </Badge>
        </span>
      </SectionLabel>
      {waiting ? (
        <p className="text-ink" data-testid="start-setup-holds">
          {setup.holds.trial ? t("start.setup.holdsTrial") : t("start.setup.holdsLive")}
        </p>
      ) : null}
      {!isAdmin ? <p className="text-sm text-ink-muted">{t("start.setup.adminOnly")}</p> : null}
      <ul className="mt-3 flex flex-col gap-3">
        {setup.items.map((row) => (
          <SetupItem
            key={row.id}
            agentId={agent.agentId}
            row={row}
            canAnswer={isAdmin}
            onChanged={onChanged}
          />
        ))}
      </ul>
    </Card>
  );
}

function SetupItem({
  agentId,
  row,
  canAnswer,
  onChanged,
}: {
  agentId: string;
  row: SetupRowView;
  canAnswer: boolean;
  onChanged(next: PortalSetupAgent): void;
}) {
  const { t, fmt } = useI18n();
  const api = useApiClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.value ?? row.suggested ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function send(body: { value?: string; files?: string[] }) {
    setBusy(true);
    setError(null);
    try {
      const out = await api.call(setupRoutes.portalSetupItem, {
        params: { id: agentId, itemId: row.id },
        body,
      });
      setEditing(false);
      onChanged(out.agent);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function addFiles(files: File[]) {
    if (files.length === 0) return;
    setError(null);
    try {
      const out = await attachToMessage(files);
      if (out.files.length > 0) await send({ files: out.files.map((f) => f.id) });
      if (out.refused.length > 0) setError(new Error(out.refused.join(" ")));
    } catch (e) {
      setError(e);
    }
  }

  const who =
    row.done && !row.byConnection && row.at
      ? row.side === "operator" || !row.byName
        ? t("start.setup.byUs", { date: fmt.date(row.at) })
        : t("start.setup.byName", { name: row.byName, date: fmt.date(row.at) })
      : null;
  const open = canAnswer && !row.byConnection && (!row.done || editing);

  return (
    <li className="border-b border-line pb-3" data-testid={`start-setup-item-${row.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink">{row.label}</span>
        <Tag>{t(GUARD[row.guards])}</Tag>
        {row.done ? (
          <Badge tone="positive">
            {row.byConnection ? t("start.setup.connected") : t("start.setup.done")}
          </Badge>
        ) : (
          <Badge tone="warning">{t("start.setup.waiting")}</Badge>
        )}
      </div>
      {row.hint ? <p className="text-sm text-ink-muted">{row.hint}</p> : null}
      {row.done && row.value && row.kind !== "connect" ? (
        <p className="text-sm text-ink" data-testid={`start-setup-value-${row.id}`}>
          {row.value}
        </p>
      ) : null}
      {who ? <p className="text-sm text-ink-muted">{who}</p> : null}
      {!row.done && row.suggested ? (
        <p className="text-sm text-ink-muted">
          {t("start.setup.suggested", { value: row.suggested })}
        </p>
      ) : null}
      {!row.done && row.min && row.max ? (
        <p className="text-sm text-ink-muted">
          {t("start.setup.range", { min: row.min, max: row.max })}
        </p>
      ) : null}
      {row.setsValue && open ? (
        <p className="text-sm text-ink-muted">{t("start.setup.setsValue")}</p>
      ) : null}

      {row.byConnection && !row.done && canAnswer ? (
        <Link className="ds-btn ds-btn--primary ds-btn--sm mt-2" to="/accounts">
          {t("start.setup.connect")}
        </Link>
      ) : null}
      {open && row.kind === "file" ? (
        <label className="ds-btn ds-btn--secondary ds-btn--sm mt-2">
          {t("start.setup.addFile")}
          <input
            type="file"
            className="sr-only"
            multiple
            data-testid={`start-setup-file-${row.id}`}
            disabled={busy}
            onChange={(e) => void addFiles([...(e.target.files ?? [])])}
          />
        </label>
      ) : null}
      {open && (row.kind === "answer" || row.kind === "confirm" || row.kind === "connect") ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          {row.options ? (
            <Select
              className="w-60"
              aria-label={row.label}
              data-testid={`start-setup-input-${row.id}`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            >
              <option value="" />
              {row.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          ) : (
            <TextInput
              aria-label={row.label}
              data-testid={`start-setup-input-${row.id}`}
              value={value}
              maxLength={2000}
              placeholder={row.kind === "answer" ? t("start.setup.answer") : t("start.setup.note")}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
          <Button
            data-testid={`start-setup-save-${row.id}`}
            disabled={busy || (row.kind === "answer" && !value.trim())}
            onClick={() => void send(value.trim() ? { value: value.trim() } : {})}
          >
            {row.kind === "answer" ? t("start.setup.save") : t("start.setup.confirm")}
          </Button>
        </div>
      ) : null}
      {canAnswer && row.done && !row.byConnection && !editing ? (
        <Button
          variant="ghost"
          data-testid={`start-setup-change-${row.id}`}
          onClick={() => setEditing(true)}
        >
          {t("start.setup.change")}
        </Button>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
    </li>
  );
}
