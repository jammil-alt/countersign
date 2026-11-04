// Fakes for tests (`@countersign/connectors/testing`): a Zoho that answers from fixtures/zoho_crm and
// a webhook receiver that records what it was sent. Never imported by the Worker.

import invalidToken from "../../../fixtures/zoho_crm/invalid-token.json";
import leadCreate from "../../../fixtures/zoho_crm/lead-create.json";
import leadCreateInvalid from "../../../fixtures/zoho_crm/lead-create-invalid.json";
import leadGet from "../../../fixtures/zoho_crm/lead-get.json";
import leadUpdate from "../../../fixtures/zoho_crm/lead-update.json";
import leadsSearch from "../../../fixtures/zoho_crm/leads-search.json";
import noteCreate from "../../../fixtures/zoho_crm/note-create.json";
import org from "../../../fixtures/zoho_crm/org.json";
import rateLimited from "../../../fixtures/zoho_crm/rate-limited.json";
import taskCreate from "../../../fixtures/zoho_crm/task-create.json";
import tokenCode from "../../../fixtures/zoho_crm/token-authorization-code.json";
import tokenInvalid from "../../../fixtures/zoho_crm/token-invalid-code.json";
import tokenRefresh from "../../../fixtures/zoho_crm/token-refresh.json";
import type { FetchLike, HttpRequestInit, HttpResponseLike } from "./http";
import { formDecode, parseUrl } from "./http";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => h[name.toLowerCase()] ?? null },
    text: async () => text,
  };
}

/** The fixtures, by name, for assertions. */
export const ZOHO_FIXTURES = {
  tokenCode,
  tokenRefresh,
  tokenInvalid,
  org,
  leadsSearch,
  leadGet,
  leadCreate,
  leadCreateInvalid,
  leadUpdate,
  noteCreate,
  taskCreate,
  rateLimited,
  invalidToken,
} as const;

/**
 * A fake Zoho (EU data center): the accounts server's token and revoke endpoints and the CRM API,
 * answering from fixtures. `codes` are the authorization codes it accepts; `accessTokens` the
 * tokens it accepts (the fixtures' first and refreshed ones), so an expired token gets a 401.
 */
export function fakeZoho(opts: { acceptAccessTokens?: string[]; rateLimitNext?: number } = {}) {
  const requests: RecordedRequest[] = [];
  const accepted = new Set(
    opts.acceptAccessTokens ?? [tokenCode.access_token, tokenRefresh.access_token],
  );
  let rateLimit = opts.rateLimitNext ?? 0;
  let refreshFails = false;
  const state = { leadModifiedTime: leadGet.data[0]?.Modified_Time ?? null };

  const fetch: FetchLike = async (url: string, init: HttpRequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    requests.push({ url, method, headers: { ...(init.headers ?? {}) }, body: init.body });
    const u = parseUrl(url);
    if (!u) return jsonResponse(400, { error: "bad url" });
    if (u.origin === "https://accounts.zoho.eu" || u.origin === "https://accounts.zoho.com") {
      if (u.pathname === "/oauth/v2/token" && method === "POST") {
        const form = formDecode(init.body ?? "");
        if (form.grant_type === "authorization_code") {
          return jsonResponse(200, form.code === "fixture-code" ? tokenCode : tokenInvalid);
        }
        if (form.grant_type === "refresh_token") {
          if (refreshFails || form.refresh_token !== tokenCode.refresh_token) {
            return jsonResponse(200, tokenInvalid);
          }
          return jsonResponse(200, tokenRefresh);
        }
      }
      if (u.pathname === "/oauth/v2/token/revoke") return jsonResponse(200, { status: "success" });
      return jsonResponse(404, { error: "not found" });
    }
    if (u.origin !== "https://www.zohoapis.eu") return jsonResponse(404, { error: "unknown host" });
    const auth = (init.headers?.authorization ?? "").replace(/^Zoho-oauthtoken /, "");
    if (!accepted.has(auth)) return jsonResponse(401, invalidToken);
    if (rateLimit > 0) {
      rateLimit -= 1;
      return jsonResponse(429, rateLimited);
    }
    const path = u.pathname;
    if (path === "/crm/v8/org") return jsonResponse(200, org);
    if (path === "/crm/v8/Leads/search") {
      return url.includes("nobody") ? jsonResponse(204, undefined) : jsonResponse(200, leadsSearch);
    }
    const lead = leadGet.data[0];
    if (path === `/crm/v8/Leads/${lead?.id}`) {
      if (method === "GET") {
        return jsonResponse(200, { data: [{ ...lead, Modified_Time: state.leadModifiedTime }] });
      }
      if (method === "PUT") {
        state.leadModifiedTime = leadUpdate.data[0]?.details.Modified_Time ?? null;
        return jsonResponse(200, leadUpdate);
      }
    }
    if (path.startsWith("/crm/v8/Leads/") && method === "GET") {
      return jsonResponse(400, {
        code: "INVALID_DATA",
        message: "the id given seems to be invalid",
      });
    }
    if (path === "/crm/v8/Leads" && method === "POST") {
      const body = JSON.parse(init.body ?? "{}") as { data?: Record<string, unknown>[] };
      return jsonResponse(201, body.data?.[0]?.Last_Name ? leadCreate : leadCreateInvalid);
    }
    if (path === `/crm/v8/Leads/${lead?.id}/Notes` && method === "POST")
      return jsonResponse(201, noteCreate);
    if (path === "/crm/v8/Tasks" && method === "POST") return jsonResponse(201, taskCreate);
    return jsonResponse(404, { code: "INVALID_URL_PATTERN", message: "no such endpoint" });
  };

  return {
    fetch,
    requests,
    state,
    /** Requests to the CRM API (not the accounts server). */
    apiCalls: () => requests.filter((r) => r.url.startsWith("https://www.zohoapis.eu/")),
    failRefreshes() {
      refreshFails = true;
    },
  };
}

/** A webhook receiver (e.g. a Zap's catch hook) that records every POST and answers `status`. */
export function fakeReceiver(
  answer: { status: number; body?: unknown } = { status: 200, body: { status: "success" } },
) {
  const received: RecordedRequest[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    received.push({
      url,
      method: (init.method ?? "GET").toUpperCase(),
      headers: { ...(init.headers ?? {}) },
      body: init.body,
    });
    return jsonResponse(answer.status, answer.body);
  };
  return { fetch, received };
}
