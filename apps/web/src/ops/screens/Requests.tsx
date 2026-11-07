// `/ops/requests` (ARCHITECTURE §11, §15): the requests queue. Clients' asks across the clients this
// operator serves, newest first, open by default. An open request waits on us (signal, "Open"). A
// request about a service hands off to the Builder on that agent's page; it is resolved here, as
// done (linking the client agent or template versions made for it) or declined, with a note the
// client reads. Drafted in the prototype's back-office style (no prototype screen;
// docs/ui-plan.md): each request a card with its client and who asked in the head, the actions in
// its foot.
import type { OpsRequest, RequestLink, RequestStatus } from "@countersign/core";
import { REQUEST_LINKS_MAX, REQUEST_NOTE_MAX } from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { StatusFilter } from "../../inbox/StatusFilter";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import { Field, Select, TextArea } from "../../ui/forms";
import { Icon } from "../../ui/icons";
import { Loaded, Page } from "../../ui/page";
import {
  Badge,
  Button,
  buttonClass,
  Card,
  EmptyState,
  PageHeader,
  type Tone,
} from "../../ui/primitives";

type Filter = "open" | "resolved" | "all";

const STATUS: Record<RequestStatus, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "warning" },
  done: { label: "Done", tone: "positive" },
  declined: { label: "Declined", tone: "neutral" },
};

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Where a linked version opens: its agent page at that version. */
export function linkHref(l: Pick<RequestLink, "kind" | "tenantId" | "slug" | "version">): string {
  const page =
    l.kind === "template"
      ? `/ops/templates/${l.slug}`
      : `/ops/clients/${l.tenantId}/agents/${l.slug}`;
  return `${page}?version=${l.version}`;
}

export function OpsRequestsScreen() {
  const session = useSession();
  const [filter, setFilter] = useState<Filter>("open");
  const [client, setClient] = useState("");
  const requests = useApi(apiRoutes.opsRequests, {
    query: { status: filter, ...(client ? { client } : {}) },
  });
  usePoll(requests.reload, filter === "open", 30_000, requests.loading);
  const items = requests.data?.items ?? [];
  const open = items.filter((i) => i.status === "open").length;

  return (
    <Page testId="ops-requests">
      <PageHeader
        title="Requests"
        subtitle={
          requests.data
            ? filter === "resolved"
              ? `${items.length} answered. Clients' asks for changes and new services.`
              : `${open} open${filter === "all" ? ` of ${items.length}` : ""}. Clients' asks for changes and new services.`
            : "Clients' asks for changes and new services."
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <StatusFilter
          value={filter}
          onChange={setFilter}
          area="ops-requests"
          label="Which requests"
          options={[
            ["open", "Open"],
            ["resolved", "Answered"],
            ["all", "All"],
          ]}
        />
        <Select
          aria-label="Client"
          data-testid="ops-requests-client"
          className="h-8 w-56 text-sm"
          value={client}
          onChange={(e) => setClient(e.target.value)}
        >
          <option value="">All clients</option>
          {session.tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </div>
      <Loaded state={requests}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState>
              {filter === "open"
                ? "Nothing open. Clients' requests show here."
                : "No requests here."}
            </EmptyState>
          ) : (
            <div data-testid="ops-requests-list" className="flex flex-col gap-4">
              {data.items.map((item) => (
                <RequestCard key={item.id} item={item} onChanged={requests.reload} />
              ))}
            </div>
          )
        }
      </Loaded>
    </Page>
  );
}

function RequestCard({ item, onChanged }: { item: OpsRequest; onChanged: () => void }) {
  const [resolving, setResolving] = useState(false);
  const status = STATUS[item.status];
  const who = item.raisedBy ? (item.raisedBy.name ?? item.raisedBy.email) : "Someone";
  const open = item.status === "open";

  return (
    <Card
      testId={`ops-request-${item.id}`}
      title={
        <span className="flex min-w-0 flex-col">
          <span data-testid="ops-request-subject">{item.subject}</span>
          <span className="text-sm font-normal text-ink-muted">
            <span data-testid="ops-request-client">{item.client.name}</span>
            {` · ${who} · ${when(item.createdAt)}`}
          </span>
        </span>
      }
      meta={
        <Badge tone={status.tone} testId="ops-request-status">
          {status.label}
        </Badge>
      }
      footer={
        open && !resolving ? (
          <>
            {item.agent ? (
              <Link
                to={`/ops/clients/${item.client.id}/agents/${item.agent.slug}/revise?request=${item.id}`}
                className={buttonClass("secondary")}
                data-testid="ops-request-revise"
              >
                Revise with the Builder
              </Link>
            ) : null}
            <Button
              variant="primary"
              data-testid="ops-request-resolve"
              onClick={() => setResolving(true)}
            >
              Resolve
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="ui-card__body flex flex-col gap-3">
        <p className="whitespace-pre-wrap text-ink" data-testid="ops-request-text">
          {item.text}
        </p>
        <p className="text-sm text-ink-muted" data-testid="ops-request-about">
          {item.agent ? (
            <>
              About{" "}
              <Link
                className="text-link underline"
                to={`/ops/clients/${item.client.id}/agents/${item.agent.slug}`}
              >
                {item.agent.serviceName}
              </Link>
            </>
          ) : (
            "Something new, or not about one service"
          )}
        </p>
        {open ? null : <Resolution item={item} />}
        {open && resolving ? (
          <ResolveForm
            item={item}
            onCancel={() => setResolving(false)}
            onResolved={() => {
              setResolving(false);
              onChanged();
            }}
          />
        ) : null}
      </div>
    </Card>
  );
}

function Resolution({ item }: { item: OpsRequest }) {
  const by = item.resolvedBy ? (item.resolvedBy.name ?? item.resolvedBy.email) : "someone";
  return (
    <div className="border-t border-line pt-3" data-testid="ops-request-resolution">
      <p className="text-sm text-ink-muted">
        {item.status === "done" ? "Done" : "Declined"} by {by}
        {item.resolvedAt ? ` on ${when(item.resolvedAt)}` : ""}
      </p>
      {item.note ? (
        <p className="mt-1 whitespace-pre-wrap text-ink" data-testid="ops-request-note">
          {item.note}
        </p>
      ) : null}
      {item.links.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1 text-sm" data-testid="ops-request-links">
          {item.links.map((l) => (
            <li key={l.agentVersionId}>
              <Link className="text-link underline" to={linkHref(l)}>
                {l.name} v{l.version}
              </Link>
              <span className="text-ink-muted">
                {l.kind === "template" ? " (template)" : ` (${item.client.name})`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface Picked {
  versionId: string;
  label: string;
}

function ResolveForm({
  item,
  onCancel,
  onResolved,
}: {
  item: OpsRequest;
  onCancel: () => void;
  onResolved: () => void;
}) {
  const api = useApiClient();
  const [outcome, setOutcome] = useState<"done" | "declined">("done");
  const [note, setNote] = useState("");
  const [links, setLinks] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const declining = outcome === "declined";
  const ready = declining ? note.trim().length > 0 : links.length > 0 || note.trim().length > 0;

  async function resolve() {
    setBusy(true);
    setError(null);
    try {
      await api.call(apiRoutes.opsResolveRequest, {
        params: { id: item.id },
        body: {
          outcome,
          ...(note.trim() ? { note: note.trim() } : {}),
          links: declining ? [] : links.map((l) => l.versionId),
        },
      });
      onResolved();
    } catch {
      setError("We couldn't resolve it. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 border-t border-line pt-4" data-testid="ops-request-form">
      <StatusFilter
        value={outcome}
        onChange={setOutcome}
        area="ops-request-outcome"
        label="Outcome"
        options={[
          ["done", "Done"],
          ["declined", "Decline"],
        ]}
      />
      {declining ? null : (
        <VersionPicker
          clientId={item.client.id}
          defaultAgentId={item.agent?.id ?? ""}
          picked={links}
          onPick={(p) =>
            setLinks((ls) =>
              ls.some((l) => l.versionId === p.versionId) || ls.length >= REQUEST_LINKS_MAX
                ? ls
                : [...ls, p],
            )
          }
          onRemove={(id) => setLinks((ls) => ls.filter((l) => l.versionId !== id))}
        />
      )}
      <Field
        label="Note to the client"
        hint={
          declining
            ? "Required. Say why, in plain words."
            : "What we did. Needed if you link no versions."
        }
      >
        <TextArea
          data-testid="ops-request-note-input"
          rows={3}
          maxLength={REQUEST_NOTE_MAX}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          data-testid="ops-request-resolve-confirm"
          disabled={busy || !ready}
          onClick={() => void resolve()}
        >
          {declining ? "Decline" : "Mark done"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {error ? <span className="ds-error text-sm">{error}</span> : null}
      </div>
    </div>
  );
}

/** Choose an agent (this client's, or a template), then one of its versions. */
function VersionPicker({
  clientId,
  defaultAgentId,
  picked,
  onPick,
  onRemove,
}: {
  clientId: string;
  defaultAgentId: string;
  picked: Picked[];
  onPick: (p: Picked) => void;
  onRemove: (versionId: string) => void;
}) {
  const clientAgents = useApi(apiRoutes.opsClientAgents, { params: { id: clientId } });
  const templates = useApi(apiRoutes.opsTemplates);
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [versionId, setVersionId] = useState("");
  const detail = useApi(apiRoutes.opsAgent, agentId ? { params: { id: agentId } } : null);
  const ownAgents = (clientAgents.data?.agents ?? []).filter((a) => !a.testCopy);
  const versions = [...(detail.data?.versions ?? [])].sort((a, b) => b.version - a.version);
  const chosen = detail.data?.agent;
  const version = versions.find((v) => v.id === versionId) ?? versions[0];

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm leading-tight font-medium text-ink">Versions made for it</span>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Agent"
          data-testid="ops-request-link-agent"
          className="w-64"
          value={agentId}
          onChange={(e) => {
            setAgentId(e.target.value);
            setVersionId("");
          }}
        >
          <option value="">Choose an agent</option>
          {ownAgents.length > 0 ? (
            <optgroup label="This client's agents">
              {ownAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.serviceName ?? a.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {(templates.data?.templates ?? []).length > 0 ? (
            <optgroup label="Templates">
              {templates.data?.templates.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </Select>
        <Select
          aria-label="Version"
          data-testid="ops-request-link-version"
          className="w-40"
          disabled={versions.length === 0}
          value={version?.id ?? ""}
          onChange={(e) => setVersionId(e.target.value)}
        >
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              v{v.version} · {v.status}
            </option>
          ))}
        </Select>
        <Button
          data-testid="ops-request-link-add"
          disabled={!version || !chosen}
          onClick={() => {
            if (!version || !chosen) return;
            const name =
              chosen.kind === "client" ? (chosen.serviceName ?? chosen.name) : chosen.name;
            onPick({ versionId: version.id, label: `${name} v${version.version}` });
          }}
        >
          Add
        </Button>
      </div>
      {picked.length > 0 ? (
        <ul className="flex flex-wrap gap-2" data-testid="ops-request-picked">
          {picked.map((p) => (
            <li key={p.versionId} className="ds-pill ds-pill--accent flex items-center gap-1">
              {p.label}
              <button
                type="button"
                aria-label={`Remove ${p.label}`}
                className="text-ink-muted hover:text-ink"
                onClick={() => onRemove(p.versionId)}
              >
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
