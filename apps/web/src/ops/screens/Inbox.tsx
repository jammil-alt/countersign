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
// its chip clears it (the top bar's picker only opens a client's page). We resolve only what the server marks as
// ours; resolving resumes the waiting run; an approval can be taken back inside its undo window.
import {
  type Escalation,
  isWaitingReminder,
  itemFingerprint,
  type OpsAgentRef,
} from "@countersign/core";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi, useApiClient } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import {
  BADGE_ACCENT,
  InboxCard,
  inboxItemTitle,
  outcomeText,
  statusBadge,
} from "../../inbox/InboxCard";
import { OPEN_RESOLVED, StatusFilter } from "../../inbox/StatusFilter";
import { shortTime } from "../../runs/format";
import { usePoll } from "../../runs/usePoll";
import { useSession } from "../../session/session";
import { AgentBadge } from "../../ui/badges";
import { cx } from "../../ui/cx";
import { KpiStrip, StatTile } from "../../ui/figures";
import { Icon } from "../../ui/icons";
import { Loaded, Page, Section } from "../../ui/page";
import { Badge, buttonClass, Card, EmptyState, PageHeader } from "../../ui/primitives";
import { SideSheet } from "../../ui/sheet";
import { SkeletonRows, SkeletonStats } from "../../ui/skeleton";
import { StatusChip } from "../../ui/status";
import {
  escalationAction,
  escalationChip,
  escalationLine,
  escalationsCalls,
  escalationTone,
  sinceDate,
  URGENCY,
  type Urgency,
  urgencyOf,
} from "../command/escalations";
import { useKept } from "../command/kept";
import { usePrefetchOnIntent } from "../command/prefetch";
import { SaveAsCase } from "../lab/SaveAsCase";
import { useShareCounts } from "../OpsLayout";
import { age, NOBODY_TO_ACT_WORDS, plural } from "../run/words";
// P-6
import { SCRIPT_DRAFT_SUBJECT, ScriptOfferLink } from "./BrowserScripts";
import { SimilarItems } from "./InboxBulk";
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

/**
 * "Waiting on the client admin for 10 days. Only they can answer it."; or, when nobody there can
 * act on it (it is in Needs us), why: "… for 10 days. Nobody at the client may approve it."
 */
export function waitingOnLine(
  item: Pick<Item, "assigneeRole" | "assigneeUserId" | "createdAt">,
  stuck?: Escalation | undefined,
): string {
  const who = item.assigneeUserId
    ? "a named person at the client"
    : (ROLE_WORDS[item.assigneeRole ?? "client_admin"] ?? "the client");
  const why = stuck?.wait?.nobodyToAct
    ? NOBODY_TO_ACT_WORDS[stuck.wait.nobodyToAct]
    : "Only they can answer it.";
  return `Waiting on ${who} for ${age(item.createdAt)}. ${why}`;
}

export function OpsInboxScreen() {
  const api = useApiClient();
  const session = useSession();
  const i18n = useI18n();
  // `?view=clients`, or a run page's "See it in Escalations" (`?assigned=all&client=`), opens on
  // what waits in the clients' inboxes; `?client=` narrows to one client.
  const [params, setParams] = useSearchParams();
  const view: View =
    params.get("view") === "clients" || params.get("assigned") === "all" ? "clients" : "us";
  const client = params.get("client") ?? "";
  const [status, setStatus] = useState<"open" | "resolved">("open");
  // What we just resolved, kept on screen with Undo while its window lasts.
  const [recent, setRecent] = useState<Item[]>([]);
  const calls = escalationsCalls({ view, status, client });
  // DECISION: switching the view or Open/Resolved keeps the list on screen, dimmed, while the new
  // one loads (docs/audit-plan.md 1.8); narrowing to one client does not (`keep` is never for a
  // query that names a client, §1.91), so another client's items never show under its chip.
  const state = useApi(apiRoutes.opsInbox, { ...calls.inbox, keep: !client });
  const needs = useApi(apiRoutes.opsNeedsUs, calls.needsUs);
  const { data, loading, reload } = state;
  // A switch of view or status is showing the last list while the new one loads.
  const kept = useKept(JSON.stringify(calls.inbox), data);
  usePoll(reload, status === "open", 20_000, loading);
  usePoll(needs.reload, true, 20_000, needs.loading);
  // DECISION: Needs us across every client is the frame's count, so this page hands it to the
  // frame, which asks GET /api/ops/counts for nothing while it is open (docs/audit-plan.md 2.3),
  // as the command center does. Narrowed to one client it has no total to give, and the frame asks.
  // Per-client counts are not in this answer; no screen under Escalations shows them.
  const needsCount = needs.data?.count;
  const shared = useMemo(
    () =>
      client ? undefined : needsCount === undefined ? null : { needsUs: needsCount, clients: [] },
    [client, needsCount],
  );
  useShareCounts(shared);
  const intent = usePrefetchOnIntent();

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
  // The supervisor's "1 item is still waiting" is a reminder about the items listed here, not an
  // item of its own (QA, 2026-11-22): left out, as the counts leave it out.
  const items = (data?.items ?? []).filter(
    (i) =>
      !recentIds.has(i.id) &&
      !isWaitingReminder(i) &&
      (view === "us" || i.assigneeRole !== "operator") &&
      (!urgency || view !== "us" || itemLevel.get(i.id) === urgency),
  );
  // A client's item nobody there can act on: the approval escalation that covers it.
  const stuckByItem = new Map(
    escalations
      .filter((e) => e.kind === "approval")
      .flatMap((e) => (e.itemIds ?? [e.id]).map((id) => [id, e] as const)),
  );
  // What a link from Home or Needs us opens: one item (`?item=`, its sheet), or an approval
  // escalation's items (`?stuck=`), marked in the list and scrolled to.
  const stuckId = params.get("stuck");
  const marked = new Set(
    stuckId ? (escalations.find((e) => e.id === stuckId)?.itemIds ?? [stuckId]) : [],
  );

  // What a row and its card both say about an item: who asks, for whom, how it ended, whom it
  // waits on.
  const describe = (item: Item) => {
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
    return {
      agent,
      mine,
      byUs,
      approved,
      context: [
        agent ? (agent.serviceName ?? agent.name) : null,
        clients.get(item.tenantId) ?? null,
        item.payload.testRun === true ? "test run" : null,
      ]
        .filter(Boolean)
        .join(" · "),
      outcome: item.status === "resolved" ? outcomeText(item.kind, approved, by) : null,
      // S4.4 (QA2 HM3): only an open item waits on anyone; a resolved or expired one never says
      // "Waiting on the client admin for 11 days".
      waitingOn:
        mine || item.status !== "open" ? null : waitingOnLine(item, stuckByItem.get(item.id)),
    };
  };

  // Feedback (2026-11-15): "smaller boxes that open up to a side modal". Each item is one row;
  // the row opens its whole card (the change, the run, the decision) in a side sheet, kept in the
  // address as `?item=` so a link opens it.
  const openId = params.get("item");
  const openItem = (id: string | null) => setParam("item", id);
  // The first marked row in view once the list is here (QA, 2026-11-22: "Open item" shows it).
  // Only an id the list holds is looked for, so the address never reaches the selector raw.
  const firstMarked = openId ?? [...marked][0] ?? null;
  const listed = Boolean(firstMarked && data?.items.some((i) => i.id === firstMarked));
  useEffect(() => {
    if (!listed || !firstMarked) return;
    document
      .querySelector(`[data-testid="ops-inbox-row-${firstMarked}"]`)
      ?.scrollIntoView?.({ block: "center" });
  }, [listed, firstMarked]);
  const row = (item: Item) => {
    const { agent, context, outcome, waitingOn } = describe(item);
    const badge = statusBadge(item, outcome, i18n);
    const title = inboxItemTitle(item, i18n);
    return (
      <div
        key={item.id}
        className="ops-row ops-row--link ops-row--avatar ui-accent ui-accent--left relative"
        data-tone={BADGE_ACCENT[badge.tone]}
        data-testid={`ops-inbox-row-${item.id}`}
        aria-current={openId === item.id || marked.has(item.id) ? "true" : undefined}
      >
        {agent ? (
          <AgentBadge name={agent.serviceName ?? agent.name} seed={agent.id} size="sm" />
        ) : (
          <span />
        )}
        <span className="ops-row__text">
          <button
            type="button"
            className="ops-row__link truncate text-left font-medium text-ink"
            data-testid={`ops-inbox-row-${item.id}-open`}
            onClick={() => openItem(item.id)}
          >
            {title}
          </button>
          <span className="truncate text-sm text-ink-muted">
            {[context, waitingOn].filter(Boolean).join(" · ")}
          </span>
        </span>
        <span className="ops-row__when">
          <Badge tone={badge.tone} testId={`ops-inbox-row-${item.id}-status`}>
            {badge.label}
          </Badge>
          <span className="text-xs text-ink-muted">
            {shortTime(item.resolvedAt ?? item.createdAt, undefined, i18n)}
          </span>
        </span>
      </div>
    );
  };

  const card = (item: Item) => {
    const { mine, byUs, approved, context, outcome, waitingOn } = describe(item);
    const shown = (
      <InboxCard
        key={item.id}
        item={item}
        context={context}
        runHref={item.runId ? `/ops/runs/${item.runId}` : null}
        recordHref={(id) => `/ops/clients/${item.tenantId}/records/${id}`}
        documentHref={(id) => `/ops/clients/${item.tenantId}/documents/${id}`}
        outcome={outcome}
        waitingOn={waitingOn}
        onResolve={
          item.status === "open" && mine
            ? async (body) => {
                // Audit 3.4: the answer names the card as it is on screen.
                const out = await api.call(apiRoutes.opsResolveInbox, {
                  params: { id: item.id },
                  body: { ...body, fingerprint: await itemFingerprint(item) },
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
                needs.reload();
              }
            : null
        }
        // R5: the lead takes back a change that went ahead before a late no (the server checks
        // that this operator is the client's lead).
        onUndoChange={async () => {
          const out = await api.call(apiRoutes.opsUndoChange, { params: { id: item.id } });
          reload();
          needs.reload();
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
    // §1.212: an approved (or corrected) change of a run: one click saves it as a test case.
    if (
      item.status === "resolved" &&
      approved === true &&
      item.runId &&
      (item.kind === "approval" || item.kind === "external_action")
    ) {
      return (
        <div key={item.id} className="flex flex-col gap-2">
          {shown}
          <SaveAsCase itemId={item.id} />
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

  // The open item: from what we just resolved first (it carries its Undo), else the list.
  const sheetItem = openId
    ? (recent.find((i) => i.id === openId) ?? data?.items.find((i) => i.id === openId) ?? null)
    : null;

  return (
    <Page testId="ops-escalations">
      <PageHeader
        title="Escalations"
        subtitle={
          view === "clients"
            ? "What waits in your clients' inboxes, and on whom."
            : needsCount === undefined
              ? "What needs us."
              : // QA (2026-11-22): Needs us and Your call count different things; said here.
                `${needsCount === 0 ? "Nothing needs us." : `${plural(needsCount, "thing needs", "things need")} us: work blocked until we act.`} Your to-dos, builds and runs to check are on Your call.`
        }
      />
      {view === "us" && status === "open" && needs.data === undefined && !needs.error ? (
        <SkeletonStats count={URGENCY.length} />
      ) : view === "us" &&
        status === "open" &&
        needs.data !== undefined &&
        escalations.length === 0 ? (
        // Where the figures' skeleton was: the page's answer, so nothing below moves up.
        <EmptyState
          tone="done"
          testId="ops-inbox-clear"
          title="Nothing needs us"
          line="Approvals delegated to us, escalations and stuck approvals show here."
        />
      ) : view === "us" && status === "open" && escalations.length > 0 ? (
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
      {view === "us" && status === "open" && rows.length > 0 ? (
        <div {...intent}>
          <NeedsUsRows rows={rows} />
        </div>
      ) : null}
      {recent.length > 0 ? (
        <Section title="Just resolved" meta="You can undo an approval for a short while.">
          <Card className="overflow-hidden" testId="ops-inbox-recent">
            {recent.map(row)}
          </Card>
        </Section>
      ) : null}
      {status === "open" && !kept ? (
        <SimilarItems
          items={items}
          context={(i) => describe(i).context}
          onDone={() => {
            reload();
            needs.reload();
          }}
        />
      ) : null}
      <Loaded state={state} skeleton={<InboxSkeleton />}>
        {() =>
          items.length === 0 ? (
            view === "us" &&
            status === "open" &&
            (rows.length > 0 ||
              (needs.data !== undefined && escalations.length === 0)) ? null : status === "open" &&
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
            <div
              data-testid="ops-inbox-list"
              className={cx("transition-opacity", kept && "opacity-60")}
              aria-busy={kept || undefined}
              inert={kept}
              {...intent}
            >
              <Card className="overflow-hidden">{items.map(row)}</Card>
            </div>
          )
        }
      </Loaded>
      {sheetItem ? (
        <SideSheet
          wide
          testId="ops-inbox-sheet"
          title={inboxItemTitle(sheetItem, i18n)}
          onClose={() => openItem(null)}
        >
          {card(sheetItem)}
        </SideSheet>
      ) : null}
    </Page>
  );
}

/** The items while they load: rows the height of an item's row. */
function InboxSkeleton() {
  return <SkeletonRows rows={4} />;
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
