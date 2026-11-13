# Outlook Calendar connector (`Calendars.ReadWrite`): notes

Written 2026-11-12 (`docs/plan.md` §1.97). Built against a fake (`fake.ts`) on the shared
Microsoft sign-in (`../microsoft/identity.ts`, `../microsoft/fake.ts`). Microsoft Graph's v1.0
reference pages for `event`, `dateTimeTimeZone`, `calendarView`, create event, update event and
single-value extended properties were read on learn.microsoft.com on 2026-11-12; nothing has been
checked against Microsoft's live services. Every item under "To verify" must be checked against a
test mailbox (one Microsoft 365 work account and one Outlook.com account) before a client connects,
and the connector and fake fixed where they differ.

## What the connector does

- Sign-in: the shared Microsoft flow (`common` endpoint, `response_mode=query`,
  `prompt=select_account`) on its **own Entra app** (`OUTLOOK_CALENDAR_CLIENT_ID`,
  `OUTLOOK_CALENDAR_CLIENT_SECRET`; redirect `<origin>/connections/outlook_calendar/callback`).
  Scopes: `openid email offline_access https://graph.microsoft.com/Calendars.ReadWrite`. The callback
  refuses, storing nothing, a grant without `Calendars.ReadWrite` or with any scope beyond OpenID's,
  `profile` and `User.Read` (so `Calendars.ReadWrite.Shared`, `Mail.*`, `Files.*` are refused).
- **What the scope reaches.** `Calendars.ReadWrite` is the narrowest delegated scope that can make
  events (`Calendars.ReadBasic` and `Calendars.Read` only read), and it reads and writes every event
  on every calendar the person has. The connector keeps to one: at sign-in it reads
  `GET /me/calendar` (the default calendar) and keeps its id in `config`
  (`{address, calendarId, calendarName, scopes}`); every call names
  `/me/calendars/<that id>/…`, and an event id from any other calendar answers 404 there and is
  refused as "not on the connected calendar". The one exception is the lookup of our own mark
  (`/me/events?$filter=…`, mailbox-wide as Graph documents it), which can only find events this
  connector made.
- The address: the ID token's `email`, else `preferred_username` (shared helper).
- Tokens are encrypted in the vault; refresh before expiry and once after a 401, rotating refresh
  tokens kept; `invalid_grant` asks for a reconnect. Disconnect drops our tokens only (no revoke
  endpoint for one app's delegated grant; the person removes Mezonas in their account's app
  permissions, as for Outlook).
- Tools: the shared calendar tools (`../calendar/`), the same ids and shapes as Google Calendar's:
  `calendar.events.list`, `calendar.freebusy` (reads), `calendar.event.create`,
  `calendar.event.update` (writes, approval on by default; no delete or cancel).
- Reading: `calendarView` with `startDateTime`/`endDateTime` in UTC, `$select`,
  `$orderby=start/dateTime`, `$top`, following `@odata.nextLink` (on graph.microsoft.com only), with
  `Prefer: outlook.timezone="UTC", outlook.body-content-type="text"`. Times are converted to the
  zone a tool asks for by us (Intl), the same code as Google's. All-day events are read as the
  dates in Graph's `dateTime`. `showAs` free and working elsewhere count as free. An HTML body
  (if the text preference wasn't applied) is read from `bodyPreview`.
- Writing times: the local time with the IANA zone given when Graph's `dateTimeTimeZone` page lists
  that zone ("Additional time zones"); any other zone as the same instant in UTC. All-day events
  are midnight dates in that zone (or UTC). `isAllDay` set accordingly.
- `calendar.event.create`: before state `{calendar, invites}` (exactly who is invited: attendees in
  lower case, once each, without the account). Graph sends an invitation to every attendee when an
  event with attendees is made, and this can't be turned off (user-post-events). Once per action:
  the event carries a single-value extended property
  `String {8d5f2e4a-3b1c-4e7a-9f60-2c4d8b1a7e93} Name mezonasAction` = the first 40 hex characters of
  sha256(`outlook_calendar:` + key), looked up first (`/me/events?$filter=singleValueExtendedProperties/Any(…)`),
  and Graph's `transactionId` (the same hash shaped as a GUID) guards the POST itself.
- `calendar.event.update`: only events the account organizes (`isOrganizer`), not cancelled; the
  description of an online meeting is refused (Graph keeps its join details in the body). Before
  state: the event as it is and who is told. Refused when what a person reads of the event (not
  attendees' answers) differs from what the approver saw; the PATCH carries `If-Match` with the
  `@odata.etag` read just before, and a 412 is refused the same way. A change of attendees alone
  tells only those added or taken off (event-update); any other change tells everyone on it.
  R5: `restore` — the fields it set are written back from the before state.

## To verify

Microsoft identity platform and the app registration:

- A separate Entra app ("Mezonas Calendar") with delegated `Calendars.ReadWrite`, supported account
  types "any organizational directory and personal Microsoft accounts", redirect URIs for staging,
  production and `http://localhost:8787`. Whether admin consent is needed in some work tenants for
  `Calendars.ReadWrite` (it is user-consentable by default).
- The token answer's `scope` for this grant (full or short form; whether `User.Read` appears
  without being asked for).

Graph:

- `GET /me/calendar?$select=id,name` works with `Calendars.ReadWrite` for both account kinds.
- `GET /me/calendars/{id}/events/{eventId}` and `PATCH` on it answer 404 (or 400) for an event that
  lives on another calendar of the same mailbox. If Graph resolves the event anyway, also check
  `calendar` (`$expand=calendar($select=id)`) before a change.
- `Prefer` with both preferences in one header, comma-separated, is honoured on calendarView, GET,
  POST and PATCH; event times come back as `{dateTime: "…0000000", timeZone: "UTC"}`.
- **All-day events read with `outlook.timezone="UTC"`**: whether `start.dateTime` keeps the event's
  own midnight (what we assume: we take its date) or is shifted into UTC (which would move the date
  by one in zones west or east of UTC). If shifted, ask for the event's own zone for all-day events.
- `$orderby=start/dateTime` on calendarView, `$top` up to 100, and `@odata.nextLink` paging.
- Writing IANA zone names: create and update take the names on the documented list; which of them a
  mailbox server refuses ("make sure you set only time zones that have been configured for the
  user's mailbox server"; listing them needs `outlookUser: supportedTimeZones`, User.Read).
- An all-day event written with `timeZone: "UTC"` (a zone Graph doesn't list) shows as all-day on
  the right days for a person whose mailbox is in another zone.
- `transactionId`: what a repeated POST with the same value answers (the fake answers 201 with the
  first event; Graph may answer 409 or the first event with 200/201). We look up our mark first, so
  this matters only when the lookup misses.
- `singleValueExtendedProperties` in the POST body is stored, and `/me/events?$filter=…Any(ep: ep/id
  eq '…' and ep/value eq '…')` finds the event right after it is made (no indexing delay).
- `If-Match` with the `@odata.etag` on an event PATCH, and 412 when it no longer matches. If Graph
  ignores `If-Match` on events, the change made between our read and our write is not caught.
- `isOrganizer`, `isOnlineMeeting`, `showAs`, `isCancelled`, `type`, `seriesMasterId`, `webLink`,
  `changeKey` and `@odata.etag` come back with our `$select`.
- Attendees' answers (`status.response`) survive a PATCH that sends the whole attendee list again.
- Which changes Graph emails attendees about (a title-only change of a meeting with attendees; an
  occurrence of a series), so `notifies` on the approval card is exact.
- Errors: 400 for a bad time zone or times, 403 for a change by a non-organizer, 404 for an unknown
  id, 429 with `Retry-After`, 5xx. 429 and 5xx are retryable; other 4xx on a write are marked
  "not written".

## Not built

- Other calendars (shared, group or secondary); choosing a calendar other than the default.
- Recurring series: a change applies to one occurrence; making repeating events.
- Online meetings (Teams links), rooms as resources, reminders, categories, sensitivity.
- Cancel and delete (delete stays off everywhere; cancelling sends emails that can't be taken back).
- Graph's `getSchedule` (work accounts only): `calendar.freebusy` is computed from the events.
