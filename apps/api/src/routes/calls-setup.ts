// Calls setup for a client, in the back office only (docs/plan.md §1.23): turning calls on (our
// voice webhooks stored with the client's Twilio connection), sending a number's incoming calls to
// us, where unanswered calls are forwarded, who answers now (the same check the webhook makes), and
// the client's recent calls. Every change is logged to connection_change. Never an agent tool: an
// agent can't change its own setup (invariant 9).

import {
  type FetchLike,
  globalFetch,
  readTwilioConfig,
  readVoiceConfig,
  setNumberVoice,
  TWILIO_CONNECTOR_ID,
  TwilioError,
  type TwilioVoiceConfig,
  twilioCredentialsOf,
  twilioVoiceUrls,
} from "@countersign/connectors";
import {
  type CallsSetup,
  type PermissionMatrix,
  routes,
  trimTrailingSlashes,
} from "@countersign/core";
import { connection, connectionChange, type Tx, tenant } from "@countersign/db";
import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { planInbound, voiceDepsFromEnv, voiceToolsUrl } from "../calls/answer";
import { recentCalls } from "../calls/store";
import type { Bindings } from "../env";
import { type AppContext, type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";
import { connectionCredentials } from "../secrets";

type ConnectionRow = typeof connection.$inferSelect;
type Services = { env: Bindings; deps: { fetch?(env: Bindings): FetchLike } };

function fetchFor(services: Services): FetchLike {
  return services.deps.fetch?.(services.env) ?? globalFetch();
}

function originOf(c: AppContext, env: Bindings): string {
  return trimTrailingSlashes(env.APP_ORIGIN?.trim() || new URL(c.req.url).origin);
}

async function twilioConnection(tx: Tx, tenantId: string): Promise<ConnectionRow | undefined> {
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, TWILIO_CONNECTOR_ID)))
    .orderBy(desc(connection.createdAt))
    .limit(1);
  return row;
}

async function setupOf(c: AppContext, tx: Tx, services: Services, tenantId: string) {
  const [t] = await tx.select({ id: tenant.id }).from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  const origin = originOf(c, services.env);
  const voiceDeps = voiceDepsFromEnv(services.env, fetchFor(services), origin);
  const row = await twilioConnection(tx, tenantId);
  const config = row ? readTwilioConfig(row.config) : null;
  const voice = row ? readVoiceConfig(row.config) : null;
  const urls = voice?.webhooks ?? twilioVoiceUrls(origin, tenantId);
  const inbound =
    row && voice
      ? await planInbound(tx, {
          tenantId,
          connectionId: row.id,
          permissions: row.permissions as Partial<PermissionMatrix>,
          config: row.config,
          forwardTo: voice.forwardTo,
          voice: voiceDeps,
        })
      : null;
  const setup: CallsSetup = {
    available: voiceDeps.elevenlabs !== null,
    twilio: Boolean(row && config && row.status === "connected"),
    enabled: voice !== null,
    forwardTo: voice?.forwardTo ?? null,
    numbers: (config?.numbers ?? []).map((n) => ({
      sid: n.sid,
      phoneNumber: n.phoneNumber,
      voice: n.capabilities.voice,
      answering: voice?.answering.includes(n.sid) ?? false,
    })),
    inbound: inbound
      ? {
          decision: inbound.decision,
          agentId: inbound.answering?.agentId ?? null,
          agentName: inbound.answering?.agentName ?? null,
          reason: inbound.reason,
        }
      : null,
    webhooks: {
      ...urls,
      tools: voiceToolsUrl(origin, tenantId),
      postCall: `${origin}/api/elevenlabs/post-call`,
    },
  };
  return { setup, calls: await recentCalls(tx, tenantId) };
}

/** The connected Twilio connection and its subaccount's credentials. */
async function connected(tx: Tx, env: Bindings, tenantId: string) {
  const row = await twilioConnection(tx, tenantId);
  const config = row ? readTwilioConfig(row.config) : null;
  if (!row || !config || row.status !== "connected") {
    throw new HttpError(409, "not_provisioned", "set up the client's Twilio subaccount first");
  }
  const auth = twilioCredentialsOf(await (await connectionCredentials(tx, env, row)).get());
  if (!auth)
    throw new HttpError(409, "not_provisioned", "the subaccount's credentials are missing");
  return { row, config, auth };
}

async function saveVoice(
  tx: Tx,
  row: ConnectionRow,
  voice: TwilioVoiceConfig | null,
  actorId: string,
  change: Record<string, unknown>,
) {
  const { voice: _old, ...rest } = (row.config ?? {}) as Record<string, unknown>;
  await tx
    .update(connection)
    .set({ config: voice ? { ...rest, voice } : rest })
    .where(and(eq(connection.id, row.id), eq(connection.tenantId, row.tenantId)));
  await tx.insert(connectionChange).values({
    tenantId: row.tenantId,
    connectionId: row.id,
    actorId,
    change: { by: "operator", ...change },
  });
}

async function twilio<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof TwilioError) {
      throw new HttpError(502, "twilio_error", `Twilio: ${error.message}`, {
        status: error.status,
        code: error.code,
      });
    }
    throw error;
  }
}

/**
 * Points each number that can take calls at our voice webhook; the sids now sending calls to us.
 * Also used when a number is bought while calls are on (routes/messaging-setup.ts).
 */
export async function takeCalls(
  fetch: FetchLike,
  auth: { accountSid: string; authToken: string },
  numbers: readonly { sid: string; capabilities: { voice: boolean } }[],
  webhooks: { voice: string; status: string },
): Promise<string[]> {
  const taken: string[] = [];
  for (const n of numbers) {
    if (!n.capabilities.voice) continue;
    await twilio(() => setNumberVoice(fetch, auth, n.sid, webhooks));
    taken.push(n.sid);
  }
  return taken;
}

export function callsSetupRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsCalls, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return setupOf(ctx.c, ctx.tx, ctx.services, ctx.params.id);
  });

  mount(app, routes.opsCallsSettings, async (ctx) => {
    const tenantId = ctx.params.id;
    ensureClient(ctx, tenantId);
    const { row, config, auth } = await connected(ctx.tx, ctx.services.env, tenantId);
    const current = readVoiceConfig(row.config);
    if (ctx.body.enabled) {
      const webhooks =
        current?.webhooks ?? twilioVoiceUrls(originOf(ctx.c, ctx.services.env), tenantId);
      // DECISION (owner, 2026-11-13): turning calls on points every number that can take calls at
      // us. A number with nothing set to answer is refused by the carriers ("your call cannot be
      // completed as dialed") and never reaches Twilio's logs; ours answers with the agent, the
      // forward or voicemail (planInbound). The operator can still stop a number taking calls.
      const answering = current
        ? current.answering
        : await takeCalls(fetchFor(ctx.services), auth, config.numbers, webhooks);
      const voice: TwilioVoiceConfig = {
        enabledAt: current?.enabledAt ?? new Date().toISOString(),
        forwardTo: ctx.body.forwardTo,
        webhooks,
        answering,
      };
      await saveVoice(ctx.tx, row, voice, ctx.session.user.id, {
        kind: current ? "calls_forwarding" : "calls_on",
        forwardTo: ctx.body.forwardTo,
        ...(current ? {} : { numbers: answering.length }),
      });
    } else {
      if (!current) throw new HttpError(409, "no_op", "calls are already off");
      // Turning calls off stops the numbers sending their calls to us first.
      for (const sid of current.answering) {
        await twilio(() => setNumberVoice(fetchFor(ctx.services), auth, sid, null));
      }
      await saveVoice(ctx.tx, row, null, ctx.session.user.id, { kind: "calls_off" });
    }
    return setupOf(ctx.c, ctx.tx, ctx.services, tenantId);
  });

  mount(app, routes.opsCallsNumber, async (ctx) => {
    const tenantId = ctx.params.id;
    ensureClient(ctx, tenantId);
    const { row, config, auth } = await connected(ctx.tx, ctx.services.env, tenantId);
    const voice = readVoiceConfig(row.config);
    if (!voice) throw new HttpError(409, "calls_off", "turn calls on for this client first");
    const n = config.numbers.find((x) => x.sid === ctx.params.sid);
    if (!n) throw notFound("number");
    if (ctx.body.answering && !n.capabilities.voice) {
      throw new HttpError(422, "no_voice", "this number doesn't take calls");
    }
    const on = voice.answering.includes(n.sid);
    if (on === ctx.body.answering) throw new HttpError(409, "no_op", "nothing to change");
    await twilio(() =>
      setNumberVoice(
        fetchFor(ctx.services),
        auth,
        n.sid,
        ctx.body.answering ? { voice: voice.webhooks.voice, status: voice.webhooks.status } : null,
      ),
    );
    await saveVoice(
      ctx.tx,
      row,
      {
        ...voice,
        answering: ctx.body.answering
          ? [...voice.answering, n.sid]
          : voice.answering.filter((s) => s !== n.sid),
      },
      ctx.session.user.id,
      { kind: "calls_number", number: n.phoneNumber, answering: ctx.body.answering },
    );
    return setupOf(ctx.c, ctx.tx, ctx.services, tenantId);
  });
}
