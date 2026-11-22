// The desktop app's routes (docs/plan.md §1.151, §1.193). Pairing, removing and the folder list
// are session routes for a client admin (`mount()`: roles, the client's scope, the audit row).
// Jobs, results and files come from the computer itself, signed with its key: no session, the
// signature, time and key are checked first (`checkDeviceRequest`), and each is audited alone
// (`auditAlone`), refusals included. Nothing a route returns carries the computer's key.

import { ContentStore, isDocumentType } from "@countersign/connectors";
import {
  bytesMatchType,
  DESKTOP_FILE_TYPES,
  DESKTOP_MAX_FILE_BYTES,
  DESKTOP_POLL_SEC,
  DesktopFileMeta,
  desktopFileType,
  desktopRoutes,
  isExtractable,
  isTableType,
  isUuid,
} from "@countersign/core";
import { withTenant } from "@countersign/db";
import { DocumentError, storeDocument } from "@countersign/documents";
import type { EventRow } from "@countersign/senses";
import type { Context, Hono } from "hono";
import { type AuditEntry, auditAlone } from "../audit";
import { readBodyLimited } from "../body";
import {
  bytesSha256Hex,
  checkDeviceRequest,
  DeviceRefused,
  deviceConnection,
  pairDesktop,
  platformFolders,
  type SignedDevice,
  setDesktopFolders,
  unpairDesktop,
} from "../desktop/devices";
import { answerJob, takeJobs } from "../desktop/jobs";
import { type AppEnv, errorResponse, HttpError, mount } from "../http";
import { keyEnrolRefusal } from "../mobile/phone-session";
import { dispatchEvents } from "../runs/dispatch";
import { extractInBackground } from "./documents";

/** A result carries at most a text file (1M characters) or a 1000-row read: 4 MB is room enough. */
const RESULT_MAX_BYTES = 4 * 1024 * 1024;
/** The file and its multipart framing. */
const FILE_MAX_BYTES = DESKTOP_MAX_FILE_BYTES + 64 * 1024;

const DESKTOP_MIME_TYPES: ReadonlySet<string> = new Set(Object.values(DESKTOP_FILE_TYPES));

/** The audit row of a signed request: the computer as the actor, ids only. */
function deviceAudit(
  c: Context<AppEnv>,
  signed: SignedDevice | null,
  refused: DeviceRefused | HttpError | null,
  target: Record<string, string> = {},
): AuditEntry {
  const tenantId = signed?.tenantId ?? (refused instanceof DeviceRefused ? refused.tenantId : null);
  const deviceId =
    signed?.device.id ?? (refused instanceof DeviceRefused ? refused.deviceId : null);
  return {
    tenantId,
    actorKind: signed ? "system" : "anonymous",
    actorRole: "desktop",
    action: `${c.req.method} ${c.req.routePath || c.req.path}`,
    outcome: refused ? "refused" : "ok",
    httpStatus: refused ? refused.status : 200,
    target: {
      ...(deviceId ? { device: deviceId } : {}),
      ...(refused instanceof DeviceRefused ? { reason: refused.reason } : {}),
      ...target,
    },
  };
}

/** Reads the body (bounded) and checks the computer's signature over it. */
async function signedRequest(
  c: Context<AppEnv>,
  limit: number,
): Promise<{ signed: SignedDevice; bytes: Uint8Array }> {
  const bytes = c.req.method === "GET" ? new Uint8Array() : await readBodyLimited(c.req.raw, limit);
  if (!bytes) throw new HttpError(413, "too_large", "the request is too large");
  const signed = await checkDeviceRequest(c.get("req").services().db, {
    headers: c.req.raw.headers,
    method: c.req.method,
    path: c.req.path,
    body: bytes,
    now: new Date(),
  });
  return { signed, bytes };
}

/** Answers a signed route's error, auditing it (a refused signature always, a failure always). */
async function refusedResponse(
  c: Context<AppEnv>,
  error: unknown,
  signed: SignedDevice | null,
  target: Record<string, string> = {},
) {
  if (error instanceof HttpError) {
    await auditAlone(c.get("req").services().db, c, deviceAudit(c, signed, error, target));
  } else {
    await auditAlone(c.get("req").services().db, c, {
      ...deviceAudit(c, signed, null, target),
      outcome: "error",
      httpStatus: 500,
    });
  }
  return errorResponse(c, error);
}

export function desktopApiRoutes(app: Hono<AppEnv>): void {
  // ── A client admin's session ──────────────────────────────────────────────────────────────────

  mount(app, desktopRoutes.pairDesktop, async ({ tx, tenantIds, session, body, services }) => {
    // As a phone's signing key (audit 5.2): a key only from a session that recently proved itself.
    const stale = keyEnrolRefusal(session, new Date());
    if (stale) {
      throw new HttpError(403, "fresh_sign_in_required", "sign in again to add this computer");
    }
    return pairDesktop(tx, {
      tenantId: tenantIds[0] as string,
      userId: session.user.id,
      platform: services.platform,
      body,
    });
  });

  mount(app, desktopRoutes.unpairDesktop, async ({ tx, tenantIds, session, params }) => {
    await unpairDesktop(tx, {
      tenantId: tenantIds[0] as string,
      userId: session.user.id,
      deviceId: params.id,
      now: new Date(),
    });
    return { ok: true as const };
  });

  mount(app, desktopRoutes.setDesktopFolders, async ({ tx, tenantIds, session, params, body }) => ({
    folders: await setDesktopFolders(tx, {
      tenantId: tenantIds[0] as string,
      userId: session.user.id,
      deviceId: params.id,
      folders: body.folders,
    }),
  }));

  // ── The computer, signed ──────────────────────────────────────────────────────────────────────

  app.get(desktopRoutes.desktopJobs.path, async (c) => {
    let signed: SignedDevice | null = null;
    try {
      ({ signed } = await signedRequest(c, 0));
      const wait = Number(c.req.query("wait") ?? DESKTOP_POLL_SEC);
      const answer = await takeJobs(
        c.get("req").services().db,
        signed,
        Number.isFinite(wait) ? wait : DESKTOP_POLL_SEC,
      );
      // DECISION: a poll that hands out no job reads nothing of the client's but the folders the
      // computer itself sent, so it writes no audit row (one every 25 seconds per computer would
      // bury the log); one that hands out jobs names them.
      if (answer.jobs.length > 0) {
        await auditAlone(
          c.get("req").services().db,
          c,
          deviceAudit(c, signed, null, { jobs: answer.jobs.map((j) => j.id).join(",") }),
        );
      }
      return c.json(answer);
    } catch (error) {
      return refusedResponse(c, error, signed);
    }
  });

  app.post(desktopRoutes.desktopJobResult.path, async (c) => {
    let signed: SignedDevice | null = null;
    const jobId = c.req.param("id") ?? "";
    try {
      const read = await signedRequest(c, RESULT_MAX_BYTES);
      signed = read.signed;
      if (!isUuid(jobId)) throw new HttpError(404, "not_found", "job not found");
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(read.bytes));
      } catch {
        throw new HttpError(400, "invalid_result", "not a job result");
      }
      const s = signed;
      const done = await withTenant(c.get("req").services().db, s.tenantId, (tx) =>
        answerJob(tx, s, jobId, body, new Date()),
      );
      await auditAlone(
        c.get("req").services().db,
        c,
        deviceAudit(c, signed, null, {
          job: jobId,
          kind: done.kind,
          result: done.ok ? "ok" : "refused",
        }),
      );
      return c.json({ ok: true as const });
    } catch (error) {
      return refusedResponse(c, error, signed, isUuid(jobId) ? { job: jobId } : {});
    }
  });

  app.post(desktopRoutes.desktopFile.path, async (c) => {
    let signed: SignedDevice | null = null;
    try {
      const read = await signedRequest(c, FILE_MAX_BYTES);
      signed = read.signed;
      const services = c.get("req").services();
      const form = await new Request("https://desktop.invalid/", {
        method: "POST",
        headers: { "content-type": c.req.header("content-type") ?? "" },
        body: read.bytes as Uint8Array<ArrayBuffer>,
      })
        .formData()
        .catch(() => null);
      const metaPart = form?.get("meta");
      const filePart = form?.get("file");
      if (typeof metaPart !== "string" || !(filePart instanceof File)) {
        throw new HttpError(400, "invalid_file", "a file needs its meta and its bytes");
      }
      let metaJson: unknown;
      try {
        metaJson = JSON.parse(metaPart);
      } catch {
        throw new HttpError(400, "invalid_file", "the file's meta isn't readable");
      }
      const meta = DesktopFileMeta.safeParse(metaJson);
      if (!meta.success) throw new HttpError(400, "invalid_file", "the file's meta isn't valid");
      const bytes = new Uint8Array(await filePart.arrayBuffer());
      // What was signed is what arrived (the body's hash), and the meta describes these bytes.
      if (bytes.length !== meta.data.size || (await bytesSha256Hex(bytes)) !== meta.data.sha256) {
        throw new HttpError(400, "invalid_file", "the file doesn't match its meta");
      }
      const mimeType = desktopFileType(meta.data.path);
      if (!mimeType || mimeType !== meta.data.contentType || !DESKTOP_MIME_TYPES.has(mimeType)) {
        throw new HttpError(415, "unsupported_file", "Mezonas doesn't take this kind of file");
      }
      if (isTableType(mimeType) && !bytesMatchType(bytes, mimeType)) {
        throw new HttpError(415, "unsupported_file", "the file is not what its type says");
      }
      const s = signed;
      const content = new ContentStore(services.deps.objects(services.env));
      const stored = await withTenant(services.db, s.tenantId, async (tx) => {
        // The platform's list decides (§1.151 "Two lists"): a folder it doesn't have, or one not
        // set to send files, is refused whatever the computer's own list says.
        const folder = platformFolders(await deviceConnection(tx, s.device)).find(
          (f) => f.id === meta.data.folderId,
        );
        if (!folder?.ingest) {
          throw new HttpError(403, "not_granted", "this folder isn't set to send files to Mezonas");
        }
        try {
          // DECISION: a file from a computer is a `connector` document of its desktop connection,
          // as a browser login's download is; PDFs, images and table files are announced (a
          // workflow starts from them as from an upload), and Word, text and Markdown files are
          // kept quietly, since nothing reads them yet.
          return await storeDocument(tx, content, {
            tenantId: s.tenantId,
            source: "connector",
            connectionId: s.device.connectionId,
            bytes,
            filename: meta.data.path.slice(meta.data.path.lastIndexOf("/") + 1),
            mimeType,
            meta: {
              desktop: {
                deviceId: s.device.id,
                folderId: folder.id,
                path: meta.data.path,
                modifiedAt: meta.data.modifiedAt,
              },
            },
            allowType: (m) => DESKTOP_MIME_TYPES.has(m),
            announce: isDocumentType(mimeType),
          });
        } catch (error) {
          if (error instanceof DocumentError) {
            throw new HttpError(error.code === "too_large" ? 413 : 400, error.code, error.message);
          }
          throw error;
        }
      });
      const events: EventRow[] = stored.event ? [stored.event] : [];
      if (events.length > 0) {
        c.get("req").deferred.push(() =>
          dispatchEvents({ db: services.db, instances: services.instances }, events),
        );
      }
      if (stored.created && isExtractable(mimeType)) {
        c.get("req").deferred.push(() =>
          extractInBackground(services, s.tenantId, [stored.document.id]),
        );
      }
      await auditAlone(
        services.db,
        c,
        deviceAudit(c, signed, null, {
          document: stored.document.id,
          folder: meta.data.folderId,
        }),
      );
      return c.json({ documentId: stored.document.id, created: stored.created });
    } catch (error) {
      return refusedResponse(c, error, signed);
    }
  });
}
