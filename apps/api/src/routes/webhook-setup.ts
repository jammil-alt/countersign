// The client's setup of its webhook connection (ARCHITECTURE §6.6): inbound hooks (a URL with its
// own secret to paste into a Zap) and the outbound URL events are sent to. Client admins only:
// these responses carry the secrets, and only the client's portal ever shows them. The operator
// sees hook names and the outbound host in the connection's config, never a token or URL.

import {
  addHook,
  hookUrl,
  readWebhookConfig,
  readWebhookCredentials,
  removeHook,
  setOutbound,
  WEBHOOK_CONNECTOR_ID,
  type WebhookConfig,
  type WebhookCredentials,
  WebhookSetupError,
} from "@countersign/connectors";
import { type JsonObject, routes } from "@countersign/core";
import { connection, connectionChange, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { Bindings } from "../env";
import { type AppContext, type AppEnv, HttpError, mount, notFound } from "../http";
import { connectionCredentials } from "../secrets";

type Row = typeof connection.$inferSelect;

async function webhookConnection(tx: Tx, tenantId: string, id: string): Promise<Row> {
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.id, id), eq(connection.tenantId, tenantId)));
  if (!row || row.connector !== WEBHOOK_CONNECTOR_ID) throw notFound("webhook connection");
  if (row.status !== "connected") {
    throw new HttpError(409, "not_connected", "connect webhooks first");
  }
  return row;
}

function originOf(c: AppContext, env: Bindings): string {
  return env.APP_ORIGIN?.trim() || new URL(c.req.url).origin;
}

function view(
  c: AppContext,
  env: Bindings,
  row: Row,
  config: WebhookConfig,
  credentials: WebhookCredentials,
) {
  const origin = originOf(c, env);
  return {
    hooks: config.hooks.flatMap((h) => {
      const token = credentials.tokens[h.id];
      return token
        ? [
            {
              id: h.id,
              name: h.name,
              url: hookUrl(origin, row.tenantId, h.id, token),
              createdAt: h.createdAt,
            },
          ]
        : [];
    }),
    outbound: credentials.outbound
      ? {
          url: credentials.outbound.url,
          host: config.outbound?.host ?? "",
          signingSecret: credentials.outbound.signingSecret,
          setAt: config.outbound?.setAt ?? null,
        }
      : null,
  };
}

async function load(tx: Tx, env: Bindings, row: Row) {
  const accessor = await connectionCredentials(tx, env, row);
  return {
    accessor,
    config: readWebhookConfig(row.config),
    credentials: readWebhookCredentials(await accessor.get()),
  };
}

/** Saves config and credentials together, with a `connection_change` that names what changed. */
async function save(
  tx: Tx,
  row: Row,
  actorId: string,
  next: { config: WebhookConfig; credentials: WebhookCredentials },
  accessor: Awaited<ReturnType<typeof connectionCredentials>>,
  change: JsonObject,
) {
  await accessor.set(next.credentials as unknown as JsonObject);
  await tx
    .update(connection)
    .set({ config: next.config as unknown as Record<string, unknown> })
    .where(and(eq(connection.id, row.id), eq(connection.tenantId, row.tenantId)));
  await tx.insert(connectionChange).values({
    tenantId: row.tenantId,
    connectionId: row.id,
    actorId,
    change: { by: "client", ...change },
  });
}

function setupError(error: unknown): never {
  if (error instanceof WebhookSetupError) throw new HttpError(422, error.code, error.message);
  throw error;
}

export function webhookSetupRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.portalWebhook, async ({ c, tx, tenantIds, params, services }) => {
    const row = await webhookConnection(tx, tenantIds[0] as string, params.id);
    const { config, credentials } = await load(tx, services.env, row);
    return view(c, services.env, row, config, credentials);
  });

  mount(
    app,
    routes.portalWebhookAddHook,
    async ({ c, tx, tenantIds, params, body, session, services }) => {
      const row = await webhookConnection(tx, tenantIds[0] as string, params.id);
      const state = await load(tx, services.env, row);
      let next: ReturnType<typeof addHook>;
      try {
        next = addHook(state, body.name, new Date());
      } catch (error) {
        setupError(error);
      }
      await save(tx, row, session.user.id, next, state.accessor, {
        kind: "webhook_hook_added",
        hookId: next.hook.id,
        name: next.hook.name,
      });
      return view(c, services.env, row, next.config, next.credentials);
    },
  );

  mount(
    app,
    routes.portalWebhookRemoveHook,
    async ({ c, tx, tenantIds, params, session, services }) => {
      const row = await webhookConnection(tx, tenantIds[0] as string, params.id);
      const state = await load(tx, services.env, row);
      const next = removeHook(state, params.hookId);
      if (!next.removed) throw notFound("hook");
      await save(tx, row, session.user.id, next, state.accessor, {
        kind: "webhook_hook_removed",
        hookId: next.removed.id,
        name: next.removed.name,
      });
      return view(c, services.env, row, next.config, next.credentials);
    },
  );

  mount(
    app,
    routes.portalWebhookOutbound,
    async ({ c, tx, tenantIds, params, body, session, services }) => {
      const row = await webhookConnection(tx, tenantIds[0] as string, params.id);
      const state = await load(tx, services.env, row);
      let next: ReturnType<typeof setOutbound>;
      try {
        next = setOutbound(state, body.url, new Date());
      } catch (error) {
        setupError(error);
      }
      await save(tx, row, session.user.id, next, state.accessor, {
        kind: "webhook_outbound",
        // The host only: the URL itself is a secret.
        host: next.config.outbound?.host ?? null,
      });
      return view(c, services.env, row, next.config, next.credentials);
    },
  );
}
