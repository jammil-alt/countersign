// One row in every tenant table for a client, and the operator's template rows (tenant_id null).
// Written through the superuser connection, which bypasses RLS, so the tests can then look at the
// same rows through cs_worker's eyes.

import type { AgentBundle } from "@countersign/core";
import type { Db } from "./client";
import {
  agent,
  agentChange,
  agentVersion,
  appUser,
  connection,
  connectionChange,
  contact,
  contactChange,
  docExtraction,
  docLine,
  document,
  event,
  externalAction,
  feedback,
  inboxItem,
  membership,
  memoryNote,
  message,
  rawRecord,
  reachOut,
  run,
  skill,
  skillVersion,
  stepRun,
  tenant,
  tenantChange,
  tenantPack,
  thread,
  toolCall,
  transaction,
  transactionLine,
  usageDaily,
  vendor,
} from "./schema";

export const BUNDLE: AgentBundle = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Test agent", role: "tests", mission: "be tested" },
    kind: "functional",
    model: { id: "claude-opus-5-5", maxTokens: 1024 },
    instructions: "Do nothing.",
    skills: [],
    extraTools: [],
    canCommand: [],
    permissions: { mode: "suggest_only" },
    budgets: { maxSteps: 3, maxCostUsd: "0.10" },
    memory: { enabled: false },
  },
  workflows: [],
};

const SKILL_DEFINITION = {
  schemaVersion: 1,
  id: "custom:test",
  name: "Test",
  description: "A test skill",
  category: "test",
  mode: "agent",
  tools: [],
  input: {},
  output: {},
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
} as never;

export interface ClientFixture {
  tenantId: string;
  userId: string;
  agentId: string;
  agentVersionId: string;
  skillVersionId: string;
  rawRecordId: string;
  documentId: string;
  extractionId: string;
  docLineId: string;
}

let counter = 0;

export async function insertClient(db: Db, name: string): Promise<ClientFixture> {
  const n = ++counter;
  const [t] = await db.insert(tenant).values({ name }).returning();
  if (!t) throw new Error("no tenant");
  const tenantId = t.id;
  const [u] = await db
    .insert(appUser)
    .values({ email: `user${n}-${tenantId}@example.com`, name: `User ${n}` })
    .returning();
  if (!u) throw new Error("no user");
  await db.insert(membership).values({ tenantId, userId: u.id, role: "client_admin" });

  const [c] = await db.insert(connection).values({ tenantId, connector: "test" }).returning();
  if (!c) throw new Error("no connection");
  await db
    .insert(connectionChange)
    .values({ tenantId, connectionId: c.id, change: { status: "x" } });
  const [rr] = await db
    .insert(rawRecord)
    .values({
      tenantId,
      connectionId: c.id,
      connector: "test",
      entityType: "thing",
      externalId: "1",
      externalVersion: "0",
      payload: { a: 1 },
    })
    .returning();
  await db.insert(tenantPack).values({ tenantId, pack: "test-pack", version: "0.0.0" });

  const [s] = await db.insert(skill).values({ tenantId, slug: "test", name: "Test" }).returning();
  if (!s) throw new Error("no skill");
  const [sv] = await db
    .insert(skillVersion)
    .values({
      tenantId,
      skillId: s.id,
      version: 1,
      definition: SKILL_DEFINITION,
      definitionHash: "h",
      status: "live",
    })
    .returning();

  const [a] = await db
    .insert(agent)
    .values({ tenantId, kind: "client", slug: "test-agent", name: "Test agent" })
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
  await db.insert(agentChange).values({ tenantId, agentId: a.id, change: { runStatus: "active" } });

  const [r] = await db
    .insert(run)
    .values({ tenantId, agentId: a.id, agentVersionId: av.id, workflowSlug: "wf" })
    .returning();
  if (!r) throw new Error("no run");
  const [sr] = await db
    .insert(stepRun)
    .values({ tenantId, runId: r.id, nodeId: "s1", nodeType: "action" })
    .returning();
  if (!sr) throw new Error("no step run");
  const [ii] = await db
    .insert(inboxItem)
    .values({ tenantId, kind: "external_action", agentId: a.id, runId: r.id, title: "Approve" })
    .returning();
  if (!ii) throw new Error("no inbox item");
  const [ea] = await db
    .insert(externalAction)
    .values({
      tenantId,
      connectionId: c.id,
      tool: "test.thing.update",
      runId: r.id,
      stepRunId: sr.id,
      agentVersionId: av.id,
      idempotencyKey: `${r.id}:s1:0`,
      inboxItemId: ii.id,
    })
    .returning();
  if (!ea) throw new Error("no external action");
  await db.insert(toolCall).values({
    tenantId,
    stepRunId: sr.id,
    tool: "test.thing.update",
    status: "awaiting_approval",
    externalActionId: ea.id,
  });
  await db.insert(event).values({ tenantId, type: "test.happened", payload: {} });
  const [th] = await db.insert(thread).values({ tenantId, title: "Thread" }).returning();
  if (!th) throw new Error("no thread");
  const [m] = await db
    .insert(message)
    .values({ tenantId, threadId: th.id, senderType: "system", body: { text: "hi" } })
    .returning();
  if (!m) throw new Error("no message");
  await db
    .insert(memoryNote)
    .values({ tenantId, agentId: a.id, note: "remember", sourceMessageId: m.id });
  await db.insert(usageDaily).values({ tenantId, day: "2026-11-03", agentId: a.id, runs: 1 });
  const [ct] = await db
    .insert(contact)
    .values({ tenantId, name: "Pat Lee", phone: "+15555550100" })
    .returning();
  if (!ct) throw new Error("no contact");
  await db.insert(contactChange).values({ tenantId, contactId: ct.id, change: { created: true } });
  await db.insert(reachOut).values({
    tenantId,
    agentId: a.id,
    agentVersionId: av.id,
    runId: r.id,
    nodeId: "s1",
    contactId: ct.id,
    subject: "s",
    purpose: "Confirm the delivery date",
    urgency: "normal",
    plan: {},
    status: "open",
  });

  const [v] = await db
    .insert(vendor)
    .values({ tenantId, name: "Acme Lumber", normalizedName: "acme lumber" })
    .returning();
  const [tx] = await db
    .insert(transaction)
    .values({
      tenantId,
      kind: "purchase",
      connector: "test",
      vendorId: v?.id ?? null,
      txnDate: "2026-11-02",
      total: "100.0000",
      externalId: "t1",
      sourceRawRecordId: rr?.id ?? null,
    })
    .returning();
  if (!tx) throw new Error("no transaction");
  await db
    .insert(transactionLine)
    .values({ tenantId, transactionId: tx.id, lineNo: 1, detailType: "account", amount: "100" });
  const [d] = await db
    .insert(document)
    .values({
      tenantId,
      transactionId: tx.id,
      source: "upload",
      connectionId: c.id,
      storageKey: `tenants/${tenantId}/content/00/${"0".repeat(64)}`,
      mimeType: "application/pdf",
      filename: "invoice.pdf",
      sizeBytes: 10,
      sha256: "0".repeat(64),
    })
    .returning();
  if (!d) throw new Error("no document");
  const [ex] = await db
    .insert(docExtraction)
    .values({
      tenantId,
      documentId: d.id,
      model: "test-model",
      header: { vendorName: "Acme Lumber" },
      subtotal: "100",
      total: "100",
      linesSum: "100",
      totalsMatch: true,
    })
    .returning();
  if (!ex) throw new Error("no extraction");
  const [dl] = await db
    .insert(docLine)
    .values({
      tenantId,
      extractionId: ex.id,
      lineNo: 1,
      rawDescription: "Thing",
      qty: "1",
      unitPrice: "100",
      extPrice: "100",
    })
    .returning();

  await db
    .insert(tenantChange)
    .values({ tenantId, change: { setting: "feedback", to: true }, reason: "Beta" });
  await db.insert(feedback).values({
    tenantId,
    surface: "portal",
    userId: u.id,
    comment: "This is confusing",
    path: "/inbox",
    viewport: { width: 1280, height: 800 },
  });

  return {
    tenantId,
    userId: u.id,
    agentId: a.id,
    agentVersionId: av.id,
    skillVersionId: sv?.id ?? "",
    rawRecordId: rr?.id ?? "",
    documentId: d.id,
    extractionId: ex.id,
    docLineId: dl?.id ?? "",
  };
}

/** A template with a version and a change, and a shared skill with a version (all tenant_id null). */
export async function insertOperatorRows(db: Db): Promise<{ agentVersionId: string }> {
  const [s] = await db.insert(skill).values({ slug: "shared", name: "Shared" }).returning();
  if (!s) throw new Error("no skill");
  await db.insert(skillVersion).values({
    skillId: s.id,
    version: 1,
    definition: SKILL_DEFINITION,
    definitionHash: "h",
  });
  const [a] = await db
    .insert(agent)
    .values({ kind: "template", slug: "template", name: "Template" })
    .returning();
  if (!a) throw new Error("no template");
  const [av] = await db
    .insert(agentVersion)
    .values({ agentId: a.id, version: 1, bundle: BUNDLE, bundleHash: "h", authorType: "operator" })
    .returning();
  await db.insert(agentChange).values({ agentId: a.id, change: { note: "x" } });
  const [op] = await db
    .insert(appUser)
    .values({ email: `operator-${a.id}@example.com`, name: "Operator" })
    .returning();
  if (!op) throw new Error("no operator user");
  await db.insert(feedback).values({
    surface: "ops",
    userId: op.id,
    comment: "Back office",
    path: "/ops",
    viewport: { width: 1280, height: 800 },
  });
  return { agentVersionId: av?.id ?? "" };
}
