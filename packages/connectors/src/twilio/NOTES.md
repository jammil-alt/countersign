# Twilio connector: notes to verify

Written 2026-11-04, overnight. Neither `twilio.com` nor its docs could be reached from the build
environment, and there were no Twilio credentials. Everything below comes from what we know of
Twilio's API. The tests run against a fake Twilio (`fake.ts`) shaped the same way, so **a mistake
here is a mistake in the fake too**. Check each **UNCHECKED** item against the live docs and a test
subaccount before a client sends a real message.

Only one fact was cross-checked: the webhook signature algorithm. It reproduces Twilio's documented
example signature (`GvWf1cFY/Q7PnoempGyD5oXAezc=` for token `12345`), which is in `twilio.test.ts`.

## Accounts and auth

| Fact | Status |
|---|---|
| REST base `https://api.twilio.com/2010-04-01`, Basic auth `AccountSid:AuthToken`, form-encoded bodies, `.json` suffix on paths | UNCHECKED (long-standing, very likely) |
| Create a subaccount: `POST /Accounts.json` with `FriendlyName`, using the main account's credentials. The answer has `sid` (AC…) and `auth_token` | UNCHECKED |
| Read a subaccount back (to reconnect): `GET /Accounts/{sid}.json` with the main account's credentials returns its `auth_token` | UNCHECKED. If Twilio no longer returns the token here, reconnecting needs a new auth token or an API key |
| The main account can act on its subaccounts' resources; a subaccount can act only on itself | UNCHECKED (the fake enforces it) |
| Better: API keys (SK…) per subaccount, not the subaccount's auth token | UNCHECKED, follow-up. We store the subaccount's auth token, encrypted, because the webhook signature uses it anyway |
| Subaccount limits (count per account, the trial account's restrictions) | UNCHECKED |

## Numbers

| Fact | Status |
|---|---|
| Search: `GET /Accounts/{sid}/AvailablePhoneNumbers/{CC}/Local.json?AreaCode=&Contains=&SmsEnabled=true&PageSize=` → `available_phone_numbers[]` with `phone_number`, `friendly_name`, `locality`, `region`, `capabilities.{voice,SMS,MMS}` (upper-case SMS/MMS) | UNCHECKED, mainly the capability key case. We read both cases |
| Buy: `POST /Accounts/{sid}/IncomingPhoneNumbers.json` with `PhoneNumber`, `SmsUrl`, `SmsMethod=POST`, `FriendlyName` → `sid` (PN…), `phone_number`, `capabilities.{voice,sms,mms}` (lower case) | UNCHECKED |
| Release: `DELETE /Accounts/{sid}/IncomingPhoneNumbers/{PN}.json` → 204 | UNCHECKED |
| Price of a US local number (about $1.15 a month) and per-message prices | UNCHECKED. Prices aren't used in code. Usage counts messages, not dollars |
| Other countries need a regulatory bundle (address, identity) before purchase | UNCHECKED. The screen searches US numbers only for now |
| Toll-free numbers (a different verification from A2P) | Not built |

## Sending

| Fact | Status |
|---|---|
| `POST /Accounts/{sid}/Messages.json` with `To`, `From`, `Body`, `StatusCallback` → 201 with `sid` (SM…), `status` (`queued`/`accepted`), `num_segments` (a string), `error_code` | UNCHECKED |
| WhatsApp: `To`/`From` prefixed `whatsapp:`; a template is `ContentSid` (HX…) with `ContentVariables` as a JSON string | UNCHECKED |
| Free-form WhatsApp only within 24 hours of the user's last message. Otherwise Twilio refuses (error 63016) unless it is an approved template | UNCHECKED. We check the window in code from our own inbound records |
| **No idempotency key on message create.** A crash after Twilio accepted a message and before we recorded it could send it twice on retry | UNCHECKED whether Twilio now accepts an idempotency header on requests. We send none. Instead the attempt is recorded before the create, and a re-run with an attempt but no recorded SID never creates again: it reconciles (below) or fails for the operator (docs/plan.md §1.22) |
| Reconciling an attempt: `GET /Accounts/{sid}/Messages.json?To=<to>&From=<our number>&PageSize=50` (with the `whatsapp:` prefix on both for WhatsApp) lists that pair's messages, newest first | UNCHECKED: that `To` and `From` filter together, and that the prefixed addresses filter WhatsApp messages |
| A message just created is listed at once, while still `queued` or `accepted`, with `date_created` set (RFC 2822) and `date_sent` empty | UNCHECKED. We match on `date_created` (falling back to `date_sent`), not on a `DateSent>` filter, so a queued message isn't missed |
| `date_created` is Twilio's clock; we allow it to be up to two minutes behind ours when comparing with the attempt time | UNCHECKED: Twilio's clock skew, and whether `date_created` has only second precision |
| `direction` of a message we sent through the API is `outbound-api` | UNCHECKED. We take any `outbound…` direction as ours |
| US A2P 10DLC: texts from an unregistered 10DLC number are filtered (error 30034). We refuse US texts until the brand is `APPROVED` and the campaign `VERIFIED` | UNCHECKED: exact status strings and the error code |
| Sending `From` a number vs `MessagingServiceSid`: once a campaign is on a Messaging Service, the number must be in that service. We send `From` the number | UNCHECKED: whether the number must be added to the service by API (we don't) |
| Error codes we expect: 21211 invalid To, 21610 recipient replied STOP, 21408 region not enabled | UNCHECKED. Errors surface as "Twilio: <message>" |
| Rate limits (per number, per second; queueing) | UNCHECKED. Not handled; sends are one per approved action |

## Reading

| Fact | Status |
|---|---|
| `GET /Accounts/{sid}/Messages.json?To=&From=&DateSent>=YYYY-MM-DD&PageSize=` → `messages[]` with `sid`, `from`, `to`, `body`, `status`, `direction` (`inbound`, `outbound-api`, `outbound-reply`), `date_sent` (RFC 2822), `num_media` | UNCHECKED: the `DateSent>` parameter spelling and paging (`next_page_uri`, not followed) |
| `GET /Accounts/{sid}/Messages/{SM}.json` | UNCHECKED |
| Media URLs need auth to fetch | See "Media (v0.14 capture)" below. From v0.14 the raw record keeps the media SID, never the URL |

## Media (v0.14 capture, docs/plan.md §1.55)

Written 2026-11-06. `twilio.com` was still outside the build environment's network, so these come
from web search results that quote Twilio's media resource pages and its WhatsApp FAQ, not from
the live docs. The fake Twilio (`fake.ts`) follows them.

| Fact | Status |
|---|---|
| An inbound message's media is `MediaUrl{i}` = `https://api.twilio.com/2010-04-01/Accounts/{AC}/Messages/{MM}/Media/{ME}` with `MediaContentType{i}` and `NumMedia` (at most 10) | UNCHECKED (long-standing). We keep index, type and the ME… SID, and rebuild the URL from validated SIDs |
| Twilio keeps inbound media until its Media resource is deleted | From search results only (Twilio's media resource page). We never delete it: **open owner choice** whether to delete it once filed |
| Media URLs need HTTP Basic auth (an API key SID and secret, per the newer page) | From search results only. An older page says they are public unless "Enforce HTTP Auth on Media URLs" is on in the Console. We always send the subaccount's SID and auth token: UNCHECKED that the auth token (not only an API key) is accepted |
| With auth on, the request answers with a redirect to a signed link valid about 4 hours | From search results only (the older page). We follow one redirect by hand, HTTPS only, without our credentials |
| The signed link's host | UNCHECKED. `TWILIO_MEDIA_REDIRECT_ORIGINS` in `media.ts` lists `media.twiliocdn.com`, `mms.twiliocdn.com` and `s3-external-1.amazonaws.com`; any other origin is refused (`redirect_refused`). Check against a real redirect before a client turns attachments on, and adjust the list |
| The signed link answers with `Content-Length` and the file's `Content-Type` | UNCHECKED. A missing length is fine (we count while reading); a missing or `application/octet-stream` type is accepted and the bytes are checked against the declared type |
| No size in the webhook | UNCHECKED. We record a size only once downloaded |
| WhatsApp's own media limits (images about 5 MB, documents up to 100 MB) | UNCHECKED. Our limit per conversation is 20 MB by default, 32 MB at most |
| Twilio charges for stored media | UNCHECKED |
| Twilio has no WhatsApp groups | From search results only: Twilio's WhatsApp FAQ says WhatsApp retired its groups API in April 2020; its "group messaging" sample fans out one-to-one chats through Conversations. Groups wait for Meta's connector (§1.19) |

## Sending files (P-3, docs/plan.md §1.65)

| Fact | Status |
|---|---|
| A message's files are `MediaUrl` form fields, one per file (repeated), fetched by Twilio from our 5-minute signed link (`/api/files/:token`, or R2's presigned link) | UNCHECKED: when Twilio fetches (we assume while it accepts the message, well within 5 minutes), whether it retries a failed fetch, and that it follows no redirect we'd need |
| An SMS with `MediaUrl` goes as MMS: up to 10 files, 5 MB in all, US and Canada numbers | UNCHECKED: the limits, and what Twilio does elsewhere (it may send a link instead). We send at most five files and 5 MB (`TWILIO_MMS_LIMITS`) |
| WhatsApp takes one file per message, with `Body` as its caption, up to 16 MB | UNCHECKED. We send one file (`TWILIO_WHATSAPP_LIMITS`); a reach-out with more leaves WhatsApp out of its plan |
| A WhatsApp template (`ContentSid`) can't carry our file | UNCHECKED (media templates exist; we don't use them). A send outside the 24-hour window with a file is refused |
| Twilio reads the file's type from the link's `Content-Type` | UNCHECKED. Our links answer the stored type |

## Replies with files (P-3)

A text or WhatsApp reply to an open reach-out has its PDFs and images fetched by the capture job
(reason `reply`) with capture's checks, whatever the conversation's setting; a text's (MMS) files
are named `mms-<sid>-<index>.<ext>`. UNCHECKED, as for capture: MMS media URLs and their redirect
host for SMS (we assume the same as WhatsApp's).

## Webhooks

| Fact | Status |
|---|---|
| Inbound messages POST to the number's `SmsUrl` as a form: `MessageSid`, `SmsMessageSid`, `AccountSid`, `MessagingServiceSid`, `From`, `To`, `Body`, `NumMedia`, `MediaUrl{n}`, `MediaContentType{n}`, `ProfileName` and `WaId` (WhatsApp), `OptOutType` (Advanced Opt-Out) | UNCHECKED |
| Status callbacks: `MessageSid`, `MessageStatus` (`queued`, `sent`, `delivered`, `undelivered`, `failed`, `read` for WhatsApp), `ErrorCode`, `AccountSid`, `From`, `To` | UNCHECKED |
| `X-Twilio-Signature` = base64(HMAC-SHA1(auth token, URL + sorted name+value pairs)) | **Checked** against Twilio's documented example |
| Requests for a subaccount's number are signed with **the subaccount's** auth token | UNCHECKED. If they are signed with the main token, `verified()` in `apps/api/src/routes/twilio-hooks.ts` must use the deployment's token |
| The URL signed is the one configured on the number (we check against the stored `config.webhooks`, not the request URL) | UNCHECKED: whether Twilio adds anything (a port, a trailing slash) |
| Twilio retries a failed webhook; `I-Twilio-Idempotency-Token` header | UNCHECKED. We store once by MessageSid (and status by SID + status), so retries and replays do nothing |
| Twilio's signature has no timestamp, so a captured request could be replayed | The replay is acknowledged and does nothing (stored once by SID). Checked in tests |
| An empty `<Response/>` TwiML reply sends nothing back | UNCHECKED |
| Twilio's own STOP handling on long codes replies to the contact and blocks further sends (21610), in addition to ours | UNCHECKED: the reply wording, and whether Advanced Opt-Out changes the keywords |
| Our keywords: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT; START, UNSTOP, YES; HELP, INFO | UNCHECKED against Twilio's current list. Spanish and other languages are not recognised yet |

## A2P 10DLC and WhatsApp senders

| Fact | Status |
|---|---|
| Brand status: `GET https://messaging.twilio.com/v1/a2p/BrandRegistrations/{BN}` → `status` (`PENDING`, `APPROVED`, `FAILED`, `IN_REVIEW`, `SUSPENDED`…) | UNCHECKED |
| Campaign status: `GET https://messaging.twilio.com/v1/Services/{MG}/Compliance/Usa2p` → `compliance[].campaign_status` (`VERIFIED`, `PENDING`, `FAILED`, `IN_PROGRESS`…) | UNCHECKED: the field names especially |
| Brands are registered in the subaccount (ISV model) and readable with its credentials | UNCHECKED |
| Fees (brand registration, campaign vetting, monthly campaign fee) | UNCHECKED, not in code |
| WhatsApp sender registration (self sign-up with the client's Meta business) happens in Twilio's console. The operator then marks the number as the client's WhatsApp sender here | UNCHECKED whether a Senders API could read its status. Not automated |

## What is not built

- Voice: built by the calls stream (`call.place`, `call.answer`, `call.get`, `twilio/voice.ts`,
  `twilio/call-tools.ts`). Its notes are in `../elevenlabs/NOTES.md`, the call list a re-run
  reconciles with included.
- MMS media download outside a reach-out's reply (P-3 fetches a reply's), toll-free verification, numbers outside the US, Messaging Services managed by API.
- Inbound messages counted as usage (only sent messages count, against the agent that sent them).
- Translation of incoming messages (plan §1.18, next step).
