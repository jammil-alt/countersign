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
  areaOwner,
  areaOwnerVersion,
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
  connectorSetting,
  contact,
  contactChange,
  conversation,
  conversationChange,
  desktopDevice,
  desktopJob,
  docExtraction,
  docLine,
  document,
  externalAction,
  feedback,
  formRequest,
  inboxItem,
  knowledgeChunk,
  knowledgeEntry,
  knowledgeEntryVersion,
  ledgerAccount,
  ledgerAccountNote,
  ledgerDimension,
  matchRule,
  membership,
  memoryNote,
  message,
  messageTranslation,
  notification,
  organization,
  organizationChange,
  ownerCheck,
  personDevice,
  qboWebhookEvent,
  rawRecord,
  reachOut,
  receivable,
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
  /** 0057: the Purchasing owner and its live version ("" on a schema before 0057). */
  ownerId: string;
  ownerVersionId: string;
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
  // Named columns only: migration tests run this on a database from before later membership
  // columns (0059's `agent_ids`), and Drizzle's insert names every column in the schema.
  await db.execute(
    sql`insert into ${membership} (tenant_id, user_id, role) values (${tenantId}, ${u.id}, 'client_admin')`,
  );

  // Named columns only, as membership above: later connection columns (0070's `mezonas_may`,
  // `connection_change.request_id`) are missing on a database stopped at an earlier migration.
  const [c] = await db.$client<{ id: string }[]>`
    insert into connection (tenant_id, connector) values (${tenantId}, 'test') returning id`;
  if (!c) throw new Error("no connection");
  await db.$client`
    insert into connection_change (tenant_id, connection_id, change)
    values (${tenantId}, ${c.id}, ${JSON.stringify({ status: "x" })}::jsonb)`;
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

  // Plain SQL for the tables later migrations add columns to (agent, run, memory_note), so a
  // migration test can build this fixture on the schema before its migration (0057 onwards).
  const [a] = await db.$client<{ id: string }[]>`
    insert into agent (tenant_id, kind, slug, name) values (${tenantId}, 'client', 'test-agent',
      'Test agent') returning id`;
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

  const [r] = await db.$client<{ id: string }[]>`
    insert into run (tenant_id, agent_id, agent_version_id, workflow_slug)
    values (${tenantId}, ${a.id}, ${av.id}, 'wf') returning id`;
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
  // 0054: its columns named, not drizzle's whole list, so a client seeded on a database migrated
  // only to an earlier migration gets this row too.
  await db.execute(sql`
      insert into event (tenant_id, type, payload) values (${tenantId}, 'test.happened', '{}'::jsonb)`);
  const [th] = await db.insert(thread).values({ tenantId, title: "Thread" }).returning();
  if (!th) throw new Error("no thread");
  const [m] = await db
    .insert(message)
    .values({ tenantId, threadId: th.id, senderType: "system", body: { text: "hi" } })
    .returning();
  if (!m) throw new Error("no message");
  await db.$client`
    insert into memory_note (tenant_id, agent_id, note, source_message_id)
    values (${tenantId}, ${a.id}, 'remember', ${m.id})`;
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
  // 0055: its columns named, not drizzle's whole list (which has `action`), so a client seeded on
  // a database migrated only to an earlier migration gets this row too.
  const [mc] = [
    ...(await db.execute<{ id: string }>(sql`
      insert into model_call (tenant_id, run_id, step_run_id, agent_version_id, provider, model,
                              tokens_in, tokens_out, cost_usd, duration_ms, stop_reason, body_key)
      values (${tenantId}, ${r.id}, ${sr.id}, ${av.id}, 'anthropic', 'claude-opus-5-5', 100, 20,
              0.0040, 900, 'end_turn', ${`tenants/${tenantId}/model-calls/${sr.id}.json`})
      returning id`)),
  ];
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
  // §1.121 (0058): a form one contact was asked to fill in. Only where the table exists: the
  // migration tests seed this fixture on a database stopped at an earlier migration.
  const [forms] = await db.$client<{ ok: boolean }[]>`
    select to_regclass('public.form_request') is not null as ok`;
  if (forms?.ok)
    await db.insert(formRequest).values({
      tenantId,
      agentId: a.id,
      agentVersionId: av.id,
      runId: r.id,
      nodeId: "s2",
      contactId: ct.id,
      purpose: "Invoice 1042 has no PO number",
      definition: { schemaVersion: 1, title: "Invoice 1042", questions: [] },
      ask: { required: [] },
      status: "open",
      dueAt: new Date(Date.now() + 86_400_000),
    });
  // §1.124 (0060): an issue with its thread and first event, and an idea the client asked for, on
  // a thread of its own. Plain SQL, and only where the tables exist, like the form above.
  const [work] = await db.$client<{ ok: boolean }[]>`
    select to_regclass('public.issue') is not null as ok`;
  if (work?.ok) {
    const [it] = await db.$client<{ id: string }[]>`
      insert into thread (tenant_id, subject_type, title) values (${tenantId}, 'issue', 'Request #1')
      returning id`;
    const [is] = await db.$client<{ id: string }[]>`
      insert into issue (tenant_id, number, title, agent_id, source, raised_by, thread_id)
      values (${tenantId}, 1, 'Invoices stopped matching', ${a.id}, 'portal', ${u.id}, ${it?.id ?? ""})
      returning id`;
    await db.$client`
      insert into issue_event (tenant_id, issue_id, kind, to_value, actor, user_id)
      values (${tenantId}, ${is?.id ?? ""}, 'created', 'reported', 'client', ${u.id})`;
    const [at] = await db.$client<{ id: string }[]>`
      insert into thread (tenant_id, subject_type, title) values (${tenantId}, 'client_ask', 'Idea')
      returning id`;
    await db.$client`
      insert into client_ask (tenant_id, title, text, source, raised_by, thread_id)
      values (${tenantId}, 'Weekly summary by email', 'Could we get the summary on Mondays?',
              'portal', ${u.id}, ${at?.id ?? ""})`;
  }
  // §1.149 (0066): an intake with its admin, an answer, a scope and a log line. Plain SQL, and only
  // where the tables exist, like the issue above.
  const [onboarding] = await db.$client<{ ok: boolean }[]>`
    select to_regclass('public.intake') is not null as ok`;
  if (onboarding?.ok) {
    const [ik] = await db.$client<{ id: string }[]>`
      insert into intake (tenant_id, covers, guide, lead_note)
      values (${tenantId}, ${JSON.stringify({ general: true, areas: ["purchasing"], templateIds: [] })}::jsonb,
              ${JSON.stringify({ version: 1, sections: [] })}::jsonb, 'A few questions about bills')
      returning id`;
    const [ip] = await db.$client<{ id: string }[]>`
      insert into intake_person (tenant_id, intake_id, user_id, email, name, is_admin)
      values (${tenantId}, ${ik?.id ?? ""}, ${u.id}, ${`admin-${tenantId}@example.com`}, 'Dana Ruiz', true)
      returning id`;
    await db.$client`
      insert into intake_answer (tenant_id, intake_id, field_key, value, state, source, user_id)
      values (${tenantId}, ${ik?.id ?? ""}, 'general.approver', ${JSON.stringify("Dana")}::jsonb,
              'answered', 'form', ${u.id})`;
    await db.$client`
      insert into intake_scope (tenant_id, intake_id, version, body)
      values (${tenantId}, ${ik?.id ?? ""}, 1, ${JSON.stringify({ agents: [] })}::jsonb)`;
    await db.$client`
      insert into intake_event (tenant_id, intake_id, kind, person_id)
      values (${tenantId}, ${ik?.id ?? ""}, 'sent', ${ip?.id ?? ""})`;
  }
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
  // 0054: its columns named, not drizzle's whole list (which has `source` and `context`), so a
  // client seeded on a database migrated only to an earlier migration gets this row too.
  await db.execute(sql`
      insert into feedback (tenant_id, surface, user_id, comment, path, viewport)
      values (${tenantId}, 'portal', ${u.id}, 'This is confusing', '/inbox',
        ${JSON.stringify({ width: 1280, height: 800 })}::jsonb)`);
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
  // §1.160 (0069): a day the agent had a phone line of its own. Plain SQL, and only where the table
  // exists, like the intake below.
  const [lines] = await db.$client<{ ok: boolean }[]>`
    select to_regclass('public.billing_phone_line_day') is not null as ok`;
  if (lines?.ok) {
    await db.$client`
      insert into billing_phone_line_day (tenant_id, day, phone_number, agent_id, agent_name, monthly_price)
      values (${tenantId}, '2026-10-01', '+15555550123', ${a.id}, 'Test agent', '10.0000')`;
  }
  // 0074: the agent's SOP, its first revision (docs/sop-plan.md §6). Plain SQL, only where the
  // table exists, as above.
  const [sops] = await db.$client<{ ok: boolean }[]>`
    select to_regclass('public.sop_revision') is not null as ok`;
  if (sops?.ok) {
    await db.$client`
      insert into sop_revision (tenant_id, agent_id, major, minor, agent_version_id, fingerprint,
        view, changed_by_side, source)
      values (${tenantId}, ${a.id}, 1, 0, ${av.id}, ${"0".repeat(64)}, '{}'::jsonb, 'system', 'first')`;
  }
  // 0075: one security check of the agent (docs/agent-assurance-plan.md §6), where it exists.
  const [checks] = await db.$client<{ ok: boolean }[]>`
    select to_regclass('public.control_check') is not null as ok`;
  if (checks?.ok) {
    await db.$client`
      insert into control_check (tenant_id, agent_id, agent_version_id, check_id, kind, controls,
        result, trigger)
      values (${tenantId}, ${a.id}, ${av.id}, 'delete_off', 'setup', '{AGT-1}', 'verified', 'nightly')`;
  }
  // 0077: what the run was about (docs/reporting-plan.md §3 R1), where it exists.
  const [subjects] = await db.$client<{ ok: boolean }[]>`
    select to_regclass('public.run_subject') is not null as ok`;
  if (subjects?.ok) {
    await db.$client`
      insert into run_subject (tenant_id, run_id, step_run_id, kind, role, connector, external_id,
        label, number, amount, currency, client_visible)
      values (${tenantId}, ${r.id}, ${sr.id}, 'document', 'changed', 'qbo', 'bill-1',
        'Acme Supply', 'INV-1001', 120.5000, 'USD', true)`;
  }
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
  // §1.116: the person's phone, once migration 0056 is there (a migration test may fill a
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
  // §1.151: a paired computer and one answered job, once migration 0080 is there.
  const [computers] = await db.$client<{ present: boolean }[]>`
    select to_regclass('public.desktop_device') is not null as present`;
  if (computers?.present) {
    const [computer] = await db
      .insert(desktopDevice)
      .values({
        tenantId,
        connectionId: c.id,
        name: "Front office PC",
        platform: "windows",
        appVersion: "0.1.0",
        publicKey: { kty: "EC", crv: "P-256", x: "C".repeat(43), y: "D".repeat(43) },
        pairedBy: u.id,
      })
      .returning();
    if (!computer) throw new Error("desktop_device insert failed");
    await db.insert(desktopJob).values({
      tenantId,
      deviceId: computer.id,
      kind: "files.list",
      request: { kind: "files.list", folderId: crypto.randomUUID(), depth: 1, limit: 200 },
      expiresAt: new Date(Date.now() + 120_000),
      sentAt: new Date(),
      answeredAt: new Date(),
      result: { ok: true, output: { entries: [], truncated: false } },
    });
  }
  // §1.215: a saved match rule, once migration 0085 is there.
  const [rules] = await db.$client<{ present: boolean }[]>`
    select to_regclass('public.match_rule') is not null as present`;
  if (rules?.present)
    await db.insert(matchRule).values({
      tenantId,
      config: "bank_to_ledger",
      field: "counterparty",
      aValue: "amzn mktp",
      bValue: "amazon",
      createdBy: u.id,
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

  // 0057 (ARCHITECTURE v0.19 §10.15): the client's Purchasing owner, its first version, a note of
  // its own and a person's summary; only on a schema that has them.
  let ownerId = "";
  let ownerVersionId = "";
  const [has] = await db.$client<{ ok: boolean }[]>`
    select to_regclass('public.area_owner') is not null as ok`;
  if (has?.ok) {
    const [o] = await db
      .insert(areaOwner)
      .values({ tenantId, area: "purchasing", name: "Pia" })
      .returning();
    if (!o) throw new Error("no owner");
    const [ov] = await db
      .insert(areaOwnerVersion)
      .values({
        tenantId,
        ownerId: o.id,
        version: 1,
        definition: { model: { id: "claude-sonnet-5-5", maxTokens: 4096 }, notes: "" },
        authorType: "system",
      })
      .returning();
    if (!ov) throw new Error("no owner version");
    await db.update(areaOwner).set({ liveVersionId: ov.id }).where(eq(areaOwner.id, o.id));
    await db.insert(memoryNote).values([
      { tenantId, ownerId: o.id, note: "Freight under $20 needs no question" },
      { tenantId, agentId: a.id, scope: "person", personId: u.id, note: "Asked about a bill" },
    ]);
    ownerId = o.id;
    ownerVersionId = ov.id;
  }
  // Connectors C3 (0070): our open request to change the connection, for the agent. Plain SQL, and
  // only where the table exists, like the form above.
  const [requests] = await db.$client<{ ok: boolean }[]>`
    select to_regclass('public.connection_change_request') is not null as ok`;
  if (requests?.ok) {
    const settings = {
      permissions: { read: "auto", create: "off", update: "off", delete: "off" },
      config: {},
    };
    await db.$client`
      insert into connection_change_request
        (tenant_id, connection_id, against, proposed, reason, requested_by, for_agent_id, expires_at)
      values (${tenantId}, ${c.id}, ${JSON.stringify(settings)}::jsonb,
        ${JSON.stringify({ ...settings, permissions: { ...settings.permissions, create: "approval" } })}::jsonb,
        'The agent adds bills.', ${u.id}, ${a.id}, now() + interval '14 days')`;
  }

  return {
    ownerId,
    ownerVersionId,
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
