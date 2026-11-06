// `/ops/connectors` (ARCHITECTURE §6.1 "Connectors catalog", docs/plan.md §1.44, W2-A): every
// registered connector with its status, the clients connected, its tools, errors in the last 24
// hours, the default access a client's new connection starts with, and the clients waiting to
// connect. The operator sets the status and a note per connector, and the default access in the
// matrix below (never looser than the platform's defaults; entities per connector).
import { CONNECTOR_STATUS_VALUES, type ConnectorStatus } from "@countersign/core";
import { useState } from "react";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { MatrixTable } from "../../connections/MatrixTable";
import { Select, TextInput } from "../../ui/forms";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
} from "../../ui/primitives";

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

const SOURCE_LABEL: Record<Connector["defaultAccess"]["source"], string> = {
  operator: "Set by you",
  connector: "The connector's",
  platform: "Platform defaults",
};

export function OpsConnectorsScreen() {
  const api = useApiClient();
  const { data, error, loading, reload } = useApi(apiRoutes.opsConnectors);
  const [saveError, setSaveError] = useState<unknown>(null);

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

  return (
    <div>
      <PageHeader
        title="Connectors"
        subtitle="Every connector we offer: its status, who uses it, errors in the last 24 hours, the access a new client starts with, and who is still waiting to connect."
      />
      {saveError ? <ErrorNotice error={saveError} /> : null}
      {data.connectors.length === 0 ? (
        <EmptyState>No connector is registered here.</EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {data.connectors.map((c) => (
            <ConnectorCard key={c.id} connector={c} onSave={(body) => put(c.id, body)} />
          ))}
        </div>
      )}
      <section className="mt-6">
        <MatrixTable
          editor="operator"
          note="Default access for new clients. It applies when a client's connection is first made, and starts no looser than approval for changes."
          rows={data.connectors
            .filter((c) => c.tools.length > 0)
            .map((c) => ({
              id: c.id,
              name: c.name,
              permissions: c.defaultAccess.matrix,
              entities: c.permissionEntities,
            }))}
          onSave={async (id, edit) => {
            const c = data.connectors.find((x) => x.id === id);
            if (!c) return;
            await put(id, {
              defaultPermissions: { ...c.defaultAccess.matrix, ...edit },
            });
          }}
        />
      </section>
    </div>
  );
}

function ConnectorCard({
  connector: c,
  onSave,
}: {
  connector: Connector;
  onSave: (body: { status?: ConnectorStatus; note?: string }) => Promise<void>;
}) {
  const [note, setNote] = useState(c.note);
  const [busy, setBusy] = useState(false);
  async function save(body: { status?: ConnectorStatus; note?: string }) {
    setBusy(true);
    try {
      await onSave(body);
    } catch {
      // Shown above the list.
    } finally {
      setBusy(false);
    }
  }
  const errors = c.errors.toolCalls + c.errors.connections;
  return (
    <Card testId={`connector-${c.id}`} className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium text-ink">{c.name}</h3>
          <p className="text-sm text-ink-muted">{c.description}</p>
        </div>
        <div className="flex items-center gap-2">
          {c.available ? null : <Badge tone="neutral">Not set up here</Badge>}
          <Select
            aria-label={`Status of ${c.name}`}
            data-testid={`connector-${c.id}-status`}
            value={c.status ?? ""}
            disabled={busy}
            onChange={(e) => void save({ status: e.target.value as ConnectorStatus })}
            className="h-8 w-36 text-sm"
          >
            {c.status === null ? <option value="">Not set</option> : null}
            {CONNECTOR_STATUS_VALUES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-ink-muted">Clients connected</dt>
          <dd className="text-ink" data-testid={`connector-${c.id}-clients`}>
            {c.clientsConnected}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">Tools</dt>
          <dd className="text-ink">{c.tools.length}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">Errors, last 24 hours</dt>
          <dd data-testid={`connector-${c.id}-errors`}>
            {errors === 0 ? (
              <span className="text-ink">None</span>
            ) : (
              <Badge tone="risk">
                {c.errors.toolCalls} failed calls, {c.errors.connections} connections in error
              </Badge>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">Default access</dt>
          <dd className="text-ink">{SOURCE_LABEL[c.defaultAccess.source]}</dd>
        </div>
      </dl>
      <div className="mt-3 text-sm" data-testid={`connector-${c.id}-waiting`}>
        <span className="text-ink-muted">Waiting to connect: </span>
        {c.waiting.length === 0 ? (
          <span className="text-ink">no one</span>
        ) : (
          <span className="text-ink">
            {c.waiting
              .map(
                (w) =>
                  `${w.clientName}${
                    w.agents.length > 0 ? ` (${w.agents.map((a) => a.name).join(", ")})` : ""
                  }`,
              )
              .join("; ")}
          </span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <TextInput
          aria-label={`Note on ${c.name}`}
          data-testid={`connector-${c.id}-note`}
          value={note}
          maxLength={2000}
          placeholder="A note for the team"
          onChange={(e) => setNote(e.target.value)}
          className="min-w-64 flex-1"
        />
        <Button
          variant="ghost"
          disabled={busy || note === c.note || c.status === null}
          onClick={() => void save({ note })}
        >
          Save note
        </Button>
      </div>
    </Card>
  );
}
