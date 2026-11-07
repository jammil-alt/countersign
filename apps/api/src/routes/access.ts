// Access, phase 1 (ARCHITECTURE §6.9, docs/plan.md §1.26): the client's vault and the agents'
// grants. The portal's Access page lists every vault item (a connection): what it is, whether its
// secret is set (never the secret), and which agents can use it with what; the client admin may
// tighten or revoke an agent's grant (never loosen: 403 `loosening`, like the connection matrix)
// and enters an API-key connector's credentials. The back office reads and sets a client agent's
// grants, up to the connection's matrix (422 `beyond_matrix`); it has no route that sets or reads
// a client's secret.

import { grantOf, grantsOfClient, setGrant } from "@countersign/agents";
import { BROWSER_CONNECTOR_ID } from "@countersign/connectors";
import {
  type AgentAccess,
  BrowserConnectionConfig,
  BrowserConnectionState,
  type BrowserVaultInfo,
  type ConnectorManifest,
  type CredentialField,
  connectionLabel,
  effectiveMatrix,
  effectiveTier,
  entityProblems,
  type GrantLimits,
  grantLoosening,
  grantProblems,
  isRevoked,
  type OpsAgentGrant,
  routes,
  uuidv7,
  type VaultField,
  type VaultItem,
  type VaultKind,
  type VaultSetup,
} from "@countersign/core";
import { agent, connection, connectionChange, type Tx, tenant } from "@countersign/db";
import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { z } from "zod";
import { releasePeople, releaseView } from "../access/release";
import { type CatalogueSite, catalogueForClient, offers } from "../browser/sites";
import { type AppEnv, HttpError, iso, mount, notFound } from "../http";
import type { Platform } from "../platform";
import { connectionCredentials } from "../secrets";
import { offeredTo } from "./connections";
import { offeredConnectors } from "./ops-clients";
import { newConnectionMatrix } from "./ops-connectors";
import { hasCredentialForm } from "./portal";

type ConnectionRow = typeof connection.$inferSelect;
type AgentRow = typeof agent.$inferSelect;

/**
 * What a connection's `config.vault` says about its credentials: which fields are set, the values
 * of the non-secret ones, and when. Written by the credential form; never a secret's value.
 */
// DECISION: the read model of an API-key connection's credentials lives in `config.vault`, so
// showing "username: agent@client.com, password: set" needs no decryption, and no read route ever
// holds a secret. The secrets themselves are only in `credentials_encrypted`.
const VaultConfig = z.object({
  fields: z.record(z.string(), z.object({ set: z.boolean(), value: z.string().optional() })),
  updatedAt: z.string(),
});
type VaultConfig = z.infer<typeof VaultConfig>;

function vaultConfigOf(row: Pick<ConnectionRow, "config">): VaultConfig | null {
  const parsed = VaultConfig.safeParse((row.config as Record<string, unknown>)?.vault);
  return parsed.success ? parsed.data : null;
}

// DECISION: the vault item's kind comes from the connector's auth (oauth2, api_key, none); browser
// logins (phase 3) add their own kind with the `browser` connector.
function kindOf(manifest: ConnectorManifest | undefined): VaultKind {
  if (manifest?.id === BROWSER_CONNECTOR_ID) return "browser";
  if (manifest?.auth === "oauth2") return "oauth";
  if (manifest?.auth === "api_key") return "api_key";
  return "built_in";
}

function fieldsOf(
  manifest: ConnectorManifest | undefined,
  row: ConnectionRow | null,
): VaultField[] {
  const vault = row ? vaultConfigOf(row) : null;
  return (manifest?.credentialFields ?? []).map((f) => {
    const state = vault?.fields[f.name];
    const set = Boolean(state?.set) && Boolean(row?.credentialsEncrypted);
    return {
      name: f.name,
      label: f.label,
      secret: f.secret,
      hint: f.hint ?? null,
      set,
      value: !f.secret && set ? (state?.value ?? null) : null,
    };
  });
}

function access(
  a: AgentRow,
  row: ConnectionRow,
  grant: { limits: GrantLimits; updatedAt: Date } | null,
  name: string,
): AgentAccess {
  const e = effectiveMatrix(row.permissions, grant?.limits);
  return {
    agentId: a.id,
    name,
    limits: grant?.limits ?? {},
    effective: { read: e.read, create: e.create, update: e.update, delete: e.delete },
    tools: grant?.limits.tools ?? null,
    revoked: isRevoked(grant?.limits),
    updatedAt: iso(grant?.updatedAt),
  };
}

function toolsOf(manifest: ConnectorManifest | undefined) {
  return (manifest?.tools ?? []).map((t) => ({
    id: t.id,
    description: t.description,
    verb: t.verb,
  }));
}

function matrixOf(row: ConnectionRow) {
  const e = effectiveMatrix(row.permissions, null);
  return { read: e.read, create: e.create, update: e.update, delete: e.delete };
}

/** Client agents that can use a connection: live ones bound to it (test copies are not services). */
function boundAgents(agents: AgentRow[], connectionId: string): AgentRow[] {
  return agents.filter(
    (a) =>
      a.runStatus !== "retired" && !a.testCopy && Object.values(a.bindings).includes(connectionId),
  );
}

/** A browser login's site, tier, identity, stricter settings and sign-in state, for the portal. */
function browserInfo(
  row: ConnectionRow,
  sites: readonly CatalogueSite[],
  at: Date,
): BrowserVaultInfo | null {
  const config = BrowserConnectionConfig.safeParse(row.config);
  if (!config.success) return null;
  const entry = sites.find((e) => e.site.slug === config.data.site);
  const state = BrowserConnectionState.safeParse(
    (row.config as Record<string, unknown>).browserState,
  );
  const today = at.toISOString().slice(0, 10);
  const tier = entry?.site.tier ?? "blocked";
  return {
    site: { slug: config.data.site, name: entry?.site.name ?? config.data.site, tier },
    effectiveTier: effectiveTier(tier, config.data.stricter),
    siteVersion: null,
    identity: config.data.identity
      ? { email: config.data.identity.email, phone: config.data.identity.phone }
      : null,
    stricter: config.data.stricter,
    signInsPerDay: config.data.caps.signInsPerDay,
    signInsToday: state.success && state.data.day === today ? state.data.signIns : 0,
    stopped: state.success ? state.data.stopped : null,
  };
}

/** The client's vault: every connection, with each bound agent's access. */
export async function vaultItems(
  tx: Tx,
  tenantId: string,
  platform: Platform,
  options: { names: "service" | "agent"; only?: string } = { names: "service" },
): Promise<VaultItem[]> {
  const rows = await tx
    .select()
    .from(connection)
    .where(
      and(
        eq(connection.tenantId, tenantId),
        ...(options.only ? [eq(connection.id, options.only)] : []),
      ),
    )
    .orderBy(connection.createdAt);
  const agents = await tx
    .select()
    .from(agent)
    .where(and(eq(agent.tenantId, tenantId), eq(agent.kind, "client"), eq(agent.status, "active")));
  const grants = await grantsOfClient(tx, tenantId);
  const browserRows = rows.filter((r) => r.connector === BROWSER_CONNECTOR_ID);
  const sites = browserRows.length > 0 ? await catalogueForClient(tx) : [];
  const now = new Date();
  const releases = new Map<string, Awaited<ReturnType<typeof releaseView>>>();
  for (const row of rows) {
    releases.set(row.id, await releaseView(tx, tenantId, row, { names: options.names, now }));
  }
  return rows.map((row) => {
    const connector = platform.connectors.get(row.connector);
    const manifest = connector?.manifest;
    const vault = vaultConfigOf(row);
    const browser = row.connector === BROWSER_CONNECTOR_ID ? browserInfo(row, sites, now) : null;
    if (browser) {
      const version = sites.find((e) => e.site.slug === browser.site.slug);
      const pinned = BrowserConnectionConfig.safeParse(row.config);
      browser.siteVersion =
        version && pinned.success && version.current.id === pinned.data.siteVersionId
          ? version.current.version
          : null;
    }
    return {
      connectionId: row.id,
      connector: row.connector,
      name: browser ? browser.site.name : (manifest?.name ?? row.connector),
      kind: kindOf(manifest),
      status: row.status,
      externalAccountId: row.externalAccountId,
      accountName: connectionLabel(row.config, row.externalAccountId),
      secret: {
        set: row.credentialsEncrypted !== null,
        fields: fieldsOf(manifest, row),
        updatedAt: row.credentialsEncrypted ? (vault?.updatedAt ?? null) : null,
      },
      credentialForm: hasCredentialForm(connector),
      matrix: matrixOf(row),
      tools: toolsOf(manifest),
      agents: boundAgents(agents, row.id).map((a) =>
        access(
          a,
          row,
          grants.find((g) => g.agentId === a.id && g.connectionId === row.id) ?? null,
          options.names === "service" ? (a.serviceName ?? a.name) : a.name,
        ),
      ),
      browser,
      release: releases.get(row.id) as Awaited<ReturnType<typeof releaseView>>,
    };
  });
}

export async function vaultItem(tx: Tx, tenantId: string, platform: Platform, id: string) {
  const [item] = await vaultItems(tx, tenantId, platform, { names: "service", only: id });
  if (!item) throw notFound("connection");
  return item;
}

/** Offered API-key connectors with a form and no connection yet: what the client can set up. */
async function vaultSetup(tx: Tx, tenantId: string, platform: Platform): Promise<VaultSetup[]> {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  const rows = await tx
    .select({ connector: connection.connector })
    .from(connection)
    .where(eq(connection.tenantId, tenantId));
  // Browser logins are set up per site (browserSiteOffers), not with this generic form.
  return offeredConnectors(t.settings)
    .filter((id) => id !== BROWSER_CONNECTOR_ID && !rows.some((r) => r.connector === id))
    .flatMap((id) => {
      const c = platform.connectors.get(id);
      if (!c || !hasCredentialForm(c)) return [];
      return [
        {
          connector: id,
          name: c.manifest.name,
          description: c.manifest.description,
          fields: c.manifest.credentialFields ?? [],
        },
      ];
    });
}

/** Sites the client may set a browser login up on: offered, allowed, and not set up yet. */
async function browserSiteOffers(tx: Tx, tenantId: string) {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!t || !offeredConnectors(t.settings).includes(BROWSER_CONNECTOR_ID)) return [];
  const rows = await tx
    .select({ config: connection.config })
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, BROWSER_CONNECTOR_ID)));
  const taken = new Set(rows.map((r) => String((r.config as Record<string, unknown>).site ?? "")));
  return offers(await catalogueForClient(tx)).filter((o) => !taken.has(o.slug));
}

/** The values entered for a connector's fields: each field, nothing else, none empty. */
function credentialValues(
  fields: readonly CredentialField[],
  values: Record<string, string>,
): Record<string, string> {
  const unknown = Object.keys(values).filter((k) => !fields.some((f) => f.name === k));
  if (unknown.length > 0) {
    throw new HttpError(422, "invalid_credentials", `unknown fields: ${unknown.join(", ")}`);
  }
  const missing = fields.filter((f) => !(values[f.name] ?? "").trim()).map((f) => f.label);
  if (missing.length > 0) {
    throw new HttpError(422, "invalid_credentials", `fill in ${missing.join(", ")}`);
  }
  return Object.fromEntries(fields.map((f) => [f.name, values[f.name] as string]));
}

async function opsGrant(
  tx: Tx,
  a: AgentRow,
  row: ConnectionRow,
  platform: Platform,
): Promise<OpsAgentGrant> {
  const manifest = platform.connectors.get(row.connector)?.manifest;
  const grant = await grantOf(tx, {
    tenantId: row.tenantId,
    agentId: a.id,
    connectionId: row.id,
  });
  return {
    connector: row.connector,
    connectorName: manifest?.name ?? row.connector,
    connectionId: row.id,
    status: row.status,
    externalAccountId: row.externalAccountId,
    kind: kindOf(manifest),
    secretSet: row.credentialsEncrypted !== null,
    matrix: matrixOf(row),
    tools: toolsOf(manifest),
    access: access(a, row, grant, a.name),
    release: await releaseView(tx, row.tenantId, row, { names: "agent", now: new Date() }),
  };
}

/** A client agent in the operator's scope (RLS limits it to the clients they serve). */
async function clientAgent(tx: Tx, id: string): Promise<AgentRow & { tenantId: string }> {
  const [a] = await tx.select().from(agent).where(eq(agent.id, id));
  if (a?.kind !== "client" || !a.tenantId) throw notFound("client agent");
  return a as AgentRow & { tenantId: string };
}

async function boundConnection(tx: Tx, a: AgentRow & { tenantId: string }, connectionId: string) {
  if (!Object.values(a.bindings).includes(connectionId)) {
    throw new HttpError(409, "not_bound", "the agent is not bound to that connection");
  }
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.id, connectionId), eq(connection.tenantId, a.tenantId)));
  if (!row) throw notFound("connection");
  return row;
}

export function accessRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.portalAccess, async ({ tx, tenantIds, role, services }) => {
    const tenantId = tenantIds[0] as string;
    const canEdit = role === "client_admin";
    return {
      items: await vaultItems(tx, tenantId, services.platform, { names: "service" }),
      setup: canEdit ? await vaultSetup(tx, tenantId, services.platform) : [],
      browserSites: canEdit ? await browserSiteOffers(tx, tenantId) : [],
      canEdit,
      people: canEdit ? await releasePeople(tx, tenantId) : [],
    };
  });

  mount(app, routes.portalSetGrant, async ({ tx, tenantIds, params, body, session, services }) => {
    const tenantId = tenantIds[0] as string;
    const [row] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, params.connectionId), eq(connection.tenantId, tenantId)));
    if (!row) throw notFound("connection");
    const [a] = await tx
      .select()
      .from(agent)
      .where(
        and(eq(agent.id, params.agentId), eq(agent.tenantId, tenantId), eq(agent.kind, "client")),
      );
    if (!a || !Object.values(a.bindings).includes(row.id)) throw notFound("agent's access");
    const before = await grantOf(tx, { tenantId, agentId: a.id, connectionId: row.id });
    // Client roles only tighten or revoke (invariant 8's rule): anything looser is the operator's.
    const manifest = services.platform.connectors.get(row.connector)?.manifest;
    // v0.12 W2-A: entities too, entity by entity and scope by scope.
    const loosened = grantLoosening(before?.limits, body.limits, manifest?.permissionEntities);
    if (loosened.verbs.length > 0 || loosened.tools || loosened.entities.length > 0) {
      const what = [
        ...loosened.verbs,
        ...(loosened.tools ? ["tools"] : []),
        ...loosened.entities,
      ].join(", ");
      throw new HttpError(
        403,
        "loosening",
        `only we can give an agent more access (${what}); you can tighten or revoke it`,
      );
    }
    const toolIds = toolsOf(manifest).map((t) => t.id);
    const unknown = (body.limits.tools ?? []).filter((t) => !toolIds.includes(t));
    if (unknown.length > 0) {
      throw new HttpError(
        422,
        "invalid_grant",
        `not tools of this connection: ${unknown.join(", ")}`,
      );
    }
    // v0.12 W2-A: entities, verbs and scopes the connector declares.
    const entityIssues = entityProblems(body.limits.entities, manifest?.permissionEntities);
    if (entityIssues.length > 0) {
      throw new HttpError(422, "invalid_grant", entityIssues.join("; "));
    }
    await setGrant(tx, {
      tenantId,
      agentId: a.id,
      connectionId: row.id,
      limits: body.limits,
      actorId: session.user.id,
      by: "client",
    });
    return { item: await vaultItem(tx, tenantId, services.platform, row.id) };
  });

  mount(app, routes.portalSetCredentials, async (ctx) => {
    const { tx, tenantIds, params, body, session, services } = ctx;
    const tenantId = tenantIds[0] as string;
    await offeredTo(tx, tenantId, params.connector);
    const connector = services.platform.connectors.get(params.connector);
    if (!connector || !hasCredentialForm(connector)) {
      throw new HttpError(409, "not_available", "this tool doesn't take a key here");
    }
    const fields = connector.manifest.credentialFields ?? [];
    const values = credentialValues(fields, body.values);
    // DECISION: a client has at most one connection per connector in v1 (as connectNoAuth),
    // except browser logins, one per site: those name their connection, made by the setup route.
    const browser = params.connector === BROWSER_CONNECTOR_ID;
    if (browser && !body.connectionId) {
      throw new HttpError(422, "invalid_credentials", "say which website login this is for");
    }
    const [existing] = await tx
      .select()
      .from(connection)
      .where(
        and(
          eq(connection.tenantId, tenantId),
          eq(connection.connector, params.connector),
          ...(body.connectionId ? [eq(connection.id, body.connectionId)] : []),
        ),
      )
      .orderBy(desc(connection.createdAt))
      .limit(1);
    if (body.connectionId && !existing) throw notFound("connection");
    const id = existing?.id ?? uuidv7();
    if (!existing) {
      await tx.insert(connection).values({
        id,
        tenantId,
        connector: params.connector,
        status: "pending",
        // v0.12 W2-A: the operator's default access for new clients, else the connector's.
        permissions: await newConnectionMatrix(tx, connector.manifest),
      });
    }
    // Encrypted under the client's own key; the read model keeps only what is set.
    await (await connectionCredentials(tx, services.env, { id, tenantId })).set(values);
    const vault: VaultConfig = {
      fields: Object.fromEntries(
        fields.map((f) => [
          f.name,
          f.secret ? { set: true } : { set: true, value: values[f.name] },
        ]),
      ),
      updatedAt: new Date().toISOString(),
    };
    // A browser login entered again starts signing in again: failures and a stop are cleared
    // (the person has checked the account), today's count stays.
    const previous = BrowserConnectionState.safeParse(
      (existing?.config as Record<string, unknown> | undefined)?.browserState,
    );
    const browserState = previous.success
      ? { browserState: { ...previous.data, failures: 0, stopped: null } }
      : {};
    await tx
      .update(connection)
      .set({
        status: "connected",
        connectedBy: session.user.id,
        config: { ...(existing?.config ?? {}), vault, ...browserState },
      })
      .where(and(eq(connection.id, id), eq(connection.tenantId, tenantId)));
    await tx.insert(connectionChange).values({
      tenantId,
      connectionId: id,
      actorId: session.user.id,
      // Which fields were entered, never their values.
      change: {
        kind: "credentials",
        by: "client",
        fields: fields.map((f) => f.name),
        before: existing?.status ?? null,
        after: "connected",
      },
    });
    return { item: await vaultItem(tx, tenantId, services.platform, id) };
  });

  mount(app, routes.opsAgentGrants, async ({ tx, params, services }) => {
    const a = await clientAgent(tx, params.id);
    const ids = [...new Set(Object.values(a.bindings))];
    const grants: OpsAgentGrant[] = [];
    for (const id of ids) {
      const [row] = await tx
        .select()
        .from(connection)
        .where(and(eq(connection.id, id), eq(connection.tenantId, a.tenantId)));
      if (row) grants.push(await opsGrant(tx, a, row, services.platform));
    }
    return { grants };
  });

  mount(app, routes.opsSetAgentGrant, async ({ tx, params, body, session, services }) => {
    const a = await clientAgent(tx, params.id);
    const row = await boundConnection(tx, a, params.connectionId);
    const manifest = services.platform.connectors.get(row.connector)?.manifest;
    // The operator may loosen, but a grant never goes past the connection's matrix.
    const problems = grantProblems(
      body.limits,
      row.permissions,
      toolsOf(manifest).map((t) => t.id),
      // v0.12 W2-A: the connector's entities.
      manifest?.permissionEntities,
    );
    if (problems.length > 0) {
      throw new HttpError(422, "beyond_matrix", problems.join("; "));
    }
    await setGrant(tx, {
      tenantId: a.tenantId,
      agentId: a.id,
      connectionId: row.id,
      limits: body.limits,
      actorId: session.user.id,
      by: "operator",
    });
    return { grant: await opsGrant(tx, a, row, services.platform) };
  });
}
