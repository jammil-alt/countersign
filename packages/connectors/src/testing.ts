// Fakes for tests (`@countersign/connectors/testing`): a Zoho that answers from fixtures/zoho_crm and
// a webhook receiver that records what it was sent. Never imported by the Worker.

import podioApp from "../../../fixtures/podio/app-jobs.json";
import podioComment from "../../../fixtures/podio/comment-create.json";
import podioExpired from "../../../fixtures/podio/expired-token.json";
import podioItemCreate from "../../../fixtures/podio/item-create.json";
import podioItem from "../../../fixtures/podio/item-job.json";
import podioItemUpdate from "../../../fixtures/podio/item-update.json";
import podioFilter from "../../../fixtures/podio/items-filter.json";
import podioNotFound from "../../../fixtures/podio/not-found.json";
import podioOrgs from "../../../fixtures/podio/orgs.json";
import podioRateLimited from "../../../fixtures/podio/rate-limited.json";
import podioApps from "../../../fixtures/podio/space-apps.json";
import podioTask from "../../../fixtures/podio/task-create.json";
import podioTokenCode from "../../../fixtures/podio/token-authorization-code.json";
import podioTokenInvalid from "../../../fixtures/podio/token-invalid-grant.json";
import podioTokenRefresh from "../../../fixtures/podio/token-refresh.json";
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
  const state = {
    leadModifiedTime: leadGet.data[0]?.Modified_Time ?? null,
    // v0.14 W4-B: records the sync's list calls answer from, by module; and the watches asked.
    listed: {} as Record<string, Record<string, unknown>[]>,
    watches: [] as unknown[],
  };

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
    // v0.14 W4-B: the sync's list calls (If-Modified-Since, oldest first, paged) and the watch.
    const listedModule = /^\/crm\/v8\/(Leads|Contacts|Accounts|Deals)$/.exec(path)?.[1];
    if (listedModule && method === "GET") {
      const since = Date.parse(init.headers?.["if-modified-since"] ?? "1970-01-01T00:00:00Z");
      const q = formDecode(url.split("?")[1] ?? "");
      const page = Number(q.page ?? "1");
      const per = Number(q.per_page ?? "200");
      const all = (state.listed[listedModule] ?? [])
        .filter((r) => Date.parse(String(r.Modified_Time)) > since)
        .sort((a, b) => Date.parse(String(a.Modified_Time)) - Date.parse(String(b.Modified_Time)));
      const slice = all.slice((page - 1) * per, page * per);
      if (slice.length === 0) return jsonResponse(304, undefined);
      return jsonResponse(200, {
        data: slice,
        info: { page, per_page: per, count: slice.length, more_records: all.length > page * per },
      });
    }
    if (path === "/crm/v8/actions/watch" && method === "POST") {
      state.watches.push(JSON.parse(init.body ?? "{}"));
      return jsonResponse(200, {
        watch: [
          { code: "SUCCESS", status: "success", message: "Successfully subscribed", details: {} },
        ],
      });
    }
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

export const PODIO_FIXTURES = {
  tokenCode: podioTokenCode,
  tokenRefresh: podioTokenRefresh,
  tokenInvalid: podioTokenInvalid,
  orgs: podioOrgs,
  apps: podioApps,
  app: podioApp,
  item: podioItem,
  filter: podioFilter,
  itemCreate: podioItemCreate,
  itemUpdate: podioItemUpdate,
  comment: podioComment,
  task: podioTask,
  rateLimited: podioRateLimited,
  notFound: podioNotFound,
  expired: podioExpired,
} as const;

/**
 * A fake Podio: the token endpoint (`fixture-code` is the one code it accepts) and the API, from
 * fixtures/podio. Access tokens it accepts: the fixtures' first and refreshed ones. Items created
 * are remembered by external id, so a repeated create is found, as in Podio.
 */
export function fakePodio(opts: { acceptAccessTokens?: string[]; rateLimitNext?: number } = {}) {
  const requests: RecordedRequest[] = [];
  const accepted = new Set(
    opts.acceptAccessTokens ?? [podioTokenCode.access_token, podioTokenRefresh.access_token],
  );
  let rateLimit = opts.rateLimitNext ?? 0;
  let refreshFails = false;
  const state = {
    revision: podioItem.current_revision.revision,
    createdByExternalId: new Map<string, number>(),
  };

  const fetch: FetchLike = async (url: string, init: HttpRequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    requests.push({ url, method, headers: { ...(init.headers ?? {}) }, body: init.body });
    const u = parseUrl(url);
    if (u?.origin !== "https://api.podio.com") return jsonResponse(404, podioNotFound);
    if (u.pathname === "/oauth/token" && method === "POST") {
      const form = formDecode(init.body ?? "");
      if (form.grant_type === "authorization_code") {
        return form.code === "fixture-code"
          ? jsonResponse(200, podioTokenCode)
          : jsonResponse(400, podioTokenInvalid);
      }
      if (form.grant_type === "refresh_token") {
        const known = [podioTokenCode.refresh_token, podioTokenRefresh.refresh_token];
        if (refreshFails || !known.includes(form.refresh_token ?? ""))
          return jsonResponse(400, podioTokenInvalid);
        return jsonResponse(200, podioTokenRefresh);
      }
      return jsonResponse(400, podioTokenInvalid);
    }
    const auth = (init.headers?.authorization ?? "").replace(/^OAuth2 /, "");
    if (!accepted.has(auth)) return jsonResponse(401, podioExpired);
    if (rateLimit > 0) {
      rateLimit -= 1;
      return jsonResponse(420, podioRateLimited);
    }
    const p = u.pathname;
    const appId = podioApp.app_id;
    const itemId = podioItem.item_id;
    if (p === "/org/" && method === "GET") return jsonResponse(200, podioOrgs);
    if (p === `/app/space/${podioApp.space_id}/` && method === "GET")
      return jsonResponse(200, podioApps);
    if (p === `/app/${appId}` && method === "GET") return jsonResponse(200, podioApp);
    if (p === `/item/app/${appId}/filter/` && method === "POST")
      return jsonResponse(200, podioFilter);
    if (p === `/item/${itemId}` && method === "GET") {
      return jsonResponse(200, {
        ...podioItem,
        current_revision: { ...podioItem.current_revision, revision: state.revision },
      });
    }
    if (p === `/item/${itemId}` && method === "PUT") {
      state.revision += 1;
      return jsonResponse(200, { ...podioItemUpdate, revision: state.revision });
    }
    if (p.startsWith(`/item/app/${appId}/external_id/`) && method === "GET") {
      const ext = decodeURIComponent(p.slice(`/item/app/${appId}/external_id/`.length));
      const found = state.createdByExternalId.get(ext);
      return found
        ? jsonResponse(200, { ...podioItemCreate, app: { app_id: appId }, fields: [] })
        : jsonResponse(404, podioNotFound);
    }
    if (p === `/item/app/${appId}/` && method === "POST") {
      const body = JSON.parse(init.body ?? "{}") as { external_id?: string };
      if (body.external_id)
        state.createdByExternalId.set(body.external_id, podioItemCreate.item_id);
      return jsonResponse(200, podioItemCreate);
    }
    if (p === `/comment/item/${itemId}` && method === "POST")
      return jsonResponse(200, podioComment);
    if (p === "/task/" && method === "POST") return jsonResponse(200, podioTask);
    return jsonResponse(404, podioNotFound);
  };

  return {
    fetch,
    requests,
    state,
    apiCalls: () => requests.filter((r) => !r.url.endsWith("/oauth/token")),
    failRefreshes() {
      refreshFails = true;
    },
  };
}

// v0.12 bankfeed: Plaid (docs/plan.md §1.52).
export {
  FAKE_CARD,
  FAKE_CHECKING,
  FAKE_INSTITUTION,
  FAKE_PLAID,
  type FakePlaid,
  type FakePlaidAccount,
  type FakePlaidItem,
  type FakePlaidTransaction,
  fakePlaid,
  fakePlaidAccounts,
  fakePlaidTransaction,
} from "./bankfeed/fake";
export {
  FAKE_ELEVENLABS,
  type FakeElevenLabs,
  type FakeRegisteredCall,
  fakeElevenLabs,
} from "./elevenlabs/fake";
// v0.14 W4-E: Google Chat (docs/plan.md §1.60).
export {
  FAKE_GCHAT,
  type FakeChatMessage,
  type FakeGoogleChat,
  fakeGoogleChat,
} from "./gchat/fake";
// v0.12 W3-B: Google Drive and Outlook (docs/plan.md §1.52).
export {
  FAKE_GOOGLE_DRIVE,
  type FakeDriveFile,
  type FakeGoogleDrive,
  fakeDriveText,
  fakeGoogleDrive,
} from "./gdrive/fake";
export {
  FAKE_GOOGLE,
  type FakeGmailMessage,
  type FakeGoogle,
  fakeGoogle,
  readSentEmail,
} from "./gmail/fake";
// v0.14 W4-D: Google Sheets.
export {
  FAKE_GOOGLE_SHEETS,
  type FakeGoogleSheets,
  type FakeSpreadsheet,
  fakeGoogleSheets,
} from "./gsheets/fake";
// v0.12 W3-B: Ramp and HubSpot (docs/plan.md §1.52).
export {
  FAKE_HUBSPOT,
  type FakeHubspot,
  type FakeHubspotObject,
  fakeHubspot,
} from "./hubspot/fake";
// v0.12 W3-B
export {
  FAKE_MICROSOFT,
  type FakeMicrosoft,
  type FakeOutlookMessage,
  fakeMicrosoft,
  MICROSOFT_CONSUMER_TENANT,
} from "./outlook/fake";
export { FAKE_QBO_CLIENT, FAKE_QBO_REALM, type FakeQbo, fakeQbo, QBO_FIXTURES } from "./qbo/fake";
export {
  FAKE_RAMP,
  type FakeRamp,
  type FakeRampReceipt,
  type FakeRampTransaction,
  fakeRamp,
} from "./ramp/fake";
export {
  FAKE_RESEND_MAIN,
  type FakeResend,
  type FakeResendEmail,
  fakeResend,
} from "./resend/fake";
// v0.14 W4-C
export {
  FAKE_SLACK,
  type FakeSlack,
  type FakeSlackChannel,
  type FakeSlackPost,
  fakeSlack,
} from "./slack/fake";
export * from "./stripe/fake";
export { FAKE_TWILIO_MAIN, type FakeTwilio, fakeTwilio } from "./twilio/fake";
// v0.14 W4-A: WhatsApp through Meta (docs/plan.md §1.57).
export {
  DEFAULT_FAKE_ACCOUNTS,
  FAKE_META,
  FAKE_META_MEDIA_HOST,
  type FakeMeta,
  type FakeMetaAccount,
  type FakeMetaSend,
  fakeInboundPayload,
  fakeMeta,
  fakeStatusPayload,
} from "./whatsapp_meta/fake";
