// A client's computers with the Mezonas desktop app (docs/plan.md §1.151, §1.204; migration 0080).
// A client admin pairs a computer from the app: it becomes its own `desktop` connection, whose
// `config` holds the computer and the folders it gives (the connector's `DesktopConfig`), and a
// `desktop_device` row holds the public half of its key. Every later request from the computer is
// signed over core's `desktopRequestText`; `checkDeviceRequest` finds its client, checks the key,
// the time and the body's hash, and refuses a removed computer. Every query runs in one client's
// scope (invariant 1); the key is never returned by any route (invariant 13).

import { DESKTOP_CONNECTOR_ID, DesktopConfig } from "@countersign/connectors";
import {
  DESKTOP_DEVICE_HEADER,
  DESKTOP_MAX_FOLDERS,
  DESKTOP_SIGNATURE_HEADER,
  DESKTOP_SIGNATURE_SKEW_SEC,
  DESKTOP_TIME_HEADER,
  type DesktopFolder,
  type DesktopPublicKey,
  desktopRequestText,
  isUuid,
  normaliseDevicePath,
  type PairDesktopBody,
  type PairedDesktop,
} from "@countersign/core";
import {
  connection,
  connectionChange,
  type Db,
  desktopDevice,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { HttpError, notFound } from "../http";
import { verifySigned } from "../mobile/devices";
import type { Platform } from "../platform";
import { newConnectionMatrix } from "../routes/ops-connectors";

export type DesktopDeviceRow = typeof desktopDevice.$inferSelect;
type ConnectionRow = typeof connection.$inferSelect;

/** How many computers a client may have paired at once. */
// DECISION: 20, as many as a computer has folders: a small office's computers, with room to spare;
// a removed one doesn't count.
export const MAX_DESKTOPS = 20;

// ── Pairing ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Pairs a computer: its own connection (connected, the connector's starting matrix, no folders
 * yet), then the computer with the public half of its key.
 */
// DECISION: each pairing makes a new connection, so two computers never share one's folders or
// bindings; an agent is bound to the computer it works on, as to any other connection.
export async function pairDesktop(
  tx: Tx,
  input: {
    tenantId: string;
    userId: string;
    platform: Platform;
    body: PairDesktopBody;
  },
): Promise<PairedDesktop> {
  const { tenantId, body } = input;
  const [live] = await tx
    .select({ n: count() })
    .from(desktopDevice)
    .where(and(eq(desktopDevice.tenantId, tenantId), isNull(desktopDevice.revokedAt)));
  if ((live?.n ?? 0) >= MAX_DESKTOPS) {
    throw new HttpError(
      409,
      "too_many_computers",
      `a client can have at most ${MAX_DESKTOPS} computers; remove one first`,
    );
  }
  const manifest = input.platform.connectors.get(DESKTOP_CONNECTOR_ID)?.manifest;
  if (!manifest) throw new HttpError(404, "not_found", "the desktop app isn't set up here");
  const deviceId = crypto.randomUUID();
  const config: DesktopConfig = {
    deviceId,
    name: body.name,
    platform: body.platform,
    folders: [],
  };
  const [conn] = await tx
    .insert(connection)
    .values({
      tenantId,
      connector: DESKTOP_CONNECTOR_ID,
      status: "connected",
      config,
      permissions: await newConnectionMatrix(tx, manifest),
      connectedBy: input.userId,
    })
    .returning({ id: connection.id });
  if (!conn) throw new Error("connection insert returned nothing");
  await tx.insert(connectionChange).values({
    tenantId,
    connectionId: conn.id,
    actorId: input.userId,
    change: { kind: "status", by: "client", before: null, after: "connected" },
  });
  await tx.insert(desktopDevice).values({
    id: deviceId,
    tenantId,
    connectionId: conn.id,
    name: body.name,
    platform: body.platform,
    appVersion: body.appVersion,
    publicKey: body.publicKey,
    pairedBy: input.userId,
  });
  const [client] = await tx
    .select({ name: tenant.name })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  return { deviceId, tenantId, clientName: client?.name ?? "", connectionId: conn.id };
}

/** A paired computer of this client (not removed), or 404. */
export async function liveDevice(
  tx: Tx,
  tenantId: string,
  deviceId: string,
): Promise<DesktopDeviceRow> {
  const [row] = await tx
    .select()
    .from(desktopDevice)
    .where(
      and(
        eq(desktopDevice.tenantId, tenantId),
        eq(desktopDevice.id, deviceId),
        isNull(desktopDevice.revokedAt),
      ),
    );
  if (!row) throw notFound("computer");
  return row;
}

/**
 * Removes a computer: its key is cleared (nothing it signs is accepted again), its connection is
 * disconnected, and jobs it hasn't picked up are never handed out. The rows stay.
 */
export async function unpairDesktop(
  tx: Tx,
  input: { tenantId: string; userId: string; deviceId: string; now: Date },
): Promise<void> {
  const row = await liveDevice(tx, input.tenantId, input.deviceId);
  await tx
    .update(desktopDevice)
    .set({ revokedAt: input.now, publicKey: null })
    .where(and(eq(desktopDevice.tenantId, input.tenantId), eq(desktopDevice.id, row.id)));
  const [conn] = await tx
    .select({ status: connection.status })
    .from(connection)
    .where(and(eq(connection.tenantId, input.tenantId), eq(connection.id, row.connectionId)));
  if (conn && conn.status !== "disconnected") {
    await tx
      .update(connection)
      .set({ status: "disconnected" })
      .where(and(eq(connection.tenantId, input.tenantId), eq(connection.id, row.connectionId)));
    await tx.insert(connectionChange).values({
      tenantId: input.tenantId,
      connectionId: row.connectionId,
      actorId: input.userId,
      change: { kind: "status", by: "client", before: conn.status, after: "disconnected" },
    });
  }
}

// ── Folders ─────────────────────────────────────────────────────────────────────────────────────

/** Why the folder list can't be taken, in plain words; null when it can. */
export function folderListProblem(
  folders: readonly DesktopFolder[],
  platform: DesktopDeviceRow["platform"],
): string | null {
  if (folders.length > DESKTOP_MAX_FOLDERS) return `at most ${DESKTOP_MAX_FOLDERS} folders`;
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const f of folders) {
    if (ids.has(f.id)) return "each folder needs its own id";
    ids.add(f.id);
    // DECISION: the API checks what it can know: a path absolute on the computer's platform, with
    // no `.` or `..`, on a drive (not a network share), named once. The home folder, system
    // folders and links are the computer's to check (core's folderGrantProblem needs its home and
    // its disk); the computer works only in folders on both lists.
    const p = normaliseDevicePath(f.path, platform);
    if (p === null || p.startsWith("\\\\")) {
      return `${f.label} isn't a folder on this computer's own drive`;
    }
    const key = platform === "windows" ? p.toLowerCase() : p;
    if (paths.has(key)) return `${f.label} is given twice`;
    paths.add(key);
  }
  return null;
}

/** Replaces the folders a computer gives, on its connection. Answers the list as kept. */
export async function setDesktopFolders(
  tx: Tx,
  input: { tenantId: string; userId: string; deviceId: string; folders: DesktopFolder[] },
): Promise<DesktopFolder[]> {
  const device = await liveDevice(tx, input.tenantId, input.deviceId);
  const problem = folderListProblem(input.folders, device.platform);
  if (problem) throw new HttpError(400, "invalid_folders", problem);
  const row = await deviceConnection(tx, device);
  const current = DesktopConfig.safeParse(row.config);
  const before = current.success ? current.data.folders : [];
  const config: DesktopConfig = {
    ...(current.success ? current.data : {}),
    deviceId: device.id,
    name: device.name,
    platform: device.platform,
    folders: input.folders,
  };
  await tx
    .update(connection)
    .set({ config })
    .where(and(eq(connection.tenantId, input.tenantId), eq(connection.id, row.id)));
  const added = input.folders.filter((f) => !before.some((b) => sameGrant(b, f))).map((f) => f.id);
  const removed = before
    .filter((b) => !input.folders.some((f) => sameGrant(b, f)))
    .map((b) => b.id);
  if (added.length > 0 || removed.length > 0) {
    // Ids and access only: a folder's path and label are the client's own words (as a file name).
    await tx.insert(connectionChange).values({
      tenantId: input.tenantId,
      connectionId: row.id,
      actorId: input.userId,
      change: { kind: "desktop_folders", by: "client", added, removed },
    });
  }
  return input.folders;
}

const sameGrant = (a: DesktopFolder, b: DesktopFolder) =>
  a.id === b.id && a.path === b.path && a.access === b.access && a.ingest === b.ingest;

/** The computer's connection. */
export async function deviceConnection(tx: Tx, device: DesktopDeviceRow): Promise<ConnectionRow> {
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, device.tenantId), eq(connection.id, device.connectionId)));
  if (!row) throw notFound("computer");
  return row;
}

/** The folders the platform has for this computer (none when its config isn't readable). */
export function platformFolders(row: Pick<ConnectionRow, "config">): DesktopFolder[] {
  const parsed = DesktopConfig.safeParse(row.config);
  return parsed.success ? parsed.data.folders : [];
}

// ── Signed requests ─────────────────────────────────────────────────────────────────────────────

export interface SignedDevice {
  tenantId: string;
  device: DesktopDeviceRow;
}

/** Why a signed request was refused: for the audit row, never sent back in detail. */
export class DeviceRefused extends HttpError {
  constructor(
    readonly reason: "no_signature" | "unknown_device" | "bad_signature" | "clock" | "revoked",
    readonly tenantId: string | null,
    readonly deviceId: string | null,
  ) {
    // DECISION: a stale or future time answers 400 `clock`, not 401: the app takes 401 and 403
    // as "removed" and stops asking, and a computer whose clock is off should keep trying once
    // it is set right. Everything else is one 401, so nothing tells a prober which part failed.
    super(
      reason === "clock" ? 400 : 401,
      reason === "clock" ? "clock" : "device_refused",
      reason === "clock"
        ? "this computer's clock is more than 5 minutes off; set it automatically and try again"
        : "this computer isn't paired with Mezonas",
    );
  }
}

/** The SHA-256 of a body's bytes, as hex (what the computer hashes before signing). */
export async function bytesSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The client of a paired computer (0080's lookup), or null. Reads no other row. */
async function deviceTenant(db: Db, deviceId: string): Promise<string | null> {
  const rows = await db.execute<{ tenant_id: string | null }>(
    sql`select desktop_device_tenant(${deviceId}::uuid) as tenant_id`,
  );
  return [...rows][0]?.tenant_id ?? null;
}

/**
 * Checks a request a computer signed: its id names a paired computer, the time is within
 * DESKTOP_SIGNATURE_SKEW_SEC of ours, and the signature is the computer's key over this method,
 * path (without the query) and body. Records when the computer was last seen. Throws DeviceRefused.
 */
export async function checkDeviceRequest(
  db: Db,
  input: {
    headers: Headers;
    method: string;
    path: string;
    body: Uint8Array;
    now: Date;
  },
): Promise<SignedDevice> {
  const deviceId = input.headers.get(DESKTOP_DEVICE_HEADER) ?? "";
  const at = input.headers.get(DESKTOP_TIME_HEADER) ?? "";
  const signature = input.headers.get(DESKTOP_SIGNATURE_HEADER) ?? "";
  if (!isUuid(deviceId) || !at || !signature || signature.length > 200) {
    throw new DeviceRefused("no_signature", null, isUuid(deviceId) ? deviceId : null);
  }
  const tenantId = await deviceTenant(db, deviceId);
  if (!tenantId) throw new DeviceRefused("unknown_device", null, deviceId);
  const when = Date.parse(at);
  if (
    !Number.isFinite(when) ||
    Math.abs(input.now.getTime() - when) > DESKTOP_SIGNATURE_SKEW_SEC * 1000
  ) {
    throw new DeviceRefused("clock", tenantId, deviceId);
  }
  const text = desktopRequestText({
    deviceId,
    method: input.method,
    path: input.path,
    bodySha256: await bytesSha256Hex(input.body),
    at,
  });
  return withTenant(db, tenantId, async (tx) => {
    const [device] = await tx
      .select()
      .from(desktopDevice)
      .where(and(eq(desktopDevice.tenantId, tenantId), eq(desktopDevice.id, deviceId)));
    // Removed between the lookup and here: refused as any removed computer.
    if (!device || device.revokedAt || !device.publicKey) {
      throw new DeviceRefused("revoked", tenantId, deviceId);
    }
    if (!(await verifySigned(device.publicKey as DesktopPublicKey, text, signature))) {
      throw new DeviceRefused("bad_signature", tenantId, deviceId);
    }
    // DECISION: last seen at most once a minute, so a computer asking every 25 seconds doesn't
    // write a row on each ask.
    await tx
      .update(desktopDevice)
      .set({ lastSeenAt: input.now })
      .where(
        and(
          eq(desktopDevice.tenantId, tenantId),
          eq(desktopDevice.id, deviceId),
          sql`(${desktopDevice.lastSeenAt} is null or ${desktopDevice.lastSeenAt} < ${new Date(
            input.now.getTime() - 60_000,
          )})`,
        ),
      );
    return { tenantId, device };
  });
}
