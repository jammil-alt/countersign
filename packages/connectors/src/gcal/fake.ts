// A fake Google Calendar for tests (re-exported by @countersign/connectors/testing; never imported
// by the Worker): Google's token endpoint for a `calendar.events.owned` grant (with an ID token for
// `openid email`), and the Calendar API calls the connector makes on the primary calendar: events
// list (single events in order of start, paged), get, insert with a client-chosen id (409 when it
// is taken) and patch (with `If-Match`). A second calendar the person owns holds events that must
// never be reached through the primary's paths. It keeps who Google would have emailed. Shaped like
// Google's answers as far as we know them (NOTES.md).

import { isoUtc, zonedToUtc } from "../calendar/time";
import type { FetchLike, HttpRequestInit, HttpResponseLike } from "../http";
import { formDecode, parseUrl } from "../http";
import { toBase64Url, utf8 } from "../runtime";
import { CALENDAR_API, GCAL_EVENTS_SCOPE } from "./index";

export const FAKE_GOOGLE_CALENDAR = {
  clientId: "1234-mezonas.apps.googleusercontent.com",
  clientSecret: "GOCSPX-fake-secret",
} as const;

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface FakeGoogleAttendee {
  email: string;
  displayName?: string;
  optional: boolean;
  responseStatus: "needsAction" | "accepted" | "declined" | "tentative";
}

export interface FakeGoogleEvent {
  id: string;
  calendarId: string;
  summary: string;
  description: string;
  location: string;
  allDay: boolean;
  /** Timed: the instants. */
  startMs: number;
  endMs: number;
  /** All-day: the dates. */
  startDate: string | null;
  endDate: string | null;
  timeZone: string | null;
  organizer: { email: string; displayName?: string; self: boolean };
  attendees: FakeGoogleAttendee[];
  transparency: "opaque" | "transparent";
  status: "confirmed" | "tentative" | "cancelled";
  recurringEventId: string | null;
  etag: number;
}

/** An email Google would have sent (`sendUpdates=all`). */
export interface FakeGoogleNotice {
  eventId: string;
  kind: "invitation" | "update";
  to: string[];
}

interface Grant {
  address: string;
  scopes: string[];
  emailVerified: boolean;
  revoked: boolean;
}

export interface FakeGoogleCalendar {
  fetch: FetchLike;
  requests: { url: string; method: string; headers: Record<string, string>; body: string }[];
  events: Map<string, FakeGoogleEvent>;
  notices: FakeGoogleNotice[];
  /** The primary calendar's zone, used for all-day events in a list's window. */
  timeZone: string;
  otherCalendarId: string;
  issueCode(opts?: { address?: string; scopes?: string[]; emailVerified?: boolean }): string;
  issued(): { accessTokens: string[]; refreshTokens: string[] };
  expireAccessTokens(): void;
  expireRefreshTokens(): void;
  seed(
    e: Partial<FakeGoogleEvent> & { summary: string } & (
        | { startMs: number; endMs: number }
        | { startDate: string; endDate: string }
      ),
  ): FakeGoogleEvent;
  touch(id: string, change?: Partial<FakeGoogleEvent>): void;
  /** The next insert is made, but its answer is lost (a 503). */
  loseNextInsertAnswer(): void;
}

function respond(status: number, body: unknown): HttpResponseLike {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => text,
  };
}

const error = (status: number, message: string) =>
  respond(status, { error: { code: status, message, errors: [{ message }] } });

function idToken(claims: Record<string, unknown>): string {
  const part = (v: unknown) => toBase64Url(utf8(JSON.stringify(v)));
  return `${part({ alg: "RS256", kid: "fake" })}.${part(claims)}.c2ln`;
}

const BASE32HEX = /^[0-9a-v]{5,1024}$/;

export function fakeGoogleCalendar(): FakeGoogleCalendar {
  let n = 0;
  const requests: FakeGoogleCalendar["requests"] = [];
  const events = new Map<string, FakeGoogleEvent>();
  const notices: FakeGoogleNotice[] = [];
  const codes = new Map<string, Grant>();
  const refreshTokens = new Map<string, Grant>();
  const accessTokens = new Map<string, { grant: Grant; live: boolean }>();
  const timeZone = "America/Chicago";
  const otherCalendarId = "c_team1234@group.calendar.google.com";
  let loseNext = false;
  let tag = 3181161784712000;

  function seed(
    e: Partial<FakeGoogleEvent> & { summary: string } & (
        | { startMs: number; endMs: number }
        | { startDate: string; endDate: string }
      ),
  ): FakeGoogleEvent {
    const allDay = "startDate" in e && e.startDate !== null && e.startDate !== undefined;
    const event: FakeGoogleEvent = {
      id: `ev${(++n).toString(32)}seed`,
      calendarId: "primary",
      description: "",
      location: "",
      allDay,
      startMs: 0,
      endMs: 0,
      startDate: null,
      endDate: null,
      timeZone: null,
      organizer: { email: "pat.lee@shop.example", self: true },
      attendees: [],
      transparency: "opaque",
      status: "confirmed",
      recurringEventId: null,
      etag: ++tag,
      ...e,
    };
    events.set(event.id, event);
    return event;
  }

  function tokens(grant: Grant, withIdToken: boolean) {
    const accessToken = `ya29.fake-calendar-access-${++n}`;
    accessTokens.set(accessToken, { grant, live: true });
    const refreshToken = `1//fake-calendar-refresh-${++n}`;
    refreshTokens.set(refreshToken, grant);
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: accessToken,
      expires_in: 3599,
      refresh_token: refreshToken,
      scope: grant.scopes.join(" "),
      token_type: "Bearer",
      ...(withIdToken
        ? {
            id_token: idToken({
              iss: "https://accounts.google.com",
              aud: FAKE_GOOGLE_CALENDAR.clientId,
              sub: `sub-${grant.address}`,
              email: grant.address,
              email_verified: grant.emailVerified,
              iat: now,
              exp: now + 3600,
            }),
          }
        : {}),
    };
  }

  function token(form: Record<string, string>): HttpResponseLike {
    if (
      form.client_id !== FAKE_GOOGLE_CALENDAR.clientId ||
      form.client_secret !== FAKE_GOOGLE_CALENDAR.clientSecret
    ) {
      return respond(401, { error: "invalid_client" });
    }
    if (form.grant_type === "authorization_code") {
      const grant = codes.get(form.code ?? "");
      if (!grant || !form.redirect_uri) return respond(400, { error: "invalid_grant" });
      codes.delete(form.code ?? "");
      return respond(200, tokens(grant, true));
    }
    if (form.grant_type === "refresh_token") {
      const grant = refreshTokens.get(form.refresh_token ?? "");
      if (!grant || grant.revoked) {
        return respond(400, {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        });
      }
      // Google keeps the refresh token: the answer has none.
      const { refresh_token: _r, ...rest } = tokens(grant, false);
      refreshTokens.delete(_r);
      return respond(200, rest);
    }
    return respond(400, { error: "unsupported_grant_type" });
  }

  const etag = (e: FakeGoogleEvent) => `"${e.etag}"`;
  const utc = (ms: number) => `${isoUtc(ms).slice(0, 19)}Z`;

  function render(e: FakeGoogleEvent) {
    return {
      kind: "calendar#event",
      etag: etag(e),
      id: e.id,
      status: e.status,
      htmlLink: `https://www.google.com/calendar/event?eid=${e.id}`,
      summary: e.summary,
      ...(e.description ? { description: e.description } : {}),
      ...(e.location ? { location: e.location } : {}),
      creator: { email: e.organizer.email, ...(e.organizer.self ? { self: true } : {}) },
      organizer: e.organizer.self ? { ...e.organizer, self: true } : { email: e.organizer.email },
      start: e.allDay
        ? { date: e.startDate }
        : { dateTime: utc(e.startMs), timeZone: e.timeZone ?? "UTC" },
      end: e.allDay
        ? { date: e.endDate }
        : { dateTime: utc(e.endMs), timeZone: e.timeZone ?? "UTC" },
      ...(e.transparency === "transparent" ? { transparency: "transparent" } : {}),
      ...(e.recurringEventId ? { recurringEventId: e.recurringEventId } : {}),
      ...(e.attendees.length
        ? {
            attendees: [
              ...(e.organizer.self
                ? [
                    {
                      email: e.organizer.email,
                      organizer: true,
                      self: true,
                      responseStatus: "accepted",
                    },
                  ]
                : []),
              ...e.attendees.map((a) => ({
                email: a.email,
                ...(a.displayName ? { displayName: a.displayName } : {}),
                ...(a.optional ? { optional: true } : {}),
                responseStatus: a.responseStatus,
              })),
            ],
          }
        : {}),
    };
  }

  /** The window's bounds for an event: all-day events in the calendar's own zone. */
  function bounds(e: FakeGoogleEvent): [number, number] {
    if (!e.allDay) return [e.startMs, e.endMs];
    return [
      zonedToUtc(`${e.startDate}T00:00`, timeZone),
      zonedToUtc(`${e.endDate}T00:00`, timeZone),
    ];
  }

  /** Google's EventDateTime, read; a string is Google's refusal. */
  function readTime(
    t: unknown,
  ): { allDay: true; date: string } | { allDay: false; ms: number; zone: string } | string {
    const v = t as { date?: unknown; dateTime?: unknown; timeZone?: unknown } | null;
    if (typeof v?.date === "string" && (v.dateTime === undefined || v.dateTime === null)) {
      return /^\d{4}-\d{2}-\d{2}$/.test(v.date) ? { allDay: true, date: v.date } : "bad date";
    }
    if (typeof v?.dateTime !== "string" || (v.date !== undefined && v.date !== null)) {
      return "Invalid start or end";
    }
    if (/(?:Z|[+-]\d{2}:\d{2})$/.test(v.dateTime)) {
      return { allDay: false, ms: Date.parse(v.dateTime), zone: String(v.timeZone ?? "UTC") };
    }
    if (typeof v.timeZone !== "string") return "Missing time zone definition for start time.";
    return { allDay: false, ms: zonedToUtc(v.dateTime, v.timeZone), zone: v.timeZone };
  }

  /** Applies an insert or patch body; a string is Google's refusal. */
  function apply(e: FakeGoogleEvent, body: Record<string, unknown>): string | null {
    if (body.summary !== undefined) e.summary = String(body.summary);
    if (body.description !== undefined) e.description = String(body.description ?? "");
    if (body.location !== undefined) e.location = String(body.location ?? "");
    if (body.start !== undefined || body.end !== undefined) {
      const s = readTime(body.start);
      const end = readTime(body.end);
      if (typeof s === "string") return s;
      if (typeof end === "string") return end;
      if (s.allDay !== end.allDay) return "start and end must both be dates or times";
      if (s.allDay && end.allDay) {
        if (end.date <= s.date) return "The specified time range is empty.";
        Object.assign(e, { allDay: true, startDate: s.date, endDate: end.date, timeZone: null });
      } else if (!s.allDay && !end.allDay) {
        if (end.ms <= s.ms) return "The specified time range is empty.";
        Object.assign(e, {
          allDay: false,
          startMs: s.ms,
          endMs: end.ms,
          startDate: null,
          endDate: null,
          timeZone: s.zone,
        });
      }
    }
    if (body.attendees !== undefined) {
      if (!Array.isArray(body.attendees)) return "attendees";
      const out: FakeGoogleAttendee[] = [];
      for (const a of body.attendees as {
        email?: unknown;
        optional?: unknown;
        responseStatus?: unknown;
      }[]) {
        if (typeof a.email !== "string" || !a.email.includes("@")) return "Invalid attendee email.";
        const had = e.attendees.find((x) => x.email === a.email);
        out.push({
          email: a.email,
          optional: a.optional === true,
          responseStatus:
            (a.responseStatus as FakeGoogleAttendee["responseStatus"] | undefined) ??
            had?.responseStatus ??
            "needsAction",
        });
      }
      e.attendees = out;
    }
    if (body.transparency !== undefined) {
      e.transparency = body.transparency === "transparent" ? "transparent" : "opaque";
    }
    return null;
  }

  function handle(
    method: string,
    path: string,
    query: Record<string, string>,
    headers: Record<string, string>,
    body: string,
  ): HttpResponseLike {
    const auth = headers.authorization ?? "";
    const at = accessTokens.get(auth.slice("Bearer ".length));
    if (!auth.startsWith("Bearer ") || !at?.live || at.grant.revoked) {
      return error(401, "Request had invalid authentication credentials.");
    }
    if (!at.grant.scopes.includes(GCAL_EVENTS_SCOPE)) {
      return error(403, "Request had insufficient authentication scopes.");
    }
    const m = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
    if (!m) return error(404, "Not Found");
    const cid = decodeURIComponent(m[1] ?? "");
    const id = m[2] === undefined ? null : decodeURIComponent(m[2]);
    if (cid !== "primary" && cid !== otherCalendarId) return error(404, "Not Found");
    const notify = (e: FakeGoogleEvent, kind: FakeGoogleNotice["kind"], to: string[]) => {
      if (query.sendUpdates === "all" && to.length) notices.push({ eventId: e.id, kind, to });
    };

    if (method === "GET" && id === null) {
      if (query.singleEvents !== "true" || query.orderBy !== "startTime") {
        return error(400, "the fake wants singleEvents=true and orderBy=startTime");
      }
      const from = Date.parse(query.timeMin ?? "");
      const to = Date.parse(query.timeMax ?? "");
      if (!Number.isFinite(from) || !Number.isFinite(to)) return error(400, "Bad Request");
      const max = Number(query.maxResults ?? "250");
      const skip = Number(query.pageToken ?? "0");
      const all = [...events.values()]
        .filter((e) => e.calendarId === cid && e.status !== "cancelled")
        .filter((e) => {
          const [s, end] = bounds(e);
          return end > from && s < to;
        })
        .sort((a, b) => bounds(a)[0] - bounds(b)[0]);
      const page = all.slice(skip, skip + max);
      return respond(200, {
        kind: "calendar#events",
        summary: cid === "primary" ? "pat.lee@shop.example" : "Team",
        timeZone,
        items: page.map(render),
        ...(skip + max < all.length ? { nextPageToken: String(skip + max) } : {}),
      });
    }

    if (method === "POST" && id === null) {
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return error(400, "Parse Error");
      }
      const wanted = typeof json.id === "string" ? json.id : null;
      if (wanted !== null && !BASE32HEX.test(wanted))
        return error(400, "Invalid resource id value.");
      if (wanted !== null && events.has(wanted)) {
        return error(409, "The requested identifier already exists.");
      }
      const e: FakeGoogleEvent = {
        id: wanted ?? `ev${(++n).toString(32)}made`,
        calendarId: cid,
        summary: "",
        description: "",
        location: "",
        allDay: false,
        startMs: 0,
        endMs: 0,
        startDate: null,
        endDate: null,
        timeZone: null,
        organizer: { email: at.grant.address, self: true },
        attendees: [],
        transparency: "opaque",
        status: "confirmed",
        recurringEventId: null,
        etag: ++tag,
      };
      if (json.start === undefined || json.end === undefined)
        return error(400, "Missing end time.");
      const problem = apply(e, json);
      if (problem) return error(400, problem);
      events.set(e.id, e);
      notify(
        e,
        "invitation",
        e.attendees.map((a) => a.email),
      );
      if (loseNext) {
        loseNext = false;
        return error(503, "Backend Error");
      }
      return respond(200, render(e));
    }

    const e = id === null ? undefined : events.get(id);
    // An event is reached only under its own calendar.
    if (!e || e.calendarId !== cid) return error(404, "Not Found");
    if (method === "GET") return respond(200, render(e));
    if (method === "PATCH") {
      const ifMatch = headers["if-match"];
      if (ifMatch !== undefined && ifMatch !== etag(e)) return error(412, "Precondition Failed");
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return error(400, "Parse Error");
      }
      const was = e.attendees.map((a) => a.email);
      const copy: FakeGoogleEvent = { ...e, attendees: [...e.attendees] };
      const problem = apply(copy, json);
      if (problem) return error(400, problem);
      Object.assign(e, copy, { etag: ++tag });
      const now = e.attendees.map((a) => a.email);
      notify(e, "update", [...now, ...was.filter((a) => !now.includes(a))]);
      return respond(200, render(e));
    }
    return error(405, "Method Not Allowed");
  }

  const fetch: FetchLike = async (url: string, init?: HttpRequestInit) => {
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const body = init?.body ?? "";
    if (url === TOKEN_URL && method === "POST") return token(formDecode(body));
    requests.push({ url, method, headers, body });
    const u = parseUrl(url);
    if (!u || !url.startsWith(`${CALENDAR_API}/`)) return error(404, "Not Found");
    const path = u.pathname.slice("/calendar/v3".length);
    return handle(method, path, formDecode(url.split("?")[1] ?? ""), headers, body);
  };

  return {
    fetch,
    requests,
    events,
    notices,
    timeZone,
    otherCalendarId,
    issueCode(opts = {}) {
      const code = `4/0Afake-calendar-code-${++n}`;
      codes.set(code, {
        address: opts.address ?? "pat.lee@shop.example",
        scopes: opts.scopes ?? [
          "openid",
          "https://www.googleapis.com/auth/userinfo.email",
          GCAL_EVENTS_SCOPE,
        ],
        emailVerified: opts.emailVerified ?? true,
        revoked: false,
      });
      return code;
    },
    issued: () => ({
      accessTokens: [...accessTokens.keys()],
      refreshTokens: [...refreshTokens.keys()],
    }),
    expireAccessTokens() {
      for (const t of accessTokens.values()) t.live = false;
    },
    expireRefreshTokens() {
      for (const g of refreshTokens.values()) g.revoked = true;
    },
    seed,
    touch(id, change = {}) {
      const e = events.get(id);
      if (!e) throw new Error(`no event ${id}`);
      Object.assign(e, change, { etag: ++tag });
    },
    loseNextInsertAnswer() {
      loseNext = true;
    },
  };
}
