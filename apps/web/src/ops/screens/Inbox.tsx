// `/ops/inbox`, Escalations (ARCHITECTURE §11, §15; not in the prototype, drafted in its style).
// Two views (UI cleanup, stream A):
// - "Needs us" (the command center's tile opens it): everything that needs us, as the command
//   center counts it. Failed runs, broken connections, low-confidence readings and approvals stuck
//   at a client (waiting over a day, or that nobody can act on) are rows that open their run or
//   page; the items for us (delegated approvals, escalations, test runs' questions, every item of
//   the Sandbox) are cards we resolve here.
// - "Waiting on clients": every open item in the clients' inboxes, each saying whom it waits on
//   and for how long.
// The client filter comes from the address (`?client=`), so a client's page links here filtered;
// the top bar's switcher is the one "All clients" control. We resolve only what the server marks as
// ours; resolving resumes the waiting run; an approval can be taken back inside its undo window.
import type { Escalation, OpsAgentRef } from "@countersign/core";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { InboxCard, outcomeText } from "../../inbox/InboxCard";
import { OPEN_RESOLVED, StatusFilter } from "../../inbox/StatusFilter";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import { AgentBadge } from "../../ui/badges";
import { Icon } from "../../ui/icons";
import { Loaded, Page, Section } from "../../ui/page";
import { buttonClass, Card, EmptyState, PageHeader } from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { escalationAction, escalationChip, escalationLine } from "../command/escalations";
import { age, NOBODY_TO_ACT_WORDS, plural } from "../run/words";

type Item = ResponseOf<typeof apiRoutes.opsInbox>["items"][number];
type View = "us" | "clients";

const ROLE_WORDS: Record<string, string> = {
  client_admin: "the client admin",
  client_user: "the client's team",
  operator: "us",
};

/**
 * Whether the signed-in operator may resolve an item: the server decides (`resolvableByOperator`,
 * packages/agents' mayResolve), including every item of the Sandbox client.
 */
export function operatorMayResolve(item: { resolvableByOperator: boolean }): boolean {
  return item.resolvableByOperator;
}

/** Inside its undo window: approved, and the run not told yet. */
function undoable(item: Pick<Item, "deliverAfter">): boolean {
  return !!item.deliverAfter && new Date(item.deliverAfter).getTime() > Date.now();
}

/** "Waiting on the client admin for 39 h. Only they can answer it.", and why nobody can. */
export function waitingOnLine(
  item: Pick<Item, "assigneeRole" | "assigneeUserId" | "createdAt">,
  stuck?: Escalation | undefined,
): string {
  const who = item.assigneeUserId
    ? "a named person at the client"
    : (ROLE_WORDS[item.assigneeRole ?? "client_admin"] ?? "the client");
  const why = stuck?.wait?.nobodyToAct ? ` ${NOBODY_TO_ACT_WORDS[stuck.wait.nobodyToAct]}` : "";
  return `Waiting on ${who} for ${age(item.createdAt)}. Only they can answer it.${why}`;
}

export function OpsInboxScreen() {
  const api = useApiClient();
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const view: View = params.get("view") === "clients" ? "clients" : "us";
  const client = params.get("client") ?? "";
  const [status, setStatus] = useState<"open" | "resolved">("open");
  // What we just resolved, kept on screen with Undo while its window lasts.
  const [recent, setRecent] = useState<Item[]>([]);
  const state = useApi(apiRoutes.opsInbox, {
    query: {
      assigned: view === "clients" ? "all" : "operator",
      status,
      ...(client ? { client } : {}),
    },
  });
  const needs = useApi(apiRoutes.opsNeedsUs, { query: client ? { client } : {} });
  const { data, loading, reload } = state;
  usePoll(reload, status === "open", 20_000, loading);
  usePoll(needs.reload, true, 20_000, needs.loading);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const clients = new Map(session.tenants.map((t) => [t.id, t.name]));
  const agents = new Map<string, OpsAgentRef>((data?.agents ?? []).map((a) => [a.id, a]));
  const recentIds = new Set(recent.map((i) => i.id));
  const items = (data?.items ?? []).filter(
    (i) => !recentIds.has(i.id) && (view === "us" || i.assigneeRole !== "operator"),
  );
  // Needs us beyond our own items (those are the cards): rows that open their run or page.
  const escalations = needs.data?.escalations ?? [];
  const rows = escalations.filter((e) => e.kind !== "item");
  const stuckByRun = new Map(
    escalations.filter((e) => e.kind === "approval" && e.runId).map((e) => [e.runId, e]),
  );

  const card = (item: Item) => {
    const agent = item.agentId ? agents.get(item.agentId) : undefined;
    const mine = operatorMayResolve(item);
    const resolution = (item.resolution ?? {}) as { approved?: unknown; decision?: unknown };
    const approved =
      typeof resolution.approved === "boolean"
        ? resolution.approved
        : resolution.decision === undefined
          ? null
          : resolution.decision === "approve";
    const byUs = item.resolvedBy === session.user.id;
    const by = byUs
      ? "you"
      : item.resolvedBy
        ? (ROLE_WORDS[item.assigneeRole ?? "client_admin"] ?? null)
        : null;
    return (
      <InboxCard
        key={item.id}
        item={item}
        context={[
          agent ? (agent.serviceName ?? agent.name) : null,
          clients.get(item.tenantId) ?? null,
          item.payload.testRun === true ? "test run" : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        runHref={item.runId ? `/ops/runs/${item.runId}` : null}
        recordHref={(id) => `/ops/clients/${item.tenantId}/records/${id}`}
        outcome={item.status === "resolved" ? outcomeText(item.kind, approved, by) : null}
        waitingOn={
          mine ? null : waitingOnLine(item, item.runId ? stuckByRun.get(item.runId) : undefined)
        }
        onResolve={
          item.status === "open" && mine
            ? async (body) => {
                const out = await api.call(apiRoutes.opsResolveInbox, {
                  params: { id: item.id },
                  body,
                });
                if (undoable(out.item)) setRecent((r) => [out.item, ...r]);
                reload();
                needs.reload();
              }
            : null
        }
        onUndo={
          item.status === "resolved" && byUs && undoable(item)
            ? async () => {
                await api.call(apiRoutes.opsUndoInbox, { params: { id: item.id } });
                setRecent((r) => r.filter((i) => i.id !== item.id));
                reload();
              }
            : null
        }
      />
    );
  };

  const needsCount = needs.data?.count;
  return (
    <Page testId="ops-escalations">
      <PageHeader
        title="Escalations"
        subtitle={
          view === "clients"
            ? "What waits in your clients' inboxes, and on whom."
            : needsCount === undefined
              ? "What needs us."
              : needsCount === 0
                ? "Nothing needs us."
                : `${plural(needsCount, "thing needs", "things need")} us.`
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <StatusFilter
          value={view}
          onChange={(v) => setParam("view", v === "clients" ? "clients" : null)}
          area="ops-inbox-view"
          label="Whose items"
          options={[
            ["us", "Needs us"],
            ["clients", "Waiting on clients"],
          ]}
        />
        <StatusFilter
          value={status}
          onChange={setStatus}
          area="ops-inbox"
          label="Status"
          options={OPEN_RESOLVED}
        />
        {client ? (
          <span className="ops-chip" data-testid="ops-inbox-client">
            <b>client</b> {clients.get(client) ?? "One client"}
            <button
              type="button"
              aria-label="Show every client"
              onClick={() => setParam("client", null)}
            >
              <Icon name="close" size={14} />
            </button>
          </span>
        ) : null}
      </div>
      {view === "us" && status === "open" && rows.length > 0 ? <NeedsUsRows rows={rows} /> : null}
      {recent.length > 0 ? (
        <Section title="Just resolved" meta="You can undo an approval for a short while.">
          <div className="flex flex-col gap-4" data-testid="ops-inbox-recent">
            {recent.map(card)}
          </div>
        </Section>
      ) : null}
      <Loaded state={state}>
        {() =>
          items.length === 0 ? (
            view === "us" && status === "open" && rows.length > 0 ? null : (
              <EmptyState>
                {status === "open"
                  ? view === "us"
                    ? "Nothing needs us. Approvals delegated to us, escalations and stuck approvals show here."
                    : "Nothing is waiting in your clients' inboxes."
                  : "Nothing resolved yet."}
              </EmptyState>
            )
          ) : (
            <div data-testid="ops-inbox-list" className="flex flex-col gap-4">
              {items.map(card)}
            </div>
          )
        }
      </Loaded>
    </Page>
  );
}

/** Needs us that isn't an item for us: what waits, on whom, how long, and a link to it. */
function NeedsUsRows({ rows }: { rows: Escalation[] }) {
  return (
    <Card title="Needs us" testId="ops-inbox-needs-us">
      {rows.map((e) => {
        const action = escalationAction(e);
        const chip = escalationChip(e);
        const who = e.agent ? (e.agent.serviceName ?? e.agent.name) : null;
        return (
          <div
            key={`${e.kind}:${e.id}`}
            className="ops-row"
            data-testid={`ops-inbox-needs-${e.id}`}
          >
            <StatusChip state={chip.state}>{chip.words}</StatusChip>
            {who ? <AgentBadge name={e.agent?.name ?? who} size="sm" /> : null}
            <span className="ops-row__text">
              <span className="font-medium text-ink">
                {[who, e.client.name].filter(Boolean).join(" · ")}
              </span>
              <span className="text-sm text-ink-muted">{escalationLine(e)}</span>
            </span>
            <Link to={action.to} className={buttonClass("secondary", undefined, "sm")}>
              {action.label}
            </Link>
          </div>
        );
      })}
    </Card>
  );
}
