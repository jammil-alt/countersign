import type { JsonObject } from "@countersign/core";
import { z } from "zod";
import {
  type Connector,
  defineConnector,
  defineReadTool,
  defineWriteTool,
  type ToolContext,
} from "../connector";
import { type FetchLike, formEncode, globalFetch, timeoutSignal } from "../http";
import {
  OAuthTokens,
  ReconnectRequiredError,
  type TokenRefresher,
  tokenManager,
} from "../oauth/tokens";
import { mapPodioField, type PodioField, plainFieldValue, podioFieldValues } from "./fields";

export { PodioField, PodioFieldError, podioFieldValues } from "./fields";

/**
 * "podio": Podio (Citrix) over OAuth 2.0 (ARCHITECTURE §6.8, owner 2026-11-04). The client signs in
 * to its own Podio from the portal; tokens are encrypted on the connection. Podio apps are built
 * by each client, so tools take fields generically (`{ <field external_id>: value }`) and check
 * them against the app's own definition when called. What was and wasn't checked: ./NOTES.md.
 */
export const PODIO_CONNECTOR_ID = "podio";
export const PODIO_TOOLS = {
  spaces: "podio.space.list",
  apps: "podio.app.list",
  app: "podio.app.get",
  filter: "podio.item.filter",
  get: "podio.item.get",
  create: "podio.item.create",
  update: "podio.item.update",
  comment: "podio.comment.create",
  task: "podio.task.create",
} as const;

const API = "https://api.podio.com";
const AUTHORIZE = "https://podio.com/oauth/authorize";

export const PodioCredentials = OAuthTokens.extend({
  /** Who signed in: Podio's `ref` on the token answer. */
  userId: z.number().int().optional(),
});

const TokenAnswer = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
  ref: z.looseObject({ type: z.string(), id: z.number().int() }).optional(),
});

export class PodioApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Rate limits (420) and server errors: the step's retry may get through. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PodioApiError";
  }
}

const Id = z.number().int().positive();

/** An item as tools return it: Podio's ids, title, revision, and its fields as plain values. */
export const PodioItem = z.object({
  itemId: z.number().int(),
  appId: z.number().int().nullable(),
  appItemId: z.number().int().nullable(),
  title: z.string().nullable(),
  link: z.string().nullable(),
  revision: z.number().int().nullable(),
  createdOn: z.string().nullable(),
  /** By field external id. */
  fields: z.record(z.string(), z.unknown()),
});
export type PodioItem = z.infer<typeof PodioItem>;

const RawItem = z.looseObject({
  item_id: z.number().int(),
  app_item_id: z.number().int().optional(),
  title: z.string().nullable().optional(),
  link: z.string().optional(),
  created_on: z.string().optional(),
  app: z.looseObject({ app_id: z.number().int() }).optional(),
  current_revision: z.looseObject({ revision: z.number().int() }).optional(),
  revision: z.number().int().optional(),
  fields: z
    .array(
      z.looseObject({ external_id: z.string(), type: z.string(), values: z.array(z.unknown()) }),
    )
    .optional(),
});

/** Podio's item JSON → PodioItem. */
export function mapPodioItem(raw: unknown): PodioItem {
  const r = RawItem.parse(raw);
  const fields: Record<string, unknown> = {};
  for (const f of r.fields ?? []) fields[f.external_id] = plainFieldValue(f);
  return PodioItem.parse({
    itemId: r.item_id,
    appId: r.app?.app_id ?? null,
    appItemId: r.app_item_id ?? null,
    title: r.title ?? null,
    link: r.link ?? null,
    revision: r.current_revision?.revision ?? r.revision ?? null,
    createdOn: r.created_on ?? null,
    fields,
  });
}

const PodioAppOut = z.object({
  appId: z.number().int(),
  spaceId: z.number().int().nullable(),
  name: z.string(),
  itemName: z.string().nullable(),
  fields: z.array(
    z.object({
      fieldId: z.number().int(),
      externalId: z.string(),
      type: z.string(),
      label: z.string(),
      required: z.boolean(),
      options: z.array(z.object({ id: z.number().int(), text: z.string() })).optional(),
      writable: z.boolean(),
    }),
  ),
});
const RawApp = z.looseObject({
  app_id: z.number().int(),
  space_id: z.number().int().optional(),
  status: z.string().optional(),
  config: z.looseObject({ name: z.string(), item_name: z.string().nullable().optional() }),
  fields: z.array(z.unknown()).optional(),
});

function mapApp(raw: unknown): z.infer<typeof PodioAppOut> {
  const a = RawApp.parse(raw);
  return {
    appId: a.app_id,
    spaceId: a.space_id ?? null,
    name: a.config.name,
    itemName: a.config.item_name ?? null,
    fields: (a.fields ?? []).map(mapPodioField).filter((f): f is PodioField => f !== null),
  };
}

const FieldsInput = z
  .record(
    z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "a Podio field external id, e.g. title"),
    z.unknown(),
  )
  .refine((f) => Object.keys(f).length > 0, "give at least one field")
  .refine((f) => Object.keys(f).length <= 100, "at most 100 fields");

export interface PodioOptions {
  /** The API key from Podio (client id and secret). */
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  fetch?: FetchLike;
}

export class PodioNotConfiguredError extends Error {
  constructor() {
    super("Podio sign-in is not set up on this deployment (PODIO_CLIENT_ID, PODIO_CLIENT_SECRET)");
    this.name = "PodioNotConfiguredError";
  }
}

export function createPodioConnector(options: PodioOptions = {}): Connector {
  const doFetch = (): FetchLike => options.fetch ?? globalFetch();
  const configured = Boolean(options.clientId && options.clientSecret);

  function client(): { id: string; secret: string } {
    if (!options.clientId || !options.clientSecret) throw new PodioNotConfiguredError();
    return { id: options.clientId, secret: options.clientSecret };
  }

  async function tokenCall(fields: Record<string, string>) {
    const c = client();
    const res = await doFetch()(`${API}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: formEncode({ ...fields, client_id: c.id, client_secret: c.secret }),
      redirect: "error",
      signal: timeoutSignal(15_000),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!res.ok) {
      const e = (body ?? {}) as { error?: unknown; error_description?: unknown };
      const error = typeof e.error === "string" ? e.error : `HTTP_${res.status}`;
      return { ok: false as const, status: res.status, error };
    }
    const parsed = TokenAnswer.safeParse(body);
    if (!parsed.success) {
      throw new PodioApiError(
        res.status,
        "bad_token_response",
        "Podio's token answer has an unexpected shape",
        false,
      );
    }
    return { ok: true as const, answer: parsed.data };
  }

  const expiresAt = (now: Date, seconds: number) =>
    new Date(now.getTime() + seconds * 1000).toISOString();

  const refresher: TokenRefresher = {
    async refresh(tokens, { now }) {
      if (!tokens.refreshToken) throw new ReconnectRequiredError("no refresh token");
      const r = await tokenCall({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
      });
      if (!r.ok) {
        if (r.status === 400 || r.status === 401) {
          // invalid_grant: revoked, or unused past its lifetime. The client signs in again.
          throw new ReconnectRequiredError(`Podio refused the refresh: ${r.error}`);
        }
        throw new PodioApiError(
          r.status,
          r.error,
          `Podio's token endpoint answered ${r.status}`,
          r.status >= 500,
        );
      }
      return {
        ...tokens,
        accessToken: r.answer.access_token,
        expiresAt: expiresAt(now, r.answer.expires_in),
        ...(r.answer.refresh_token ? { refreshToken: r.answer.refresh_token } : {}),
      };
    },
  };

  async function api(
    ctx: ToolContext,
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ) {
    const stored = PodioCredentials.safeParse(await ctx.credentials.get());
    if (!stored.success)
      throw new ReconnectRequiredError("the Podio connection has no valid credentials");
    const tokens = tokenManager({ credentials: ctx.credentials, refresher, now: ctx.now });
    const res = await tokens.withAccessToken(
      (token) =>
        doFetch()(`${API}${path}`, {
          method,
          headers: {
            authorization: `OAuth2 ${token}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal: timeoutSignal(20_000),
        }),
      (r) => r.status === 401,
    );
    if (res.status === 204) return null;
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status === 401) throw new ReconnectRequiredError("Podio refused the access token");
    if (!res.ok) {
      const e = (json ?? {}) as { error?: unknown; error_description?: unknown };
      const code = typeof e.error === "string" ? e.error : `HTTP_${res.status}`;
      const message =
        typeof e.error_description === "string"
          ? e.error_description
          : `Podio answered ${res.status}`;
      // Podio answers 420 when a rate limit is hit.
      throw new PodioApiError(
        res.status,
        code,
        message,
        res.status === 420 || res.status === 429 || res.status >= 500,
      );
    }
    return json;
  }

  async function appFields(ctx: ToolContext, appId: number): Promise<PodioField[]> {
    return mapApp(await api(ctx, "GET", `/app/${appId}`)).fields;
  }

  async function getItem(ctx: ToolContext, itemId: number): Promise<PodioItem | null> {
    try {
      return mapPodioItem(await api(ctx, "GET", `/item/${itemId}`));
    } catch (error) {
      if (error instanceof PodioApiError && (error.status === 404 || error.status === 410))
        return null;
      throw error;
    }
  }

  return defineConnector({
    id: PODIO_CONNECTOR_ID,
    name: "Podio",
    description: "Your Podio workspaces, apps and items. You sign in to Podio yourself.",
    icon: "grid",
    auth: "oauth2",
    entities: ["Organization", "Space", "App", "Item", "Comment", "Task"],
    isConfigured: () => configured,

    async authorize(req) {
      const c = client();
      // DECISION: no `scope` parameter: Podio then grants what the signing-in user can do, and the
      // connection's permission matrix and the approval gate limit what agents do with it.
      const query = formEncode({
        response_type: "code",
        client_id: c.id,
        redirect_uri: req.redirectUri,
        state: req.state,
      });
      return { redirectUrl: `${AUTHORIZE}?${query}` };
    },

    async handleCallback(params, req) {
      if (!params.code) throw new Error("the Podio callback has no code");
      const r = await tokenCall({
        grant_type: "authorization_code",
        code: params.code,
        redirect_uri: req.redirectUri,
      });
      if (!r.ok) throw new Error(`Podio refused the sign-in: ${r.error}`);
      if (!r.answer.refresh_token) throw new Error("Podio gave no refresh token");
      const now = new Date();
      const userId = r.answer.ref?.type === "user" ? r.answer.ref.id : undefined;
      const credentials = PodioCredentials.parse({
        accessToken: r.answer.access_token,
        refreshToken: r.answer.refresh_token,
        expiresAt: expiresAt(now, r.answer.expires_in),
        tokenType: "OAuth2",
        ...(r.answer.scope ? { scope: r.answer.scope } : {}),
        ...(userId === undefined ? {} : { userId }),
      });
      return {
        externalAccountId: userId === undefined ? null : `user:${userId}`,
        credentials: credentials as unknown as JsonObject,
        config: {},
      };
    },

    tokens: refresher,

    tools: [
      defineReadTool({
        id: PODIO_TOOLS.spaces,
        description: "List the Podio organizations and workspaces the connection can see.",
        summary: "Found {{spaces.length}} workspaces",
        input: z.object({}),
        output: z.object({
          spaces: z.array(
            z.object({
              spaceId: z.number().int(),
              name: z.string(),
              orgId: z.number().int(),
              orgName: z.string(),
            }),
          ),
        }),
        async run(_input, ctx) {
          const orgs = z
            .array(
              z.looseObject({
                org_id: z.number().int(),
                name: z.string(),
                spaces: z
                  .array(z.looseObject({ space_id: z.number().int(), name: z.string() }))
                  .default([]),
              }),
            )
            .parse(await api(ctx, "GET", "/org/"));
          return {
            spaces: orgs.flatMap((o) =>
              o.spaces.map((s) => ({
                spaceId: s.space_id,
                name: s.name,
                orgId: o.org_id,
                orgName: o.name,
              })),
            ),
          };
        },
      }),
      defineReadTool({
        id: PODIO_TOOLS.apps,
        description: "List the apps in a Podio workspace.",
        summary: "Found {{apps.length}} apps",
        input: z.object({ spaceId: Id }),
        output: z.object({
          apps: z.array(
            z.object({
              appId: z.number().int(),
              name: z.string(),
              itemName: z.string().nullable(),
            }),
          ),
        }),
        async run(input, ctx) {
          const apps = z
            .array(z.unknown())
            .parse(await api(ctx, "GET", `/app/space/${input.spaceId}/`));
          return {
            apps: apps
              .map((a) => RawApp.parse(a))
              .filter((a) => !a.status || a.status === "active")
              .map((a) => ({
                appId: a.app_id,
                name: a.config.name,
                itemName: a.config.item_name ?? null,
              })),
          };
        },
      }),
      defineReadTool({
        id: PODIO_TOOLS.app,
        description:
          "Get a Podio app with its fields (external ids, types, choices), to know what its items hold.",
        summary: "Read app {{app.name}}",
        input: z.object({ appId: Id }),
        output: z.object({ app: PodioAppOut }),
        async run(input, ctx) {
          return { app: mapApp(await api(ctx, "GET", `/app/${input.appId}`)) };
        },
      }),
      defineReadTool({
        id: PODIO_TOOLS.filter,
        description:
          "Find items in a Podio app, filtered by field values (keys are field external ids) and paged.",
        summary: "Found {{items.length}} of {{filtered}} items",
        input: z.object({
          appId: Id,
          /** By field external id, Podio's filter value for that field (e.g. a category option id). */
          filters: z.record(z.string(), z.unknown()).default({}),
          limit: z.number().int().min(1).max(100).default(20),
          offset: z.number().int().min(0).default(0),
          sortBy: z.string().max(100).optional(),
          sortDesc: z.boolean().optional(),
        }),
        output: z.object({
          total: z.number().int(),
          filtered: z.number().int(),
          items: z.array(PodioItem),
        }),
        async run(input, ctx) {
          // Podio's filters key fields by id: the app's definition turns external ids into ids.
          const fields =
            Object.keys(input.filters).length > 0 ? await appFields(ctx, input.appId) : [];
          const filters: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(input.filters)) {
            const f = fields.find((x) => x.externalId === key);
            if (!f)
              throw new PodioApiError(400, "unknown_field", `the app has no field ${key}`, false);
            filters[String(f.fieldId)] = value;
          }
          const body = z
            .looseObject({
              total: z.number().int(),
              filtered: z.number().int(),
              items: z.array(z.unknown()),
            })
            .parse(
              await api(ctx, "POST", `/item/app/${input.appId}/filter/`, {
                limit: input.limit,
                offset: input.offset,
                filters,
                ...(input.sortBy ? { sort_by: input.sortBy } : {}),
                ...(input.sortDesc === undefined ? {} : { sort_desc: input.sortDesc }),
              }),
            );
          return {
            total: body.total,
            filtered: body.filtered,
            items: body.items.map((i) => {
              const item = mapPodioItem(i);
              return { ...item, appId: item.appId ?? input.appId };
            }),
          };
        },
      }),
      defineReadTool({
        id: PODIO_TOOLS.get,
        description: "Get one Podio item with its field values.",
        summary: "Read item {{item.title}}",
        input: z.object({ itemId: Id }),
        output: z.object({ item: PodioItem.nullable() }),
        async run(input, ctx) {
          return { item: await getItem(ctx, input.itemId) };
        },
      }),
      defineWriteTool({
        id: PODIO_TOOLS.create,
        description:
          "Create an item in a Podio app. Fields by external id; checked against the app's fields.",
        verb: "create",
        summary: "Created item {{title}}",
        input: z.object({
          appId: Id,
          fields: FieldsInput,
          /** An id from another system, to find the item by later. */
          externalId: z.string().min(1).max(200).optional(),
        }),
        output: z.object({
          itemId: z.number().int(),
          title: z.string().nullable(),
          link: z.string().nullable(),
        }),
        beforeSchema: z.object({}),
        async before() {
          return null;
        },
        async run(input, ctx) {
          const fields = podioFieldValues(await appFields(ctx, input.appId), input.fields, {
            create: true,
          });
          // DECISION: the item's external_id defaults to the external action's key, so a retried
          // create can be recognised in Podio (`GET /item/app/{app}/external_id/{key}`).
          const externalId = input.externalId ?? ctx.idempotencyKey;
          const existing = await findByExternalId(ctx, input.appId, externalId);
          if (existing)
            return { itemId: existing.itemId, title: existing.title, link: existing.link };
          const out = z
            .looseObject({
              item_id: z.number().int(),
              title: z.string().nullable().optional(),
              link: z.string().optional(),
            })
            .parse(
              await api(ctx, "POST", `/item/app/${input.appId}/`, {
                fields,
                external_id: externalId,
              }),
            );
          return { itemId: out.item_id, title: out.title ?? null, link: out.link ?? null };
        },
      }),
      defineWriteTool({
        id: PODIO_TOOLS.update,
        description:
          "Change fields of a Podio item. Give the revision you read to refuse the change if the item changed since.",
        verb: "update",
        summary: "Updated item {{itemId}}",
        input: z.object({
          itemId: Id,
          fields: FieldsInput,
          expectedRevision: z.number().int().optional(),
        }),
        output: z.object({ itemId: z.number().int(), revision: z.number().int().nullable() }),
        // What the change replaces: the item's current values of the fields it sets.
        beforeSchema: z.object({
          itemId: z.number().int(),
          appId: z.number().int().nullable(),
          revision: z.number().int().nullable(),
          fields: z.record(z.string(), z.unknown()),
        }),
        async before(input, ctx) {
          const item = await getItem(ctx, input.itemId);
          if (!item) return null;
          const fields: Record<string, unknown> = {};
          for (const k of Object.keys(input.fields)) fields[k] = item.fields[k] ?? null;
          return { itemId: item.itemId, appId: item.appId, revision: item.revision, fields };
        },
        async run(input, ctx, before) {
          if (!before)
            throw new PodioApiError(404, "not_found", `item ${input.itemId} not found`, false);
          if (
            input.expectedRevision !== undefined &&
            before.revision !== null &&
            before.revision !== input.expectedRevision
          ) {
            throw new PodioApiError(
              409,
              "stale",
              `item ${input.itemId} changed since it was read`,
              false,
            );
          }
          if (before.appId === null) {
            throw new PodioApiError(404, "not_found", `item ${input.itemId} has no app`, false);
          }
          const fields = podioFieldValues(await appFields(ctx, before.appId), input.fields, {
            create: false,
          });
          const out = z
            .looseObject({ revision: z.number().int().optional() })
            .nullable()
            .parse(
              await api(ctx, "PUT", `/item/${input.itemId}`, {
                fields,
                ...(before.revision === null ? {} : { revision: before.revision }),
              }),
            );
          return { itemId: input.itemId, revision: out?.revision ?? null };
        },
      }),
      defineWriteTool({
        id: PODIO_TOOLS.comment,
        description: "Add a comment to a Podio item.",
        verb: "create",
        summary: "Commented on item {{itemId}}",
        input: z.object({ itemId: Id, text: z.string().min(1).max(10_000) }),
        output: z.object({ itemId: z.number().int(), commentId: z.number().int() }),
        beforeSchema: z.object({}),
        async before() {
          return null;
        },
        async run(input, ctx) {
          const out = z.looseObject({ comment_id: z.number().int() }).parse(
            await api(ctx, "POST", `/comment/item/${input.itemId}`, {
              value: input.text,
              external_id: ctx.idempotencyKey,
            }),
          );
          return { itemId: input.itemId, commentId: out.comment_id };
        },
      }),
      defineWriteTool({
        id: PODIO_TOOLS.task,
        description: "Create a Podio task, optionally on an item.",
        verb: "create",
        summary: "Created task {{taskId}}",
        input: z.object({
          text: z.string().min(1).max(400),
          description: z.string().max(10_000).optional(),
          dueDate: z.iso.date().optional(),
          itemId: Id.optional(),
        }),
        output: z.object({ taskId: z.number().int(), link: z.string().nullable() }),
        beforeSchema: z.object({}),
        async before() {
          return null;
        },
        async run(input, ctx) {
          const task: Record<string, unknown> = {
            text: input.text,
            external_id: ctx.idempotencyKey,
          };
          if (input.description) task.description = input.description;
          if (input.dueDate) task.due_date = input.dueDate;
          if (input.itemId) {
            task.ref_type = "item";
            task.ref_id = input.itemId;
          }
          const out = z
            .looseObject({ task_id: z.number().int(), link: z.string().optional() })
            .parse(await api(ctx, "POST", "/task/", task));
          return { taskId: out.task_id, link: out.link ?? null };
        },
      }),
    ],
  });

  async function findByExternalId(ctx: ToolContext, appId: number, externalId: string) {
    try {
      return mapPodioItem(
        await api(ctx, "GET", `/item/app/${appId}/external_id/${encodeURIComponent(externalId)}`),
      );
    } catch (error) {
      if (error instanceof PodioApiError && (error.status === 404 || error.status === 410))
        return null;
      throw error;
    }
  }
}
