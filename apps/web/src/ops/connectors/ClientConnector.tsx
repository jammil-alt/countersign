// `/ops/clients/:clientId/connectors/:connector` (docs/connectors-plan.md §7.1, §7.2; mockup
// docs/design/connectors.html screen 6): one connector of a client, as the back office sees it.
// Each connection: its account and status, what agents may read and change (row by row), its
// setup, the agents using it and what they still need, the client's say over our changes, the open
// request and the history. Credentials never show.
//
// We edit as if it were ours, but nothing is saved yet: a footer lists the change row by row (the
// API's preview), asks why (the client sees it) and says what pressing does. Tighter applies now;
// what the client's go-ahead covers applies now and they are told; anything else is sent to them to
// approve. The Sandbox is ours: it applies. `?for=<agent>` marks what that agent needs here.
import type {
  ChangeRequestView,
  ConnectionHistoryEntry,
  OpsAgentNeedsState,
  OpsConnectionChangeBody,
  OpsConnectionChangePreview,
  OpsConnectionChangeResult,
  OpsConnectionPageView,
  PermissionLevel,
} from "@countersign/core";
import { connectorAccessRoutes as access, levelWords } from "@countersign/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { ConnectorMark, connectionStatusLabel } from "../../connections/ConnectorMark";
import { shortTime } from "../../runs/format";
import { Badge, Button, Card, ErrorNotice, Loading, SectionLabel, Tag } from "../../ui/primitives";
import { Field, Notice, TextArea } from "../agents/ui";
import { ClientFrame } from "../client/ClientFrame";
import {
  AUTH_WORDS,
  accessWords,
  changeButtonWords,
  changeSummaryWords,
  dayWords,
  GAP_WORDS,
  mezonasMayWords,
  requestState,
  resultWords,
} from "./words";
import { ZohoSyncFields } from "./ZohoSyncFields";

type Page = ResponseOf<typeof access.opsClientConnector>;
type Row = OpsConnectionPageView["read"][number];
type RawPermissions = ResponseOf<
  typeof apiRoutes.opsClientConnections
>["connections"][number]["permissions"];
type MatrixEditBody = NonNullable<OpsConnectionChangeBody["permissions"]>;

/** The back office's path to a client's connector, optionally for one agent. */
export function clientConnectorPath(clientId: string, connector: string, forAgent?: string) {
  const base = `/ops/clients/${clientId}/connectors/${connector}`;
  return forAgent ? `${base}?for=${forAgent}` : base;
}

export function OpsClientConnectorScreen() {
  const { clientId = "", connector = "" } = useParams();
  return (
    <ClientFrame clientId={clientId}>
      <ClientConnector clientId={clientId} connector={connector} />
    </ClientFrame>
  );
}

function ClientConnector({ clientId, connector }: { clientId: string; connector: string }) {
  const [search] = useSearchParams();
  const forAgent = search.get("for") ?? undefined;
  const page = useApi(access.opsClientConnector, {
    params: { id: clientId, connector },
    query: forAgent ? { for: forAgent } : {},
  });
  // The stored matrices, for an edit that sends a connection's record types whole (MatrixEdit).
  const raw = useApi(apiRoutes.opsClientConnections, { params: { id: clientId } });
  const client = useApi(apiRoutes.opsClient, { params: { id: clientId } });
  const clientName = client.data?.client.name ?? "the client";

  if (page.loading && !page.data) return <Loading />;
  if (page.error && !page.data) return <ErrorNotice error={page.error} onRetry={page.reload} />;
  if (!page.data) return null;
  const data = page.data;
  const rawOf = (id: string) => raw.data?.connections.find((c) => c.id === id)?.permissions;

  return (
    <div className="flex flex-col gap-6" data-testid="ops-client-connector">
      <div>
        <Link
          to={`/ops/clients/${clientId}/connections`}
          className="text-sm text-link hover:underline"
          data-testid="ops-client-connector-back"
        >
          Connectors
        </Link>
        <div className="mt-3 flex items-center gap-3">
          <ConnectorMark name={data.connector.name} connector={data.connector.connector} />
          <div className="min-w-0">
            <h2 className="type-subheading text-ink">
              {data.connector.name}
              {data.connector.beta ? <Tag className="ml-2">Beta</Tag> : null}
            </h2>
            <p className="text-sm text-ink-muted">
              {AUTH_WORDS[data.connector.auth] ?? "the client connects it from their portal"}
              {data.connector.custom ? ` · built for ${clientName}` : ""}
            </p>
          </div>
        </div>
      </div>

      <p
        className="rounded-sm border border-line bg-surface-subtle px-4 py-3 text-sm text-ink"
        data-testid="ops-client-connector-note"
      >
        {data.sandbox
          ? "Your own test client: what you change here applies at once."
          : `You're editing ${clientName}'s settings. Tighter changes apply at once; anything looser goes to ${clientName} to approve.`}
      </p>

      {data.forAgent ? <ForAgentStrip forAgent={data.forAgent} clientName={clientName} /> : null}

      {data.connections.length === 0 ? (
        <Card pad testId="ops-client-connector-none">
          <p className="text-ink">
            {clientName} hasn't connected {data.connector.name} yet.{" "}
            {data.sandbox
              ? "Connect it from the Connectors tab."
              : "A client admin connects it from their portal; we never connect on their behalf."}
          </p>
        </Card>
      ) : (
        data.connections.map((c) => (
          <ConnectionEditor
            key={c.id}
            clientId={clientId}
            clientName={clientName}
            connectorName={data.connector.name}
            connector={data.connector.connector}
            connection={c}
            raw={rawOf(c.id)}
            sandbox={data.sandbox}
            forAgent={data.forAgent?.agent.id}
            onChanged={() => {
              page.reload();
              raw.reload();
            }}
          />
        ))
      )}
    </div>
  );
}

/** `?for=`: the gold strip naming what that agent still needs here. */
function ForAgentStrip({
  forAgent,
  clientName,
}: {
  forAgent: NonNullable<Page["forAgent"]>;
  clientName: string;
}) {
  const blocking = forAgent.gaps.filter((g) => g.blocking);
  if (forAgent.ready) {
    return (
      <Notice tone="positive" testId="ops-client-connector-for">
        {forAgent.agent.name} has what it needs here.
      </Notice>
    );
  }
  return (
    <div
      className="rounded-sm border border-line bg-signal-tint px-4 py-3 text-sm text-signal-ink"
      data-testid="ops-client-connector-for"
    >
      <p className="font-medium">
        Waiting: {forAgent.agent.name} needs {blocking.length}{" "}
        {blocking.length === 1 ? "thing" : "things"} here
      </p>
      <ul className="mt-1 list-disc pl-5">
        {blocking.map((g) => (
          <li key={`${g.kind}:${g.connectionId ?? ""}:${g.words}`}>
            {g.words} ({g.fixBy === "mezonas" ? "us" : clientName})
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── One connection, edited ───────────────────────────────────────────────────────────────────

const rowKey = (r: Pick<Row, "verb" | "entity">) => `${r.verb}:${r.entity ?? ""}`;
const LEVEL_ORDER: readonly PermissionLevel[] = ["auto", "approval", "off"];

// DECISION (C6): the connector page's rows give each record type's level as the gate reads it,
// not the stored matrix, and an edit sends `entities` whole; so the stored matrix comes from the
// older `opsClientConnections` list, and an edited record type is laid over it.
/**
 * Our edit as the API takes it: a verb's own row sets the verb; a record type's row sets that
 * record type, sent with the others as stored (MatrixEdit sends `entities` whole).
 */
export function matrixEditOf(
  edits: Readonly<Record<string, PermissionLevel>>,
  rows: readonly Row[],
  raw: RawPermissions | undefined,
): MatrixEditBody | undefined {
  const edit: MatrixEditBody = {};
  let entities: Record<string, Record<string, unknown>> | null = null;
  for (const row of rows) {
    const level = edits[rowKey(row)];
    if (level === undefined || level === row.level) continue;
    if (row.entity === null) {
      edit[row.verb] = level;
    } else {
      entities ??= structuredClone(
        (raw?.entities ?? {}) as Record<string, Record<string, unknown>>,
      );
      entities[row.entity] = { ...(entities[row.entity] ?? {}), [row.verb]: level };
    }
  }
  if (entities) edit.entities = entities as MatrixEditBody["entities"];
  return Object.keys(edit).length > 0 ? edit : undefined;
}

/** The setup as text, and what it parses to (an object, or why not). */
/** docs/plan.md §1.164: Zoho CRM's connections choose the fields their sync reads. */
const ZOHO_CRM = "zoho_crm";

function parseConfig(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const v: unknown = JSON.parse(text);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false };
    return { ok: true, value: v as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function ConnectionEditor({
  clientId,
  clientName,
  connectorName,
  connector,
  connection: c,
  raw,
  sandbox,
  forAgent,
  onChanged,
}: {
  clientId: string;
  clientName: string;
  connectorName: string;
  connector: string;
  connection: OpsConnectionPageView;
  raw: RawPermissions | undefined;
  sandbox: boolean;
  forAgent: string | undefined;
  onChanged(): void;
}) {
  const api = useApiClient();
  const [edits, setEdits] = useState<Record<string, PermissionLevel>>({});
  const savedConfig = JSON.stringify(c.config, null, 2);
  const [configText, setConfigText] = useState(savedConfig);
  const [editingSetup, setEditingSetup] = useState(false);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<OpsConnectionChangePreview | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [result, setResult] = useState<OpsConnectionChangeResult | null>(null);
  const [reasonMissing, setReasonMissing] = useState(false);
  useEffect(() => setConfigText(savedConfig), [savedConfig]);

  const rows = useMemo(() => [...c.read, ...c.change], [c.read, c.change]);
  const permissions = matrixEditOf(edits, rows, raw);
  const config = parseConfig(configText);
  const configChanged = configText !== savedConfig;
  const body: { permissions?: MatrixEditBody; config?: Record<string, unknown> } | null =
    configChanged && !config.ok
      ? null
      : {
          ...(permissions ? { permissions } : {}),
          ...(configChanged && config.ok ? { config: config.value } : {}),
        };
  const dirty = permissions !== undefined || configChanged;
  const bodyKey = body && dirty ? JSON.stringify(body) : null;

  // The preview follows the draft: the last answer for the last draft wins.
  const asked = useRef(0);
  useEffect(() => {
    const n = ++asked.current;
    setPreviewError(null);
    if (!bodyKey) {
      setPreview(null);
      return;
    }
    api
      .call(access.opsPreviewConnectionChange, {
        params: { id: clientId, connectionId: c.id },
        body: JSON.parse(bodyKey),
      })
      .then((p) => {
        if (asked.current === n) setPreview(p);
      })
      .catch((e) => {
        if (asked.current === n) {
          setPreview(null);
          setPreviewError(e);
        }
      });
  }, [api, bodyKey, clientId, c.id]);

  function setLevel(row: Row, level: PermissionLevel) {
    setResult(null);
    setEdits((e) => {
      const next = { ...e };
      if (level === row.level) delete next[rowKey(row)];
      else next[rowKey(row)] = level;
      return next;
    });
  }

  function discard() {
    setEdits({});
    setConfigText(savedConfig);
    setEditingSetup(false);
    setReason("");
    setReasonMissing(false);
    setProblem(null);
  }

  async function submit() {
    if (!body || !preview || preview.outcome === "none") return;
    if (!reason.trim()) {
      setReasonMissing(true);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await api.call(access.opsConnectionChange, {
        params: { id: clientId, connectionId: c.id },
        body: { ...body, reason: reason.trim(), ...(forAgent ? { forAgentId: forAgent } : {}) },
      });
      setResult(res);
      setEdits({});
      setEditingSetup(false);
      setReason("");
      setReasonMissing(false);
      onChanged();
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }

  const shownLevel = (row: Row) => edits[rowKey(row)] ?? row.level;
  const testId = `ops-client-connection-${c.id}`;

  return (
    <Card testId={testId} className="flex flex-col">
      <div className="flex flex-wrap items-start gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink" data-testid="ops-client-connection-account">
            {c.accountName ?? connectorName}
          </p>
          <p className="text-sm text-ink-muted">
            {c.lastSyncAt ? `Synced ${shortTime(c.lastSyncAt)}` : "Never synced"} ·{" "}
            {accessWords(c.access)}
          </p>
        </div>
        <Badge tone={c.status === "connected" ? "positive" : "warning"}>
          {connectionStatusLabel(c.status)}
        </Badge>
      </div>

      <div className="flex flex-col gap-6 px-5 py-4">
        <p className="text-sm text-ink" data-testid="ops-client-connection-may">
          {sandbox ? "Ours: no approval needed." : mezonasMayWords(clientName, c.mezonasMay)}
        </p>

        <AccessGroup
          title="Read"
          note="What agents can look at. Reads never change anything."
          rows={c.read}
          shownLevel={shownLevel}
          onSet={setLevel}
        />
        <AccessGroup
          title="Change"
          note="What agents can write. Delete is always off."
          rows={c.change}
          shownLevel={shownLevel}
          onSet={setLevel}
        />

        <section>
          <SectionLabel
            action={
              editingSetup ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="ops-client-connection-setup-edit"
                  onClick={() => setEditingSetup(true)}
                >
                  Edit setup
                </Button>
              )
            }
          >
            Setup
          </SectionLabel>
          {editingSetup ? (
            <Field
              label="The tool's setup (JSON)"
              error={config.ok ? undefined : "The setup must be a JSON object."}
            >
              <TextArea
                data-testid="ops-client-connection-setup-input"
                className="font-mono text-xs"
                rows={6}
                spellCheck={false}
                value={configText}
                invalid={!config.ok}
                onChange={(e) => {
                  setResult(null);
                  setConfigText(e.target.value);
                }}
              />
            </Field>
          ) : (
            <p className="text-sm text-ink-muted">
              {Object.keys(c.config).length === 0
                ? "Nothing set."
                : `${Object.keys(c.config).length} ${Object.keys(c.config).length === 1 ? "setting" : "settings"}: ${Object.keys(c.config).join(", ")}`}
            </p>
          )}
        </section>

        {connector === ZOHO_CRM ? (
          <ZohoSyncFields
            clientId={clientId}
            clientName={clientName}
            connectionId={c.id}
            config={config.ok ? config.value : c.config}
            onConfig={(next) => {
              setResult(null);
              setConfigText(JSON.stringify(next, null, 2));
            }}
          />
        ) : null}

        {dirty ? (
          <ChangeFooter
            clientName={clientName}
            sandbox={sandbox}
            preview={preview}
            previewError={previewError}
            invalid={body === null}
            reason={reason}
            reasonMissing={reasonMissing}
            busy={busy}
            problem={problem}
            onReason={(v) => {
              setReason(v);
              if (v.trim()) setReasonMissing(false);
            }}
            onDiscard={discard}
            onSubmit={() => void submit()}
          />
        ) : null}
        {result ? (
          <Notice tone="positive" testId="ops-client-connection-result">
            {resultWords(result, clientName, sandbox)}
          </Notice>
        ) : null}

        <UsedBy agents={c.usedBy} clientName={clientName} />
        {c.openRequest ? (
          <OpenRequest
            clientId={clientId}
            clientName={clientName}
            request={c.openRequest}
            onChanged={onChanged}
          />
        ) : null}
        <History entries={c.history} />
      </div>
    </Card>
  );
}

function AccessGroup({
  title,
  note,
  rows,
  shownLevel,
  onSet,
}: {
  title: string;
  note: string;
  rows: readonly Row[];
  shownLevel(row: Row): PermissionLevel;
  onSet(row: Row, level: PermissionLevel): void;
}) {
  return (
    <section data-testid={`ops-access-${title.toLowerCase()}`}>
      <SectionLabel>{title}</SectionLabel>
      <p className="mb-2 text-sm text-ink-muted">{note}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing here.</p>
      ) : (
        <ul className="rounded-sm border border-line">
          {rows.map((row) => {
            const level = shownLevel(row);
            const edited = level !== row.level;
            const choices = LEVEL_ORDER.filter((l) => row.choices.includes(l) || l === row.level);
            const needed = row.neededBy.length > 0 && !edited;
            return (
              <li
                key={rowKey(row)}
                data-testid={`ops-access-row-${rowKey(row)}`}
                className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink">{row.label}</p>
                  {row.tools.length > 0 ? (
                    <p className="font-mono text-xs text-ink-muted">
                      {row.tools.map((t) => t.id).join(", ")}
                    </p>
                  ) : null}
                  {row.scope ? (
                    <p className="text-xs text-ink-muted">Scope: {row.scope.label}</p>
                  ) : null}
                </div>
                {row.usedBy.length > 0 ? (
                  <Tag>{row.usedBy.map((a) => a.name).join(", ")}</Tag>
                ) : null}
                {needed ? (
                  <Badge tone="warning">
                    {row.neededBy.map((a) => a.name).join(", ")}{" "}
                    {row.neededBy.length === 1 ? "needs this" : "need this"}
                  </Badge>
                ) : null}
                {edited ? (
                  <Badge tone="accent" testId="ops-access-row-edited">
                    {levelWords(row.verb, row.level)} → {levelWords(row.verb, level)}
                  </Badge>
                ) : null}
                {choices.length > 1 ? (
                  <fieldset className="ds-seg" aria-label={row.label}>
                    {choices.map((l) => (
                      <button
                        key={l}
                        type="button"
                        aria-pressed={level === l}
                        data-testid={`ops-access-set-${rowKey(row)}-${l}`}
                        onClick={() => onSet(row, l)}
                      >
                        {levelWords(row.verb, l)}
                      </button>
                    ))}
                  </fieldset>
                ) : (
                  <span className="text-sm text-ink">{levelWords(row.verb, level)}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ChangeFooter({
  clientName,
  sandbox,
  preview,
  previewError,
  invalid,
  reason,
  reasonMissing,
  busy,
  problem,
  onReason,
  onDiscard,
  onSubmit,
}: {
  clientName: string;
  sandbox: boolean;
  preview: OpsConnectionChangePreview | null;
  previewError: unknown;
  invalid: boolean;
  reason: string;
  reasonMissing: boolean;
  busy: boolean;
  problem: unknown;
  onReason(v: string): void;
  onDiscard(): void;
  onSubmit(): void;
}) {
  const nothing = !preview || preview.outcome === "none";
  return (
    <div
      className="rounded-sm border border-line bg-surface-subtle p-4"
      data-testid="ops-change-footer"
    >
      {invalid ? (
        <p className="text-sm text-ink-muted">Fix the setup to see what this changes.</p>
      ) : previewError ? (
        <ErrorNotice error={previewError} />
      ) : !preview ? (
        <Loading label="Checking what this changes…" />
      ) : (
        <>
          <p className="font-medium text-ink" data-testid="ops-change-summary">
            {changeSummaryWords(preview.rows.length, preview.direction)}
          </p>
          <ul className="mt-1 text-sm text-ink" data-testid="ops-change-rows">
            {preview.rows.map((r) => (
              <li key={r.label}>{r.label}</li>
            ))}
          </ul>
          {!sandbox && preview.outcome === "request" && preview.whyNot ? (
            <p className="mt-2 text-sm text-ink-muted" data-testid="ops-change-why-not">
              It goes to {clientName} to approve: {preview.whyNot}
            </p>
          ) : null}
          {!sandbox && preview.outcome === "apply_under_authorization" ? (
            <p className="mt-2 text-sm text-ink-muted">
              {mezonasMayWords(clientName, preview.mezonasMay)}. They're told about it.
            </p>
          ) : null}
        </>
      )}
      <div className="mt-3">
        <Field
          label={sandbox ? "Why" : `Why (${clientName} sees this)`}
          error={reasonMissing ? "Say why: it's required." : undefined}
        >
          <TextArea
            data-testid="ops-change-reason"
            rows={2}
            value={reason}
            invalid={reasonMissing}
            onChange={(e) => onReason(e.target.value)}
          />
        </Field>
      </div>
      {problem ? (
        <div className="mt-3">
          <ErrorNotice error={problem} />
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" data-testid="ops-change-discard" onClick={onDiscard}>
          Discard
        </Button>
        <Button
          variant="primary"
          data-testid="ops-change-submit"
          disabled={nothing || invalid || !reason.trim()}
          working={busy}
          onClick={onSubmit}
        >
          {preview ? changeButtonWords(preview, clientName, sandbox) : "Apply now"}
        </Button>
      </div>
    </div>
  );
}

function UsedBy({
  agents,
  clientName,
}: {
  agents: readonly OpsAgentNeedsState[];
  clientName: string;
}) {
  return (
    <section data-testid="ops-client-connection-used-by">
      <SectionLabel>Used by</SectionLabel>
      {agents.length === 0 ? (
        <p className="text-sm text-ink-muted">No agent uses it yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {agents.map((a) => {
            const blocking = a.gaps.filter((g) => g.blocking);
            return (
              <li key={a.agent.id} className="flex flex-wrap items-start gap-2 text-sm">
                <span className="font-medium text-ink">{a.agent.name}</span>
                {blocking.length === 0 ? (
                  <Badge tone="positive">Has what it needs</Badge>
                ) : (
                  <Badge tone="warning">Needs {blocking.length}</Badge>
                )}
                {a.gaps.length > 0 ? (
                  <span className="basis-full text-ink-muted">
                    {a.gaps
                      .map(
                        (g) =>
                          `${g.words} (${GAP_WORDS[g.kind]}; ${g.fixBy === "mezonas" ? "us" : clientName})`,
                      )
                      .join(" · ")}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The open request on a connection, with Withdraw until it's answered. */
export function OpenRequest({
  clientId,
  clientName,
  request: r,
  onChanged,
  showConnector,
}: {
  clientId: string;
  clientName: string;
  request: ChangeRequestView;
  onChanged(): void;
  showConnector?: boolean;
}) {
  const api = useApiClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const state = requestState(r, clientName);
  async function withdraw() {
    setBusy(true);
    setProblem(null);
    try {
      await api.call(access.opsWithdrawConnectionRequest, {
        params: { id: clientId, requestId: r.id },
        body: {},
      });
      onChanged();
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-sm border border-line px-4 py-3" data-testid={`ops-request-${r.id}`}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink">
            {showConnector ? `${r.connectorName}: ` : ""}
            {r.rows.map((x) => x.label).join(" · ")}
          </p>
          <p className="text-sm text-ink-muted">
            {r.forAgent ? `For ${r.forAgent.name} · ` : ""}
            Sent by <span className="text-copper-ink">{r.requestedBy.name ?? "us"}</span>,{" "}
            {dayWords(r.createdAt)}
            {r.status === "open" ? ` · ends ${dayWords(r.expiresAt)}` : ""}
          </p>
          <p className="mt-1 text-sm text-ink">Why: {r.reason}</p>
          {r.outOfDate ? (
            <p className="mt-1 text-sm text-ink-muted">
              {clientName} changed this connection since: approving is refused. Send a new one.
            </p>
          ) : null}
        </div>
        <Badge tone={state.tone} testId="ops-request-state">
          {state.words}
        </Badge>
        {r.status === "open" ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="ops-request-withdraw"
            working={busy}
            onClick={() => void withdraw()}
          >
            Withdraw
          </Button>
        ) : null}
      </div>
      {problem ? (
        <div className="mt-2">
          <ErrorNotice error={problem} />
        </div>
      ) : null}
    </div>
  );
}

function History({ entries }: { entries: readonly ConnectionHistoryEntry[] }) {
  return (
    <section data-testid="ops-client-connection-history">
      <SectionLabel>History</SectionLabel>
      {entries.length === 0 ? (
        <p className="text-sm text-ink-muted">No changes yet.</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {entries.map((h) => (
            <li key={h.id}>
              <span className="text-ink-muted">{dayWords(h.at)} · </span>
              <span className={h.by ? "text-copper-ink" : "text-ink-muted"}>
                {h.by ? (h.by.name ?? "Someone") : "Automatic"}
              </span>
              <span className="text-ink">
                {": "}
                {h.note ?? h.rows.map((r) => r.label).join(" · ")}
              </span>
              {h.requestId ? <span className="text-ink-muted"> · approved request</span> : null}
              {h.authorization ? (
                <span className="text-ink-muted">
                  {" "}
                  · under the go-ahead {h.authorization.setBy.name ?? "the client admin"} gave{" "}
                  {dayWords(h.authorization.setAt)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
