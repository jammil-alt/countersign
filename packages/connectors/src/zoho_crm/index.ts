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
import { type FetchLike, formEncode, globalFetch, parseUrl, timeoutSignal } from "../http";
import {
  OAuthTokens,
  ReconnectRequiredError,
  type TokenRefresher,
  tokenManager,
} from "../oauth/tokens";

/**
 * "zoho_crm": Zoho CRM over OAuth 2.0 (ARCHITECTURE §6.7, owner 2026-11-04). The client signs in
 * to its own Zoho from the portal; tokens, the accounts server and the API domain of the client's
 * data center are kept encrypted on the connection. Read tools search and get records; write tools
 * create and update records, add notes and create tasks, each an external action behind approval.
 * No delete. What was and wasn't checked against Zoho's docs: ./NOTES.md.
 */
export const ZOHO_CRM_CONNECTOR_ID = "zoho_crm";
export const ZOHO_TOOLS = {
  search: "zoho_crm.record.search",
  get: "zoho_crm.record.get",
  create: "zoho_crm.record.create",
  update: "zoho_crm.record.update",
  note: "zoho_crm.note.create",
  task: "zoho_crm.task.create",
} as const;

/** The modules agents may work in. */
export const ZohoModule = z.enum(["Leads", "Contacts", "Accounts", "Deals"]);
export type ZohoModule = z.infer<typeof ZohoModule>;

// DECISION: read, create and update scopes per module, notes and tasks, plus org read (for the org
// id on the connection). No delete scope at all, so even a bug can't delete in the client's CRM.
export const ZOHO_SCOPES: readonly string[] = [
  ...ZohoModule.options.flatMap((m) =>
    ["READ", "CREATE", "UPDATE"].map((op) => `ZohoCRM.modules.${m.toLowerCase()}.${op}`),
  ),
  "ZohoCRM.modules.notes.READ",
  "ZohoCRM.modules.notes.CREATE",
  "ZohoCRM.modules.tasks.READ",
  "ZohoCRM.modules.tasks.CREATE",
  "ZohoCRM.org.READ",
];

const API_VERSION = "v8";
const DEFAULT_ACCOUNTS = "https://accounts.zoho.com";

/**
 * Zoho's accounts servers, one per data center. The callback's `accounts-server` is a query
 * parameter anyone can forge, and the code (with our client secret) goes to it, so only these hosts
 * are accepted.
 */
// UNCHECKED: the list of data centers (NOTES.md); a client in a missing one is refused with a clear
// error rather than sent anywhere unknown.
const ACCOUNTS_SERVER = /^https:\/\/accounts\.zoho\.(com|eu|in|com\.au|jp|ca|com\.cn|sa|uk)$/;
const API_DOMAIN = /^https:\/\/(www\.)?zohoapis\.(com|eu|in|com\.au|jp|ca|com\.cn|sa|uk)$/;

export function isZohoAccountsServer(url: string): boolean {
  return ACCOUNTS_SERVER.test(url.replace(/\/+$/, ""));
}

export function isZohoApiDomain(url: string): boolean {
  return API_DOMAIN.test(url.replace(/\/+$/, ""));
}

/** The encrypted credentials: the shared token fields plus where this client's Zoho lives. */
export const ZohoCredentials = OAuthTokens.extend({
  accountsServer: z.string().refine(isZohoAccountsServer, "not a Zoho accounts server"),
  apiDomain: z.string().refine(isZohoApiDomain, "not a Zoho API domain"),
});
export type ZohoCredentials = z.infer<typeof ZohoCredentials>;

/** The token endpoint's answer (authorization code and refresh grants). */
export const ZohoTokenResponse = z.union([
  z.looseObject({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    api_domain: z.string().optional(),
    token_type: z.string().optional(),
    expires_in: z.number().int().positive(),
    scope: z.string().optional(),
  }),
  z.looseObject({ error: z.string() }),
]);

export class ZohoApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** 429 and 5xx: the step's retry with backoff may get through. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ZohoApiError";
  }
}

// ── Records ──────────────────────────────────────────────────────────────────────────────────────

const FieldName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "a Zoho field API name, e.g. Last_Name")
  .max(100);
const FieldValue: z.ZodType = z.union([
  z.string().max(32_000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);
const Fields = z
  .record(FieldName, FieldValue)
  .refine((f) => Object.keys(f).length > 0, "give at least one field")
  .refine((f) => Object.keys(f).length <= 100, "at most 100 fields")
  .refine((f) => !("id" in f), "the record id is not a field");

/** A Zoho record as tools return it: its id, its fields, and when it was made and changed. */
export const ZohoRecord = z.object({
  id: z.string().min(1),
  module: ZohoModule,
  fields: z.record(z.string(), z.unknown()),
  createdTime: z.string().nullable(),
  modifiedTime: z.string().nullable(),
});
export type ZohoRecord = z.infer<typeof ZohoRecord>;

const RawRecord = z.looseObject({ id: z.union([z.string(), z.number()]) });

/** Zoho's record JSON → ZohoRecord. Zoho's own `$` keys (state, permissions) are dropped. */
export function mapZohoRecord(module: ZohoModule, raw: unknown): ZohoRecord {
  const r = RawRecord.parse(raw);
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === "id" || k.startsWith("$")) continue;
    fields[k] = v;
  }
  const time = (v: unknown) => (typeof v === "string" ? v : null);
  return ZohoRecord.parse({
    id: String(r.id),
    module,
    fields,
    createdTime: time(r.Created_Time),
    modifiedTime: time(r.Modified_Time),
  });
}

const WriteAnswer = z.object({
  data: z
    .array(
      z.looseObject({
        code: z.string(),
        status: z.string(),
        message: z.string().optional(),
        details: z.looseObject({}).optional(),
      }),
    )
    .min(1),
});

/** The one result of a single-record write, or the error Zoho gave for it. */
function writeResult(body: unknown): { id: string; modifiedTime: string | null } {
  const first = WriteAnswer.parse(body).data[0];
  if (first?.status !== "success") {
    throw new ZohoApiError(
      400,
      first?.code ?? "UNKNOWN",
      `Zoho refused the change: ${first?.message ?? first?.code ?? "no reason given"}`,
      false,
    );
  }
  const details = first.details ?? {};
  const id = details.id;
  if (typeof id !== "string" && typeof id !== "number") {
    throw new ZohoApiError(502, "NO_ID", "Zoho answered without a record id", false);
  }
  return {
    id: String(id),
    modifiedTime: typeof details.Modified_Time === "string" ? details.Modified_Time : null,
  };
}

// ── The connector ────────────────────────────────────────────────────────────────────────────────

export interface ZohoCrmOptions {
  /** The OAuth client from Zoho's API console (Server-based application, multi-DC on). */
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  /** Per data center client secrets, by accounts server, when the console gives each its own. */
  clientSecrets?: Record<string, string>;
  fetch?: FetchLike;
  /** Where sign-in starts. Default: https://accounts.zoho.com. */
  accountsUrl?: string;
}

export class ZohoNotConfiguredError extends Error {
  constructor() {
    super("Zoho CRM sign-in is not set up on this deployment (ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET)");
    this.name = "ZohoNotConfiguredError";
  }
}

export function createZohoCrmConnector(options: ZohoCrmOptions = {}): Connector {
  const doFetch = (): FetchLike => options.fetch ?? globalFetch();
  const accountsUrl = (options.accountsUrl ?? DEFAULT_ACCOUNTS).replace(/\/+$/, "");
  const configured = Boolean(options.clientId && options.clientSecret);

  function client(accountsServer: string): { id: string; secret: string } {
    if (!options.clientId || !options.clientSecret) throw new ZohoNotConfiguredError();
    return {
      id: options.clientId,
      secret: options.clientSecrets?.[accountsServer] ?? options.clientSecret,
    };
  }

  async function tokenCall(
    accountsServer: string,
    fields: Record<string, string>,
  ): Promise<z.infer<typeof ZohoTokenResponse>> {
    const res = await doFetch()(`${accountsServer}/oauth/v2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: formEncode(fields),
      redirect: "manual",
      signal: timeoutSignal(15_000),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ZohoApiError(
        res.status,
        "BAD_TOKEN_RESPONSE",
        "Zoho's token endpoint did not answer JSON",
        res.status >= 500,
      );
    }
    const parsed = ZohoTokenResponse.safeParse(body);
    if (!parsed.success) {
      throw new ZohoApiError(
        res.status,
        "BAD_TOKEN_RESPONSE",
        "Zoho's token answer has an unexpected shape",
        false,
      );
    }
    return parsed.data;
  }

  const expiresAt = (now: Date, seconds: number) =>
    new Date(now.getTime() + seconds * 1000).toISOString();

  const refresher: TokenRefresher = {
    async refresh(tokens, { now }) {
      const creds = ZohoCredentials.safeParse(tokens);
      if (!creds.success)
        throw new ReconnectRequiredError("the stored Zoho credentials are not valid");
      if (!tokens.refreshToken) throw new ReconnectRequiredError("no refresh token");
      const c = client(creds.data.accountsServer);
      const answer = await tokenCall(creds.data.accountsServer, {
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: c.id,
        client_secret: c.secret,
      });
      if ("error" in answer) {
        // invalid_code (revoked or expired grant), invalid_client: the client must sign in again.
        throw new ReconnectRequiredError(`Zoho refused the refresh: ${answer.error}`);
      }
      const apiDomain =
        answer.api_domain && isZohoApiDomain(answer.api_domain)
          ? answer.api_domain
          : creds.data.apiDomain;
      // Zoho's refresh tokens don't rotate: the answer has none, and tokenManager keeps the old one.
      return {
        ...creds.data,
        accessToken: answer.access_token,
        expiresAt: expiresAt(now, answer.expires_in),
        apiDomain,
        ...(answer.refresh_token ? { refreshToken: answer.refresh_token } : {}),
      };
    },
  };

  async function api(
    ctx: ToolContext,
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const stored = ZohoCredentials.safeParse(await ctx.credentials.get());
    if (!stored.success)
      throw new ReconnectRequiredError("the Zoho connection has no valid credentials");
    const tokens = tokenManager({ credentials: ctx.credentials, refresher, now: ctx.now });
    const res = await tokens.withAccessToken(
      async (token) => {
        // The API domain can change on refresh: read it again each try.
        const domain = ZohoCredentials.parse(await ctx.credentials.get()).apiDomain;
        return doFetch()(`${domain.replace(/\/+$/, "")}/crm/${API_VERSION}${path}`, {
          method,
          headers: {
            authorization: `Zoho-oauthtoken ${token}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "manual",
          signal: timeoutSignal(20_000),
        });
      },
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
    if (res.status === 401) throw new ReconnectRequiredError("Zoho refused the access token");
    if (!res.ok) {
      const e = (json ?? {}) as { code?: unknown; message?: unknown };
      const code = typeof e.code === "string" ? e.code : `HTTP_${res.status}`;
      const message = typeof e.message === "string" ? e.message : `Zoho answered ${res.status}`;
      throw new ZohoApiError(res.status, code, message, res.status === 429 || res.status >= 500);
    }
    return json;
  }

  async function getRecord(
    ctx: ToolContext,
    module: ZohoModule,
    id: string,
  ): Promise<ZohoRecord | null> {
    try {
      const body = (await api(ctx, "GET", `/${module}/${encodeURIComponent(id)}`)) as {
        data?: unknown[];
      } | null;
      const raw = body?.data?.[0];
      return raw === undefined ? null : mapZohoRecord(module, raw);
    } catch (error) {
      if (
        error instanceof ZohoApiError &&
        (error.status === 404 || error.code === "INVALID_DATA")
      ) {
        return null;
      }
      throw error;
    }
  }

  const RecordId = z.string().regex(/^\d{1,30}$/, "a Zoho record id (digits)");

  return defineConnector({
    id: ZOHO_CRM_CONNECTOR_ID,
    name: "Zoho CRM",
    description:
      "Leads, contacts, accounts and deals in your Zoho CRM. You sign in to Zoho yourself.",
    icon: "users",
    auth: "oauth2",
    entities: ["Leads", "Contacts", "Accounts", "Deals", "Notes", "Tasks"],
    isConfigured: () => configured,

    async authorize(req) {
      const c = client(accountsUrl);
      const query = formEncode({
        response_type: "code",
        client_id: c.id,
        scope: ZOHO_SCOPES.join(","),
        redirect_uri: req.redirectUri,
        access_type: "offline",
        // Always ask, so Zoho issues a refresh token on a reconnect too.
        prompt: "consent",
        state: req.state,
      });
      return { redirectUrl: `${accountsUrl}/oauth/v2/auth?${query}` };
    },

    async handleCallback(params, req) {
      const code = params.code;
      if (!code) throw new Error("the Zoho callback has no code");
      const accountsServer = (params["accounts-server"] ?? accountsUrl).replace(/\/+$/, "");
      if (!isZohoAccountsServer(accountsServer)) {
        throw new Error("the Zoho callback names an accounts server we don't know");
      }
      const c = client(accountsServer);
      const answer = await tokenCall(accountsServer, {
        grant_type: "authorization_code",
        code,
        client_id: c.id,
        client_secret: c.secret,
        redirect_uri: req.redirectUri,
      });
      if ("error" in answer) throw new Error(`Zoho refused the sign-in: ${answer.error}`);
      if (!answer.refresh_token) throw new Error("Zoho gave no refresh token");
      if (!answer.api_domain || !isZohoApiDomain(answer.api_domain)) {
        throw new Error("Zoho's answer names an API domain we don't know");
      }
      const now = new Date();
      const credentials: ZohoCredentials = ZohoCredentials.parse({
        accessToken: answer.access_token,
        refreshToken: answer.refresh_token,
        expiresAt: expiresAt(now, answer.expires_in),
        tokenType: answer.token_type ?? "Bearer",
        ...(answer.scope ? { scope: answer.scope } : {}),
        accountsServer,
        apiDomain: answer.api_domain,
      });
      // The org id names the connection (which Zoho it is); a failure here fails the sign-in.
      const res = await doFetch()(`${answer.api_domain}/crm/${API_VERSION}/org`, {
        headers: {
          authorization: `Zoho-oauthtoken ${answer.access_token}`,
          accept: "application/json",
        },
        redirect: "manual",
        signal: timeoutSignal(15_000),
      });
      const org = z
        .object({
          org: z
            .array(
              z.looseObject({
                id: z.union([z.string(), z.number()]),
                company_name: z.string().nullable().optional(),
              }),
            )
            .min(1),
        })
        .safeParse(JSON.parse((await res.text()) || "{}"));
      if (!res.ok || !org.success) throw new Error("could not read the Zoho organization");
      const first = org.data.org[0] as {
        id: string | number;
        company_name?: string | null | undefined;
      };
      return {
        externalAccountId: String(first.id),
        credentials: credentials as unknown as JsonObject,
        config: {
          dataCenter: params.location ?? parseUrl(accountsServer)?.hostname ?? "us",
          apiDomain: answer.api_domain,
          ...(first.company_name ? { orgName: first.company_name } : {}),
        },
      };
    },

    tokens: refresher,

    async revoke(ctx: ConnectionContext) {
      const creds = ZohoCredentials.safeParse(await ctx.credentials.get());
      if (!creds.success || !creds.data.refreshToken) return;
      await doFetch()(
        `${creds.data.accountsServer}/oauth/v2/token/revoke?${formEncode({ token: creds.data.refreshToken })}`,
        { method: "POST", redirect: "manual", signal: timeoutSignal(15_000) },
      );
    },

    tools: [
      defineReadTool({
        id: ZOHO_TOOLS.search,
        description:
          "Search a Zoho CRM module (Leads, Contacts, Accounts, Deals) by criteria, email, phone or a word.",
        summary: "Found {{records.length}} {{module}}",
        input: z
          .object({
            module: ZohoModule,
            /** Zoho criteria, e.g. `(Last_Name:equals:Lee)and(City:starts_with:Port)`. */
            criteria: z.string().min(3).max(2000).optional(),
            email: z.string().min(3).max(200).optional(),
            phone: z.string().min(3).max(50).optional(),
            word: z.string().min(2).max(200).optional(),
            page: z.number().int().min(1).max(100).default(1),
            perPage: z.number().int().min(1).max(200).default(20),
          })
          .refine(
            (v) =>
              [v.criteria, v.email, v.phone, v.word].filter((x) => x !== undefined).length === 1,
            "give exactly one of criteria, email, phone, word",
          ),
        output: z.object({
          module: ZohoModule,
          records: z.array(ZohoRecord),
          moreRecords: z.boolean(),
        }),
        async run(input, ctx) {
          const q: Record<string, string> = {
            page: String(input.page),
            per_page: String(input.perPage),
          };
          if (input.criteria !== undefined) q.criteria = input.criteria;
          if (input.email !== undefined) q.email = input.email;
          if (input.phone !== undefined) q.phone = input.phone;
          if (input.word !== undefined) q.word = input.word;
          const body = (await api(ctx, "GET", `/${input.module}/search?${formEncode(q)}`)) as {
            data?: unknown[];
            info?: { more_records?: boolean };
          } | null;
          return {
            module: input.module,
            records: (body?.data ?? []).map((r) => mapZohoRecord(input.module, r)),
            moreRecords: body?.info?.more_records === true,
          };
        },
      }),
      defineReadTool({
        id: ZOHO_TOOLS.get,
        description: "Get one Zoho CRM record by module and id.",
        summary: "Read {{record.module}} {{record.id}}",
        input: z.object({ module: ZohoModule, id: RecordId }),
        output: z.object({ record: ZohoRecord.nullable() }),
        async run(input, ctx) {
          return { record: await getRecord(ctx, input.module, input.id) };
        },
      }),
      defineWriteTool({
        id: ZOHO_TOOLS.create,
        description:
          "Create a record in a Zoho CRM module, e.g. a lead with Last_Name and Company.",
        verb: "create",
        summary: "Created {{module}} {{id}}",
        input: z.object({ module: ZohoModule, fields: Fields }),
        output: z.object({ module: ZohoModule, id: z.string() }),
        beforeSchema: z.object({}),
        async before() {
          return null;
        },
        async run(input, ctx) {
          // DECISION: Zoho takes no idempotency key; the external action runs the call once, and a
          // retry after a lost answer could create a second record (upsert with duplicate-check
          // fields is the follow-up, NOTES.md).
          ctx.logger.info("creating zoho record", { module: input.module });
          const body = await api(ctx, "POST", `/${input.module}`, {
            data: [input.fields],
          });
          return { module: input.module, id: writeResult(body).id };
        },
      }),
      defineWriteTool({
        id: ZOHO_TOOLS.update,
        description:
          "Change fields of a Zoho CRM record. Give the record's Modified_Time as read to refuse the change if it changed since.",
        verb: "update",
        summary: "Updated {{module}} {{id}}",
        input: z.object({
          module: ZohoModule,
          id: RecordId,
          fields: Fields,
          /** The record's `modifiedTime` when the agent read it. */
          expectedModifiedTime: z.string().optional(),
        }),
        output: z.object({
          module: ZohoModule,
          id: z.string(),
          modifiedTime: z.string().nullable(),
        }),
        // What the change replaces: the record's current values of the fields it sets.
        beforeSchema: z.object({
          id: z.string(),
          modifiedTime: z.string().nullable(),
          fields: z.record(z.string(), z.unknown()),
        }),
        async before(input, ctx) {
          const current = await getRecord(ctx, input.module, input.id);
          if (!current) return null;
          const fields: Record<string, unknown> = {};
          for (const k of Object.keys(input.fields)) fields[k] = current.fields[k] ?? null;
          return { id: current.id, modifiedTime: current.modifiedTime, fields };
        },
        async run(input, ctx, before) {
          if (!before)
            throw new ZohoApiError(
              404,
              "NOT_FOUND",
              `${input.module} ${input.id} not found`,
              false,
            );
          if (
            input.expectedModifiedTime !== undefined &&
            before.modifiedTime !== null &&
            before.modifiedTime !== input.expectedModifiedTime
          ) {
            throw new ZohoApiError(
              409,
              "STALE",
              `${input.module} ${input.id} changed since it was read`,
              false,
            );
          }
          const body = await api(ctx, "PUT", `/${input.module}/${encodeURIComponent(input.id)}`, {
            data: [input.fields],
          });
          const r = writeResult(body);
          return { module: input.module, id: r.id, modifiedTime: r.modifiedTime };
        },
      }),
      defineWriteTool({
        id: ZOHO_TOOLS.note,
        description: "Add a note to a Zoho CRM record.",
        verb: "create",
        summary: "Added a note to {{module}} {{recordId}}",
        input: z.object({
          module: ZohoModule,
          recordId: RecordId,
          title: z.string().max(120).optional(),
          content: z.string().min(1).max(32_000),
        }),
        output: z.object({ module: ZohoModule, recordId: z.string(), id: z.string() }),
        beforeSchema: z.object({}),
        async before() {
          return null;
        },
        async run(input, ctx) {
          const note: Record<string, string> = { Note_Content: input.content };
          if (input.title) note.Note_Title = input.title;
          const body = await api(
            ctx,
            "POST",
            `/${input.module}/${encodeURIComponent(input.recordId)}/Notes`,
            { data: [note] },
          );
          return { module: input.module, recordId: input.recordId, id: writeResult(body).id };
        },
      }),
      defineWriteTool({
        id: ZOHO_TOOLS.task,
        description:
          "Create a task in Zoho CRM, optionally linked to a record (a contact as Who, others as What).",
        verb: "create",
        summary: "Created task {{id}}",
        input: z
          .object({
            subject: z.string().min(1).max(255),
            dueDate: z.iso.date().optional(),
            priority: z.enum(["Highest", "High", "Normal", "Low", "Lowest"]).optional(),
            description: z.string().max(32_000).optional(),
            module: ZohoModule.optional(),
            recordId: RecordId.optional(),
          })
          .refine((v) => (v.module === undefined) === (v.recordId === undefined), {
            message: "give both module and recordId, or neither",
          }),
        output: z.object({ id: z.string() }),
        beforeSchema: z.object({}),
        async before() {
          return null;
        },
        async run(input, ctx) {
          const task: Record<string, unknown> = { Subject: input.subject };
          if (input.dueDate) task.Due_Date = input.dueDate;
          if (input.priority) task.Priority = input.priority;
          if (input.description) task.Description = input.description;
          if (input.module && input.recordId) {
            if (input.module === "Contacts") task.Who_Id = { id: input.recordId };
            else {
              task.What_Id = { id: input.recordId };
              task.$se_module = input.module;
            }
          }
          const body = await api(ctx, "POST", "/Tasks", { data: [task] });
          return { id: writeResult(body).id };
        },
      }),
    ],
  });
}
