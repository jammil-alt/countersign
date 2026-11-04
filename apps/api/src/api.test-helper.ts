// Shared setup for the API's Node tests: a throwaway database (packages/db/testing), a client that
// connects as cs_worker (so RLS and grants apply as in the Worker), three clients with users, the
// app built over them with the dev sign-in, the testkit connector and in-memory Workflow
// instances, and a fake WorkflowStep for driving runs.

import { DEV_USER_HEADER } from "@countersign/auth";
import {
  createTestkitConnector,
  createUploadConnector,
  MemoryObjectStore,
  TESTKIT_UPDATE_TOOL,
  TestkitBackend,
} from "@countersign/connectors";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import { appUser, connection, createDb, type Db, membership, tenant } from "@countersign/db";
import { createTestDatabase, type TestDatabase } from "@countersign/db/testing";
import { type LlmTransport, withRecording } from "@countersign/llm";
import { fileFixtureStore } from "@countersign/llm/node";
import type { Hono } from "hono";
import { createApp } from "./app";
import type { Bindings } from "./env";
import type { AppEnv } from "./http";
import { createPlatform, type Platform } from "./platform";
import { MemoryInstances } from "./runs/instances";
import type { CloudflareStepConfig, WorkflowStepLike } from "./runs/step-runner";

export interface Client {
  tenantId: string;
  admin: string;
  user: string;
  connectionId: string;
}

export interface ApiHarness {
  t: TestDatabase;
  db: Db;
  app: Hono<AppEnv>;
  env: Bindings;
  platform: Platform;
  backend: TestkitBackend;
  instances: MemoryInstances;
  /** Originals uploaded and forwarded through the app. */
  objects: MemoryObjectStore;
  /** What reads documents in the background: replays fixtures/llm. */
  extraction: { transport: LlmTransport | null };
  operator: string;
  /** Serves only client C. */
  otherOperator: string;
  A: Client;
  B: Client;
  C: Client;
  /** Work handed to waitUntil, awaited by `settle()`. */
  settle(): Promise<void>;
  call(
    email: string | null,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: unknown; headers: Headers }>;
  close(): Promise<void>;
}

function workerUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set("options", "-c role=cs_worker");
  return u.toString();
}

async function addUser(t: TestDatabase, email: string, name: string): Promise<string> {
  const [row] = await t.db.insert(appUser).values({ email, name }).returning();
  if (!row) throw new Error("no user");
  return row.id;
}

async function addClient(
  t: TestDatabase,
  name: string,
  slug: string,
  operators: string[],
): Promise<Client> {
  const [row] = await t.db
    .insert(tenant)
    .values({ name, settings: { connectors_offered: ["testkit"] } })
    .returning();
  if (!row) throw new Error("no tenant");
  const admin = await addUser(t, `admin@${slug}.example.com`, `${name} admin`);
  const user = await addUser(t, `user@${slug}.example.com`, `${name} user`);
  await t.db
    .insert(membership)
    .values([
      { tenantId: row.id, userId: admin, role: "client_admin" },
      { tenantId: row.id, userId: user, role: "client_user" },
      ...operators.map((userId) => ({ tenantId: row.id, userId, role: "operator" as const })),
    ]);
  const [conn] = await t.db
    .insert(connection)
    .values({ tenantId: row.id, connector: "testkit", status: "pending" })
    .returning();
  if (!conn) throw new Error("no connection");
  return { tenantId: row.id, admin, user, connectionId: conn.id };
}

/** null when no database is reachable (the tests then skip). */
export async function createApiHarness(
  options: { llm?: LlmTransport } = {},
): Promise<ApiHarness | null> {
  const t = await createTestDatabase();
  if (!t) return null;
  const db = createDb(workerUrl(t.url), { max: 4 });
  const operator = await addUser(t, "operator@example.com", "Operator");
  const otherOperator = await addUser(t, "other-operator@example.com", "Other operator");
  const A = await addClient(t, "Client A", "a", [operator]);
  const B = await addClient(t, "Client B", "b", [operator]);
  const C = await addClient(t, "Client C", "c", [otherOperator]);
  const backend = new TestkitBackend();
  backend.seed(A.connectionId, [{ id: "r1", name: "Oak board", amount: "10.00" }]);
  backend.seed(B.connectionId, [{ id: "r1", name: "Maple board", amount: "20.00" }]);
  const platform = createPlatform({
    connectors: [createUploadConnector(), createTestkitConnector(backend)],
  });
  const instances = new MemoryInstances();
  const objects = new MemoryObjectStore();
  const extraction: { transport: LlmTransport | null } = {
    transport: withRecording(null, { mode: "replay", store: fileFixtureStore() }),
  };
  const app = createApp({
    platform: () => platform,
    openDb: () => ({ db, close: async () => {} }),
    instances: () => instances,
    ...(options.llm ? { llm: () => options.llm as LlmTransport } : {}),
    objects: () => objects,
    extractionTransport: () => extraction.transport,
  });
  const env = { ENVIRONMENT: "development", AUTH_PROVIDER: "dev" } as unknown as Bindings;
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  };
  return {
    t,
    db,
    app,
    env,
    platform,
    backend,
    instances,
    objects,
    extraction,
    operator,
    otherOperator,
    A,
    B,
    C,
    async settle() {
      while (pending.length > 0) await Promise.all(pending.splice(0));
    },
    async call(email, method, path, body, headers = {}) {
      const res = await app.request(
        path,
        {
          method,
          headers: {
            ...(email ? { [DEV_USER_HEADER]: email } : {}),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
        executionCtx as unknown as ExecutionContext,
      );
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { status: res.status, json, headers: res.headers };
    },
    async close() {
      await Promise.all(pending);
      await db.$client.end();
      await t.drop();
    },
  };
}

export const OPERATOR = "operator@example.com";
export const OTHER_OPERATOR = "other-operator@example.com";
export const admin = (c: "a" | "b" | "c") => `admin@${c}.example.com`;
export const user = (c: "a" | "b" | "c") => `user@${c}.example.com`;

/**
 * A bundle with one manual workflow: a change to the testkit record (approval on), a person's
 * approval, then a note in the run's thread.
 */
export function testBundle(name = "Records clerk"): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name, role: "keeps records", mission: "keep records right" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Change records only when asked.",
      skills: [],
      extraTools: [TESTKIT_UPDATE_TOOL],
      canCommand: [],
      permissions: { mode: "suggest_only" },
      budgets: { maxSteps: 4, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [
      {
        slug: "fix-record",
        name: "Fix a record",
        workflow: {
          schemaVersion: 3,
          trigger: { id: "trg-manual", on: { type: "manual", input: {} } },
          steps: [
            {
              id: "update",
              name: "Update the record",
              kind: "action",
              tool: TESTKIT_UPDATE_TOOL,
              input: { id: "r1", amount: "12.00" },
              approval: { required: "required" },
              client: { visible: true, label: "Corrected the record" },
            },
            {
              id: "confirm",
              name: "Confirm",
              kind: "person",
              mode: "approve",
              assignee: "client_admin",
              title: "Is the record right now?",
              timeout: "1 day",
              onTimeout: "stop",
            },
            {
              id: "internal",
              name: "Operator note",
              kind: "notify",
              channel: "thread",
              message: "Record fixed",
              client: { visible: false },
            },
          ],
        },
      },
    ],
  } satisfies AgentBundleInput);
}

/**
 * Cloudflare's WorkflowStep with the engine's replay contract, in memory: a completed `do` returns
 * its stored result, and so does a completed wait; a new wait asks `onWait` (which may throw the
 * engine's timeout error).
 */
export class FakeWorkflowStep implements WorkflowStepLike {
  readonly results = new Map<string, unknown>();
  readonly configs = new Map<string, CloudflareStepConfig | undefined>();
  readonly waits: { name: string; type: string; timeout: string | number | undefined }[] = [];
  readonly sleeps: string[] = [];

  constructor(
    private readonly onWait: (name: string, type: string) => Promise<unknown> = async () => {
      throw Object.assign(new Error("Execution timed out after 1000ms"), {
        name: "WorkflowTimeoutError",
      });
    },
  ) {}

  async do(
    name: string,
    a: CloudflareStepConfig | (() => Promise<unknown>),
    b?: () => Promise<unknown>,
  ): Promise<unknown> {
    if (this.results.has(name)) return this.results.get(name);
    const fn = typeof a === "function" ? a : b;
    this.configs.set(name, typeof a === "function" ? undefined : a);
    if (!fn) throw new Error("no callback");
    // Results go through JSON, as the engine stores them.
    const value = JSON.parse(JSON.stringify((await fn()) ?? null));
    this.results.set(name, value);
    return value;
  }

  async sleep(name: string): Promise<void> {
    this.sleeps.push(name);
  }

  async waitForEvent(name: string, options: { type: string; timeout?: string | number }) {
    const key = `wait:${name}`;
    if (this.results.has(key)) {
      return { type: options.type, payload: this.results.get(key), timestamp: new Date() };
    }
    this.waits.push({ name, type: options.type, timeout: options.timeout });
    const payload = await this.onWait(name, options.type);
    this.results.set(key, payload);
    return { type: options.type, payload, timestamp: new Date() };
  }
}
