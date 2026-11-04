// The client's upload connection: built in and always on (ARCHITECTURE §6.1), so it is created the
// first time a client uploads or forwards, never signed in to. It holds the forwarding address and
// the allowed senders (config.forwarding, ARCHITECTURE §6.5) and the forwarding counts.

import { connection, connectionChange, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { UPLOAD_CONNECTOR_ID } from "./manifest";

export type UploadConnectionRow = typeof connection.$inferSelect;

export const ForwardingConfig = z.object({
  /** The client's private address, e.g. `millwork-<id>-<secret>@in.mezonas.com`; null until made. */
  address: z.string().nullable().default(null),
  /** Addresses (`ap@shop.com`) and domains (`shop.com`) whose mail is accepted. */
  allowedSenders: z.array(z.string()).default([]),
});
export type ForwardingConfig = z.infer<typeof ForwardingConfig>;

export const ForwardingStats = z.object({
  accepted: z.number().int().nonnegative().default(0),
  dropped: z.number().int().nonnegative().default(0),
  lastReceivedAt: z.string().nullable().default(null),
  lastDroppedAt: z.string().nullable().default(null),
  lastDropReason: z.string().nullable().default(null),
});
export type ForwardingStats = z.infer<typeof ForwardingStats>;

export function forwardingOf(row: Pick<UploadConnectionRow, "config">): ForwardingConfig {
  const parsed = ForwardingConfig.safeParse(row.config?.forwarding ?? {});
  return parsed.success ? parsed.data : ForwardingConfig.parse({});
}

// DECISION: forwarding counts live in the upload connection's `sync_cursor` (connector state the
// operator never edits), not in `config`, so a config edit never resets them.
export function forwardingStatsOf(row: Pick<UploadConnectionRow, "syncCursor">): ForwardingStats {
  const parsed = ForwardingStats.safeParse(row.syncCursor?.forwarding ?? {});
  return parsed.success ? parsed.data : ForwardingStats.parse({});
}

/** The client's upload connection, created (connected, by the system) when it has none. */
export async function ensureUploadConnection(
  tx: Tx,
  tenantId: string,
): Promise<UploadConnectionRow> {
  const [existing] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, UPLOAD_CONNECTOR_ID)))
    .orderBy(connection.createdAt)
    .limit(1);
  if (existing) {
    if (existing.status === "connected") return existing;
    // Upload can't be disconnected for good: it is how clients send documents at all.
    const [row] = await tx
      .update(connection)
      .set({ status: "connected" })
      .where(and(eq(connection.id, existing.id), eq(connection.tenantId, tenantId)))
      .returning();
    await tx.insert(connectionChange).values({
      tenantId,
      connectionId: existing.id,
      change: { status: { from: existing.status, to: "connected" }, by: "system" },
    });
    return row ?? existing;
  }
  const [row] = await tx
    .insert(connection)
    .values({ tenantId, connector: UPLOAD_CONNECTOR_ID, status: "connected" })
    .returning();
  if (!row) throw new Error("upload connection insert returned nothing");
  await tx.insert(connectionChange).values({
    tenantId,
    connectionId: row.id,
    change: { status: { from: null, to: "connected" }, by: "system", builtIn: true },
  });
  return row;
}

/** Replaces config.forwarding's fields given, keeping the rest of config; logs the change. */
export async function updateForwarding(
  tx: Tx,
  row: UploadConnectionRow,
  patch: Partial<ForwardingConfig>,
  actorId: string | null,
): Promise<UploadConnectionRow> {
  const before = forwardingOf(row);
  const next = ForwardingConfig.parse({ ...before, ...patch });
  const [updated] = await tx
    .update(connection)
    .set({ config: { ...row.config, forwarding: next } })
    .where(and(eq(connection.id, row.id), eq(connection.tenantId, row.tenantId)))
    .returning();
  await tx.insert(connectionChange).values({
    tenantId: row.tenantId,
    connectionId: row.id,
    actorId,
    change: { forwarding: { from: before, to: next } },
  });
  return updated ?? row;
}

/** Counts one forwarded message, accepted or dropped (under the row lock, so none is lost). */
export async function countForwarded(
  tx: Tx,
  row: Pick<UploadConnectionRow, "id" | "tenantId">,
  outcome: { accepted: true } | { accepted: false; reason: string },
  now: Date,
): Promise<void> {
  const where = and(eq(connection.id, row.id), eq(connection.tenantId, row.tenantId));
  const [fresh] = await tx
    .select({ syncCursor: connection.syncCursor })
    .from(connection)
    .where(where)
    .for("update");
  const s = forwardingStatsOf({ syncCursor: fresh?.syncCursor ?? null });
  const next: ForwardingStats = outcome.accepted
    ? { ...s, accepted: s.accepted + 1, lastReceivedAt: now.toISOString() }
    : {
        ...s,
        dropped: s.dropped + 1,
        lastDroppedAt: now.toISOString(),
        lastDropReason: outcome.reason,
      };
  await tx
    .update(connection)
    .set({ syncCursor: { ...(fresh?.syncCursor ?? {}), forwarding: next } })
    .where(where);
}
