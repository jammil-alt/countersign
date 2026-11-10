// §1.77 (M49): "linkedin", posts to the client's LinkedIn company page and nothing else
// (docs/marketing-plan.md §4.2, D8). A page admin at the client signs in with LinkedIn's OAuth
// (the Community Management API): we ask for `w_organization_social` (post as the page) and
// `r_organization_admin` (to see which pages they administer), never a member's own feed or
// messages. `linkedin.post` is an external tool a person always signs (ToolSpec `approval:
// 'always'`, §1.73): no matrix, step or mode makes a post automatic. LinkedIn's posts API takes no
// idempotency key, so a post is recorded as started before it is sent and a started, unrecorded
// post is never sent again (the platform's write attempts, as Slack's). Without LINKEDIN_CLIENT_ID
// and LINKEDIN_CLIENT_SECRET the portal shows "not available yet". Unchecked facts: ./NOTES.md.

import type { JsonObject } from "@countersign/core";
import { z } from "zod";
import type { WriteAttemptServices } from "../attempts";
import {
  type ConnectionContext,
  type Connector,
  defineConnector,
  defineWriteTool,
  type ToolContext,
  UnconfirmedWriteError,
} from "../connector";
import { type FetchLike, formEncode, globalFetch, timeoutSignal } from "../http";
import {
  OAuthTokens,
  ReconnectRequiredError,
  SignInRefusedError,
  type TokenRefresher,
  tokenManager,
} from "../oauth/tokens";

export const LINKEDIN_CONNECTOR_ID = "linkedin";
export const LINKEDIN_POST_TOOL = "linkedin.post";

export const LINKEDIN_AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
export const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
export const LINKEDIN_REVOKE_URL = "https://www.linkedin.com/oauth/v2/revoke";
export const LINKEDIN_API = "https://api.linkedin.com/rest";
// DECISION: one pinned version of LinkedIn's versioned API (yyyymm), changed on purpose only.
export const LINKEDIN_VERSION = "202510";

export const LINKEDIN_SCOPES: readonly string[] = ["w_organization_social", "r_organization_admin"];
const ALLOWED_SCOPES = new Set(LINKEDIN_SCOPES);

/** A post's text: LinkedIn's limit for a post's commentary. */
export const LINKEDIN_POST_MAX = 3000;
/** Pages kept from a sign-in. */
const MAX_PAGES = 20;
/** After this many refused attempts under one key, the action stops trying. */
const MAX_ATTEMPTS = 3;

export const LinkedInPage = z.object({
  /** The organization's numeric id. */
  id: z.string().regex(/^\d{1,20}$/),
  name: z.string(),
});
export type LinkedInPage = z.infer<typeof LinkedInPage>;

export const LinkedInConfig = z.object({
  /** The company pages the person who signed in administers. */
  pages: z.array(LinkedInPage).min(1).max(MAX_PAGES),
  accountName: z.string(),
  scopes: z.array(z.string()),
});
export type LinkedInConfig = z.infer<typeof LinkedInConfig>;

export const LinkedInCredentials = OAuthTokens;

export class LinkedInApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LinkedInApiError";
  }
}

export class LinkedInNotConfiguredError extends Error {
  constructor() {
    super(
      "LinkedIn sign-in is not set up on this deployment (LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET)",
    );
    this.name = "LinkedInNotConfiguredError";
  }
}

export const LinkedInPostInput = z.strictObject({
  /** The post's text, plain. */
  text: z.string().trim().min(1).max(LINKEDIN_POST_MAX),
  /** Which of the client's pages; may be left out when the connection has one page. */
  page: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
});
export type LinkedInPostInput = z.infer<typeof LinkedInPostInput>;

export const LinkedInPostOutput = z.object({
  /** LinkedIn's id for the post (`urn:li:share:…` or `urn:li:ugcPost:…`). */
  id: z.string(),
  url: z.string(),
  page: LinkedInPage,
});
export type LinkedInPostOutput = z.infer<typeof LinkedInPostOutput>;

/** What the person signing sees and `external_action.before` keeps: the post as it would go. */
export const LinkedInPostBefore = z.object({
  page: LinkedInPage,
  text: z.string(),
});

/**
 * LinkedIn's "little text" format reads `\`, `|`, `{`, `}`, `@`, `[`, `]`, `(`, `)`, `<`, `>`, `#`,
 * `*`, `_` and `~` as markup (mentions, hashtags, formatting); each is escaped so the post reads
 * exactly as written and mentions no one. Control characters but line breaks and tabs are dropped.
 */
export function linkedInCommentary(text: string): string {
  return dropControls(text).replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);
}

/** Control characters dropped, but line breaks and tabs. */
function dropControls(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if ((c < 0x20 && ch !== "\n" && ch !== "\r" && ch !== "\t") || c === 0x7f) continue;
    out += ch;
  }
  return out;
}

/** The pages a connection may post to, from its config; refused when there are none. */
function configOf(ctx: ConnectionContext): LinkedInConfig {
  const c = LinkedInConfig.safeParse(ctx.connection.config);
  if (!c.success) throw new ReconnectRequiredError("the LinkedIn connection has no company page");
  return c.data;
}

/** The page the input names (or the one page), among the connection's; else refused. */
export function pageFor(config: LinkedInConfig, page: string | undefined): LinkedInPage {
  if (page === undefined) {
    if (config.pages.length === 1) return config.pages[0] as LinkedInPage;
    throw new Error(
      `name the company page: ${config.pages.map((p) => `${p.name} (${p.id})`).join(", ")}`,
    );
  }
  const found = config.pages.find((p) => p.id === page);
  if (!found) throw new Error("that is not one of the client's LinkedIn company pages");
  return found;
}

function attemptServices(ctx: ToolContext): WriteAttemptServices {
  const s = ctx.services?.attempts;
  if (!s) throw new Error("LinkedIn posts need the platform's record of attempts");
  return s;
}

const TokenAnswer = z.union([
  z.looseObject({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
    refresh_token: z.string().min(1).optional(),
    refresh_token_expires_in: z.number().int().positive().optional(),
    scope: z.string().optional(),
  }),
  z.looseObject({ error: z.string(), error_description: z.string().optional() }),
]);

const AclAnswer = z.looseObject({
  elements: z.array(
    z.looseObject({
      organization: z.string().optional(),
      organizationTarget: z.string().optional(),
      role: z.string(),
      state: z.string(),
    }),
  ),
});
const OrgAnswer = z.looseObject({
  id: z.number().int().optional(),
  localizedName: z.string().optional(),
});

const ORG_URN = /^urn:li:organization:(\d{1,20})$/;
const POST_URN = /^urn:li:(share|ugcPost):\d{1,30}$/;

export interface LinkedInOptions {
  /** Our LinkedIn app ("Mezonas"): its client id and secret. */
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  fetch?: FetchLike;
}

export function createLinkedInConnector(options: LinkedInOptions = {}): Connector {
  const doFetch = (): FetchLike => options.fetch ?? globalFetch();
  const configured = Boolean(options.clientId && options.clientSecret);

  function client(): { id: string; secret: string } {
    if (!options.clientId || !options.clientSecret) throw new LinkedInNotConfiguredError();
    return { id: options.clientId, secret: options.clientSecret };
  }

  async function readJson(res: { text(): Promise<string> }): Promise<unknown> {
    const text = await res.text();
    if (text.length > 1_000_000) return null;
    try {
      return text ? (JSON.parse(text) as unknown) : null;
    } catch {
      return null;
    }
  }

  async function tokenCall(fields: Record<string, string>) {
    const res = await doFetch()(LINKEDIN_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: formEncode(fields),
      redirect: "manual",
      signal: timeoutSignal(15_000),
    });
    const parsed = TokenAnswer.safeParse(await readJson(res));
    if (!parsed.success) {
      throw new LinkedInApiError(res.status, "LinkedIn's token answer has an unexpected shape");
    }
    return parsed.data;
  }

  const at = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();

  const refresher: TokenRefresher = {
    async refresh(tokens, { now }) {
      if (!tokens.refreshToken) throw new ReconnectRequiredError("no refresh token");
      const c = client();
      const answer = await tokenCall({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: c.id,
        client_secret: c.secret,
      });
      if ("error" in answer) {
        throw new ReconnectRequiredError(`LinkedIn refused the refresh: ${answer.error}`);
      }
      return {
        ...tokens,
        accessToken: answer.access_token,
        expiresAt: at(now, answer.expires_in),
        ...(answer.refresh_token ? { refreshToken: answer.refresh_token } : {}),
        ...(answer.refresh_token_expires_in
          ? { refreshTokenExpiresAt: at(now, answer.refresh_token_expires_in) }
          : {}),
      };
    },
  };

  const apiHeaders = (token: string): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "linkedin-version": LINKEDIN_VERSION,
    "x-restli-protocol-version": "2.0.0",
  });

  async function get(token: string, path: string) {
    const res = await doFetch()(`${LINKEDIN_API}${path}`, {
      method: "GET",
      headers: apiHeaders(token),
      redirect: "manual",
      signal: timeoutSignal(15_000),
    });
    return { status: res.status, ok: res.ok, body: await readJson(res) };
  }

  /** The company pages this person administers (approved admin roles only), with their names. */
  async function adminPages(token: string): Promise<LinkedInPage[]> {
    const acl = await get(
      token,
      `/organizationAcls?${formEncode({ q: "roleAssignee", role: "ADMINISTRATOR", state: "APPROVED" })}`,
    );
    if (acl.status === 401) throw new ReconnectRequiredError("LinkedIn refused the access token");
    const parsed = AclAnswer.safeParse(acl.body);
    if (!acl.ok || !parsed.success) {
      throw new LinkedInApiError(acl.status, "LinkedIn didn't list the pages you administer");
    }
    const ids = new Set<string>();
    for (const e of parsed.data.elements) {
      if (e.role !== "ADMINISTRATOR" || e.state !== "APPROVED") continue;
      const m = ORG_URN.exec(e.organization ?? e.organizationTarget ?? "");
      if (m?.[1]) ids.add(m[1]);
      if (ids.size >= MAX_PAGES) break;
    }
    const pages: LinkedInPage[] = [];
    for (const id of ids) {
      const org = await get(token, `/organizations/${id}`);
      const named = OrgAnswer.safeParse(org.body);
      const name = (org.ok && named.success ? named.data.localizedName : undefined)?.trim();
      pages.push({ id, name: (name || `Page ${id}`).slice(0, 200) });
    }
    return pages;
  }

  return defineConnector({
    id: LINKEDIN_CONNECTOR_ID,
    name: "LinkedIn",
    description:
      "Post to your LinkedIn company page, after a person signs each post. We can't read your messages or post as you.",
    icon: "message",
    auth: "oauth2",
    entities: [],
    permissionEntities: [{ id: "post", label: "Posts", verbs: ["create"] }],
    isConfigured: () => configured,

    async authorize(req) {
      const c = client();
      const query = formEncode({
        response_type: "code",
        client_id: c.id,
        redirect_uri: req.redirectUri,
        state: req.state,
        scope: LINKEDIN_SCOPES.join(" "),
      });
      return { redirectUrl: `${LINKEDIN_AUTH_URL}?${query}` };
    },

    async handleCallback(params, req) {
      const code = params.code;
      if (!code) throw new Error("the LinkedIn callback has no code");
      const c = client();
      const answer = await tokenCall({
        grant_type: "authorization_code",
        code,
        redirect_uri: req.redirectUri,
        client_id: c.id,
        client_secret: c.secret,
      });
      if ("error" in answer) throw new Error(`LinkedIn refused the sign-in: ${answer.error}`);
      const scopes = (answer.scope ?? "")
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!scopes.includes("w_organization_social")) {
        throw new SignInRefusedError(
          "LinkedIn didn't give us permission to post to your page. Connect again and allow it.",
        );
      }
      if (scopes.some((s) => !ALLOWED_SCOPES.has(s))) {
        throw new SignInRefusedError(
          "LinkedIn gave more access than we ask for, so we didn't keep it",
        );
      }
      const pages = await adminPages(answer.access_token);
      // DECISION: a sign-in by someone who administers no company page is refused: posting as a
      // person is out of scope (company page only, D8).
      if (pages.length === 0) {
        throw new SignInRefusedError(
          "You don't administer a LinkedIn company page, so there is nowhere for us to post",
        );
      }
      const now = new Date();
      const credentials = LinkedInCredentials.parse({
        accessToken: answer.access_token,
        expiresAt: at(now, answer.expires_in),
        ...(answer.refresh_token ? { refreshToken: answer.refresh_token } : {}),
        ...(answer.refresh_token_expires_in
          ? { refreshTokenExpiresAt: at(now, answer.refresh_token_expires_in) }
          : {}),
        tokenType: "Bearer",
        scope: scopes.join(" "),
      });
      const config: LinkedInConfig = {
        pages,
        accountName: pages.map((p) => p.name).join(", "),
        scopes,
      };
      return {
        // The first page names the account on the Connections card.
        externalAccountId: `urn:li:organization:${pages[0]?.id}`,
        credentials: credentials as unknown as JsonObject,
        config: config as unknown as JsonObject,
      };
    },

    tokens: refresher,

    // DECISION: disconnect revokes the token at LinkedIn (best effort), then the platform drops it.
    async revoke(ctx) {
      const creds = LinkedInCredentials.safeParse(await ctx.credentials.get());
      if (!creds.success || !configured) return;
      const c = client();
      await doFetch()(LINKEDIN_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formEncode({
          client_id: c.id,
          client_secret: c.secret,
          token: creds.data.accessToken,
        }),
        redirect: "manual",
        signal: timeoutSignal(15_000),
      }).catch(() => undefined);
    },

    tools: [
      defineWriteTool({
        id: LINKEDIN_POST_TOOL,
        entity: "post",
        description:
          "Propose a post to the client's LinkedIn company page. A person always reads and signs it first; it goes out as written, plain text.",
        verb: "create",
        // R5: a post can't be taken back.
        undo: { kind: "none" },
        // §1.73: a person always signs a post (no matrix, step or mode loosens it).
        approval: "always",
        summary: "Posted on LinkedIn as {{page.name}}",
        input: LinkedInPostInput,
        output: LinkedInPostOutput,
        beforeSchema: LinkedInPostBefore,
        async before(input, ctx) {
          const page = pageFor(configOf(ctx), input.page);
          return { page, text: input.text };
        },
        async run(input, ctx) {
          const attempts = attemptServices(ctx);
          const key = ctx.idempotencyKey;
          const state = await attempts.stateFor(key);
          // A re-run after the post was recorded returns it, before any check.
          if (state.done) return LinkedInPostOutput.parse(state.done);
          // DECISION: LinkedIn's posts API takes no idempotency key, so an attempt started without
          // LinkedIn's answer is never sent again: the action fails as unconfirmed and the operator
          // checks the page. An attempt LinkedIn refused with an answer posted nothing.
          if (state.started > state.refused) {
            const last = state.last;
            throw new UnconfirmedWriteError(
              `The LinkedIn post to ${String(last?.details.pageName ?? "the company page")} may have gone out`,
              `we started it at ${last?.startedAt.toISOString() ?? "an unknown time"} and have no answer from LinkedIn`,
              {
                channel: "linkedin",
                ...(last?.details ?? {}),
                ...(last ? { startedAt: last.startedAt.toISOString() } : {}),
              },
            );
          }
          if (state.started >= MAX_ATTEMPTS) {
            throw new Error(`LinkedIn refused this post ${state.started} times; we stopped trying`);
          }
          // Checked again at the post: the pages may have changed since it was signed.
          const page = pageFor(configOf(ctx), input.page);
          const attempt = state.started + 1;
          const details: JsonObject = { pageId: page.id, pageName: page.name, attempt };
          const claimed = await attempts.start({
            idempotencyKey: key,
            attempt,
            details,
            at: ctx.now(),
          });
          if (!claimed) {
            throw new UnconfirmedWriteError(
              `The LinkedIn post to ${page.name} may have gone out`,
              "another run of this action started posting it at the same time",
              { channel: "linkedin", ...details },
            );
          }
          const tokens = tokenManager({ credentials: ctx.credentials, refresher, now: ctx.now });
          const body = JSON.stringify({
            author: `urn:li:organization:${page.id}`,
            commentary: linkedInCommentary(input.text),
            visibility: "PUBLIC",
            distribution: {
              feedDistribution: "MAIN_FEED",
              targetEntities: [],
              thirdPartyDistributionChannels: [],
            },
            lifecycleState: "PUBLISHED",
            isReshareDisabledByAuthor: false,
          });
          // A network failure throws here with the attempt open: unconfirmed on retry.
          const res = await tokens.withAccessToken(
            (token) =>
              doFetch()(`${LINKEDIN_API}/posts`, {
                method: "POST",
                headers: { ...apiHeaders(token), "content-type": "application/json" },
                body,
                redirect: "manual",
                signal: timeoutSignal(30_000),
              }),
            (r) => r.status === 401,
          );
          if (res.status === 201) {
            const id = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id") ?? "";
            if (!POST_URN.test(id)) {
              // Posted, but we can't say which post: recorded as done with what we know.
              const output = { id: id || "unknown", url: "https://www.linkedin.com/", page };
              await attempts.done({ idempotencyKey: key, output, at: ctx.now() });
              return output;
            }
            const output: LinkedInPostOutput = {
              id,
              url: `https://www.linkedin.com/feed/update/${id}/`,
              page,
            };
            await attempts.done({ idempotencyKey: key, output, at: ctx.now() });
            return output;
          }
          // A 4xx is LinkedIn's answer: nothing was posted, and the action may try again.
          if (res.status >= 400 && res.status < 500) {
            await attempts.refused({
              idempotencyKey: key,
              attempt,
              reason: String(res.status),
              at: ctx.now(),
            });
            if (res.status === 401) throw new ReconnectRequiredError("LinkedIn refused the token");
            const answer = (await readJson(res)) as { message?: unknown } | null;
            const why = typeof answer?.message === "string" ? answer.message.slice(0, 300) : "";
            throw new LinkedInApiError(
              res.status,
              `LinkedIn refused the post (${res.status})${why ? `: ${why}` : ""}`,
            );
          }
          // A 5xx or anything else: LinkedIn may have posted it; the attempt stays open.
          throw new LinkedInApiError(
            res.status,
            `LinkedIn didn't say whether the post to ${page.name} went out (${res.status})`,
          );
        },
      }),
    ],
  });
}
