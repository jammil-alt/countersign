// O3 Connectors (`#O3-Connectors` → `/ops/connectors`; ARCHITECTURE §6.1 "Connectors catalog",
// docs/plan.md §1.44): every registered connector in one table (kind, status, clients connected,
// tools, errors in the last 24 hours), filtered by status; the selected one in the rail with its
// status and note (the operator sets them), the tools it gives agents, the default access a new
// client's connection starts with, who is waiting to connect, and whether a client is offered it.
// Below, the default access matrix with entities (never looser than the platform's defaults).
// Clients sign in to their own tools in the portal; we never see their credentials.
// R8: the Library's Connectors bank (`/ops/library/connectors`), with a search over names,
// descriptions and tools; website logins are connectors too (`/ops/library/browser-sites`).
//
// Plain words (2026-11-12): each row reads by its name and one line (`connectorLine`); the row opens the
// connector in a side sheet (its whole description, status and note, tools, default access, who
// waits, offer), as the Skills and Tools banks do, in place of the rail beside the table.
import { CONNECTOR_STATUS_VALUES, type ConnectorStatus } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ConnectorMark } from "../../connections/ConnectorMark";
import { MatrixTable } from "../../connections/MatrixTable";
import { useSession } from "../../session/session";
import { saysMore } from "../../ui/brief";
import { Field, Select, TextInput } from "../../ui/forms";
import { Page, Section } from "../../ui/page";
import {
  Badge,
  Button,
  buttonClass,
  Card,
  cx,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  Tag,
} from "../../ui/primitives";
import { SheetSection, SideSheet } from "../../ui/sheet";
import { type ChipState, StatusChip } from "../../ui/status";
import { BankSearch } from "../library/LibraryFrame";
import { matches } from "../library/paths";
import { connectorLine, toolName } from "../library/plain";
import { OPS_PATHS } from "../paths";

type Connector = ResponseOf<typeof apiRoutes.opsConnectors>["connectors"][number];
type SetBody = {
  status?: ConnectorStatus;
  note?: string;
  defaultPermissions?: Connector["defaultAccess"]["matrix"] | null;
};

const STATUS_LABEL: Record<ConnectorStatus, string> = {
  live: "Live",
  beta: "Beta",
  in_review: "In review",
  building: "Building",
};

// DECISION: a connector's status as a chip: live = done (positive), beta = running (slate, in
// use while we finish it), in review = waiting (a review we wait on, said in words), building =
// setting up (neutral); not set up on this deployment = idle.
const STATUS_CHIP: Record<ConnectorStatus, ChipState> = {
  live: "done",
  beta: "running",
  in_review: "waiting",
  building: "setup",
};

const SOURCE_LABEL: Record<Connector["defaultAccess"]["source"], string> = {
  operator: "Set by you",
  connector: "The connector's",
  platform: "Platform defaults",
};

const KIND_LABEL: Record<Connector["auth"], string> = {
  oauth2: "API · OAuth",
  api_key: "API · key",
  none: "Built in",
};

function ConnectorStatusChip({
  status,
  testId,
}: {
  status: ConnectorStatus | null;
  testId?: string | undefined;
}) {
  return status === null ? (
    <StatusChip state="idle" {...(testId ? { testId } : {})}>
      Not set up
    </StatusChip>
  ) : (
    <StatusChip state={STATUS_CHIP[status]} {...(testId ? { testId } : {})}>
      {STATUS_LABEL[status]}
    </StatusChip>
  );
}

function errorWords(c: Connector): string | null {
  const parts = [
    c.errors.toolCalls > 0
      ? `${c.errors.toolCalls} failed ${c.errors.toolCalls === 1 ? "call" : "calls"}`
      : null,
    c.errors.connections > 0
      ? `${c.errors.connections} ${c.errors.connections === 1 ? "connection" : "connections"} in error`
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

export function OpsConnectorsScreen() {
  const api = useApiClient();
  const { data, error, loading, reload } = useApi(apiRoutes.opsConnectors);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [filter, setFilter] = useState<ConnectorStatus | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!data) return null;

  async function put(id: string, body: SetBody) {
    setSaveError(null);
    try {
      await api.call(apiRoutes.opsSetConnector, { params: { id }, body });
      reload();
    } catch (e) {
      setSaveError(e);
      throw e;
    }
  }

  const all = data.connectors;
  const shown = (filter === "all" ? all : all.filter((c) => c.status === filter)).filter((c) =>
    matches(search, c.name, c.id, c.description, ...c.tools.map((t) => t.id)),
  );
  const selected = selectedId ? all.find((c) => c.id === selectedId) : undefined;
  const filters: [ConnectorStatus | "all", string][] = [
    ["all", `All · ${all.length}`],
    ...CONNECTOR_STATUS_VALUES.filter((s) => all.some((c) => c.status === s)).map(
      (s): [ConnectorStatus, string] => [
        s,
        `${STATUS_LABEL[s]} · ${all.filter((c) => c.status === s).length}`,
      ],
    ),
  ];

  return (
    <Page testId="ops-connectors">
      <PageHeader
        title="Connectors"
        subtitle="The systems an agent can work in, such as QuickBooks or Gmail. Each gives agents a set of tools. Clients sign in to their own; we never see their credentials."
        actions={
          <Link to={OPS_PATHS.browserSites} className={buttonClass("secondary")}>
            Allowed browser sites
          </Link>
        }
      />
      <div className="-mt-2 flex flex-wrap items-center justify-between gap-3">
        <div className="ds-seg flex-wrap" data-testid="connectors-filter">
          {filters.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              data-testid={`connectors-filter-${value}`}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <BankSearch
          value={search}
          onChange={setSearch}
          label="Search connectors"
          testId="connectors-search"
        />
      </div>
      {saveError ? <ErrorNotice error={saveError} /> : null}
      {all.length === 0 ? (
        <EmptyState>No connector is registered here.</EmptyState>
      ) : (
        <>
          {selected ? (
            <ConnectorPanel
              // A new selection starts with its own note.
              key={selected.id}
              connector={selected}
              onSave={(body) => put(selected.id, body)}
              onOffered={reload}
              onClose={() => setSelectedId(null)}
            />
          ) : null}
          <Card>
            <div className="dt dt-ana overflow-x-auto">
              <table data-testid="connectors-table">
                <thead>
                  <tr className="dt-cols">
                    <th>Connector</th>
                    <th>Kind</th>
                    <th>Status</th>
                    <th className="text-right">Clients</th>
                    <th className="text-right">Tools</th>
                    <th>Errors 24 h</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c) => {
                    const errs = errorWords(c);
                    const on = selected?.id === c.id;
                    return (
                      <tr
                        key={c.id}
                        data-testid={`connector-${c.id}`}
                        aria-selected={on}
                        className={cx(on && "bg-slate-tint")}
                      >
                        <td>
                          <button
                            type="button"
                            className="group flex items-center gap-3 text-left"
                            aria-haspopup="dialog"
                            data-testid={`connector-${c.id}-open`}
                            onClick={() => setSelectedId(c.id)}
                          >
                            <ConnectorMark name={c.name} connector={c.id} size="sm" />
                            <span className="flex flex-col">
                              <span className="font-medium text-ink group-hover:underline">
                                {c.name}
                              </span>
                              <span
                                className="max-w-xl text-sm text-ink-muted"
                                data-testid={`connector-${c.id}-line`}
                              >
                                {connectorLine(c)}
                              </span>
                            </span>
                          </button>
                        </td>
                        <td className="text-sm whitespace-nowrap text-ink">{KIND_LABEL[c.auth]}</td>
                        <td>
                          <ConnectorStatusChip status={c.status} />
                        </td>
                        <td
                          className="text-right figures"
                          data-testid={`connector-${c.id}-clients`}
                        >
                          {c.clientsConnected}
                        </td>
                        <td className="text-right figures">{c.tools.length}</td>
                        <td className="text-sm" data-testid={`connector-${c.id}-errors`}>
                          {errs ? (
                            <span className="text-risk">{errs}</span>
                          ) : (
                            <span className="text-positive figures">0</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {shown.length === 0 ? (
              <p className="ui-card__body text-sm text-ink-muted">
                {search.trim() ? "No connector matches." : "No connector has this status."}
              </p>
            ) : null}
          </Card>
          <Section title="Default access for new clients">
            <MatrixTable
              editor="operator"
              note="It applies when a client's connection is first made, and starts no looser than approval for changes."
              rows={all
                .filter((c) => c.tools.length > 0)
                .map((c) => ({
                  id: c.id,
                  name: c.name,
                  permissions: c.defaultAccess.matrix,
                  entities: c.permissionEntities,
                }))}
              onSave={async (id, edit) => {
                const c = all.find((x) => x.id === id);
                if (!c) return;
                await put(id, { defaultPermissions: { ...c.defaultAccess.matrix, ...edit } });
              }}
            />
          </Section>
        </>
      )}
    </Page>
  );
}

const LEVEL_WORDS = {
  auto: ["On its own", "neutral"],
  approval: ["Needs approval", "person"],
  off: ["Off", "neutral"],
} as const;

const TOOLS_SHOWN = 9;

function ConnectorPanel({
  connector: c,
  onSave,
  onOffered,
  onClose,
}: {
  connector: Connector;
  onSave: (body: { status?: ConnectorStatus; note?: string }) => Promise<void>;
  onOffered(): void;
  onClose(): void;
}) {
  const [note, setNote] = useState(c.note);
  const [busy, setBusy] = useState(false);
  const [allTools, setAllTools] = useState(false);
  async function save(body: { status?: ConnectorStatus; note?: string }) {
    setBusy(true);
    try {
      await onSave(body);
    } catch {
      // Shown above the table.
    } finally {
      setBusy(false);
    }
  }
  const tools = allTools ? c.tools : c.tools.slice(0, TOOLS_SHOWN);
  const m = c.defaultAccess.matrix;
  return (
    <SideSheet
      testId="connector-panel"
      onClose={onClose}
      eyebrow={
        <span className="flex flex-wrap items-center gap-2.5">
          <ConnectorMark name={c.name} connector={c.id} size="sm" />
          <span className="text-sm text-ink-muted">{KIND_LABEL[c.auth]}</span>
          <ConnectorStatusChip status={c.status} testId="connector-panel-status" />
        </span>
      }
      title={c.name}
    >
      <p className="text-ink">{connectorLine(c)}</p>
      {saysMore(c.description, connectorLine(c)) ? (
        <SheetSection label="In full">
          <p className="text-sm text-ink" data-testid="connector-panel-description">
            {c.description}
          </p>
        </SheetSection>
      ) : null}
      {c.available ? null : (
        <Badge tone="neutral" className="self-start">
          Not set up on this deployment
        </Badge>
      )}
      {c.testOnly ? (
        <Badge tone="neutral" className="self-start" testId="connector-panel-test-only">
          For testing only: real clients never see it
        </Badge>
      ) : null}
      <Field
        label="Status"
        {...(c.statusSource === "deployment"
          ? {
              hint:
                c.status === null
                  ? "Nobody has set a status. Choose one when you start building it."
                  : "Live because clients can connect it here. Choose a status to set your own.",
            }
          : {})}
      >
        <Select
          aria-label={`Status of ${c.name}`}
          data-testid={`connector-${c.id}-status`}
          value={c.status ?? ""}
          disabled={busy}
          onChange={(e) => void save({ status: e.target.value as ConnectorStatus })}
        >
          {c.status === null ? <option value="">Not set up</option> : null}
          {CONNECTOR_STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Note for the team">
        <div className="flex gap-2">
          <TextInput
            aria-label={`Note on ${c.name}`}
            data-testid={`connector-${c.id}-note`}
            value={note}
            maxLength={2000}
            placeholder="What we're waiting on"
            onChange={(e) => setNote(e.target.value)}
          />
          <Button
            variant="ghost"
            disabled={busy || note === c.note || c.status === null}
            onClick={() => void save({ note })}
          >
            Save
          </Button>
        </div>
      </Field>

      <SheetSection label="Tools it gives agents">
        {c.tools.length === 0 ? (
          <p className="text-sm text-ink-muted">None.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5" data-testid="connector-panel-tools">
            {tools.map((t) => (
              <Tag key={t.id}>{toolName(t.id)}</Tag>
            ))}
            {c.tools.length > TOOLS_SHOWN ? (
              <Button size="sm" variant="link" onClick={() => setAllTools((v) => !v)}>
                {allTools ? "Fewer" : `+${c.tools.length - TOOLS_SHOWN}`}
              </Button>
            ) : null}
          </div>
        )}
      </SheetSection>

      <SheetSection label="Default access for new clients">
        <dl className="flex flex-col gap-2 text-sm">
          {(
            [
              ["Read", m.read],
              ["Create", m.create],
              ["Update", m.update],
              ["Delete", m.delete],
            ] as const
          ).map(([label, level]) => (
            <div key={label} className="flex items-center justify-between gap-3">
              <dt className="text-ink">{label}</dt>
              <dd>
                <Badge tone={LEVEL_WORDS[level][1]}>{LEVEL_WORDS[level][0]}</Badge>
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-ink-muted">{SOURCE_LABEL[c.defaultAccess.source]}</p>
      </SheetSection>

      <SheetSection label="Waiting to connect">
        {c.waiting.length === 0 ? (
          <p className="text-sm text-ink-muted" data-testid={`connector-${c.id}-waiting`}>
            No one.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm" data-testid={`connector-${c.id}-waiting`}>
            {c.waiting.map((w) => (
              <li key={w.clientId} className="flex flex-wrap justify-between gap-2">
                <span className="text-ink">{w.clientName}</span>
                <span className="text-ink-muted">
                  {w.agents.length > 0
                    ? `${w.agents.map((a) => a.name).join(", ")} ${w.agents.length === 1 ? "needs" : "need"} it`
                    : "Offered"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SheetSection>

      <SheetSection label="Offer to a client">
        <OfferControl connector={c} onChanged={onOffered} />
      </SheetSection>
    </SideSheet>
  );
}

/** Whether one client is offered this connector, and the switch to offer it or stop. */
function OfferControl({ connector: c, onChanged }: { connector: Connector; onChanged(): void }) {
  const session = useSession();
  const api = useApiClient();
  const clients = [...new Map(session.tenants.map((t) => [t.id, t])).values()];
  const [clientId, setClientId] = useState("");
  const conns = useApi(
    apiRoutes.opsClientConnections,
    clientId ? { params: { id: clientId } } : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const offered = conns.data?.offered ?? [];
  const isOffered = offered.includes(c.id);

  async function toggle() {
    if (!clientId || !conns.data) return;
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.opsOfferConnectors, {
        params: { id: clientId },
        body: {
          offered: isOffered ? offered.filter((x) => x !== c.id) : [...offered, c.id],
        },
      });
      conns.reload();
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Select
        aria-label="Client"
        data-testid="connector-offer-client"
        value={clientId}
        onChange={(e) => setClientId(e.target.value)}
      >
        <option value="">Choose a client…</option>
        {clients.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Select>
      {clientId && conns.error ? <ErrorNotice error={conns.error} onRetry={conns.reload} /> : null}
      {clientId && conns.data ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-ink" data-testid="connector-offer-state">
            {isOffered ? "Offered: they can sign in to it." : "Not offered."}
          </span>
          <Button size="sm" data-testid="connector-offer-toggle" disabled={busy} onClick={toggle}>
            {isOffered ? "Stop offering" : "Offer it"}
          </Button>
        </div>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
    </div>
  );
}
