// A client for the pack's database tests: a user, a client agent version (the decider an agent's
// matches record), a connected Zoho CRM and its synced records, the Sales area on. Written through
// the superuser connection, which bypasses RLS; the tests then act through the pack's functions,
// which open the client's own transaction.

import type { AgentBundle } from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  connection,
  type Db,
  membership,
  rawRecord,
  tenant,
  tenantPack,
} from "@countersign/db";
import { ZOHO_CONNECTOR } from "./keys/zoho";

const BUNDLE: AgentBundle = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Sheet to Zoho", role: "sales", mission: "match rows" },
    kind: "functional",
    model: { id: "test-model", maxTokens: 1024 },
    instructions: "Match rows.",
    skills: [],
    extraTools: [],
    canCommand: [],
    permissions: { mode: "suggest_only" },
    budgets: { maxSteps: 3, maxCostUsd: "0.10" },
    memory: { enabled: false },
  },
  workflows: [],
};

export interface SalesFixture {
  tenantId: string;
  userId: string;
  agentVersionId: string;
  connectionId: string;
  /** One synced record's version, as Zoho sync stores it; answers its raw record id. */
  record(
    module: string,
    externalId: string,
    payload: Record<string, unknown>,
    version?: string,
  ): Promise<string>;
}

let counter = 0;

export async function insertSalesClient(
  db: Db,
  name: string,
  options: { salesOn?: boolean; settings?: Record<string, unknown> } = {},
): Promise<SalesFixture> {
  const n = ++counter;
  const [t] = await db
    .insert(tenant)
    .values({ name, settings: options.settings ?? {} })
    .returning();
  if (!t) throw new Error("no tenant");
  const tenantId = t.id;
  const [u] = await db
    .insert(appUser)
    .values({ email: `seller${n}-${tenantId}@example.com`, name: `Seller ${n}` })
    .returning();
  if (!u) throw new Error("no user");
  await db.insert(membership).values({ tenantId, userId: u.id, role: "client_admin" });
  const [a] = await db
    .insert(agent)
    .values({ tenantId, kind: "client", slug: "sheet-to-zoho", name: "Sheet to Zoho" })
    .returning();
  if (!a) throw new Error("no agent");
  const [av] = await db
    .insert(agentVersion)
    .values({
      tenantId,
      agentId: a.id,
      version: 1,
      bundle: BUNDLE,
      bundleHash: "h",
      status: "live",
      authorType: "operator",
    })
    .returning();
  if (!av) throw new Error("no agent version");
  const [conn] = await db
    .insert(connection)
    .values({
      tenantId,
      connector: ZOHO_CONNECTOR,
      status: "connected",
      externalAccountId: "org-1",
    })
    .returning();
  if (!conn) throw new Error("no connection");
  if (options.salesOn ?? true) {
    await db.insert(tenantPack).values({ tenantId, pack: "sales", version: "0.1.0" });
  }
  return {
    tenantId,
    userId: u.id,
    agentVersionId: av.id,
    connectionId: conn.id,
    async record(module, externalId, payload, version = "2026-11-01T10:00:00+00:00") {
      const [r] = await db
        .insert(rawRecord)
        .values({
          tenantId,
          connectionId: conn.id,
          connector: ZOHO_CONNECTOR,
          entityType: module,
          externalId,
          externalVersion: version,
          payload: { id: externalId, Modified_Time: version, ...payload },
        })
        .returning({ id: rawRecord.id });
      if (!r) throw new Error("no raw record");
      return r.id;
    },
  };
}
