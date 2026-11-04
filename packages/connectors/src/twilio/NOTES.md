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
| **No idempotency key on message create.** A crash after Twilio accepted a message and before we recorded it could send it twice on retry | UNCHECKED whether Twilio now accepts an idempotency header on requests. We send none, and narrow the gap by checking our own record for the action's key before sending |
| US A2P 10DLC: texts from an unregistered 10DLC number are filtered (error 30034). We refuse US texts until the brand is `APPROVED` and the campaign `VERIFIED` | UNCHECKED: exact status strings and the error code |
| Sending `From` a number vs `MessagingServiceSid`: once a campaign is on a Messaging Service, the number must be in that service. We send `From` the number | UNCHECKED: whether the number must be added to the service by API (we don't) |
| Error codes we expect: 21211 invalid To, 21610 recipient replied STOP, 21408 region not enabled | UNCHECKED. Errors surface as "Twilio: <message>" |
| Rate limits (per number, per second; queueing) | UNCHECKED. Not handled; sends are one per approved action |

## Reading

| Fact | Status |
|---|---|
| `GET /Accounts/{sid}/Messages.json?To=&From=&DateSent>=YYYY-MM-DD&PageSize=` → `messages[]` with `sid`, `from`, `to`, `body`, `status`, `direction` (`inbound`, `outbound-api`, `outbound-reply`), `date_sent` (RFC 2822), `num_media` | UNCHECKED: the `DateSent>` parameter spelling and paging (`next_page_uri`, not followed) |
| `GET /Accounts/{sid}/Messages/{SM}.json` | UNCHECKED |
| Media URLs need auth to fetch | UNCHECKED. Media is not downloaded. We keep the URLs in the raw record only |

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
  `twilio/call-tools.ts`). Its notes are in `../elevenlabs/NOTES.md`.
- MMS media download, toll-free verification, numbers outside the US, Messaging Services managed by API.
- Inbound messages counted as usage (only sent messages count, against the agent that sent them).
- Translation of incoming messages (plan §1.18, next step).
