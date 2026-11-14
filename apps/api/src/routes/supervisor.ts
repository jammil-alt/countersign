// The supervisor's findings and health summary (docs/plan.md §1.28), as the portal's overview and
// the back office show them, and adding the supervisor to a client.
//
// Findings are inbox items carrying a fingerprint (`payload.fingerprint`); the daily summary is the
// latest `health.checked` event. The portal sees only the client admin's items, and of those only
// the title and the plain steps (invariant 11); the back office sees both audiences, with the
// operator's details and note.

import { activate, fork, getVersion, publish } from "@countersign/agents";
import {
  // v0.12 W2-D
  ACCOUNT_AGENT_NAME,
  ACCOUNT_AGENT_SERVICE_DESCRIPTION,
  ACCOUNT_AGENT_SERVICE_NAME,
  FINDING_KINDS,
  FINGERPRINT_KEY,
  type FindingKind,
  fingerprintOf,
  HealthSummary,
  type HealthSummaryView,
  healthState,
  isPlainObject,
  type OpsFinding,
  type PortalFinding,
  type Role,
  routes,
  SUPERVISOR_SLUG,
} from "@countersign/core";
import { agent, agentChange, event, inboxItem, type Tx } from "@countersign/db";
import { and, desc, eq, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { installPlatformTemplate, latestSeededVersion } from "../account/templates";
import { type AppEnv, ensureClient, HttpError, iso, mount } from "../http";
import { afterActivate, type StageActor } from "../lifecycle/stages";
import type { Platform } from "../platform";
import { portalInboxFilter } from "./portal";

type ItemRow = typeof inboxItem.$inferSelect;
type AgentRow = typeof agent.$inferSelect;

/** The latest daily summary of a client (its newest `health.checked` event), or null. */
export async function latestHealthSummary(
  tx: Tx,
  tenantId: string,
): Promise<HealthSummaryView | null> {
  const [row] = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.tenantId, tenantId), eq(event.type, "health.checked")))
    .orderBy(desc(event.createdAt))
    .limit(1);
  const parsed = HealthSummary.safeParse(row?.payload);
  if (!parsed.success) return null;
  const { sources: _sources, ...counts } = parsed.data;
  return { ...counts, state: healthState(parsed.data) };
}

const hasFingerprint = sql`${inboxItem.payload}->>${FINGERPRINT_KEY} is not null`;

function findingState(payload: unknown): Record<string, unknown> {
  return isPlainObject(payload) && isPlainObject(payload.finding) ? payload.finding : {};
}

/** A finding's kind: what the supervisor recorded, else the fingerprint's first part. */
function kindOf(payload: unknown): string {
  const k = findingState(payload).kind;
  if (typeof k === "string") return k;
  return (fingerprintOf(payload) ?? "").split(":")[0] ?? "";
}

function stepsOf(payload: unknown): string[] {
  const steps = findingState(payload).steps;
  if (Array.isArray(steps)) return steps.filter((s): s is string => typeof s === "string");
  // An item a platform feature opened with the fingerprint (a stopped website login, a code
  // alert) explains itself in one sentence.
  const explanation = isPlainObject(payload) ? payload.explanation : undefined;
  return typeof explanation === "string" ? [explanation] : [];
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const int = (v: unknown, fallback: number) => (typeof v === "number" ? v : fallback);

/** The open findings that need the client, as the portal shows them: title and steps only. */
export async function portalFindings(
  tx: Tx,
  tenantId: string,
  role: Role,
  userId: string,
): Promise<PortalFinding[]> {
  const rows = await tx
    .select()
    .from(inboxItem)
    .where(
      and(
        eq(inboxItem.tenantId, tenantId),
        eq(inboxItem.status, "open"),
        hasFingerprint,
        portalInboxFilter(role, userId),
      ),
    )
    .orderBy(desc(inboxItem.createdAt))
    .limit(20);
  return rows.flatMap((i) => {
    const kind = kindOf(i.payload);
    if (!(FINDING_KINDS as readonly string[]).includes(kind)) return [];
    return [
      {
        id: i.id,
        kind: kind as FindingKind,
        title: i.title,
        steps: stepsOf(i.payload),
        createdAt: i.createdAt.toISOString(),
        remindedAt: str(findingState(i.payload).remindedAt),
      },
    ];
  });
}

function opsFinding(i: ItemRow): OpsFinding {
  const state = findingState(i.payload);
  const operator = i.assigneeRole === "operator";
  const p = (isPlainObject(i.payload) ? i.payload : {}) as Record<string, unknown>;
  return {
    id: i.id,
    audience: operator ? "operator" : "client_admin",
    kind: kindOf(i.payload),
    title: i.title,
    fingerprint: fingerprintOf(i.payload) ?? "",
    status: i.status,
    createdAt: i.createdAt.toISOString(),
    resolvedAt: iso(i.resolvedAt),
    remindedAt: str(state.remindedAt),
    reminders: int(state.reminders, 0),
    occurrences: int(state.occurrences, 1),
    details: operator && isPlainObject(p.details) ? p.details : null,
    note: operator ? str(p.note) : null,
    steps: operator ? [] : stepsOf(i.payload),
    sources: Array.isArray(p.sources) ? p.sources.filter((s) => typeof s === "string") : [],
  };
}

/** The client's supervisor: its client agent forked from the supervisor template, if any. */
async function supervisorOf(tx: Tx, tenantId: string): Promise<AgentRow | null> {
  const [template] = await tx
    .select({ id: agent.id })
    .from(agent)
    .where(and(isNull(agent.tenantId), eq(agent.slug, SUPERVISOR_SLUG)));
  if (!template) return null;
  const [row] = await tx
    .select()
    .from(agent)
    .where(
      and(
        eq(agent.tenantId, tenantId),
        eq(agent.templateId, template.id),
        eq(agent.testCopy, false),
        eq(agent.status, "active"),
        or(isNull(agent.runStatus), ne(agent.runStatus, "retired")),
      ),
    )
    .orderBy(agent.createdAt)
    .limit(1);
  return row ?? null;
}

const supervisorRef = (a: AgentRow) => ({
  id: a.id,
  slug: a.slug,
  name: a.serviceName ?? a.name,
  runStatus: a.runStatus,
  liveVersionId: a.liveVersionId,
});

/**
 * Adds the supervisor to a client: the template's live version forked in and published. A client
 * that has one keeps it. Forked and published only: `turnOnSloan` turns it on.
 */
export async function addSupervisor(
  tx: Tx,
  input: { tenantId: string; actorId: string | null; platform: Platform },
): Promise<{ agent: AgentRow; created: boolean }> {
  const existing = await supervisorOf(tx, input.tenantId);
  if (existing) return { agent: existing, created: false };
  const templateRow = () =>
    tx
      .select()
      .from(agent)
      .where(and(isNull(agent.tenantId), eq(agent.slug, SUPERVISOR_SLUG)))
      .then((rows) => rows[0]);
  let template = await templateRow();
  if (!template?.liveVersionId) {
    // DECISION (2026-11-10): where the seed never runs (production), adding the supervisor
    // installs its seeded template first, newest version, as `POST /api/ops/platform-templates/
    // supervisor/install` would; until then the new-client form failed with `no_template`.
    const version = latestSeededVersion(SUPERVISOR_SLUG);
    if (version !== null) {
      await installPlatformTemplate(tx, {
        slug: SUPERVISOR_SLUG,
        version,
        actorId: input.actorId,
        platform: input.platform,
      });
      template = await templateRow();
    }
  }
  if (!template?.liveVersionId) {
    throw new HttpError(409, "no_template", "the supervisor template is not installed");
  }
  const [taken] = await tx
    .select({ id: agent.id })
    .from(agent)
    .where(and(eq(agent.tenantId, input.tenantId), eq(agent.slug, SUPERVISOR_SLUG)));
  // v0.12 W2-D: from the template's v2 the fork is Sloan, "Sloan, your account agent" (§1.47).
  const live = await getVersion(tx, template.liveVersionId);
  const sloan = live.bundle.definition.identity.name === ACCOUNT_AGENT_NAME;
  const created = await fork(tx, {
    tenantId: input.tenantId,
    slug: taken ? `${SUPERVISOR_SLUG}-${Date.now().toString(36)}` : SUPERVISOR_SLUG,
    templateVersionId: template.liveVersionId,
    actorId: input.actorId,
    serviceName: sloan ? ACCOUNT_AGENT_SERVICE_NAME : "Account check",
    serviceDescription: sloan
      ? ACCOUNT_AGENT_SERVICE_DESCRIPTION
      : "Keeps watch over your account and tells you, in plain steps, when something needs you.",
  });
  await publish(tx, {
    agentId: created.agent.id,
    versionId: created.version.id,
    actorId: input.actorId,
    ctx: input.platform.ctx,
  });
  const [row] = await tx.select().from(agent).where(eq(agent.id, created.agent.id));
  return { agent: row ?? created.agent, created: true };
}

/**
 * Whether a client agent was never turned on: still a draft (or testing) with no run status change
 * in its log. One the operator activated, paused, moved back to the bench or retired was turned on
 * once, and stays as the operator left it.
 */
export async function neverTurnedOn(
  tx: Tx,
  row: Pick<AgentRow, "id" | "tenantId" | "runStatus" | "status">,
): Promise<boolean> {
  if (row.status !== "active") return false;
  if (row.runStatus !== null && row.runStatus !== "draft" && row.runStatus !== "testing") {
    return false;
  }
  const [changed] = await tx
    .select({ id: agentChange.id })
    .from(agentChange)
    .where(
      and(
        row.tenantId ? eq(agentChange.tenantId, row.tenantId) : isNull(agentChange.tenantId),
        eq(agentChange.agentId, row.id),
        sql`${agentChange.change} ->> 'kind' = 'run_status'`,
      ),
    )
    .limit(1);
  return !changed;
}

/**
 * Turns Sloan, the account agent, on for a client (docs/plan.md §1.47 "On by default"): added
 * when the client has none (`addSupervisor`), then, when it was never turned on, activated and
 * moved off the bench, straight to live ("no writes": it writes nothing to a client's tools). One
 * the operator paused, moved back or retired stays as it is.
 */
// DECISION (2026-11-10, the owner: "All accounts should have Sloan turned on by default"): Sloan is
// activated without a passing test run, the one agent that is. Its bundle is the platform's own,
// unchanged, and the guard keeps it to platform tools that write only internal records (no
// external tool, no connector, no binding), so a test run proves nothing a client would miss; any
// other activation check still applies. Everything Sloan may see or do is unchanged (invariant 11).
export async function turnOnSloan(
  tx: Tx,
  input: { tenantId: string; actorId: string | null; actor: StageActor; platform: Platform },
): Promise<{ agent: AgentRow; created: boolean; turnedOn: boolean }> {
  const added = await addSupervisor(tx, input);
  if (!(await neverTurnedOn(tx, added.agent))) return { ...added, turnedOn: false };
  await activate(tx, {
    agentId: added.agent.id,
    actorId: input.actorId,
    ctx: input.platform.ctx,
    requireTestRun: false,
  });
  const row = await afterActivate(tx, {
    before: added.agent,
    actorId: input.actorId,
    actor: input.actor,
    ctx: input.platform.ctx,
  });
  return { agent: row, created: added.created, turnedOn: true };
}

export function supervisorRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, routes.opsClientHealth, async (ctx) => {
    const { tx, params, query } = ctx;
    ensureClient(ctx, params.id);
    const where: SQL[] = [eq(inboxItem.tenantId, params.id), hasFingerprint];
    if (query.status === "open") where.push(eq(inboxItem.status, "open"));
    const rows = await tx
      .select()
      .from(inboxItem)
      .where(and(...where))
      .orderBy(desc(inboxItem.createdAt))
      .limit(200);
    const supervisor = await supervisorOf(tx, params.id);
    return {
      supervisor: supervisor ? supervisorRef(supervisor) : null,
      summary: await latestHealthSummary(tx, params.id),
      findings: rows.map(opsFinding),
    };
  });

  mount(app, routes.opsAddSupervisor, async (ctx) => {
    const { tx, params, session, services } = ctx;
    ensureClient(ctx, params.id);
    // Sloan on by default (§1.47): the button adds it turned on, as a new client gets it.
    const { agent: row, created } = await turnOnSloan(tx, {
      tenantId: params.id,
      actorId: session.user.id,
      actor: {
        actorKind: "user",
        actorUserId: session.user.id,
        actorEmail: session.user.email,
        actorRole: ctx.role,
      },
      platform: services.platform,
    });
    return { supervisor: supervisorRef(row), created };
  });
}
