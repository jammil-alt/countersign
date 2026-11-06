// Exports (docs/plan.md §1.36): the client data export (operator: start one, list them with a
// short-lived link), the accountant export (client admin and operator) and the client's audit log
// (client admin). Every request is audited by mount(); each export also writes its own audit row
// naming what it covered, and starting a client data export is logged in the client's change log.

import { SIGNED_URL_TTL_SECONDS } from "@countersign/connectors";
import { type ClientExport, routes, uuidv7 } from "@countersign/core";
import { narrowToTenant, type Tx, tenant, tenantChange } from "@countersign/db";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { auditInTx } from "../audit";
import type { Bindings } from "../env";
import { exportFilename } from "../exports/client-data";
import { type ExportJobs, exportJobs } from "../exports/instances";
import { accountantExport, auditExport } from "../exports/period";
import { type ExportManifest, exportRunning, listManifests, writeManifest } from "../exports/store";
import {
  type AppContext,
  type AppDeps,
  type AppEnv,
  auditActor,
  ensureClient,
  type HandlerCtx,
  HttpError,
  iso,
  mount,
  mountFile,
  notFound,
} from "../http";
import { signerFor } from "../storage";
import { purgeAfter } from "./compliance";

/** The deployment's ExportWorkflow (tests pass memory jobs); null where it isn't bound. */
export function exportJobsFor(deps: AppDeps, env: Bindings): ExportJobs | null {
  if (deps.exports) return deps.exports(env);
  return env.EXPORT_WORKFLOW ? exportJobs(env.EXPORT_WORKFLOW) : null;
}

type TenantRow = typeof tenant.$inferSelect;

/**
 * Until when a client's data can still be exported: always while it is a client; for a retired
 * client, until its files are deleted 30 days after retirement (the terms' 30 days to ask).
 */
export function exportableUntil(t: Pick<TenantRow, "retiredAt">): Date | null {
  return t.retiredAt ? purgeAfter(t.retiredAt) : null;
}

function refuseClosedWindow(t: TenantRow, now: Date): void {
  const purge = (t.settings as { purge?: { files_deleted_at?: unknown } }).purge;
  const until = exportableUntil(t);
  if (purge?.files_deleted_at || (until && now >= until)) {
    throw new HttpError(
      409,
      "export_window_closed",
      "this client was retired more than 30 days ago and its data has been or is being deleted",
    );
  }
}

async function clientRow(tx: Tx, id: string): Promise<TenantRow> {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, id));
  if (!t) throw notFound("client");
  return t;
}

async function exportView(
  c: AppContext,
  env: Bindings,
  m: ExportManifest,
  now: Date,
): Promise<ClientExport> {
  let download: ClientExport["download"] = null;
  if (m.status === "ready" && m.key) {
    const signer = signerFor(env, new URL(c.req.url).origin, () => m.filename);
    download = {
      url: await signer.signedGetUrl(m.key, { expiresInSeconds: SIGNED_URL_TTL_SECONDS }),
      filename: m.filename,
      expiresAt: new Date(now.getTime() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
    };
  }
  return {
    id: m.id,
    status: m.status,
    requestedAt: m.requestedAt,
    requestedBy: m.requestedBy,
    reason: m.reason,
    finishedAt: m.finishedAt,
    files: m.files,
    sizeBytes: m.sizeBytes,
    error: m.error,
    download,
  };
}

/** The export's own audit row, beside mount's: what it covered. */
async function auditExportRow(
  ctx: Pick<HandlerCtx<typeof routes.portalAuditExport>, "c" | "tx" | "session">,
  tenantId: string,
  action: string,
  target: Record<string, string>,
): Promise<void> {
  await auditInTx(ctx.tx, ctx.c, {
    ...auditActor(ctx.session),
    tenantId,
    action,
    outcome: "ok",
    httpStatus: 200,
    target,
  });
}

export function exportRoutes(app: Hono<AppEnv>): void {
  // ── Client data export (operator) ──────────────────────────────────────────────────────────────

  mount(app, routes.opsClientExports, async ({ c, tx, params, tenantIds, services }) => {
    ensureClient({ tenantIds }, params.id);
    const t = await clientRow(tx, params.id);
    const now = new Date();
    const manifests = await listManifests(services.deps.objects(services.env), t.id);
    return {
      exports: await Promise.all(manifests.map((m) => exportView(c, services.env, m, now))),
      retiredAt: iso(t.retiredAt),
      exportableUntil: iso(exportableUntil(t)),
    };
  });

  mount(
    app,
    routes.opsClientExportStart,
    async ({ c, tx, params, tenantIds, services, session, body }) => {
      ensureClient({ tenantIds }, params.id);
      // Locked, so two starts at once can't both find no export running.
      const [t] = await tx.select().from(tenant).where(eq(tenant.id, params.id)).for("update");
      if (!t) throw notFound("client");
      const now = new Date();
      refuseClosedWindow(t, now);
      const jobs = exportJobsFor(services.deps, services.env);
      if (!jobs) throw new HttpError(503, "exports_off", "exports are not set up here");
      const objects = services.deps.objects(services.env);
      if (await exportRunning(objects, t.id, now)) {
        throw new HttpError(409, "export_running", "an export of this client is being built");
      }
      const reason = body.reason ?? "Client data export";
      const manifest: ExportManifest = {
        v: 1,
        id: uuidv7(),
        tenantId: t.id,
        status: "running",
        requestedAt: now.toISOString(),
        requestedBy: { id: session.user.id, email: session.user.email },
        reason,
        finishedAt: null,
        files: null,
        sizeBytes: null,
        filename: exportFilename(t.name, now),
        key: null,
        error: null,
      };
      await writeManifest(objects, manifest);
      await tx.insert(tenantChange).values({
        tenantId: t.id,
        actorId: session.user.id,
        change: { setting: "export", to: manifest.id },
        reason,
      });
      await auditExportRow({ c, tx, session }, t.id, "export.client_data.start", {
        export: manifest.id,
      });
      try {
        await jobs.start({ tenantId: t.id, exportId: manifest.id });
      } catch (error) {
        console.error("export job not started", error);
        await writeManifest(objects, {
          ...manifest,
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: "the export job could not be started",
        });
        throw new HttpError(503, "export_not_started", "the export could not be started; try again");
      }
      return exportView(c, services.env, manifest, now);
    },
  );

  // ── Accountant export ──────────────────────────────────────────────────────────────────────────

  mountFile(app, routes.portalAccountantExport, async ({ c, tx, tenantIds, query, services, session }) => {
    const tenantId = tenantIds[0] as string;
    const file = await accountantExport({
      tx,
      tenantId,
      period: query,
      platform: services.platform,
      objects: services.deps.objects(services.env),
      now: new Date(),
    });
    await auditExportRow({ c, tx, session }, tenantId, "export.accountant", {
      from: query.from,
      to: query.to,
      format: query.format,
      changes: String(file.changes),
    });
    return file;
  });

  mountFile(
    app,
    routes.opsClientAccountantExport,
    async ({ c, tx, params, tenantIds, query, services, session }) => {
      ensureClient({ tenantIds }, params.id);
      // The portal's export, in this one client's scope.
      return narrowToTenant(tx, params.id, async (one) => {
        const file = await accountantExport({
          tx: one,
          tenantId: params.id,
          period: query,
          platform: services.platform,
          objects: services.deps.objects(services.env),
          now: new Date(),
        });
        await auditExportRow({ c, tx: one, session }, params.id, "export.accountant", {
          from: query.from,
          to: query.to,
          format: query.format,
          changes: String(file.changes),
        });
        return file;
      });
    },
  );

  // ── The client's audit log (client admin) ─────────────────────────────────────────────────────

  mountFile(app, routes.portalAuditExport, async ({ c, tx, tenantIds, query, session }) => {
    const tenantId = tenantIds[0] as string;
    const file = await auditExport(tx, tenantId, query);
    await auditExportRow({ c, tx, session }, tenantId, "export.audit", {
      from: query.from,
      to: query.to,
      rows: String(file.rows),
    });
    return file;
  });
}
