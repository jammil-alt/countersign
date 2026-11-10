// Scripted site tools (docs/plan.md §1.86 "Scripts (wave 4)"; ARCHITECTURE v0.16 §10.14 "Browser
// connectors"): a client's recorded scripts, read for the browser connector's script tools (the
// published version only, inside the connection's client), shown to the back office and the
// portal, recorded one action at a time in our browser and tested as dry runs.
//
// Recording: each action runs in one browser session our code signs in to (packages/connectors'
// withBrowserSession: the vault's login, sign-in by code on the pinned origins, every page checked
// against the site's allowed pages, sign-out and the session's record), so whoever records never
// sees or types the client's login (invariant 13). The steps recorded so far are replayed first, as
// a dry run, then the new action is done and kept as a step with its screenshot. A submit is never
// clicked by a recording or a test: nothing reaches the client's tool outside external_action
// (invariant 8).

import {
  BROWSER_CONNECTOR_ID,
  BrowserRefused,
  BrowserStop,
  type ConnectionRef,
  ContentStore,
  credentialKeysFromEnv,
  noopLogger,
  runScriptSteps,
  type ScriptRun,
  ScriptStepMissing,
  type SignedInPage,
  SignInFailed,
  scriptNeedsHelp,
  scriptResult,
  type ToolContext,
  withBrowserSession,
} from "@countersign/connectors";
import {
  BrowserConnectionConfig,
  BrowserScriptDefinition,
  type BrowserScriptTool,
  type BrowserScriptView,
  canonicalJson,
  checkBrowserUrl,
  fillScriptUrl,
  type JsonObject,
  type RecorderAction,
  type RecorderPage,
  recordedStep,
  recordingDefinition,
  recordingExamples,
  type ScriptLogin,
  ScriptRecording,
  type ScriptStep,
  scriptInputSchema,
  scriptProblems,
  signInDecision,
} from "@countersign/core";
import { browserScript, browserScriptVersion, connection, type Tx, tenant } from "@countersign/db";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { z } from "zod";
import { codesFor } from "../codes/client";
import { HttpError, notFound, type Services } from "../http";
import { credentialsFor } from "../runs/execute";
import { signerFor } from "../storage";
import { browserRunOpener } from "./driver";
import { type BrowserDeps, dbBrowserServices } from "./services";
import { catalogueForClient, pinnedSite } from "./sites";

type ScriptRow = typeof browserScript.$inferSelect;
type VersionRow = typeof browserScriptVersion.$inferSelect;
type ConnectionRow = typeof connection.$inferSelect;
export type ScriptSide = "operator" | "client";

/** The most steps a recording holds (the definition's own limit). */
const MAX_STEPS = 50;
/** How much of a page's text the recorder shows. */
const PAGE_TEXT = 4_000;

// ── Views ────────────────────────────────────────────────────────────────────────────────────────

function recordingOf(row: Pick<ScriptRow, "recording">): ScriptRecording {
  const parsed = ScriptRecording.safeParse(row.recording);
  return parsed.success ? parsed.data : ScriptRecording.parse({});
}

/** What stops a recording from being saved as it is. */
function problemsOf(row: ScriptRow, recording: ScriptRecording): string[] {
  if (recording.steps.length === 0) return ["nothing is recorded yet"];
  const parsed = BrowserScriptDefinition.safeParse(
    recordingDefinition(row.site, row.name, recording),
  );
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join(".") || "script"}: ${i.message}`);
  }
  return scriptProblems(parsed.data);
}

/** The scripts' views, newest first, with their clients' and sites' names. */
export async function scriptViews(tx: Tx, rows: ScriptRow[]): Promise<BrowserScriptView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const versions = await tx
    .select({
      scriptId: browserScriptVersion.scriptId,
      version: browserScriptVersion.version,
      definition: browserScriptVersion.definition,
      recordedSide: browserScriptVersion.recordedSide,
      createdAt: browserScriptVersion.createdAt,
    })
    .from(browserScriptVersion)
    .where(inArray(browserScriptVersion.scriptId, ids))
    .orderBy(asc(browserScriptVersion.version));
  const clients = await tx
    .select({ id: tenant.id, name: tenant.name })
    .from(tenant)
    .where(
      inArray(
        tenant.id,
        rows.map((r) => r.tenantId),
      ),
    );
  const names = await siteNames(
    tx,
    rows.map((r) => r.site),
  );
  return rows.map((row) => {
    const recording = recordingOf(row);
    const own = versions.filter((v) => v.scriptId === row.id);
    const newest = own.at(-1)?.version ?? null;
    const state =
      newest === null
        ? "recording"
        : row.publishedVersion !== null && row.publishedVersion === newest
          ? "published"
          : "draft";
    return {
      id: row.id,
      clientId: row.tenantId,
      clientName: clients.find((c) => c.id === row.tenantId)?.name ?? "",
      connectionId: row.connectionId,
      site: row.site,
      siteName: names.get(row.site) ?? row.site,
      slug: row.slug,
      name: row.name,
      state,
      createdSide: row.createdSide,
      recording,
      problems: problemsOf(row, recording),
      versions: own.map((v) => ({
        version: v.version,
        sideEffect:
          (v.definition as { sideEffect?: string }).sideEffect === "external" ? "external" : "none",
        recordedSide: v.recordedSide,
        createdAt: v.createdAt.toISOString(),
      })),
      published:
        row.publishedVersion !== null && row.publishedAt
          ? { version: row.publishedVersion, publishedAt: row.publishedAt.toISOString() }
          : null,
      offerItemId: row.offerItemId,
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

/** The catalogue's names for these sites (a client transaction reads the operator's catalogue). */
async function siteNames(tx: Tx, slugs: string[]): Promise<Map<string, string>> {
  const entries = await catalogueForClient(tx, [...new Set(slugs)]);
  return new Map(entries.map((e) => [e.site.slug, e.site.name]));
}

/** The scripts in scope (RLS holds the request to its clients), and the logins to record on. */
export async function scriptList(
  tx: Tx,
  tenantIds: readonly string[],
): Promise<{ scripts: BrowserScriptView[]; logins: z.input<typeof ScriptLogin>[] }> {
  const rows = await tx
    .select()
    .from(browserScript)
    .where(inArray(browserScript.tenantId, [...tenantIds]))
    .orderBy(desc(browserScript.updatedAt));
  const conns = await tx
    .select({ id: connection.id, tenantId: connection.tenantId, config: connection.config })
    .from(connection)
    .where(
      and(
        inArray(connection.tenantId, [...tenantIds]),
        eq(connection.connector, BROWSER_CONNECTOR_ID),
      ),
    );
  const configs = conns.flatMap((c) => {
    const config = BrowserConnectionConfig.safeParse(c.config);
    return config.success ? [{ ...c, config: config.data }] : [];
  });
  const sites = await catalogueForClient(
    tx,
    configs.map((c) => c.config.site),
  );
  const clients = await tx
    .select({ id: tenant.id, name: tenant.name })
    .from(tenant)
    .where(inArray(tenant.id, [...tenantIds]));
  const logins = configs.flatMap((c) => {
    const site = sites.find((s) => s.site.slug === c.config.site);
    // A login agents can't sign in to on their own (blocked, a person signs in) records nothing.
    if (!site || !signInDecision(site.site.tier, c.config.stricter).ok) return [];
    return [
      {
        clientId: c.tenantId,
        clientName: clients.find((t) => t.id === c.tenantId)?.name ?? "",
        connectionId: c.id,
        site: site.site.slug,
        siteName: site.site.name,
        tier: site.site.tier,
      },
    ];
  });
  return { scripts: await scriptViews(tx, rows), logins };
}

/** A client's published scripts as the browser connector's tools (the builder, the Library). */
export async function scriptTools(tx: Tx, tenantId: string): Promise<BrowserScriptTool[]> {
  const rows = await tx
    .select({ script: browserScript, version: browserScriptVersion })
    .from(browserScript)
    .innerJoin(
      browserScriptVersion,
      and(
        eq(browserScriptVersion.scriptId, browserScript.id),
        eq(browserScriptVersion.version, browserScript.publishedVersion),
      ),
    )
    .where(and(eq(browserScript.tenantId, tenantId), isNotNull(browserScript.publishedVersion)))
    .orderBy(asc(browserScript.site), asc(browserScript.name));
  const names = await siteNames(
    tx,
    rows.map((r) => r.script.site),
  );
  return rows.flatMap(({ script, version }) => {
    const def = BrowserScriptDefinition.safeParse(version.definition);
    if (!def.success) return [];
    return [
      {
        tool: def.data.sideEffect === "external" ? "browser.script.submit" : "browser.script.read",
        connector: "browser",
        site: script.site,
        siteName: names.get(script.site) ?? script.site,
        script: script.slug,
        name: def.data.name,
        description: def.data.description,
        sideEffect: def.data.sideEffect,
        version: version.version,
        inputs: def.data.inputs,
        outputs: def.data.outputs,
      } satisfies BrowserScriptTool,
    ];
  });
}

/** One script in the request's scope, or 404 (another client's is never found: RLS and the id). */
export async function scriptRow(
  tx: Tx,
  tenantIds: readonly string[],
  id: string,
): Promise<ScriptRow> {
  const [row] = await tx
    .select()
    .from(browserScript)
    .where(and(eq(browserScript.id, id), inArray(browserScript.tenantId, [...tenantIds])));
  if (!row) throw notFound("script");
  return row;
}

export async function oneView(tx: Tx, row: ScriptRow): Promise<{ script: BrowserScriptView }> {
  const [fresh] = await tx
    .select()
    .from(browserScript)
    .where(and(eq(browserScript.id, row.id), eq(browserScript.tenantId, row.tenantId)));
  const [view] = await scriptViews(tx, [fresh ?? row]);
  if (!view) throw notFound("script");
  return { script: view };
}

// ── The browser, for a recording or a test ────────────────────────────────────────────────────────

/** Browser Run (or a test's browser), the code service and storage for this deployment. */
function browserDeps(services: Services): BrowserDeps {
  const env = services.env;
  const open = services.deps.browserOpener
    ? services.deps.browserOpener(env)
    : browserRunOpener(env);
  return {
    ...(open ? { open } : {}),
    codes: codesFor(env),
    content: new ContentStore(services.deps.objects(env)),
  };
}

async function loginRow(tx: Tx, row: ScriptRow): Promise<ConnectionRow> {
  const [conn] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.id, row.connectionId), eq(connection.tenantId, row.tenantId)));
  if (!conn || conn.connector !== BROWSER_CONNECTOR_ID) throw notFound("website login");
  return conn;
}

/** The connector's context for one client's browser login: the vault's login, for one session. */
function loginContext(services: Services, conn: ConnectionRow): ToolContext {
  if (!services.env.ENCRYPTION_KEY) {
    throw new HttpError(503, "not_configured", "website logins aren't available here yet");
  }
  const ref: ConnectionRef = {
    id: conn.id,
    tenantId: conn.tenantId,
    connector: conn.connector,
    status: conn.status,
    externalAccountId: conn.externalAccountId,
    config: conn.config as JsonObject,
    permissions: conn.permissions,
  };
  return {
    tenantId: conn.tenantId,
    connection: ref,
    credentials: credentialsFor(services.db, credentialKeysFromEnv(services.env))(ref),
    logger: noopLogger,
    now: () => new Date(),
    services: { browser: dbBrowserServices(services.db, ref, browserDeps(services)) },
  };
}

const SESSION = { codePoll: { intervalMs: 2_000, attempts: 45 } };

/** A browser failure as the recorder and the test answer it: plain words, never a secret. */
function browserFailure(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof ScriptStepMissing) {
    throw new HttpError(422, "not_found", `${error.what} isn't on ${error.url}`);
  }
  if (error instanceof BrowserStop) throw new HttpError(409, "stopped", error.message);
  if (error instanceof SignInFailed) throw new HttpError(422, "sign_in_failed", error.message);
  if (error instanceof BrowserRefused) throw new HttpError(422, "refused", error.message);
  throw error;
}

/** A 5-minute link to an evidence screenshot; null when it can't be signed here. */
async function shotUrl(services: Services, origin: string, key: string | null) {
  if (!key) return null;
  try {
    return await signerFor(services.env, origin, () => "screenshot.png").signedGetUrl(key);
  } catch {
    return null;
  }
}

/** The pinned site's own address, for a recorded path (`/orders/new`). */
async function siteOrigin(services: Services, conn: ConnectionRow): Promise<string> {
  const config = BrowserConnectionConfig.safeParse(conn.config);
  if (!config.success) throw new HttpError(409, "invalid_state", "this login is not set up");
  const site = await pinnedSite(services.db, {
    slug: config.data.site,
    versionId: config.data.siteVersionId,
  });
  if (!site) throw new HttpError(409, "invalid_state", "this site is no longer in our catalogue");
  const decision = signInDecision(site.tier, config.data.stricter);
  if (!decision.ok) throw new HttpError(409, "not_allowed", decision.reason);
  return new URL(site.profile.login.url).origin;
}

function nextStepId(steps: readonly ScriptStep[]): string {
  const n = steps.reduce((m, s) => Math.max(m, Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0)), 0);
  return `s${n + 1}`;
}

/**
 * Records one action: replays the recording (a dry run), does the action, and keeps it as a step
 * with its screenshot. A typed value marked as an input becomes one (its example); a read marked
 * as an output becomes one. Nothing after a submit is recorded: it was never clicked.
 */
// DECISION: one action per request, each in a session our code signs in to, replaying the steps so
// far as a dry run: a Worker keeps no browser between requests (no Durable Object; Browser Run's
// reconnect is unchecked). Each action spends a sign-in within the caps; a kept low-tier session none.
export async function recordAction(
  services: Services,
  tx: Tx,
  row: ScriptRow,
  action: RecorderAction,
  origin: string,
) {
  const recording = recordingOf(row);
  if (recording.steps.some((s) => s.op === "click" && s.submits)) {
    throw new HttpError(
      409,
      "after_submit",
      "the submit is the script's last step: it is never clicked while recording",
    );
  }
  if (recording.steps.length >= MAX_STEPS) {
    throw new HttpError(409, "too_long", `a script has at most ${MAX_STEPS} steps`);
  }
  const conn = await loginRow(tx, row);
  const made = recordedStep(action, nextStepId(recording.steps), await siteOrigin(services, conn));
  const taken = (name: string) =>
    recording.inputs.some((i) => i.name === name) || recording.outputs.some((o) => o.name === name);
  const named = made.input?.name ?? made.output?.name;
  if (named && taken(named)) {
    throw new HttpError(409, "name_taken", `${named} is already an input or an output`);
  }
  const inputs = made.input ? [...recording.inputs, made.input] : recording.inputs;
  const outputs = made.output ? [...recording.outputs, made.output] : recording.outputs;
  const values = recordingExamples({ inputs });
  const ctx = loginContext(services, conn);
  let ran: { run: ScriptRun; page: Omit<RecorderPage, "screenshotUrl"> };
  try {
    ran = await withBrowserSession(
      ctx,
      { tool: "browser.script.record", site: row.site },
      SESSION,
      async (page) => {
        // The steps so far, as a dry run, to reach where the recording left off.
        await runScriptSteps(page, recording.steps, values, outputs, { dryRun: true });
        const run = await runScriptSteps(page, [made.step], values, outputs, {
          dryRun: true,
          everyStep: true,
        });
        return { run, page: await pageNow(page) };
      },
    );
  } catch (error) {
    browserFailure(error);
  }
  const done = ran.run.steps[0];
  const next: ScriptRecording = {
    ...recording,
    inputs,
    outputs,
    steps: [...recording.steps, made.step],
    evidence: {
      ...recording.evidence,
      [made.step.id]: { screenshot: done?.screenshot ?? null, url: done?.url ?? ran.page.url },
    },
  };
  await tx
    .update(browserScript)
    .set({ recording: next })
    .where(and(eq(browserScript.id, row.id), eq(browserScript.tenantId, row.tenantId)));
  return {
    ...(await oneView(tx, row)),
    step: made.step,
    ...(done?.value !== undefined ? { value: done.value } : {}),
    page: { ...ran.page, screenshotUrl: await shotUrl(services, origin, done?.screenshot ?? null) },
  };
}

/** The page as the recorder shows it: some text, its first tables, what may be used. */
async function pageNow(page: SignedInPage): Promise<Omit<RecorderPage, "screenshotUrl">> {
  const text = await page.readText();
  const tables = (await page.readTables())
    .slice(0, 3)
    .map((t) => ({ headers: t.headers, rows: t.rows.slice(0, 20) }));
  return {
    url: page.url(),
    text: text.slice(0, PAGE_TEXT),
    tables,
    controls: await page.controls(),
  };
}

/**
 * Checks a recording's addresses against the site's pages, each filled with the inputs' examples:
 * a page agents may not open is never saved.
 */
async function offSitePages(
  services: Services,
  conn: ConnectionRow,
  recording: ScriptRecording,
): Promise<string[]> {
  const config = BrowserConnectionConfig.parse(conn.config);
  const site = await pinnedSite(services.db, {
    slug: config.site,
    versionId: config.siteVersionId,
  });
  if (!site) return ["this site is no longer in our catalogue"];
  const values = recordingExamples(recording);
  const problems: string[] = [];
  for (const s of recording.steps) {
    if (s.op !== "open" && s.op !== "download") continue;
    const check = checkBrowserUrl(fillScriptUrl(s.url, values), site.profile);
    if (!check.ok) problems.push(`step ${s.id} opens ${s.url}: ${check.reason}`);
  }
  return problems;
}

/** Saves the recording as the next version: immutable, a draft until the operator publishes it. */
export async function saveVersion(
  services: Services,
  tx: Tx,
  row: ScriptRow,
  by: { userId: string; side: ScriptSide },
) {
  const recording = recordingOf(row);
  const problems = problemsOf(row, recording);
  const conn = await loginRow(tx, row);
  problems.push(...(await offSitePages(services, conn, recording)));
  if (problems.length > 0) {
    throw new HttpError(422, "invalid_script", problems.join("; "));
  }
  const definition = BrowserScriptDefinition.parse(
    recordingDefinition(row.site, row.name, recording),
  );
  const [last] = await tx
    .select()
    .from(browserScriptVersion)
    .where(
      and(
        eq(browserScriptVersion.scriptId, row.id),
        eq(browserScriptVersion.tenantId, row.tenantId),
      ),
    )
    .orderBy(desc(browserScriptVersion.version))
    .limit(1);
  if (last && canonicalJson(last.definition) === canonicalJson(definition)) {
    throw new HttpError(409, "no_op", "nothing changed since the last version");
  }
  const evidence = Object.fromEntries(
    definition.steps.flatMap((s) => {
      const shot = recording.evidence[s.id]?.screenshot;
      return shot ? [[s.id, shot]] : [];
    }),
  );
  await tx.insert(browserScriptVersion).values({
    tenantId: row.tenantId,
    scriptId: row.id,
    version: (last?.version ?? 0) + 1,
    definition,
    evidence,
    recordedBy: by.userId,
    recordedSide: by.side,
  });
  await tx
    .update(browserScript)
    .set({ name: row.name })
    .where(and(eq(browserScript.id, row.id), eq(browserScript.tenantId, row.tenantId)));
  return oneView(tx, row);
}

/** A saved version of a script, or 404. */
export async function versionRow(tx: Tx, row: ScriptRow, version: number): Promise<VersionRow> {
  const [found] = await tx
    .select()
    .from(browserScriptVersion)
    .where(
      and(
        eq(browserScriptVersion.scriptId, row.id),
        eq(browserScriptVersion.tenantId, row.tenantId),
        eq(browserScriptVersion.version, version),
      ),
    );
  if (!found) throw notFound("version");
  return found;
}

/** Whether the script's site may still be signed in to by agents (never a blocked one). */
export async function siteAllowsScripts(tx: Tx, row: ScriptRow): Promise<void> {
  const [entry] = await catalogueForClient(tx, [row.site]);
  if (!entry || entry.site.tier === "blocked") {
    throw new HttpError(409, "not_allowed", "agents never sign in to this site");
  }
}

/**
 * Tests a script: its steps run in our browser as a dry run (the submit is never clicked, a file
 * is fetched and not kept), with the inputs given or the examples. Test runs never write.
 */
export async function testScript(
  services: Services,
  tx: Tx,
  row: ScriptRow,
  body: { version?: number | undefined; inputs?: Record<string, unknown> | undefined },
  origin: string,
) {
  const recording = recordingOf(row);
  const parsed =
    body.version !== undefined
      ? BrowserScriptDefinition.safeParse((await versionRow(tx, row, body.version)).definition)
      : BrowserScriptDefinition.safeParse(recordingDefinition(row.site, row.name, recording));
  if (!parsed.success) {
    throw new HttpError(422, "invalid_script", "this script has nothing to test yet");
  }
  const def = parsed.data;
  const inputs = scriptInputSchema(def).safeParse(body.inputs ?? recordingExamples(def));
  if (!inputs.success) {
    throw new HttpError(
      422,
      "invalid_inputs",
      inputs.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  const conn = await loginRow(tx, row);
  await siteOrigin(services, conn);
  const ctx = loginContext(services, conn);
  const steps = async (run: { steps: ScriptRun["steps"] }) =>
    Promise.all(
      run.steps.map(async (s) => ({
        id: s.id,
        op: s.op,
        url: s.url,
        status: s.status,
        screenshotUrl: await shotUrl(services, origin, s.screenshot),
      })),
    );
  try {
    const run = await withBrowserSession(
      ctx,
      { tool: "browser.script.test", site: row.site },
      SESSION,
      (page) =>
        runScriptSteps(page, def.steps, inputs.data as Record<string, unknown>, def.outputs, {
          dryRun: true,
          everyStep: true,
        }),
    );
    let outputs: JsonObject | null = null;
    let reason: string | null = null;
    try {
      // A write's dry run never submits: what it reads is checked as if it had.
      outputs = scriptResult(def, { ...run, submitted: def.sideEffect === "external" });
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    return {
      outcome: reason ? ("refused" as const) : ("done" as const),
      outputs,
      reason,
      steps: await steps(run),
      needsHelp: null,
    };
  } catch (error) {
    if (error instanceof ScriptStepMissing) {
      const help = scriptNeedsHelp(def, error, error.done);
      return {
        outcome: "needs_help" as const,
        outputs: null,
        reason: error.message,
        steps: await steps({ steps: error.done }),
        needsHelp: { question: help.question, tried: help.tried },
      };
    }
    if (error instanceof BrowserRefused) {
      return {
        outcome: "refused" as const,
        outputs: null,
        reason: error.message,
        steps: [],
        needsHelp: null,
      };
    }
    browserFailure(error);
  }
}
