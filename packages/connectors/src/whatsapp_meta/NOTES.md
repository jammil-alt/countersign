# WhatsApp through Meta (`whatsapp_meta`): facts to verify

Built against a fake Graph API (`fake.ts`) on 2026-11-06 (W4-A, `docs/plan.md` §1.57). This session
could not reach `developers.facebook.com`, so everything below that isn't marked as checked comes from
memory and third-party guides. The webhook's signature, handshake, payload nesting, message and media
fields, the media two-step and the bearer on both steps were verified against Meta's reference by
Respaldo's receiver (`docs/features/ingestion-webhook.md` in that repo, 2026-08-24); we copied those
patterns, not code. Check each item before a client goes live.

## The owner's Meta setup (once)

1. **Business verification** of Mezonas' Meta business (Business Settings → Security Center). Days to
   weeks; start first.
2. **Tech Provider** registration: Mezonas onboards clients' own WhatsApp Business Accounts, so it
   registers as a Tech Provider (not a Solution Partner: we don't pay for clients' messages or share a
   credit line). Accept the WhatsApp Business Terms for Tech Providers.
3. **The app**: developers.facebook.com → Create app → type *Business*, add *WhatsApp* and
   *Facebook Login for Business*. App ID → `META_APP_ID`; Settings → Basic → App secret →
   `META_APP_SECRET` (the secret, not an access token: it verifies every webhook).
4. **App review / Advanced access** for `whatsapp_business_messaging` and
   `whatsapp_business_management` (and `business_management` if Meta asks for it to list accounts).
   Until then only the app's own testers can finish Embedded Signup.
5. **Embedded Signup configuration**: Facebook Login for Business → Configurations → create one of the
   *WhatsApp Embedded Signup* variant, login type *System-user access token* (a business integration
   token, no expiry), permissions the two above. Its id → `META_CONFIG_ID`. Allowed domains for the
   JS SDK: `staging.mezonas.com`, `app.mezonas.com` (and `localhost` for testing, if allowed).
6. **Webhook**: WhatsApp → Configuration → Callback URL
   `https://app.mezonas.com/api/hooks/whatsapp_meta` (staging:
   `https://staging.mezonas.com/api/hooks/whatsapp_meta`, on a second app or its test mode), Verify
   token = a long random string of our own → `META_WEBHOOK_VERIFY_TOKEN`. Subscribe to the
   **`messages`** field (inbound messages and statuses). Subscribing to nothing passes the handshake
   and delivers nothing. Also worth subscribing: `account_update` (to learn of a client removing us;
   not handled yet, see below).
7. **Graph version**: the code pins `v26.0` in every URL; set the app dashboard's version to the same
   so the JS SDK and the dashboard agree.
8. A **system user** is not needed for clients: Embedded Signup gives each client's own business
   integration token. A Mezonas system user (Admin, the two permissions) is useful only for testing on
   Mezonas' own test number.

## What each client does

The client admin, in the portal's Connections, clicks **Connect WhatsApp (your own number)**. Meta's
window opens: they sign in to Facebook, pick or create the client's Meta business and WhatsApp
Business Account, add and verify the number (it must not be on the WhatsApp app at the same time),
and set the display name. When the window closes, Mezonas registers the number on the Cloud API and
subscribes to its messages. The client's Meta business needs its own business verification for
higher limits and the display name's approval.

## To verify

### Embedded Signup and the token
- The code from `FB.login` (`response_type: "code"`, `override_default_response_type: true`,
  `config_id`) is exchanged at `GET /v26.0/oauth/access_token?client_id&client_secret&code` with **no
  `redirect_uri`**, and is valid about 30 seconds.
- The token is a business integration system-user token that **does not expire**; no refresher is
  built. If it can expire, add one (Graph's 190 marks the connection to reconnect today).
- `debug_token` (with the app token `APP_ID|APP_SECRET`) returns `data.app_id`, `is_valid`, `scopes`
  and `granular_scopes[].target_ids` with the WABA ids for `whatsapp_business_management`. We require
  the WABA the page names to be among them.
- The session-info message: `sessionInfoVersion: "3"` posts `{type: "WA_EMBEDDED_SIGNUP", event:
  "FINISH", data: {phone_number_id, waba_id}}` from `https://www.facebook.com` (or `web.facebook.com`)
  as a JSON string; `CANCEL` when abandoned. Other events (`FINISH_ONLY_WABA`, coexistence's
  `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`) aren't handled: the page then sends no ids and the
  server takes the account's only number, or refuses.
- `POST /<WABA>/subscribed_apps` subscribes our app to the client's account; `DELETE` unsubscribes.
- `POST /<PHONE_NUMBER_ID>/register` with `{messaging_product: "whatsapp", pin}`: needed for a number
  new to Cloud API; the PIN becomes its two-step verification PIN. Unchecked: the error when the
  number already has a PIN another provider set (we refuse the sign-in and undo the subscription),
  and whether registering again on a reconnect is harmless.
- One client per number: Embedded Signup refuses a number another client has connected (and inbound
  messages to a number two clients had would reach neither). A second `whatsapp_meta` connection
  for the same client isn't supported by the portal (one connection per connector).

### Deauthorization (what Meta allows)
- Disconnect calls `DELETE /<WABA>/subscribed_apps` (best effort), then the platform drops the token
  and PIN. We don't deregister the number (`POST /<PHONE_NUMBER_ID>/deregister` would take it off the
  Cloud API for every provider) and there is no Graph call we know of that revokes a business
  integration token outright; the business removes Mezonas under Business Settings → Integrations
  (or Partners) to end the grant at Meta. Verify both, and whether `account_update` webhooks
  (`PARTNER_REMOVED` or similar) tell us when a client does that; handling it is a follow-up.

### Sending
- `POST /<PHONE_NUMBER_ID>/messages`: `{messaging_product: "whatsapp", recipient_type: "individual",
  to: <digits>, type: "text", text: {preview_url: false, body}}`, or `type: "template"` with
  `template: {name, language: {code}, components: [{type: "body", parameters: [...]}]}`. Named
  parameters (`parameter_name`) are newer: verify for the templates clients use.
- No idempotency key on sends (so the attempt is recorded first). `biz_opaque_callback_data` (≤ 512
  characters) is echoed on that message's status callbacks: we send the action's key and adopt the
  message a status names after a lost answer. Verify the echo and its length limit.
- The 24-hour window is per business number and user; error `131047` outside it. Free text inside,
  an approved template outside (our check, and Meta's).
- Answer `messages[0].message_status` (`accepted`) is newer and optional.
- Graph errors that mean the token is gone: 190 (and 102, 10, 200 in some cases): the connection is
  marked to reconnect.

### Sending files (P-3, docs/plan.md §1.65)
- One file per message, by link: `type: "document", document: {link, caption, filename}` for a PDF
  (and GIF or WebP), `type: "image", image: {link, caption}` for JPEG and PNG. The link is our
  5-minute signed link. UNCHECKED: that Meta fetches it at once (well within 5 minutes), whether it
  caches by URL, and that it takes the type from `Content-Type`.
- DECISION: by link, not Meta's media upload (`POST /<PHONE_NUMBER_ID>/media`, multipart): the
  connector's HTTP interface carries text bodies only. Upload is the fallback if links prove
  unreliable.
- Limits (from memory, UNCHECKED): documents up to 100 MB, images up to 5 MB, a caption up to 1024
  characters. We refuse an image over 5 MB or a caption over 1024 characters
  (`checkMetaMedia`), and a reach-out composes WhatsApp text of at most 1000 characters when a file
  goes with it.
- A template (outside the 24-hour window) carries no file here: refused.

### Webhook
- `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 over the raw body with the app secret (checked);
  the GET handshake echoes `hub.challenge` as text/plain (checked).
- Meta retries a delivery that isn't answered 200 for up to about 7 days with backoff (to verify the
  exact policy); we answer 500 on a failure, and each message is stored once per `wamid`.
- Deliveries can batch several messages and statuses; we read at most 100 of each per change.
- `messages[].type` values handled: `text`, `image`, `document`, `audio`, `video` (attachments),
  `button`, `interactive` (their titles as text). Stickers, reactions, locations and contacts keep no
  text and no attachment.
- Audio's `mime_type` may carry parameters (`audio/ogg; codecs=opus`): normalized to `audio/ogg`.

### Media
- `GET /v26.0/<media-id>?phone_number_id=<id>` answers `{url, mime_type, sha256, file_size, id}`
  (checked by Respaldo); `phone_number_id` makes Meta refuse a media id not received on that number.
- The signed link is on `https://lookaside.fbsbx.com` (the only origin we fetch), needs the bearer
  token too (checked by Respaldo), and lives about 5 minutes (checked): an expired link (404/410) is
  resolved again once.
- Unchecked: whether the download ever redirects (we refuse any redirect), and whether Meta's
  `sha256` is hex or base64 (not compared).
- Meta keeps inbound media about 30 days; download after that fails (`gone`).

### Groups (behind `tenant.settings.messaging.whatsappGroups`, off by default)
- **Unverified throughout.** Third-party guides say Meta's Groups API needs an Official Business
  Account, groups the business creates through the API, and about 8 participants. Where a group
  message names its group is not known: we read a top-level `group_id` on the message (letters,
  digits, `.`, `_`, `-`, `@`, at most 200), and anything else is a direct message. Verify the
  payload, then adjust `webhook.ts` and turn groups on for a client.
- In a group, STOP and START are not acted on, no agent starts and nothing replies; the group's
  conversation starts with attachments off.

### The portal's signup page and its Content-Security-Policy
- `https://connect.facebook.net/en_US/sdk.js` is allowed by its full path; the SDK loads its own code
  from the same path (with a query), which the path allows. Verify in a browser that nothing else is
  blocked (`connect-src` has `graph.facebook.com`; `frame-src` has `www.facebook.com`,
  `web.facebook.com` and `staticxx.facebook.com`), and add only what Meta's SDK needs.
- `Cross-Origin-Opener-Policy: same-origin-allow-popups` on that page, so Meta's pop-up can answer it.
