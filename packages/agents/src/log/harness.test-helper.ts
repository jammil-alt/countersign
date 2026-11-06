// Shared test setup: a throwaway database, a Drizzle client that acts as cs_worker (so RLS and
// grants apply exactly as in the Worker), clients with users and a testkit connection, the
// registries with a few built-in test skills, and bundle builders.

import {
  ConnectorRegistry,
  createTestkitConnector,
  TESTKIT_QUERY_TOOL,
  TESTKIT_UPDATE_TOOL,
  TestkitBackend,
} from "@countersign/connectors";
import type {
  AgentBundle,
  AgentBundleInput,
  PermissionMatrix,
  SkillDefinition,
} from "@countersign/core";
import { AgentBundle as AgentBundleSchema } from "@countersign/core";
import {
  appUser,
  connection,
  createDb,
  type Db,
  membership,
  type Tx,
  tenant,
  withOperator,
  withTenant,
} from "@countersign/db";
import { createTestDatabase, type TestDatabase } from "@countersign/db/testing";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import type { RegistryContext } from "../registry/agents";
import { SkillCatalog } from "../registry/skills";
import { ToolRegistry } from "../registry/tools";
import type { RuntimeDeps } from "../runtime/context";
import { PLATFORM_TOOLS } from "../tools/platform";
import { createDbPorts } from "./ports";

export const LOOKUP_SKILL: SkillDefinition = {
  schemaVersion: 1,
  id: "test.lookup",
  name: "Look up records",
  description: "Find records and report on them",
  category: "test",
  mode: "agent",
  instructions: "Look the records up with the query tool and report what you found.",
  tools: [TESTKIT_QUERY_TOOL, TESTKIT_UPDATE_TOOL, "memory.write", "inbox.create"],
  input: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  output: {
    type: "object",
    properties: {
      answer: { type: "string" },
      sources: { type: "array", items: { type: "string" } },
    },
    required: ["answer"],
  },
  settings: [
    { key: "threshold", label: "Threshold", type: "number", default: 5, clientSpecific: false },
    { key: "vendor_list", label: "Vendors", type: "string", default: "", clientSpecific: true },
  ],
  // A version per language (docs/plan.md §1.18); runs without a language read English.
  summary: { en: "Answered: {{answer}}", es: "Respondido: {{answer}}" },
  requiresConnectors: ["testkit"],
  requiresPacks: [],
  producesAlerts: false,
};

export const ALERT_SKILL: SkillDefinition = {
  ...LOOKUP_SKILL,
  id: "test.alert",
  name: "Raise an alert",
  settings: [],
  summary: undefined,
  output: {
    type: "object",
    properties: {
      title: { type: "string" },
      sources: { type: "array", items: { type: "string" } },
    },
    required: ["title"],
  },
  producesAlerts: true,
} as SkillDefinition;

export const UPDATE_SKILL: SkillDefinition = {
  schemaVersion: 1,
  id: "test.update-record",
  name: "Update a record",
  description: "Change a record in the client's tool",
  category: "test",
  mode: "tool",
  handler: TESTKIT_UPDATE_TOOL,
  tools: [],
  input: {
    type: "object",
    properties: { id: { type: "string" }, amount: { type: "string" } },
    required: ["id"],
  },
  output: { type: "object" },
  settings: [],
  requiresConnectors: ["testkit"],
  requiresPacks: [],
  producesAlerts: false,
};

// v0.13 W2-H: a task skill, a typed job on its own model with no agent instructions or memory.
export const READ_SKILL: SkillDefinition = {
  schemaVersion: 1,
  id: "test.read",
  name: "Read a note",
  description: "Turn a note into a name and an amount",
  category: "test",
  mode: "task",
  model: { id: "claude-haiku-5-5", maxTokens: 512 },
  instructions: "Read the note and return the name and the amount it gives.",
  tools: [],
  input: {
    type: "object",
    properties: { note: { type: "string" } },
    required: ["note"],
  },
  output: {
    type: "object",
    properties: { name: { type: "string" }, amount: { type: "string" } },
    required: ["name"],
  },
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
};

export const TRIGGER_ID = "trg-manual";
export const LOOKUP_STEP = "step-lookup";
export const UPDATE_STEP = "step-update";
export const REVIEW_STEP = "step-review";

export interface BundleOptions {
  mode?: "suggest_only" | "act";
  instructions?: string;
  maxSteps?: number;
  maxCostUsd?: string;
  skillSettings?: Record<string, unknown>;
  workflows?: AgentBundleInput["workflows"];
  skills?: AgentBundleInput["definition"]["skills"];
}

/** A workflow: look up, then update the record (an action that needs approval by default). */
export function defaultWorkflows(): AgentBundleInput["workflows"] {
  return [
    {
      slug: "check-record",
      name: "Check a record",
      workflow: {
        schemaVersion: 3,
        trigger: {
          id: TRIGGER_ID,
          on: {
            type: "manual",
            input: {
              type: "object",
              properties: { name: { type: "string" }, id: { type: "string" } },
              required: ["name", "id"],
            },
          },
        },
        steps: [
          {
            id: LOOKUP_STEP,
            kind: "skill",
            name: "Look it up",
            skill: "test.lookup",
            input: { name: "{{trigger.name}}" },
          },
          {
            id: UPDATE_STEP,
            kind: "action",
            name: "Update it",
            tool: TESTKIT_UPDATE_TOOL,
            input: { id: "{{trigger.id}}", amount: "1.00" },
          },
        ],
      },
    },
  ];
}

export function makeBundle(options: BundleOptions = {}): AgentBundle {
  return AgentBundleSchema.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Tester", role: "checks records", mission: "Keep records right." },
      kind: "functional",
      model: { id: "claude-sonnet-5-5", maxTokens: 1024 },
      instructions: options.instructions ?? "Check records carefully.",
      skills: options.skills ?? [
        { skill: "test.lookup", settings: options.skillSettings ?? {} },
        { skill: "test.update-record", settings: {} },
        { skill: "test.alert", settings: {} },
      ],
      extraTools: [],
      canCommand: [],
      permissions: { mode: options.mode ?? "suggest_only" },
      budgets: { maxSteps: options.maxSteps ?? 6, maxCostUsd: options.maxCostUsd ?? "0.50" },
      memory: { enabled: true },
    },
    workflows: options.workflows ?? defaultWorkflows(),
  } satisfies AgentBundleInput);
}

export interface Client {
  tenantId: string;
  adminId: string;
  userId: string;
  connectionId: string;
}

export interface Harness {
  t: TestDatabase;
  /** Connections act as cs_worker: RLS and grants apply. */
  db: Db;
  operatorId: string;
  A: Client;
  B: Client;
  backend: TestkitBackend;
  tools: ToolRegistry;
  catalog: SkillCatalog;
  ctx: RegistryContext;
  deps(model?: FakeModel): RuntimeDeps;
  /** A back-office session over both clients. */
  ops<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  client<T>(c: Client, fn: (tx: Tx) => Promise<T>): Promise<T>;
  setPermissions(c: Client, matrix: Partial<PermissionMatrix>): Promise<void>;
  close(): Promise<void>;
}

function workerUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set("options", "-c role=cs_worker");
  return u.toString();
}

async function insertClient(t: TestDatabase, name: string, operatorId: string): Promise<Client> {
  const [row] = await t.db.insert(tenant).values({ name }).returning();
  if (!row) throw new Error("no tenant");
  const [admin] = await t.db
    .insert(appUser)
    .values({ email: `admin-${row.id}@example.com`, name: `${name} admin` })
    .returning();
  const [user] = await t.db
    .insert(appUser)
    .values({ email: `user-${row.id}@example.com`, name: `${name} user` })
    .returning();
  if (!admin || !user) throw new Error("no users");
  await t.db.insert(membership).values([
    { tenantId: row.id, userId: admin.id, role: "client_admin" },
    { tenantId: row.id, userId: user.id, role: "client_user" },
    { tenantId: row.id, userId: operatorId, role: "operator" },
  ]);
  const [conn] = await t.db
    .insert(connection)
    .values({ tenantId: row.id, connector: "testkit", status: "pending" })
    .returning();
  if (!conn) throw new Error("no connection");
  return { tenantId: row.id, adminId: admin.id, userId: user.id, connectionId: conn.id };
}

/** null when no database is reachable (the tests then skip). */
export async function createHarness(): Promise<Harness | null> {
  const t = await createTestDatabase();
  if (!t) return null;
  const db = createDb(workerUrl(t.url), { max: 4 });
  const [op] = await t.db
    .insert(appUser)
    .values({ email: "operator@example.com", name: "Operator" })
    .returning();
  if (!op) throw new Error("no operator");
  const A = await insertClient(t, "Client A", op.id);
  const B = await insertClient(t, "Client B", op.id);
  const backend = new TestkitBackend();
  backend.seed(A.connectionId, [{ id: "r1", name: "Oak board", amount: "10.00" }]);
  backend.seed(B.connectionId, [{ id: "r1", name: "Maple board", amount: "20.00" }]);
  const tools = new ToolRegistry({
    platform: PLATFORM_TOOLS,
    connectors: new ConnectorRegistry([createTestkitConnector(backend)]),
  });
  const catalog = new SkillCatalog([LOOKUP_SKILL, ALERT_SKILL, UPDATE_SKILL, READ_SKILL], tools);
  const ports = createDbPorts(db);
  return {
    t,
    db,
    operatorId: op.id,
    A,
    B,
    backend,
    tools,
    catalog,
    ctx: { tools, catalog },
    deps: (model = new FakeModel()) => ({ ports, tools, catalog, transport: model }),
    ops: (fn) => withOperator(db, [A.tenantId, B.tenantId], fn),
    client: (c, fn) => withTenant(db, c.tenantId, fn),
    async setPermissions(c, matrix) {
      await t.db
        .update(connection)
        .set({
          permissions: {
            read: "auto",
            create: "approval",
            update: "approval",
            delete: "off",
            ...matrix,
          },
        })
        .where(eq(connection.id, c.connectionId));
    },
    async close() {
      await db.$client.end();
      await t.drop();
    },
  };
}
