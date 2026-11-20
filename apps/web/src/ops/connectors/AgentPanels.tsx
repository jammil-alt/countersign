// The back office's agent panels (docs/connectors-plan.md §7; mockup docs/design/connectors.html
// screen 5). Needs: per connector, the record types and verbs a template or client agent reads and
// changes, from its steps' tools and skills (computed, never stored). Readiness: per connector of a
// client agent, Ready or what's missing and who fixes it. Our fixes go to the bind and grant
// controls on the same page; the client's go as a change request (Send to client, with a reason
// the client sees) with exactly the rows the agent is missing there.
import {
  type AgentReadinessPanel,
  connectorAccessRoutes as access,
  type OpsConnectionChangeResult,
  type OpsGapView,
  type OpsNeedView,
} from "@countersign/core";
import { useState } from "react";
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { Badge, Button, Card, ErrorNotice, Loading, SectionLabel } from "../../ui/primitives";
import { Field, Notice, TextArea } from "../agents/ui";
import { clientConnectorPath } from "./ClientConnector";
import {
  dayWords,
  fixByWords,
  GAP_WORDS,
  READINESS_WORDS,
  type ReadinessStateId,
  resultWords,
} from "./words";

/** A need in a few words: "Create bills (asks first)", "Bills". */
export function needWords(n: Pick<OpsNeedView, "label" | "level" | "wantsAuto" | "anyOf">): string {
  const parts = [n.label];
  if (n.level === "ask") parts.push("(asks first)");
  return parts.join(" ");
}

/** The ids the agent page's controls carry, so a fix of ours can bring them into view. */
export const BIND_ANCHOR = "agent-bindings";
export const GRANTS_ANCHOR = "agent-grants";

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function NeedsPanel({ agentId }: { agentId: string }) {
  const needs = useApi(access.opsAgentNeeds, { params: { id: agentId } });
  return (
    <Card title="What it needs from connectors" pad testId="agent-needs">
      {needs.error ? <ErrorNotice error={needs.error} onRetry={needs.reload} /> : null}
      {needs.loading && !needs.data ? <Loading /> : null}
      {needs.data ? (
        needs.data.connectors.length === 0 ? (
          <p className="text-ink-muted">It needs no connector.</p>
        ) : (
          <>
            <p className="mb-3 text-sm text-ink-muted">
              From its steps' tools and skills.{" "}
              {needs.data.agent.template
                ? "Each client it's forked into needs these on its connections."
                : "Readiness, in Settings, says what this client still has to allow."}
            </p>
            <ul className="flex flex-col gap-4">
              {needs.data.connectors.map((c) => {
                const reads = c.needs.filter((n) => n.verb === "read");
                const changes = c.needs.filter((n) => n.verb !== "read");
                return (
                  <li key={c.connector} data-testid={`agent-needs-${c.connector}`}>
                    <p className="font-medium text-ink">{c.name}</p>
                    <NeedLine label="Reads" needs={reads} />
                    <NeedLine label="Changes" needs={changes} />
                  </li>
                );
              })}
            </ul>
          </>
        )
      ) : null}
    </Card>
  );
}

function NeedLine({ label, needs }: { label: string; needs: readonly OpsNeedView[] }) {
  if (needs.length === 0) return null;
  const alone = needs.filter((n) => n.wantsAuto).map((n) => n.label);
  const anyOf = needs.some((n) => n.anyOf !== null);
  return (
    <div className="mt-1 text-sm">
      <span className="text-ink-muted">{label}: </span>
      <span className="text-ink">{needs.map(needWords).join(", ")}</span>
      {alone.length > 0 ? (
        <span className="block text-ink-muted">
          Set to run on its own in a step: {alone.join(", ")}. It asks first until the client allows
          that.
        </span>
      ) : null}
      {anyOf ? (
        <span className="block text-ink-muted">Some are alternatives: one of them is enough.</span>
      ) : null}
    </div>
  );
}

type ReadinessConnector = AgentReadinessPanel["connectors"][number];

export function ReadinessPanel({ agentId, clientId }: { agentId: string; clientId: string }) {
  const client = useApi(apiRoutes.opsClient, { params: { id: clientId } });
  const clientName = client.data?.client.name ?? "the client";
  const readiness = useApi(access.opsAgentReadiness, { params: { id: agentId }, query: {} });
  const needs = useApi(access.opsAgentNeeds, { params: { id: agentId } });
  const needsOf = (connector: string) =>
    needs.data?.connectors.find((c) => c.connector === connector)?.needs ?? [];
  const data = readiness.data;
  return (
    <Card className="p-5" testId="agent-readiness">
      <SectionLabel>
        <span className="flex items-center gap-2">
          Readiness
          {data ? (
            data.ready ? (
              <Badge tone="positive" testId="agent-readiness-state">
                Ready
              </Badge>
            ) : (
              <Badge tone="warning" testId="agent-readiness-state">
                Waiting on connectors
              </Badge>
            )
          ) : null}
        </span>
      </SectionLabel>
      <p className="mb-4 text-sm text-ink-muted">
        What this agent needs from {clientName}'s connectors, from its steps' tools and skills. The
        setup checklist holds the trial until every connector is ready.
      </p>
      {readiness.error ? <ErrorNotice error={readiness.error} onRetry={readiness.reload} /> : null}
      {readiness.loading && !data ? <Loading /> : null}
      {data && data.connectors.length === 0 ? (
        <p className="text-sm text-ink-muted">It needs no connector.</p>
      ) : null}
      {data && data.connectors.length > 0 ? (
        <ul className="flex flex-col">
          {data.connectors.map((c) => (
            <ReadinessRow
              key={c.connector}
              agentId={agentId}
              clientId={clientId}
              clientName={clientName}
              row={c}
              needs={needsOf(c.connector)}
              onSent={readiness.reload}
            />
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function ReadinessRow({
  agentId,
  clientId,
  clientName,
  row: c,
  needs,
  onSent,
}: {
  agentId: string;
  clientId: string;
  clientName: string;
  row: ReadinessConnector;
  needs: readonly OpsNeedView[];
  onSent(): void;
}) {
  const [words, tone] = READINESS_WORDS[c.state as ReadinessStateId] ?? ["Not ready", "warning"];
  const ours = c.gaps.filter((g) => g.fixBy === "mezonas" && g.blocking);
  const theirs = c.gaps.filter((g) => g.fixBy === "client" && g.blocking);
  // DECISION (C6): a request needs a connection (`ReadinessSendBody.connectionId`), so a connector
  // not connected, or one to sign in to again, has no Send to client: the client connects it from
  // their portal (Getting started and the needs banner already ask them).
  const sendable = theirs.find((g) => g.connectionId !== null)?.connectionId ?? c.connectionId;
  const canSend =
    theirs.some((g) => g.kind !== "not_connected" && g.kind !== "broken") && !!sendable;
  return (
    <li
      className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0"
      data-testid={`agent-readiness-${c.connector}`}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <Link
            to={clientConnectorPath(clientId, c.connector, agentId)}
            className="font-medium text-ink hover:underline"
          >
            {c.name}
          </Link>
          {needs.length > 0 ? (
            <p className="text-sm text-ink-muted">{needs.map(needWords).join(" · ")}</p>
          ) : null}
        </div>
        <Badge tone={tone} testId="agent-readiness-row-state">
          {words}
        </Badge>
      </div>
      {c.state === "could_run_alone" ? (
        <p className="text-sm text-ink-muted">
          Ready. A step set to run on its own still asks first here; only {clientName} can allow
          that.
        </p>
      ) : null}
      {ours.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {ours.map((g) => (
            <OurFix key={gapKey(g)} gap={g} />
          ))}
        </ul>
      ) : null}
      {theirs.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {theirs.map((g) => (
            <li key={gapKey(g)} className="text-ink">
              {g.words}{" "}
              <span className="text-ink-muted">
                · {GAP_WORDS[g.kind]} · {fixByWords(g.fixBy, clientName)}
                {g.kind === "not_connected"
                  ? " connects it from their portal"
                  : g.kind === "broken"
                    ? " signs in again from their portal"
                    : " allows it"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {c.openRequest ? (
        <p className="text-sm text-ink-muted" data-testid="agent-readiness-open-request">
          <Badge tone="warning">Waiting on {clientName}</Badge> Request sent{" "}
          {dayWords(c.openRequest.createdAt)}: {c.openRequest.rows.map((r) => r.label).join(" · ")}
        </p>
      ) : null}
      {canSend && sendable ? (
        <SendToClient
          agentId={agentId}
          connectionId={sendable}
          clientName={clientName}
          again={c.openRequest !== null}
          onSent={onSent}
        />
      ) : null}
    </li>
  );
}

const gapKey = (g: OpsGapView) => `${g.kind}:${g.connectionId ?? ""}:${g.words}`;

/** A fix of ours: bind the connection, or widen the grant, on this page. */
function OurFix({ gap: g }: { gap: OpsGapView }) {
  const target =
    g.kind === "not_bound" ? BIND_ANCHOR : g.kind === "off_in_grant" ? GRANTS_ANCHOR : null;
  return (
    <li className="flex flex-wrap items-center gap-2 text-ink">
      {g.words}
      <span className="text-ink-muted">· {GAP_WORDS[g.kind]} · us</span>
      {target ? (
        <Button
          size="sm"
          variant="link"
          data-testid={`agent-readiness-fix-${g.kind}`}
          onClick={() => scrollTo(target)}
        >
          {g.kind === "not_bound" ? "Bind" : "Widen the grant"}
        </Button>
      ) : null}
    </li>
  );
}

/** Send to client: a change request with exactly the rows the agent is missing there. */
function SendToClient({
  agentId,
  connectionId,
  clientName,
  again,
  onSent,
}: {
  agentId: string;
  connectionId: string;
  clientName: string;
  again: boolean;
  onSent(): void;
}) {
  const api = useApiClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [result, setResult] = useState<OpsConnectionChangeResult | null>(null);

  async function send() {
    if (!reason.trim()) {
      setMissing(true);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await api.call(access.opsAgentReadinessSend, {
        params: { id: agentId },
        body: { connectionId, reason: reason.trim() },
      });
      setResult(res);
      setOpen(false);
      setReason("");
      onSent();
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Notice tone="positive" testId="agent-readiness-sent">
        {resultWords(result, clientName, false)}
      </Notice>
    );
  }
  if (!open) {
    return (
      <div>
        <Button size="sm" data-testid="agent-readiness-send-start" onClick={() => setOpen(true)}>
          {again ? "Send to client again" : "Send to client"}
        </Button>
      </div>
    );
  }
  return (
    <div
      className="rounded-sm border border-line bg-surface-subtle p-3"
      data-testid="agent-readiness-send"
    >
      <Field
        label={`Why (${clientName} sees this)`}
        error={missing ? "Say why: it's required." : undefined}
      >
        <TextArea
          data-testid="agent-readiness-send-reason"
          rows={2}
          value={reason}
          invalid={missing}
          onChange={(e) => {
            setReason(e.target.value);
            if (e.target.value.trim()) setMissing(false);
          }}
        />
      </Field>
      {again ? (
        <p className="mt-2 text-sm text-ink-muted">It replaces the request that's open.</p>
      ) : null}
      {problem ? (
        <div className="mt-2">
          <ErrorNotice error={problem} />
        </div>
      ) : null}
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          data-testid="agent-readiness-send-confirm"
          working={busy}
          onClick={() => void send()}
        >
          Send to {clientName}
        </Button>
      </div>
    </div>
  );
}
