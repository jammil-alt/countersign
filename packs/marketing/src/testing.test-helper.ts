// A client for the pack's database tests: a user, a client agent and its live version, a run of
// it, a website connection with one external action, the Marketing pack switched on and one
// measured site. Written through the superuser connection, which bypasses RLS; the tests then act
// as cs_worker inside withTenant. Later milestones' tests build their rows on top of it.

import type { AgentBundle } from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  connection,
  type Db,
  externalAction,
  membership,
  run,
  tenant,
  tenantPack,
} from "@countersign/db";
import { site } from "./schema";

const BUNDLE: AgentBundle = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Site reporter", role: "marketing", mission: "report on the site" },
    kind: "functional",
    model: { id: "test-model", maxTokens: 1024 },
    instructions: "Report on the site.",
    skills: [],
    extraTools: [],
    canCommand: [],
    permissions: { mode: "suggest_only" },
    budgets: { maxSteps: 3, maxCostUsd: "0.10" },
    memory: { enabled: false },
  },
  workflows: [],
};

export interface MarketingClient {
  tenantId: string;
  userId: string;
  agentId: string;
  agentVersionId: string;
  runId: string;
  connectionId: string;
  externalActionId: string;
  siteId: string;
}

let counter = 0;

export async function insertMarketingClient(
  db: Db,
  name: string,
  domain = `site${counter + 1}.example.com`,
): Promise<MarketingClient> {
  const n = ++counter;
  const [t] = await db.insert(tenant).values({ name }).returning();
  if (!t) throw new Error("no tenant");
  const tenantId = t.id;
  const [u] = await db
    .insert(appUser)
    .values({ email: `marketer${n}-${tenantId}@example.com`, name: `Marketer ${n}` })
    .returning();
  if (!u) throw new Error("no user");
  await db.insert(membership).values({ tenantId, userId: u.id, role: "client_admin" });
  await db.insert(tenantPack).values({ tenantId, pack: "marketing", version: "0.1.0" });
  const [a] = await db
    .insert(agent)
    .values({ tenantId, kind: "client", slug: "site-reporter", name: "Site reporter" })
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
  const [r] = await db
    .insert(run)
    .values({ tenantId, agentId: a.id, agentVersionId: av.id, workflowSlug: "weekly" })
    .returning();
  if (!r) throw new Error("no run");
  const [c] = await db
    .insert(connection)
    .values({ tenantId, connector: "website", status: "connected" })
    .returning();
  if (!c) throw new Error("no connection");
  const [ea] = await db
    .insert(externalAction)
    .values({
      tenantId,
      connectionId: c.id,
      tool: "site.publish",
      runId: r.id,
      agentVersionId: av.id,
      idempotencyKey: `${r.id}:publish:0`,
    })
    .returning();
  if (!ea) throw new Error("no external action");
  const [s] = await db
    .insert(site)
    .values({ tenantId, domain, name: domain, createdByUserId: u.id })
    .returning();
  if (!s) throw new Error("no site");
  return {
    tenantId,
    userId: u.id,
    agentId: a.id,
    agentVersionId: av.id,
    runId: r.id,
    connectionId: c.id,
    externalActionId: ea.id,
    siteId: s.id,
  };
}
