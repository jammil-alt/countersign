// v0.14 W4-E: Google Chat spaces and the clients they belong to (docs/plan.md §1.60). The app is
// one for every client, so an event names a space, never a client: a code finds the client it was
// made for, and a space's binding is looked up in each client's Google Chat connection in turn
// (each in its own withTenant, as QuickBooks' webhook finds a company: no table outside RLS learns
// which client uses which space). A space is bound to at most one client; a code binds only the
// client and connection it was made for, once, within 15 minutes.

import {
  BINDING_CODE_TTL_MS,
  BINDING_CODES_PER_HOUR,
  BindAttemptLimiter,
  bindingCodeHash,
  bindingCodeMatches,
  bindSpace,
  CHAT_REPLIES,
  type ChatReplyKey,
  findBindingCode,
  GCHAT_CONNECTOR_ID,
  type GchatConfig,
  type GchatCredentials,
  generateBindingCode,
  normalizeBindingCode,
  type ParsedChatEvent,
  readGchatConfig,
  readGchatCredentials,
  unbindSpace,
} from "@countersign/connectors";
import type { JsonObject } from "@countersign/core";
import {
  connection,
  connectionChange,
  type Db,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import { and, count, eq, gt, sql } from "drizzle-orm";
import type { Bindings } from "../env";
import { HttpError } from "../http";
import { connectionCredentials } from "../secrets";

type Row = typeof connection.$inferSelect;
type Env = Pick<Bindings, "ENCRYPTION_KEY" | "ENCRYPTION_KEY_PREVIOUS">;

/** `connection_change.change.kind` of each Google Chat change. */
export const GCHAT_CHANGES = {
  code: "gchat_code",
  bound: "gchat_space_bound",
  unbound: "gchat_space_unbound",
} as const;

/** Wrong codes per space, in this isolate (codes.ts says why that is enough). */
const attempts = new BindAttemptLimiter();

async function gchatRows(tx: Tx, tenantId: string): Promise<Row[]> {
  return tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, GCHAT_CONNECTOR_ID)));
}

async function pendingOf(tx: Tx, env: Env, row: Row): Promise<GchatCredentials["pendingCode"]> {
  if (!row.credentialsEncrypted) return null;
  const creds = readGchatCredentials(await (await connectionCredentials(tx, env, row)).get());
  return creds.pendingCode ?? null;
}

async function codeIsRow(
  tx: Tx,
  env: Env,
  row: Row,
  canonical: string,
  now: Date,
): Promise<{ createdBy: string | null } | null> {
  if (row.status !== "connected") return null;
  const pending = await pendingOf(tx, env, row);
  if (!pending) return null;
  // Compared before the expiry is looked at, so an expired code takes as long as a live one.
  const same = await bindingCodeMatches(pending.hash, row.tenantId, row.id, canonical);
  if (!same || Date.parse(pending.expiresAt) <= now.getTime()) return null;
  return { createdBy: pending.createdBy };
}

async function saveConfig(tx: Tx, row: Row, next: GchatConfig) {
  const config = { ...(row.config as Record<string, unknown>), spaces: next.spaces };
  await tx
    .update(connection)
    .set({ config })
    .where(and(eq(connection.id, row.id), eq(connection.tenantId, row.tenantId)));
}

async function recordChange(tx: Tx, row: Row, actorId: string | null, change: JsonObject) {
  await tx.insert(connectionChange).values({
    tenantId: row.tenantId,
    connectionId: row.id,
    actorId,
    change,
  });
}

/** What the app answers an event: a fixed line, or nothing. */
export type ChatAnswer = { text?: string };
const say = (key: ChatReplyKey): ChatAnswer => ({ text: CHAT_REPLIES[key] });

/** The space is removed from whichever client has it bound. */
async function unbindEverywhere(db: Db, space: string): Promise<number> {
  let removed = 0;
  for (const client of await db.select({ id: tenant.id }).from(tenant)) {
    removed += await withTenant(db, client.id, async (tx) => {
      let n = 0;
      for (const row of await gchatRows(tx, client.id)) {
        const r = unbindSpace(readGchatConfig(row.config), space);
        if (!r.removed) continue;
        await saveConfig(tx, row, r.config);
        await recordChange(tx, row, null, {
          kind: GCHAT_CHANGES.unbound,
          by: "google_chat",
          space,
          displayName: r.removed.displayName,
        });
        n += 1;
      }
      return n;
    });
  }
  return removed;
}

/**
 * One verified event from Google Chat. Only a code is read from a message; nothing of it is
 * stored. Returns the line the app answers in the space.
 */
export async function handleChatEvent(
  db: Db,
  env: Env,
  event: ParsedChatEvent,
  now = new Date(),
): Promise<ChatAnswer> {
  const space = event.space;
  if (!space) return {};
  if (event.type === "REMOVED_FROM_SPACE") {
    await unbindEverywhere(db, space.name);
    return {};
  }
  if (event.type !== "MESSAGE" && event.type !== "ADDED_TO_SPACE") return {};
  // A bot's message never binds (another app repeating a code it saw).
  if (event.user && !event.user.human) return {};

  const code = findBindingCode(event.text);
  if (!code) return say(event.type === "ADDED_TO_SPACE" ? "welcome" : "onlyPosts");
  if (space.kind === "dm") return say("dmRefused");
  if (!attempts.allowed(space.name, now.getTime())) return say("tooManyTries");

  // Which client the code is for, and which client (if any) has the space already.
  const seen: { owner: Row | null; boundTo: string | null } = { owner: null, boundTo: null };
  for (const client of await db.select({ id: tenant.id }).from(tenant)) {
    await withTenant(db, client.id, async (tx) => {
      for (const row of await gchatRows(tx, client.id)) {
        if (readGchatConfig(row.config).spaces.some((s) => s.name === space.name)) {
          seen.boundTo = client.id;
        }
        if (!seen.owner && (await codeIsRow(tx, env, row, code, now))) seen.owner = row;
      }
    });
  }
  const found = seen.owner;
  if (!found) {
    attempts.failed(space.name, now.getTime());
    return say("badCode");
  }
  if (seen.boundTo !== null && seen.boundTo !== found.tenantId) return say("takenByAnother");

  // DECISION: the binding is written in the code's own client only, under that connection's row
  // lock, after checking the code again there; two clients' codes posted in one space within the
  // same instant could both bind (no cross-client lock without a table), which needs two valid
  // codes from two clients in one space and is shown to both clients in their portal.
  return withTenant(db, found.tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, found.id), eq(connection.tenantId, found.tenantId)))
      .for("update");
    const valid = row ? await codeIsRow(tx, env, row, code, now) : null;
    if (!row || !valid) return say("badCode");
    const accessor = await connectionCredentials(tx, env, row);
    const bound = bindSpace(
      readGchatConfig(row.config),
      space,
      event.user?.displayName ?? null,
      now,
    );
    if (!bound.ok && bound.reason === "full") return say("tooManySpaces");
    if (!bound.ok && bound.reason === "dm") return say("dmRefused");
    // Used once: the code goes whether the space was new or already this client's.
    await accessor.set({ pendingCode: null });
    if (!bound.ok) return say("alreadyConnected");
    await saveConfig(tx, row, bound.config);
    await recordChange(tx, row, valid.createdBy, {
      kind: GCHAT_CHANGES.bound,
      by: "client",
      space: space.name,
      displayName: space.displayName,
    });
    return say("connected");
  });
}

// --- The portal ---------------------------------------------------------------------------------

/** The client's Google Chat connection, connected, or 404/409. */
export async function gchatConnection(tx: Tx, tenantId: string, id: string): Promise<Row> {
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.id, id), eq(connection.tenantId, tenantId)));
  if (!row || row.connector !== GCHAT_CONNECTOR_ID)
    throw new HttpError(404, "not_found", "no such Google Chat connection");
  if (row.status !== "connected") {
    throw new HttpError(409, "not_connected", "connect Google Chat first");
  }
  return row;
}

export async function gchatView(tx: Tx, env: Env, row: Row, newCode: string | null = null) {
  const pending = await pendingOf(tx, env, row);
  const live = pending && Date.parse(pending.expiresAt) > Date.now() ? pending : null;
  return {
    spaces: readGchatConfig(row.config).spaces,
    pendingCodeExpiresAt: live?.expiresAt ?? null,
    newCode,
  };
}

/**
 * A new code for this connection (replacing any not yet used): shown once, kept only as its hash
 * in the encrypted credentials. At most BINDING_CODES_PER_HOUR an hour per connection.
 */
export async function makeCode(
  tx: Tx,
  env: Env,
  row: Row,
  actorId: string,
  now = new Date(),
): Promise<{ code: string; expiresAt: string }> {
  const [made] = await tx
    .select({ n: count() })
    .from(connectionChange)
    .where(
      and(
        eq(connectionChange.tenantId, row.tenantId),
        eq(connectionChange.connectionId, row.id),
        sql`${connectionChange.change}->>'kind' = ${GCHAT_CHANGES.code}`,
        gt(connectionChange.createdAt, new Date(now.getTime() - 3600_000)),
      ),
    );
  if ((made?.n ?? 0) >= BINDING_CODES_PER_HOUR) {
    throw new HttpError(429, "too_many_codes", "too many codes this hour; try again later");
  }
  const code = generateBindingCode();
  const canonical = normalizeBindingCode(code);
  if (!canonical) throw new Error("a generated code did not read back");
  const expiresAt = new Date(now.getTime() + BINDING_CODE_TTL_MS).toISOString();
  const credentials: GchatCredentials = {
    pendingCode: {
      hash: await bindingCodeHash(row.tenantId, row.id, canonical),
      createdAt: now.toISOString(),
      expiresAt,
      createdBy: actorId,
    },
  };
  await (await connectionCredentials(tx, env, row)).set(credentials as unknown as JsonObject);
  // The record says a code was made, never the code.
  await recordChange(tx, row, actorId, { kind: GCHAT_CHANGES.code, by: "client", expiresAt });
  return { code, expiresAt };
}

/** The client admin disconnects one space. */
export async function unbindFromPortal(
  tx: Tx,
  row: Row,
  spaceName: string,
  actorId: string,
): Promise<Row> {
  const r = unbindSpace(readGchatConfig(row.config), spaceName);
  if (!r.removed) throw new HttpError(404, "not_found", "that space isn't connected");
  await saveConfig(tx, row, r.config);
  await recordChange(tx, row, actorId, {
    kind: GCHAT_CHANGES.unbound,
    by: "client",
    space: spaceName,
    displayName: r.removed.displayName,
  });
  return {
    ...row,
    config: { ...(row.config as Record<string, unknown>), spaces: r.config.spaces },
  };
}
