// Agent assurance (docs/agent-assurance-plan.md §4, §4b): everything core's checks and view need for
// one client agent, read inside that client's scope (invariant 1). Evidence is counts and record
// ids; no secret is decrypted, no message body or model request is read (invariant 13).

import { CredentialEnvelope } from "@countersign/connectors";
import {
  type AnyAgentBundle,
  type AssuranceAction,
  type AssuranceConnection,
  type AssuranceInput,
  type BrowserTier,
  bundleHash,
  isUuid,
  type Levels,
  type PermissionMatrix,
  PROCESSORS,
  type Processor,
  parseCoveredProcessors,
  type SopLevel,
  siteTier,
  sopStepModels,
  sopView,
} from "@countersign/core";
import {
  auditEvent,
  browserSite,
  browserSiteVersion,
  connection,
  externalAction,
  membership,
  modelCall,
  run,
  type Tx,
  tenantKey,
} from "@countersign/db";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Platform } from "../platform";
import { sopInputFor, sopVersion } from "../sop/inputs";
import { sopSettings } from "../sop/revisions";
import type { AssuranceScanEnv } from "./scan";

type AgentRow = typeof import("@countersign/db").agent.$inferSelect;

/** The period run checks read: the last 30 days. */
export const ASSURANCE_PERIOD_DAYS = 30;

export interface AssuranceEnv {
  /** `BAA_PROCESSORS`. */
  covered: string | undefined;
  /** The second step at sign-in is on (Twilio Verify and WorkOS configured). */
  secondFactorOn: boolean;
  /** §1.231.2: the vault and the bodies' bucket, for the checks that read stored secrets. */
  scan?: AssuranceScanEnv | undefined;
}

const MATRIX_LEVEL: Record<string, SopLevel> = { auto: "auto", approval: "ask", off: "off" };

function matrixLevels(m: Partial<PermissionMatrix> | null): Levels {
  const at = (v: keyof PermissionMatrix) => {
    const x = m?.[v];
    return typeof x === "string" ? (MATRIX_LEVEL[x] ?? null) : null;
  };
  return { read: at("read"), create: at("create"), update: at("update"), delete: at("delete") };
}

const AUTH: Record<string, AssuranceConnection["auth"]> = {
  oauth2: "oauth",
  api_key: "key",
  none: "none",
};

/**
 * One agent's assurance input, or null when it has no version. `now` ends the period.
 */
export async function assuranceInputFor(
  tx: Tx,
  platform: Platform,
  env: AssuranceEnv,
  a: AgentRow,
  now: Date,
): Promise<AssuranceInput | null> {
  const tenantId = a.tenantId as string;
  const read = await sopInputFor(tx, platform, a, {
    learned: null,
    measures: [],
    settings: await sopSettings(tx, platform, tenantId, a.id),
    asOf: now,
  });
  const v = await sopVersion(tx, a);
  if (!read || !v) return null;
  const sop = sopView({ ...read.input, revision: null, previous: null, history: [] });
  const start = new Date(now.getTime() - ASSURANCE_PERIOD_DAYS * 86_400_000);

  // Connections it is bound to, as the SOP reads them, with their stored credential's envelope.
  const ids = read.input.connections
    .map((c) => c.id)
    .filter((id): id is string => !!id && isUuid(id));
  const rows = ids.length
    ? await tx
        .select()
        .from(connection)
        .where(and(eq(connection.tenantId, tenantId), inArray(connection.id, ids)))
    : [];
  const sites = new Map<string, BrowserTier>();
  for (const r of rows.filter((x) => x.connector === "browser")) {
    const slug = (r.config as { site?: string } | null)?.site;
    if (!slug) continue;
    const [s] = await tx
      .select({ tier: browserSite.tier, profile: browserSiteVersion.profile })
      .from(browserSite)
      .leftJoin(browserSiteVersion, eq(browserSiteVersion.siteId, browserSite.id))
      .where(eq(browserSite.slug, slug))
      .orderBy(sql`${browserSiteVersion.version} desc nulls last`)
      .limit(1);
    // A site no longer in the catalogue is treated as blocked: no agent may sign in to it.
    sites.set(r.id, s ? siteTier(s.tier, (s.profile ?? null) as never) : "blocked");
  }
  const connections: AssuranceConnection[] = read.input.connections
    .filter((c) => c.connected)
    .map((c) => {
      const row = rows.find((r) => r.id === c.id);
      const sys = sop.systems.find((s) => s.key === c.key);
      const head = CredentialEnvelope.safeParse(row?.credentialsEncrypted ?? null);
      const manifest = platform.connectors.get(c.connector)?.manifest;
      return {
        id: c.id ?? c.key,
        connector: c.connector,
        name: c.name,
        auth: c.connector === "browser" ? "login" : (AUTH[manifest?.auth ?? "none"] ?? "none"),
        credential: head.success ? { version: head.data.v, kid: head.data.kid } : null,
        connectionLevels: matrixLevels(c.matrix),
        agentLevels: sys
          ? { read: sys.read, create: sys.create, update: sys.update, delete: sys.delete }
          : matrixLevels(c.matrix),
        browserTier: row ? (sites.get(row.id) ?? null) : null,
        usedBySteps: (sys?.steps.length ?? 0) > 0,
        connectedBy: c.connectedBy,
        connectedAt: row?.createdAt?.toISOString() ?? null,
        lastUsedAt: row?.lastSyncAt?.toISOString() ?? null,
      };
    });
  // Bindings to a connection that isn't this client's (or no longer exists).
  const foreignRefs = read.input.connections.filter(
    (c) => c.id && !rows.some((r) => r.id === c.id),
  ).length;

  const [key] = await tx
    .select({ id: tenantKey.id })
    .from(tenantKey)
    .where(and(eq(tenantKey.tenantId, tenantId), eq(tenantKey.status, "active")));

  // Its live runs over the period, their model calls and their changes to the client's tools.
  const runs = tx
    .select({ id: run.id })
    .from(run)
    .where(
      and(
        eq(run.tenantId, tenantId),
        eq(run.agentId, a.id),
        eq(run.mode, "live"),
        gte(run.createdAt, start),
        lt(run.createdAt, now),
      ),
    );
  const calls = await tx
    .select({
      provider: modelCall.provider,
      model: modelCall.model,
      action: modelCall.action,
      count: sql<number>`count(*)::int`,
    })
    .from(modelCall)
    .where(and(eq(modelCall.tenantId, tenantId), inArray(modelCall.runId, runs)))
    .groupBy(modelCall.provider, modelCall.model, modelCall.action);
  const known = new Set<string>(PROCESSORS);
  const acts = await tx
    .select()
    .from(externalAction)
    .where(and(eq(externalAction.tenantId, tenantId), inArray(externalAction.runId, runs)));
  const members = new Set(
    (
      await tx
        .select({ userId: membership.userId })
        .from(membership)
        .where(eq(membership.tenantId, tenantId))
    ).map((m) => m.userId),
  );
  // An approval's audit row: by the approver, on the inbox item it answered (mount()'s target
  // carries the route's ids).
  const asked = acts.filter((x) => x.inboxItemId && x.approvedBy);
  const audited = new Set<string>();
  if (asked.length > 0) {
    const found = await tx
      .select({ item: sql<string>`t.value` })
      .from(auditEvent)
      .innerJoin(sql`jsonb_each_text(${auditEvent.target}::jsonb) as t`, sql`true`)
      .where(
        and(
          eq(auditEvent.tenantId, tenantId),
          inArray(auditEvent.actorUserId, [...new Set(asked.map((x) => x.approvedBy as string))]),
          eq(auditEvent.outcome, "ok"),
          inArray(
            sql`t.value`,
            asked.map((x) => x.inboxItemId as string),
          ),
        ),
      );
    for (const f of found) audited.add(f.item);
  }
  // DECISION (A2): "during its trial" is read from the agent's stage now. The stage's history isn't
  // stored per run yet, so an agent that went live inside the period counts its changes as live.
  const trial = a.stage === "trial" || a.stage === "signoff";
  const actions: AssuranceAction[] = acts.map((x) => ({
    id: x.id,
    status: x.status as AssuranceAction["status"],
    asked: x.inboxItemId !== null,
    approvedBy: x.approvedBy,
    idempotencyKey: x.idempotencyKey,
    hasBefore: x.before !== null,
    audited: x.inboxItemId !== null && audited.has(x.inboxItemId),
    approverIsMember: x.approvedBy ? members.has(x.approvedBy) : true,
    duringTrial: trial,
  }));

  const bundle = v.bundle as AnyAgentBundle;
  return {
    clientName: read.input.client,
    sop,
    period: { start: start.toISOString(), end: now.toISOString() },
    version: {
      id: v.id,
      number: v.version,
      live: a.liveVersionId === v.id && v.status === "live",
      storedHash: v.bundleHash,
      hashNow: await bundleHash(bundle),
      // Published by a person: an operator's version, or a merge or promotion a person reviewed.
      // A Builder draft or a pack's install becomes live only when a person publishes it, which
      // makes a new version of the operator's.
      publishedByPerson: v.authorType !== "builder" && v.authorType !== "pack",
      publishedBy: "Mezonas",
      publishedAt: v.createdAt.toISOString(),
    },
    connections,
    activeKeyId: key?.id ?? null,
    hipaa: read.input.hipaa,
    covered: [...parseCoveredProcessors(env.covered)],
    secondFactorRequired: env.secondFactorOn,
    setupModels: sopStepModels({ ...read.input, revision: null, previous: null, history: [] }),
    calls: calls
      .filter((c) => known.has(c.provider))
      .map((c) => ({
        provider: c.provider as Processor,
        model: c.model,
        action: c.action,
        count: Number(c.count),
      })),
    // DECISION (A2): a model call's run is the same client's by the database (model_call_run_fk on
    // run id and tenant), so this is zero unless that key is dropped; the check states the count.
    callsElsewhere: 0,
    foreignRefs,
    actions,
  };
}
