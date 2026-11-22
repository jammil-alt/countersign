// The two checks of docs/agent-assurance-plan.md §4b that read stored secrets (§1.231.2), gathered
// only when the checks run, never for a view: "No secret in its AI requests" reads the period's
// stored model requests of the agent's live runs and looks in them for the client's stored secret
// values and for secret-shaped strings; "Sign-ins grant no more than we ask for" compares each
// bound OAuth connection's granted scopes, kept beside its tokens, with the connector's.
//
// Everything is read inside the client's transaction (invariant 1). A secret is opened in memory
// with the client's own key, compared, and dropped: it is never returned, logged or stored, and the
// results carry only counts and record ids (invariant 13).

import {
  type CredentialSealer,
  declaredOAuthScopes,
  type ObjectStore,
} from "@countersign/connectors";
import {
  type AssuranceConnection,
  type AssuranceOAuthGrant,
  type AssuranceRequestScan,
  holdsSecret,
  parseScopes,
  scopesBeyond,
  secretShapesIn,
  secretValues,
} from "@countersign/core";
import { connection, modelCall, run, type Tx } from "@countersign/db";
import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";

/** What the scan needs beside the database: the vault and the bucket the bodies are in. */
export interface AssuranceScanEnv {
  /** The client's vault in `tx`; null where no ENCRYPTION_KEY is set (nothing secret is stored). */
  vault: ((tx: Tx) => Promise<CredentialSealer>) | null;
  /** Where model calls' bodies are stored (R2); null where there is none. */
  bodies: ObjectStore | null;
}

/** The stored requests read per agent per run of the checks: the newest. */
// DECISION (§1.231.2): at most 200 a night per agent, the newest first, so the nightly run stays
// within a Worker's limits; the result says how many of the period's it read.
export const REQUESTS_READ_MAX = 200;

type Opened = Map<string, Record<string, unknown> | "unreadable">;

/** Every stored credential of the client, opened with its key; "unreadable" when it won't open. */
async function openCredentials(tx: Tx, scan: AssuranceScanEnv, tenantId: string): Promise<Opened> {
  const rows = await tx
    .select({ id: connection.id, c: connection.credentialsEncrypted })
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), isNotNull(connection.credentialsEncrypted)));
  const out: Opened = new Map();
  const vault = scan.vault ? await scan.vault(tx) : null;
  for (const r of rows) {
    if (!vault) {
      out.set(r.id, "unreadable");
      continue;
    }
    try {
      out.set(r.id, await vault.decrypt(r.c, { tenantId, connectionId: r.id }));
    } catch {
      out.set(r.id, "unreadable");
    }
  }
  return out;
}

async function scanRequests(
  tx: Tx,
  scan: AssuranceScanEnv,
  opened: Opened,
  tenantId: string,
  agentId: string,
  period: { start: string; end: string },
): Promise<AssuranceRequestScan | null> {
  if (!scan.bodies) return null;
  const runs = tx
    .select({ id: run.id })
    .from(run)
    .where(
      and(
        eq(run.tenantId, tenantId),
        eq(run.agentId, agentId),
        eq(run.mode, "live"),
        gte(run.createdAt, new Date(period.start)),
        lt(run.createdAt, new Date(period.end)),
      ),
    );
  const where = and(eq(modelCall.tenantId, tenantId), inArray(modelCall.runId, runs));
  const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(modelCall).where(where);
  const calls = Number(count?.n ?? 0);
  const rows = await tx
    .select({ id: modelCall.id, bodyKey: modelCall.bodyKey })
    .from(modelCall)
    .where(where)
    .orderBy(desc(modelCall.createdAt))
    .limit(REQUESTS_READ_MAX);

  const secrets = new Set<string>();
  let unreadable = 0;
  for (const c of opened.values()) {
    if (c === "unreadable") unreadable += 1;
    else for (const s of secretValues(c)) secrets.add(s);
  }
  const values = [...secrets];

  let read = 0;
  let missing = 0;
  const withSecret: string[] = [];
  const secretShaped: { id: string; kinds: string[] }[] = [];
  for (const m of rows) {
    // Only ever under the call's own client's prefix (invariant 1).
    const stored = m.bodyKey.startsWith(`tenants/${tenantId}/model-calls/`)
      ? await scan.bodies.get(m.bodyKey)
      : null;
    if (!stored) {
      missing += 1;
      continue;
    }
    let request: string;
    try {
      const body = JSON.parse(new TextDecoder().decode(stored.bytes)) as { request?: unknown };
      request = JSON.stringify(body.request ?? null);
    } catch {
      missing += 1;
      continue;
    }
    read += 1;
    if (holdsSecret(request, values)) withSecret.push(m.id);
    const kinds = secretShapesIn(request);
    if (kinds.length > 0) secretShaped.push({ id: m.id, kinds });
  }
  return {
    calls,
    read,
    missing,
    secrets: values.length,
    unreadable,
    withSecret,
    secretShaped,
  };
}

function grantsOf(
  connections: readonly AssuranceConnection[],
  opened: Opened,
): AssuranceOAuthGrant[] {
  return connections
    .filter((c) => c.auth === "oauth")
    .map((c) => {
      const declared = declaredOAuthScopes(c.connector);
      const creds = opened.get(c.id);
      const granted = declared && creds && creds !== "unreadable" ? parseScopes(creds.scope) : null;
      return {
        id: c.id,
        name: c.name,
        granted,
        beyond: granted && declared ? scopesBeyond(granted, declared) : [],
      };
    });
}

/** Both scans for one agent, in the client's transaction. */
export async function assuranceScans(
  tx: Tx,
  scan: AssuranceScanEnv,
  tenantId: string,
  agentId: string,
  period: { start: string; end: string },
  connections: readonly AssuranceConnection[],
): Promise<{
  requestScan: AssuranceRequestScan | null;
  oauthGrants: AssuranceOAuthGrant[];
}> {
  const opened = await openCredentials(tx, scan, tenantId);
  return {
    requestScan: await scanRequests(tx, scan, opened, tenantId, agentId, period),
    oauthGrants: grantsOf(connections, opened),
  };
}
