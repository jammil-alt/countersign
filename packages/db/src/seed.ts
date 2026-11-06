// The seed (docs/plan.md §1.2 "Seeded and template definitions", "Sandbox client"): the operator,
// the clients "Sandbox" and "Demo client" with their memberships, and the platform templates as v1
// rows from packages/db/seed/agents/<slug>.v1.json, later seeded versions (`<slug>.v<n>.json`) as
// the live version, and one change on the Demo client's Desk, on the test kit only
// (`seedDemoDesk`). Idempotent: ids are uuid v5 of fixed names and every insert skips what is
// already there, so running it twice changes nothing.
//
// Node only (it reads the seed files); not exported from the package's Worker-safe index.

import { readdir, readFile } from "node:fs/promises";
import {
  type AgentBundle,
  batchKeyOf,
  bundleHash,
  DEFAULT_PERMISSIONS,
  explainWrite,
  startTrial,
  uuidv5,
  validateBundle,
} from "@countersign/core";
import { and, eq, isNull } from "drizzle-orm";
import { type Db, type Tx, withOperator } from "./client";
import {
  agent,
  agentVersion,
  appUser,
  connection,
  externalAction,
  inboxItem,
  membership,
  rawRecord,
  run,
  stepRun,
  tenant,
  toolCall,
} from "./schema";

/** Namespace for seeded ids. Never change it: seeded rows are found again by these ids. */
export const SEED_NAMESPACE = "3b0f9a56-2c41-4e8f-a1d7-6c5e9b204d18";

export const SEED_TENANTS = {
  sandbox: { name: "Sandbox", settings: { sandbox: true } },
  demo: { name: "Demo client", settings: {} },
} as const;

export const SEED_USERS = {
  operator: { email: "operator@example.com", name: "Operator" },
  demoAdmin: { email: "admin@demo-client.example.com", name: "Demo admin" },
} as const;

const SEED_DIR = new URL("../seed/agents/", import.meta.url);
const CLIENT_SEED_DIR = new URL("../seed/clients/", import.meta.url);

export interface SeedTemplate {
  slug: string;
  bundle: AgentBundle;
  hash: string;
}

/** The platform templates, parsed and validated. Throws on any file that fails validation. */
export async function loadSeedTemplates(): Promise<SeedTemplate[]> {
  const files = (await readdir(SEED_DIR)).filter((f) => f.endsWith(".v1.json")).sort();
  const out: SeedTemplate[] = [];
  for (const file of files) {
    const slug = file.slice(0, -".v1.json".length);
    const raw: unknown = JSON.parse(await readFile(new URL(file, SEED_DIR), "utf8"));
    const result = validateBundle(raw);
    if (!result.valid || !result.value) {
      const errors = result.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
      throw new Error(`seed/agents/${file} is not a valid bundle: ${errors}`);
    }
    out.push({ slug, bundle: result.value, hash: await bundleHash(result.value) });
  }
  return out;
}

// v0.12 W2-D: later seeded versions (`<slug>.v<n>.json`, n ≥ 2), e.g. the supervisor's v2, Sloan.
export interface SeedTemplateVersion extends SeedTemplate {
  version: number;
}

/** Every seeded version after the first, by slug then version. Throws on an invalid file. */
export async function loadSeedVersions(): Promise<SeedTemplateVersion[]> {
  const out: SeedTemplateVersion[] = [];
  for (const file of await readdir(SEED_DIR)) {
    const m = /^([a-z0-9-]+)\.v(\d{1,4})\.json$/.exec(file);
    if (!m?.[1] || !m[2] || Number(m[2]) < 2) continue;
    const raw: unknown = JSON.parse(await readFile(new URL(file, SEED_DIR), "utf8"));
    const result = validateBundle(raw);
    if (!result.valid || !result.value) {
      const errors = result.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
      throw new Error(`seed/agents/${file} is not a valid bundle: ${errors}`);
    }
    out.push({
      slug: m[1],
      version: Number(m[2]),
      bundle: result.value,
      hash: await bundleHash(result.value),
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug) || a.version - b.version);
}

const seedId = (name: string) => uuidv5(name, SEED_NAMESPACE);

export interface SeedResult {
  tenants: { sandbox: string; demo: string };
  users: { operator: string; demoAdmin: string };
  /** slug → ids of the template and its v1. */
  templates: Record<string, { agentId: string; versionId: string }>;
  /** The Demo client's one Desk item and what stands behind it (`seedDemoDesk`). */
  demoDesk: DemoDesk;
}

export async function seed(db: Db): Promise<SeedResult> {
  const templates = await loadSeedTemplates();
  const tenants = {
    sandbox: await seedId("tenant:sandbox"),
    demo: await seedId("tenant:demo"),
  };

  // The operator's session covers both seeded clients and the templates, so the seed passes RLS
  // whichever role runs it.
  return withOperator(db, Object.values(tenants), async (tx) => {
    for (const [key, t] of Object.entries(SEED_TENANTS) as [
      keyof typeof tenants,
      typeof SEED_TENANTS.sandbox,
    ][]) {
      await tx
        .insert(tenant)
        .values({ id: tenants[key], name: t.name, settings: t.settings })
        .onConflictDoNothing();
    }

    // Users are found by email: one may already exist from a real sign-in, with its own id.
    const users = {} as SeedResult["users"];
    for (const [key, u] of Object.entries(SEED_USERS) as [
      keyof typeof SEED_USERS,
      (typeof SEED_USERS)["operator"],
    ][]) {
      await tx
        .insert(appUser)
        .values({ id: await seedId(`user:${u.email}`), email: u.email, name: u.name })
        .onConflictDoNothing();
      const [row] = await tx
        .select({ id: appUser.id })
        .from(appUser)
        .where(eq(appUser.email, u.email));
      if (!row) throw new Error(`seed: user ${u.email} missing after insert`);
      users[key] = row.id;
    }

    await tx
      .insert(membership)
      .values([
        // The owner serves every client.
        { tenantId: tenants.sandbox, userId: users.operator, role: "operator" },
        { tenantId: tenants.demo, userId: users.operator, role: "operator" },
        { tenantId: tenants.demo, userId: users.demoAdmin, role: "client_admin" },
      ])
      .onConflictDoNothing();

    const seeded: SeedResult["templates"] = {};
    for (const t of templates) {
      await tx
        .insert(agent)
        .values({
          id: await seedId(`template:${t.slug}`),
          tenantId: null,
          kind: "template",
          slug: t.slug,
          name: t.bundle.definition.identity.name,
          role: t.bundle.definition.identity.role,
        })
        .onConflictDoNothing();
      const [row] = await tx
        .select({ id: agent.id, liveVersionId: agent.liveVersionId })
        .from(agent)
        .where(and(isNull(agent.tenantId), eq(agent.slug, t.slug)));
      if (!row) throw new Error(`seed: template ${t.slug} missing after insert`);

      // A v1 that already exists is history and stays as it is (immutable), whatever the file says.
      await tx
        .insert(agentVersion)
        .values({
          id: await seedId(`template:${t.slug}:v1`),
          tenantId: null,
          agentId: row.id,
          version: 1,
          bundle: t.bundle,
          bundleHash: t.hash,
          status: "live",
          changeNote: "Seeded platform template",
          releaseNote: "First version",
          authorType: "operator",
        })
        .onConflictDoNothing();
      const [v1] = await tx
        .select({ id: agentVersion.id })
        .from(agentVersion)
        .where(and(eq(agentVersion.agentId, row.id), eq(agentVersion.version, 1)));
      if (!v1) throw new Error(`seed: template ${t.slug} v1 missing after insert`);

      if (row.liveVersionId === null) {
        await tx.update(agent).set({ liveVersionId: v1.id }).where(eq(agent.id, row.id));
      }
      seeded[t.slug] = { agentId: row.id, versionId: v1.id };
    }

    // v0.12 W2-D: later seeded versions become the template's live version, once: a version with
    // the same bundle already there (seeded, or installed by the back office's install route)
    // changes nothing. Publishing a template changes no client agent (invariant 11): clients'
    // forks move by the usual reviewed update.
    for (const v of await loadSeedVersions()) {
      const template = seeded[v.slug];
      if (!template) continue;
      const versions = await tx
        .select({
          id: agentVersion.id,
          version: agentVersion.version,
          hash: agentVersion.bundleHash,
        })
        .from(agentVersion)
        .where(eq(agentVersion.agentId, template.agentId));
      if (versions.some((x) => x.hash === v.hash)) continue;
      const [row] = await tx
        .select({ liveVersionId: agent.liveVersionId })
        .from(agent)
        .where(eq(agent.id, template.agentId));
      const id = await seedId(`template:${v.slug}:v${v.version}`);
      await tx.insert(agentVersion).values({
        id,
        tenantId: null,
        agentId: template.agentId,
        // DECISION: the next free number, so an operator's own versions keep theirs.
        version: Math.max(0, ...versions.map((x) => x.version)) + 1,
        bundle: v.bundle,
        bundleHash: v.hash,
        status: "live",
        changeNote: `Seeded platform template v${v.version}`,
        releaseNote: `Seeded v${v.version}`,
        authorType: "operator",
        parentVersionId: row?.liveVersionId ?? null,
      });
      if (row?.liveVersionId) {
        await tx
          .update(agentVersion)
          .set({ status: "retired" })
          .where(eq(agentVersion.id, row.liveVersionId));
      }
      await tx.update(agent).set({ liveVersionId: id }).where(eq(agent.id, template.agentId));
    }

    const demoDesk = await seedDemoDesk(tx, { tenantId: tenants.demo, adminId: users.demoAdmin });

    return { tenants, users, templates: seeded, demoDesk };
  });
}

// ── The Demo client's Desk: one change waiting for a signature, on the test kit only ─────────────
//
// So the Demo client's admin has something to sign and undo (the end-to-end walkthrough does
// both). Every row is the shape the runtime writes when an action step proposes a write
// (packages/agents runtime/call-tool.ts and log/external-actions.ts `propose`): a client agent
// with its live version, a live run waiting on its step, the step's tool call, the external action
// (`proposed`, with its idempotency key, before state and `agent_version_id`) and its inbox item
// for the client admin, citing the record the change rests on (`sources`).
//
// DECISION: the change is the testkit connector's `testkit.record.update` on a `testkit`
// connection: the in-memory system the Worker registers everywhere but production, never a real
// client tool. Signing writes nothing anywhere: resolving only marks the action approved
// (resolveExternalActionTx); a write happens only when the run executes it, and this run has no
// Workflow instance, so nothing ever claims the action. Even if something did, `executeAction`
// runs the tool only through the connection's own connector, the testkit, in memory. The seed
// never runs on production, where the testkit isn't registered at all.
// DECISION: the agent is in its trial (every write signed, ARCHITECTURE §10.9) and active, with a
// manual trigger only, so no event or schedule ever starts a run of it.

/** The seeded Demo client agent's bundle file (a client agent, not a template). */
export const DEMO_AGENT_FILE = "demo-records-clerk.v1.json";
export const DEMO_AGENT_SLUG = "records-clerk";
const DEMO_WORKFLOW = "fix-price";
const DEMO_STEP = "update";
/** The testkit connector's id and its write tool (packages/connectors/src/testkit). */
export const DEMO_CONNECTOR = "testkit";
export const DEMO_TOOL = "testkit.record.update";
/** The testkit's sample record the change is about, as the testkit holds it before the change. */
export const DEMO_RECORD_BEFORE = {
  id: "R-1002",
  name: "White oak 4/4 FAS",
  amount: "8.7500",
  syncToken: "0",
} as const;

export interface DemoDesk {
  connectionId: string;
  agentId: string;
  agentVersionId: string;
  runId: string;
  stepRunId: string;
  actionId: string;
  inboxItemId: string;
  /** The synced record the change cites. */
  recordId: string;
}

/** The Demo client agent's bundle, validated. Throws when the file fails validation. */
export async function loadDemoAgent(): Promise<SeedTemplate> {
  const raw: unknown = JSON.parse(
    await readFile(new URL(DEMO_AGENT_FILE, CLIENT_SEED_DIR), "utf8"),
  );
  const result = validateBundle(raw);
  if (!result.valid || !result.value) {
    const errors = result.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
    throw new Error(`seed/clients/${DEMO_AGENT_FILE} is not a valid bundle: ${errors}`);
  }
  return { slug: DEMO_AGENT_SLUG, bundle: result.value, hash: await bundleHash(result.value) };
}

async function seedDemoDesk(
  tx: Tx,
  input: { tenantId: string; adminId: string },
): Promise<DemoDesk> {
  const { tenantId } = input;
  const demo = await loadDemoAgent();
  const ids: DemoDesk = {
    connectionId: await seedId("demo:connection:testkit"),
    agentId: await seedId(`demo:agent:${DEMO_AGENT_SLUG}`),
    agentVersionId: await seedId(`demo:agent:${DEMO_AGENT_SLUG}:v1`),
    runId: await seedId("demo:run:desk"),
    stepRunId: await seedId("demo:run:desk:step"),
    actionId: await seedId("demo:run:desk:action"),
    inboxItemId: await seedId("demo:run:desk:item"),
    recordId: await seedId(`demo:raw-record:${DEMO_RECORD_BEFORE.id}`),
  };
  const step = demo.bundle.workflows
    .find((w) => w.slug === DEMO_WORKFLOW)
    ?.workflow.steps.find((s) => s.id === DEMO_STEP);
  if (step?.kind !== "action" || step.tool !== DEMO_TOOL) {
    throw new Error(`seed: ${DEMO_AGENT_FILE} has no ${DEMO_TOOL} step "${DEMO_STEP}"`);
  }
  const change = step.input as Record<string, string>;
  const before = { ...DEMO_RECORD_BEFORE };
  const now = new Date();

  await tx
    .insert(connection)
    .values({
      id: ids.connectionId,
      tenantId,
      connector: DEMO_CONNECTOR,
      status: "connected",
      permissions: DEFAULT_PERMISSIONS,
      connectedBy: input.adminId,
    })
    .onConflictDoNothing();
  // The record as a sync of the testkit brought it in: what the change cites.
  await tx
    .insert(rawRecord)
    .values({
      id: ids.recordId,
      tenantId,
      connectionId: ids.connectionId,
      connector: DEMO_CONNECTOR,
      entityType: "Record",
      externalId: before.id,
      externalVersion: before.syncToken,
      payload: before,
    })
    .onConflictDoNothing();

  await tx
    .insert(agent)
    .values({
      id: ids.agentId,
      tenantId,
      kind: "client",
      slug: DEMO_AGENT_SLUG,
      name: demo.bundle.definition.identity.name,
      role: demo.bundle.definition.identity.role,
      templateId: null,
      linked: false,
      bindings: { [DEMO_CONNECTOR]: ids.connectionId },
      runStatus: "active",
      stage: "trial",
      stageState: { trial: startTrial(now, null) },
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select({ id: agent.id, liveVersionId: agent.liveVersionId })
    .from(agent)
    .where(and(eq(agent.id, ids.agentId), eq(agent.tenantId, tenantId)));
  if (!row) throw new Error(`seed: the Demo client already has another "${DEMO_AGENT_SLUG}" agent`);
  // A v1 already there is history and stays as it is, like the templates' v1.
  await tx
    .insert(agentVersion)
    .values({
      id: ids.agentVersionId,
      tenantId,
      agentId: ids.agentId,
      version: 1,
      bundle: demo.bundle,
      bundleHash: demo.hash,
      status: "live",
      changeNote: "Seeded Demo client agent",
      authorType: "operator",
    })
    .onConflictDoNothing();
  if (row.liveVersionId === null) {
    await tx.update(agent).set({ liveVersionId: ids.agentVersionId }).where(eq(agent.id, row.id));
  }

  // The run, waiting on its one step's approval.
  await tx
    .insert(run)
    .values({
      id: ids.runId,
      tenantId,
      agentId: ids.agentId,
      agentVersionId: ids.agentVersionId,
      workflowSlug: DEMO_WORKFLOW,
      config: { bindings: { [DEMO_CONNECTOR]: ids.connectionId } },
      mode: "live",
      trigger: { type: "manual", input: {} },
      status: "waiting",
      startedAt: now,
    })
    .onConflictDoNothing();
  await tx
    .insert(stepRun)
    .values({
      id: ids.stepRunId,
      tenantId,
      runId: ids.runId,
      nodeId: DEMO_STEP,
      nodeType: "action",
      agentVersionId: ids.agentVersionId,
      input: change,
      summary: "Updated the price: waiting for approval",
      status: "waiting",
      attempts: 1,
      startedAt: now,
    })
    .onConflictDoNothing();

  const route = { source: "default" as const, ruleId: null };
  await tx
    .insert(inboxItem)
    .values({
      id: ids.inboxItemId,
      tenantId,
      kind: "external_action",
      agentId: ids.agentId,
      subjectType: "external_action",
      subjectId: ids.actionId,
      runId: ids.runId,
      // The default approver: the client admin (ARCHITECTURE §4).
      assigneeRole: "client_admin",
      assigneeUserId: null,
      // The testkit tool's description, as call-tool titles an item of a tool with no display line.
      title: "Change a record's name or amount.",
      payload: {
        tool: DEMO_TOOL,
        verb: "update",
        connector: DEMO_CONNECTOR,
        connectionId: ids.connectionId,
        input: change,
        before,
        stepId: DEMO_STEP,
        onReject: "stop",
        approverRoute: { ...route, revision: 0 },
        whyApproval: explainWrite({
          verb: "update",
          matrix: DEFAULT_PERMISSIONS,
          stepApproval: "required",
          agentMode: "suggest_only",
          definitionMode: demo.bundle.definition.permissions.mode,
          stage: "trial",
          route,
        }),
        actionId: ids.actionId,
        // Invariant 10: the record the change rests on.
        sources: [ids.recordId],
      },
      batchKey: batchKeyOf(ids.runId, DEMO_STEP),
    })
    .onConflictDoNothing();
  await tx
    .insert(externalAction)
    .values({
      id: ids.actionId,
      tenantId,
      connectionId: ids.connectionId,
      tool: DEMO_TOOL,
      runId: ids.runId,
      stepRunId: ids.stepRunId,
      agentVersionId: ids.agentVersionId,
      input: change,
      // `<run id>:<step id>:<index>`, as the runtime keys a step's writes.
      idempotencyKey: `${ids.runId}:${DEMO_STEP}:0`,
      status: "proposed",
      inboxItemId: ids.inboxItemId,
      before,
    })
    .onConflictDoNothing();
  await tx
    .insert(toolCall)
    .values({
      id: await seedId("demo:run:desk:tool-call"),
      tenantId,
      stepRunId: ids.stepRunId,
      tool: DEMO_TOOL,
      input: change,
      status: "awaiting_approval",
      externalActionId: ids.actionId,
    })
    .onConflictDoNothing();

  return ids;
}
