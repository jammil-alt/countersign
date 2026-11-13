// A fake Outlook Calendar for tests (re-exported by @countersign/connectors/testing; never
// imported by the Worker): the shared fake Microsoft identity platform (../microsoft/fake.ts) and
// the Graph calendar calls the connector makes: the default calendar, a calendar view (UTC and
// text only, as the connector asks), an event by id under a calendar, events found by our extended
// property, event create (with `transactionId`, which answers the first event again) and update
// (with `If-Match`). Two calendars: the default, and another the person owns, whose events must
// never be reached through the default's paths. It keeps who Graph would have emailed. Shaped like
// Graph's answers as far as we know them (NOTES.md).

import { isoUtc, isTimeZone, zonedToUtc } from "../calendar/time";
import type { HttpResponseLike } from "../http";
import { formDecode, parseUrl } from "../http";
import {
  type FakeMicrosoftApp,
  type FakeMicrosoftIdentity,
  fakeMicrosoftIdentity,
  graphErrorResponse,
  jsonResponse,
  unauthorized,
} from "../microsoft/fake";
import type { GraphFetch, GraphRequestInit } from "../microsoft/identity";
import { GRAPH_API } from "../microsoft/identity";
import { CALENDARS_READWRITE, GRAPH_IANA_ZONES } from "./index";

export const FAKE_OUTLOOK_CALENDAR: FakeMicrosoftApp = {
  clientId: "6f1c0d2e-0000-4000-8000-00000000ca1e",
  clientSecret: "fake~outlook~calendar~secret",
};

export interface FakeGraphAttendee {
  address: string;
  name: string;
  type: "required" | "optional";
  response: "none" | "accepted" | "declined" | "tentativelyAccepted" | "notResponded";
}

export interface FakeGraphEvent {
  id: string;
  calendarId: string;
  subject: string;
  isAllDay: boolean;
  /** Timed: the instants. All-day: midnight UTC of the dates. */
  startMs: number;
  endMs: number;
  /** The zone it was written in (Graph's `originalStartTimeZone`). */
  zone: string;
  location: string;
  body: string;
  organizer: { name: string; address: string };
  isOrganizer: boolean;
  attendees: FakeGraphAttendee[];
  showAs: string;
  isCancelled: boolean;
  isOnlineMeeting: boolean;
  seriesMasterId: string | null;
  changeKey: number;
  transactionId: string | null;
  props: Record<string, string>;
}

/** An email Graph would have sent: invitations and meeting updates. */
export interface FakeGraphNotice {
  eventId: string;
  kind: "invitation" | "update";
  to: string[];
}

export interface FakeOutlookCalendar {
  fetch: GraphFetch;
  identity: FakeMicrosoftIdentity;
  /** Every Graph request, in order. */
  requests: { url: string; method: string; headers: Record<string, string>; body: string }[];
  events: Map<string, FakeGraphEvent>;
  notices: FakeGraphNotice[];
  /** The default calendar's id, and another calendar the person owns. */
  calendarId: string;
  otherCalendarId: string;
  issueCode(opts?: Parameters<FakeMicrosoftIdentity["issueCode"]>[0]): string;
  /** An event already on a calendar (default: the default calendar, organized by the person). */
  seed(
    e: Partial<FakeGraphEvent> & { subject: string; startMs: number; endMs: number },
  ): FakeGraphEvent;
  /** Someone changes the event in Outlook (its changeKey moves). */
  touch(id: string, change?: Partial<FakeGraphEvent>): void;
  /** The next create is made, but its answer is lost (a 503), as in a dropped connection. */
  loseNextCreateAnswer(): void;
  /** Turns off our extended-property lookup, so only `transactionId` guards a retry. */
  hidePropertyLookups(): void;
}

const ACCOUNT_DEFAULT = "pat.lee@shop.example";

export function fakeOutlookCalendar(
  app: FakeMicrosoftApp = FAKE_OUTLOOK_CALENDAR,
): FakeOutlookCalendar {
  const identity = fakeMicrosoftIdentity([CALENDARS_READWRITE], app);
  const requests: FakeOutlookCalendar["requests"] = [];
  const events = new Map<string, FakeGraphEvent>();
  const notices: FakeGraphNotice[] = [];
  const calendarId = "AAMkAGI2-default-calendar=";
  const otherCalendarId = "AAMkAGI2-birthdays-calendar=";
  let n = 0;
  let loseNext = false;
  let propertyLookups = true;

  const newId = () => `AAMkAGI2TG93AAA-event-${++n}=`;

  function seed(
    e: Partial<FakeGraphEvent> & { subject: string; startMs: number; endMs: number },
  ): FakeGraphEvent {
    const event: FakeGraphEvent = {
      id: newId(),
      calendarId,
      isAllDay: false,
      zone: "UTC",
      location: "",
      body: "",
      organizer: { name: "Pat Lee", address: ACCOUNT_DEFAULT },
      isOrganizer: true,
      attendees: [],
      showAs: "busy",
      isCancelled: false,
      isOnlineMeeting: false,
      seriesMasterId: null,
      changeKey: 1,
      transactionId: null,
      props: {},
      ...e,
    };
    events.set(event.id, event);
    return event;
  }

  const etag = (e: FakeGraphEvent) => `W/"DwAAABYAAAA${e.changeKey}"`;
  const graphTime = (ms: number) => ({
    dateTime: `${isoUtc(ms).slice(0, 19)}.0000000`,
    timeZone: "UTC",
  });

  function render(e: FakeGraphEvent) {
    return {
      "@odata.etag": etag(e),
      id: e.id,
      changeKey: `DwAAABYAAAA${e.changeKey}`,
      subject: e.subject,
      start: graphTime(e.startMs),
      end: graphTime(e.endMs),
      isAllDay: e.isAllDay,
      location: { displayName: e.location },
      body: { contentType: "text", content: e.body },
      bodyPreview: e.body.slice(0, 255),
      organizer: { emailAddress: e.organizer },
      attendees: e.attendees.map((a) => ({
        type: a.type,
        status: { response: a.response, time: "0001-01-01T00:00:00Z" },
        emailAddress: { name: a.name, address: a.address },
      })),
      showAs: e.showAs,
      isCancelled: e.isCancelled,
      isOrganizer: e.isOrganizer,
      isOnlineMeeting: e.isOnlineMeeting,
      type: e.seriesMasterId ? "occurrence" : "singleInstance",
      seriesMasterId: e.seriesMasterId,
      webLink: `https://outlook.office365.com/owa/?itemid=${encodeURIComponent(e.id)}&exvsurl=1&path=/calendar/item`,
      ...(e.transactionId ? { transactionId: e.transactionId } : {}),
    };
  }

  /** Graph's dateTimeTimeZone, read: "UTC", or a zone Graph documents. */
  function readTime(t: unknown, allDay: boolean): number | string {
    const v = t as { dateTime?: unknown; timeZone?: unknown } | null;
    if (typeof v?.dateTime !== "string" || typeof v.timeZone !== "string") return "missing time";
    const local = v.dateTime.slice(0, 19);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(local)) return "bad dateTime";
    if (allDay) {
      if (!local.endsWith("T00:00:00")) return "an all-day event starts and ends at midnight";
      return Date.parse(`${local.slice(0, 10)}T00:00:00Z`);
    }
    if (v.timeZone === "UTC") return Date.parse(`${local}Z`);
    if (!GRAPH_IANA_ZONES.has(v.timeZone) || !isTimeZone(v.timeZone)) {
      return `time zone ${v.timeZone} isn't supported`;
    }
    return zonedToUtc(local, v.timeZone);
  }

  function readAttendees(
    list: unknown,
    before: FakeGraphAttendee[] = [],
  ): FakeGraphAttendee[] | string {
    if (!Array.isArray(list)) return "attendees is a list";
    const out: FakeGraphAttendee[] = [];
    for (const a of list as { emailAddress?: { address?: unknown }; type?: unknown }[]) {
      const address = a.emailAddress?.address;
      if (typeof address !== "string" || !address.includes("@")) return "attendee without address";
      const had = before.find((b) => b.address === address.toLowerCase());
      out.push({
        address: address.toLowerCase(),
        name: had?.name ?? address,
        type: a.type === "optional" ? "optional" : "required",
        response: had?.response ?? "none",
      });
    }
    return out;
  }

  /** Applies a POST or PATCH body's fields; a string is Graph's refusal. */
  function apply(e: FakeGraphEvent, body: Record<string, unknown>): string | null {
    if (body.subject !== undefined) {
      if (typeof body.subject !== "string") return "subject";
      e.subject = body.subject;
    }
    if (body.start !== undefined || body.end !== undefined || body.isAllDay !== undefined) {
      const allDay = body.isAllDay === true;
      const s = readTime(body.start, allDay);
      const end = readTime(body.end, allDay);
      if (typeof s === "string") return s;
      if (typeof end === "string") return end;
      if (end <= s) return "the end is before the start";
      e.isAllDay = allDay;
      e.startMs = s;
      e.endMs = end;
      e.zone = String((body.start as { timeZone?: unknown }).timeZone);
    }
    if (body.location !== undefined) {
      const name = (body.location as { displayName?: unknown } | null)?.displayName;
      if (typeof name !== "string") return "location";
      e.location = name;
    }
    if (body.body !== undefined) {
      const b = body.body as { contentType?: unknown; content?: unknown } | null;
      if (b?.contentType !== "text" || typeof b.content !== "string") return "body";
      e.body = b.content;
    }
    if (body.attendees !== undefined) {
      const list = readAttendees(body.attendees, e.attendees);
      if (typeof list === "string") return list;
      e.attendees = list;
    }
    if (body.showAs !== undefined) e.showAs = String(body.showAs);
    return null;
  }

  function calendarEvents(cid: string) {
    return [...events.values()].filter((e) => e.calendarId === cid);
  }

  function handle(
    method: string,
    u: NonNullable<ReturnType<typeof parseUrl>>,
    headers: Record<string, string>,
    body: string,
  ): HttpResponseLike {
    const grant = identity.grantFor(headers);
    if (!grant) return unauthorized();
    if (!identity.hasScope(grant, CALENDARS_READWRITE)) {
      return graphErrorResponse(403, "ErrorAccessDenied", "Access is denied.");
    }
    const path = decodeURIComponent(u.pathname.slice("/v1.0".length));
    const query: Record<string, string> = formDecode(u.href.split("?")[1] ?? "");
    const param = (k: string): string | null => query[k] ?? null;
    const prefer = headers.prefer ?? "";
    const utcText =
      prefer.includes('outlook.timezone="UTC"') && prefer.includes('body-content-type="text"');

    if (method === "GET" && path === "/me/calendar") {
      return jsonResponse(200, { id: calendarId, name: "Calendar" });
    }

    // Our extended-property lookup: `/me/events?$filter=singleValueExtendedProperties/Any(...)`.
    if (method === "GET" && path === "/me/events") {
      if (!utcText) return graphErrorResponse(400, "BadRequest", "the fake wants UTC and text");
      const m =
        /^singleValueExtendedProperties\/Any\(ep: ep\/id eq '([^']+)' and ep\/value eq '([0-9a-f]+)'\)$/.exec(
          param("$filter") ?? "",
        );
      if (!m) return graphErrorResponse(400, "BadRequest", "unsupported $filter");
      const found = propertyLookups
        ? [...events.values()].filter((e) => e.props[m[1] ?? ""] === m[2])
        : [];
      return jsonResponse(200, { value: found.map(render) });
    }

    const cal = /^\/me\/calendars\/([^/]+)(\/.*)$/.exec(path);
    if (!cal) return graphErrorResponse(400, "BadRequest", `the fake has no ${method} ${path}`);
    const cid = cal[1] ?? "";
    const rest = cal[2] ?? "";
    if (cid !== calendarId && cid !== otherCalendarId) {
      return graphErrorResponse(
        404,
        "ErrorItemNotFound",
        "The specified object was not found in the store.",
      );
    }

    if (method === "GET" && rest === "/calendarView") {
      if (!utcText) return graphErrorResponse(400, "BadRequest", "the fake wants UTC and text");
      const from = Date.parse(param("startDateTime") ?? "");
      const to = Date.parse(param("endDateTime") ?? "");
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        return graphErrorResponse(400, "ErrorInvalidParameter", "startDateTime and endDateTime");
      }
      if (param("$orderby") !== "start/dateTime") {
        return graphErrorResponse(400, "BadRequest", "the fake wants $orderby=start/dateTime");
      }
      const top = Number(param("$top") ?? "10");
      const skip = Number(param("$skip") ?? "0");
      const all = calendarEvents(cid)
        .filter((e) => e.endMs > from && e.startMs < to)
        .sort((a, b) => a.startMs - b.startMs);
      const page = all.slice(skip, skip + top);
      const next = skip + top < all.length;
      const nextQuery = Object.entries({ ...query, $skip: String(skip + top) })
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&");
      return jsonResponse(200, {
        value: page.map(render),
        ...(next
          ? {
              "@odata.nextLink": `${GRAPH_API}/me/calendars/${encodeURIComponent(cid)}/calendarView?${nextQuery}`,
            }
          : {}),
      });
    }

    if (method === "POST" && rest === "/events") {
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return graphErrorResponse(400, "BadRequest", "body");
      }
      // Graph's guard against a repeated POST: the event made with this transactionId comes back.
      const tx = typeof json.transactionId === "string" ? json.transactionId : null;
      const repeat = tx ? [...events.values()].find((e) => e.transactionId === tx) : undefined;
      if (repeat) return jsonResponse(201, render(repeat));
      const e = seed({
        subject: "",
        startMs: 0,
        endMs: 0,
        calendarId: cid,
        organizer: { name: "Pat Lee", address: grant.address },
      });
      const problem = apply(e, json);
      if (problem || e.subject === "") {
        events.delete(e.id);
        return graphErrorResponse(400, "ErrorInvalidRequest", problem ?? "subject");
      }
      e.transactionId = tx;
      for (const p of (json.singleValueExtendedProperties as
        | { id: string; value: string }[]
        | undefined) ?? []) {
        e.props[p.id] = p.value;
      }
      if (e.attendees.length)
        notices.push({ eventId: e.id, kind: "invitation", to: e.attendees.map((a) => a.address) });
      if (loseNext) {
        loseNext = false;
        return graphErrorResponse(503, "ServiceUnavailable", "lost");
      }
      return jsonResponse(201, render(e));
    }

    const one = /^\/events\/([^/]+)$/.exec(rest);
    const e = one ? events.get(one[1] ?? "") : undefined;
    // An event is reached only under its own calendar.
    if (one && (!e || e.calendarId !== cid)) {
      return graphErrorResponse(
        404,
        "ErrorItemNotFound",
        "The specified object was not found in the store.",
      );
    }
    if (e && method === "GET") {
      if (!utcText) return graphErrorResponse(400, "BadRequest", "the fake wants UTC and text");
      return jsonResponse(200, render(e));
    }
    if (e && method === "PATCH") {
      const ifMatch = headers["if-match"];
      if (ifMatch !== undefined && ifMatch !== etag(e)) {
        return graphErrorResponse(
          412,
          "ErrorIrresolvableConflict",
          "The send or update operation could not be performed because the change key passed in the request doesn't match the current change key for the item.",
        );
      }
      if (!e.isOrganizer) return graphErrorResponse(403, "ErrorAccessDenied", "Only the organizer");
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return graphErrorResponse(400, "BadRequest", "body");
      }
      const was = e.attendees.map((a) => a.address);
      const copy = { ...e, attendees: [...e.attendees] };
      const problem = apply(copy, json);
      if (problem) return graphErrorResponse(400, "ErrorInvalidRequest", problem);
      Object.assign(e, copy, { changeKey: e.changeKey + 1 });
      const now = e.attendees.map((a) => a.address);
      const removed = was.filter((a) => !now.includes(a));
      const onlyAttendees = Object.keys(json).every((k) => k === "attendees");
      const to = onlyAttendees
        ? [...now.filter((a) => !was.includes(a)), ...removed]
        : [...now, ...removed];
      if (to.length) notices.push({ eventId: e.id, kind: "update", to });
      return jsonResponse(200, render(e));
    }
    return graphErrorResponse(400, "BadRequest", `the fake has no ${method} ${path}`);
  }

  const fetch: GraphFetch = async (url: string, init?: GraphRequestInit) => {
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const body = typeof init?.body === "string" ? init.body : "";
    const token = identity.handle(url, { method, body });
    if (token) return token;
    requests.push({ url, method, headers, body });
    const u = parseUrl(url);
    if (u?.origin !== "https://graph.microsoft.com" || !u.pathname.startsWith("/v1.0/")) {
      return jsonResponse(404, { error: "not found" });
    }
    return handle(method, u, headers, body);
  };

  return {
    fetch,
    identity,
    requests,
    events,
    notices,
    calendarId,
    otherCalendarId,
    issueCode: (opts) => identity.issueCode(opts),
    seed,
    touch(id, change = {}) {
      const e = events.get(id);
      if (!e) throw new Error(`no event ${id}`);
      Object.assign(e, change, { changeKey: e.changeKey + 1 });
    },
    loseNextCreateAnswer() {
      loseNext = true;
    },
    hidePropertyLookups() {
      propertyLookups = false;
    },
  };
}
