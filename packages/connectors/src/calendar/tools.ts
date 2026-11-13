// The calendar tools' handlers, shared by `gcal` and `outlook_calendar`: each connector gives a
// CalendarProvider (its API calls, read into one event shape) and gets the same four tools with the
// same specs, so the registry accepts both under the `calendar` namespace (registry.ts,
// `sharedToolShape`). What the tools decide is here, once: the window and caps of a list, busy
// times, who is invited, the check that an event is the account's own, the refusal of a change to
// an event that changed since it was proposed, a retried step that finds its write already made,
// and how a change is put back (R5).

import {
  defineReadTool,
  defineWriteTool,
  type ToolContext,
  type ToolDefinition,
  type WriteContext,
} from "../connector";
import {
  CALENDAR_LIMITS,
  CALENDAR_TOOLS,
  type CalendarAttendee,
  CalendarCreateBefore,
  CalendarCreateInput,
  CalendarCreateOutput,
  type CalendarEvent,
  CalendarFreeBusyInput,
  CalendarFreeBusyOutput,
  CalendarListInput,
  CalendarListOutput,
  CalendarUpdateBefore,
  CalendarUpdateInput,
  CalendarUpdateOutput,
  EventChangedError,
  EventNotChangeableError,
  EventNotFoundError,
} from "./spec";
import { isoUtc, wallTime, withSeconds, zonedToUtc } from "./time";

/** An event as a provider reads it: instants for a timed event, dates for an all-day one. */
export interface ProviderEvent {
  id: string;
  title: string;
  allDay: boolean;
  /** Timed: the instants, in ms. */
  startMs: number | null;
  endMs: number | null;
  /** All-day: the first day and the day after the last. */
  startDate: string | null;
  endDate: string | null;
  location: string | null;
  description: string | null;
  organizer: { address: string | null; name: string | null };
  mine: boolean;
  /** Everyone invited but the connected account, addresses in lower case. */
  attendees: CalendarAttendee[];
  busy: boolean;
  cancelled: boolean;
  recurring: boolean;
  link: string | null;
  version: string;
  /** Why its description can't be changed (an Outlook online meeting), or null. */
  descriptionLocked?: string | null;
}

/** An event's times as a write gives them. */
export interface EventTimes {
  allDay: boolean;
  /** Local times with seconds in `timeZone`, or dates. */
  start: string;
  end: string;
  /** The zone of a timed event's local times; for an all-day event, the zone given, if any. */
  timeZone: string | null;
  /** Timed: the instants. */
  startMs: number | null;
  endMs: number | null;
}

export interface EventInvitee {
  address: string;
  optional: boolean;
}

/** A new event, checked, with invitees in lower case and the account itself left out. */
export interface EventDraft extends EventTimes {
  title: string;
  location: string | null;
  description: string | null;
  attendees: EventInvitee[];
  busy: boolean;
}

/** The fields a change sets (`location` and `description` null: cleared). */
export interface EventChange {
  title?: string;
  times?: EventTimes;
  location?: string | null;
  description?: string | null;
  attendees?: EventInvitee[];
  busy?: boolean;
}

/**
 * One calendar provider's calls, each on the connection's own calendar only. Errors are the
 * provider's; a 401 after one refresh is ReconnectRequiredError.
 */
export interface CalendarProvider {
  /** In plain words, for refusals ("Google Calendar"). */
  provider: string;
  /**
   * Whether a change of attendees alone tells only the people added or taken off (Outlook);
   * otherwise every change goes to everyone on the event (Google's `sendUpdates=all`).
   */
  attendeesOnlyNotifiesChanged: boolean;
  /** The connected account's address. */
  account(ctx: ToolContext): Promise<string>;
  /** Events overlapping the window, in order of start: at most `max`, and whether there are more. */
  list(
    ctx: ToolContext,
    window: { fromMs: number; toMs: number },
    max: number,
  ): Promise<{ events: ProviderEvent[]; more: boolean }>;
  /** The event, or null when it isn't on the connection's calendar. */
  get(ctx: ToolContext, id: string): Promise<ProviderEvent | null>;
  /**
   * Makes the event once for this action (ctx.idempotencyKey): a retry finds the event the first
   * try made (`alreadyDone`) and never makes a second. Invitations go to every attendee.
   */
  create(
    ctx: WriteContext,
    draft: EventDraft,
  ): Promise<{ event: ProviderEvent; alreadyDone: boolean }>;
  /**
   * Changes the event (as just read) if it is still at its `version`; throws EventChangedError
   * when the provider says it isn't. The people on the event are told, as `notified` says.
   */
  update(ctx: WriteContext, event: CalendarEvent, change: EventChange): Promise<ProviderEvent>;
}

// ── Reading events the same way for both ───────────────────────────────────────────────────────

function cut(text: string | null, max: number): string | null {
  if (text === null) return null;
  return text.length > max ? text.slice(0, max) : text;
}

/** The event as the tools show it, times in `zone`. */
export function presentEvent(
  e: ProviderEvent,
  zone: string,
  descriptionMax: number = CALENDAR_LIMITS.description,
): CalendarEvent {
  const timed = !e.allDay && e.startMs !== null && e.endMs !== null;
  return {
    id: e.id,
    title: e.title,
    allDay: !timed,
    start: timed ? wallTime(e.startMs as number, zone) : (e.startDate ?? ""),
    end: timed ? wallTime(e.endMs as number, zone) : (e.endDate ?? ""),
    timeZone: timed ? zone : null,
    startUtc: timed ? isoUtc(e.startMs as number) : null,
    endUtc: timed ? isoUtc(e.endMs as number) : null,
    location: e.location,
    description: cut(e.description, descriptionMax),
    organizer: e.organizer,
    mine: e.mine,
    attendees: e.attendees,
    busy: e.busy,
    cancelled: e.cancelled,
    recurring: e.recurring,
    link: e.link,
    version: e.version,
  };
}

/** An input's times, read once. */
export function eventTimes(input: {
  start: string;
  end: string;
  timeZone?: string | undefined;
  allDay?: boolean | undefined;
}): EventTimes {
  if (input.allDay) {
    return {
      allDay: true,
      start: input.start,
      end: input.end,
      timeZone: input.timeZone ?? null,
      startMs: null,
      endMs: null,
    };
  }
  const zone = input.timeZone ?? "UTC";
  return {
    allDay: false,
    start: withSeconds(input.start),
    end: withSeconds(input.end),
    timeZone: zone,
    startMs: zonedToUtc(input.start, zone),
    endMs: zonedToUtc(input.end, zone),
  };
}

/** Invitees in lower case, each once (required wins), without the account itself. */
export function invitees(
  list: readonly { address: string; optional: boolean }[],
  account: string,
): EventInvitee[] {
  const self = account.toLowerCase();
  const out = new Map<string, EventInvitee>();
  for (const a of list) {
    const address = a.address.trim().toLowerCase();
    if (address === self) continue;
    const had = out.get(address);
    out.set(address, { address, optional: (had?.optional ?? true) && a.optional });
  }
  return [...out.values()];
}

/** Empty text is no text. */
const orNull = (s: string | undefined | null): string | null =>
  s === undefined || s === null || s.trim() === "" ? null : s;

/** Text compared as people read it: line endings and the ends' spaces don't count. */
const sameText = (a: string | null, b: string | null) =>
  (a ?? "").replace(/\r\n/g, "\n").trim() === (b ?? "").replace(/\r\n/g, "\n").trim();

function sameInvitees(
  a: readonly { address: string; optional: boolean }[],
  b: readonly { address: string; optional: boolean }[],
): boolean {
  const key = (l: readonly { address: string; optional: boolean }[]) =>
    l
      .map((x) => `${x.address.toLowerCase()}:${x.optional ? 1 : 0}`)
      .sort()
      .join(",");
  return key(a) === key(b);
}

/** Whether the event's times are these. */
function sameTimes(e: CalendarEvent, t: EventTimes): boolean {
  if (t.allDay) return e.allDay && e.start === t.start && e.end === t.end;
  return (
    !e.allDay &&
    e.startUtc !== null &&
    e.endUtc !== null &&
    Date.parse(e.startUtc) === t.startMs &&
    Date.parse(e.endUtc) === t.endMs
  );
}

/** Whether the event already holds everything the change sets (a retried step). */
function holds(e: CalendarEvent, change: EventChange): boolean {
  return (
    (change.title === undefined || e.title === change.title) &&
    (change.times === undefined || sameTimes(e, change.times)) &&
    (change.location === undefined || sameText(e.location, change.location)) &&
    (change.description === undefined || sameText(e.description, change.description)) &&
    (change.attendees === undefined || sameInvitees(e.attendees, change.attendees)) &&
    (change.busy === undefined || e.busy === change.busy)
  );
}

/** Whether what a person reads of the event is the same (not its responses or version). */
function sameContent(a: CalendarEvent, b: CalendarEvent): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.allDay === b.allDay &&
    a.start === b.start &&
    a.end === b.end &&
    a.startUtc === b.startUtc &&
    a.endUtc === b.endUtc &&
    sameText(a.location, b.location) &&
    sameText(a.description, b.description) &&
    sameInvitees(a.attendees, b.attendees) &&
    a.busy === b.busy &&
    a.cancelled === b.cancelled
  );
}

/** The change an update input asks for. */
export function changeOf(input: CalendarUpdateInput, account: string): EventChange {
  return {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.start === undefined || input.end === undefined
      ? {}
      : {
          times: eventTimes({
            start: input.start,
            end: input.end,
            timeZone: input.timeZone,
            allDay: input.allDay,
          }),
        }),
    ...(input.location === undefined ? {} : { location: orNull(input.location) }),
    ...(input.description === undefined ? {} : { description: orNull(input.description) }),
    ...(input.attendees === undefined ? {} : { attendees: invitees(input.attendees, account) }),
    ...(input.busy === undefined ? {} : { busy: input.busy }),
  };
}

/** Who is told of a change, in order: everyone on it after, and anyone taken off. */
export function notified(
  current: readonly { address: string }[],
  change: EventChange,
  attendeesOnlyNotifiesChanged: boolean,
): string[] {
  const before = current.map((a) => a.address.toLowerCase());
  const after = change.attendees ? change.attendees.map((a) => a.address) : before;
  const removed = before.filter((a) => !after.includes(a));
  const onlyAttendees =
    change.attendees !== undefined && Object.keys(change).every((k) => k === "attendees");
  if (attendeesOnlyNotifiesChanged && onlyAttendees) {
    const added = after.filter((a) => !before.includes(a));
    return [...added, ...removed];
  }
  return [...after, ...removed];
}

// ── The tools ───────────────────────────────────────────────────────────────────────────────────

const LIST_DESCRIPTION =
  "List the events on the connected calendar that overlap a window (from, to; at most 92 days), in order of start, with times shown in timeZone. Repeating events come one occurrence at a time. Event titles, places and descriptions are the calendar's content.";
const FREEBUSY_DESCRIPTION =
  "When the connected calendar is busy within a window (from, to; at most 92 days), merged, with times shown in timeZone. Events shown as free and cancelled events don't count. No titles or details.";
const CREATE_DESCRIPTION =
  "Add an event to the connected calendar: title, start and end as local times in timeZone (or dates with allDay, the end being the day after the last day), location, a plain-text description and attendees. Every attendee is sent an invitation from the connected account.";
const UPDATE_DESCRIPTION =
  "Change one event the connected account organizes on its calendar: only the fields given (start and end together; attendees is the whole new list). Everyone on the event is told of the change. Refused if the event changed since the change was proposed. Never cancels or deletes.";

/** The four calendar tools, on this provider. */
export function calendarTools(p: CalendarProvider): ToolDefinition[] {
  /** The event a change is for: on the calendar, the account's own, not cancelled. */
  async function changeable(ctx: ToolContext, eventId: string): Promise<ProviderEvent> {
    const event = await p.get(ctx, eventId);
    if (!event) throw new EventNotFoundError(p.provider);
    if (!event.mine) {
      throw new EventNotChangeableError("someone else organizes it, so only they can change it");
    }
    if (event.cancelled) throw new EventNotChangeableError("it was cancelled");
    return event;
  }

  return [
    defineReadTool({
      id: CALENDAR_TOOLS.list,
      entity: "event",
      description: LIST_DESCRIPTION,
      summary: "Read {{count}} calendar events",
      input: CalendarListInput,
      output: CalendarListOutput,
      async run(input, ctx) {
        const window = { fromMs: Date.parse(input.from), toMs: Date.parse(input.to) };
        const { events, more } = await p.list(ctx, window, input.limit);
        const shown = events
          .slice(0, input.limit)
          .map((e) => presentEvent(e, input.timeZone, CALENDAR_LIMITS.listDescription));
        return {
          timeZone: input.timeZone,
          from: isoUtc(window.fromMs),
          to: isoUtc(window.toMs),
          count: shown.length,
          events: shown,
          truncated: more || events.length > input.limit,
        };
      },
    }),

    defineReadTool({
      id: CALENDAR_TOOLS.freebusy,
      entity: "event",
      description: FREEBUSY_DESCRIPTION,
      summary: "Checked when the calendar is busy",
      input: CalendarFreeBusyInput,
      output: CalendarFreeBusyOutput,
      async run(input, ctx) {
        const fromMs = Date.parse(input.from);
        const toMs = Date.parse(input.to);
        const zone = input.timeZone;
        const { events, more } = await p.list(
          ctx,
          { fromMs, toMs },
          CALENDAR_LIMITS.freebusyEvents,
        );
        const spans: [number, number][] = [];
        for (const e of events) {
          if (!e.busy || e.cancelled) continue;
          // DECISION: an all-day event is busy from midnight to midnight in the zone asked for.
          const s = e.allDay && e.startDate ? zonedToUtc(`${e.startDate}T00:00`, zone) : e.startMs;
          const end = e.allDay && e.endDate ? zonedToUtc(`${e.endDate}T00:00`, zone) : e.endMs;
          if (s === null || end === null) continue;
          const a = Math.max(s, fromMs);
          const b = Math.min(end, toMs);
          if (b > a) spans.push([a, b]);
        }
        spans.sort((x, y) => x[0] - y[0]);
        const merged: [number, number][] = [];
        for (const span of spans) {
          const last = merged[merged.length - 1];
          if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
          else merged.push([span[0], span[1]]);
        }
        return {
          timeZone: zone,
          from: isoUtc(fromMs),
          to: isoUtc(toMs),
          busy: merged.map(([a, b]) => ({
            start: wallTime(a, zone),
            end: wallTime(b, zone),
            startUtc: isoUtc(a),
            endUtc: isoUtc(b),
          })),
          truncated: more,
        };
      },
    }),

    defineWriteTool({
      id: CALENDAR_TOOLS.create,
      entity: "event",
      description: CREATE_DESCRIPTION,
      verb: "create",
      // R5: no tool takes an event back (cancel and delete stay off), and the invitations are
      // already sent.
      undo: { kind: "none" },
      summary: "Added {{title}} to the calendar",
      input: CalendarCreateInput,
      output: CalendarCreateOutput,
      beforeSchema: CalendarCreateBefore,
      async before(input, ctx) {
        const account = await p.account(ctx);
        return {
          calendar: account,
          invites: invitees(input.attendees, account).map((a) => a.address),
        };
      },
      async run(input, ctx) {
        const account = await p.account(ctx);
        const draft: EventDraft = {
          ...eventTimes(input),
          title: input.title,
          location: orNull(input.location),
          description: orNull(input.description),
          attendees: invitees(input.attendees, account),
          busy: input.busy,
        };
        const { event, alreadyDone } = await p.create(ctx, draft);
        return { ...presentEvent(event, input.timeZone ?? "UTC"), alreadyDone };
      },
      testOutput: (input) => ({
        ...presentEvent(
          {
            id: "test-event",
            title: input.title,
            ...(input.allDay
              ? { allDay: true, startMs: null, endMs: null, startDate: input.start }
              : {
                  allDay: false,
                  startMs: eventTimes(input).startMs,
                  endMs: eventTimes(input).endMs,
                  startDate: null,
                }),
            endDate: input.allDay ? input.end : null,
            location: orNull(input.location),
            description: orNull(input.description),
            organizer: { address: null, name: null },
            mine: true,
            attendees: input.attendees.map((a) => ({
              address: a.address.toLowerCase(),
              name: null,
              response: "none" as const,
              optional: a.optional,
            })),
            busy: input.busy,
            cancelled: false,
            recurring: false,
            link: null,
            version: "test",
          },
          input.timeZone ?? "UTC",
        ),
        alreadyDone: false,
      }),
    }),

    defineWriteTool({
      id: CALENDAR_TOOLS.update,
      entity: "event",
      description: UPDATE_DESCRIPTION,
      verb: "update",
      // R5: the fields this change set are written back with this tool, if the event hasn't
      // changed since; the people told of the change are told again.
      undo: { kind: "restore" },
      summary: "Changed {{title}} on the calendar",
      input: CalendarUpdateInput,
      output: CalendarUpdateOutput,
      beforeSchema: CalendarUpdateBefore,
      async before(input, ctx) {
        const account = await p.account(ctx);
        const event = await changeable(ctx, input.eventId);
        if (input.description !== undefined && event.descriptionLocked) {
          throw new EventNotChangeableError(event.descriptionLocked);
        }
        return {
          event: presentEvent(event, input.timeZone ?? "UTC"),
          notifies: notified(
            event.attendees,
            changeOf(input, account),
            p.attendeesOnlyNotifiesChanged,
          ),
        };
      },
      undoInput: ({ input, before }) => calendarRestoreInput(input, before),
      async run(input, ctx, now) {
        if (!now) throw new EventNotFoundError(p.provider);
        const account = await p.account(ctx);
        const change = changeOf(input, account);
        const zone = input.timeZone ?? "UTC";
        // A retried step (the answer was lost): the event already holds what we set.
        if (holds(now.event, change)) return { ...now.event, alreadyDone: true };
        // DECISION: refused if what a person reads of the event (not its responses) differs from
        // what the approver saw when the change was proposed (`proposedBefore`); without a
        // proposal (a direct call), the event read now is the one changed. The write itself
        // carries the version read now, so a change made in between is refused by the provider.
        const proposed = CalendarUpdateBefore.safeParse(ctx.proposedBefore);
        if (proposed.success && !sameContent(proposed.data.event, now.event)) {
          throw new EventChangedError(now.event.title);
        }
        const updated = await p.update(ctx, now.event, change);
        return { ...presentEvent(updated, zone), alreadyDone: false };
      },
    }),
  ];
}

/**
 * R5: the update that puts back what a change set, from the event as it was. Null when it can't
 * (the description was longer than a change can write).
 */
export function calendarRestoreInput(
  input: CalendarUpdateInput,
  before: CalendarUpdateBefore | null,
): Record<string, unknown> | null {
  if (!before) return null;
  const e = before.event;
  const out: Record<string, unknown> = { eventId: input.eventId };
  if (input.title !== undefined) out.title = e.title;
  if (input.start !== undefined) {
    out.start = e.start;
    out.end = e.end;
    out.allDay = e.allDay;
    if (!e.allDay && e.timeZone) out.timeZone = e.timeZone;
  } else if (input.timeZone !== undefined) {
    out.timeZone = input.timeZone;
  }
  if (input.location !== undefined) out.location = e.location ?? "";
  if (input.description !== undefined) {
    if ((e.description ?? "").length >= CALENDAR_LIMITS.description) return null;
    out.description = e.description ?? "";
  }
  if (input.attendees !== undefined) {
    out.attendees = e.attendees.map((a) => ({ address: a.address, optional: a.optional }));
  }
  if (input.busy !== undefined) out.busy = e.busy;
  return out;
}
