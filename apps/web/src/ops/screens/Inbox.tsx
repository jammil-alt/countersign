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
import { KpiStrip, StatTile } from "../../ui/figures";
import { Icon } from "../../ui/icons";
import { Loaded, Page, Section } from "../../ui/page";
import { buttonClass, Card, EmptyState, PageHeader } from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import {
  escalationAction,
  escalationChip,
  escalationLine,
  escalationTone,
  sinceDate,
  URGENCY,
  type Urgency,
  urgencyOf,
} from "../command/escalations";
import { age, NOBODY_TO_ACT_WORDS, plural } from "../run/words";
// P-6
import { SCRIPT_DRAFT_SUBJECT, ScriptOfferLink } from "./BrowserScripts";
import { StepIn } from "./StepIn";

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
  // `?view=clients`, or a run page's "See it in Escalations" (`?assigned=all&client=`), opens on
  // what waits in the clients' inboxes; `?client=` narrows to one client.
  const [params, setParams] = useSearchParams();
  const view: View =
    params.get("view") === "clients" || params.get("assigned") === "all" ? "clients" : "us";
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
  // Needs us beyond our own items (those are the cards): rows that open their run or page.
  const escalations = needs.data?.escalations ?? [];
  // `?urgency=` narrows Needs us (the rows and our own items) to one level of urgency.
  const urgencyParam = params.get("urgency");
  const urgency = URGENCY.some((u) => u.id === urgencyParam) ? (urgencyParam as Urgency) : null;
  const now = new Date();
  const inLevel = (e: Escalation) => !urgency || urgencyOf(e, now) === urgency;
  const rows = escalations.filter((e) => e.kind !== "item" && inLevel(e));
  const itemLevel = new Map(
    escalations.filter((e) => e.kind === "item").map((e) => [e.id, urgencyOf(e, now)]),
  );
  const items = (data?.items ?? []).filter(
    (i) =>
      !recentIds.has(i.id) &&
      (view === "us" || i.assigneeRole !== "operator") &&
      (!urgency || view !== "us" || itemLevel.get(i.id) === urgency),
  );
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
    const shown = (
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
        // R5: the lead takes back a change that went ahead before a late no (the server checks
        // that this operator is the client's lead).
        onUndoChange={async () => {
          const out = await api.call(apiRoutes.opsUndoChange, { params: { id: item.id } });
          reload();
          return out;
        }}
        surface="ops"
      />
    );
    // P-6: a client's own item: theirs to answer, ours to step into when we must (§1.68).
    // Wave 4: a script-draft offer opens the recorder with its path.
    if (item.subjectType === SCRIPT_DRAFT_SUBJECT) {
      return (
        <div key={item.id} className="flex flex-col gap-2">
          {shown}
          <ScriptOfferLink item={item} />
        </div>
      );
    }
    if (mine || item.status !== "open") return shown;
    return (
      <div key={item.id} className="flex flex-col gap-2">
        {shown}
        <StepIn
          item={item}
          onDone={() => {
            reload();
            needs.reload();
          }}
        />
      </div>
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
      {view === "us" && status === "open" && escalations.length > 0 ? (
        <UrgencyFigures
          escalations={escalations}
          now={now}
          hrefFor={(u) => {
            const next = new URLSearchParams(params);
            if (u && u !== urgency) next.set("urgency", u);
            else next.delete("urgency");
            const q = next.toString();
            return q ? `?${q}` : "?";
          }}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <StatusFilter
          value={view}
          onChange={(v) => {
            const next = new URLSearchParams(params);
            next.delete("assigned");
            if (v === "clients") next.set("view", "clients");
            else next.delete("view");
            setParams(next, { replace: true });
          }}
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
        {urgency ? (
          <span className="ops-chip" data-testid="ops-inbox-urgency">
            <b>urgency</b> {URGENCY.find((u) => u.id === urgency)?.label}
            <button
              type="button"
              aria-label="Show every level"
              onClick={() => setParam("urgency", null)}
            >
              <Icon name="close" size={14} />
            </button>
          </span>
        ) : null}
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
            view === "us" && status === "open" && rows.length > 0 ? null : status === "open" &&
              view === "us" &&
              urgency ? (
              <EmptyState
                icon="filter"
                title="Nothing at this level"
                line="Pick another level of urgency, or show every level."
              />
            ) : status === "open" ? (
              <EmptyState
                tone="done"
                title={view === "us" ? "Nothing needs us" : "Your clients' inboxes are clear"}
                line={
                  view === "us"
                    ? "Approvals delegated to us, escalations and stuck approvals show here."
                    : "Approvals and questions waiting on a client's team show here."
                }
              />
            ) : (
              <EmptyState
                icon="check"
                title="Nothing resolved yet"
                line="What we and your clients resolve shows here."
              />
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
    <Card titleAbove title="Needs us" testId="ops-inbox-needs-us">
      {rows.map((e) => {
        const action = escalationAction(e);
        const chip = escalationChip(e);
        const who = e.agent ? (e.agent.serviceName ?? e.agent.name) : null;
        return (
          <div
            key={`${e.kind}:${e.id}`}
            className="ops-row ops-row--link ops-row--avatar ui-accent ui-accent--left"
            data-tone={escalationTone(chip.state)}
            data-testid={`ops-inbox-needs-${e.id}`}
          >
            {who ? <AgentBadge name={who} seed={e.agent?.id} size="sm" /> : <span />}
            <span className="ops-row__text">
              <span className="font-medium text-ink">
                {[who, e.client.name].filter(Boolean).join(" · ")}
              </span>
              <span className="text-sm text-ink-muted">{escalationLine(e)}</span>
            </span>
            <span className="ops-row__when">
              <StatusChip state={chip.state}>{chip.words}</StatusChip>
              <span
                className="text-xs text-ink-muted"
                data-testid={`ops-inbox-needs-${e.id}-since`}
              >
                Since {sinceDate(e.blockedSince)}
              </span>
            </span>
            <Link to={action.to} className={buttonClass("secondary", "ops-row__link", "sm")}>
              {action.label}
            </Link>
          </div>
        );
      })}
    </Card>
  );
}

/**
 * Needs us by urgency: a figure per level with its count and since when its oldest has waited,
 * each a link that narrows the list to that level (and back).
 */
function UrgencyFigures({
  escalations,
  now,
  hrefFor,
}: {
  escalations: Escalation[];
  now: Date;
  /** The link for a level: to it, or back to every level when it is the one shown. */
  hrefFor(u: Urgency): string;
}) {
  return (
    <KpiStrip testId="ops-inbox-urgency-figures">
      {URGENCY.map((u) => {
        const mine = escalations.filter((e) => urgencyOf(e, now) === u.id);
        const oldest = mine.reduce<string | null>(
          (min, e) => (min === null || e.blockedSince < min ? e.blockedSince : min),
          null,
        );
        return (
          <StatTile
            key={u.id}
            label={`${u.label} · ${u.range}`}
            value={mine.length}
            note={oldest ? `Oldest since ${sinceDate(oldest)}` : "None waiting"}
            tone={mine.length > 0 ? u.tone : undefined}
            alert={u.id === "urgent" && mine.length > 0}
            to={hrefFor(u.id)}
            testId={`ops-inbox-urgency-${u.id}`}
          />
        );
      })}
    </KpiStrip>
  );
}
