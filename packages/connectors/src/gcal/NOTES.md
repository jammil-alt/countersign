# Google Calendar connector (`calendar.events.owned`): notes

Written 2026-11-12 (`docs/plan.md` §1.97). Google's documentation was not reachable from the build
environment, so the connector and its fake (`fake.ts`) follow Google OAuth 2.0 and the Calendar API
v3 as we know them. Nothing has been checked against Google's live services. Every item under "To
verify" must be checked against Google's current docs and a test account before a client connects,
and the connector and fake fixed where they differ.

## What the connector does

- Sign-in: authorization code flow on Google's OAuth client "Mezonas web" (the one Gmail and Drive
  use, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`; redirect `<origin>/connections/gcal/callback`),
  with `access_type=offline`, `prompt=consent`, `include_granted_scopes=false` and the scopes
  `openid email https://www.googleapis.com/auth/calendar.events.owned`. The callback refuses,
  storing nothing, a grant without the calendar scope, with any scope beyond those (and
  `userinfo.email`), without a refresh token or ID token, or with an unverified address.
- **The scope.** `calendar.events.owned` ("events on calendars you own") rather than
  `calendar.events` (also every calendar shared with the person that they can edit) or `calendar`
  (calendars, sharing and settings too). It is the narrowest scope that can list, make and change
  events on the primary calendar. Trade-off: it still reaches the person's other calendars that
  they own, so every call names `calendars/primary/…` and nothing else; an event id from another
  calendar answers 404 there and is refused. `calendar.app.created` would be narrower but only
  covers calendars the app makes, not the primary one.
- The address: from the ID token (`openid email`), checked as Gmail checks it (issuer, audience,
  expiry, verified address). The events scope can't read the profile, and the primary calendar's
  own record (`calendars/primary`, whose id is the address) needs a calendars scope.
- Tokens are encrypted in the vault; refresh before expiry and once after a 401; `invalid_grant`
  asks for a reconnect. **No revoke**: Google's revoke ends every scope the account granted the
  shared client, so it could end a Gmail or Drive connection made by the same Google account.
  Disconnect drops our tokens; the person can remove Mezonas in their Google account.
- `config`: `{address, calendarId: "primary", scopes: ["calendar.events.owned"]}`.
- Tools: the shared calendar tools (`../calendar/`), the same ids and shapes as Outlook Calendar's:
  `calendar.events.list`, `calendar.freebusy` (reads), `calendar.event.create`,
  `calendar.event.update` (writes, approval on by default; no delete or cancel).
- Reading: `GET /calendar/v3/calendars/primary/events` with `timeMin`, `timeMax` (UTC),
  `singleEvents=true`, `orderBy=startTime`, `showDeleted=false`, `timeZone=UTC`, `maxResults`,
  following `nextPageToken`. Timed events are read from `dateTime` (with its offset); all-day
  events from `date`. `transparency: transparent` counts as free. The account's own entry
  (`self: true`) is left out of the attendees.
- `calendar.event.create`: before state `{calendar, invites}` (exactly who is invited). Insert
  with `sendUpdates=all`, `start/end` as `{dateTime: <local time>, timeZone: <IANA>}` or
  `{date}`, `transparency`. Once per action: the event's id is ours, the first 40 hex characters of
  sha256(`gcal:` + key) (hex is within base32hex); a retry gets 409 and reads that id back
  (`alreadyDone`). A 409 whose event can't be read is reported as unconfirmed for the operator.
- `calendar.event.update`: only events the account organizes (`organizer.self`), not cancelled.
  Refused when what a person reads of the event (not attendees' answers) differs from what the
  approver saw; the PATCH carries `If-Match` with the etag read just before, and a 412 is refused
  the same way. `sendUpdates=all`: everyone on the event (and anyone taken off) is told. A new
  attendee list carries each remaining attendee's answer. Switching between timed and all-day sends
  the other form as null. R5: `restore` — the fields it set are written back from the before state.

## To verify

OAuth (the same Google client as Gmail and Drive):

- `https://www.googleapis.com/auth/calendar.events.owned` exists under that name, is a
  **sensitive** scope (not restricted), and is added to the consent screen with a justification;
  the app's verification covers it.
- It allows `events.list`, `events.get`, `events.insert` and `events.patch` on `primary`.
- The token answer's `scope` lists exactly `openid`, `…/userinfo.email` and the calendar scope
  (granular consent may drop the calendar scope: then we refuse).
- With `include_granted_scopes=false`, a Calendar sign-in by an account that already granted Gmail
  or Drive gets a token with Calendar's scopes only, and the other connections keep working.
- The redirect URI `<origin>/connections/gcal/callback` is registered for each environment.
- Refresh tokens expire after 7 days while the consent screen is in "Testing".

Calendar API v3:

- Event ids: base32hex characters (`0-9`, `a-v`), 5 to 1024 long, unique per calendar; an insert
  with a taken id answers 409. Whether an id stays taken after the event is deleted (we then report
  the action as unconfirmed rather than make another).
- `sendUpdates=all` on insert and patch emails every attendee (and anyone removed).
- `If-Match` with the event's `etag` on patch, and 412 when it no longer matches.
- Patch: `start: {date, dateTime: null, timeZone: null}` switches a timed event to all-day (and
  the reverse); `location: ""` and `description: ""` clear them; a new `attendees` list replaces
  the old one, and `responseStatus` sent for a remaining attendee keeps their answer.
- `timeZone=UTC` on events.list makes `dateTime` come back in UTC; all-day events come back as
  `date` either way, and overlap the window by the calendar's own zone.
- `organizer.self` is true on events the account organizes on its primary calendar, and attendees
  carry `self: true` for the account.
- Instances of a repeating event (`singleEvents=true`) have their own ids and can be patched one by
  one.
- Errors: 401 bad token, 403 rate limits (`rateLimitExceeded`, `userRateLimitExceeded`) and
  insufficient scope, 404 unknown id or another calendar's, 409 taken id, 410 deleted, 412, 429,
  5xx. 429 and 5xx are retryable; other 4xx on a write are marked "not written". 403 rate limits
  are not yet retried.

## Not built

- Other calendars (secondary, shared); choosing one.
- Repeating events (making them; changing a whole series), Meet links, reminders, colours.
- Cancel and delete (delete stays off everywhere).
- Google's `freeBusy.query` (needs another scope): `calendar.freebusy` is computed from the events.
