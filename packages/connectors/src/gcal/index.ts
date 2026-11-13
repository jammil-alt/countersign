// "gcal": Google Calendar, on the person's primary calendar (docs/plan.md §1.97). A person at the
// client signs in to their Google account from the portal, on the same Google OAuth client as
// Gmail and Drive; we ask Google for `calendar.events.owned` (with `openid email` for the
// address), the narrowest scope that can read and make events on the primary calendar. Every call
// names the primary calendar, so an event on any other calendar is never reached. The tools are
// the shared calendar tools (../calendar), the same as Outlook Calendar's, so a workflow runs on
// either. Event text reaches models only in tool results (invariant 9). Unchecked facts about
// Google: ./NOTES.md.

import type { JsonObject } from "@countersign/core";
import { z } from "zod";
import {
  CALENDAR_NAMESPACE,
  CALENDAR_PERMISSION_ENTITIES,
  type CalendarAttendee,
  type CalendarEvent,
  type CalendarProvider,
  calendarTools,
  type EventChange,
  EventChangedError,
  type EventTimes,
  isoUtc,
  isTimeZone,
  type ProviderEvent,
  zonedToUtc,
} from "../calendar/index";
import {
  type ConnectionContext,
  type Connector,
  defineConnector,
  NotWrittenError,
  type ToolContext,
  UnconfirmedWriteError,
  type WriteContext,
} from "../connector";
import { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, grantedScopes, idTokenAddress } from "../gmail/index";
import {
  type FetchLike,
  formEncode,
  globalFetch,
  type HttpResponseLike,
  timeoutSignal,
} from "../http";
import {
  OAuthTokens,
  ReconnectRequiredError,
  SignInRefusedError,
  type TokenRefresher,
  tokenManager,
} from "../oauth/tokens";
import { sha256Bytes, toHex, utf8 } from "../runtime";

export const GCAL_CONNECTOR_ID = "gcal";

export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
/** Every call is on the primary calendar: nothing else is ever named. */
export const GCAL_EVENTS_URL = `${CALENDAR_API}/calendars/primary/events`;

/** Events on calendars the person owns (their primary among them); not calendars shared with them. */
export const GCAL_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";
// DECISION: `calendar.events.owned`, not `calendar.events` (which also reaches every calendar
// shared with the person) or `calendar` (calendars, sharing and settings too): it is the narrowest
// scope that can list, make and change events on the primary calendar. It still reaches the
// person's other owned calendars, so every call names `primary`. `openid email` beside it, so the
// token answer's ID token gives the address (as Gmail does): the events scope can't read the
// profile, and the primary calendar's metadata needs a calendars scope (NOTES.md).
export const GCAL_SCOPES: readonly string[] = ["openid", "email", GCAL_EVENTS_SCOPE];

/** Every Google scope other than these is refused if a grant carries it: we hold nothing more. */
const ALLOWED_SCOPES = new Set([...GCAL_SCOPES, "https://www.googleapis.com/auth/userinfo.email"]);

export const GcalCredentials = OAuthTokens.extend({ address: z.string().min(3) });
export type GcalCredentials = z.infer<typeof GcalCredentials>;

/** What `connection.config` holds: whose calendar. */
export const GcalConfig = z.looseObject({
  address: z.string(),
  calendarId: z.literal("primary"),
  scopes: z.array(z.string()).optional(),
});
export type GcalConfig = z.infer<typeof GcalConfig>;

const TokenAnswer = z.union([
  z.looseObject({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().optional(),
    token_type: z.string().optional(),
    id_token: z.string().optional(),
  }),
  z.looseObject({ error: z.string(), error_description: z.string().optional() }),
]);

const GoogleTime = z.looseObject({
  date: z.string().nullish(),
  dateTime: z.string().nullish(),
  timeZone: z.string().nullish(),
});
const GooglePerson = z.looseObject({
  email: z.string().nullish(),
  displayName: z.string().nullish(),
  self: z.boolean().nullish(),
});

export const GoogleEvent = z.looseObject({
  id: z.string().min(1),
  etag: z.string().nullish(),
  status: z.string().nullish(),
  htmlLink: z.string().nullish(),
  summary: z.string().nullish(),
  description: z.string().nullish(),
  location: z.string().nullish(),
  start: GoogleTime.nullish(),
  end: GoogleTime.nullish(),
  organizer: GooglePerson.nullish(),
  attendees: z
    .array(
      GooglePerson.extend({
        responseStatus: z.string().nullish(),
        optional: z.boolean().nullish(),
      }),
    )
    .nullish(),
  transparency: z.string().nullish(),
  recurringEventId: z.string().nullish(),
  recurrence: z.array(z.string()).nullish(),
});
type GoogleEvent = z.infer<typeof GoogleEvent>;

const EventPage = z.looseObject({
  items: z.array(GoogleEvent).default([]),
  nextPageToken: z.string().optional(),
});

export class GcalApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** 429 and 5xx: a later try may get through (the step's retry). */
    readonly retryable = status === 429 || status >= 500,
  ) {
    super(message);
    this.name = "GcalApiError";
  }
}

export class GcalNotConfiguredError extends Error {
  constructor() {
    super(
      "Google Calendar sign-in is not set up on this deployment (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)",
    );
    this.name = "GcalNotConfiguredError";
  }
}

export interface GcalOptions {
  /** Google Cloud's OAuth client ("Mezonas web"), the one Gmail and Drive use. */
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  fetch?: FetchLike;
}

/** The event id an action's create asks Google for: a hash of its key, in base32hex letters. */
// DECISION: Google takes a client-chosen event id (base32hex: 0-9 and a-v, 5 to 1024 characters)
// and answers 409 when the calendar already has it, so the id is the first 40 hex characters of
// sha256("gcal:" + the action's key) (hex is within base32hex): a retried step can't make two.
export async function gcalEventId(idempotencyKey: string): Promise<string> {
  return toHex(await sha256Bytes(utf8(`gcal:${idempotencyKey}`))).slice(0, 40);
}

function readJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function googleMessage(json: unknown): string {
  const msg = (json as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof msg === "string" ? msg : "no reason given";
}

const RESPONSES: Record<string, CalendarAttendee["response"]> = {
  accepted: "accepted",
  declined: "declined",
  tentative: "tentative",
};
const GOOGLE_RESPONSES: Record<CalendarAttendee["response"], string> = {
  accepted: "accepted",
  declined: "declined",
  tentative: "tentative",
  none: "needsAction",
};

/** An instant from Google's `dateTime` (with its offset, or a local time in `timeZone`). */
function googleInstant(t: z.infer<typeof GoogleTime>): number {
  const value = t.dateTime ?? "";
  const ms = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isFinite(ms)) return ms;
  if (t.timeZone && isTimeZone(t.timeZone) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) {
    return zonedToUtc(value, t.timeZone);
  }
  throw new GcalApiError(502, "Google Calendar answered a time we can't read", false);
}

/** A Google event as the calendar tools read it; `account` is left out of the attendees. */
export function readGoogleEvent(e: GoogleEvent, account: string): ProviderEvent {
  const self = account.toLowerCase();
  if (!e.start || !e.end) {
    throw new GcalApiError(502, "Google Calendar answered an event without times", false);
  }
  const allDay = Boolean(e.start.date);
  const attendees: CalendarAttendee[] = [];
  for (const a of e.attendees ?? []) {
    const address = a.email?.trim().toLowerCase();
    if (!address || a.self === true || address === self) continue;
    attendees.push({
      address,
      name: a.displayName?.trim() || null,
      response: RESPONSES[a.responseStatus ?? ""] ?? "none",
      optional: a.optional === true,
    });
  }
  return {
    id: e.id,
    title: e.summary ?? "",
    allDay,
    startMs: allDay ? null : googleInstant(e.start),
    endMs: allDay ? null : googleInstant(e.end),
    startDate: allDay ? (e.start.date ?? null) : null,
    endDate: allDay ? (e.end.date ?? null) : null,
    location: e.location?.trim() || null,
    description: e.description?.trim() ? e.description : null,
    organizer: {
      address: e.organizer?.email?.trim().toLowerCase() || null,
      name: e.organizer?.displayName?.trim() || null,
    },
    mine: e.organizer?.self === true,
    attendees,
    busy: e.transparency !== "transparent",
    cancelled: e.status === "cancelled",
    recurring: Boolean(e.recurringEventId) || Boolean(e.recurrence?.length),
    link: e.htmlLink ?? null,
    version: e.etag ?? "",
    descriptionLocked: null,
  };
}

/** Google's start and end for these times; a change clears the form it no longer uses. */
export function googleTimes(t: EventTimes, clearOther: boolean): JsonObject {
  const clear = clearOther ? { dateTime: null, timeZone: null } : {};
  if (t.allDay) return { start: { date: t.start, ...clear }, end: { date: t.end, ...clear } };
  const clearDate = clearOther ? { date: null } : {};
  return {
    start: { dateTime: t.start, timeZone: t.timeZone ?? "UTC", ...clearDate },
    end: { dateTime: t.end, timeZone: t.timeZone ?? "UTC", ...clearDate },
  };
}

/** The Google body for a change: only the fields it sets. */
export function googleChange(change: EventChange, current: CalendarEvent): JsonObject {
  const responses = new Map(current.attendees.map((a) => [a.address, a.response]));
  return {
    ...(change.title === undefined ? {} : { summary: change.title }),
    ...(change.times === undefined ? {} : googleTimes(change.times, true)),
    ...(change.location === undefined ? {} : { location: change.location ?? "" }),
    ...(change.description === undefined ? {} : { description: change.description ?? "" }),
    ...(change.attendees === undefined
      ? {}
      : {
          // The whole list; people who stay keep their answer (NOTES.md "To verify").
          attendees: change.attendees.map((a) => ({
            email: a.address,
            optional: a.optional,
            responseStatus: GOOGLE_RESPONSES[responses.get(a.address) ?? "none"],
          })),
        }),
    ...(change.busy === undefined ? {} : { transparency: change.busy ? "opaque" : "transparent" }),
  };
}

type Call = (
  method: string,
  url: string,
  opts?: { json?: unknown; headers?: Record<string, string>; accept?: readonly number[] },
) => Promise<{ status: number; json: unknown }>;

export function createGcalConnector(options: GcalOptions = {}): Connector {
  const doFetch = (): FetchLike => options.fetch ?? globalFetch();
  const configured = Boolean(options.clientId && options.clientSecret);

  function client(): { id: string; secret: string } {
    if (!options.clientId || !options.clientSecret) throw new GcalNotConfiguredError();
    return { id: options.clientId, secret: options.clientSecret };
  }

  async function tokenCall(fields: Record<string, string>): Promise<z.infer<typeof TokenAnswer>> {
    const res = await doFetch()(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: formEncode(fields),
      redirect: "manual",
      signal: timeoutSignal(15_000),
    });
    const parsed = TokenAnswer.safeParse(readJson(await res.text()));
    if (!parsed.success) {
      throw new GcalApiError(res.status, "Google's token answer has an unexpected shape");
    }
    return parsed.data;
  }

  const expiresAt = (now: Date, seconds: number) =>
    new Date(now.getTime() + seconds * 1000).toISOString();

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
        // invalid_grant: revoked, or expired (after 7 days while the app is in Testing).
        throw new ReconnectRequiredError(`Google refused the refresh: ${answer.error}`);
      }
      return {
        ...tokens,
        accessToken: answer.access_token,
        expiresAt: expiresAt(now, answer.expires_in),
        ...(answer.scope ? { scope: answer.scope } : {}),
        ...(answer.refresh_token ? { refreshToken: answer.refresh_token } : {}),
      };
    },
  };

  /** One Calendar API call for a connection: refreshed before expiry and once after a 401. */
  function callFor(ctx: Pick<ConnectionContext, "credentials" | "now">): Call {
    const tokens = tokenManager({ credentials: ctx.credentials, refresher, now: ctx.now });
    return async (method, url, opts = {}) => {
      const res: HttpResponseLike = await tokens.withAccessToken(
        (token) =>
          doFetch()(url, {
            method,
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/json",
              ...(opts.json === undefined ? {} : { "content-type": "application/json" }),
              ...(opts.headers ?? {}),
            },
            ...(opts.json === undefined ? {} : { body: JSON.stringify(opts.json) }),
            redirect: "manual",
            signal: timeoutSignal(30_000),
          }),
        (r) => r.status === 401,
      );
      const json = readJson(await res.text());
      if (res.status === 401) throw new ReconnectRequiredError("Google refused the access token");
      if (!res.ok && !opts.accept?.includes(res.status)) {
        throw new GcalApiError(
          res.status,
          `Google Calendar refused the request (${res.status}): ${googleMessage(json)}`,
        );
      }
      return { status: res.status, json };
    };
  }

  async function account(ctx: ToolContext): Promise<string> {
    const config = GcalConfig.safeParse(ctx.connection.config);
    if (!config.success) {
      throw new ReconnectRequiredError("the Google Calendar connection has no calendar");
    }
    if (ctx.connection.externalAccountId) return ctx.connection.externalAccountId.toLowerCase();
    const creds = GcalCredentials.safeParse(await ctx.credentials.get());
    if (!creds.success) {
      throw new ReconnectRequiredError("the Google Calendar connection has no valid sign-in");
    }
    return creds.data.address.toLowerCase();
  }

  function readEvent(json: unknown, self: string): ProviderEvent {
    const e = GoogleEvent.safeParse(json);
    if (!e.success) throw new GcalApiError(502, "Google's event has an unexpected shape", false);
    return readGoogleEvent(e.data, self);
  }

  /** A Google refusal of a write that made nothing (it answered, and said no). */
  function notWritten(error: unknown): unknown {
    if (error instanceof GcalApiError && !error.retryable && error.status < 500) {
      return new NotWrittenError(error.message);
    }
    return error;
  }

  const eventUrl = (id: string, params: Record<string, string> = {}) => {
    const q = formEncode(params);
    return `${GCAL_EVENTS_URL}/${encodeURIComponent(id)}${q ? `?${q}` : ""}`;
  };

  const provider: CalendarProvider = {
    provider: "Google Calendar",
    // DECISION: `sendUpdates=all` on every create and change: everyone on the event is told, as
    // Outlook always does, so the calendar and the invitees agree.
    attendeesOnlyNotifiesChanged: false,
    account,

    async list(ctx, window, max) {
      const call = callFor(ctx);
      const self = await account(ctx);
      const collected: GoogleEvent[] = [];
      let pageToken: string | undefined;
      // Pages until one more than asked for (to know there are more), ten pages at most.
      for (let page = 0; page < 10 && collected.length <= max; page++) {
        const { json } = await call(
          "GET",
          `${GCAL_EVENTS_URL}?${formEncode({
            timeMin: isoUtc(window.fromMs),
            timeMax: isoUtc(window.toMs),
            singleEvents: "true",
            orderBy: "startTime",
            showDeleted: "false",
            timeZone: "UTC",
            maxResults: String(Math.min(max + 1, 250)),
            ...(pageToken ? { pageToken } : {}),
          })}`,
        );
        const parsed = EventPage.safeParse(json);
        if (!parsed.success) {
          throw new GcalApiError(502, "Google's event list has an unexpected shape", false);
        }
        collected.push(...parsed.data.items);
        pageToken = parsed.data.nextPageToken;
        if (!pageToken) break;
      }
      return {
        events: collected.slice(0, max).map((e) => readGoogleEvent(e, self)),
        more: collected.length > max || pageToken !== undefined,
      };
    },

    async get(ctx, id) {
      const call = callFor(ctx);
      // On the primary calendar only: an event on any other calendar answers 404.
      const res = await call("GET", eventUrl(id), { accept: [400, 404, 410] });
      if (res.status !== 200) return null;
      return readEvent(res.json, await account(ctx));
    },

    async create(ctx: WriteContext, draft) {
      const call = callFor(ctx);
      const self = await account(ctx);
      const id = await gcalEventId(ctx.idempotencyKey);
      const body: JsonObject = {
        id,
        summary: draft.title,
        ...googleTimes(draft, false),
        ...(draft.location ? { location: draft.location } : {}),
        ...(draft.description ? { description: draft.description } : {}),
        attendees: draft.attendees.map((a) => ({ email: a.address, optional: a.optional })),
        transparency: draft.busy ? "opaque" : "transparent",
      };
      let res: { status: number; json: unknown };
      try {
        res = await call("POST", `${GCAL_EVENTS_URL}?${formEncode({ sendUpdates: "all" })}`, {
          json: body,
          accept: [409],
        });
      } catch (error) {
        throw notWritten(error);
      }
      if (res.status !== 409) return { event: readEvent(res.json, self), alreadyDone: false };
      // Executed once: the calendar already has this action's event (a retried step).
      const earlier = await call("GET", eventUrl(id), { accept: [404, 410] });
      if (earlier.status === 200)
        return { event: readEvent(earlier.json, self), alreadyDone: true };
      throw new UnconfirmedWriteError(
        `The event "${draft.title}" may already have been made in Google Calendar`,
        "Google says this action's event exists, but it isn't on the calendar now",
        { eventId: id, calendar: self },
      );
    },

    async update(ctx: WriteContext, event, change) {
      const call = callFor(ctx);
      let res: { status: number; json: unknown };
      try {
        res = await call("PATCH", eventUrl(event.id, { sendUpdates: "all" }), {
          json: googleChange(change, event),
          headers: { "if-match": event.version },
          accept: [412],
        });
      } catch (error) {
        throw notWritten(error);
      }
      if (res.status === 412) throw new EventChangedError(event.title);
      return readEvent(res.json, await account(ctx));
    },
  };

  return defineConnector({
    id: GCAL_CONNECTOR_ID,
    name: "Google Calendar",
    description:
      "See and add events on your Google Calendar, and change the ones you organize. We never cancel or delete one.",
    icon: "calendar",
    auth: "oauth2",
    entities: [],
    sharedNamespaces: [CALENDAR_NAMESPACE],
    permissionEntities: CALENDAR_PERMISSION_ENTITIES,
    isConfigured: () => configured,

    async authorize(req) {
      const c = client();
      const query = formEncode({
        client_id: c.id,
        redirect_uri: req.redirectUri,
        response_type: "code",
        scope: GCAL_SCOPES.join(" "),
        // A refresh token, every time: Google gives one only with offline access, and on a
        // reconnect only when consent is asked again.
        access_type: "offline",
        prompt: "consent",
        // Never widen to scopes granted to Mezonas before (Gmail's, Drive's).
        include_granted_scopes: "false",
        state: req.state,
      });
      return { redirectUrl: `${GOOGLE_AUTH_URL}?${query}` };
    },

    async handleCallback(params, req) {
      const code = params.code;
      if (!code) throw new Error("the Google callback has no code");
      const c = client();
      const answer = await tokenCall({
        grant_type: "authorization_code",
        code,
        client_id: c.id,
        client_secret: c.secret,
        redirect_uri: req.redirectUri,
      });
      if ("error" in answer) throw new Error(`Google refused the sign-in: ${answer.error}`);
      const scopes = grantedScopes(answer.scope);
      if (!scopes.includes(GCAL_EVENTS_SCOPE)) {
        // Granular consent: the person unticked the calendar permission.
        throw new SignInRefusedError(
          "Google didn't give us permission to use your calendar. Connect again and allow it.",
        );
      }
      if (scopes.some((s) => !ALLOWED_SCOPES.has(s))) {
        throw new SignInRefusedError(
          "Google gave more access than we ask for, so we didn't keep it",
        );
      }
      if (!answer.refresh_token) throw new Error("Google gave no refresh token");
      if (!answer.id_token) {
        throw new SignInRefusedError("Google didn't say which account signed in");
      }
      const now = new Date();
      const address = idTokenAddress(answer.id_token, c.id, now);
      const credentials: GcalCredentials = GcalCredentials.parse({
        accessToken: answer.access_token,
        refreshToken: answer.refresh_token,
        expiresAt: expiresAt(now, answer.expires_in),
        tokenType: answer.token_type ?? "Bearer",
        scope: scopes.join(" "),
        address,
      });
      const config: GcalConfig = {
        address,
        calendarId: "primary",
        scopes: ["calendar.events.owned"],
      };
      return {
        externalAccountId: address,
        credentials: credentials as unknown as JsonObject,
        config: config as unknown as JsonObject,
      };
    },

    tokens: refresher,
    // DECISION: no `revoke`, as for Drive: Calendar shares Gmail's OAuth client, and Google's
    // revoke ends every scope the account granted that client, so it could end a Gmail or Drive
    // connection made by the same Google account. Disconnect drops our tokens only (NOTES.md).

    tools: calendarTools(provider),
  });
}
