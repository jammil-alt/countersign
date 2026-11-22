// Shared setup for the API's Node tests: a throwaway database (packages/db/testing), a client that
// connects as cs_worker (so RLS and grants apply as in the Worker), three clients with users, the
// app built over them with the dev sign-in, the testkit connector and in-memory Workflow
// instances, and a fake WorkflowStep for driving runs.

import { DEV_USER_HEADER, type WorkOSClient } from "@countersign/auth";
import type { CodeVerifier } from "@countersign/connectors";
import {
  type Connector,
  createHackerNewsConnector,
  createLinkedInConnector,
  createTestkitConnector,
  createUploadConnector,
  createWebsiteConnector,
  type FetchLike,
  MemoryObjectStore,
  type StripeClient,
  TESTKIT_UPDATE_TOOL,
  TestkitBackend,
} from "@countersign/connectors";
import {
  AgentBundle,
  type AgentBundleInput,
  FORBIDDEN_PORTAL_FIELD,
  hashJson,
  type SkillDefinition,
  SkillDefinition as SkillDefinitionSchema,
} from "@countersign/core";
import {
  appUser,
  connection,
  createDb,
  type Db,
  inboxItem,
  membership,
  skill,
  skillVersion,
  tenant,
} from "@countersign/db";
import { createTestDatabase, type TestDatabase } from "@countersign/db/testing";
import { type LlmTransport, type Transcriber, withRecording } from "@countersign/llm";
import { fileFixtureStore } from "@countersign/llm/node";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { createApp } from "./app";
// v0.12 W2-C
import type { BrowserDeps } from "./browser/services";
import type { Bindings } from "./env";
import type { ExportJobs } from "./exports/instances";
import type { AppEnv } from "./http";
import type { InboxRow } from "./inbox";
import type { McpDeps } from "./mcp/routes";
import { createPlatform, type Platform } from "./platform";
import type { QboSyncInstances } from "./qbo/instances";
import { opsShownFingerprint } from "./routes/mappers";
import { shownFingerprint } from "./routes/portal";
import { MemoryInstances } from "./runs/instances";
import type { CloudflareStepConfig, WorkflowStepLike } from "./runs/step-runner";
import type { TestSuiteJobs } from "./testbench/instances";

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
  // P-7
  /** What translates messages outside a run: none by default (tests set a FakeModel). */
  translation: { transport: LlmTransport | null };
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
    // The undo window (v0.12 W1-D) is off for the shared clients, so a test's approval reaches its
    // run at once; src/desk.test.ts turns it on where it is under test.
    .values({ name, settings: { connectors_offered: ["testkit"], approvals: { undoSeconds: 0 } } })
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

export interface HarnessOptions {
  /** More connectors beside the testkit (e.g. webhooks, Zoho CRM over fakes). */
  connectors?: (backend: TestkitBackend) => Connector[];
  /** Env beside the dev sign-in (e.g. ENCRYPTION_KEY, OAUTH_STATE_SECRET). */
  env?: Partial<Bindings>;
  /** The Builder's model transport (tests pass a FakeModel). */
  llm?: LlmTransport;
  /** A fake WorkOS API for the WorkOS sign-in (with `AUTH_PROVIDER: "workos"` in `env`). */
  workos?: WorkOSClient;
  /** Outbound HTTP for provisioning routes (e.g. a fake Twilio). */
  fetch?: FetchLike;
  /** Billing's Stripe (tests pass a client over `fakeStripe`); none by default. */
  stripe?: StripeClient;
  /** Platform skills beside the built-in ones (e.g. an agent-mode skill over a connector's tools). */
  skills?: SkillDefinition[];
  /** QuickBooks syncs (in-memory instances); none by default. */
  qboSync?: QboSyncInstances;
  /** Client data export jobs (in memory); none by default. */
  exports?: ExportJobs;
  /** The MCP server's authorization server, audit, rate limit and clock (fakes). */
  mcp?: McpDeps;
  /** §1.100: the code service for sign-in codes (tests pass one in memory). */
  codeVerifier?: CodeVerifier;
  /** §1.109: voice typing's speech-to-text (a fake); none by default, so voice is off. */
  transcriber?: Transcriber;
  // v0.12 W2-C
  /** Test suite jobs (in memory); none by default. */
  testSuites?: TestSuiteJobs;
  // Wave 4
  /** A browser for script recordings and tests (a fake); none by default. */
  browserOpener?: NonNullable<BrowserDeps["open"]>;
  /**
   * The app's own database pool, as a Worker has it: production's `openDb` gives a request one
   * connection (`{ max: 1 }`), so a handler that opens a transaction beside the request's waits on
   * itself. Set to 1 to catch that (the test then times out). Absent: the harness's `db` (4).
   * The harness's `db`, for the test's own reads and runs, stays at 4 either way.
   */
  appDbMax?: number;
}

/** null when no database is reachable (the tests then skip). */
export async function createApiHarness(options: HarnessOptions = {}): Promise<ApiHarness | null> {
  const t = await createTestDatabase();
  if (!t) return null;
  const db = createDb(workerUrl(t.url), { max: 4 });
  const appDb =
    options.appDbMax !== undefined ? createDb(workerUrl(t.url), { max: options.appDbMax }) : db;
  const operator = await addUser(t, "operator@example.com", "Operator");
  const otherOperator = await addUser(t, "other-operator@example.com", "Other operator");
  const A = await addClient(t, "Client A", "a", [operator]);
  const B = await addClient(t, "Client B", "b", [operator]);
  const C = await addClient(t, "Client C", "c", [otherOperator]);
  const backend = new TestkitBackend();
  backend.seed(A.connectionId, [{ id: "r1", name: "Oak board", amount: "10.00" }]);
  backend.seed(B.connectionId, [{ id: "r1", name: "Maple board", amount: "20.00" }]);
  const extra = options.connectors?.(backend) ?? [];
  // The Marketing pack is in every deployment, and its skills and templates name the Hacker News,
  // website and LinkedIn tools (a skill catalog or a template refuses a tool no connector
  // provides), so every test platform registers them too, as platform.ts does: Hacker News with
  // no network, the website over memory, LinkedIn with no sign-in. A test that passes its own
  // copy of one gets that one instead.
  const marketing = [
    createHackerNewsConnector({
      fetch: async () => {
        throw new Error("no network in tests");
      },
    }),
    createWebsiteConnector({ store: new MemoryObjectStore() }),
    createLinkedInConnector({}),
  ].filter((c) => !extra.some((e) => e.manifest.id === c.manifest.id));
  const platform = createPlatform({
    connectors: [createUploadConnector(), createTestkitConnector(backend), ...marketing, ...extra],
    ...(options.skills ? { skills: options.skills } : {}),
  });
  const instances = new MemoryInstances();
  const objects = new MemoryObjectStore();
  const extraction: { transport: LlmTransport | null } = {
    transport: withRecording(null, { mode: "replay", store: fileFixtureStore() }),
  };
  // P-7: no translation model unless a test sets one, so other tests never call one.
  const translation: { transport: LlmTransport | null } = { transport: null };
  const app = createApp({
    platform: () => platform,
    openDb: () => ({ db: appDb, close: async () => {} }),
    instances: () => instances,
    ...(options.llm ? { llm: () => options.llm as LlmTransport } : {}),
    ...(options.workos ? { workos: () => options.workos as WorkOSClient } : {}),
    ...(options.fetch ? { fetch: () => options.fetch as FetchLike } : {}),
    objects: () => objects,
    extractionTransport: () => extraction.transport,
    translationTransport: () => translation.transport,
    stripe: () => options.stripe ?? null,
    qboSync: () => options.qboSync ?? null,
    exports: () => options.exports ?? null,
    ...(options.mcp ? { mcp: options.mcp } : {}),
    ...(options.codeVerifier ? { codeVerifier: () => options.codeVerifier as CodeVerifier } : {}),
    transcriber: () => options.transcriber ?? null,
    // v0.12 W2-C
    ...(options.testSuites ? { testSuites: () => options.testSuites as TestSuiteJobs } : {}),
    ...(options.browserOpener ? { browserOpener: () => options.browserOpener } : {}),
  });
  const env = {
    ENVIRONMENT: "development",
    AUTH_PROVIDER: "dev",
    ...options.env,
  } as unknown as Bindings;
  /** The fingerprint of an item as the portal shows it now (`shownFingerprint`). */
  const seenNow = async (id: string): Promise<string | null> => {
    const [row] = await t.db.select().from(inboxItem).where(eq(inboxItem.id, id));
    if (!row) return null;
    return shownFingerprint(
      t.db as unknown as Parameters<typeof shownFingerprint>[0],
      row as InboxRow,
      platform,
    );
  };
  /**
   * The fingerprint of an item as the back office shows it now (`opsShownFingerprint`); which
   * operator asks is not part of it.
   */
  const opsSeenNow = async (id: string): Promise<string | null> => {
    const [row] = await t.db.select().from(inboxItem).where(eq(inboxItem.id, id));
    if (!row) return null;
    return opsShownFingerprint(row as InboxRow, { userId: operator, role: "operator" }, platform);
  };
  const withFingerprints = async (path: string, body: unknown): Promise<unknown> => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return body;
    const b = body as Record<string, unknown>;
    // The back office's resolve and step-in (audit 3.4, docs/plan.md §1.191).
    const ops =
      /^\/api\/ops\/inbox\/([0-9a-f-]{36})\/resolve$/.exec(path) ??
      /^\/api\/ops\/clients\/[0-9a-f-]{36}\/inbox\/([0-9a-f-]{36})\/step-in$/.exec(path);
    if (ops?.[1] && b.fingerprint === undefined) {
      const fp = await opsSeenNow(ops[1]);
      return fp ? { ...b, fingerprint: fp } : body;
    }
    const one = /^\/api\/inbox\/([0-9a-f-]{36})\/resolve$/.exec(path);
    if (one?.[1] && b.fingerprint === undefined && b.deviceSignature === undefined) {
      const fp = await seenNow(one[1]);
      return fp ? { ...b, fingerprint: fp } : body;
    }
    if (path === "/api/inbox/batch/resolve" && b.fingerprints === undefined) {
      const ids = [b.approve, b.reject].flatMap((l) => (Array.isArray(l) ? l : []));
      const fingerprints: Record<string, string> = {};
      for (const id of ids) {
        const fp = typeof id === "string" ? await seenNow(id) : null;
        if (fp) fingerprints[id as string] = fp;
      }
      return { ...b, fingerprints };
    }
    return body;
  };
  const pending: Promise<unknown>[] = [];
  // DECISION: every request through the harness's app has its after-the-response work (event
  // dispatch, a document's reading, closing the request's database) kept in `pending`, whatever
  // execution context the test passed, or none (docs/plan.md §1.209). A test that passed its own
  // still gets the promises too. Without this, work handed to a discarded `waitUntil` ran on its
  // own: it raced what the test did next, and `close()` ended the pool under it.
  const request = app.request;
  app.request = (input, init, requestEnv, ctx) =>
    request(input, init, requestEnv, {
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p);
        ctx?.waitUntil(p);
      },
      passThroughOnException: () => ctx?.passThroughOnException(),
      props: ctx?.props ?? {},
    } as ExecutionContext);
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
    translation,
    operator,
    otherOperator,
    A,
    B,
    C,
    async settle() {
      while (pending.length > 0) await Promise.all(pending.splice(0));
    },
    async call(email, method, path, body, rawHeaders = {}) {
      // Audit 3.4: the portal's answers carry the fingerprint of the item as the person saw it.
      // A test that doesn't send one answers what the portal shows now (as the web would), unless
      // it sends `AS_SENT` to have its body go exactly as written.
      const { [AS_SENT]: asSent, ...headers } = rawHeaders;
      if (method === "POST" && !asSent) body = await withFingerprints(path, body);
      const res = await app.request(
        path,
        {
          method,
          headers: {
            ...(email ? { [DEV_USER_HEADER]: email } : {}),
            ...(body === undefined || typeof body === "string"
              ? {}
              : { "content-type": "application/json" }),
            ...headers,
          },
          ...(body === undefined
            ? {}
            : { body: typeof body === "string" ? body : JSON.stringify(body) }),
        },
        env,
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
      // Work still running after the response is awaited first: the pools end only after it.
      while (pending.length > 0) await Promise.allSettled(pending.splice(0));
      if (appDb !== db) await appDb.$client.end();
      await db.$client.end();
      await t.drop();
    },
  };
}

/**
 * The area owner's signature under a message sent outside the client ("Pia, purchasing agent for
 * Acme" and "Powered by mezonas.com"; ARCHITECTURE v0.19 §10.15), and under it, on a first text,
 * the opt-out line (docs/plan.md §1.97).
 */
const SIGNED = /\n\n([^\n]+(?:\n[^\n]*mezonas\.com)?)(?:\n([^\n]*\bSTOP\b[^\n]*))?$/u;

/** A message sent outside the client without its signature, so a test can compare what the agent wrote. */
export function unsigned(text: string | null | undefined): string | undefined {
  return text?.replace(SIGNED, "");
}

/** The signature lines the sent message ends with, for a test that checks them. */
export function signatureOf(text: string | null | undefined): string[] {
  return text?.match(SIGNED)?.[1]?.split("\n") ?? [];
}

/** The opt-out line a signed first text ends with (§1.97), or null when it has none. */
export function optOutOf(text: string | null | undefined): string | null {
  return text?.match(SIGNED)?.[2] ?? null;
}

/**
 * A header for `ApiHarness.call` (never sent): the body goes exactly as written, with no
 * fingerprint added to a portal answer that lacks one (audit 3.4).
 */
export const AS_SENT = "x-test-as-sent";

export const OPERATOR = "operator@example.com";
export const OTHER_OPERATOR = "other-operator@example.com";
/**
 * Skill model (2026-11-10): an operator skill version as it was stored before the skill model (an
 * agent-mode skill, say), written straight to its rows and made live. A new version of that kind is
 * refused; a stored one keeps running (invariant 3), which is what tests of stored skills need.
 */
export async function storedSkill(
  h: Pick<ApiHarness, "t">,
  definition: { id: string; name: string } & Record<string, unknown>,
  tenantId: string | null = null,
): Promise<{ skillId: string; versionId: string }> {
  const def = SkillDefinitionSchema.parse(definition);
  const [row] = await h.t.db
    .insert(skill)
    .values({ tenantId, slug: def.id.replace(/^custom:/, ""), name: def.name })
    .returning();
  if (!row) throw new Error("no skill");
  const [v] = await h.t.db
    .insert(skillVersion)
    .values({
      tenantId,
      skillId: row.id,
      version: 1,
      definition: def,
      definitionHash: await hashJson(def),
      status: "live",
    })
    .returning();
  if (!v) throw new Error("no skill version");
  await h.t.db.update(skill).set({ liveVersionId: v.id }).where(eq(skill.id, row.id));
  return { skillId: row.id, versionId: v.id };
}

/**
 * Connectors C4 (docs/connectors-plan.md §3.2, §5.1): a new connection starts low risk (writes
 * off but a few ask-first rows), so a test whose agent writes has the client admin press "Allow
 * what <agent> needs" on the connection, as the portal does: exactly the agent's needs, at ask
 * first, as the client's own change. Returns the connection's page view.
 */
export async function allowForAgent(
  H: Pick<ApiHarness, "call">,
  adminEmail: string,
  connectionId: string,
  agentId: string,
): Promise<unknown> {
  const res = await H.call(
    adminEmail,
    "POST",
    `/api/portal/connections/${connectionId}/allow-for/${agentId}`,
    {},
  );
  if (res.status !== 200) {
    throw new Error(`allowing what the agent needs failed: ${JSON.stringify(res.json)}`);
  }
  return res.json;
}

export const admin = (c: "a" | "b" | "c") => `admin@${c}.example.com`;
export const user = (c: "a" | "b" | "c") => `user@${c}.example.com`;

/**
 * Every key in a JSON value that a portal response may never carry (invariant 11): the contract's
 * forbidden fields, and `also` when a test is stricter (e.g. any key naming cost or tokens).
 */
export function forbiddenKeys(value: unknown, also?: RegExp, at = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, also, `${at}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [
    ...(FORBIDDEN_PORTAL_FIELD.test(k) || also?.test(k) ? [`${at}.${k}`] : []),
    ...forbiddenKeys(v, also, `${at}.${k}`),
  ]);
}

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
/** Cloudflare Workflows' limit on one step's stored result. */
export const ENGINE_STEP_RESULT_MAX_BYTES = 1024 * 1024;

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
    // Results go through JSON, as the engine stores them, and over 1 MiB fail as the engine's do.
    const json = JSON.stringify((await fn()) ?? null);
    if (new TextEncoder().encode(json).length > ENGINE_STEP_RESULT_MAX_BYTES) {
      throw new Error(`step ${name}: its result is over the engine's 1 MiB`);
    }
    const value = JSON.parse(json);
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
