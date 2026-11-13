// A person's phones (docs/plan.md §1.97, migration 0048), and the check of a phone's signature when
// its owner signs a Desk item with Face ID or a fingerprint. Every query runs in the request's own
// client scope and names the person: a phone is only ever its owner's (invariant 1).

import {
  DEVICE_SIGNATURE_SKEW_SEC,
  type DevicePublicKey,
  type DeviceSignature,
  deviceSignedText,
  itemFingerprintText,
  type MyDevice,
  type RegisterDeviceBody,
} from "@countersign/core";
import { personDevice, type Tx } from "@countersign/db";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { HttpError, notFound } from "../http";

type DeviceRow = typeof personDevice.$inferSelect;

/** How many phones a person may have at once in one client. */
export const MAX_DEVICES = 10;

export function toMyDevice(row: DeviceRow): MyDevice {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    push: row.pushToken !== null,
    signing: row.publicKey !== null,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
  };
}

const mine = (tenantId: string, userId: string) =>
  and(
    eq(personDevice.tenantId, tenantId),
    eq(personDevice.userId, userId),
    isNull(personDevice.revokedAt),
  );

export async function myDevices(tx: Tx, tenantId: string, userId: string): Promise<DeviceRow[]> {
  return tx
    .select()
    .from(personDevice)
    .where(mine(tenantId, userId))
    .orderBy(asc(personDevice.createdAt));
}

export async function myDevice(
  tx: Tx,
  tenantId: string,
  userId: string,
  id: string,
): Promise<DeviceRow> {
  const [row] = await tx
    .select()
    .from(personDevice)
    .where(and(mine(tenantId, userId), eq(personDevice.id, id)));
  if (!row) throw notFound("phone");
  return row;
}

/** Removes a phone: its token and key are cleared at once; the row stays for the audit log. */
async function revoke(tx: Tx, where: ReturnType<typeof and>, now: Date) {
  await tx
    .update(personDevice)
    .set({ revokedAt: now, pushToken: null, publicKey: null })
    .where(where);
}

/**
 * Registers this phone. The same push token on another of the person's phones means the app was
 * reinstalled there: that older entry is removed, as its signing key went with the old install.
 */
export async function registerDevice(
  tx: Tx,
  tenantId: string,
  userId: string,
  body: RegisterDeviceBody,
  now: Date,
): Promise<DeviceRow> {
  if (body.pushToken) {
    await revoke(tx, and(mine(tenantId, userId), eq(personDevice.pushToken, body.pushToken)), now);
  }
  const current = await myDevices(tx, tenantId, userId);
  if (current.length >= MAX_DEVICES) {
    throw new HttpError(
      409,
      "too_many_devices",
      `you have ${MAX_DEVICES} phones: remove one in Settings first`,
    );
  }
  const [row] = await tx
    .insert(personDevice)
    .values({
      tenantId,
      userId,
      name: body.name,
      platform: body.platform,
      pushToken: body.pushToken,
      publicKey: body.publicKey,
      lastSeenAt: now,
    })
    .returning();
  if (!row) throw new Error("phone not registered");
  return row;
}

export async function updateDevice(
  tx: Tx,
  tenantId: string,
  userId: string,
  id: string,
  body: { name?: string | undefined; pushToken?: string | null | undefined },
  now: Date,
): Promise<DeviceRow> {
  await myDevice(tx, tenantId, userId, id);
  if (body.pushToken) {
    await revoke(
      tx,
      and(
        mine(tenantId, userId),
        eq(personDevice.pushToken, body.pushToken),
        ne(personDevice.id, id),
      ),
      now,
    );
  }
  const [row] = await tx
    .update(personDevice)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.pushToken !== undefined ? { pushToken: body.pushToken } : {}),
      lastSeenAt: now,
    })
    .where(and(mine(tenantId, userId), eq(personDevice.id, id)))
    .returning();
  if (!row) throw notFound("phone");
  return row;
}

export async function removeDevice(
  tx: Tx,
  tenantId: string,
  userId: string,
  id: string,
  now: Date,
): Promise<void> {
  await myDevice(tx, tenantId, userId, id);
  await revoke(tx, and(mine(tenantId, userId), eq(personDevice.id, id)), now);
}

// ── A phone's signature ─────────────────────────────────────────────────────────────────────────

const utf8 = (text: string) => new TextEncoder().encode(text);

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The fingerprint of a Desk item as the portal returns it (core's `itemFingerprintText`). */
export const itemFingerprint = (item: { id: string; title: string; display?: unknown }) =>
  sha256Hex(itemFingerprintText(item));

/** ECDSA P-256 over SHA-256, r‖s: true only when this key signed this text. */
export async function verifySigned(
  publicKey: DevicePublicKey,
  text: string,
  signature: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { ...publicKey, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64UrlBytes(signature),
      utf8(text),
    );
  } catch {
    return false;
  }
}

/**
 * A Desk item signed on a phone: the person's own phone with a key, a signature of this decision
 * on this item as they saw it, made within DEVICE_SIGNATURE_SKEW_SEC. Anything else is refused
 * before the item is touched; the phone's last use is recorded.
 */
export async function checkDeviceSignature(
  tx: Tx,
  input: {
    tenantId: string;
    userId: string;
    item: { id: string; title: string; display?: unknown };
    decision: "approve" | "reject" | undefined;
    signature: DeviceSignature;
    now: Date;
  },
): Promise<void> {
  const { signature: sig } = input;
  if (!input.decision) {
    throw new HttpError(400, "signature_needs_decision", "a phone signs an approval or a no only");
  }
  const [device] = await tx
    .select()
    .from(personDevice)
    .where(and(mine(input.tenantId, input.userId), eq(personDevice.id, sig.deviceId)));
  if (!device?.publicKey) {
    throw new HttpError(403, "device_unknown", "this phone can't sign: set it up again in the app");
  }
  const at = Date.parse(sig.at);
  if (
    !Number.isFinite(at) ||
    Math.abs(input.now.getTime() - at) > DEVICE_SIGNATURE_SKEW_SEC * 1000
  ) {
    throw new HttpError(401, "signature_stale", "the signature is too old: sign again");
  }
  if ((await itemFingerprint(input.item)) !== sig.fingerprint) {
    throw new HttpError(409, "item_changed", "this item changed since you opened it: look again");
  }
  const text = deviceSignedText({
    deviceId: device.id,
    itemId: input.item.id,
    decision: input.decision,
    fingerprint: sig.fingerprint,
    at: sig.at,
  });
  if (!(await verifySigned(device.publicKey, text, sig.signature))) {
    throw new HttpError(401, "signature_invalid", "the signature doesn't match: sign again");
  }
  await tx
    .update(personDevice)
    .set({ lastSeenAt: input.now })
    .where(and(mine(input.tenantId, input.userId), eq(personDevice.id, device.id)));
}
