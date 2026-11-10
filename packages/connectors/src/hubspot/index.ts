// "hubspot": HubSpot CRM over OAuth 2.0 (ARCHITECTURE §6.11, order 4). The client signs in to its
// own HubSpot from the portal (a public app's authorization code flow); tokens are encrypted on the
// connection. Reads search and get contacts, companies and deals; writes create and update them,
// add notes and create tasks, each an external action behind approval with its before state. No
// delete scope, no delete tool. Unchecked facts about HubSpot: ./NOTES.md.

import type { JsonObject } from "@countersign/core";
import { z } from "zod";
import {
  type ConnectionContext,
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

export const HUBSPOT_CONNECTOR_ID = "hubspot";
export const HUBSPOT_TOOLS = {
  search: "hubspot.record.search",
  get: "hubspot.record.get",
  create: "hubspot.record.create",
  update: "hubspot.record.update",
  note: "hubspot.note.create",
  task: "hubspot.task.create",
} as const;

export const HUBSPOT_AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize";
export const HUBSPOT_API = "https://api.hubapi.com";

/** The record types agents may work in. */
export const HubspotObjectType = z.enum(["contacts", "companies", "deals"]);
export type HubspotObjectType = z.infer<typeof HubspotObjectType>;

// v0.12 W3-B: the record tools work on any of the three types; the entity is the one their
// `objectType` names (as Zoho's `module`, docs/plan.md §1.44).
export const HUBSPOT_OBJECT_ENTITY = {
  field: "objectType",
  values: { contacts: "contact", companies: "company", deals: "deal" },
} satisfies { field: string; values: Record<HubspotObjectType, string> };

// DECISION: read and write on contacts, companies and deals (notes and tasks are created against
// them, NOTES.md), plus `oauth`, which HubSpot requires of every app. No delete exists as a scope
// apart from write, so no tool deletes and the matrix keeps delete off.
export const HUBSPOT_SCOPES: readonly string[] = [
  "oauth",
  ...HubspotObjectType.options.flatMap((t) => [`crm.objects.${t}.read`, `crm.objects.${t}.write`]),
];

/** HUBSPOT_DEFINED association type ids from a note or a task to each record type (NOTES.md). */
const ASSOCIATION_TYPE = {
  notes: { contacts: 202, companies: 190, deals: 214 },
  tasks: { contacts: 204, companies: 192, deals: 216 },
} as const satisfies Record<"notes" | "tasks", Record<HubspotObjectType, number>>;

/** The singular names HubSpot's search uses for association filters (`associations.contact`). */
const ASSOCIATION_FILTER: Record<HubspotObjectType, string> = {
  contacts: "associations.contact",
  companies: "associations.company",
  deals: "associations.deal",
};

/** The properties returned when the call names none: enough to know the record. */
const DEFAULT_PROPERTIES: Record<HubspotObjectType, readonly string[]> = {
  contacts: ["firstname", "lastname", "email", "phone", "company", "jobtitle", "lifecyclestage"],
  companies: ["name", "domain", "phone", "city", "state", "country", "industry"],
  deals: ["dealname", "amount", "dealstage", "pipeline", "closedate"],
};

/** The property that names a record, for finding a record a create would repeat. */
const KEY_PROPERTIES: Record<HubspotObjectType, readonly string[]> = {
  contacts: ["email"],
  companies: ["domain", "name"],
  deals: ["dealname"],
};

/** A create that finds its twin made within this long is this action's own earlier write. */
const TWIN_WINDOW_MS = 24 * 60 * 60 * 1000;

export const HubspotCredentials = OAuthTokens.extend({
  /** The HubSpot account (portal) the tokens are for. */
  hubId: z.number().int().optional(),
});
export type HubspotCredentials = z.infer<typeof HubspotCredentials>;

const TokenAnswer = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.string().optional(),
});

export class HubspotApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** 429 and 5xx: the step's retry with backoff may get through. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "HubspotApiError";
  }
}

export class HubspotNotConfiguredError extends Error {
  constructor() {
    super(
      "HubSpot sign-in is not set up on this deployment (HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET)",
    );
    this.name = "HubspotNotConfiguredError";
  }
}

// ── Records ──────────────────────────────────────────────────────────────────────────────────────

const RecordId = z.string().regex(/^\d{1,30}$/, "a HubSpot record id (digits)");
/** Names that must never be keys we assign (prototype pollution). */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PropertyName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,99}$/, "a HubSpot property's internal name, e.g. lastname")
  .refine((n) => !UNSAFE_KEYS.has(n), "not a property name");
const PropertyValue = z.union([z.string().max(65_536), z.number(), z.boolean(), z.null()]);
const Properties = z
  .record(PropertyName, PropertyValue)
  .refine((p) => Object.keys(p).length > 0, "give at least one property")
  .refine((p) => Object.keys(p).length <= 100, "at most 100 properties")
  .refine((p) => !("hs_object_id" in p), "the record id is not a property");

/**
 * A HubSpot record as tools return it. Its properties are what people and other tools wrote in the
 * client's CRM: data, never instructions (invariant 9).
 */
export const HubspotRecord = z.object({
  id: z.string(),
  objectType: HubspotObjectType,
  properties: z.record(z.string(), z.string().nullable()),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type HubspotRecord = z.infer<typeof HubspotRecord>;

const RawRecord = z.looseObject({
  id: z.union([z.string(), z.number()]),
  properties: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
});

/** HubSpot's record JSON → HubspotRecord. Property values are strings (or null) in HubSpot. */
export function mapHubspotRecord(objectType: HubspotObjectType, raw: unknown): HubspotRecord {
  const r = RawRecord.parse(raw);
  // Keys come from HubSpot's answer: built with fromEntries (no assignment by key) and without
  // the names that could reach an object's prototype.
  const properties: Record<string, string | null> = Object.fromEntries(
    Object.entries(r.properties ?? {})
      .filter(([k]) => k !== "hs_object_id" && !UNSAFE_KEYS.has(k))
      .map(([k, v]) => [k, v === null || v === undefined ? null : String(v)]),
  );
  return HubspotRecord.parse({
    id: String(r.id),
    objectType,
    properties,
    createdAt: r.createdAt ?? null,
    updatedAt: r.updatedAt ?? null,
  });
}

/** How a value reads in HubSpot, where every property is text. */
function asText(v: string | number | boolean | null): string | null {
  return v === null ? null : String(v);
}

/** Note text as HubSpot's HTML body: markup in the text stays text. */
export function noteBodyHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SearchAnswer = z.looseObject({
  total: z.number().int().optional(),
  results: z.array(z.unknown()),
  paging: z
    .looseObject({ next: z.looseObject({ after: z.string() }).optional() })
    .nullable()
    .optional(),
});

const Filter = z.object({
  propertyName: z.string(),
  operator: z.string(),
  value: z.string().optional(),
});
type Filter = z.infer<typeof Filter>;

// ── The connector ────────────────────────────────────────────────────────────────────────────────

export interface HubspotOptions {
  /** The OAuth client of Mezonas' HubSpot public app. */
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  fetch?: FetchLike;
}

export function createHubspotConnector(options: HubspotOptions = {}): Connector {
  const doFetch = (): FetchLike => options.fetch ?? globalFetch();
  const configured = Boolean(options.clientId && options.clientSecret);

  function client(): { id: string; secret: string } {
    if (!options.clientId || !options.clientSecret) throw new HubspotNotConfiguredError();
    return { id: options.clientId, secret: options.clientSecret };
  }

  function parseJson(text: string): unknown {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  async function tokenCall(fields: Record<string, string>) {
    const c = client();
    const res = await doFetch()(`${HUBSPOT_API}/oauth/v1/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: formEncode({ ...fields, client_id: c.id, client_secret: c.secret }),
      redirect: "manual",
      signal: timeoutSignal(15_000),
    });
    const body = parseJson(await res.text());
    if (!res.ok) {
      const e = (body ?? {}) as { error?: unknown; status?: unknown };
      const error =
        typeof e.error === "string"
          ? e.error
          : typeof e.status === "string"
            ? e.status
            : `HTTP_${res.status}`;
      return { ok: false as const, status: res.status, error };
    }
    const parsed = TokenAnswer.safeParse(body);
    if (!parsed.success) {
      throw new HubspotApiError(
        res.status,
        "bad_token_response",
        "HubSpot's token answer has an unexpected shape",
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
          // BAD_REFRESH_TOKEN / invalid_grant: the app was uninstalled or the token revoked.
          throw new ReconnectRequiredError(`HubSpot refused the refresh: ${r.error}`);
        }
        throw new HubspotApiError(
          r.status,
          r.error,
          `HubSpot's token endpoint answered ${r.status}`,
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
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const stored = HubspotCredentials.safeParse(await ctx.credentials.get());
    if (!stored.success)
      throw new ReconnectRequiredError("the HubSpot connection has no valid credentials");
    const tokens = tokenManager({ credentials: ctx.credentials, refresher, now: ctx.now });
    const res = await tokens.withAccessToken(
      (token) =>
        doFetch()(`${HUBSPOT_API}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "manual",
          signal: timeoutSignal(20_000),
        }),
      (r) => r.status === 401,
    );
    if (res.status === 204) return null;
    const json = parseJson(await res.text());
    if (res.status === 401) throw new ReconnectRequiredError("HubSpot refused the access token");
    if (!res.ok) {
      const e = (json ?? {}) as { category?: unknown; message?: unknown };
      const code = typeof e.category === "string" ? e.category : `HTTP_${res.status}`;
      const message = typeof e.message === "string" ? e.message : `HubSpot answered ${res.status}`;
      throw new HubspotApiError(res.status, code, message, res.status === 429 || res.status >= 500);
    }
    return json;
  }

  function propertiesFor(objectType: HubspotObjectType, extra: readonly string[] = []): string[] {
    return [...new Set([...DEFAULT_PROPERTIES[objectType], ...extra])];
  }

  async function getRecord(
    ctx: ToolContext,
    objectType: HubspotObjectType,
    id: string,
    properties: readonly string[] = [],
  ): Promise<HubspotRecord | null> {
    try {
      const q = formEncode({ properties: propertiesFor(objectType, properties).join(",") });
      return mapHubspotRecord(
        objectType,
        await api(ctx, "GET", `/crm/v3/objects/${objectType}/${encodeURIComponent(id)}?${q}`),
      );
    } catch (error) {
      if (error instanceof HubspotApiError && error.status === 404) return null;
      throw error;
    }
  }

  async function search(
    ctx: ToolContext,
    objectType: string,
    body: {
      filters?: Filter[];
      query?: string;
      properties: string[];
      limit: number;
      after?: string;
    },
  ) {
    return SearchAnswer.parse(
      await api(ctx, "POST", `/crm/v3/objects/${objectType}/search`, {
        ...(body.filters?.length ? { filterGroups: [{ filters: body.filters }] } : {}),
        ...(body.query ? { query: body.query } : {}),
        properties: body.properties,
        limit: body.limit,
        ...(body.after ? { after: body.after } : {}),
      }),
    );
  }

  /** Made since this instant: a create that finds one like itself treats it as its own. */
  const twinSince = (ctx: ToolContext) => String(ctx.now().getTime() - TWIN_WINDOW_MS);

  /** A note or task like this one, made within the window, on the same record (or none). */
  async function findTwin(
    ctx: ToolContext,
    kind: "notes" | "tasks",
    on: { objectType: HubspotObjectType; recordId: string } | null,
    match: Record<string, string>,
  ): Promise<string | null> {
    const [keyName, keyValue] = Object.entries(match)[0] ?? [];
    const filters: Filter[] = [
      { propertyName: "hs_createdate", operator: "GTE", value: twinSince(ctx) },
      ...(on
        ? [{ propertyName: ASSOCIATION_FILTER[on.objectType], operator: "EQ", value: on.recordId }]
        : []),
      // Long text can't be an equality filter (NOTES.md): a task's subject narrows; a note's body
      // is compared below.
      ...(kind === "tasks" && keyName && keyValue !== undefined
        ? [{ propertyName: keyName, operator: "EQ", value: keyValue }]
        : []),
    ];
    const found = await search(ctx, kind, {
      filters,
      properties: Object.keys(match),
      limit: 100,
    });
    for (const raw of found.results) {
      const r = RawRecord.parse(raw);
      const props = r.properties ?? {};
      if (Object.entries(match).every(([k, v]) => String(props[k] ?? "") === v))
        return String(r.id);
    }
    return null;
  }

  const SearchFilter = z.object({
    property: PropertyName,
    operator: z.enum([
      "EQ",
      "NEQ",
      "LT",
      "LTE",
      "GT",
      "GTE",
      "CONTAINS_TOKEN",
      "HAS_PROPERTY",
      "NOT_HAS_PROPERTY",
    ]),
    value: z.string().max(500).optional(),
  });

  const Attach = z.object({ objectType: HubspotObjectType, recordId: RecordId });
  const AttachedTo = z.object({
    objectType: HubspotObjectType,
    id: z.string(),
    /** What names the record on the approval card (a contact's name, a company's, a deal's). */
    name: z.string().nullable(),
  });

  function nameOf(r: HubspotRecord): string | null {
    const p = r.properties;
    if (r.objectType === "contacts") {
      const full = [p.firstname, p.lastname].filter(Boolean).join(" ");
      return full || p.email || null;
    }
    return (r.objectType === "deals" ? p.dealname : p.name) ?? null;
  }

  return defineConnector({
    id: HUBSPOT_CONNECTOR_ID,
    name: "HubSpot",
    description:
      "Contacts, companies and deals in your HubSpot, with notes and tasks. You sign in to HubSpot yourself.",
    icon: "users",
    auth: "oauth2",
    entities: ["Contact", "Company", "Deal", "Note", "Task"],
    // v0.12 W3-B: record types for the matrix (docs/plan.md §1.44, §1.52). The record tools read
    // theirs from the input's `objectType` (HUBSPOT_OBJECT_ENTITY).
    permissionEntities: [
      { id: "contact", label: "Contacts", verbs: ["read", "create", "update"] },
      { id: "company", label: "Companies", verbs: ["read", "create", "update"] },
      { id: "deal", label: "Deals", verbs: ["read", "create", "update"] },
      { id: "note", label: "Notes", verbs: ["create"] },
      { id: "task", label: "Tasks", verbs: ["create"] },
    ],
    isConfigured: () => configured,

    async authorize(req) {
      const c = client();
      const query = formEncode({
        client_id: c.id,
        redirect_uri: req.redirectUri,
        scope: HUBSPOT_SCOPES.join(" "),
        state: req.state,
      });
      return { redirectUrl: `${HUBSPOT_AUTHORIZE_URL}?${query}` };
    },

    async handleCallback(params, req) {
      if (!params.code) throw new Error("the HubSpot callback has no code");
      const r = await tokenCall({
        grant_type: "authorization_code",
        code: params.code,
        redirect_uri: req.redirectUri,
      });
      if (!r.ok) throw new Error(`HubSpot refused the sign-in: ${r.error}`);
      if (!r.answer.refresh_token) throw new Error("HubSpot gave no refresh token");
      // The account the tokens are for names the connection; a failure here fails the sign-in.
      const res = await doFetch()(
        `${HUBSPOT_API}/oauth/v1/access-tokens/${encodeURIComponent(r.answer.access_token)}`,
        {
          headers: { accept: "application/json" },
          redirect: "manual",
          signal: timeoutSignal(15_000),
        },
      );
      const info = z
        .looseObject({
          hub_id: z.number().int(),
          hub_domain: z.string().nullable().optional(),
          scopes: z.array(z.string()).optional(),
        })
        .safeParse(parseJson(await res.text()));
      if (!res.ok || !info.success) throw new Error("could not read the HubSpot account");
      const now = new Date();
      const credentials = HubspotCredentials.parse({
        accessToken: r.answer.access_token,
        refreshToken: r.answer.refresh_token,
        expiresAt: expiresAt(now, r.answer.expires_in),
        tokenType: r.answer.token_type ?? "bearer",
        ...(info.data.scopes ? { scope: info.data.scopes.join(" ") } : {}),
        hubId: info.data.hub_id,
      });
      return {
        externalAccountId: String(info.data.hub_id),
        credentials: credentials as unknown as JsonObject,
        config: info.data.hub_domain ? { hubDomain: info.data.hub_domain } : {},
      };
    },

    tokens: refresher,

    async revoke(ctx: ConnectionContext) {
      const creds = HubspotCredentials.safeParse(await ctx.credentials.get());
      if (!creds.success || !creds.data.refreshToken) return;
      await doFetch()(
        `${HUBSPOT_API}/oauth/v1/refresh-tokens/${encodeURIComponent(creds.data.refreshToken)}`,
        { method: "DELETE", redirect: "manual", signal: timeoutSignal(15_000) },
      );
    },

    tools: [
      defineReadTool({
        id: HUBSPOT_TOOLS.search,
        entityInput: HUBSPOT_OBJECT_ENTITY,
        description:
          "Search HubSpot contacts, companies or deals by a word (name, email, domain) or property filters, a page at a time.",
        summary: "Found {{records.length}} {{objectType}}",
        input: z.object({
          objectType: HubspotObjectType,
          /** Searched across the type's default text properties. */
          query: z.string().min(2).max(200).optional(),
          /** All must hold. */
          filters: z.array(SearchFilter).max(5).optional(),
          /** Extra properties to return beside the defaults. */
          properties: z.array(PropertyName).max(50).optional(),
          limit: z.number().int().min(1).max(100).default(20),
          /** The `next` of the page before. */
          after: z
            .string()
            .regex(/^\d{1,10}$/)
            .optional(),
        }),
        output: z.object({
          objectType: HubspotObjectType,
          total: z.number().int(),
          records: z.array(HubspotRecord),
          next: z.string().nullable(),
        }),
        async run(input, ctx) {
          const body = await search(ctx, input.objectType, {
            filters: (input.filters ?? []).map((f) => ({
              propertyName: f.property,
              operator: f.operator,
              ...(f.value === undefined ? {} : { value: f.value }),
            })),
            ...(input.query ? { query: input.query } : {}),
            properties: propertiesFor(input.objectType, input.properties),
            limit: input.limit,
            ...(input.after ? { after: input.after } : {}),
          });
          const records = body.results.map((r) => mapHubspotRecord(input.objectType, r));
          return {
            objectType: input.objectType,
            total: body.total ?? records.length,
            records,
            next: body.paging?.next?.after ?? null,
          };
        },
      }),
      defineReadTool({
        id: HUBSPOT_TOOLS.get,
        entityInput: HUBSPOT_OBJECT_ENTITY,
        description: "Get one HubSpot contact, company or deal by id.",
        summary: "Read {{record.objectType}} {{record.id}}",
        input: z.object({
          objectType: HubspotObjectType,
          id: RecordId,
          properties: z.array(PropertyName).max(50).optional(),
        }),
        output: z.object({ record: HubspotRecord.nullable() }),
        async run(input, ctx) {
          return { record: await getRecord(ctx, input.objectType, input.id, input.properties) };
        },
      }),
      defineWriteTool({
        id: HUBSPOT_TOOLS.create,
        entityInput: HUBSPOT_OBJECT_ENTITY,
        description:
          "Create a HubSpot contact, company or deal with the given properties (internal names, e.g. email, firstname).",
        verb: "create",
        // R5: no void or archive tool yet, and delete stays off (docs/plan.md §9 follow-ups).
        undo: { kind: "none" },
        summary: "Created {{objectType}} {{id}}",
        input: z.object({ objectType: HubspotObjectType, properties: Properties }),
        output: z.object({
          objectType: HubspotObjectType,
          id: z.string(),
          alreadyDone: z.boolean(),
        }),
        // What is there already: records of this type with the same email, domain, name or deal
        // name, so the approver sees a likely duplicate before it is made.
        beforeSchema: z.object({ existing: z.array(HubspotRecord) }),
        async before(input, ctx) {
          const keys = KEY_PROPERTIES[input.objectType].filter(
            (k) => typeof input.properties[k] === "string" && input.properties[k] !== "",
          );
          const key = keys[0];
          if (!key) return { existing: [] };
          const found = await search(ctx, input.objectType, {
            filters: [{ propertyName: key, operator: "EQ", value: String(input.properties[key]) }],
            properties: propertiesFor(input.objectType, Object.keys(input.properties)),
            limit: 5,
          });
          return { existing: found.results.map((r) => mapHubspotRecord(input.objectType, r)) };
        },
        async run(input, ctx, before) {
          // DECISION: HubSpot takes no idempotency key. A record of this type made within the
          // last day whose every given property already has the given value is this action's own
          // earlier write (a retry after a lost answer): it is reported done, not made again.
          const since = ctx.now().getTime() - TWIN_WINDOW_MS;
          const twin = (before?.existing ?? []).find(
            (r) =>
              r.createdAt !== null &&
              Date.parse(r.createdAt) >= since &&
              Object.entries(input.properties).every(
                ([k, v]) => (r.properties[k] ?? null) === asText(v),
              ),
          );
          if (twin) return { objectType: input.objectType, id: twin.id, alreadyDone: true };
          if (input.objectType === "contacts" && (before?.existing.length ?? 0) > 0) {
            throw new HubspotApiError(
              409,
              "CONFLICT",
              "a contact with this email already exists: update it instead",
              false,
            );
          }
          ctx.logger.info("creating hubspot record", { objectType: input.objectType });
          const out = RawRecord.parse(
            await api(ctx, "POST", `/crm/v3/objects/${input.objectType}`, {
              properties: input.properties,
            }),
          );
          return { objectType: input.objectType, id: String(out.id), alreadyDone: false };
        },
      }),
      defineWriteTool({
        id: HUBSPOT_TOOLS.update,
        entityInput: HUBSPOT_OBJECT_ENTITY,
        description:
          "Change properties of a HubSpot contact, company or deal. Give the record's updatedAt as read to refuse the change if it changed since.",
        verb: "update",
        // R5: the before state is written back with this tool, if the record hasn't changed since.
        undo: { kind: "restore" },
        summary: "Updated {{objectType}} {{id}}",
        input: z.object({
          objectType: HubspotObjectType,
          id: RecordId,
          properties: Properties,
          /** The record's `updatedAt` when the agent read it. */
          expectedUpdatedAt: z.string().max(40).optional(),
        }),
        output: z.object({
          objectType: HubspotObjectType,
          id: z.string(),
          updatedAt: z.string().nullable(),
          alreadyDone: z.boolean(),
        }),
        // What the change replaces: the record's current values of the properties it sets.
        beforeSchema: z.object({
          id: z.string(),
          name: z.string().nullable(),
          updatedAt: z.string().nullable(),
          properties: z.record(z.string(), z.string().nullable()),
        }),
        // R5: the properties it set go back to their values before, guarded by the record's
        // `updatedAt` now (the undo runs only when nobody changed it since our write); the before
        // state holds HubSpot's text values, not the input's, and its own `updatedAt`.
        undoInput: ({ input, before, current }) =>
          before && current
            ? {
                objectType: input.objectType,
                id: input.id,
                properties: Object.fromEntries(
                  Object.keys(input.properties).map((k) => [k, before.properties[k] ?? null]),
                ),
                ...(current.updatedAt === null ? {} : { expectedUpdatedAt: current.updatedAt }),
              }
            : null,
        async before(input, ctx) {
          const current = await getRecord(
            ctx,
            input.objectType,
            input.id,
            Object.keys(input.properties),
          );
          if (!current) return null;
          const properties: Record<string, string | null> = Object.fromEntries(
            Object.keys(input.properties).map((k) => [k, current.properties[k] ?? null]),
          );
          return {
            id: current.id,
            name: nameOf(current),
            updatedAt: current.updatedAt,
            properties,
          };
        },
        async run(input, ctx, before) {
          if (!before) {
            throw new HubspotApiError(
              404,
              "OBJECT_NOT_FOUND",
              `${input.objectType} ${input.id} not found`,
              false,
            );
          }
          // Already as asked (a retry after a lost answer, or nothing to change): no write.
          if (
            Object.entries(input.properties).every(
              ([k, v]) => (before.properties[k] ?? null) === asText(v),
            )
          ) {
            return {
              objectType: input.objectType,
              id: before.id,
              updatedAt: before.updatedAt,
              alreadyDone: true,
            };
          }
          if (
            input.expectedUpdatedAt !== undefined &&
            before.updatedAt !== null &&
            before.updatedAt !== input.expectedUpdatedAt
          ) {
            throw new HubspotApiError(
              409,
              "STALE",
              `${input.objectType} ${input.id} changed since it was read`,
              false,
            );
          }
          const out = RawRecord.parse(
            await api(
              ctx,
              "PATCH",
              `/crm/v3/objects/${input.objectType}/${encodeURIComponent(input.id)}`,
              { properties: input.properties },
            ),
          );
          return {
            objectType: input.objectType,
            id: String(out.id),
            updatedAt: out.updatedAt ?? null,
            alreadyDone: false,
          };
        },
      }),
      defineWriteTool({
        id: HUBSPOT_TOOLS.note,
        entity: "note",
        description: "Add a note to a HubSpot contact, company or deal.",
        verb: "create",
        // R5: no void or archive tool yet, and delete stays off (docs/plan.md §9 follow-ups).
        undo: { kind: "none" },
        summary: "Added a note to {{objectType}} {{recordId}}",
        input: Attach.extend({ text: z.string().min(1).max(10_000) }),
        output: z.object({
          objectType: HubspotObjectType,
          recordId: z.string(),
          id: z.string(),
          alreadyDone: z.boolean(),
        }),
        beforeSchema: z.object({ record: AttachedTo }),
        async before(input, ctx) {
          const r = await getRecord(ctx, input.objectType, input.recordId);
          return r ? { record: { objectType: r.objectType, id: r.id, name: nameOf(r) } } : null;
        },
        async run(input, ctx, before) {
          if (!before) {
            throw new HubspotApiError(
              404,
              "OBJECT_NOT_FOUND",
              `${input.objectType} ${input.recordId} not found`,
              false,
            );
          }
          const body = noteBodyHtml(input.text);
          const done = (id: string, alreadyDone: boolean) => ({
            objectType: input.objectType,
            recordId: input.recordId,
            id,
            alreadyDone,
          });
          // DECISION: the same note on the same record within a day is this action's own earlier
          // write (HubSpot takes no idempotency key): reported done, not added again.
          const twin = await findTwin(ctx, "notes", input, { hs_note_body: body });
          if (twin) return done(twin, true);
          const out = RawRecord.parse(
            await api(ctx, "POST", "/crm/v3/objects/notes", {
              properties: { hs_timestamp: ctx.now().toISOString(), hs_note_body: body },
              associations: [
                {
                  to: { id: input.recordId },
                  types: [
                    {
                      associationCategory: "HUBSPOT_DEFINED",
                      associationTypeId: ASSOCIATION_TYPE.notes[input.objectType],
                    },
                  ],
                },
              ],
            }),
          );
          return done(String(out.id), false);
        },
      }),
      defineWriteTool({
        id: HUBSPOT_TOOLS.task,
        entity: "task",
        description:
          "Create a task in HubSpot (a to-do with a due date), optionally on a contact, company or deal.",
        verb: "create",
        // R5: no void or archive tool yet, and delete stays off (docs/plan.md §9 follow-ups).
        undo: { kind: "none" },
        summary: "Created task {{id}}",
        input: z
          .object({
            subject: z.string().min(1).max(255),
            body: z.string().max(10_000).optional(),
            dueDate: z.iso.date().optional(),
            priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
            objectType: HubspotObjectType.optional(),
            recordId: RecordId.optional(),
          })
          .refine((v) => (v.objectType === undefined) === (v.recordId === undefined), {
            message: "give both objectType and recordId, or neither",
          }),
        output: z.object({ id: z.string(), alreadyDone: z.boolean() }),
        beforeSchema: z.object({ record: AttachedTo }),
        async before(input, ctx) {
          if (!input.objectType || !input.recordId) return null;
          const r = await getRecord(ctx, input.objectType, input.recordId);
          return r ? { record: { objectType: r.objectType, id: r.id, name: nameOf(r) } } : null;
        },
        async run(input, ctx, before) {
          const on =
            input.objectType && input.recordId
              ? { objectType: input.objectType, recordId: input.recordId }
              : null;
          if (on && !before) {
            throw new HubspotApiError(
              404,
              "OBJECT_NOT_FOUND",
              `${on.objectType} ${on.recordId} not found`,
              false,
            );
          }
          // DECISION: a due date is noon UTC of that day, so it reads as the same day in the
          // Americas and Europe; no due date is due now (HubSpot requires hs_timestamp).
          const due = input.dueDate ? `${input.dueDate}T12:00:00.000Z` : ctx.now().toISOString();
          const match: Record<string, string> = { hs_task_subject: input.subject };
          if (input.body) match.hs_task_body = noteBodyHtml(input.body);
          // As notes: the same task within a day is this action's own earlier write.
          const twin = await findTwin(ctx, "tasks", on, match);
          if (twin) return { id: twin, alreadyDone: true };
          const properties: Record<string, string> = {
            hs_timestamp: due,
            hs_task_subject: input.subject,
            hs_task_status: "NOT_STARTED",
            hs_task_type: "TODO",
            ...(input.body ? { hs_task_body: noteBodyHtml(input.body) } : {}),
            ...(input.priority ? { hs_task_priority: input.priority } : {}),
          };
          const out = RawRecord.parse(
            await api(ctx, "POST", "/crm/v3/objects/tasks", {
              properties,
              ...(on
                ? {
                    associations: [
                      {
                        to: { id: on.recordId },
                        types: [
                          {
                            associationCategory: "HUBSPOT_DEFINED",
                            associationTypeId: ASSOCIATION_TYPE.tasks[on.objectType],
                          },
                        ],
                      },
                    ],
                  }
                : {}),
            }),
          );
          return { id: String(out.id), alreadyDone: false };
        },
      }),
    ],
  });
}
