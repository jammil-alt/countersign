// Human release (ARCHITECTURE §6.9, docs/plan.md §1.26 "Human release", phase 4): a vault item (a
// connection) may need a named person of the client to release it before an agent uses it. When a
// step calls through such a connection with no live release, it asks for one: a 6-digit code goes
// to the person (a text from the client's own number when it can, else an email from Mezonas'
// sending domain), their inbox item opens, and the step waits. Entering the code in the portal, or
// replying with it from their own number or address, releases it and wakes the run.
//
// The code exists only in the message and in what the person types back: `access_release` keeps
// its HMAC; no log line, step output, tool result, event, inbox payload or response carries it;
// inbound messages that carry a code for a pending request are consumed here and never stored or
// shown in a thread (invariants 9, 12, 13). Every transaction is withTenant for one client
// (invariant 1); every request, release, failed try, expiry, re-send, void and revoke is a
// `connection_change` row.

import type { ReleasePort, ReleaseRequested } from "@countersign/agents";
import {
  type FetchLike,
  generateReleaseCode,
  globalFetch,
  parseForwardingAddress,
  parseReplyEmail,
  ReleaseCodeKeys,
  readTwilioConfig,
  releaseTextSender,
  resendRequest,
  sameAddress,
  sendReleaseText,
  TWILIO_CONNECTOR_ID,
  taggedReplyTo,
  trustedFromHeader,
  twilioCredentialsOf,
} from "@countersign/connectors";
import {
  type ContactConsent,
  clientLanguage,
  consentBlock,
  contactHours,
  inQuietHours,
  isPlainObject,
  type LiveRelease,
  type Locale,
  maskEmail,
  maskPhone,
  normalizeCode,
  RELEASE_CODE_TTL_MS,
  RELEASE_MAX_RESENDS,
  RELEASE_MAX_TRIES,
  RELEASE_WORDS,
  type ReleaseChannel,
  type ReleasePerson,
  type ReleaseRecord,
  type ReleaseRequestView,
  type ReleaseSetting,
  type ReleaseView,
  type ReleaseWindow,
  releaseCovers,
  releaseLocale,
  releaseMessage,
  releaseOf,
  releaseSettingProblem,
  type SetRelease,
  tryCode,
  userLanguage,
  uuidv7,
  validUntilFor,
} from "@countersign/core";
import {
  accessRelease,
  agent,
  appUser,
  connection,
  connectionChange,
  contact,
  type Db,
  inboxItem,
  membership,
  run,
  stepRun,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import type { InboxResolution, StepOutcome } from "@countersign/workflows";
import { inboxEventType } from "@countersign/workflows";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { Bindings } from "../env";
import { HttpError, notFound } from "../http";
import { messagingSettings, reachContactOf } from "../messaging/contacts";
import type { Platform } from "../platform";
import { forwardingAddress } from "../reach/replies";
import type { RunInstances } from "../runs/instances";
import { connectionCredentials } from "../secrets";

export type ReleaseRow = typeof accessRelease.$inferSelect;
type ConnectionRow = typeof connection.$inferSelect;
type InboxRow = typeof inboxItem.$inferSelect;

/** The subject an access release inbox item names: the current request. */
export const RELEASE_SUBJECT = "access_release";

export interface ReleaseDeps {
  db: Db;
  platform: Platform;
  /** ENCRYPTION_KEY (and the previous ones): the code key is derived from it. */
  secrets: Pick<Bindings, "ENCRYPTION_KEY" | "ENCRYPTION_KEY_PREVIOUS">;
  /** Twilio and Resend calls. */
  fetch: FetchLike;
  /** Mezonas' sending for codes by email; null: codes go by text only. */
  resend: { apiKey: string; domain: string } | null;
  /** EMAIL_FORWARDING_DOMAIN: where email replies come back; null: email replies aren't read. */
  forwardingDomain: string | null;
  /** Wakes the run once released; without it the cron's redelivery does. */
  instances?: RunInstances;
  now?: () => Date;
}

export function releaseDepsFromEnv(
  env: Bindings,
  base: { db: Db; platform: Platform; instances?: RunInstances; fetch?: FetchLike },
): ReleaseDeps {
  const apiKey = env.RESEND_API_KEY?.trim();
  const domain = env.RESEND_FALLBACK_DOMAIN?.trim().toLowerCase();
  return {
    db: base.db,
    platform: base.platform,
    secrets: {
      ...(env.ENCRYPTION_KEY ? { ENCRYPTION_KEY: env.ENCRYPTION_KEY } : {}),
      ...(env.ENCRYPTION_KEY_PREVIOUS
        ? { ENCRYPTION_KEY_PREVIOUS: env.ENCRYPTION_KEY_PREVIOUS }
        : {}),
    },
    fetch: base.fetch ?? globalFetch(),
    resend: apiKey && domain ? { apiKey, domain } : null,
    forwardingDomain: env.EMAIL_FORWARDING_DOMAIN?.trim().toLowerCase() || null,
    ...(base.instances ? { instances: base.instances } : {}),
  };
}

const keyCache = new Map<string, Promise<ReleaseCodeKeys>>();

function codeKeys(secrets: ReleaseDeps["secrets"]): Promise<ReleaseCodeKeys> {
  if (!secrets.ENCRYPTION_KEY) {
    throw new HttpError(503, "not_configured", "codes can't be made here: no encryption key");
  }
  const previous = (secrets.ENCRYPTION_KEY_PREVIOUS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cacheKey = `${secrets.ENCRYPTION_KEY}|${previous.join(",")}`;
  let k = keyCache.get(cacheKey);
  if (!k) {
    k = ReleaseCodeKeys.create({ current: secrets.ENCRYPTION_KEY, previous });
    keyCache.set(cacheKey, k);
  }
  return k;
}

function recordOf(row: ReleaseRow): ReleaseRecord {
  return {
    status: row.status,
    connectionId: row.connectionId,
    agentId: row.agentId,
    runId: row.runId,
    personId: row.personId,
    expiresAt: row.expiresAt,
    tries: row.tries,
    releasedAt: row.releasedAt,
    validUntil: row.validUntil,
  };
}

/** One line in the connection's log. Names ids and what happened; never a code or a hash. */
async function logChange(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  actorId: string | null,
  change: Record<string, unknown>,
) {
  await tx.insert(connectionChange).values({
    tenantId,
    connectionId,
    actorId,
    change: { kind: "release", ...change },
  });
}

const serviceName = (a: Pick<typeof agent.$inferSelect, "serviceName" | "name">) =>
  a.serviceName ?? a.name;

function toolName(platform: Platform, connector: string): string {
  return platform.connectors.get(connector)?.manifest.name ?? connector;
}

// ── People and the setting ──────────────────────────────────────────────────────────────────────

/** The client's users (admins and users), each with whether a text can reach them. */
export async function releasePeople(tx: Tx, tenantId: string): Promise<ReleasePerson[]> {
  const users = await tx
    .select({ id: appUser.id, name: appUser.name, email: appUser.email })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(
      and(
        eq(membership.tenantId, tenantId),
        inArray(membership.role, ["client_admin", "client_user"]),
      ),
    )
    .orderBy(appUser.email);
  const out: ReleasePerson[] = [];
  for (const u of users) {
    out.push({
      id: u.id,
      name: u.name,
      email: maskEmail(u.email),
      canText: (await textablePhone(tx, tenantId, u.email)) !== null,
    });
  }
  return out;
}

/**
 * The person's phone for texts: the client's contact with the person's sign-in address, with a
 * phone, text consent and no opt-out. Null: no text can reach them.
 */
// DECISION: users have no phone of their own (app_user holds a verified sign-in email only), so a
// text goes to the client's contact with the same email address, and only with that contact's
// text consent and no STOP. The number is pinned in the setting when the client admin saves it;
// if the contact's phone changes later, codes go by email until the setting is saved again, so
// editing a contact never redirects codes.
async function textableContact(tx: Tx, tenantId: string, email: string) {
  const [c] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.tenantId, tenantId), eq(contact.email, email.toLowerCase())))
    .limit(1);
  if (!c?.phone) return null;
  const block = consentBlock(
    {
      phone: c.phone,
      whatsapp: c.whatsapp,
      consent: (c.consent ?? {}) as ContactConsent,
      optedOutAt: c.optedOutAt,
    },
    "sms",
  );
  return block ? null : c;
}

async function textablePhone(tx: Tx, tenantId: string, email: string): Promise<string | null> {
  return (await textableContact(tx, tenantId, email))?.phone ?? null;
}

async function clientPerson(tx: Tx, tenantId: string, personId: string) {
  const [p] = await tx
    .select({ id: appUser.id, name: appUser.name, email: appUser.email })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(
      and(
        eq(membership.tenantId, tenantId),
        eq(membership.userId, personId),
        inArray(membership.role, ["client_admin", "client_user"]),
      ),
    );
  return p ?? null;
}

/**
 * Saves a connection's release setting. The client admin may change anything; the operator may
 * only turn it on from off (invariant 8's rule: only the client loosens this one).
 */
export async function setReleaseSetting(
  tx: Tx,
  input: {
    tenantId: string;
    row: ConnectionRow;
    body: SetRelease;
    by: "client" | "operator";
    actorId: string;
    now: Date;
  },
): Promise<ReleaseSetting> {
  const { tenantId, row, body, by, actorId, now } = input;
  const before = releaseOf(row.config);
  if (by === "operator") {
    if (body.mode === "off") {
      throw new HttpError(403, "client_only", "only the client admin can turn human release off");
    }
    if (before.mode === "code") {
      throw new HttpError(
        403,
        "client_only",
        "human release is on; only the client admin can change who releases it or for how long",
      );
    }
  }
  let next: ReleaseSetting;
  if (body.mode === "off") {
    next = { ...before, mode: "off", updatedAt: now.toISOString() };
  } else {
    const person = body.personId ? await clientPerson(tx, tenantId, body.personId) : null;
    if (!person) {
      throw new HttpError(422, "invalid_person", "pick a person of this client");
    }
    const channel = body.channel as ReleaseChannel;
    const phone = channel === "sms" ? await textablePhone(tx, tenantId, person.email) : null;
    if (channel === "sms" && !phone) {
      throw new HttpError(
        422,
        "no_phone",
        "we can't text this person: add them as a contact with their phone and text consent, or pick email",
      );
    }
    next = {
      mode: "code",
      personId: person.id,
      channel,
      window: body.window as ReleaseWindow,
      phone,
      updatedAt: now.toISOString(),
    };
  }
  await tx
    .update(connection)
    .set({ config: { ...(row.config ?? {}), release: next } })
    .where(and(eq(connection.id, row.id), eq(connection.tenantId, tenantId)));
  await logChange(tx, tenantId, row.id, actorId, {
    event: "setting",
    by,
    before: {
      mode: before.mode,
      personId: before.personId,
      channel: before.channel,
      window: before.window,
    },
    after: { mode: next.mode, personId: next.personId, channel: next.channel, window: next.window },
  });
  return next;
}

/** Releases that let an agent through now (a `run` release while its run is going). */
export async function liveReleases(
  tx: Tx,
  tenantId: string,
  options: { connectionId?: string; names: "service" | "agent"; now: Date },
): Promise<LiveRelease[]> {
  const rows = await tx
    .select({ r: accessRelease, a: agent, u: appUser, runStatus: run.status, c: connection })
    .from(accessRelease)
    .innerJoin(agent, and(eq(agent.id, accessRelease.agentId), eq(agent.tenantId, tenantId)))
    .innerJoin(appUser, eq(appUser.id, accessRelease.personId))
    .innerJoin(run, and(eq(run.id, accessRelease.runId), eq(run.tenantId, tenantId)))
    .innerJoin(
      connection,
      and(eq(connection.id, accessRelease.connectionId), eq(connection.tenantId, tenantId)),
    )
    .where(
      and(
        eq(accessRelease.tenantId, tenantId),
        eq(accessRelease.status, "released"),
        ...(options.connectionId ? [eq(accessRelease.connectionId, options.connectionId)] : []),
        or(
          gt(accessRelease.validUntil, options.now),
          and(
            isNull(accessRelease.validUntil),
            inArray(run.status, ["queued", "running", "waiting"]),
          ),
        ),
      ),
    )
    .orderBy(desc(accessRelease.releasedAt))
    .limit(200);
  return rows
    .filter(({ r, c }) =>
      // Only what the setting as it is now still honours (another person, a shorter window: no).
      releaseCovers(recordOf(r), releaseOf(c.config), {
        connectionId: r.connectionId,
        agentId: r.agentId,
        runId: r.runId,
        now: options.now,
      }),
    )
    .map(({ r, a, u }) => ({
      id: r.id,
      connectionId: r.connectionId,
      agentId: r.agentId,
      agentName: options.names === "service" ? serviceName(a) : a.name,
      person: { id: u.id, name: u.name },
      channel: r.channel,
      runId: r.validUntil ? null : r.runId,
      releasedAt: (r.releasedAt as Date).toISOString(),
      validUntil: r.validUntil?.toISOString() ?? null,
    }));
}

/** A connection's release setting and live releases, as both surfaces show them. */
export async function releaseView(
  tx: Tx,
  tenantId: string,
  row: ConnectionRow,
  options: { names: "service" | "agent"; now: Date },
): Promise<ReleaseView> {
  const s = releaseOf(row.config);
  const [person] = s.personId
    ? await tx
        .select({ id: appUser.id, name: appUser.name })
        .from(appUser)
        .where(eq(appUser.id, s.personId))
    : [];
  return {
    mode: s.mode,
    person: person ?? null,
    channel: s.channel,
    window: s.window,
    sentTo: s.channel === "sms" && s.phone ? maskPhone(s.phone) : null,
    updatedAt: s.updatedAt,
    live: await liveReleases(tx, tenantId, { connectionId: row.id, ...options }),
  };
}

/** Revokes a live release (the client admin): the agent needs a new code next time. */
export async function revokeRelease(
  tx: Tx,
  input: { tenantId: string; releaseId: string; actorId: string },
): Promise<ReleaseRow> {
  const [row] = await tx
    .select()
    .from(accessRelease)
    .where(and(eq(accessRelease.id, input.releaseId), eq(accessRelease.tenantId, input.tenantId)))
    .for("update");
  if (!row) throw notFound("release");
  if (row.status !== "released") {
    throw new HttpError(409, "not_live", "this release is not live");
  }
  await tx
    .update(accessRelease)
    .set({ status: "revoked", revokedBy: input.actorId })
    .where(and(eq(accessRelease.id, row.id), eq(accessRelease.tenantId, input.tenantId)));
  await logChange(tx, input.tenantId, row.connectionId, input.actorId, {
    event: "revoked",
    releaseId: row.id,
    agentId: row.agentId,
    runId: row.runId,
  });
  return row;
}

// ── Sending a code ──────────────────────────────────────────────────────────────────────────────

type Route =
  | { channel: "sms"; to: string; from: string; twilio: ConnectionRow }
  | { channel: "email"; to: string };

/**
 * Where this code goes: a text when the setting says text, the client has a number that may text
 * now (A2P approved for US numbers), and the person's contact still has the pinned phone, text
 * consent and no STOP, outside their quiet hours; otherwise an email to their sign-in address.
 */
// DECISION: a release text is a transactional message to the client's own person, but it still
// honours what the messaging code enforces: text consent, STOP, A2P and quiet hours. Where any of
// them stops a text, the code goes by email instead (email has no quiet hours), so a release is
// never blocked by them.
async function routeFor(
  tx: Tx,
  tenantId: string,
  setting: ReleaseSetting,
  person: { email: string },
  now: Date,
): Promise<Route> {
  const email: Route = { channel: "email", to: person.email.toLowerCase() };
  if (setting.channel !== "sms" || !setting.phone) return email;
  const [twilio] = await tx
    .select()
    .from(connection)
    .where(
      and(
        eq(connection.tenantId, tenantId),
        eq(connection.connector, TWILIO_CONNECTOR_ID),
        eq(connection.status, "connected"),
      ),
    )
    .limit(1);
  const from = twilio ? releaseTextSender(readTwilioConfig(twilio.config)) : null;
  if (!twilio || !from) return email;
  const c = await textableContact(tx, tenantId, person.email);
  if (!c?.phone || c.phone !== setting.phone) return email;
  // The client's quiet hours (as every text), then the person's own.
  const client = await messagingSettings(tx, tenantId);
  if (inQuietHours(now, client.timezone, client.quietHours)) return email;
  const hours = contactHours(reachContactOf(c), client);
  if (inQuietHours(now, hours.timezone, hours.quietHours)) return email;
  return { channel: "sms", to: c.phone, from, twilio };
}

function hex(id: string): string {
  return id.replace(/-/g, "");
}

/** The `+tag` of an email that carries a code: `rel` and the request's id. */
export function releaseReplyTag(releaseId: string): string {
  return `rel${hex(releaseId)}`;
}

/** Sends the code; throws (rolling the request back) when it can't. */
async function deliver(
  tx: Tx,
  deps: ReleaseDeps,
  tenantId: string,
  route: Route,
  input: { releaseId: string; text: string; locale: Locale },
) {
  if (route.channel === "sms") {
    const creds = twilioCredentialsOf(
      await (await connectionCredentials(tx, deps.secrets, route.twilio)).get(),
    );
    if (!creds) throw new Error("the client's Twilio connection has no credentials");
    await sendReleaseText(deps.fetch, creds, { from: route.from, to: route.to, body: input.text });
    return;
  }
  if (!deps.resend) throw new Error("codes can't be emailed here: no sending domain is set up");
  const forward = deps.forwardingDomain ? await forwardingAddress(tx, tenantId) : null;
  const replyTo = forward ? taggedReplyTo(forward, releaseReplyTag(input.releaseId)) : null;
  const words = RELEASE_WORDS[input.locale];
  const body = `${input.text}\n\n${replyTo ? words.replyOrEnter : words.enter}`;
  await resendRequest(
    deps.fetch,
    deps.resend.apiKey,
    "POST",
    "/emails",
    {
      from: `Mezonas <codes@${deps.resend.domain}>`,
      to: [route.to],
      subject: words.subject,
      text: body,
      ...(replyTo ? { reply_to: replyTo } : {}),
    },
    { "Idempotency-Key": `release-${input.releaseId}` },
  );
}

const titleFor = (locale: Locale, channel: ReleaseChannel, agentName: string, tool: string) =>
  RELEASE_WORDS[locale].title(channel, agentName, tool);

interface RequestContext {
  conn: ConnectionRow;
  setting: ReleaseSetting;
  person: { id: string; name: string | null; email: string };
  agentRow: typeof agent.$inferSelect;
  test: boolean;
  /** The person's language: their own choice, else the client's, else English. */
  locale: Locale;
}

/**
 * Makes one request: a new code, its HMAC stored, the code sent. Voids the pending request it
 * replaces (the item's current one, or the same connection, agent and run's).
 */
async function newRequest(
  tx: Tx,
  deps: ReleaseDeps,
  tenantId: string,
  ctx: RequestContext,
  runId: string,
  now: Date,
): Promise<{ release: ReleaseRow; route: Route }> {
  const voided = await tx
    .update(accessRelease)
    .set({ status: "void" })
    .where(
      and(
        eq(accessRelease.tenantId, tenantId),
        eq(accessRelease.connectionId, ctx.conn.id),
        eq(accessRelease.agentId, ctx.agentRow.id),
        eq(accessRelease.runId, runId),
        eq(accessRelease.status, "pending"),
      ),
    )
    .returning({ id: accessRelease.id });
  for (const v of voided) {
    await logChange(tx, tenantId, ctx.conn.id, null, {
      event: "void",
      releaseId: v.id,
      agentId: ctx.agentRow.id,
      runId,
    });
  }
  const route = await routeFor(tx, tenantId, ctx.setting, ctx.person, now);
  const code = generateReleaseCode();
  const keys = await codeKeys(deps.secrets);
  const id = uuidv7();
  const [release] = await tx
    .insert(accessRelease)
    .values({
      id,
      tenantId,
      connectionId: ctx.conn.id,
      agentId: ctx.agentRow.id,
      runId,
      personId: ctx.person.id,
      channel: route.channel,
      codeHash: await keys.hash(id, code),
      expiresAt: new Date(now.getTime() + RELEASE_CODE_TTL_MS),
    })
    .returning();
  if (!release) throw new Error("access_release insert returned nothing");
  await deliver(tx, deps, tenantId, route, {
    releaseId: id,
    text: releaseMessage({
      code,
      agent: serviceName(ctx.agentRow),
      tool: toolName(deps.platform, ctx.conn.connector),
      window: ctx.setting.window,
      test: ctx.test,
      locale: ctx.locale,
    }),
    locale: ctx.locale,
  });
  return { release, route };
}

async function requestContext(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  agentId: string,
  runId: string,
): Promise<RequestContext | { refused: string }> {
  const [conn] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.id, connectionId), eq(connection.tenantId, tenantId)));
  if (!conn) return { refused: "the connection is gone" };
  const setting = releaseOf(conn.config);
  const problem = releaseSettingProblem(setting);
  if (problem) return { refused: problem };
  const person = await clientPerson(tx, tenantId, setting.personId as string);
  if (!person) {
    return { refused: "the person named to release this connection is no longer with the client" };
  }
  const [agentRow] = await tx
    .select()
    .from(agent)
    .where(and(eq(agent.id, agentId), eq(agent.tenantId, tenantId)));
  const [r] = await tx
    .select({ mode: run.mode })
    .from(run)
    .where(and(eq(run.id, runId), eq(run.tenantId, tenantId)));
  if (!agentRow || !r) return { refused: "the run is gone" };
  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  // DECISION: the code message is written in the person's language (their own choice, else the
  // client's default, else English), from core's RELEASE_WORDS: the Worker writes it, and the
  // portal's message files are in the web bundle, which apps/api doesn't import (§1.18's pattern
  // for the timeline words).
  const locale = releaseLocale(userLanguage(t?.settings, person.id), clientLanguage(t?.settings));
  return { conn, setting, person, agentRow, test: r.mode === "test", locale };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a live release lets this agent use the connection now (true when it needs none). The one
 * check every path shares: the gate, approved writes, reach-out attempts, a call's tools and
 * inbound call answering.
 */
export async function releaseCoversTx(
  tx: Tx,
  tenantId: string,
  ask: {
    connection: { id: string; config: unknown };
    agentId: string;
    /** Null outside a run (an inbound call): only an hours release covers it. */
    runId: string | null;
    now: Date;
  },
): Promise<boolean> {
  const setting = releaseOf(ask.connection.config);
  if (setting.mode !== "code") return true;
  const rows = await tx
    .select()
    .from(accessRelease)
    .where(
      and(
        eq(accessRelease.tenantId, tenantId),
        eq(accessRelease.connectionId, ask.connection.id),
        eq(accessRelease.agentId, ask.agentId),
        eq(accessRelease.status, "released"),
      ),
    )
    .orderBy(desc(accessRelease.releasedAt))
    .limit(20);
  return rows.some((r) =>
    releaseCovers(recordOf(r), setting, {
      connectionId: ask.connection.id,
      agentId: ask.agentId,
      runId: ask.runId,
      now: ask.now,
    }),
  );
}

/**
 * For a call's tools: a live release lets a call through, but nothing on a call can wait for a
 * person's code, so it never asks for one (the call is refused instead).
 */
// DECISION: a call never asks for a release mid-call; it goes on only under one already live.
export function coverOnlyReleasePort(deps: Pick<ReleaseDeps, "db" | "now">): ReleasePort {
  const port = dbReleasePort(deps as ReleaseDeps);
  return {
    covers: port.covers,
    async request() {
      return {
        refused:
          "this connection needs a person to release it first, and that can't be asked for on a call",
      };
    },
  };
}

/** The runtime's port: whether a release covers a call, and a new request when none does. */
export function dbReleasePort(deps: ReleaseDeps): ReleasePort {
  const now = () => deps.now?.() ?? new Date();
  return {
    covers(tenantId, ask) {
      return withTenant(deps.db, tenantId, (tx) =>
        releaseCoversTx(tx, tenantId, {
          connection: ask.connection,
          agentId: ask.agentId,
          runId: ask.runId,
          now: now(),
        }),
      );
    },

    async request(tenantId, ask): Promise<ReleaseRequested | { refused: string }> {
      try {
        return await withTenant(deps.db, tenantId, async (tx) => {
          const ctx = await requestContext(tx, tenantId, ask.connection.id, ask.agentId, ask.runId);
          if ("refused" in ctx) return ctx;
          const at = now();
          // An open item of this connection, agent and run is closed: its request is voided.
          await tx
            .update(inboxItem)
            .set({ status: "expired" })
            .where(
              and(
                eq(inboxItem.tenantId, tenantId),
                eq(inboxItem.runId, ask.runId),
                eq(inboxItem.agentId, ctx.agentRow.id),
                eq(inboxItem.subjectType, RELEASE_SUBJECT),
                eq(inboxItem.status, "open"),
                sql`${inboxItem.payload}->'accessRelease'->>'connectionId' = ${ctx.conn.id}`,
              ),
            );
          const { release, route } = await newRequest(tx, deps, tenantId, ctx, ask.runId, at);
          const agentName = serviceName(ctx.agentRow);
          const tool = toolName(deps.platform, ctx.conn.connector);
          const [item] = await tx
            .insert(inboxItem)
            .values({
              tenantId,
              kind: "request",
              agentId: ctx.agentRow.id,
              subjectType: RELEASE_SUBJECT,
              subjectId: release.id,
              runId: ask.runId,
              assigneeUserId: ctx.person.id,
              assigneeRole: null,
              title: titleFor(ctx.locale, route.channel, agentName, tool),
              // Names only: never the code, the hash or where it went.
              payload: {
                accessRelease: {
                  connectionId: ctx.conn.id,
                  connector: ctx.conn.connector,
                  toolName: tool,
                  agentName,
                  tool: ask.toolId,
                  channel: route.channel,
                  window: ctx.setting.window,
                  resends: 0,
                },
                ...(ctx.test ? { testRun: true } : {}),
              },
              dueAt: release.expiresAt,
            })
            .returning({ id: inboxItem.id });
          if (!item) throw new Error("inbox item insert returned nothing");
          await logChange(tx, tenantId, ctx.conn.id, null, {
            event: "requested",
            releaseId: release.id,
            agentId: ctx.agentRow.id,
            runId: ask.runId,
            stepRunId: ask.stepRunId,
            tool: ask.toolId,
            personId: ctx.person.id,
            channel: route.channel,
            ...(ctx.test ? { testRun: true } : {}),
          });
          console.log("access release requested", {
            tenantId,
            connectionId: ctx.conn.id,
            releaseId: release.id,
            channel: route.channel,
          });
          return { releaseId: release.id, inboxItemId: item.id };
        });
      } catch (error) {
        console.error("access release request failed", { tenantId, error: errorText(error) });
        return { refused: `we couldn't send a code to release this: ${errorText(error)}` };
      }
    },
  };
}

// ── The person's request: view, code, re-send ───────────────────────────────────────────────────

interface RequestState {
  item: InboxRow;
  release: ReleaseRow;
  payload: {
    connectionId: string;
    connector: string;
    toolName: string;
    agentName: string;
    channel: ReleaseChannel;
    resends: number;
  };
}

function releasePayload(item: InboxRow): RequestState["payload"] | null {
  const p = isPlainObject(item.payload) ? item.payload.accessRelease : undefined;
  if (!isPlainObject(p)) return null;
  return {
    connectionId: String(p.connectionId ?? ""),
    connector: String(p.connector ?? ""),
    toolName: String(p.toolName ?? ""),
    agentName: String(p.agentName ?? ""),
    channel: p.channel === "sms" ? "sms" : "email",
    resends: typeof p.resends === "number" ? p.resends : 0,
  };
}

/** Whether an inbox item is a request for a code (the generic resolve route refuses these). */
export function isReleaseItem(item: Pick<InboxRow, "subjectType">): boolean {
  return item.subjectType === RELEASE_SUBJECT;
}

async function requestState(
  tx: Tx,
  tenantId: string,
  inboxItemId: string,
  lock: boolean,
): Promise<RequestState> {
  const q = tx
    .select()
    .from(inboxItem)
    .where(and(eq(inboxItem.id, inboxItemId), eq(inboxItem.tenantId, tenantId)));
  const [item] = lock ? await q.for("update") : await q;
  const payload = item ? releasePayload(item) : null;
  if (!item || !payload || !isReleaseItem(item) || !item.subjectId) {
    throw notFound("request for a code");
  }
  const rq = tx
    .select()
    .from(accessRelease)
    .where(and(eq(accessRelease.id, item.subjectId), eq(accessRelease.tenantId, tenantId)));
  const [release] = lock ? await rq.for("update") : await rq;
  if (!release) throw notFound("request for a code");
  return { item, release, payload };
}

async function sentToOf(tx: Tx, tenantId: string, release: ReleaseRow): Promise<string> {
  if (release.channel === "sms") {
    const [c] = await tx
      .select({ config: connection.config })
      .from(connection)
      .where(and(eq(connection.id, release.connectionId), eq(connection.tenantId, tenantId)));
    const phone = c ? releaseOf(c.config).phone : null;
    return phone ? maskPhone(phone) : "your phone";
  }
  const [u] = await tx
    .select({ email: appUser.email })
    .from(appUser)
    .where(eq(appUser.id, release.personId));
  return u ? maskEmail(u.email) : "your email";
}

async function viewOf(
  tx: Tx,
  tenantId: string,
  s: RequestState,
  viewer: string | null,
): Promise<ReleaseRequestView> {
  return {
    inboxItemId: s.item.id,
    status: s.release.status,
    agentName: s.payload.agentName,
    toolName: s.payload.toolName,
    channel: s.release.channel,
    sentTo: await sentToOf(tx, tenantId, s.release),
    expiresAt: s.release.expiresAt.toISOString(),
    triesLeft: Math.max(0, RELEASE_MAX_TRIES - s.release.tries),
    resendsLeft:
      s.item.status === "open" ? Math.max(0, RELEASE_MAX_RESENDS - s.payload.resends) : 0,
    mine: viewer !== null && viewer === s.release.personId,
  };
}

export async function releaseRequestView(
  tx: Tx,
  tenantId: string,
  inboxItemId: string,
  viewer: string,
): Promise<ReleaseRequestView> {
  return viewOf(tx, tenantId, await requestState(tx, tenantId, inboxItemId, false), viewer);
}

export interface Wake {
  runId: string;
  inboxItemId: string;
  by: string;
}

export type CodeResult = "released" | "wrong" | "expired" | "closed";

/**
 * A code entered for a request: in the portal by the person (`personId` is checked), or in a reply
 * from their own number or address (`personId` null: the sender was checked by the caller). Every
 * try is logged; the code never is.
 */
export async function enterReleaseCode(
  tx: Tx,
  deps: Pick<ReleaseDeps, "secrets">,
  input: {
    tenantId: string;
    inboxItemId: string;
    personId: string | null;
    code: string;
    via: "portal" | "sms" | "email";
    now: Date;
  },
): Promise<{ result: CodeResult; view: ReleaseRequestView; wake: Wake | null }> {
  const { tenantId, now } = input;
  const s = await requestState(tx, tenantId, input.inboxItemId, true);
  if (input.personId !== null && input.personId !== s.release.personId) {
    throw new HttpError(403, "not_yours", "only the person the code went to can enter it");
  }
  const person = s.release.personId;
  const code = normalizeCode(input.code);
  const keys = await codeKeys(deps.secrets);
  const matched =
    code !== null &&
    s.item.status === "open" &&
    (await keys.matches(s.release.id, code, s.release.codeHash));
  const o = s.item.status === "open" ? tryCode(recordOf(s.release), matched, now) : null;
  const where = and(eq(accessRelease.id, s.release.id), eq(accessRelease.tenantId, tenantId));
  const base = {
    releaseId: s.release.id,
    agentId: s.release.agentId,
    runId: s.release.runId,
    via: input.via,
  };
  let wake: Wake | null = null;
  let result: CodeResult = "closed";
  if (o?.kind === "released") {
    const [conn] = await tx
      .select({ config: connection.config })
      .from(connection)
      .where(and(eq(connection.id, s.release.connectionId), eq(connection.tenantId, tenantId)));
    const validUntil = validUntilFor(releaseOf(conn?.config).window, now);
    await tx
      .update(accessRelease)
      .set({ status: "released", releasedAt: now, validUntil })
      .where(where);
    const resolution: InboxResolution = { approved: true, answer: null, by: person };
    await tx
      .update(inboxItem)
      .set({
        status: "resolved",
        resolution: { ...resolution, release: "released", via: input.via },
        resolvedBy: person,
        resolvedAt: now,
      })
      .where(and(eq(inboxItem.id, s.item.id), eq(inboxItem.tenantId, tenantId)));
    await logChange(tx, tenantId, s.release.connectionId, person, {
      event: "released",
      ...base,
      validUntil: validUntil?.toISOString() ?? null,
    });
    wake = s.item.runId ? { runId: s.item.runId, inboxItemId: s.item.id, by: person } : null;
    result = "released";
  } else if (o?.kind === "wrong") {
    await tx.update(accessRelease).set({ tries: o.tries, status: o.status }).where(where);
    await logChange(tx, tenantId, s.release.connectionId, input.personId, {
      event: o.status === "failed" ? "failed" : "failed_try",
      ...base,
      tries: o.tries,
    });
    result = "wrong";
  } else if (o?.kind === "expired") {
    await tx.update(accessRelease).set({ status: "expired" }).where(where);
    await logChange(tx, tenantId, s.release.connectionId, null, { event: "expired", ...base });
    result = "expired";
  }
  console.log("access release code entered", {
    tenantId,
    releaseId: s.release.id,
    via: input.via,
    result,
  });
  const after = await requestState(tx, tenantId, input.inboxItemId, false);
  return { result, view: await viewOf(tx, tenantId, after, input.personId ?? person), wake };
}

/** A new code for an open request (only its person; at most 3 times while the step waits). */
export async function resendReleaseCode(
  tx: Tx,
  deps: ReleaseDeps,
  input: { tenantId: string; inboxItemId: string; personId: string; now: Date },
): Promise<ReleaseRequestView> {
  const { tenantId, now } = input;
  const s = await requestState(tx, tenantId, input.inboxItemId, true);
  if (input.personId !== s.release.personId) {
    throw new HttpError(403, "not_yours", "only the person the code went to can ask for a new one");
  }
  if (s.item.status !== "open" || !s.item.runId) {
    throw new HttpError(409, "closed", "the agent is no longer waiting for this code");
  }
  if (s.payload.resends >= RELEASE_MAX_RESENDS) {
    throw new HttpError(429, "no_resends_left", "no new codes left: the step will stop waiting");
  }
  const ctx = await requestContext(
    tx,
    tenantId,
    s.release.connectionId,
    s.release.agentId,
    s.release.runId,
  );
  if ("refused" in ctx) throw new HttpError(409, "not_available", ctx.refused);
  if (ctx.person.id !== s.release.personId) {
    throw new HttpError(409, "changed", "someone else releases this now");
  }
  const { release, route } = await newRequest(tx, deps, tenantId, ctx, s.release.runId, now);
  const payload = isPlainObject(s.item.payload) ? s.item.payload : {};
  await tx
    .update(inboxItem)
    .set({
      subjectId: release.id,
      dueAt: release.expiresAt,
      title: titleFor(ctx.locale, route.channel, s.payload.agentName, s.payload.toolName),
      payload: {
        ...payload,
        accessRelease: {
          ...(payload.accessRelease as Record<string, unknown>),
          channel: route.channel,
          resends: s.payload.resends + 1,
        },
      },
    })
    .where(and(eq(inboxItem.id, s.item.id), eq(inboxItem.tenantId, tenantId)));
  await logChange(tx, tenantId, s.release.connectionId, input.personId, {
    event: "resent",
    releaseId: release.id,
    replaces: s.release.id,
    agentId: s.release.agentId,
    runId: s.release.runId,
    channel: route.channel,
  });
  return releaseRequestView(tx, tenantId, s.item.id, input.personId);
}

/** Wakes the run a release was waiting on (best effort: the cron re-sends until it takes it). */
export async function wakeRelease(instances: RunInstances | undefined, wake: Wake | null) {
  if (!instances || !wake) return;
  try {
    await instances.sendEvent(wake.runId, {
      type: inboxEventType(wake.inboxItemId),
      payload: { approved: true, answer: null, by: wake.by } satisfies InboxResolution,
    });
  } catch (error) {
    console.error(`waking run ${wake.runId} for a release failed`, errorText(error));
  }
}

// ── Replies ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A text to one of the client's numbers that may carry a code: consumed here, before it is stored,
 * shown in a thread or seen by any agent, when it is only a code and either matches a pending
 * request's code or comes from the number of a person with a pending text request. Only a reply
 * from that person's own number (the phone pinned in the setting) releases; the right code from
 * anyone else is consumed and logged, never counted as theirs.
 */
// DECISION: a code from another number does not use the person's tries (anyone could burn them),
// but it is still consumed so the code is never stored in a thread.
export async function consumeTextReply(
  tx: Tx,
  deps: Pick<ReleaseDeps, "secrets">,
  input: { tenantId: string; from: string; text: string; now: Date },
): Promise<{ consumed: boolean; wake: Wake | null }> {
  const code = normalizeCode(input.text);
  if (!code) return { consumed: false, wake: null };
  const pending = await tx
    .select({ r: accessRelease, c: connection })
    .from(accessRelease)
    .innerJoin(
      connection,
      and(eq(connection.id, accessRelease.connectionId), eq(connection.tenantId, input.tenantId)),
    )
    .where(
      and(
        eq(accessRelease.tenantId, input.tenantId),
        eq(accessRelease.status, "pending"),
        eq(accessRelease.channel, "sms"),
      ),
    )
    .orderBy(desc(accessRelease.createdAt))
    .limit(50);
  if (pending.length === 0) return { consumed: false, wake: null };
  const keys = await codeKeys(deps.secrets);
  const fromPerson = pending.filter(({ c }) => releaseOf(c.config).phone === input.from);
  let matchedOther: ReleaseRow | null = null;
  for (const { r } of pending) {
    if (!(await keys.matches(r.id, code, r.codeHash))) continue;
    if (fromPerson.some((p) => p.r.id === r.id)) {
      const item = await itemFor(tx, input.tenantId, r.id);
      if (!item) continue;
      const out = await enterReleaseCode(tx, deps, {
        tenantId: input.tenantId,
        inboxItemId: item.id,
        personId: null,
        code,
        via: "sms",
        now: input.now,
      });
      return { consumed: true, wake: out.wake };
    }
    matchedOther = r;
  }
  if (matchedOther) {
    await logChange(tx, input.tenantId, matchedOther.connectionId, null, {
      event: "wrong_sender",
      releaseId: matchedOther.id,
      via: "sms",
    });
    console.warn("access release code texted from another number", {
      tenantId: input.tenantId,
      releaseId: matchedOther.id,
    });
    return { consumed: true, wake: null };
  }
  // The person's own number, but not the code: a wrong try on their newest request.
  const newest = fromPerson[0]?.r;
  if (newest) {
    const item = await itemFor(tx, input.tenantId, newest.id);
    if (item) {
      await enterReleaseCode(tx, deps, {
        tenantId: input.tenantId,
        inboxItemId: item.id,
        personId: null,
        code,
        via: "sms",
        now: input.now,
      });
    }
    return { consumed: true, wake: null };
  }
  return { consumed: false, wake: null };
}

async function itemFor(tx: Tx, tenantId: string, releaseId: string) {
  const [item] = await tx
    .select({ id: inboxItem.id })
    .from(inboxItem)
    .where(
      and(
        eq(inboxItem.tenantId, tenantId),
        eq(inboxItem.subjectType, RELEASE_SUBJECT),
        eq(inboxItem.subjectId, releaseId),
      ),
    )
    .limit(1);
  return item ?? null;
}

/**
 * An email to `<forwarding address>+rel<request id>`: a reply to a code email. Consumed whatever it
 * says (it is never forwarded mail); it releases only when it comes from the person's sign-in
 * address with DMARC passing for that address's domain, and its new text is the code alone.
 * Returns null when the address isn't a release tag.
 */
// DECISION: the inbound email path checks DMARC (the receiving server's Authentication-Results,
// which needs SPF or DKIM aligned with the From domain), so only the From header under a DMARC pass
// counts, never the envelope sender alone. The new text must be the code and nothing else, so an
// auto-reply or a forward that quotes our email can't release anything.
export async function receiveReleaseEmail(
  deps: Pick<ReleaseDeps, "db" | "secrets">,
  mail: { from: string; to: string; raw: Uint8Array },
  options: { domain: string; now: Date },
): Promise<{ tenantId: string; wake: Wake | null } | null> {
  const to = mail.to.trim().toLowerCase();
  const plus = /^([^@+]+)\+rel([0-9a-f]{32})@(.+)$/.exec(to);
  if (!plus) return null;
  const target = parseForwardingAddress(to, options.domain);
  if (!target) return null;
  const bare = `${plus[1]}@${plus[3]}`;
  const h = plus[2] as string;
  const releaseId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  const parsed = await parseReplyEmail(mail.raw).catch(() => null);
  const wake = await withTenant(deps.db, target.tenantId, async (tx) => {
    const stored = await forwardingAddress(tx, target.tenantId);
    if (!stored || !sameAddress(stored, bare)) return null;
    const [release] = await tx
      .select()
      .from(accessRelease)
      .where(and(eq(accessRelease.id, releaseId), eq(accessRelease.tenantId, target.tenantId)));
    if (!release) return null;
    const item = await itemFor(tx, target.tenantId, release.id);
    const [person] = await tx
      .select({ email: appUser.email })
      .from(appUser)
      .where(eq(appUser.id, release.personId));
    const fromPerson =
      parsed !== null &&
      person !== undefined &&
      parsed.from === person.email.toLowerCase() &&
      trustedFromHeader(parsed.from, parsed.dmarcPassFrom);
    const code = parsed ? normalizeCode(parsed.text) : null;
    if (!item || !fromPerson || !code || release.status !== "pending") {
      await logChange(tx, target.tenantId, release.connectionId, null, {
        event: "email_ignored",
        releaseId: release.id,
        reason: !fromPerson ? "sender" : !code ? "not_a_code" : "not_pending",
      });
      return { wake: null };
    }
    const out = await enterReleaseCode(tx, deps, {
      tenantId: target.tenantId,
      inboxItemId: item.id,
      personId: null,
      code,
      via: "email",
      now: options.now,
    });
    return { wake: out.wake };
  });
  if (wake === null) return null;
  return { tenantId: target.tenantId, wake: wake.wake };
}

// ── The waiting step ────────────────────────────────────────────────────────────────────────────

/** What a step waiting for a release carries between durable steps: ids only. */
export interface ReleaseWaitState {
  release: { inboxItemId: string; connectionId: string };
}

export function releaseWaitOf(state: unknown): ReleaseWaitState["release"] | null {
  const r = isPlainObject(state) ? state.release : undefined;
  if (
    !isPlainObject(r) ||
    typeof r.inboxItemId !== "string" ||
    typeof r.connectionId !== "string"
  ) {
    return null;
  }
  return { inboxItemId: r.inboxItemId, connectionId: r.connectionId };
}

/** A step waits on the person's inbox item until the code's expiry (a little longer, for clocks). */
export function releaseWaitOutcome(
  o: { inboxItemId: string; connectionId: string },
  expiresAt: Date | null,
  now: Date,
): StepOutcome {
  const ms = (expiresAt?.getTime() ?? now.getTime() + RELEASE_CODE_TTL_MS) - now.getTime();
  const seconds = Math.max(30, Math.ceil(ms / 1000) + 5);
  return {
    kind: "waiting",
    wait: {
      eventType: inboxEventType(o.inboxItemId),
      timeout: `${seconds} seconds`,
      state: {
        release: { inboxItemId: o.inboxItemId, connectionId: o.connectionId },
      } satisfies ReleaseWaitState,
      reason: "release",
    },
  };
}

/** The step's request as it is now (null when the item is gone). */
export async function currentRelease(db: Db, tenantId: string, inboxItemId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const [item] = await tx
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.id, inboxItemId), eq(inboxItem.tenantId, tenantId)));
    if (!item?.subjectId) return null;
    const [release] = await tx
      .select()
      .from(accessRelease)
      .where(and(eq(accessRelease.id, item.subjectId), eq(accessRelease.tenantId, tenantId)));
    return release ? { item, release } : null;
  });
}

export type AfterReleaseWait =
  | { kind: "released" }
  | { kind: "wait"; outcome: StepOutcome }
  | { kind: "failed"; error: string };

/**
 * After the wait (the event, the timeout or a check before waiting): released → the step runs
 * again; a pending code with time left (a new one was sent) → wait again; otherwise the step fails
 * `access_not_released`, its request is marked expired and its item closed.
 */
export async function afterReleaseWait(
  db: Db,
  tenantId: string,
  wait: ReleaseWaitState["release"],
  now: Date,
): Promise<AfterReleaseWait> {
  const cur = await currentRelease(db, tenantId, wait.inboxItemId);
  if (!cur) return { kind: "failed", error: "access_not_released: the request is gone" };
  const { item, release } = cur;
  if (release.status === "released") {
    await withTenant(db, tenantId, (tx) =>
      tx
        .update(inboxItem)
        .set({ runReceivedAt: now })
        .where(
          and(
            eq(inboxItem.id, item.id),
            eq(inboxItem.tenantId, tenantId),
            isNull(inboxItem.runReceivedAt),
          ),
        ),
    );
    return { kind: "released" };
  }
  if (release.status === "pending" && release.expiresAt.getTime() > now.getTime()) {
    return { kind: "wait", outcome: releaseWaitOutcome(wait, release.expiresAt, now) };
  }
  await withTenant(db, tenantId, async (tx) => {
    if (release.status === "pending") {
      const ended = await tx
        .update(accessRelease)
        .set({ status: "expired" })
        .where(
          and(
            eq(accessRelease.id, release.id),
            eq(accessRelease.tenantId, tenantId),
            eq(accessRelease.status, "pending"),
          ),
        )
        .returning({ id: accessRelease.id });
      if (ended.length > 0) {
        await logChange(tx, tenantId, release.connectionId, null, {
          event: "expired",
          releaseId: release.id,
          agentId: release.agentId,
          runId: release.runId,
        });
      }
    }
    await tx
      .update(inboxItem)
      .set({ status: "expired" })
      .where(
        and(
          eq(inboxItem.id, item.id),
          eq(inboxItem.tenantId, tenantId),
          eq(inboxItem.status, "open"),
        ),
      );
  });
  return {
    kind: "failed",
    error: `access_not_released: nobody entered the code for the ${release.channel === "sms" ? "texted" : "emailed"} request in time`,
  };
}

/** Whether there is nothing to wait for: released, or the code is no longer open. */
export async function releaseWaitDone(
  db: Db,
  tenantId: string,
  wait: ReleaseWaitState["release"],
  now: Date,
): Promise<boolean> {
  const cur = await currentRelease(db, tenantId, wait.inboxItemId);
  if (!cur) return true;
  return !(cur.release.status === "pending" && cur.release.expiresAt.getTime() > now.getTime());
}

/** The input a step ran with (`step_run.input`), to run it again once released. */
export async function stepInputOf(db: Db, tenantId: string, stepRunId: string): Promise<unknown> {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ input: stepRun.input })
      .from(stepRun)
      .where(and(eq(stepRun.id, stepRunId), eq(stepRun.tenantId, tenantId)));
    return row?.input ?? null;
  });
}

/** Whether an item may still be resolved the generic way (it can't, if it waits for a code). */
export function refuseGenericResolve(item: Pick<InboxRow, "subjectType">) {
  if (isReleaseItem(item)) {
    throw new HttpError(409, "enter_code", "enter the code we sent to release this");
  }
}
