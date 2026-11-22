// docs/plan.md §1.212: the golden datasets' runner. Each case gets a client of its own on a
// throwaway database, its world seeded with fixed ids (so the model's requests, and their recorded
// answers, are the same every run), then a test run of the template's live version of the workflow,
// to its end, on replayed model answers (`LLM_MODE=replay`, fixtures/llm). Its writes are scored
// against the case's (core `scoreWrites`), with the verifier's verdict, its cost and its run time.
//
// The worlds are synthetic: nothing here is, or is made from, a client's records (invariant 14).
//
// Writing replays by hand (no API key here): a model call with nothing recorded is answered with
// the case's own `answers` (each a `finish` input, in call order) and stored marked hand-written:
//   WRITE_EVAL_FIXTURES=1 COUNTERSIGN_REQUIRE_DB=1 pnpm --filter @countersign/api exec vitest run src/evals

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ContentStore,
  createBankfeedConnector,
  createQboConnector,
  createResendConnector,
  generateEncryptionKey,
} from "@countersign/connectors";
import {
  FAKE_PLAID,
  FAKE_QBO_CLIENT,
  FAKE_RESEND_MAIN,
  fakePlaid,
  fakeQbo,
  fakeResend,
} from "@countersign/connectors/testing";
import {
  type AnyAgentBundle,
  type EvalCase,
  type EvalCaseResult,
  EvalDataset,
  type EvalVerifier,
  isPlainObject,
  parseSkillRef,
  type RunWrite,
  resolveRefs,
  runWrites,
  scoreWrites,
  stepIdOf,
} from "@countersign/core";
import { agent, agentVersion, appUser, membership, tenant } from "@countersign/db";
import {
  fakeMessage,
  type LlmRequest,
  type LlmTransport,
  ReplayMissError,
  withRecording,
} from "@countersign/llm";
import { DEFAULT_FIXTURE_DIR, fileFixtureStore } from "@countersign/llm/node";
import { and, eq, isNull } from "drizzle-orm";
import { type ApiHarness, createApiHarness, OPERATOR } from "../api.test-helper";
import { quietNever } from "../quiet-hours.test-helper";
import { credentialsFor } from "../runs/execute";
import { runTemplateTest } from "../testbench/suite";
import { booksAfterEnable, GOLDEN_CHART, seedBooks } from "./world-books.test-helper";
import { seedInvoice } from "./world-invoice.test-helper";

export const EVALS_DIR = resolve(DEFAULT_FIXTURE_DIR, "../evals");
/** The day every golden run happens on, so nothing in it depends on when CI ran. */
export const EVAL_NOW = new Date("2026-11-20T15:00:00Z");
const WRITE = process.env.WRITE_EVAL_FIXTURES === "1";

const ENCRYPTION_KEY = generateEncryptionKey();

/** The QuickBooks sign-in codes the fake takes, one per client (it takes each once). */
const QBO_CODES = Array.from({ length: 1000 }, (_, i) => `golden-code-${i}`);
let qboCodes = 0;
export const nextQboCode = (): string => {
  const code = QBO_CODES[qboCodes++];
  if (!code) throw new Error("out of QuickBooks sign-in codes");
  return code;
};

/** A fixed id for a name in a case's world: a v7-shaped uuid from the case and the name. */
export function worldId(caseId: string, name: string): string {
  const h = createHash("sha256").update(`${caseId}\u0000${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** What a world's seeder is given. */
export interface WorldContext {
  H: ApiHarness;
  tenantId: string;
  /** The client admin's sign-in email (the dev sign-in). */
  admin: string;
  caseId: string;
  /** The world's ids by name; the seeder adds what it makes. */
  ids: Record<string, string>;
  id(name: string): string;
}

export interface World {
  /** The pack the template comes with. */
  pack: string;
  seed(ctx: WorldContext, world: unknown): Promise<void>;
  /** What needs the pack switched on (its own tables' rows made through its actions). */
  afterEnable?(ctx: WorldContext, world: unknown): Promise<void>;
}

/** The worlds, by template slug. */
export const WORLDS: Record<string, World> = {
  "vendor-contracts": { pack: "materials", seed: seedInvoice },
  bookkeeper: { pack: "bookkeeping", seed: seedBooks, afterEnable: booksAfterEnable },
};

/** The datasets in fixtures/evals, each parsed. */
export function loadDatasets(): { file: string; dataset: EvalDataset }[] {
  const out: { file: string; dataset: EvalDataset }[] = [];
  for (const dir of readdirSync(EVALS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of readdirSync(join(EVALS_DIR, dir.name))) {
      if (!f.endsWith(".json")) continue;
      const file = join(EVALS_DIR, dir.name, f);
      out.push({ file, dataset: EvalDataset.parse(JSON.parse(readFileSync(file, "utf8"))) });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** The harness the golden runs need: QuickBooks, the bank feed and Mezonas' email, over fakes. */
export function createEvalHarness(): Promise<ApiHarness | null> {
  const resend = fakeResend();
  // One QuickBooks company (the fake serves one), with the golden chart of accounts.
  const qbo = fakeQbo({ codes: QBO_CODES });
  for (const [Id, Name, AccountType] of GOLDEN_CHART) {
    qbo.put("Account", {
      Id,
      SyncToken: "0",
      Name,
      FullyQualifiedName: Name,
      AccountType,
      Active: true,
    });
  }
  return createApiHarness({
    connectors: () => [
      createQboConnector({
        ...FAKE_QBO_CLIENT,
        environment: "sandbox",
        webhookVerifier: "qbo-verifier",
        fetch: qbo.fetch,
        sleep: async () => {},
      }),
      createBankfeedConnector({ ...FAKE_PLAID, fetch: fakePlaid().fetch }),
      createResendConnector({ fetch: resend.fetch }),
    ],
    env: {
      ENCRYPTION_KEY,
      OAUTH_STATE_SECRET: "golden-state-secret-".repeat(3),
      APP_ORIGIN: "https://app.mezonas.test",
      QBO_WEBHOOK_VERIFIER: "qbo-verifier",
      RESEND_API_KEY: FAKE_RESEND_MAIN.apiKey,
      RESEND_FALLBACK_DOMAIN: "mail.mezonas.test",
      EMAIL_FORWARDING_DOMAIN: "in.mezonas.test",
    },
    fetch: resend.fetch,
  });
}

/** A client of the case's own: its admin and the operator serving it. */
async function newClient(H: ApiHarness, c: EvalCase): Promise<{ tenantId: string; admin: string }> {
  const [t] = await H.t.db
    .insert(tenant)
    .values({ name: `Golden ${c.id}`, settings: { approvals: { undoSeconds: 0 } } })
    .returning();
  if (!t) throw new Error("no tenant");
  const [op] = await H.t.db.select().from(appUser).where(eq(appUser.email, OPERATOR));
  const [admin] = await H.t.db
    .insert(appUser)
    .values({ email: `admin+${t.id}@golden.example.com`, name: "Golden admin" })
    .returning();
  if (!op || !admin) throw new Error("no users");
  await H.t.db.insert(membership).values([
    { tenantId: t.id, userId: op.id, role: "operator" },
    { tenantId: t.id, userId: admin.id, role: "client_admin" },
  ]);
  return { tenantId: t.id, admin: admin.email };
}

/** Every write step's tool (or a v3 action step's), by step id, read from the bundle. */
function writeTools(bundle: AnyAgentBundle): Map<string, string> {
  const tools = new Map<string, string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!isPlainObject(v)) return;
    if (typeof v.id === "string" && (v.kind === "write" || v.kind === "action")) {
      const tool =
        typeof v.tool === "string" ? v.tool : typeof v.action === "string" ? v.action : null;
      if (tool) tools.set(v.id, tool);
    }
    for (const x of Object.values(v)) walk(x);
  };
  walk(bundle.workflows);
  return tools;
}

/** The case's skill parameters set on the bundle's skill refs, as a client agent sets them. */
function withParameters(c: EvalCase, ids: Record<string, string>) {
  return (bundle: AnyAgentBundle): AnyAgentBundle => {
    if (Object.keys(c.parameters).length === 0) return bundle;
    const parameters = resolveRefs(c.parameters, ids);
    return {
      ...bundle,
      definition: {
        ...bundle.definition,
        skills: bundle.definition.skills.map((ref) => {
          const own = parameters[parseSkillRef(ref.skill).id];
          return own ? { ...ref, parameters: { ...(ref.parameters ?? {}), ...own } } : ref;
        }),
      },
    } as AnyAgentBundle;
  };
}

/**
 * Replays fixtures/llm. Writing (WRITE_EVAL_FIXTURES=1), a miss is answered with the case's next
 * answer as the skill's `finish`, stored marked hand-written. Its tokens are counted from the
 * request and the answer (4 characters a token) so a case's cost is what a real call would about
 * cost, the same every run.
 */
function transportFor(answers: readonly unknown[]): LlmTransport {
  const store = fileFixtureStore();
  const replay = withRecording(null, { mode: "replay", store });
  let next = 0;
  const writer = withRecording(
    {
      async create(request: LlmRequest) {
        const answer = answers[next++];
        if (answer === undefined) {
          const asked = JSON.stringify(request.messages.at(-1)?.content ?? null).slice(0, 6000);
          throw new Error(
            `the case has no more answers for the model; add one to its \`answers\`. Asked: ${asked}`,
          );
        }
        return fakeMessage(
          request.model,
          [
            {
              type: "tool_use",
              id: `toolu_golden_${next}`,
              name: "finish",
              input: answer,
              caller: { type: "direct" },
            } as never,
          ],
          "tool_use",
          {
            input: Math.ceil(JSON.stringify(request).length / 4),
            output: Math.ceil(JSON.stringify(answer).length / 4) + 20,
          },
        );
      },
    },
    {
      mode: "record",
      store: {
        read: store.read,
        write: (call) => store.write({ ...call, handWritten: true } as typeof call),
      },
    },
  );
  // Writing, every call is answered from the case (and written over what was stored), so an
  // answer changed in the dataset never meets the old one.
  if (WRITE) return writer;
  return {
    async create(request, options) {
      try {
        return await replay.create(request, options);
      } catch (error) {
        if (error instanceof ReplayMissError) {
          throw new Error(
            `${error.message} A golden case's answers are written by hand: WRITE_EVAL_FIXTURES=1 (fixtures/llm/README.md).`,
          );
        }
        throw error;
      }
    },
  };
}

export interface GoldenResult extends EvalCaseResult {
  writes: RunWrite[];
  /** Each step's id and status (a failed one's output), for reading a failure. */
  steps: { id: string; status: string; why?: string }[];
}

export interface GoldenOptions {
  verify?: EvalVerifier;
}

/** The template's live version (installed with its pack on the first client). */
async function liveVersion(H: ApiHarness, slug: string): Promise<string> {
  const [tpl] = await H.t.db
    .select({ live: agent.liveVersionId })
    .from(agent)
    .where(and(isNull(agent.tenantId), eq(agent.slug, slug), eq(agent.kind, "template")));
  if (!tpl?.live) throw new Error(`template ${slug} has no live version`);
  return tpl.live;
}

/** One golden case, start to end: its client, its world, its run, its score. */
export async function runGoldenCase(
  H: ApiHarness,
  dataset: EvalDataset,
  c: EvalCase,
  options: GoldenOptions = {},
): Promise<GoldenResult> {
  const world = WORLDS[dataset.template];
  if (!world) throw new Error(`no world for template ${dataset.template}`);
  const { tenantId, admin } = await newClient(H, c);
  const ids: Record<string, string> = {};
  const ctx: WorldContext = {
    H,
    tenantId,
    admin,
    caseId: c.id,
    ids,
    id: (name) => {
      ids[name] ??= worldId(c.id, name);
      return ids[name] as string;
    },
  };
  const base = {
    caseId: c.id,
    exact: false,
    verifier: null,
    costUsd: "0",
    ms: 0,
    writes: [] as RunWrite[],
    steps: [] as GoldenResult["steps"],
  };
  try {
    // Connections and the chart first: switching a pack on validates its template against them.
    await world.seed(ctx, c.world);
    const on = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${tenantId}/packs/${world.pack}/enable`,
    );
    if (on.status !== 200) throw new Error(`enable ${world.pack}: ${JSON.stringify(on.json)}`);
    if (world.afterEnable) await world.afterEnable(ctx, c.world);
    const versionId = await liveVersion(H, dataset.template);
    const ran = await runTemplateTest(
      {
        db: H.db,
        platform: H.platform,
        transport: transportFor(resolveRefs(c.answers, ids)),
        instances: H.instances,
        documents: { content: new ContentStore(H.objects) },
        credentials: credentialsFor(H.db, { current: ENCRYPTION_KEY }),
        now: () => EVAL_NOW,
      },
      {
        runTenantId: tenantId,
        versionId,
        actorId: null,
        workflow: dataset.workflow,
        payload: resolveRefs(c.trigger, ids),
        ...(Object.keys(c.parameters).length > 0 ? { adjust: withParameters(c, ids) } : {}),
      },
    );
    const [row] = await H.t.db
      .select({ bundle: agentVersion.bundle })
      .from(agentVersion)
      .where(eq(agentVersion.id, versionId));
    const bundle = row?.bundle as AnyAgentBundle;
    const tools = writeTools(bundle);
    const writes = runWrites(ran.steps, (step) => tools.get(step) ?? null);
    // A failed step's output says why, for reading a failure.
    const steps = ran.steps.map((s) => ({
      id: s.nodeId,
      status: s.status,
      ...(s.status === "failed" ? { why: JSON.stringify(s.output ?? null).slice(0, 500) } : {}),
    }));
    // As the bench: a wait for a person times out at once (`benchRunner`), and the run is scored
    // as it stands; any other failure is an error.
    const benchTimeout = /^[a-z_]+:timeout$/.test(ran.result.errorKey ?? "");
    const failed = ran.result.status === "failed" && !benchTimeout;
    const stoppedAt = failed ? stepIdOf(ran.result.nodeId ?? "") : null;
    const stoppedRight =
      !!c.stops && stoppedAt === c.stops.step && (ran.result.reason ?? "").includes(c.stops.error);
    if (c.stops && !stoppedRight) {
      return {
        ...base,
        status: "fail",
        costUsd: ran.costUsd,
        ms: ran.ms,
        writes,
        steps,
        error: `expected the run to stop at ${c.stops.step} (${c.stops.error}); it ${failed ? `stopped at ${ran.result.nodeId}: ${ran.result.reason}` : `ended ${ran.result.status}`}`,
      };
    }
    if (failed && !stoppedRight) {
      return {
        ...base,
        status: "error",
        costUsd: ran.costUsd,
        ms: ran.ms,
        writes,
        steps,
        error: `the run failed at ${ran.result.nodeId ?? "?"}: ${ran.result.reason ?? ""}`,
      };
    }
    const score = scoreWrites(resolveRefs(c.writes, ids), writes, c.tolerances);
    const verdict = options.verify
      ? await options.verify({ caseId: c.id, workflow: dataset.workflow, writes })
      : null;
    return {
      ...base,
      status: score.exact ? "pass" : "fail",
      exact: score.exact,
      verifier: verdict ? verdict.agree : null,
      costUsd: ran.costUsd,
      ms: ran.ms,
      score,
      writes,
      steps,
    };
  } catch (error) {
    return {
      ...base,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Mezonas' email for the client: the account's email channel, sending at any hour. */
export async function setUpEmail(ctx: WorldContext): Promise<void> {
  const base = `/api/ops/clients/${ctx.tenantId}`;
  const quiet = await ctx.H.call(OPERATOR, "PUT", `${base}/messaging`, {
    quietHours: quietNever(EVAL_NOW),
  });
  if (quiet.status !== 200) throw new Error(`messaging: ${JSON.stringify(quiet.json)}`);
  const made = await ctx.H.call(OPERATOR, "POST", `${base}/email`, {
    domain: "golden-millwork.example",
    localPart: "orders",
  });
  if (made.status !== 200) throw new Error(`email: ${JSON.stringify(made.json)}`);
}

/** A contact in the client's directory who agreed to email (an AP or pricing mailbox). */
export async function addContact(ctx: WorldContext, name: string, email: string): Promise<void> {
  const r = await ctx.H.call(ctx.admin, "POST", "/api/contacts", {
    name,
    email,
    consent: { channels: ["email"], source: "the client's own mailbox" },
  });
  if (r.status !== 200) throw new Error(`contact: ${JSON.stringify(r.json)}`);
}
