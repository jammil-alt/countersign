// Texting setup for a client, in the back office only (docs/plan.md §1.22): the client's Twilio
// subaccount under Mezonas' account, its numbers (searched, bought and released here, never by an
// agent: a number costs money and agents can't change their own setup), its WhatsApp sender, A2P
// 10DLC registration as tracked status, and quiet hours. Every change is logged to
// connection_change. The subaccount's credentials are encrypted in the connection; the main
// account's are deployment secrets and never stored.

import {
  buyNumber,
  createSubaccount,
  type FetchLike,
  fetchA2pStatus,
  fetchSubaccount,
  globalFetch,
  readTwilioConfig,
  releaseNumber,
  searchNumbers,
  TWILIO_CONNECTOR_ID,
  type TwilioAuth,
  type TwilioConfig,
  TwilioError,
  twilioCredentialsOf,
  twilioWebhookUrls,
} from "@countersign/connectors";
import { A2pRegistration, type MessagingSetup, routes } from "@countersign/core";
import { connection, connectionChange, type Tx, tenant } from "@countersign/db";
import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Bindings } from "../env";
import { type AppContext, type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";
// P-8: US texting registration by API (docs/plan.md §1.70)
import {
  a2pWithoutRegistration,
  joinService,
  opsView,
  pollRegistration,
  registrationOf,
  rollupFees,
  submitRegistration,
} from "../messaging/a2p";
import { messagingSettingsOf } from "../messaging/contacts";
import { cipherFor, connectionCredentials } from "../secrets";
import { newConnectionMatrix } from "./ops-connectors";

type ConnectionRow = typeof connection.$inferSelect;
type Services = { env: Bindings; deps: { fetch?(env: Bindings): FetchLike } };

function fetchFor(services: Services): FetchLike {
  return services.deps.fetch?.(services.env) ?? globalFetch();
}

function mainAccount(env: Bindings): TwilioAuth | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  return accountSid && authToken ? { accountSid, authToken } : null;
}

function originOf(c: AppContext, env: Bindings): string {
  return env.APP_ORIGIN?.trim() || new URL(c.req.url).origin;
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

async function setupOf(
  c: AppContext,
  tx: Tx,
  env: Bindings,
  tenantId: string,
): Promise<{ setup: MessagingSetup }> {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  const row = await twilioConnection(tx, tenantId);
  const config = row ? readTwilioConfig(row.config) : null;
  return {
    setup: {
      available: mainAccount(env) !== null,
      ...messagingSettingsOf(t),
      twilio:
        row && config
          ? {
              connectionId: row.id,
              status: row.status,
              subaccountSid: config.subaccountSid,
              numbers: config.numbers,
              // P-8: the stored registration stays out; its view is below.
              a2p: a2pWithoutRegistration(config.a2p),
              registration: opsView(config, env),
            }
          : null,
      webhooks: config?.webhooks ?? twilioWebhookUrls(originOf(c, env), tenantId),
    },
  };
}

/** The connected Twilio connection, its config and the subaccount's credentials. */
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

async function saveConfig(
  tx: Tx,
  row: ConnectionRow,
  config: TwilioConfig,
  actorId: string,
  change: Record<string, unknown>,
) {
  await tx
    .update(connection)
    .set({ config: config as unknown as Record<string, unknown> })
    .where(and(eq(connection.id, row.id), eq(connection.tenantId, row.tenantId)));
  await tx.insert(connectionChange).values({
    tenantId: row.tenantId,
    connectionId: row.id,
    actorId,
    change: { by: "operator", ...change },
  });
}

/** Twilio's refusals as 502s with its message; everything else as it was. */
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

export function messagingSetupRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsMessaging, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return setupOf(ctx.c, ctx.tx, ctx.services.env, ctx.params.id);
  });

  mount(app, routes.opsMessagingSettings, async (ctx) => {
    const tenantId = ctx.params.id;
    ensureClient(ctx, tenantId);
    const [t] = await ctx.tx.select().from(tenant).where(eq(tenant.id, tenantId));
    if (!t) throw notFound("client");
    const settings = (t.settings ?? {}) as Record<string, unknown>;
    const messaging = (settings.messaging ?? {}) as Record<string, unknown>;
    await ctx.tx
      .update(tenant)
      .set({
        settings: { ...settings, messaging: { ...messaging, quietHours: ctx.body.quietHours } },
      })
      .where(eq(tenant.id, tenantId));
    return setupOf(ctx.c, ctx.tx, ctx.services.env, tenantId);
  });

  mount(app, routes.opsTwilioProvision, async (ctx) => {
    const { tx, services, session } = ctx;
    const tenantId = ctx.params.id;
    ensureClient(ctx, tenantId);
    const main = mainAccount(services.env);
    if (!main) {
      throw new HttpError(503, "not_configured", "Mezonas' Twilio account isn't set up here yet");
    }
    // Credentials can be stored before Twilio is asked for anything.
    await cipherFor(services.env);
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
    if (!t) throw notFound("client");
    const existing = await twilioConnection(tx, tenantId);
    const existingConfig = existing ? readTwilioConfig(existing.config) : null;
    if (existing?.status === "connected" && existingConfig) {
      throw new HttpError(
        409,
        "already_provisioned",
        "this client already has its Twilio subaccount",
      );
    }
    const fetch = fetchFor(services);
    // DECISION: a disconnected client keeps its subaccount and numbers; reconnecting reads the
    // subaccount's credentials back with the main account rather than making a new one.
    const creds = await twilio(() =>
      existingConfig
        ? fetchSubaccount(fetch, main, existingConfig.subaccountSid)
        : createSubaccount(fetch, main, `Mezonas - ${t.name}`),
    );
    const config: TwilioConfig = existingConfig ?? {
      subaccountSid: creds.accountSid,
      numbers: [],
      a2p: A2pRegistration.parse({
        brandSid: null,
        messagingServiceSid: null,
        brandStatus: null,
        campaignStatus: null,
        status: "not_started",
        checkedAt: null,
      }),
      webhooks: twilioWebhookUrls(originOf(ctx.c, services.env), tenantId),
      provisionedAt: new Date().toISOString(),
    };
    let row: ConnectionRow | undefined = existing;
    if (existing) {
      await tx
        .update(connection)
        .set({
          status: "connected",
          externalAccountId: creds.accountSid,
          connectedBy: session.user.id,
        })
        .where(and(eq(connection.id, existing.id), eq(connection.tenantId, tenantId)));
    } else {
      const connector = services.platform.connectors.get(TWILIO_CONNECTOR_ID);
      [row] = await tx
        .insert(connection)
        .values({
          tenantId,
          connector: TWILIO_CONNECTOR_ID,
          status: "connected",
          externalAccountId: creds.accountSid,
          config: config as unknown as Record<string, unknown>,
          // v0.12 W2-A: the operator's default access for new clients, else the connector's.
          permissions: await newConnectionMatrix(tx, connector?.manifest),
          connectedBy: session.user.id,
        })
        .returning();
    }
    if (!row) throw new Error("connection insert returned nothing");
    await (await connectionCredentials(tx, services.env, row)).set({ ...creds });
    await tx.insert(connectionChange).values({
      tenantId,
      connectionId: row.id,
      actorId: session.user.id,
      change: {
        kind: "status",
        by: "operator",
        before: existing?.status ?? null,
        after: "connected",
        account: creds.accountSid,
      },
    });
    return setupOf(ctx.c, tx, services.env, tenantId);
  });

  mount(app, routes.opsTwilioAvailableNumbers, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const { auth } = await connected(ctx.tx, ctx.services.env, ctx.params.id);
    const items = await twilio(() =>
      searchNumbers(fetchFor(ctx.services), auth, {
        country: ctx.query.country,
        areaCode: ctx.query.areaCode,
        contains: ctx.query.contains,
      }),
    );
    return { items };
  });

  mount(app, routes.opsTwilioBuyNumber, async (ctx) => {
    const tenantId = ctx.params.id;
    ensureClient(ctx, tenantId);
    const { row, config, auth } = await connected(ctx.tx, ctx.services.env, tenantId);
    if (config.numbers.some((n) => n.phoneNumber === ctx.body.phoneNumber)) {
      throw new HttpError(409, "no_op", "the client has that number already");
    }
    const [t] = await ctx.tx
      .select({ name: tenant.name })
      .from(tenant)
      .where(eq(tenant.id, tenantId));
    const bought = await twilio(() =>
      buyNumber(fetchFor(ctx.services), auth, {
        phoneNumber: ctx.body.phoneNumber,
        smsUrl: config.webhooks.messages,
        friendlyName: t?.name ?? "Mezonas client",
        now: new Date(),
      }),
    );
    // P-8: once the client's campaign is verified, a new number joins its Messaging Service.
    const joined = await twilio(() =>
      joinService(
        fetchFor(ctx.services),
        auth,
        { ...config, numbers: [...config.numbers, bought] },
        bought,
      ),
    );
    await saveConfig(ctx.tx, row, joined, ctx.session.user.id, {
      kind: "number_bought",
      number: bought.phoneNumber,
      sid: bought.sid,
    });
    return setupOf(ctx.c, ctx.tx, ctx.services.env, tenantId);
  });

  mount(app, routes.opsTwilioReleaseNumber, async (ctx) => {
    const tenantId = ctx.params.id;
    ensureClient(ctx, tenantId);
    const { row, config, auth } = await connected(ctx.tx, ctx.services.env, tenantId);
    const n = config.numbers.find((x) => x.sid === ctx.params.sid);
    if (!n) throw notFound("number");
    await twilio(() => releaseNumber(fetchFor(ctx.services), auth, n.sid));
    await saveConfig(
      ctx.tx,
      row,
      {
        ...config,
        numbers: config.numbers.filter((x) => x.sid !== n.sid),
        // P-8: a released number leaves the Messaging Service with it.
        ...(config.a2p.registration
          ? {
              a2p: {
                ...config.a2p,
                registration: {
                  ...config.a2p.registration,
                  serviceNumbers: config.a2p.registration.serviceNumbers.filter((x) => x !== n.sid),
                },
              },
            }
          : {}),
      },
      ctx.session.user.id,
      { kind: "number_released", number: n.phoneNumber, sid: n.sid },
    );
    return setupOf(ctx.c, ctx.tx, ctx.services.env, tenantId);
  });

  mount(app, routes.opsTwilioNumberWhatsApp, async (ctx) => {
    const tenantId = ctx.params.id;
    ensureClient(ctx, tenantId);
    const { row, config } = await connected(ctx.tx, ctx.services.env, tenantId);
    const n = config.numbers.find((x) => x.sid === ctx.params.sid);
    if (!n) throw notFound("number");
    if (n.whatsapp === ctx.body.enabled) throw new HttpError(409, "no_op", "nothing to change");
    await saveConfig(
      ctx.tx,
      row,
      {
        ...config,
        numbers: config.numbers.map((x) =>
          x.sid === n.sid ? { ...x, whatsapp: ctx.body.enabled } : x,
        ),
      },
      ctx.session.user.id,
      { kind: "whatsapp_sender", number: n.phoneNumber, enabled: ctx.body.enabled },
    );
    return setupOf(ctx.c, ctx.tx, ctx.services.env, tenantId);
  });

  mount(app, routes.opsTwilioA2p, async (ctx) => {
    const tenantId = ctx.params.id;
    ensureClient(ctx, tenantId);
    const { row, config } = await connected(ctx.tx, ctx.services.env, tenantId);
    // P-8: a registration Mezonas submitted by API keeps its own SIDs.
    if (registrationOf(config).stage !== "draft") {
      throw new HttpError(
        409,
        "registered_by_api",
        "this client's registration is Mezonas' own, by API",
      );
    }
    const { brandSid, messagingServiceSid } = ctx.body;
    const a2p = A2pRegistration.parse({
      brandSid,
      messagingServiceSid,
      brandStatus: null,
      campaignStatus: null,
      status: brandSid || messagingServiceSid ? "pending" : "not_started",
      checkedAt: null,
      // P-8: the client's details (a draft) stay.
      ...(config.a2p.registration ? { registration: config.a2p.registration } : {}),
    });
    await saveConfig(ctx.tx, row, { ...config, a2p }, ctx.session.user.id, {
      kind: "a2p",
      brandSid,
      messagingServiceSid,
    });
    return setupOf(ctx.c, ctx.tx, ctx.services.env, tenantId);
  });

  mount(app, routes.opsTwilioA2pRefresh, async (ctx) => {
    const tenantId = ctx.params.id;
    ensureClient(ctx, tenantId);
    const { row, config, auth } = await connected(ctx.tx, ctx.services.env, tenantId);
    // P-8: a registration by API: the cron's pass, now.
    const polled = await pollRegistration(ctx.tx, ctx.services.env, {
      row,
      config,
      auth,
      fetch: fetchFor(ctx.services),
      now: new Date(),
    });
    if (polled) return setupOf(ctx.c, ctx.tx, ctx.services.env, tenantId);
    if (!config.a2p.brandSid && !config.a2p.messagingServiceSid) {
      throw new HttpError(409, "a2p_not_started", "record the brand and Messaging Service first");
    }
    const a2p = await twilio(() =>
      fetchA2pStatus(fetchFor(ctx.services), auth, config.a2p, new Date()),
    );
    await saveConfig(ctx.tx, row, { ...config, a2p }, ctx.session.user.id, {
      kind: "a2p_checked",
      status: a2p.status,
      brandStatus: a2p.brandStatus,
      campaignStatus: a2p.campaignStatus,
    });
    return setupOf(ctx.c, ctx.tx, ctx.services.env, tenantId);
  });

  // P-8: the operator submits the client's details to Twilio, fees confirmed (docs/plan.md §1.70).
  mount(app, routes.opsA2pSubmit, async (ctx) => {
    const tenantId = ctx.params.id;
    ensureClient(ctx, tenantId);
    const { row, config, auth } = await connected(ctx.tx, ctx.services.env, tenantId);
    const now = new Date();
    await submitRegistration(ctx.tx, ctx.services.env, {
      row,
      config,
      auth,
      fetch: fetchFor(ctx.services),
      actor: { id: ctx.session.user.id, label: ctx.session.user.name ?? ctx.session.user.email },
      reason: ctx.body.reason,
      campaign: ctx.body.campaign,
      now,
    });
    await rollupFees(ctx.tx, tenantId, now);
    return setupOf(ctx.c, ctx.tx, ctx.services.env, tenantId);
  });
}
