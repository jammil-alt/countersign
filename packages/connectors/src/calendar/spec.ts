// The calendar tools as agents and workflows see them, whichever calendar a client uses: Google
// Calendar (`gcal`) or Outlook Calendar (`outlook_calendar`). The ids, inputs and outputs here are
// provider-neutral, so a workflow keeps working when a client moves from one to the other; each
// connector supplies handlers behind them (./tools.ts) and declares the `calendar` namespace.
// Event text (titles, places, descriptions, names) is the calendar's content: it reaches models
// only in tool results, never as instructions (invariant 9).

import type { PermissionEntity } from "@countersign/core";
import { z } from "zod";
import { NotWrittenError } from "../connector";
import { daysBetween, isDate, isTimeZone, isWallTime, zonedToUtc } from "./time";

/** The namespace both calendar connectors share (ConnectorManifest.sharedNamespaces). */
export const CALENDAR_NAMESPACE = "calendar";

export const CALENDAR_TOOLS = {
  list: "calendar.events.list",
  freebusy: "calendar.freebusy",
  create: "calendar.event.create",
  update: "calendar.event.update",
} as const;

/** The record type for the connection matrix (docs/plan.md §1.44). Delete is never offered. */
export const CALENDAR_PERMISSION_ENTITIES: PermissionEntity[] = [
  { id: "event", label: "Events", verbs: ["read", "create", "update"] },
];

export const CALENDAR_LIMITS = {
  /** The longest window a list or busy check reads. */
  windowDays: 92,
  /** Events a list returns at most, and by default. */
  listMax: 100,
  listDefault: 50,
  /** Events a busy check reads at most. */
  freebusyEvents: 250,
  /** The longest event we make or move to. */
  eventDays: 62,
  attendees: 50,
  title: 255,
  location: 255,
  description: 8000,
  /** A description in a list is cut to this; the full text (up to `description`) is in a change. */
  listDescription: 2000,
} as const;

// ── Pieces ──────────────────────────────────────────────────────────────────────────────────────

const TimeZone = z
  .string()
  .min(1)
  .max(64)
  .refine(isTimeZone, "an IANA time zone, such as America/Chicago")
  .describe("An IANA time zone, such as America/Chicago or Europe/London.");

const Instant = z.iso
  .datetime({ offset: true })
  .describe(
    "An instant with its offset, such as 2026-11-20T00:00:00-06:00 or 2026-11-20T06:00:00Z.",
  );

const When = z
  .string()
  .min(10)
  .max(19)
  .describe(
    "A local time such as 2026-11-20T10:00 in `timeZone`, or a date such as 2026-11-20 for an all-day event.",
  );

const Address = z.email().max(254);

const Attendee = z.object({
  address: Address,
  /** Invited as optional rather than required. */
  optional: z.boolean().default(false),
});

const Title = z.string().trim().min(1).max(CALENDAR_LIMITS.title);
const Location = z
  .string()
  .max(CALENDAR_LIMITS.location)
  .describe("Where it happens; an empty string clears it.");
const Description = z
  .string()
  .max(CALENDAR_LIMITS.description)
  .describe("Plain text shown in the event; an empty string clears it.");

/** An event's start and end, as an input gives them, checked together. */
interface Times {
  start?: string | undefined;
  end?: string | undefined;
  timeZone?: string | undefined;
  allDay?: boolean | undefined;
}

/** Problems with an input's times, in plain words (empty when they're fine). */
export function timesProblems(t: Times): string[] {
  if (t.start === undefined && t.end === undefined) return [];
  if (t.start === undefined || t.end === undefined) return ["give start and end together"];
  if (t.allDay) {
    if (!isDate(t.start) || !isDate(t.end)) {
      return ["an all-day event's start and end are dates, such as 2026-11-20"];
    }
    const days = daysBetween(t.start, t.end);
    if (days < 1) return ["an all-day event's end is the day after its last day"];
    if (days > CALENDAR_LIMITS.eventDays) {
      return [`an event lasts at most ${CALENDAR_LIMITS.eventDays} days`];
    }
    return [];
  }
  if (!isWallTime(t.start) || !isWallTime(t.end)) {
    return ["start and end are local times such as 2026-11-20T10:00 (or set allDay)"];
  }
  if (t.timeZone === undefined) return ["give the time zone of start and end"];
  if (!isTimeZone(t.timeZone)) return [];
  const span = zonedToUtc(t.end, t.timeZone) - zonedToUtc(t.start, t.timeZone);
  if (span <= 0) return ["the end is after the start"];
  if (span > CALENDAR_LIMITS.eventDays * 86_400_000) {
    return [`an event lasts at most ${CALENDAR_LIMITS.eventDays} days`];
  }
  return [];
}

const issues = (problems: string[], ctx: z.RefinementCtx) => {
  for (const message of problems) ctx.addIssue({ code: "custom", message });
};

// ── Events as the tools show them ───────────────────────────────────────────────────────────────

export const CalendarAttendee = z.object({
  address: z.string(),
  name: z.string().nullable(),
  response: z.enum(["accepted", "declined", "tentative", "none"]),
  optional: z.boolean(),
});
export type CalendarAttendee = z.infer<typeof CalendarAttendee>;

/** One event on the connection's calendar. Its text is the calendar's content, not instructions. */
export const CalendarEvent = z.object({
  id: z.string(),
  title: z.string(),
  allDay: z.boolean(),
  /** Local time in `timeZone` (`2026-11-20T10:00:00`), or the first day of an all-day event. */
  start: z.string(),
  /** Local time in `timeZone`, or the day after the last day of an all-day event. */
  end: z.string(),
  /** The zone `start` and `end` are in; null for an all-day event. */
  timeZone: z.string().nullable(),
  startUtc: z.string().nullable(),
  endUtc: z.string().nullable(),
  location: z.string().nullable(),
  description: z.string().nullable(),
  organizer: z.object({ address: z.string().nullable(), name: z.string().nullable() }),
  /** The connected account organizes it (only these can be changed). */
  mine: z.boolean(),
  /** Everyone invited but the connected account. */
  attendees: z.array(CalendarAttendee),
  /** Shown as busy (not free). */
  busy: z.boolean(),
  cancelled: z.boolean(),
  /** One occurrence of a repeating event (a change applies to this occurrence only). */
  recurring: z.boolean(),
  link: z.string().nullable(),
  /** The provider's version of the event (etag); it changes with every change. */
  version: z.string(),
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

// ── calendar.events.list ────────────────────────────────────────────────────────────────────────

export const CalendarListInput = z
  .object({
    from: Instant,
    to: Instant,
    /** The zone the events' times are shown in. */
    timeZone: TimeZone.default("UTC"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(CALENDAR_LIMITS.listMax)
      .default(CALENDAR_LIMITS.listDefault),
  })
  .superRefine((v, ctx) => issues(windowProblems(v.from, v.to), ctx));

export function windowProblems(from: string, to: string): string[] {
  const span = Date.parse(to) - Date.parse(from);
  if (!(span > 0)) return ["`to` is after `from`"];
  if (span > CALENDAR_LIMITS.windowDays * 86_400_000) {
    return [`a window of at most ${CALENDAR_LIMITS.windowDays} days`];
  }
  return [];
}

export const CalendarListOutput = z.object({
  timeZone: z.string(),
  from: z.string(),
  to: z.string(),
  count: z.number().int().nonnegative(),
  events: z.array(CalendarEvent),
  /** More events overlap the window than `limit`: ask for a shorter window. */
  truncated: z.boolean(),
});

// ── calendar.freebusy ───────────────────────────────────────────────────────────────────────────

export const CalendarFreeBusyInput = z
  .object({ from: Instant, to: Instant, timeZone: TimeZone.default("UTC") })
  .superRefine((v, ctx) => issues(windowProblems(v.from, v.to), ctx));

const BusyInterval = z.object({
  start: z.string(),
  end: z.string(),
  startUtc: z.string(),
  endUtc: z.string(),
});

export const CalendarFreeBusyOutput = z.object({
  timeZone: z.string(),
  from: z.string(),
  to: z.string(),
  /** When the calendar is busy within the window, merged and in order; the rest is free. */
  busy: z.array(BusyInterval),
  /** The window has more events than we read: the end of it may show free when it isn't. */
  truncated: z.boolean(),
});

// ── calendar.event.create ───────────────────────────────────────────────────────────────────────

export const CalendarCreateInput = z
  .object({
    title: Title,
    start: When,
    end: When,
    /** Required for a timed event; for an all-day event, the zone its days are in (optional). */
    timeZone: TimeZone.optional(),
    allDay: z.boolean().default(false),
    location: Location.optional(),
    description: Description.optional(),
    /** Each is sent an invitation from the connected account when the event is made. */
    attendees: z.array(Attendee).max(CALENDAR_LIMITS.attendees).default([]),
    /** Shown as busy (default) or free. */
    busy: z.boolean().default(true),
  })
  .superRefine((v, ctx) => issues(timesProblems(v), ctx));
export type CalendarCreateInput = z.output<typeof CalendarCreateInput>;

export const CalendarCreateOutput = CalendarEvent.extend({
  /** True when this action had already made it (a retried step): nothing new was made. */
  alreadyDone: z.boolean(),
});

/** What the approver sees and `external_action.before` keeps: whose calendar, and who is invited. */
export const CalendarCreateBefore = z.object({
  /** The connected account: the event goes on its calendar, and it sends the invitations. */
  calendar: z.string(),
  /** Exactly who is sent an invitation when the event is made (empty: nobody). */
  invites: z.array(z.string()),
});
export type CalendarCreateBefore = z.infer<typeof CalendarCreateBefore>;

// ── calendar.event.update ───────────────────────────────────────────────────────────────────────

export const CalendarUpdateInput = z
  .object({
    eventId: z.string().min(1).max(1024),
    title: Title.optional(),
    /** A new start and end, given together (as for a new event). */
    start: When.optional(),
    end: When.optional(),
    /** The zone of a new start and end; also the zone the event is shown in. */
    timeZone: TimeZone.optional(),
    allDay: z.boolean().optional(),
    location: Location.optional(),
    description: Description.optional(),
    /** The whole new list of attendees: anyone left out is taken off the event. */
    attendees: z.array(Attendee).max(CALENDAR_LIMITS.attendees).optional(),
    busy: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    issues(timesProblems(v), ctx);
    if (v.allDay !== undefined && v.start === undefined) {
      ctx.addIssue({ code: "custom", message: "allDay goes with a new start and end" });
    }
    const changes = [v.title, v.start, v.location, v.description, v.attendees, v.busy];
    if (changes.every((c) => c === undefined)) {
      ctx.addIssue({ code: "custom", message: "say what to change" });
    }
  });
export type CalendarUpdateInput = z.output<typeof CalendarUpdateInput>;

export const CalendarUpdateOutput = CalendarCreateOutput;

/** What the approver sees: the event as it is now, and who is told about the change. */
export const CalendarUpdateBefore = z.object({
  event: CalendarEvent,
  /** Exactly who is sent the change (invited, told of new details, or taken off). */
  notifies: z.array(z.string()),
});
export type CalendarUpdateBefore = z.infer<typeof CalendarUpdateBefore>;

// ── Refusals ────────────────────────────────────────────────────────────────────────────────────

/** The event isn't on the connection's calendar (another calendar's, or gone). */
export class EventNotFoundError extends NotWrittenError {
  constructor(readonly provider: string) {
    super(`that event isn't on the connected ${provider}`);
    this.name = "EventNotFoundError";
  }
}

/** The event is someone else's meeting, or cancelled: we change only the account's own events. */
export class EventNotChangeableError extends NotWrittenError {
  constructor(why: string) {
    super(`that event can't be changed: ${why}`);
    this.name = "EventNotChangeableError";
  }
}

/** The event changed since the change was proposed: a person decides again. */
export class EventChangedError extends NotWrittenError {
  constructor(title: string) {
    super(
      `"${title}" changed since this change was proposed; nothing was changed. Propose it again from what is there now.`,
    );
    this.name = "EventChangedError";
  }
}
