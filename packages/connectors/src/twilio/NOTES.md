# Twilio connector: notes to verify

Written 2026-11-04, overnight, when neither `twilio.com` nor its docs could be reached from the
build environment, and there were no Twilio credentials: what isn't marked checked comes from what we
know of Twilio's API. The tests run against a fake Twilio (`fake.ts`) shaped the same way, so **a
mistake here is a mistake in the fake too**. Check each **UNCHECKED** item against the live docs and
a test subaccount before a client sends a real message. On 2026-11-08 (P-8) Twilio's docs could be
read: the A2P 10DLC sections and the Messaging Service row are checked against them, each with its
source page.

Before P-8 only one fact was cross-checked: the webhook signature algorithm. It reproduces Twilio's documented
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
| US A2P 10DLC: texts from an unregistered 10DLC number are filtered (error 30034). We refuse US texts until the brand is `APPROVED` and the campaign `VERIFIED` | Status strings **checked** (P-8, below). Error 30034 UNCHECKED |
| Sending `From` a number vs `MessagingServiceSid`: once a campaign is on a Messaging Service, the number must be in that service | **Checked** (P-8, 2026-11-08). A 10DLC number must be added to the campaign's Messaging Service before A2P sends ([ISV API guide, step 6](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api)); sending with both `MessagingServiceSid` and `From` turns off the service's sender selection and keeps its other features ([Messaging Services](https://www.twilio.com/docs/messaging/services), "Sender selection"); a message sent through a service is `accepted` at once. We send both once the client's campaign is verified (below) |
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
| Brand status: `GET https://messaging.twilio.com/v1/a2p/BrandRegistrations/{BN}` → `status`, one of `PENDING`, `APPROVED`, `FAILED`, `IN_REVIEW`, `DELETION_PENDING`, `DELETION_FAILED`, `SUSPENDED` | **Checked** 2026-11-08 ([BrandRegistrations resource](https://www.twilio.com/docs/messaging/api/brand-registration-resource)) |
| Campaign status: `GET https://messaging.twilio.com/v1/Services/{MG}/Compliance/Usa2p` → `compliance[].campaign_status` (`PENDING`, `IN_PROGRESS`, `FAILED`, `VERIFIED`; the troubleshooting guide adds a rare `SUSPENDED`) | **Checked** 2026-11-08 ([Usa2p resource](https://www.twilio.com/docs/messaging/api/usapptoperson-resource), [troubleshooting campaigns](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/troubleshooting-a2p-brands/troubleshooting-and-rectifying-a2p-campaigns-1)) |
| Brands are registered in the subaccount (ISV model) and read with its credentials | **Checked**: "If the BrandRegistration belongs to a subaccount, use that subaccount's credentials, not the parent account's" ([BrandRegistrations resource](https://www.twilio.com/docs/messaging/api/brand-registration-resource)); a subaccount per customer with its own Messaging Service is Twilio's preferred ISV architecture #1 ([ISV onboarding overview](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv)) |
| Fees | See "A2P 10DLC by API (P-8)" below |
| WhatsApp sender registration (self sign-up with the client's Meta business) happens in Twilio's console. The operator then marks the number as the client's WhatsApp sender here | UNCHECKED whether a Senders API could read its status. Not automated |

## A2P 10DLC by API (P-8, docs/plan.md §1.70)

Checked 2026-11-08 against Twilio's live docs (`www.twilio.com/docs/…`, read as Markdown by
appending `.md` to each page). Twilio's Help Center (`help.twilio.com`) renders its articles in the
browser only, so its articles could not be read; facts that depend on one are marked.

### The flow

| Fact | Status |
|---|---|
| Six steps, all with the credentials of the account the customer sends from (the client's subaccount): secondary customer profile, trust product, BrandRegistration, Messaging Service, campaign (Usa2p), number added to the service | **Checked** ([ISV API guide](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api), "Step overview" and "Use the correct Account SID") |
| A primary business profile, `Twilio Approved`, business type `ISV Reseller or Partner`, is needed first; its BU SID is assigned to each secondary profile | **Checked** (same guide, "Before you begin", step 1.9). The owner's audit (2026-11-08) found it approved: we need its SID (`TWILIO_PRIMARY_PROFILE_SID`) |
| 1.1 `POST https://trusthub.twilio.com/v1/CustomerProfiles` `PolicySid=RNdfbf3fae0e1107f8aded0e7cead80bf5`, `FriendlyName`, `Email` (required; the ISV's own address, "not your customer's"), optional `StatusCallback` → `sid` BU…, `status` `draft` | **Checked** (guide 1.1; [CustomerProfiles](https://www.twilio.com/docs/trust-hub/trusthub-rest-api/customer-profiles): `FriendlyName`, `Email`, `PolicySid` required) |
| 1.2 `POST /v1/EndUsers` `Type=customer_profile_business_information`, `Attributes` (JSON): `business_name`, `business_type`, `business_industry`, `business_registration_identifier` (`EIN`), `business_registration_number`, `business_identity` (`direct_customer`), `business_regions_of_operation`, `website_url`, optional `social_media_profile_urls` → IT… | **Checked** (guide 1.2) |
| 1.3, 1.5, 1.8, 1.9 `POST /v1/CustomerProfiles/{BU}/EntityAssignments` `ObjectSid=` the end user, the rep, the supporting document, then the primary profile | **Checked** (guide) |
| 1.4 `Type=authorized_representative_1` with `first_name`, `last_name`, `business_title`, `job_position` (`Director`, `GM`, `VP`, `CEO`, `CFO`, `General Counsel`, `Other`), `phone_number` (E.164), `email`; a second rep is optional | **Checked** (guide 1.4; [Gather business information](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/collect-business-info)) |
| 1.6 `POST https://api.twilio.com/2010-04-01/Accounts/{AC}/Addresses.json` `CustomerName`, `Street`, optional `StreetSecondary`, `City`, `Region`, `PostalCode`, `IsoCountry` → AD…; updated with `POST …/Addresses/{AD}.json` | **Checked** (guide 1.6; [Address resource](https://www.twilio.com/docs/usage/api/address)) |
| 1.7 `POST /v1/SupportingDocuments` `Type=customer_profile_address`, `Attributes={"address_sids": "AD…"}` → RD… | **Checked** (guide 1.7) |
| 1.10 `POST /v1/CustomerProfiles/{BU}/Evaluations` `PolicySid=` → `status` `compliant` or `noncompliant`, with `results[]` (`friendly_name`, `passed`, `failure_reason`, `error_code`, `invalid[]` with `object_field` and `failure_reason`) | **Checked** (guide 1.10) |
| 1.11 `POST /v1/CustomerProfiles/{BU}` `Status=pending-review`; the brand step need not wait for approval | **Checked** (guide 1.11; the prose says `pending_review`, the request and the enum say `pending-review`: we send `pending-review`) |
| Bundle statuses: `draft`, `pending-review`, `in-review`, `twilio-rejected`, `twilio-approved`, with `errors[]` on a rejection | **Checked** ([CustomerProfiles](https://www.twilio.com/docs/trust-hub/trusthub-rest-api/customer-profiles), [TrustProducts](https://www.twilio.com/docs/trust-hub/trusthub-rest-api/trust-products)). The shape of a rejected bundle's `errors[]` items is UNCHECKED: we read `code`/`error_code` and `message`/`description` when present |
| 2.1 `POST /v1/TrustProducts` `PolicySid=RNb0d4771c2c98518d916a3d4cd70a8f8b`, `FriendlyName`, `Email` | **Checked** (guide 2.1) |
| 2.2 `Type=us_a2p_messaging_profile_information`, `Attributes={"company_type": …}` (`private`, `public`, `non-profit`, `government`); `stock_exchange` and `stock_ticker` only for `public`; `brand_contact_email` (Authentication+ 2FA) for public for-profit brands | **Checked** (guide 2.2, Gather business information). We don't offer `public` |
| 2.3–2.6 assign that end user and the secondary profile to the trust product, evaluate, `Status=pending-review` | **Checked** (guide) |
| End users are updated with `POST /v1/EndUsers/{IT}` `Attributes=` | **Checked** ([EndUser resource](https://www.twilio.com/docs/trust-hub/trusthub-rest-api/enduser-resource)) |
| 3 `POST https://messaging.twilio.com/v1/a2p/BrandRegistrations` `CustomerProfileBundleSid`, `A2PProfileBundleSid` (both required), `BrandType` (`STANDARD` or `SOLE_PROPRIETOR`), `SkipAutomaticSecVet` (only for Low-Volume Standard and 527 political), `Mock` → BN…, `status` `PENDING`, `brand_type`, `tcr_id`, `identity_status`, `errors[]`, `mock` | **Checked** (guide 3; BrandRegistrations resource). "This API request incurs fees" |
| A Low-Volume Standard brand is `BrandType=STANDARD` with `SkipAutomaticSecVet=true` | **Checked** (Gather business information, `skip_automatic_sec_vet`) |
| Rate limit: at most one brand or campaign request a second | **Checked** (guide 3, warning) |
| Brand vetting usually takes minutes, sometimes more than seven days; `IN_REVIEW` for more than two days → Twilio support | **Checked** (guide 3; [troubleshooting brands](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/troubleshooting-a2p-brands/troubleshooting-and-rectifying-a2p-standardlvs-brands)) |
| A `FAILED` brand's reasons are in `errors[]` (`failure_reason` and `brand_feedback` are deprecated into it) | **Checked** (troubleshooting brands). The item shape is UNCHECKED for brands: we read it like a campaign's (below) |
| Resubmit a failed brand: fix the profile or trust product (end users, then `pending-review`), then `POST /v1/a2p/BrandRegistrations/{BN}` with no body; free up to three times, then 400 with error 21724. Only when `tcr_id` is not null | **Checked** (troubleshooting brands, "Updating an A2P Brand Using the API") |
| A suspended brand can't be updated or get campaigns (21731); its campaigns are suspended (30033 on send) | **Checked** (troubleshooting brands) |
| 4 `POST https://messaging.twilio.com/v1/Services` `FriendlyName` (required, ≤ 64), `InboundRequestUrl`, `StatusCallback`, `UseInboundWebhookOnNumber` (the number's own webhook wins) → MG…; use a new service for A2P, not an existing one | **Checked** (guide 4; [Service resource](https://www.twilio.com/docs/messaging/api/service-resource)). We set `UseInboundWebhookOnNumber=true` so inbound texts keep reaching the number's `SmsUrl`, which the webhook signature is checked over |
| Don't create the campaign until the brand is `APPROVED` | **Checked** (guide 4–5, cautions) |
| 5.1 `GET /v1/Services/{MG}/Compliance/Usa2p/Usecases?BrandRegistrationSid={BN}` → `us_app_to_person_usecases[]` with `code`, `name`, `description`, `post_approval_required` | **Checked** (guide 5.1) |
| Use cases for Standard brands: `2FA`, `ACCOUNT_NOTIFICATION`, `CUSTOMER_CARE`, `DELIVERY_NOTIFICATION`, `FRAUD_ALERT`, `HIGHER_EDUCATION`, `MARKETING`, `MIXED` ("covers multiple use cases such as Customer Care and Delivery Notifications"; lower throughput, higher cost per message), `POLLING_VOTING`, `PUBLIC_SERVICE_ANNOUNCEMENT`, `SECURITY_ALERT`; for Low-Volume Standard: `LOW_VOLUME` ("covers multiple use cases", lower monthly fee, lowest throughput) | **Checked** ([Gather business information](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/collect-business-info), `us_app_to_person_usecase`). **We use `MIXED` or `LOW_VOLUME` by brand type** |
| 5.2 `POST /v1/Services/{MG}/Compliance/Usa2p`: required `BrandRegistrationSid`, `Description` (40–4,096), `MessageFlow` (40–2,048, every opt-in path), `MessageSamples` (repeated, 2–5, each 20–1,024), `UsAppToPersonUsecase`, `HasEmbeddedLinks`, `HasEmbeddedPhone`; optional `OptInMessage`, `OptOutMessage`, `HelpMessage` (20–320), `OptInKeywords`, `OptOutKeywords`, `HelpKeywords` (alphanumeric, ≤ 255), `SubscriberOptIn`, `AgeGated`, `DirectLending`, `PrivacyPolicyUrl`, `TermsAndConditionsUrl` | **Checked** (Usa2p resource, request body schema) |
| A privacy policy and terms link are required to pass vetting (on the business's own domain, public, the policy stating mobile numbers aren't shared, the frequency, and "message and data rates may apply"); the response echoes them only with `X-Twilio-Api-Version: v1.2` | **Checked** (guide 5.3; Gather business information) |
| Each sample names the brand, uses `[brackets]` for variable parts, and includes any links or phone numbers the texts will carry | **Checked** (Gather business information, `message_samples`) |
| With Twilio's default or Advanced Opt-Out, the opt-out and help fields may be left out (Twilio fills them); managing them yourself requires them | **Checked** (Usa2p resource note). We send our keywords and messages anyway (our STOP, START and HELP handling, §1.22). UNCHECKED whether Twilio's own auto-replies then use our messages |
| The campaign's `sid` is always the compliance type `QE2c6890da8086d771620e9b13fadeba0b`; fetch and delete use `/Compliance/Usa2p/{QE}` | **Checked** (Usa2p resource) |
| A failed campaign's `errors[]`: `{error_code, fields[], url, description}`; some codes (e.g. 30883 content violation) can't be fixed by an edit | **Checked** (troubleshooting campaigns) |
| Editing a failed campaign in place by API (`POST …/Usa2p/{QE}` with seven fields) is a **private beta** for API users; otherwise delete and recreate, which charges a new vetting fee | **Checked** ([troubleshooting campaigns](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/troubleshooting-a2p-brands/troubleshooting-and-rectifying-a2p-campaigns-1); [edit details](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/troubleshooting-a2p-brands/troubleshooting-and-rectifying-a2p-campaigns)). We delete and recreate |
| Deleting a verified campaign blocks A2P sends from the service until a new one is verified | **Checked** (Usa2p resource). We delete only a `FAILED` one |
| Up to five campaigns per brand | **Checked** (guide 5.3 note). We make one |
| 6 `POST /v1/Services/{MG}/PhoneNumbers` `PhoneNumberSid=PN…`; at most 400 numbers per service by default | **Checked** ([PhoneNumber resource](https://www.twilio.com/docs/messaging/api/phonenumber-resource)) |
| After a campaign is verified, carriers register each number in the service; this is not instant and can fail | **Checked** ([troubleshooting](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/troubleshooting-a2p-brands)). We don't read the numbers' own registration status: UNCHECKED where Twilio exposes it by API |
| Twilio's answers carry the error `code` and `message` we already read | UNCHECKED for Trust Hub's host (assumed the same as the REST API's) |
| Status callbacks on profiles and trust products, and Event Streams for brands and campaigns | Exist (guide; [Event Streams setup](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/event-streams-setup)). Not used: we poll |
| Sole proprietors (no EIN) register differently; a sole proprietor **with** an EIN must register as Standard or Low-Volume | **Checked** (Gather business information). We don't offer sole proprietor |
| The legal name must match the EIN's CP 575 letter exactly; new EINs take 30–90 days to reach the vetting databases; the website must be reachable, not parked, not behind a login | **Checked** (Gather business information). Shown as hints on the form |
| A rep email and a street address can be used at most ten times across all brands at TCR | **Checked** (same). Not checked in code |

### Fees

| Fact | Status |
|---|---|
| Standard: $44 one-time brand registration, + $15 per campaign one-time vetting, + $1.50–$10 per campaign per month; for businesses with an EIN sending over 6,000 segments a day | **Checked** 2026-11-08 ([A2P 10DLC product page](https://www.twilio.com/en-us/phone-numbers/a2p-10dlc), "What is the price of provisioning a 10DLC number?") |
| Low-Volume Standard: $4 one-time brand registration, + $15 vetting, + $1.50–$10 per campaign per month; under 6,000 segments a day | **Checked** (same page) |
| The monthly fee for `MIXED` is $10 and for `LOW_VOLUME` $1.50 | UNCHECKED against Twilio: its help article ([1260803965530](https://help.twilio.com/articles/1260803965530)) renders only in a browser. From TCR's rates as Telnyx and Telgorithm publish them. Whether Twilio bills the first three months at once (some resellers say TCR does) is also UNCHECKED |
| Vetting is charged once per campaign, at its first decision; an edited resubmit isn't charged again, a deleted and recreated campaign is | **Checked** (troubleshooting campaigns) |
| Brand resubmits are free up to three; an appeal for manual re-vetting costs $10 | **Checked** (troubleshooting brands) |
| Mock brands and campaigns cost nothing and can't send | **Checked** ([mock brand guide](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/mock-brand-api)) |
| Twilio's usage records have a category `a2p-registration-fees` ("All Messaging A2P Registration Fees") | **Checked** ([UsageRecords](https://www.twilio.com/docs/usage/api/usage-record)). Not read: a later check could compare what we recorded with what Twilio billed |
| Per-message carrier fees (e.g. AT&T $0.0035, T-Mobile $0.0045 an SMS) are added on top | **Checked** ([US SMS pricing](https://www.twilio.com/en-us/sms/pricing/us)). Not in `messages`' unit cost yet: open for the owner |

### Mock brand checklist (by hand, against a real subaccount; never from tests)

Twilio's mock brand API makes a brand and campaign that cost nothing and can't send, deleted
after 30 days ([mock brand guide](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/mock-brand-api)).
Before the first client:

1. Make a test subaccount under Mezonas' account and note its SID and token.
2. With its credentials, run steps 1.1–2.6 above with made-up but well-formed details (a real profile
   and trust product are needed even for a mock brand) and see each answer match `twilio/a2p.ts`'s
   schemas, the evaluation `results[]` shape included.
3. `POST …/a2p/BrandRegistrations` with `Mock=true` and `BrandType=STANDARD` (and once with
   `SkipAutomaticSecVet=true`): check `mock: true`, the status strings and `errors[]`'s shape.
4. Create a Messaging Service as `createA2pService` does, then the campaign (it becomes a mock by its
   brand) with our real description, samples and keywords: check the answer and `campaign_status`.
5. Fetch the use cases for the mock brand and confirm `MIXED` and `LOW_VOLUME` are listed as expected.
6. Delete the mock campaign (`DELETE …/Usa2p/QE2c6890da8086d771620e9b13fadeba0b`); the brand expires by
   itself.
7. Write what differed back into this file and the fake (`fake.ts`).

## What is not built

- Voice: built by the calls stream (`call.place`, `call.answer`, `call.get`, `twilio/voice.ts`,
  `twilio/call-tools.ts`). Its notes are in `../elevenlabs/NOTES.md`, the call list a re-run
  reconciles with included.
- MMS media download outside a reach-out's reply (P-3 fetches a reply's), toll-free verification, numbers outside the US. Messaging Services by API: built for A2P only (P-8).
- Inbound messages counted as usage (only sent messages count, against the agent that sent them).
- Translation of incoming messages (plan §1.18, next step).
