// The client portal (ARCHITECTURE §14, §10.6): services, inbox, run timelines and connections.
// Every handler runs inside withTenant(the session's one client). Nothing here returns an agent
// bundle, instructions, prompts, model output outside step summaries, or cost (invariant 11):
// responses are parsed against contract schemas that have no such fields, and free-form payloads
// are scrubbed besides.

import type { Approver } from "@countersign/agents";
import type { Session } from "@countersign/auth";
import {
  applyMatrixChange,
  type Connector,
  describeAccess,
  type MatrixChangeRefusal,
  normalizeMatrix,
  UPLOAD_CONNECTOR_ID,
} from "@countersign/connectors";
import {
  type AnyAgentBundle,
  type ConnectorAuth,
  checkKindOf,
  clientLabel,
  clientStepData,
  connectionLabel,
  connectorShown,
  findNodeStep,
  isPlainObject,
  LEAD_ASSIGNEE,
  leadCheckLabel,
  type PermissionEntity,
  portalRunFilter,
  type Role,
  routes,
  type Step,
  shownOnTimeline,
  stepNodeOf,
  stepStateLabel,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  connection,
  connectionChange,
  externalAction,
  inboxItem,
  membership,
  run,
  stepRun,
  type Tx,
  tenant,
} from "@countersign/db";
import type { EventRow } from "@countersign/senses";
import { and, desc, eq, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { changeDisplay, clientTitles, itemDisplay, plainTitle } from "../change-display";
import { syncedRefNames } from "../change-names";
// P-6
import { mayControlConversation } from "../converse/control";
// P-4
import { portalConversation, runConversations } from "../converse/views";
import { type AppEnv, HttpError, iso, mount, notFound } from "../http";
import { type InboxRow, resolveInboxItem, scrubForPortal, sendResolution } from "../inbox";
// v0.13 W2-I
import { timelineOversight } from "../oversight/views";
import type { Platform } from "../platform";
import {
  clientRunsPerDay,
  clientStatusWhere,
  clientWaits,
  OPEN_RUN,
  openRunsByAgent,
} from "../runs/client-status";
import { dispatchEvents } from "../runs/dispatch";
import { runSubjects, sourceNames } from "../runs/subject";
import { actionTimelineWrite, timelineWrite } from "../skill-facts";
import { steppedInOf } from "../step-in/service";
import { clientDescription } from "../weekly/stats";
import { lastActivityOf, sourceActivity, usedByWith } from "./built-in-sources";
import { matrixEdit } from "./mappers";
import {
  isClientCheckRow,
  stepFinder,
  stepOfRow,
  type TimelineStepDef,
  timelineChecks,
} from "./run-checks";
import { runFilterWhere } from "./run-controls";
import { latestHealthSummary, portalFindings } from "./supervisor";
// v0.12 W1-C
import { leadFirstName } from "./threads";

type ConnectionRow = typeof connection.$inferSelect;
/** The workflow (or v4 process) a run ran, as its version's bundle holds it. */
type RunWorkflow = AnyAgentBundle["workflows"][number]["workflow"];

/**
 * What a client user may see of the inbox: never the operator's items (escalations, budget hits,
 * test runs); client users only what is assigned to them (ARCHITECTURE §11).
 */
export function portalInboxFilter(role: Role, userId: string): SQL {
  const notOperator = or(isNull(inboxItem.assigneeRole), ne(inboxItem.assigneeRole, "operator"));
  if (role === "client_admin") return notOperator as SQL;
  // v0.12 W1-D: items routed to the role skip viewers (`membership.can_sign` false).
  const signs = sql`exists (select 1 from ${membership} where ${membership.tenantId} = ${inboxItem.tenantId} and ${membership.userId} = ${userId} and ${membership.canSign})`;
  return and(
    notOperator,
    or(
      eq(inboxItem.assigneeUserId, userId),
      and(isNull(inboxItem.assigneeUserId), eq(inboxItem.assigneeRole, "client_user"), signs),
    ),
  ) as SQL;
}

/** v0.12 W1-D: open items snoozed until later are out of "waiting" (ARCHITECTURE §11.1). */
export function snoozedNow(snoozed: boolean): SQL {
  return snoozed
    ? sql`${inboxItem.snoozedUntil} > now()`
    : sql`(${inboxItem.snoozedUntil} is null or ${inboxItem.snoozedUntil} <= now())`;
}

async function userNames(tx: Tx, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => v !== null))];
  if (wanted.length === 0) return new Map<string, string | null>();
  const rows = await tx
    .select({ id: appUser.id, name: appUser.name })
    .from(appUser)
    .where(inArray(appUser.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** UI-1b: the client agents items belong to, by id, as the portal names them (its service name). */
async function serviceRefs(tx: Tx, rows: InboxRow[]) {
  const wanted = [...new Set(rows.map((r) => r.agentId).filter((v): v is string => v !== null))];
  if (wanted.length === 0) return new Map<string, { id: string; name: string }>();
  const agents = await tx
    .select({ id: agent.id, name: agent.name, serviceName: agent.serviceName })
    .from(agent)
    .where(
      and(
        inArray(agent.id, wanted),
        inArray(agent.tenantId, [...new Set(rows.map((r) => r.tenantId))]),
        eq(agent.kind, "client"),
      ),
    );
  return new Map(agents.map((a) => [a.id, { id: a.id, name: serviceName(a) }]));
}

export async function portalItems(tx: Tx, rows: InboxRow[], platform: Platform) {
  // Speed run: the four lookups are independent, so they are asked together.
  const [names, services, titles, refNames] = await Promise.all([
    userNames(
      tx,
      rows.map((r) => r.resolvedBy),
    ),
    serviceRefs(tx, rows),
    clientTitles(tx, rows, platform),
    // QA round 1: ids the before state leaves unnamed are named from the synced records.
    syncedRefNames(tx, platform, rows),
  ]);
  const displayOf = (i: InboxRow) => {
    const view = itemDisplay(platform, i);
    const names = refNames.get(i.id);
    return view && names ? { ...view, names } : view;
  };
  return rows.map((i) => ({
    id: i.id,
    kind: i.kind,
    title: titles.get(i.id) ?? plainTitle(i),
    payload: scrubForPortal(i.payload) as Record<string, unknown>,
    display: displayOf(i),
    status: i.status,
    runId: i.runId,
    dueAt: iso(i.dueAt),
    createdAt: i.createdAt.toISOString(),
    resolvedAt: iso(i.resolvedAt),
    // P-6: when we stepped in, the portal names no person of ours (docs/plan.md §1.68).
    resolvedBy: i.resolvedBy
      ? { id: i.resolvedBy, name: steppedInOf(i) ? null : (names.get(i.resolvedBy) ?? null) }
      : null,
    steppedIn: steppedInOf(i),
    // v0.12 W1-D: the Desk's undo window, snooze and batch.
    deliverAfter: iso(i.deliverAfter),
    snoozedUntil: iso(i.snoozedUntil),
    batchKey: i.batchKey,
    // UI-1b: which of the client's agents asks, for the Desk's list (null for platform items).
    service: (i.agentId ? services.get(i.agentId) : undefined) ?? null,
  }));
}

const serviceName = (a: Pick<typeof agent.$inferSelect, "serviceName" | "name">) =>
  a.serviceName ?? a.name;

/** The run and agent columns a run summary shows (6.2: never whole rows). */
const summaryColumns = {
  id: run.id,
  tenantId: run.tenantId,
  status: run.status,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  trigger: run.trigger,
  agentId: agent.id,
  agentName: agent.name,
  serviceName: agent.serviceName,
};
type SummaryRow = {
  id: string;
  tenantId: string;
  status: (typeof run.$inferSelect)["status"];
  startedAt: Date | null;
  finishedAt: Date | null;
  trigger: unknown;
  agentId: string;
  agentName: string;
  serviceName: string | null;
};

/** Summaries of runs already read: their waits on the client and subjects, asked together. */
async function summarize(
  tx: Tx,
  tenantId: string,
  rows: readonly SummaryRow[],
  platform?: Pick<Platform, "tools" | "connectors">,
) {
  const [waits, subjects] = await Promise.all([
    // QA round 1: whether each run waits on the client now, and how long it waited on the client.
    clientWaits(
      tx,
      tenantId,
      rows.map((r) => r.id),
    ),
    platform ? runSubjects(tx, [tenantId], rows, platform) : undefined,
  ]);
  return rows.map((r) => {
    const w = waits.get(r.id);
    const going = (OPEN_RUN as readonly string[]).includes(r.status);
    return {
      id: r.id,
      service: { id: r.agentId, name: r.serviceName ?? r.agentName },
      status: r.status,
      startedAt: iso(r.startedAt),
      finishedAt: iso(r.finishedAt),
      waitingOnYou: going && (r.status === "waiting" || (w?.waitingOnYou ?? false)),
      waitedMs: Math.round(w?.waitedMs ?? 0),
      ...(subjects?.has(r.id) ? { subject: subjects.get(r.id) } : {}),
    };
  });
}

/** Live runs of the client's services, newest first (test runs never reach the portal). */
export async function runSummaries(
  tx: Tx,
  tenantId: string,
  where: SQL[],
  limit: number,
  /** For each run's subject (core RunSubject): the tool registry names its first change. */
  platform?: Pick<Platform, "tools" | "connectors">,
) {
  const rows = await tx
    .select(summaryColumns)
    .from(run)
    .innerJoin(agent, and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)))
    .where(and(eq(run.tenantId, tenantId), eq(run.mode, "live"), ...where))
    .orderBy(desc(run.createdAt))
    .limit(limit);
  return summarize(tx, tenantId, rows, platform);
}

/**
 * A step's stored line without the label it starts with ("Itemized the bill: waiting for
 * approval" → "Waiting for approval"): the timeline shows the label above it already, and lines
 * written before steps read by their state carried the done label while they waited.
 */
export function summaryAfterLabel(
  summary: string | null,
  labels: readonly string[],
): string | null {
  if (summary === null) return null;
  for (const label of labels) {
    const prefix = `${label}: `;
    if (label !== "" && summary.startsWith(prefix)) {
      const rest = summary.slice(prefix.length).trim();
      return rest === "" ? null : rest.charAt(0).toUpperCase() + rest.slice(1);
    }
  }
  return summary;
}

/** Record ids a step's output cites (`output.sources`, invariant 10), for the client timeline. */
// DECISION: the timeline's sources are only the string ids in `output.sources`; nothing else of a
// step's output reaches the portal (model text stays out, ARCHITECTURE §10.6).
export function sourcesOf(output: unknown): string[] {
  const s = isPlainObject(output) ? output.sources : undefined;
  return Array.isArray(s) ? s.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Whether the client can sign in to a connector from the portal now.
 */
// DECISION: connectors that need no provider sign-in (`auth: 'none'`: the testkit, webhooks)
// connect at once; OAuth connectors (Zoho CRM) sign in through the provider once the deployment
// has their client and the state secret (`isConfigured`); others show "not available yet".
export function canSignIn(
  connector: Pick<Connector, "manifest" | "isConfigured" | "authorize" | "beginLink"> | undefined,
): boolean {
  if (!connector) return false;
  // v0.14 W4-E: a connector without sign-in may still need the deployment's keys (Google Chat).
  if (connector.manifest.auth === "none") return connector.isConfigured?.() !== false;
  if (connector.manifest.auth === "oauth2") {
    // v0.12 bankfeed: or a hosted link widget (Plaid Link) in place of a redirect.
    return (
      Boolean(connector.authorize || connector.beginLink) && connector.isConfigured?.() !== false
    );
  }
  // API-key connectors with a credential form: the client admin enters the key (Access page).
  return hasCredentialForm(connector);
}

/** An API-key connector whose credentials the client admin enters (docs/plan.md §1.26). */
export function hasCredentialForm(connector: Pick<Connector, "manifest"> | undefined): boolean {
  return connector?.manifest.auth === "api_key" && Boolean(connector.manifest.credentialFields);
}

/**
 * Connectors for a person's own account: a client user may sign in to theirs (and disconnect what
 * they connected), not only the client admin (ARCHITECTURE §6.4, plan M10).
 */
// DECISION: named here, where apps/api names connectors, rather than in the manifest: Gmail is the
// only one, and the rule is the portal's, not the connector's.
export const PERSONAL_CONNECTORS: ReadonlySet<string> = new Set(["gmail"]);

interface PortalConnectionRow {
  connection: {
    id: string;
    status: string;
    externalAccountId: string | null;
    accountName: string | null;
    lastSyncAt: string | null;
    lastActivityAt: string | null;
    permissions: ReturnType<typeof normalizeMatrix>;
    access: ReturnType<typeof describeAccess>;
    usedBy: { id: string; name: string }[];
    connectedByYou: boolean;
  } | null;
}

export async function portalConnections(
  tx: Tx,
  tenantId: string,
  platform: Platform,
  only?: string,
  /** The signed-in person, for `connectedByYou`. */
  viewerId?: string,
): Promise<
  {
    connector: string;
    name: string;
    description: string;
    icon: string | null;
    available: boolean;
    credentialForm: boolean;
    auth?: ConnectorAuth;
    personal: boolean;
    permissionEntities: PermissionEntity[];
    connection: {
      id: string;
      status: string;
      externalAccountId: string | null;
      accountName: string | null;
      lastSyncAt: string | null;
      lastActivityAt: string | null;
      permissions: ReturnType<typeof normalizeMatrix>;
      access: ReturnType<typeof describeAccess>;
      usedBy: { id: string; name: string }[];
      connectedByYou: boolean;
    } | null;
    multiple?: boolean;
    others?: NonNullable<PortalConnectionRow["connection"]>[];
  }[]
> {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  const rows = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), ...(only ? [eq(connection.id, only)] : [])))
    .orderBy(connection.createdAt);
  const offered = Array.isArray(t.settings.connectors_offered)
    ? (t.settings.connectors_offered as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const agents = await tx
    .select()
    .from(agent)
    .where(and(eq(agent.tenantId, tenantId), eq(agent.kind, "client"), eq(agent.status, "active")));
  // Upload and forwarding: their last document, and the agents their documents start.
  const activity = await sourceActivity(tx, tenantId, rows);
  const usedBy = (c: ConnectionRow) =>
    usedByWith(
      c,
      agents
        .filter((a) => a.runStatus !== "retired" && Object.values(a.bindings).includes(c.id))
        .map((a) => ({ id: a.id, name: serviceName(a) })),
      activity,
    );
  // Upload (with forwarding) is built in: every client has it, offered or not.
  const builtIn = platform.connectors.has(UPLOAD_CONNECTOR_ID) ? [UPLOAD_CONNECTOR_ID] : [];
  // Test-only connectors (the testkit) only in the Sandbox or where a connection already exists.
  const ids = (
    only
      ? rows.map((r) => r.connector)
      : [...new Set([...builtIn, ...offered, ...rows.map((r) => r.connector)])]
  ).filter((id) => {
    const m = platform.connectors.get(id)?.manifest;
    return (
      !m ||
      connectorShown(m, {
        sandbox: t.settings.sandbox === true,
        inUse: rows.some((r) => r.connector === id),
      })
    );
  });
  const state = (c: ConnectionRow) => ({
    id: c.id,
    status: c.status,
    externalAccountId: c.externalAccountId,
    // QA round 1: a name the client knows, never a bare id (a QuickBooks realm id).
    accountName: connectionLabel(c.config, c.externalAccountId),
    lastSyncAt: iso(c.lastSyncAt),
    lastActivityAt: iso(lastActivityOf(c, activity)),
    permissions: normalizeMatrix(c.permissions),
    access: (() => {
      const m = platform.connectors.get(c.connector)?.manifest;
      return m ? describeAccess(m, c.permissions) : [];
    })(),
    usedBy: usedBy(c),
    connectedByYou: viewerId !== undefined && c.connectedBy === viewerId,
  });
  return ids.map((id) => {
    const manifest = platform.connectors.get(id)?.manifest;
    const all = rows.filter((r) => r.connector === id);
    const c = all[0] ?? null;
    return {
      connector: id,
      name: manifest?.name ?? id,
      description: manifest?.description ?? "",
      icon: manifest?.icon ?? null,
      available: canSignIn(platform.connectors.get(id)),
      credentialForm: hasCredentialForm(platform.connectors.get(id)),
      ...(manifest ? { auth: manifest.auth } : {}),
      personal: PERSONAL_CONNECTORS.has(id),
      // v0.12 W2-A: the record types the matrix sets levels for.
      permissionEntities: manifest?.permissionEntities ?? [],
      connection: c && state(c),
      // B-5 (docs/plan.md §1.79): a tool connected several times lists the rest after the first.
      ...(manifest?.multiple ? { multiple: true, others: all.slice(1).map(state) } : {}),
    };
  });
}

/**
 * A run's client timeline, as `GET /api/runs/:id` returns it: visible steps, approvals and
 * changes. v0.12 W2-D: a function, so Sloan's `account.run` reads exactly what the portal shows.
 */
export async function portalRunView(
  tx: Tx,
  tenantId: string,
  runId: string,
  platform: Platform,
  // P-6: the person looking, for whether they may take a live conversation over (§1.68).
  viewer?: Approver,
) {
  // 6.2: the run row once, with its agent and only the workflow that ran (a JSON path, never the
  // whole bundle); then everything else about the run asked together in the request's
  // transaction (postgres-js pipelines them; none of them changes the scope).
  // Test runs are hidden from the portal (ARCHITECTURE §10.4).
  const [head] = await tx
    .select({
      ...summaryColumns,
      error: run.error,
      // R8: the workflow that ran may be a v4 process (§1.86).
      workflow:
        sql<RunWorkflow | null>`jsonb_path_query_first(${agentVersion.bundle}, '$.workflows[*] ? (@.slug == $slug).workflow', jsonb_build_object('slug', ${run.workflowSlug}))`.mapWith(
          (v: unknown) =>
            typeof v === "string" ? (JSON.parse(v) as RunWorkflow) : (v as RunWorkflow),
        ),
    })
    .from(run)
    .innerJoin(agent, and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)))
    .leftJoin(
      agentVersion,
      and(eq(agentVersion.id, run.agentVersionId), eq(agentVersion.tenantId, run.tenantId)),
    )
    .where(and(eq(run.id, runId), eq(run.tenantId, tenantId), eq(run.mode, "live")));
  if (!head) throw notFound("run");
  const workflow = head.workflow ?? undefined;
  // A check row (`:confer:`…) names the step it checks.
  const lookup = stepFinder(workflow);

  const [[summary], steps, oversight, conversations, runItems, actions] = await Promise.all([
    summarize(tx, tenantId, [head], platform),
    // Only the columns the timeline, its checks and the step panel read: never cost or tokens
    // (only whether it asked a model at all), and the input only to pass it through
    // `clientStepData` (step panel, §1.95).
    tx
      .select({
        id: stepRun.id,
        nodeId: stepRun.nodeId,
        nodeType: stepRun.nodeType,
        status: stepRun.status,
        input: stepRun.input,
        output: stepRun.output,
        summary: stepRun.summary,
        attempts: stepRun.attempts,
        askedModel: sql<boolean>`(${stepRun.tokensIn} + ${stepRun.tokensOut}) > 0`,
        startedAt: stepRun.startedAt,
        finishedAt: stepRun.finishedAt,
      })
      .from(stepRun)
      .where(and(eq(stepRun.runId, runId), eq(stepRun.tenantId, tenantId)))
      .orderBy(stepRun.startedAt, stepRun.id),
    // v0.13 W2-I: run oversight in the platform's words only, never the agent's note (§10.11).
    // Wave 3b: the oversight words read a v3 workflow's or a v4 process's steps alike.
    timelineOversight(tx, tenantId, runId, platform, workflow),
    // P-4: the client's side of each conversation step, never a prompt, model or cost (§1.66).
    runConversations(tx, tenantId, runId),
    // R8: the run's items not assigned to us, for the checks' approvers and urgent notices' Seen.
    tx
      .select({
        id: inboxItem.id,
        tenantId: inboxItem.tenantId,
        runId: inboxItem.runId,
        kind: inboxItem.kind,
        title: inboxItem.title,
        payload: inboxItem.payload,
        status: inboxItem.status,
        resolution: inboxItem.resolution,
        resolvedBy: inboxItem.resolvedBy,
        resolvedAt: inboxItem.resolvedAt,
        assigneeRole: inboxItem.assigneeRole,
        assigneeUserId: inboxItem.assigneeUserId,
        createdAt: inboxItem.createdAt,
      })
      .from(inboxItem)
      .where(
        and(
          eq(inboxItem.runId, runId),
          eq(inboxItem.tenantId, tenantId),
          or(isNull(inboxItem.assigneeRole), ne(inboxItem.assigneeRole, "operator")),
        ),
      )
      .orderBy(inboxItem.createdAt),
    tx
      .select({
        id: externalAction.id,
        tool: externalAction.tool,
        status: externalAction.status,
        executedAt: externalAction.executedAt,
        // Step panel (§1.95): the change as the Inbox showed it.
        stepRunId: externalAction.stepRunId,
        before: externalAction.before,
        input: externalAction.input,
        editedInput: externalAction.editedInput,
      })
      .from(externalAction)
      .where(and(eq(externalAction.runId, runId), eq(externalAction.tenantId, tenantId)))
      .orderBy(externalAction.createdAt),
  ]);
  if (!summary) throw notFound("run");

  // v0.12 W1-C: a lead check's label carries the lead's first name ("Ana: Check new matches").
  const isLeadCheck = (step: TimelineStepDef) =>
    step.kind === "person" && step.assignee === LEAD_ASSIGNEE;
  const wantsLead = steps.some((s) => {
    const step = stepOfRow(lookup, s.nodeId);
    return !!step && isLeadCheck(step);
  });
  const items = runItems.filter((i) => i.kind === "approval" || i.kind === "external_action");
  // 6.2: a change item named by its step is named from the workflow already read, as
  // `clientTitles` would name it, so that does not read the run and its whole bundle again.
  const stepTitles = new Map<string, string>();
  const toTitle = items.filter((i) => {
    if (i.kind !== "external_action" || !isPlainObject(i.payload)) return true;
    const { tool, stepId } = i.payload;
    if (typeof tool === "string" && platform.tools.get(tool)?.spec.display?.description) {
      return true;
    }
    if (typeof stepId !== "string") return true;
    // A retried or helped write's node carries a suffix (`<node>:o1`): read the step before it.
    const step = workflow ? findNodeStep(workflow, stepNodeOf(stepId).node) : undefined;
    if (step) stepTitles.set(i.id, clientLabel(step));
    return false;
  });
  // P-6: which live conversations this person approves, so may take over or end (§1.68).
  const live = viewer
    ? [...conversations].filter(([, view]) => view.outcome === null).map(([id]) => id)
    : [];
  const [leadName, controlled, checks, names, titles] = await Promise.all([
    wantsLead ? leadFirstName(tx, tenantId) : null,
    Promise.all(
      live.map(async (stepRunId) =>
        viewer && (await mayControlConversation(tx, tenantId, runId, stepRunId, viewer))
          ? stepRunId
          : null,
      ),
    ),
    timelineChecks(tx, steps, runItems, head.error ?? null, lookup),
    userNames(
      tx,
      items.map((i) => i.resolvedBy),
    ),
    clientTitles(tx, toTitle, platform),
  ]);
  const controls = new Set(controlled.filter((v): v is string => v !== null));
  const timeline = steps.flatMap((s) => {
    const step = stepOfRow(lookup, s.nodeId);
    // Unknown nodes (agent tasks, internal bookkeeping) are internal steps: not shown.
    if (!step || !shownOnTimeline(step)) return [];
    // R8: a step's confer is its own row ("Checked with Dana: agrees"); an urgent notice its
    // check sent shows while it waits for a Seen; other check rows stay internal.
    const check = checks.get(s.id);
    if (
      checkKindOf(s.nodeId) &&
      !(isClientCheckRow(s.nodeId) && (check?.confer || check?.urgent))
    ) {
      return [];
    }
    const labelled = step as Step;
    // A step reads by its state: "Itemize the bill" until it has run, then "Itemized the bill".
    const label = stepStateLabel(labelled, s.status === "succeeded" || !!check?.confer);
    return [
      {
        id: s.id,
        label: isLeadCheck(step) ? leadCheckLabel(label, leadName) : label,
        status: s.status,
        // A confer's own words are its verdict, worded by the screen; its row's summary is ours.
        summary: check?.confer
          ? null
          : summaryAfterLabel(s.summary, [clientLabel(labelled), step.name]),
        sources: check?.confer ? [] : sourcesOf(s.output),
        startedAt: iso(s.startedAt),
        finishedAt: iso(s.finishedAt),
        // Step panel (§1.95): what the client may read of what went in and came out, never on
        // a check's row (a confer's question is ours to word).
        ...(checkKindOf(s.nodeId) ? {} : clientIo(s.input, s.output)),
        ...(s.attempts > 1 ? { attempts: s.attempts } : {}),
        ...(s.askedModel ? { ai: true as const } : {}),
        // v0.13 W2-I
        ...(oversight.has(s.id) ? { oversight: oversight.get(s.id) } : {}),
        // P-4
        ...(conversations.has(s.id)
          ? { conversation: portalConversation(conversations.get(s.id), controls.has(s.id)) }
          : {}),
        // R8
        ...(check ?? {}),
        // Skill model (2026-11-10), wave A: a write reads "Saved" or "Changed in QuickBooks";
        // a confer's row is the check's, not the write's.
        ...(!check?.confer && (step.kind === "write" || step.kind === "action")
          ? {
              write:
                step.kind === "write" && step.action !== undefined
                  ? actionTimelineWrite(platform, step.via)
                  : timelineWrite(platform, step.tool as string),
            }
          : {}),
      },
    ];
  });

  const approvals = items.map((i) => {
    const res = (i.resolution ?? {}) as { approved?: unknown; decision?: unknown };
    const approved =
      typeof res.approved === "boolean"
        ? res.approved
        : res.decision === undefined
          ? null
          : res.decision === "approve";
    return {
      id: i.id,
      title: stepTitles.get(i.id) ?? titles.get(i.id) ?? plainTitle(i),
      status: i.status,
      approved: i.status === "resolved" ? approved : null,
      // P-6: "We stepped in" when we did: never our person's name.
      by: i.resolvedBy
        ? { id: i.resolvedBy, name: steppedInOf(i) ? null : (names.get(i.resolvedBy) ?? null) }
        : null,
      resolvedAt: iso(i.resolvedAt),
      steppedIn: steppedInOf(i),
    };
  });

  return {
    run: summary,
    steps: timeline,
    sourceNames: await sourceNames(
      tx,
      [tenantId],
      timeline.flatMap((s) => s.sources),
    ),
    approvals,
    actions: actions.map((a) => ({
      id: a.id,
      tool: a.tool,
      description: platform.tools.get(a.tool)?.spec.description ?? a.tool,
      display: changeDisplay(platform, a.tool),
      status: a.status,
      executedAt: iso(a.executedAt),
      stepRunId: a.stepRunId,
      before: clientStepData(a.before) ?? null,
      input: clientStepData(a.editedInput ?? a.input) ?? null,
    })),
  };
}

/** Step panel (§1.95): a step's input and output as a client may read them, when there is any. */
function clientIo(input: unknown, output: unknown): { input?: unknown; output?: unknown } {
  const i = clientStepData(input);
  const o = clientStepData(output);
  return { ...(i === undefined ? {} : { input: i }), ...(o === undefined ? {} : { output: o }) };
}

/**
 * Speed run 6.2: what a run page polls instead of the whole view. One statement: the run's
 * status, whether it waits on the client, the latest time anything on its page moved, and a key
 * that changes whenever anything the page shows changes (a step can go from running to waiting,
 * or be retried, without a timestamp moving). Test runs are hidden, as from the view.
 */
// DECISION: the key is an md5 over the content of every row the view reads (the run's status,
// times, error and trigger; each step's status, attempts, times, summary and output; each client
// item's state, title, payload and resolution; each change's status, time, input and before; each
// conversation's status, turns, plan and reply, and each translation of its reply), not
// timestamps alone and not a stored counter: a step going from running to waiting, a reply or
// its translation landing, or a write's status changing moves no timestamp, and no write path has
// to remember to bump anything. Cost, models and tool calls are not keyed on their own: the portal
// shows none of them. A conversation's plan does carry its model and cost, so their changes do
// move the key; harmless, since only an opaque md5 leaves (invariant 11). Not in the key:
// `waitedMs` (it grows with the clock: the page ticks it locally) and the display names of
// people and cited records (they live in other rows and rarely change).
export async function portalRunStatus(tx: Tx, tenantId: string, runId: string) {
  const rows = await tx.execute<{
    id: string;
    status: (typeof run.$inferSelect)["status"];
    waiting: boolean;
    updated_at: string;
    change_key: string;
  }>(sql`
    select r.id, r.status,
      r.status in ('queued', 'running', 'waiting') and (r.status = 'waiting' or exists (
        select 1 from inbox_item i
        where i.tenant_id = r.tenant_id and i.run_id = r.id and i.status = 'open'
          and (i.assignee_role is null or i.assignee_role <> 'operator')
      )) as waiting,
      to_json(greatest(r.created_at, r.started_at, r.finished_at, s.at, i.at, x.at, c.at, t.at, o.at)) #>> '{}' as updated_at,
      md5(concat_ws('|', r.status, r.started_at, r.finished_at, md5(coalesce(r.error::text, '')), md5(r.trigger::text), s.k, i.k, x.k, c.k, t.k, o.k)) as change_key
    from run r
    left join lateral (
      select max(greatest(started_at, finished_at)) as at,
        string_agg(concat_ws(':', id, node_id, status, attempts, started_at, finished_at, md5(coalesce(summary, '')), md5(coalesce(output::text, ''))), ',' order by id) as k
      from step_run where tenant_id = r.tenant_id and run_id = r.id
    ) s on true
    left join lateral (
      select max(greatest(created_at, resolved_at)) as at,
        string_agg(concat_ws(':', id, kind, status, resolved_by, resolved_at, assignee_user_id, assignee_role, md5(title), md5(payload::text), md5(coalesce(resolution::text, ''))), ',' order by id) as k
      from inbox_item
      where tenant_id = r.tenant_id and run_id = r.id
        and (assignee_role is null or assignee_role <> 'operator')
    ) i on true
    left join lateral (
      select max(greatest(created_at, approved_at, executed_at, edited_at)) as at,
        string_agg(concat_ws(':', id, tool, status, executed_at, md5(input::text), md5(coalesce(before::text, ''))), ',' order by id) as k
      from external_action where tenant_id = r.tenant_id and run_id = r.id
    ) x on true
    left join lateral (
      select max(greatest(created_at, updated_at, ended_at)) as at,
        string_agg(concat_ws(':', id, step_run_id, status, outcome, ended_at, updated_at, md5(plan::text), md5(attempts::text), md5(coalesce(reply::text, ''))), ',' order by id) as k
      from reach_out where tenant_id = r.tenant_id and run_id = r.id
    ) c on true
    left join lateral (
      select max(created_at) as at,
        string_agg(concat_ws(':', id, status, field, target_language, md5(coalesce(text, ''))), ',' order by id) as k
      from message_translation
      where tenant_id = r.tenant_id and raw_record_id in (
        select (reply->>'rawRecordId')::uuid from reach_out
        where tenant_id = r.tenant_id and run_id = r.id
          and reply->>'rawRecordId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      )
    ) t on true
    left join lateral (
      select max(created_at) as at,
        string_agg(concat_ws(':', id, step_run_id, action, inbox_item_id), ',' order by id) as k
      from oversight_decision where tenant_id = r.tenant_id and run_id = r.id
    ) o on true
    where r.id = ${runId} and r.tenant_id = ${tenantId} and r.mode = 'live'
  `);
  const [row] = [...rows];
  if (!row) throw notFound("run");
  return {
    id: row.id,
    status: row.status,
    waitingOnYou: row.waiting,
    updatedAt: new Date(row.updated_at).toISOString(),
    changeKey: row.change_key,
  };
}

function by(session: Session, role: Role) {
  return { userId: session.user.id, role };
}

export function portalRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, routes.portalOverview, async ({ tx, tenantIds, role, session }) => {
    const tenantId = tenantIds[0] as string;
    // 6.4: the overview's reads asked together in the request's transaction (postgres-js
    // pipelines them; none changes the scope), and a count of open items, not their ids.
    const [[t], services, going, [open], recentRuns, summary, findings] = await Promise.all([
      tx.select({ id: tenant.id, name: tenant.name }).from(tenant).where(eq(tenant.id, tenantId)),
      tx
        .select({
          id: agent.id,
          name: agent.name,
          serviceName: agent.serviceName,
          serviceDescription: agent.serviceDescription,
          role: agent.role,
          runStatus: agent.runStatus,
          stage: agent.stage,
        })
        .from(agent)
        .where(
          and(
            eq(agent.tenantId, tenantId),
            eq(agent.kind, "client"),
            inArray(agent.runStatus, ["active", "paused"]),
          ),
        )
        .orderBy(agent.slug),
      openRunsByAgent(tx, tenantId),
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(inboxItem)
        .where(
          and(
            eq(inboxItem.tenantId, tenantId),
            eq(inboxItem.status, "open"),
            portalInboxFilter(role, session.user.id),
            snoozedNow(false),
          ),
        ),
      runSummaries(tx, tenantId, [], 5),
      // The supervisor's latest summary: one statement over `event` (its index is 7.3).
      latestHealthSummary(tx, tenantId),
      portalFindings(tx, tenantId, role, session.user.id),
    ]);
    if (!t) throw notFound("client");
    return {
      client: { id: t.id, name: t.name },
      services: services.map((a) => ({
        id: a.id,
        name: serviceName(a),
        description: clientDescription(a),
        status: a.runStatus ?? "draft",
        // QA round 1: for its state in the sidebar (Working, Waiting on you, Ready, …).
        stage: a.stage,
        runsNow: going.get(a.id) ?? { running: 0, waitingOnYou: 0 },
      })),
      needsYou: { inbox: Number(open?.n ?? 0) },
      recentRuns,
      health: { summary, findings },
    };
  });

  mount(app, routes.portalInbox, async ({ tx, tenantIds, role, session, query, services }) => {
    const tenantId = tenantIds[0] as string;
    const rows = await tx
      .select()
      .from(inboxItem)
      .where(
        and(
          eq(inboxItem.tenantId, tenantId),
          eq(inboxItem.status, query.status),
          ...(query.kind ? [eq(inboxItem.kind, query.kind)] : []),
          portalInboxFilter(role, session.user.id),
          // v0.12 W1-D: snoozed open items show only in `view=snoozed`.
          ...(query.status === "open" ? [snoozedNow(query.view === "snoozed")] : []),
        ),
      )
      .orderBy(desc(inboxItem.createdAt))
      .limit(200);
    return { items: await portalItems(tx, rows, services.platform) };
  });

  mount(app, routes.portalResolveInbox, async (ctx) => {
    const { tx, tenantIds, role, session, params, body, services } = ctx;
    const tenantId = tenantIds[0] as string;
    const [visible] = await tx
      .select({ id: inboxItem.id })
      .from(inboxItem)
      .where(
        and(
          eq(inboxItem.id, params.id),
          eq(inboxItem.tenantId, tenantId),
          portalInboxFilter(role, session.user.id),
        ),
      );
    if (!visible) throw notFound("inbox item");
    const collect: EventRow[] = [];
    const outcome = await resolveInboxItem(tx, {
      tenantId,
      itemId: params.id,
      by: by(session, role),
      body,
      registry: services.platform.events,
      collect,
      // R5: a late no is offered an undo when its write's tool says how.
      tools: services.platform.tools,
    });
    // R7: and a conversation's own event beside it, for a v4 conversation step.
    if (outcome.resume || outcome.conversation) {
      ctx.afterCommit(() => sendResolution(services.instances, outcome));
    }
    if (collect.length > 0) {
      ctx.defer(() => dispatchEvents({ db: services.db, instances: services.instances }, collect));
    }
    const [item] = await portalItems(tx, [outcome.item], services.platform);
    return { item: item as NonNullable<typeof item> };
  });

  mount(app, routes.portalRuns, async ({ tx, tenantIds, query, services }) => {
    // v0.12 W1-E: RunFilter without the back office's keys (refused by the query schema), the
    // client's own live runs only.
    const tenantId = tenantIds[0] as string;
    // QA round 1: statuses are the client's (a run waiting on the client is "waiting" whatever
    // its stored status), so the filter, the list and the chart agree.
    const { statuses, ...filter } = portalRunFilter(query.filter);
    const where = [
      ...runFilterWhere(filter, services.platform.ctx.tools.specs()),
      ...clientStatusWhere(statuses),
    ];
    const runs = await runSummaries(tx, tenantId, where, query.limit, services.platform);
    if (!query.perDay) return { runs };
    const scope = [eq(run.tenantId, tenantId), eq(run.mode, "live"), ...where];
    const [t] = await tx
      .select({ timezone: tenant.timezone })
      .from(tenant)
      .where(eq(tenant.id, tenantId));
    return { runs, perDay: await clientRunsPerDay(tx, scope, t?.timezone ?? "UTC") };
  });

  mount(app, routes.portalRun, async ({ tx, tenantIds, params, services, session, role }) =>
    // P-6: the viewer, for the conversations they may take over (docs/plan.md §1.68).
    portalRunView(tx, tenantIds[0] as string, params.id, services.platform, by(session, role)),
  );

  mount(app, routes.portalRunStatus, async ({ tx, tenantIds, params }) =>
    portalRunStatus(tx, tenantIds[0] as string, params.id),
  );

  mount(app, routes.portalConnections, async ({ tx, tenantIds, services, session }) => ({
    connections: await portalConnections(
      tx,
      tenantIds[0] as string,
      services.platform,
      undefined,
      session.user.id,
    ),
  }));

  mount(app, routes.portalTightenPermissions, async (ctx) => {
    const { tx, tenantIds, params, body, session, services } = ctx;
    const tenantId = tenantIds[0] as string;
    const [row] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, params.id), eq(connection.tenantId, tenantId)));
    if (!row) throw notFound("connection");
    const r = applyMatrixChange({
      current: row.permissions,
      proposed: matrixEdit(body),
      by: "client",
      // v0.12 W2-A: tighten-only per entity too (403 `loosening`).
      declared: services.platform.connectors.get(row.connector)?.manifest.permissionEntities,
    });
    if (!r.ok) {
      const refusal: MatrixChangeRefusal = r;
      // v0.12 W2-A: entities the connector doesn't have are a bad request, not a refusal.
      const status = refusal.reason === "invalid_entities" ? 422 : 403;
      throw new HttpError(status, refusal.reason, refusal.message);
    }
    if (r.changed) {
      await tx
        .update(connection)
        .set({ permissions: r.matrix })
        .where(and(eq(connection.id, row.id), eq(connection.tenantId, tenantId)));
      await tx.insert(connectionChange).values({
        tenantId,
        connectionId: row.id,
        actorId: session.user.id,
        change: { ...r.change },
      });
    }
    const [out] = await portalConnections(tx, tenantId, services.platform, row.id);
    if (!out) throw notFound("connection");
    return { connection: out };
  });
}
