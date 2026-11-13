// One row in every tenant table for a client, and the operator's template rows (tenant_id null).
// Written through the superuser connection, which bypasses RLS, so the tests can then look at the
// same rows through cs_worker's eyes.

import type { AgentBundle, AutomationDefinition } from "@countersign/core";
import { eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import {
  accessRelease,
  agent,
  agentChange,
  agentGrant,
  agentVersion,
  alert,
  appUser,
  auditEvent,
  automation,
  automationVersion,
  billingAgentDay,
  billingAgentPrice,
  billingEvent,
  billingStatement,
  billingStatementLine,
  billingUsageReport,
  browserScript,
  browserScriptVersion,
  builderSession,
  builderTurn,
  connection,
  connectionChange,
  connectorSetting,
  contact,
  contactChange,
  conversation,
  conversationChange,
  docExtraction,
  docLine,
  document,
  event,
  externalAction,
  feedback,
  inboxItem,
  knowledgeChunk,
  knowledgeEntry,
  knowledgeEntryVersion,
  ledgerAccount,
  ledgerAccountNote,
  ledgerDimension,
  membership,
  memoryNote,
  message,
  messageTranslation,
  modelCall,
  notification,
  organization,
  organizationChange,
  ownerCheck,
  personDevice,
  qboWebhookEvent,
  rawRecord,
  reachOut,
  receivable,
  run,
  runAudit,
  runAuditMark,
  savedView,
  skill,
  skillVersion,
  stepRun,
  tenant,
  tenantChange,
  tenantKey,
  tenantPack,
  testCase,
  testCaseResult,
  testSuiteRun,
  thread,
  threadRead,
  toolCall,
  transaction,
  transactionLine,
  usageDaily,
  usagePlatformDaily,
  vendor,
  weeklyTable,
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
  connectionId: string;
  agentId: string;
  agentVersionId: string;
  runId: string;
  skillVersionId: string;
  rawRecordId: string;
  documentId: string;
  extractionId: string;
  docLineId: string;
  stepRunId: string;
  threadId: string;
  notificationId: string;
  modelCallId: string;
  receivableId: string;
  automationId: string;
  automationVersionId: string;
  testCaseId: string;
  suiteRunId: string;
  testCaseResultId: string;
  oversightDecisionId: string;
  builderSessionId: string;
  builderTurnId: string;
  conversationId: string;
  translationId: string;
}

/** A shared automation's definition, as core's `Automation` (W2-B) will check it. */
export const AUTOMATION_DEFINITION: AutomationDefinition = {
  schemaVersion: 1,
  slug: "lookup",
  name: "Lookup",
  description: "Looks a thing up",
  input: { type: "object" },
  output: {},
  steps: [],
  requires: { skills: [], tools: [], connectors: [] },
};

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
  await db.insert(agentGrant).values({
    tenantId,
    agentId: a.id,
    connectionId: c.id,
    limits: { verbs: { create: "off" } },
  });
  await db.insert(tenantKey).values({
    tenantId,
    wrappedKey: { v: 1, alg: "A256GCM", kid: "0000000000000000", iv: "aXY=", ct: "Y3Q=" },
  });

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
  await db.insert(usagePlatformDaily).values({
    tenantId,
    day: "2026-11-03",
    documents: 1,
    tokensIn: 1200,
    tokensOut: 300,
    costUsd: "0.0123",
  });
  await db.insert(threadRead).values({ tenantId, threadId: th.id, userId: u.id });
  const [mc] = await db
    .insert(modelCall)
    .values({
      tenantId,
      runId: r.id,
      stepRunId: sr.id,
      agentVersionId: av.id,
      provider: "anthropic",
      model: "claude-opus-5-5",
      tokensIn: 100,
      tokensOut: 20,
      costUsd: "0.0040",
      durationMs: 900,
      stopReason: "end_turn",
      bodyKey: `tenants/${tenantId}/model-calls/${sr.id}.json`,
    })
    .returning();
  if (!mc) throw new Error("no model call");
  const [nt] = await db
    .insert(notification)
    .values({
      tenantId,
      userId: u.id,
      channel: "email",
      kind: "items_waiting",
      dedupeKey: `items_waiting:${u.id}:2026-11-06T09`,
      link: "/desk",
      counts: { items: 1 },
    })
    .returning();
  if (!nt) throw new Error("no notification");
  await db.insert(weeklyTable).values({ tenantId, weekStart: "2026-11-02", stats: { runs: 1 } });
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
  await db.insert(accessRelease).values({
    tenantId,
    connectionId: c.id,
    agentId: a.id,
    runId: r.id,
    personId: u.id,
    channel: "email",
    codeHash: "0".repeat(64),
    expiresAt: new Date(Date.now() + 600_000),
  });

  const [v] = await db
    .insert(vendor)
    .values({ tenantId, name: "Acme Lumber", normalizedName: "acme lumber" })
    .returning();
  const [org] = await db
    .insert(organization)
    .values({ tenantId, name: "Acme Lumber", kinds: ["vendor"], vendorId: v?.id ?? null })
    .returning();
  if (!org) throw new Error("no organization");
  const [rv] = await db
    .insert(receivable)
    .values({
      tenantId,
      connectionId: c.id,
      connector: "test",
      externalId: "inv-1",
      docNumber: "1043",
      customerExternalId: "cust-1",
      customerName: "Lakeside Builders",
      organizationId: org.id,
      txnDate: "2026-10-01",
      dueDate: "2026-10-31",
      total: "500.0000",
      balance: "500.0000",
      status: "open",
      sourceRawRecordId: rr?.id ?? "",
    })
    .returning();
  if (!rv) throw new Error("no receivable");
  await db
    .insert(organizationChange)
    .values({ tenantId, organizationId: org.id, change: { created: true } });
  await db
    .update(contact)
    .set({ organizationId: org.id, relationship: "vendor" })
    .where(eq(contact.id, ct.id));
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
  await db.insert(billingUsageReport).values({
    tenantId,
    period: "2026-11-01",
    day: "2026-11-03",
    agents: 1,
    allowance: 2000,
    credits: 12,
    overage: 0,
    quantity: 0,
    costUsd: "0.1150",
    identifier: `${tenantId}:2026-11-01:2026-11-03`,
    status: "none",
  });
  await db.insert(billingEvent).values({
    tenantId,
    stripeEventId: `evt_${tenantId}`,
    type: "invoice.paid",
    objectId: "in_1",
    summary: { status: "paid" },
  });
  await db.insert(billingAgentPrice).values({
    tenantId,
    agentId: a.id,
    monthlyPrice: "100.0000",
    includedCredits: 500,
    note: "Agreed in the contract",
  });
  await db.insert(billingAgentDay).values({
    tenantId,
    day: "2026-10-01",
    agentId: a.id,
    agentName: "Test agent",
    monthlyPrice: "100.0000",
    includedCredits: 500,
    priceSource: "override",
  });
  const [st] = await db
    .insert(billingStatement)
    .values({
      tenantId,
      period: "2026-10-01",
      periodEnd: "2026-10-31",
      daysInMonth: 31,
      status: "draft",
      total: "3.2300",
      creditsUsed: 0,
      creditsIncluded: 16,
      extraCredits: 0,
      creditPrice: "0.0200",
    })
    .returning();
  if (!st) throw new Error("no statement");
  await db.insert(billingStatementLine).values({
    tenantId,
    statementId: st.id,
    position: 0,
    kind: "agent",
    agentId: a.id,
    description: "Test agent",
    amount: "3.2300",
  });

  const [ke] = await db
    .insert(knowledgeEntry)
    .values({ tenantId, kind: "faq", createdBy: u.id })
    .returning();
  if (!ke) throw new Error("no knowledge entry");
  const [kv] = await db
    .insert(knowledgeEntryVersion)
    .values({
      tenantId,
      entryId: ke.id,
      version: 1,
      title: "Opening hours",
      body: "We open at 8am.",
      status: "active",
      authorId: u.id,
      authorRole: "client_admin",
    })
    .returning();
  if (!kv) throw new Error("no knowledge entry version");
  await db.insert(knowledgeChunk).values({
    tenantId,
    sourceType: "entry",
    entryId: ke.id,
    entryVersionId: kv.id,
    chunkNo: 0,
    title: "Opening hours",
    body: "We open at 8am.",
    tsv: sql`to_tsvector('english', 'Opening hours We open at 8am.')`,
  });
  // Wave 2 (0027–0029): a client's own automation, test bench rows and an oversight decision.
  const [au] = await db
    .insert(automation)
    .values({ tenantId, slug: "lookup", name: "Lookup" })
    .returning();
  if (!au) throw new Error("no automation");
  const [auv] = await db
    .insert(automationVersion)
    .values({
      tenantId,
      automationId: au.id,
      version: 1,
      definition: AUTOMATION_DEFINITION,
      definitionHash: "h",
      status: "live",
    })
    .returning();
  if (!auv) throw new Error("no automation version");
  const [tc] = await db
    .insert(testCase)
    .values({
      tenantId,
      targetKind: "skill",
      targetId: s.id,
      name: "Reads the Acme invoice",
      input: { documentId: d.id },
      expected: { total: "100.0000" },
      matcher: { kind: "exact" },
      source: "run",
      sourceRef: r.id,
      createdBy: u.id,
    })
    .returning();
  if (!tc) throw new Error("no test case");
  const [ts] = await db
    .insert(testSuiteRun)
    .values({
      tenantId,
      targetKind: "skill",
      targetId: s.id,
      versionId: sv?.id ?? "",
      status: "done",
      total: 1,
      passed: 1,
      metrics: { passRate: 1, costPerCase: "0.0010" },
      costUsd: "0.0010",
      startedBy: u.id,
      finishedAt: new Date(),
    })
    .returning();
  if (!ts) throw new Error("no suite run");
  const [tr] = await db
    .insert(testCaseResult)
    .values({
      tenantId,
      suiteRunId: ts.id,
      testCaseId: tc.id,
      status: "pass",
      got: { total: "100.0000" },
      diff: [],
      costUsd: "0.0010",
      runId: r.id,
    })
    .returning();
  if (!tr) throw new Error("no test case result");
  // v0.17 (0048): its columns named, not drizzle's whole list, so a client seeded on a database
  // migrated only to an earlier migration (the 0047 test stops at 0046) gets this row too.
  const [od] = await db.execute<{ id: string }>(sql`
      insert into oversight_decision
        (tenant_id, run_id, step_run_id, node_id, seq, cause, action, note, sources, model,
         cost_usd, tokens_in, tokens_out, agent_version_id)
      values (${tenantId}, ${r.id}, ${sr.id}, 's1', 1, 'failed', 'retry',
        'The lookup timed out; trying again.', ${JSON.stringify([rr?.id ?? ""])}::jsonb,
        'claude-opus-5-5', '0.0021', 800, 60, ${av.id})
      returning id`);
  if (!od) throw new Error("no oversight decision");
  // Wave 3 (0030): a Builder conversation about the client's agent.
  const [bs] = await db
    .insert(builderSession)
    .values({
      tenantId,
      kind: "agent",
      agentId: a.id,
      baseVersionId: av.id,
      bundle: BUNDLE,
      createdBy: u.id,
    })
    .returning();
  if (!bs) throw new Error("no builder session");
  const [bt] = await db
    .insert(builderTurn)
    .values({
      tenantId,
      sessionId: bs.id,
      seq: 1,
      role: "builder",
      text: "Added a check step.",
      changes: [{ id: "step:s2", label: "+1 step, step 2", after: { id: "s2" } }],
      bundle: BUNDLE,
      costUsd: "0.0120",
    })
    .returning();
  if (!bt) throw new Error("no builder turn");
  // v0.14 capture (0031): the contact's WhatsApp conversation and one change to its capture.
  const [cv] = await db
    .insert(conversation)
    .values({
      tenantId,
      connectionId: c.id,
      channel: "whatsapp",
      kind: "direct",
      contactId: ct.id,
      title: "Pat Lee",
    })
    .returning();
  if (!cv) throw new Error("no conversation");
  await db.insert(conversationChange).values({
    tenantId,
    conversationId: cv.id,
    actorId: u.id,
    side: "client",
    change: {
      setting: "capture",
      before: cv.capture,
      after: { ...cv.capture, attachments: "documents" },
    },
  });

  // P-1 (0032): an alert on the client's document line, raised by its run.
  await db.insert(alert).values({
    tenantId,
    kind: "price_jump",
    subjectType: "document",
    subjectId: d.id,
    severity: "warning",
    title: "Price up",
    body: "A price went up.",
    evidence: [dl?.id ?? d.id],
    raisedByRunId: r.id,
    agentVersionId: av.id,
  });

  // P-7 (0034): the raw record's text, translated by the run's step.
  const [mt] = await db
    .insert(messageTranslation)
    .values({
      tenantId,
      rawRecordId: rr?.id ?? "",
      direction: "in",
      sourceLanguage: "es",
      targetLanguage: "en",
      detectedBy: "rule",
      status: "translated",
      text: "Hello",
      originalChars: 4,
      model: "claude-haiku-5-5",
      costUsd: "0.0002",
      agentVersionId: av.id,
      runId: r.id,
      stepRunId: sr.id,
    })
    .returning();
  if (!mt) throw new Error("no translation");

  // B-1 (0039): an account in the client's chart, and the client's note on what it is for.
  const [la] = await db
    .insert(ledgerAccount)
    .values({
      tenantId,
      connectionId: c.id,
      connector: "qbo",
      externalId: "7",
      name: "Job materials",
      fullName: "Job materials",
      classification: "expense",
      kind: "cost_of_goods",
      accountType: "Cost of Goods Sold",
      rawRecordId: rr?.id ?? null,
    })
    .returning();
  if (!la) throw new Error("no ledger account");
  await db.insert(ledgerDimension).values({
    tenantId,
    connectionId: c.id,
    connector: "qbo",
    kind: "class",
    externalId: "5000000000000301",
    name: "Shop",
    fullName: "Shop",
  });
  // 0041: one of Intuit's notifications for this company.
  await db.insert(qboWebhookEvent).values({
    tenantId,
    connectionId: c.id,
    realmId: "9341458640918607",
    entity: "Bill",
    entityId: "146",
    operation: "Update",
    lastUpdated: new Date("2026-11-09T12:00:00Z"),
    acted: true,
  });
  // 0045: a recorded browser script and its first version.
  const [script] = await db
    .insert(browserScript)
    .values({
      tenantId,
      connectionId: c.id,
      site: "supplier",
      slug: "check-stock",
      name: "Check stock",
      recording: { steps: [] },
      createdSide: "client",
    })
    .returning();
  if (!script) throw new Error("no browser script");
  await db.insert(browserScriptVersion).values({
    tenantId,
    scriptId: script.id,
    version: 1,
    definition: { schemaVersion: 1, site: "supplier", name: "Check stock" },
    recordedSide: "client",
  });
  // 0046: the owner's check that led to the decision, the run queued for audit and a mark on it.
  await db.insert(ownerCheck).values({
    tenantId,
    runId: r.id,
    nodeId: "s1",
    attempt: 1,
    result: "reviewed",
    attemptOutcome: "failed",
    cause: "failed",
    verdict: "retry",
    decisionId: od.id,
    agentVersionId: av.id,
  });
  await db.insert(runAudit).values({
    tenantId,
    runId: r.id,
    agentId: a.id,
    reason: "wrote",
    rule: { writes: true, percent: "5", source: "default", bucket: 4210 },
  });
  await db.insert(runAuditMark).values({
    tenantId,
    runId: r.id,
    verdict: "problem",
    note: "The bill went to the wrong vendor.",
    markedBy: u.id,
    inboxItemId: ii.id,
  });
  // §1.97: the person's phone, once migration 0048 is there (a migration test may fill a
  // database migrated only up to an earlier one).
  const [phones] = await db.$client<{ present: boolean }[]>`
    select to_regclass('public.person_device') is not null as present`;
  if (phones?.present)
    await db.insert(personDevice).values({
      tenantId,
      userId: u.id,
      name: "Phone",
      platform: "ios",
      pushToken: "ExponentPushToken[fixture]",
      publicKey: { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43) },
    });
  await db.insert(ledgerAccountNote).values({
    tenantId,
    ledgerAccountId: la.id,
    note: "Lumber and sheet goods.",
    source: "client",
    userId: u.id,
  });

  await db.insert(auditEvent).values({
    tenantId,
    actorKind: "user",
    actorUserId: u.id,
    action: "GET /api/runs",
    outcome: "ok",
    httpStatus: 200,
  });

  return {
    tenantId,
    userId: u.id,
    connectionId: c.id,
    agentId: a.id,
    agentVersionId: av.id,
    runId: r.id,
    skillVersionId: sv?.id ?? "",
    rawRecordId: rr?.id ?? "",
    documentId: d.id,
    extractionId: ex.id,
    docLineId: dl?.id ?? "",
    stepRunId: sr.id,
    threadId: th.id,
    notificationId: nt.id,
    modelCallId: mc.id,
    receivableId: rv.id,
    automationId: au.id,
    automationVersionId: auv.id,
    testCaseId: tc.id,
    suiteRunId: ts.id,
    testCaseResultId: tr.id,
    oversightDecisionId: od.id,
    builderSessionId: bs.id,
    builderTurnId: bt.id,
    conversationId: cv.id,
    translationId: mt.id,
  };
}

/**
 * A template with a version and a change, a shared skill with a version, a shared automation with
 * a version, a shared test case with a suite run and result and a Builder conversation about the
 * template (all tenant_id null), and the
 * operator-only rows (a saved view, a connector setting).
 */
export async function insertOperatorRows(db: Db): Promise<{
  agentVersionId: string;
  automationVersionId: string;
  testCaseResultId: string;
  builderTurnId: string;
}> {
  const [s] = await db.insert(skill).values({ slug: "shared", name: "Shared" }).returning();
  if (!s) throw new Error("no skill");
  const [sv] = await db
    .insert(skillVersion)
    .values({ skillId: s.id, version: 1, definition: SKILL_DEFINITION, definitionHash: "h" })
    .returning();
  if (!sv) throw new Error("no skill version");
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
  await db
    .insert(savedView)
    .values({ userId: op.id, surface: "ops_runs", name: "Failed this week", filters: {} });
  await db.insert(auditEvent).values({
    actorKind: "anonymous",
    action: "session.sign_in",
    outcome: "refused",
    httpStatus: 403,
  });
  await db
    .insert(connectorSetting)
    .values({ connector: "test", status: "beta", note: "Ready for one client", updatedBy: op.id })
    .onConflictDoNothing();
  const [au] = await db
    .insert(automation)
    .values({ slug: "lookup", name: "Lookup", description: "Looks a thing up" })
    .returning();
  if (!au) throw new Error("no automation");
  const [auv] = await db
    .insert(automationVersion)
    .values({
      automationId: au.id,
      version: 1,
      definition: AUTOMATION_DEFINITION,
      definitionHash: "h",
      authorId: op.id,
    })
    .returning();
  if (!auv) throw new Error("no automation version");
  const [tc] = await db
    .insert(testCase)
    .values({
      targetKind: "skill",
      targetId: s.id,
      name: "Synthetic invoice",
      input: { text: "Invoice 1, total 100" },
      expected: { total: "100.0000" },
      matcher: { kind: "fields", fields: { total: { money: "0.01" } } },
      createdBy: op.id,
    })
    .returning();
  if (!tc) throw new Error("no test case");
  const [ts] = await db
    .insert(testSuiteRun)
    .values({ targetKind: "skill", targetId: s.id, versionId: sv.id, startedBy: op.id })
    .returning();
  if (!ts) throw new Error("no suite run");
  const [tr] = await db
    .insert(testCaseResult)
    .values({ suiteRunId: ts.id, testCaseId: tc.id, status: "fail", got: {}, diff: [] })
    .returning();
  if (!tr) throw new Error("no test case result");
  const [bs] = await db
    .insert(builderSession)
    .values({ kind: "agent", agentId: a.id, bundle: BUNDLE, createdBy: op.id })
    .returning();
  if (!bs) throw new Error("no builder session");
  const [bt] = await db
    .insert(builderTurn)
    .values({ sessionId: bs.id, seq: 1, role: "operator", text: "Draft a card receipts agent." })
    .returning();
  if (!bt) throw new Error("no builder turn");
  return {
    agentVersionId: av?.id ?? "",
    automationVersionId: auv.id,
    testCaseResultId: tr.id,
    builderTurnId: bt.id,
  };
}
