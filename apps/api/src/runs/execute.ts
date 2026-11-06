// One run, start to finish, against any StepRunner: RunWorkflow passes Cloudflare's step, tests a
// fake. Loads the pinned version's workflow, executes it through packages/workflows with the real
// ports, records how it ended on `run`, rolls usage up, and dispatches the events it emitted.

import { createDbPorts, finishRun, type RuntimeDeps, rollupUsageForRun } from "@countersign/agents";
import {
  ContentStore,
  CredentialCipher,
  type CredentialKeys,
  type CredentialsAccessor,
  credentialKeysFromEnv,
  encryptedCredentials,
  R2ObjectStore,
  tenantKeysInDb,
  type UrlSigner,
} from "@countersign/connectors";
import {
  type Locale,
  type Processor,
  parseCoveredProcessors,
  type Workflow,
} from "@countersign/core";
import { agentVersion, connection, type Db, run, withTenant } from "@countersign/db";
import {
  anthropicTransport,
  type LlmTransport,
  openaiTransport,
  routingTransport,
} from "@countersign/llm";
import { type EventRow, emit } from "@countersign/senses";
import {
  type ExecutorContext,
  executeWorkflow,
  type RunInfo,
  type RunResult,
  type StepRunner,
} from "@countersign/workflows";
import { and, eq } from "drizzle-orm";
import { dbReleasePort, type ReleaseDeps, releaseDepsFromEnv } from "../access/release";
import { browserRunOpener } from "../browser/driver";
import { type BrowserDeps, dbBrowserServices } from "../browser/services";
import { type VoiceDeps, voiceDepsFromEnv } from "../calls/answer";
import { codesFor } from "../codes/client";
import { guardModels, hipaaToolPolicy, profileReader } from "../compliance/policy";
import type { Bindings } from "../env";
import { connectorServicesFor } from "../messaging/services";
import type { Platform } from "../platform";
import { dbDocumentServices } from "../qbo/documents";
import { type ReachDeps, reachPort } from "../reach/service";
import { tenantLocale } from "../routes/language";
import { signerFor } from "../storage";
import { createRunRow, dispatchEvents, senseEmitter } from "./dispatch";
import type { RunInstances, RunParams } from "./instances";
import { agentPort, dbInboxPort, dbStepLog, threadNotifyPort } from "./ports";

export interface RunDeps {
  db: Db;
  platform: Platform;
  transport: LlmTransport;
  /**
   * The vendors with a signed BAA (docs/plan.md §1.35): with it, clients in HIPAA mode are held to
   * them (tool policy and model guard). Absent (tests): nothing is refused.
   */
  covered?: ReadonlySet<Processor>;
  instances?: RunInstances;
  credentials?: RuntimeDeps["credentials"];
  /** Object storage and links for the `docs.*` tools; extraction uses `transport`. */
  documents?: { content: ContentStore; signer?: UrlSigner | null };
  /** ElevenLabs, the public origin and outbound HTTP, for calls (`call.place`). */
  voice?: VoiceDeps;
  /**
   * Human release (docs/plan.md §1.26): codes and how they are sent. Absent: a connection that
   * needs a release refuses every call (fails closed).
   */
  release?: ReleaseDeps;
  /** The clock for release waits (tests move it); default the system clock. */
  now?: () => Date;
  /** Browser Run, the code service and storage, for browser logins (`browser.*`). */
  browser?: BrowserDeps;
}

/**
 * The model transport for a deployed Worker: Anthropic models with ANTHROPIC_API_KEY, OpenAI models
 * (`openai:` ids) with OPENAI_API_KEY.
 */
// DECISION: the Worker calls the model live or not at all: record/replay needs the fixture files,
// which only tests (Node) have. A model whose provider has no key fails with an error naming the
// missing key, so a run without a model still runs its tool-mode skills and actions.
export function workerTransport(
  env: Pick<Bindings, "ANTHROPIC_API_KEY" | "OPENAI_API_KEY">,
): LlmTransport {
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  const openaiKey = env.OPENAI_API_KEY?.trim();
  return routingTransport({
    ...(anthropicKey ? { anthropic: anthropicTransport({ apiKey: anthropicKey }) } : {}),
    ...(openaiKey ? { openai: openaiTransport({ apiKey: openaiKey }) } : {}),
  });
}

/**
 * Encrypted connection credentials, decrypted only when a connector asks for them: under the
 * client's own key (v2; v1 rows still open), each read and write a short transaction for that
 * client, never held across a model call.
 */
export function credentialsFor(
  db: Db,
  keys: CredentialKeys,
): NonNullable<RuntimeDeps["credentials"]> {
  let cipher: Promise<CredentialCipher> | undefined;
  return (conn) => {
    let inner: CredentialsAccessor | undefined;
    const open = async () => {
      cipher ??= CredentialCipher.create(keys);
      inner ??= encryptedCredentials({
        cipher: (await cipher).forClients(tenantKeysInDb(db)),
        binding: { tenantId: conn.tenantId, connectionId: conn.id },
        load: () =>
          withTenant(db, conn.tenantId, async (tx) => {
            const [row] = await tx
              .select({ c: connection.credentialsEncrypted })
              .from(connection)
              .where(and(eq(connection.id, conn.id), eq(connection.tenantId, conn.tenantId)));
            return row?.c ?? null;
          }),
        save: (envelope) =>
          withTenant(db, conn.tenantId, async (tx) => {
            await tx
              .update(connection)
              .set({ credentialsEncrypted: envelope as Record<string, unknown> })
              .where(and(eq(connection.id, conn.id), eq(connection.tenantId, conn.tenantId)));
          }),
      });
      return inner;
    };
    return {
      get: async () => (await open()).get(),
      set: async (value) => (await open()).set(value),
    };
  };
}

export function runDepsFromEnv(
  env: Bindings,
  base: { db: Db; platform: Platform; instances?: RunInstances },
): RunDeps {
  const content = new ContentStore(new R2ObjectStore(env.ARTIFACTS));
  const open = browserRunOpener(env);
  return {
    ...base,
    covered: parseCoveredProcessors(env.BAA_PROCESSORS),
    transport: workerTransport(env),
    voice: voiceDepsFromEnv(env),
    documents: { content, signer: signerFor(env, env.APP_ORIGIN ?? "") },
    // Browser logins: Browser Run when bound (BROWSER), codes when bound (CODES).
    browser: { ...(open ? { open } : {}), codes: codesFor(env), content },
    ...(env.ENCRYPTION_KEY
      ? { credentials: credentialsFor(base.db, credentialKeysFromEnv(env)) }
      : {}),
    release: releaseDepsFromEnv(env, base),
  };
}

// DECISION: skill and action steps retry three times with backoff and give up after 15 minutes:
// a failure a fourth attempt would not fix needs a person (Plenary Labs' policy).
const STEP_CONFIG = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "15 minutes",
} as const;

type Loaded = { ok: true; workflow: Workflow; language: Locale } | { ok: false; reason: string };

/** The agents runtime over the database, as a run (or the cron, for reach-outs) uses it. */
export function runtimeFor(
  deps: RunDeps,
  options: { collect?: EventRow[]; testRun?: boolean } = {},
): RuntimeDeps {
  const { db } = deps;
  return {
    ports: createDbPorts(db, {
      connectorName: (id) => deps.platform.connectors.get(id)?.manifest.name ?? id,
      emit: senseEmitter(deps.platform.events, {
        ...(options.collect ? { collect: options.collect } : {}),
        testRun: options.testRun === true,
      }),
      ...(deps.documents ? { documents: { ...deps.documents, transport: deps.transport } } : {}),
      ...(deps.release
        ? { release: dbReleasePort(deps.now ? { ...deps.release, now: deps.now } : deps.release) }
        : {}),
    }),
    tools: deps.platform.tools,
    catalog: deps.platform.catalog,
    transport: deps.transport,
    ...(deps.covered ? { policy: hipaaToolPolicy(profileReader(db), deps.covered) } : {}),
    ...(deps.credentials ? { credentials: deps.credentials } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    // Contacts and consent for messaging connectors, scoped to the connection's client; the
    // catalogue, a browser, codes and documents for browser logins.
    services: withDocuments(
      withBrowser(
        connectorServicesFor(
          db,
          deps.voice ? { voice: deps.voice, platform: deps.platform } : undefined,
        ),
        db,
        deps.browser,
      ),
      db,
      deps.documents?.content,
    ),
  };
}

/** The client's stored documents, for tools that send one to the client's tool (QBO attachments). */
function withDocuments(
  base: NonNullable<RuntimeDeps["services"]>,
  db: Db,
  content: ContentStore | undefined,
): NonNullable<RuntimeDeps["services"]> {
  if (!content) return base;
  return (conn) => ({ ...base(conn), documents: dbDocumentServices(db, conn, content) });
}

function withBrowser(
  base: NonNullable<RuntimeDeps["services"]>,
  db: Db,
  browser: BrowserDeps | undefined,
): NonNullable<RuntimeDeps["services"]> {
  if (!browser) return base;
  return (conn) => ({ ...base(conn), browser: dbBrowserServices(db, conn, browser) });
}

/** RunDeps for one client: its model calls held to its HIPAA mode (docs/plan.md §1.35). */
export function forClient(deps: RunDeps, tenantId: string): RunDeps {
  if (!deps.covered) return deps;
  return {
    ...deps,
    transport: guardModels(deps.transport, tenantId, profileReader(deps.db), deps.covered),
  };
}

/** The reach-out service outside a run (the cron's escalation). */
export function reachDepsFor(deps: RunDeps): ReachDeps {
  return {
    db: deps.db,
    runtime: runtimeFor(deps),
    ...(deps.instances ? { instances: deps.instances } : {}),
  };
}

export async function executeRun(
  deps: RunDeps,
  params: RunParams,
  runner: StepRunner,
): Promise<RunResult> {
  const info: RunInfo = {
    id: params.runId,
    tenantId: params.tenantId,
    agentId: params.agentId,
    agentVersionId: params.agentVersionId,
    workflowSlug: params.workflowSlug,
    mode: params.mode,
  };
  const { db } = deps;
  const emitted: EventRow[] = [];

  const loaded = await runner.do<Loaded>("run:load", () =>
    withTenant(db, info.tenantId, async (tx) => {
      // The API and the dispatcher write the row first; this covers a start that crashed between.
      try {
        await createRunRow(tx, params);
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      const [v] = await tx
        .select({ bundle: agentVersion.bundle })
        .from(agentVersion)
        .where(
          and(eq(agentVersion.id, info.agentVersionId), eq(agentVersion.tenantId, info.tenantId)),
        );
      const wf = v?.bundle.workflows.find((w) => w.slug === info.workflowSlug);
      if (!wf) return { ok: false, reason: `no workflow ${info.workflowSlug} in that version` };
      // DECISION: the run reads the client's language once, inside this durable step, so a replay
      // writes in the same language even if the client changed it meanwhile (plan §1.18).
      return { ok: true, workflow: wf.workflow, language: await tenantLocale(tx, info.tenantId) };
    }),
  );

  const finish = async (result: RunResult) => {
    await runner.do("run:finish", async () => {
      await withTenant(db, info.tenantId, async (tx) => {
        const [exists] = await tx.select({ id: run.id }).from(run).where(eq(run.id, info.id));
        if (!exists) return;
        await finishRun(tx, {
          tenantId: info.tenantId,
          runId: info.id,
          status: result.status,
          ...(result.status === "succeeded"
            ? {}
            : { error: { reason: result.reason ?? null, nodeId: result.nodeId ?? null } }),
        });
        // `run.failed` (docs/plan.md §1.28), in the transaction that records the failure, so it
        // exists exactly when the run is failed. A test run emits nothing (ARCHITECTURE §10.4).
        if (result.status === "failed") {
          const row = await emit(
            tx,
            {
              tenantId: info.tenantId,
              type: "run.failed",
              subjectType: "run",
              subjectId: info.id,
              payload: {
                runId: info.id,
                agentId: info.agentId,
                agentVersionId: info.agentVersionId,
                workflowSlug: info.workflowSlug,
                stepId: result.nodeId ?? null,
                error: (result.reason ?? "failed").slice(0, 1000),
              },
            },
            { registry: deps.platform.events, testRun: info.mode === "test" },
          );
          if (row) emitted.push(row);
        }
      });
      // Best effort: whatever this misses (or a replay lost), the cron sweep dispatches.
      if (deps.instances && emitted.length > 0) {
        await dispatchEvents({ db, instances: deps.instances }, emitted.splice(0));
      }
      return null;
    });
    // DECISION: usage is rolled up in its own step once the run's end is committed, so the run page
    // shows Done as soon as the run is done, not after every day it touched is recomputed in the
    // same transaction. A rollup that fails retries alone; the hourly sweep covers it too.
    await runner.do("run:usage", async () => {
      await withTenant(db, info.tenantId, async (tx) => {
        // Every day the run touched: one that waited overnight added to more than today.
        await rollupUsageForRun(tx, { tenantId: info.tenantId, runId: info.id });
      });
      return null;
    });
  };

  if (!loaded.ok) {
    const result: RunResult = { status: "failed", reason: loaded.reason };
    await finish(result);
    return result;
  }

  const runtime = runtimeFor(forClient(deps, info.tenantId), {
    collect: emitted,
    testRun: info.mode === "test",
  });
  info.language = loaded.language;
  const ctx: ExecutorContext = {
    run: info,
    agent: agentPort(
      runtime,
      reachPort({ db, runtime, ...(deps.instances ? { instances: deps.instances } : {}) }),
      { db },
    ),
    inbox: dbInboxPort(db, info),
    notify: threadNotifyPort(runtime),
    log: dbStepLog(db, info),
    catalog: {
      skills: Object.fromEntries(deps.platform.catalog.list().map((s) => [s.id, s])),
      tools: deps.platform.tools.specs(),
    },
    stepConfig: {
      retries: { ...STEP_CONFIG.retries },
      timeout: STEP_CONFIG.timeout,
    },
  };

  let result: RunResult;
  try {
    result = await executeWorkflow(runner, ctx, loaded.workflow, params.payload);
  } catch (error) {
    await finish({
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  await finish(result);
  return result;
}
