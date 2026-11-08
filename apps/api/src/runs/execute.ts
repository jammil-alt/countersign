// One run, start to finish, against any StepRunner: RunWorkflow passes Cloudflare's step, tests a
// fake. Loads the pinned version's workflow, executes it through packages/workflows with the real
// ports, records how it ended on `run`, rolls usage up, and dispatches the events it emitted.

import {
  createDbPorts,
  dbModelCalls,
  finishRun,
  type RuntimeDeps,
  resolveAutomation,
  rollupUsageForRun,
} from "@countersign/agents";
import {
  ContentStore,
  CredentialCipher,
  type CredentialKeys,
  type CredentialsAccessor,
  credentialKeysFromEnv,
  encryptedCredentials,
  type ObjectStore,
  R2ObjectStore,
  tenantKeysInDb,
  type UrlSigner,
} from "@countersign/connectors";
import {
  type AutomationDefinition,
  automationRefs,
  // v0.12 W2-E
  HANDOFF_OUTPUT_MAX_BYTES,
  HANDOFF_SOURCES_MAX,
  isUuid,
  type Locale,
  // v0.13 W2-I
  type OversightSettings,
  type Processor,
  parseCoveredProcessors,
  RUN_SUCCEEDED_EVENT,
  type RunSucceededPayload,
  resolveTemplate,
  runErrorKey,
  shortRunId,
  type Workflow,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  type Db,
  run,
  stepRun,
  type Tx,
  withTenant,
} from "@countersign/db";
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
  type RunResume,
  type StepRunner,
} from "@countersign/workflows";
import { and, eq, inArray } from "drizzle-orm";
import { dbReleasePort, type ReleaseDeps, releaseDepsFromEnv } from "../access/release";
// v0.12 W2-D
import { accountViews } from "../account/views";
import { browserRunOpener } from "../browser/driver";
import { type BrowserDeps, dbBrowserServices } from "../browser/services";
import { type VoiceDeps, voiceDepsFromEnv } from "../calls/answer";
import { codesFor } from "../codes/client";
import { guardModels, hipaaToolPolicy, profileReader } from "../compliance/policy";
// P-4
import { conversePort } from "../converse/service";
import type { Bindings } from "../env";
import { connectorServicesFor } from "../messaging/services";
// v0.13 W2-I
import { oversightPort } from "../oversight/port";
import type { Platform } from "../platform";
import { dbDocumentServices } from "../qbo/documents";
import { dbSyncedRecords } from "../qbo/receivables";
import { type ReachDeps, reachPort } from "../reach/service";
import { tenantLocale } from "../routes/language";
import { signerFor } from "../storage";
import { createRunRow, dispatchEvents, dispatchingRunner, senseEmitter } from "./dispatch";
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
  // v0.12 W1-E
  /**
   * Where model calls' requests and answers are stored (the R2 bucket). Absent (tests): the
   * `model_call` rows are still written, without their bodies.
   */
  modelCallBodies?: ObjectStore | null;
  // §1.77
  /** Web research for `web.search` and `web.fetch` (MARKETING_RESEARCH=on); absent: off. */
  webResearch?: boolean;
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
    // v0.12 W1-E: model calls' bodies, under the client's prefix in the same bucket.
    modelCallBodies: new R2ObjectStore(env.ARTIFACTS),
    // §1.77: off unless the owner sets MARKETING_RESEARCH=on (docs/marketing-plan.md §11.5).
    webResearch: researchOn(env),
  };
}

/** MARKETING_RESEARCH=on: `web.search` and `web.fetch` call the vendor; anything else is off. */
export function researchOn(env: Pick<Bindings, "MARKETING_RESEARCH">): boolean {
  return env.MARKETING_RESEARCH?.trim().toLowerCase() === "on";
}

// DECISION: skill and action steps retry three times with backoff and give up after 15 minutes:
// a failure a fourth attempt would not fix needs a person (Plenary Labs' policy).
const STEP_CONFIG = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "15 minutes",
} as const;

type Loaded =
  | {
      ok: true;
      workflow: Workflow;
      language: Locale;
      resume: RunResume | null;
      // v0.12 W2-B: the automation versions its use steps pin.
      automations?: Record<string, AutomationDefinition>;
      // v0.13 W2-I: the agent's oversight settings, as pinned (absent: off).
      oversight?: OversightSettings;
    }
  | { ok: false; reason: string; cancelled?: true };

// v0.12 W2-B: automations (ARCHITECTURE §10.7; docs/plan.md §1.45).
/**
 * The automation versions a workflow's use steps pin, resolved in the run's own client (its own
 * automations and its copies of shared ones). Read once, in the run's load step, so a replay
 * expands the same steps; a reference that resolves to nothing fails the run at that use step.
 */
async function automationsOf(
  tx: Tx,
  tenantId: string,
  workflow: Workflow,
): Promise<Record<string, AutomationDefinition>> {
  const out: Record<string, AutomationDefinition> = {};
  for (const ref of automationRefs([workflow])) {
    const found = await resolveAutomation(tx, { tenantId, ref });
    if (found) out[ref] = found.definition;
  }
  return out;
}

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
      // v0.12 W1-E: every model call of a run, with its body when storage is there.
      modelCalls: dbModelCalls(deps.db, {
        bodies: deps.modelCallBodies ?? null,
        ...(deps.now ? { now: deps.now } : {}),
      }),
      // v0.12 W2-D: Sloan reads and writes the account through the portal's own code.
      account: accountViews(deps.platform),
      // P-7: `comms.translate` on the run's transport (held to the client's HIPAA mode by
      // forClient), docs/plan.md §1.69.
      translation: { transport: deps.transport, ...(deps.now ? { now: deps.now } : {}) },
      // §1.77: web research on the same transport, when the deployment has it on.
      ...(deps.webResearch ? { webResearch: { transport: deps.transport } } : {}),
    }),
    tools: deps.platform.tools,
    catalog: deps.platform.catalog,
    transport: deps.transport,
    // P-1: pack tools reach the client's data through the run's database (packs.ts).
    packServices: {
      db,
      transport: deps.transport,
      // P-5: document storage, for a document a pack tool makes (a purchase order PDF).
      ...(deps.documents ? { content: deps.documents.content } : {}),
    },
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
      // P-3: 5-minute links for the files Twilio and Meta fetch (docs/plan.md §1.65).
      deps.documents?.signer ?? null,
    ),
  };
}

/** The client's stored documents, for tools that send one to the client's tool (QBO attachments). */
function withDocuments(
  base: NonNullable<RuntimeDeps["services"]>,
  db: Db,
  content: ContentStore | undefined,
  signer: UrlSigner | null = null,
): NonNullable<RuntimeDeps["services"]> {
  // v0.12 W1-F: what QuickBooks sync stored (duplicate bills, receivable ids), for the qbo tools.
  if (!content) return (conn) => ({ ...base(conn), records: dbSyncedRecords(db, conn) });
  return (conn) => ({
    ...base(conn),
    documents: dbDocumentServices(db, conn, content, signer),
    records: dbSyncedRecords(db, conn),
  });
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
    ...(params.retryOf ? { retryOf: params.retryOf } : {}),
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
      // v0.12 W1-E: a run cancelled before its instance began (queued) never starts.
      const [state] = await tx.select({ status: run.status }).from(run).where(eq(run.id, info.id));
      if (state?.status === "cancelled") return { ok: false, reason: "cancelled", cancelled: true };
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
      return {
        ok: true,
        workflow: wf.workflow,
        language: await tenantLocale(tx, info.tenantId),
        resume: await resumeOf(tx, params, wf.workflow),
        // v0.12 W2-B
        automations: await automationsOf(tx, info.tenantId, wf.workflow),
        // v0.13 W2-I
        ...(v?.bundle.definition.oversight ? { oversight: v.bundle.definition.oversight } : {}),
      };
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
            : {
                error: {
                  reason: result.reason ?? null,
                  nodeId: result.nodeId ?? null,
                  // v0.12 W1-E: what failed runs are grouped by (docs/plan.md §1.40).
                  ...(result.status === "failed"
                    ? {
                        key: result.errorKey ?? runErrorKey({ kind: "run" }, result.reason ?? null),
                      }
                    : {}),
                },
              }),
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
                // v0.13 W2-I: the agent's diagnosis, when it reviewed the failure.
                ...(result.diagnosis ? { diagnosis: result.diagnosis.slice(0, 2000) } : {}),
              },
            },
            { registry: deps.platform.events, testRun: info.mode === "test" },
          );
          if (row) emitted.push(row);
        }
        // v0.12 W2-E: `run.succeeded`, with what the workflow hands off, in the same transaction
        // (docs/plan.md §1.48). Live runs only: a test run starts nothing (ARCHITECTURE §10.4).
        if (result.status === "succeeded" && info.mode === "live" && loaded.ok) {
          const row = await emit(
            tx,
            {
              tenantId: info.tenantId,
              type: RUN_SUCCEEDED_EVENT,
              subjectType: "run",
              subjectId: info.id,
              payload: await runSucceededPayload(tx, params, loaded.workflow),
            },
            { registry: deps.platform.events },
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

  if (!loaded.ok && loaded.cancelled) return { status: "cancelled", reason: "cancelled" };
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
      // P-4: conversations (docs/plan.md §1.66)
      conversePort({ db, runtime, ...(deps.instances ? { instances: deps.instances } : {}) }),
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
    ...(loaded.resume ? { resume: loaded.resume } : {}),
    // v0.12 W2-B
    ...(loaded.automations ? { automations: loaded.automations } : {}),
    // v0.13 W2-I: run oversight; the executor asks only for steps whose failures are reviewed.
    oversight: {
      port: oversightPort(runtime, db, info, loaded.oversight),
      settings: loaded.oversight,
    },
  };

  let result: RunResult;
  try {
    // v0.12 W1-H: each step's events are dispatched right after it (ARCHITECTURE §8).
    const stepRunner = dispatchingRunner(
      runner,
      deps.instances ? { db, instances: deps.instances } : null,
      emitted,
    );
    result = await executeWorkflow(stepRunner, ctx, loaded.workflow, params.payload);
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

// ── v0.12 W2-E: what a successful run hands off (ARCHITECTURE §10.8; docs/plan.md §1.48) ───────

/**
 * `run.succeeded`'s payload: the workflow's `handoff.output` and `sources` evaluated over the run's
 * trigger and its top-level steps' outputs (≤ 16 KB, else left out), and the depth: the run's own
 * handoff depth + 1.
 */
async function runSucceededPayload(
  tx: Tx,
  params: RunParams,
  workflow: Workflow,
): Promise<RunSucceededPayload> {
  const [a] = await tx
    .select({ slug: agent.slug })
    .from(agent)
    .where(and(eq(agent.id, params.agentId), eq(agent.tenantId, params.tenantId)));
  const depth = (params.trigger.type === "handoff" ? params.trigger.depth : 0) + 1;
  let output: unknown = null;
  let outputTooLarge = false;
  let sources: string[] = [];
  const handoff = workflow.handoff;
  if (handoff) {
    const ids = workflow.steps.map((s) => s.id);
    const rows =
      ids.length === 0
        ? []
        : await tx
            .select({ nodeId: stepRun.nodeId, output: stepRun.output, status: stepRun.status })
            .from(stepRun)
            .where(
              and(
                eq(stepRun.runId, params.runId),
                eq(stepRun.tenantId, params.tenantId),
                inArray(stepRun.nodeId, ids),
              ),
            );
    const steps: Record<string, { output: unknown }> = {};
    for (const r of rows) {
      if (r.status === "succeeded" || r.status === "skipped") {
        steps[r.nodeId] = { output: r.output ?? null };
      }
    }
    const context = { trigger: params.payload, steps };
    try {
      output = resolveTemplate(handoff.output, context) ?? null;
    } catch (error) {
      console.warn(`handoff output of run ${params.runId} could not be evaluated`, String(error));
      output = null;
    }
    if (
      new TextEncoder().encode(JSON.stringify(output) ?? "null").length > HANDOFF_OUTPUT_MAX_BYTES
    ) {
      output = null;
      outputTooLarge = true;
    }
    if (handoff.sources !== undefined) {
      let resolved: unknown;
      try {
        resolved = resolveTemplate(handoff.sources, context);
      } catch {
        resolved = [];
      }
      const flat = (Array.isArray(resolved) ? resolved : [resolved]).flat(2);
      sources = [...new Set(flat.filter((v): v is string => typeof v === "string" && isUuid(v)))];
      sources = sources.slice(0, HANDOFF_SOURCES_MAX);
    }
  }
  return {
    runId: params.runId,
    agentId: params.agentId,
    agentSlug: a?.slug ?? "",
    agentVersionId: params.agentVersionId,
    workflowSlug: params.workflowSlug,
    output,
    ...(outputTooLarge ? { outputTooLarge } : {}),
    sources,
    depth,
  };
}

// ── v0.12 W1-E: retry from the failed step (ARCHITECTURE §10.10; docs/plan.md §1.40) ──────────

/**
 * What a retry reuses: the run retried's rows of the top-level steps before `resumeFrom` that
 * succeeded (or were skipped), with their outputs. Read once, inside the run's load step, so a
 * replay of the instance reuses the same outputs.
 */
async function resumeOf(tx: Tx, params: RunParams, workflow: Workflow): Promise<RunResume | null> {
  if (!params.retryOf || !params.resumeFrom) return null;
  const index = workflow.steps.findIndex((s) => s.id === params.resumeFrom);
  if (index <= 0) return null;
  const before = workflow.steps.slice(0, index).map((s) => s.id);
  const rows = await tx
    .select({ nodeId: stepRun.nodeId, status: stepRun.status, output: stepRun.output })
    .from(stepRun)
    .where(
      and(
        eq(stepRun.runId, params.retryOf),
        eq(stepRun.tenantId, params.tenantId),
        inArray(stepRun.nodeId, before),
      ),
    );
  const reused: RunResume["reused"] = {};
  for (const r of rows) {
    if (r.status === "succeeded" || r.status === "skipped") {
      reused[r.nodeId] = { status: r.status, output: r.output ?? null };
    }
  }
  return { from: params.resumeFrom, of: shortRunId(params.retryOf), reused };
}
