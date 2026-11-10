// Scripted site tools (docs/plan.md §1.86 "Scripts (wave 4)"; ARCHITECTURE v0.16 §10.14 "Browser
// connectors"). The back office's Websites screen and the portal's website logins record a script
// one action at a time (../browser/scripts.ts), review its steps and name its inputs and outputs,
// and save it as an immutable version. Only the operator tests (a dry run that never submits) and
// publishes: a client admin's recording is a draft until then (invariant 11), and a published
// version is a browser tool for that client alone (invariant 1).

import { BROWSE_SCRIPT_DRAFT_SUBJECT, BROWSER_CONNECTOR_ID } from "@countersign/connectors";
import {
  BrowserConnectionConfig,
  type EditBrowserScript,
  routes,
  ScriptRecording,
  type ScriptStep,
} from "@countersign/core";
import { browserScript, connection, connectionChange, inboxItem, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { z } from "zod";
import {
  oneView,
  recordAction,
  type ScriptSide,
  saveVersion,
  scriptList,
  scriptRow,
  scriptTools,
  siteAllowsScripts,
  testScript,
  versionRow,
} from "../browser/scripts";
import { type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";

/** The pages of a script-draft offer (a browsing path that worked twice) as open steps. */
async function offerSteps(
  tx: Tx,
  tenantId: string,
  itemId: string,
  site: string,
): Promise<Pick<ScriptRecording, "steps" | "outputs">> {
  const [item] = await tx
    .select({ subjectType: inboxItem.subjectType, payload: inboxItem.payload })
    .from(inboxItem)
    .where(and(eq(inboxItem.id, itemId), eq(inboxItem.tenantId, tenantId)));
  if (!item || item.subjectType !== BROWSE_SCRIPT_DRAFT_SUBJECT) throw notFound("offer");
  const draft = (item.payload as { draft?: { steps?: unknown } }).draft;
  const raw = Array.isArray(draft?.steps) ? draft.steps : [];
  const steps: ScriptStep[] = [];
  const outputs: ScriptRecording["outputs"] = [];
  for (const s of raw as { tool?: unknown; site?: unknown; example?: unknown }[]) {
    if (s.site !== site || typeof s.example !== "string") continue;
    const id = `s${steps.length + 1}`;
    // DECISION: the offer's pages are open steps (a download a download step with an output of
    // its own); what to read on each page is recorded on top, since the path names pages only.
    if (s.tool === "browser.file.download") {
      const name = `file${outputs.length + 1}`;
      steps.push({ id, op: "download", url: s.example, output: name });
      outputs.push({ name, label: `File ${outputs.length + 1}`, type: "document" });
    } else {
      steps.push({ id, op: "open", url: s.example });
    }
  }
  return { steps: steps.slice(0, 50), outputs };
}

async function startScript(
  tx: Tx,
  tenantIds: readonly string[],
  body: { connectionId: string; slug: string; name: string; fromOffer?: string | undefined },
  by: { userId: string; side: ScriptSide },
) {
  const [conn] = await tx.select().from(connection).where(eq(connection.id, body.connectionId));
  if (!conn || conn.connector !== BROWSER_CONNECTOR_ID) throw notFound("website login");
  ensureClient({ tenantIds }, conn.tenantId);
  const config = BrowserConnectionConfig.safeParse(conn.config);
  if (!config.success) throw new HttpError(409, "invalid_state", "this login is not set up");
  const [taken] = await tx
    .select({ id: browserScript.id })
    .from(browserScript)
    .where(
      and(
        eq(browserScript.tenantId, conn.tenantId),
        eq(browserScript.site, config.data.site),
        eq(browserScript.slug, body.slug),
      ),
    );
  if (taken) throw new HttpError(409, "conflict", `a script called ${body.slug} already exists`);
  const prefill = body.fromOffer
    ? await offerSteps(tx, conn.tenantId, body.fromOffer, config.data.site)
    : { steps: [], outputs: [] };
  const recording = ScriptRecording.parse(prefill);
  const [row] = await tx
    .insert(browserScript)
    .values({
      tenantId: conn.tenantId,
      connectionId: conn.id,
      site: config.data.site,
      slug: body.slug,
      name: body.name,
      recording,
      offerItemId: body.fromOffer ?? null,
      createdBy: by.userId,
      createdSide: by.side,
    })
    .returning();
  if (!row) throw new Error("no script");
  return oneView(tx, row);
}

/** The review: the recording's names and the steps kept; a kept step keeps its evidence. */
async function editScript(
  tx: Tx,
  tenantIds: readonly string[],
  id: string,
  body: z.output<typeof EditBrowserScript>,
) {
  const row = await scriptRow(tx, tenantIds, id);
  const before = ScriptRecording.safeParse(row.recording);
  const evidence = before.success ? before.data.evidence : {};
  const kept = new Set(body.steps.map((s) => s.id));
  const recording = ScriptRecording.parse({
    description: body.description,
    inputs: body.inputs,
    outputs: body.outputs,
    steps: body.steps,
    undo: body.undo,
    evidence: Object.fromEntries(Object.entries(evidence).filter(([k]) => kept.has(k))),
  });
  await tx
    .update(browserScript)
    .set({ name: body.name, recording })
    .where(and(eq(browserScript.id, row.id), eq(browserScript.tenantId, row.tenantId)));
  return oneView(tx, row);
}

export function browserScriptRoutes(app: Hono<AppEnv>): void {
  const originOf = (url: string) => new URL(url).origin;

  // ── The back office ──
  mount(app, routes.opsBrowserScripts, async ({ tx, tenantIds }) => scriptList(tx, tenantIds));

  mount(app, routes.opsClientBrowserScriptTools, async ({ tx, tenantIds, params }) => {
    ensureClient({ tenantIds }, params.id);
    return { tools: await scriptTools(tx, params.id) };
  });

  mount(app, routes.opsStartBrowserScript, async ({ tx, tenantIds, body, session }) =>
    startScript(tx, tenantIds, body, { userId: session.user.id, side: "operator" }),
  );

  mount(app, routes.opsBrowserScriptAction, async ({ c, tx, tenantIds, params, body, services }) =>
    recordAction(
      services,
      tx,
      await scriptRow(tx, tenantIds, params.id),
      body.action,
      originOf(c.req.url),
    ),
  );

  mount(app, routes.opsEditBrowserScript, async ({ tx, tenantIds, params, body }) =>
    editScript(tx, tenantIds, params.id, body),
  );

  mount(app, routes.opsSaveBrowserScript, async ({ tx, tenantIds, params, session, services }) =>
    saveVersion(services, tx, await scriptRow(tx, tenantIds, params.id), {
      userId: session.user.id,
      side: "operator",
    }),
  );

  mount(app, routes.opsTestBrowserScript, async ({ c, tx, tenantIds, params, body, services }) =>
    testScript(services, tx, await scriptRow(tx, tenantIds, params.id), body, originOf(c.req.url)),
  );

  mount(app, routes.opsPublishBrowserScript, async ({ tx, tenantIds, params, session }) => {
    const row = await scriptRow(tx, tenantIds, params.id);
    const version = await versionRow(tx, row, params.version);
    await siteAllowsScripts(tx, row);
    await tx
      .update(browserScript)
      .set({
        publishedVersion: version.version,
        publishedBy: session.user.id,
        publishedAt: new Date(),
      })
      .where(and(eq(browserScript.id, row.id), eq(browserScript.tenantId, row.tenantId)));
    // On the login's own log, beside its sessions: which script runs as a tool from now on.
    await tx.insert(connectionChange).values({
      tenantId: row.tenantId,
      connectionId: row.connectionId,
      actorId: session.user.id,
      change: {
        kind: "browser_script_published",
        by: "operator",
        script: row.slug,
        before: row.publishedVersion,
        after: version.version,
      },
    });
    return oneView(tx, row);
  });

  // ── The portal: the client admin records; we publish ──
  mount(app, routes.portalBrowserScripts, async ({ tx, tenantIds }) => scriptList(tx, tenantIds));

  mount(app, routes.portalStartBrowserScript, async ({ tx, tenantIds, body, session }) =>
    startScript(tx, tenantIds, body, { userId: session.user.id, side: "client" }),
  );

  mount(
    app,
    routes.portalBrowserScriptAction,
    async ({ c, tx, tenantIds, params, body, services }) =>
      recordAction(
        services,
        tx,
        await scriptRow(tx, tenantIds, params.id),
        body.action,
        originOf(c.req.url),
      ),
  );

  mount(app, routes.portalEditBrowserScript, async ({ tx, tenantIds, params, body }) =>
    editScript(tx, tenantIds, params.id, body),
  );

  mount(app, routes.portalSaveBrowserScript, async ({ tx, tenantIds, params, session, services }) =>
    saveVersion(services, tx, await scriptRow(tx, tenantIds, params.id), {
      userId: session.user.id,
      side: "client",
    }),
  );
}
