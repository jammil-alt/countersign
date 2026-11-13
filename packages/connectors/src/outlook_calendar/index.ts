// "outlook_calendar": Outlook Calendar, on the person's default calendar (docs/plan.md §1.97). A
// person at the client signs in to their Microsoft account (work or personal) from the portal; we
// ask Microsoft for delegated `Calendars.ReadWrite` (with `openid email offline_access` for the
// address and a refresh token), the narrowest scope that can make events. It reaches every event on
// every calendar of the person, so the connector keeps to the calendar that was the default at
// sign-in: every call names it, and an event on any other calendar is refused. The tools are the
// shared calendar tools (../calendar), the same as Google Calendar's, so a workflow runs on either.
// Event text reaches models only in tool results (invariant 9). Unchecked facts about Microsoft:
// ./NOTES.md.

import type { JsonObject } from "@countersign/core";
import { z } from "zod";
import {
  CALENDAR_NAMESPACE,
  CALENDAR_PERMISSION_ENTITIES,
  type CalendarAttendee,
  type CalendarProvider,
  calendarTools,
  type EventChange,
  EventChangedError,
  type EventInvitee,
  type EventTimes,
  isoUtc,
  isTimeZone,
  type ProviderEvent,
  zonedToUtc,
} from "../calendar/index";
import {
  type Connector,
  defineConnector,
  NotWrittenError,
  type ToolContext,
  type WriteContext,
} from "../connector";
import {
  type GraphCall,
  MicrosoftApiError,
  type MicrosoftAppOptions,
  MicrosoftCredentials,
  microsoftSignIn,
} from "../microsoft/identity";
import { ReconnectRequiredError } from "../oauth/tokens";
import { sha256Bytes, toHex, utf8 } from "../runtime";

export const OUTLOOK_CALENDAR_CONNECTOR_ID = "outlook_calendar";

/** The one Graph scope: the person's calendars, read and write. */
export const CALENDARS_READWRITE = "Calendars.ReadWrite";

/**
 * The extended property that marks an event with the external action that made it, so a retried
 * step finds it (Graph's `transactionId` is the second guard).
 */
// DECISION: our own property set's GUID, named `mezonasAction`; the value is the first 40 hex
// characters of sha256("outlook_calendar:" + the action's key).
export const OUTLOOK_CALENDAR_ACTION_PROPERTY =
  "String {8d5f2e4a-3b1c-4e7a-9f60-2c4d8b1a7e93} Name mezonasAction";

// DECISION: Graph answers times in UTC and bodies as text (`Prefer`), and we show them in the zone
// a tool asks for ourselves (../calendar/time.ts), exactly as for Google: one way of reading times.
export const OUTLOOK_CALENDAR_PREFER = 'outlook.timezone="UTC", outlook.body-content-type="text"';

const EVENT_SELECT = [
  "id",
  "subject",
  "start",
  "end",
  "isAllDay",
  "location",
  "body",
  "bodyPreview",
  "organizer",
  "attendees",
  "showAs",
  "isCancelled",
  "isOrganizer",
  "isOnlineMeeting",
  "type",
  "seriesMasterId",
  "webLink",
  "changeKey",
].join(",");

/**
 * The IANA zones Graph documents for `dateTimeTimeZone` beside Windows' own names (resources/
 * datetimetimezone, "Additional time zones").
 */
// DECISION: a write sends the local time in the zone given when Graph lists that zone, so Outlook
// shows the event in it; any other zone goes as the same instant in UTC (an all-day event's days
// in UTC), which Graph always takes. NOTES.md "To verify".
export const GRAPH_IANA_ZONES: ReadonlySet<string> = new Set(
  (
    "Etc/GMT+12 Etc/GMT+11 Pacific/Honolulu America/Anchorage America/Santa_Isabel " +
    "America/Los_Angeles America/Phoenix America/Chihuahua America/Denver America/Guatemala " +
    "America/Chicago America/Mexico_City America/Regina America/Bogota America/New_York " +
    "America/Indiana/Indianapolis America/Caracas America/Asuncion America/Halifax " +
    "America/Cuiaba America/La_Paz America/Santiago America/St_Johns America/Sao_Paulo " +
    "America/Argentina/Buenos_Aires America/Cayenne America/Godthab America/Montevideo " +
    "America/Bahia Etc/GMT+2 Atlantic/Azores Atlantic/Cape_Verde Africa/Casablanca Etc/GMT " +
    "Europe/London Atlantic/Reykjavik Europe/Berlin Europe/Budapest Europe/Paris Europe/Warsaw " +
    "Africa/Lagos Africa/Windhoek Europe/Bucharest Asia/Beirut Africa/Cairo Asia/Damascus " +
    "Africa/Johannesburg Europe/Kyiv Europe/Istanbul Asia/Jerusalem Asia/Amman Asia/Baghdad " +
    "Europe/Kaliningrad Asia/Riyadh Africa/Nairobi Asia/Tehran Asia/Dubai Asia/Baku " +
    "Europe/Moscow Indian/Mauritius Asia/Tbilisi Asia/Yerevan Asia/Kabul Asia/Karachi " +
    "Asia/Kolkata Asia/Colombo Asia/Kathmandu Asia/Dhaka Asia/Yekaterinburg Asia/Bangkok " +
    "Asia/Novosibirsk Asia/Shanghai Asia/Krasnoyarsk Asia/Singapore Australia/Perth Asia/Taipei " +
    "Asia/Ulaanbaatar Asia/Irkutsk Asia/Tokyo Asia/Seoul Australia/Adelaide Australia/Darwin " +
    "Australia/Brisbane Australia/Sydney Pacific/Port_Moresby Australia/Hobart Asia/Yakutsk " +
    "Pacific/Guadalcanal Asia/Vladivostok Pacific/Auckland Etc/GMT-12 Pacific/Fiji " +
    "Asia/Magadan Pacific/Tongatapu Pacific/Apia Pacific/Kiritimati"
  ).split(" "),
);

/** What `connection.config` holds: whose calendar, and which one. */
export const OutlookCalendarConfig = z.looseObject({
  address: z.string(),
  calendarId: z.string().min(1),
  calendarName: z.string(),
  scopes: z.array(z.string()).optional(),
});
export type OutlookCalendarConfig = z.infer<typeof OutlookCalendarConfig>;

const GraphDateTime = z.looseObject({ dateTime: z.string(), timeZone: z.string().nullish() });
const GraphAddress = z.looseObject({
  name: z.string().nullish(),
  address: z.string().nullish(),
});

export const GraphEvent = z.looseObject({
  id: z.string().min(1),
  subject: z.string().nullish(),
  start: GraphDateTime.nullish(),
  end: GraphDateTime.nullish(),
  isAllDay: z.boolean().nullish(),
  location: z.looseObject({ displayName: z.string().nullish() }).nullish(),
  body: z
    .looseObject({ contentType: z.string().nullish(), content: z.string().nullish() })
    .nullish(),
  bodyPreview: z.string().nullish(),
  organizer: z.looseObject({ emailAddress: GraphAddress.nullish() }).nullish(),
  attendees: z
    .array(
      z.looseObject({
        type: z.string().nullish(),
        status: z.looseObject({ response: z.string().nullish() }).nullish(),
        emailAddress: GraphAddress.nullish(),
      }),
    )
    .nullish(),
  showAs: z.string().nullish(),
  isCancelled: z.boolean().nullish(),
  isOrganizer: z.boolean().nullish(),
  isOnlineMeeting: z.boolean().nullish(),
  type: z.string().nullish(),
  seriesMasterId: z.string().nullish(),
  webLink: z.string().nullish(),
  changeKey: z.string().nullish(),
  "@odata.etag": z.string().nullish(),
});
type GraphEvent = z.infer<typeof GraphEvent>;

const EventPage = z.looseObject({
  value: z.array(GraphEvent).default([]),
  "@odata.nextLink": z.string().optional(),
});

const GraphCalendar = z.looseObject({
  id: z.string().min(1),
  name: z.string().nullish(),
});

export type OutlookCalendarOptions = MicrosoftAppOptions;

/** The action's mark on the event it makes: a hash of its key. */
export async function outlookCalendarActionTag(idempotencyKey: string): Promise<string> {
  return toHex(await sha256Bytes(utf8(`outlook_calendar:${idempotencyKey}`))).slice(0, 40);
}

/** Graph's `transactionId` for the action: the tag shaped as a GUID. */
export function outlookCalendarTransactionId(tag: string): string {
  return `${tag.slice(0, 8)}-${tag.slice(8, 12)}-${tag.slice(12, 16)}-${tag.slice(16, 20)}-${tag.slice(20, 32)}`;
}

/** A query string whose `$` keys stay as they are (OData) and whose values are encoded. */
function query(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
}

/** An instant from Graph's `dateTimeTimeZone` (UTC as asked, or a zone we know). */
export function graphInstant(t: z.infer<typeof GraphDateTime>): number {
  const local = t.dateTime.slice(0, 19);
  const zone = t.timeZone ?? "UTC";
  if (zone === "UTC" || zone === "Etc/UTC" || zone === "Etc/GMT") {
    const ms = Date.parse(`${local}Z`);
    if (Number.isFinite(ms)) return ms;
  } else if (isTimeZone(zone) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(local)) {
    return zonedToUtc(local, zone);
  }
  throw new MicrosoftApiError(502, `Outlook answered a time we can't read (${zone})`, null, false);
}

const RESPONSES: Record<string, CalendarAttendee["response"]> = {
  accepted: "accepted",
  organizer: "accepted",
  tentativelyaccepted: "tentative",
  declined: "declined",
};

/** A Graph event as the calendar tools read it; `account` is left out of the attendees. */
export function readGraphEvent(e: GraphEvent, account: string): ProviderEvent {
  const self = account.toLowerCase();
  const allDay = e.isAllDay === true;
  if (!e.start || !e.end) {
    throw new MicrosoftApiError(502, "Outlook answered an event without times", null, false);
  }
  const attendees: CalendarAttendee[] = [];
  for (const a of e.attendees ?? []) {
    const address = a.emailAddress?.address?.trim().toLowerCase();
    if (!address || address === self) continue;
    attendees.push({
      address,
      name: a.emailAddress?.name?.trim() || null,
      response: RESPONSES[(a.status?.response ?? "").toLowerCase()] ?? "none",
      optional: a.type === "optional",
    });
  }
  const html = (e.body?.contentType ?? "text").toLowerCase() === "html";
  const text = html ? e.bodyPreview : e.body?.content;
  const showAs = (e.showAs ?? "busy").toLowerCase();
  return {
    id: e.id,
    title: e.subject ?? "",
    allDay,
    startMs: allDay ? null : graphInstant(e.start),
    endMs: allDay ? null : graphInstant(e.end),
    // DECISION: an all-day event's days are the dates Graph gives, read as they are.
    startDate: allDay ? e.start.dateTime.slice(0, 10) : null,
    endDate: allDay ? e.end.dateTime.slice(0, 10) : null,
    location: e.location?.displayName?.trim() || null,
    description: text?.trim() ? text : null,
    organizer: {
      address: e.organizer?.emailAddress?.address?.trim().toLowerCase() || null,
      name: e.organizer?.emailAddress?.name?.trim() || null,
    },
    mine: e.isOrganizer === true,
    attendees,
    // DECISION: free and working elsewhere count as free; tentative, busy and away as busy.
    busy: showAs !== "free" && showAs !== "workingelsewhere",
    cancelled: e.isCancelled === true,
    recurring: Boolean(e.seriesMasterId) || e.type === "occurrence" || e.type === "exception",
    link: e.webLink ?? null,
    version: e["@odata.etag"] ?? (e.changeKey ? `W/"${e.changeKey}"` : ""),
    // Graph keeps the join details of an online meeting in its body (event-update, "body
    // property and online meetings"); a plain-text body would drop them.
    descriptionLocked:
      e.isOnlineMeeting === true
        ? "it's an online meeting, and a new description would remove how to join it"
        : null,
  };
}

/** Graph's start, end and isAllDay for these times. */
export function graphTimes(t: EventTimes): JsonObject {
  if (t.allDay) {
    const zone = t.timeZone && GRAPH_IANA_ZONES.has(t.timeZone) ? t.timeZone : "UTC";
    return {
      start: { dateTime: `${t.start}T00:00:00`, timeZone: zone },
      end: { dateTime: `${t.end}T00:00:00`, timeZone: zone },
      isAllDay: true,
    };
  }
  if (t.timeZone && GRAPH_IANA_ZONES.has(t.timeZone)) {
    return {
      start: { dateTime: t.start, timeZone: t.timeZone },
      end: { dateTime: t.end, timeZone: t.timeZone },
      isAllDay: false,
    };
  }
  const utc = (ms: number | null) => isoUtc(ms ?? 0).slice(0, 19);
  return {
    start: { dateTime: utc(t.startMs), timeZone: "UTC" },
    end: { dateTime: utc(t.endMs), timeZone: "UTC" },
    isAllDay: false,
  };
}

const graphAttendees = (list: readonly EventInvitee[]) =>
  list.map((a) => ({
    emailAddress: { address: a.address },
    type: a.optional ? "optional" : "required",
  }));

/** The Graph body for a change: only the fields it sets. */
export function graphChange(change: EventChange): JsonObject {
  return {
    ...(change.title === undefined ? {} : { subject: change.title }),
    ...(change.times === undefined ? {} : graphTimes(change.times)),
    ...(change.location === undefined ? {} : { location: { displayName: change.location ?? "" } }),
    ...(change.description === undefined
      ? {}
      : { body: { contentType: "text", content: change.description ?? "" } }),
    ...(change.attendees === undefined ? {} : { attendees: graphAttendees(change.attendees) }),
    ...(change.busy === undefined ? {} : { showAs: change.busy ? "busy" : "free" }),
  };
}

/** A Graph refusal of a write that made nothing (it answered, and said no). */
function notWritten(error: unknown): unknown {
  if (
    error instanceof MicrosoftApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  ) {
    return new NotWrittenError(error.message);
  }
  return error;
}

export function createOutlookCalendarConnector(options: OutlookCalendarOptions = {}): Connector {
  const signIn = microsoftSignIn(options, {
    provider: "Outlook Calendar",
    envNames: "OUTLOOK_CALENDAR_CLIENT_ID, OUTLOOK_CALENDAR_CLIENT_SECRET",
    graphScopes: [CALENDARS_READWRITE],
    missingMessage:
      "Microsoft didn't give us permission to use your calendar. Connect again and allow it.",
  });

  function configOf(ctx: ToolContext): OutlookCalendarConfig {
    const r = OutlookCalendarConfig.safeParse(ctx.connection.config);
    if (!r.success) {
      throw new ReconnectRequiredError("the Outlook Calendar connection has no calendar");
    }
    return r.data;
  }

  /** The connection's calendar in Graph paths: the one that was the default at sign-in. */
  const calendarPath = (ctx: ToolContext) =>
    `/me/calendars/${encodeURIComponent(configOf(ctx).calendarId)}`;

  const prefer = { headers: { prefer: OUTLOOK_CALENDAR_PREFER } };

  async function account(ctx: ToolContext): Promise<string> {
    if (ctx.connection.externalAccountId) return ctx.connection.externalAccountId.toLowerCase();
    const creds = MicrosoftCredentials.safeParse(await ctx.credentials.get());
    if (!creds.success) {
      throw new ReconnectRequiredError("the Outlook Calendar connection has no valid sign-in");
    }
    return creds.data.address.toLowerCase();
  }

  function readEvent(json: unknown, self: string): ProviderEvent {
    const e = GraphEvent.safeParse(json);
    if (!e.success) {
      throw new MicrosoftApiError(502, "Outlook's event has an unexpected shape", null, false);
    }
    return readGraphEvent(e.data, self);
  }

  /** The event this action made before, if any (a retried step). */
  async function madeFor(graph: GraphCall, tag: string, self: string) {
    const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${OUTLOOK_CALENDAR_ACTION_PROPERTY}' and ep/value eq '${tag}')`;
    const { json } = await graph(
      "GET",
      `/me/events?${query({ $filter: filter, $select: EVENT_SELECT, $top: "1" })}`,
      prefer,
    );
    const page = EventPage.safeParse(json);
    if (!page.success) {
      throw new MicrosoftApiError(502, "Outlook's event list has an unexpected shape", null, false);
    }
    const first = page.data.value[0];
    return first ? readGraphEvent(first, self) : null;
  }

  const provider: CalendarProvider = {
    provider: "Outlook Calendar",
    // Graph: "An event update that includes only the attendees property in the request body sends
    // a meeting update to only the attendees that have changed" (event-update).
    attendeesOnlyNotifiesChanged: true,
    account,

    async list(ctx, window, max) {
      const graph = signIn.graph(ctx);
      const self = await account(ctx);
      const collected: GraphEvent[] = [];
      let url: string | undefined = `${calendarPath(ctx)}/calendarView?${query({
        startDateTime: isoUtc(window.fromMs),
        endDateTime: isoUtc(window.toMs),
        $select: EVENT_SELECT,
        $orderby: "start/dateTime",
        $top: String(Math.min(max + 1, 100)),
      })}`;
      // Pages until one more than asked for (to know there are more), ten pages at most.
      for (let page = 0; url && page < 10 && collected.length <= max; page++) {
        const { json } = await graph("GET", url, prefer);
        const parsed = EventPage.safeParse(json);
        if (!parsed.success) {
          throw new MicrosoftApiError(
            502,
            "Outlook's calendar has an unexpected shape",
            null,
            false,
          );
        }
        collected.push(...parsed.data.value);
        url = parsed.data["@odata.nextLink"];
      }
      return {
        events: collected.slice(0, max).map((e) => readGraphEvent(e, self)),
        more: collected.length > max || url !== undefined,
      };
    },

    async get(ctx, id) {
      const graph = signIn.graph(ctx);
      // Under the connection's calendar: an event on any other calendar answers 404.
      const res = await graph(
        "GET",
        `${calendarPath(ctx)}/events/${encodeURIComponent(id)}?${query({ $select: EVENT_SELECT })}`,
        prefer,
        { accept: [400, 404] },
      );
      if (res.status === 400 || res.status === 404) return null;
      return readEvent(res.json, await account(ctx));
    },

    async create(ctx: WriteContext, draft) {
      const graph = signIn.graph(ctx);
      const self = await account(ctx);
      const tag = await outlookCalendarActionTag(ctx.idempotencyKey);
      // Executed once: a retried step finds the event this action made.
      const earlier = await madeFor(graph, tag, self);
      if (earlier) return { event: earlier, alreadyDone: true };
      const body: JsonObject = {
        subject: draft.title,
        ...graphTimes(draft),
        ...(draft.location ? { location: { displayName: draft.location } } : {}),
        ...(draft.description ? { body: { contentType: "text", content: draft.description } } : {}),
        // Graph sends an invitation to every attendee when the event is made (user-post-events).
        attendees: graphAttendees(draft.attendees),
        showAs: draft.busy ? "busy" : "free",
        // Graph's own guard against a repeated POST (resources/event `transactionId`).
        transactionId: outlookCalendarTransactionId(tag),
        singleValueExtendedProperties: [{ id: OUTLOOK_CALENDAR_ACTION_PROPERTY, value: tag }],
      };
      try {
        const { json } = await graph("POST", `${calendarPath(ctx)}/events`, {
          json: body,
          ...prefer,
        });
        return { event: readEvent(json, self), alreadyDone: false };
      } catch (error) {
        throw notWritten(error);
      }
    },

    async update(ctx: WriteContext, event, change) {
      const graph = signIn.graph(ctx);
      let res: Awaited<ReturnType<GraphCall>>;
      try {
        res = await graph(
          "PATCH",
          `${calendarPath(ctx)}/events/${encodeURIComponent(event.id)}`,
          { json: graphChange(change), headers: { ...prefer.headers, "if-match": event.version } },
          { accept: [412] },
        );
      } catch (error) {
        throw notWritten(error);
      }
      if (res.status === 412) throw new EventChangedError(event.title);
      return readEvent(res.json, await account(ctx));
    },
  };

  return defineConnector({
    id: OUTLOOK_CALENDAR_CONNECTOR_ID,
    name: "Outlook Calendar",
    description:
      "See and add events on your Outlook or Microsoft 365 calendar, and change the ones you organize. We never cancel or delete one.",
    icon: "calendar",
    auth: "oauth2",
    entities: [],
    sharedNamespaces: [CALENDAR_NAMESPACE],
    permissionEntities: CALENDAR_PERMISSION_ENTITIES,
    isConfigured: () => signIn.configured,

    async authorize(req) {
      return { redirectUrl: signIn.authorizeUrl(req) };
    },

    async handleCallback(params, req) {
      const code = params.code;
      if (!code) throw new Error("the Microsoft callback has no code");
      const signedIn = await signIn.exchange(code, req.redirectUri);
      const { credentials, accessToken } = signedIn;
      const address = signedIn.account.address;
      // The calendar the person has as default now is the one the connection uses from now on.
      const { json } = await signIn.graphWith(accessToken)(
        "GET",
        `/me/calendar?${query({ $select: "id,name" })}`,
      );
      const calendar = GraphCalendar.safeParse(json);
      if (!calendar.success) {
        throw new MicrosoftApiError(502, "Outlook didn't say which calendar is yours", null, false);
      }
      const config: OutlookCalendarConfig = {
        address,
        calendarId: calendar.data.id,
        calendarName: calendar.data.name?.trim() || "Calendar",
        scopes: [CALENDARS_READWRITE],
      };
      return {
        externalAccountId: address,
        credentials: credentials as unknown as JsonObject,
        config: config as unknown as JsonObject,
      };
    },

    tokens: signIn.refresher,
    // DECISION: no `revoke`, as for Outlook: Microsoft has no endpoint that ends one app's
    // delegated grant; disconnect drops our tokens and the person removes Mezonas from their
    // account's app permissions (NOTES.md).

    tools: calendarTools(provider),
  });
}
