# Outlook connector (send only): notes

Written 2026-11-06 for M29 (`docs/plan.md` §1.52; ARCHITECTURE §6.11). Microsoft's documentation
was not reachable from the build environment, so the connector and its fake (`fake.ts`) follow the
Microsoft identity platform (v2.0 endpoints) and Microsoft Graph v1.0 as we know them. Nothing has
been checked against Microsoft's live services. Every item under "To verify" must be checked against
Microsoft's current docs and a test mailbox (one Microsoft 365 work account and one Outlook.com
account) before a client connects, and the connector and fake fixed where they differ.

## What the connector does

- Sign-in: authorization code flow at `https://login.microsoftonline.com/common/oauth2/v2.0/`
  (`/authorize`, `/token`), so work and school accounts and personal Outlook.com accounts can
  both connect. Scopes: `openid email offline_access https://graph.microsoft.com/Mail.Send`,
  `response_mode=query`, `prompt=select_account`. The code is exchanged with our client secret;
  the redirect is the portal page `<origin>/connections/outlook/callback`, through the generic
  OAuth routes.
- The callback refuses, storing nothing, a grant without `Mail.Send`, a grant with any scope
  beyond `openid`, `email`, `profile`, `offline_access`, `Mail.Send` and `User.Read` (short or
  `https://graph.microsoft.com/` form, any case), a token answer without a refresh token or ID
  token, and an ID token whose issuer isn't `https://login.microsoftonline.com/<its tid>/v2.0`,
  whose audience isn't our client id, or that expired.
- The address: the ID token's `email` claim, else `preferred_username` when it is an address. Kept
  as the connection's account and shown on Connections. `Mail.Send` can't read `/me`.
- Tokens (access, refresh, expiry, granted scopes, address) are encrypted in the vault with the
  client's own key. Refresh before expiry (5 minutes' margin) and once after a 401, with the same
  scopes; Microsoft rotates refresh tokens and we keep the new one each time. `invalid_grant` marks
  the connection as needing a person to connect again.
- Disconnect: drops the stored tokens only. Microsoft has no endpoint that revokes one app's
  delegated refresh token; the person removes Mezonas from their account's app permissions
  (work accounts: `myapps.microsoft.com`; personal: `account.live.com/consent/Manage`).
- `outlook.send`: external, verb `create`, entity `message`, behind approval by default, with the
  same input as `email.send` and `gmail.send` (`to`, `subject`, `text`, `replyTag`), so reach out
  can use it as an agent's email channel (`CHANNEL_TOOLS.outlook`). Its before state is the email
  as it would go. The contact checks (a contact of this client, email consent, not opted out) run in
  code before and again at the send, through the same `EmailServices` as Gmail and Resend.
- The message: Graph JSON, `POST https://graph.microsoft.com/v1.0/me/sendMail` with
  `{message: {subject, body: {contentType: "Text", content}, toRecipients, replyTo?,
  internetMessageHeaders: [{name: "X-Mezonas-Ref", value}]}, saveToSentItems: true}`. Line breaks in
  the subject become spaces. `Reply-To` is the client's forwarding address tagged `+<reach-out id>`
  (none while the client has no forwarding address). Graph sends as the signed-in mailbox.
- Sent once, exactly as `gmail.send` (plan §1.31): Graph takes no idempotency key and `Mail.Send`
  can't read Sent Items, so the send is recorded as started (`raw_record` `EmailAttempt`, one per
  key) before Graph is called. A re-run returns the recorded email; a started send with no record
  is never sent again: the action fails as unconfirmed and the operator gets an item to check the
  mailbox, with the `X-Mezonas-Ref` value to search for. This includes a send Graph refused with an
  error after the attempt was recorded.
- Output: `email.send`'s shape. Graph answers 202 with no body, so `id` is our `X-Mezonas-Ref`
  (`mz-` + 32 hex characters of sha256(`outlook:` + the action's key)) and `messageId` is empty.

## To verify

Microsoft identity platform:

- The endpoints and parameters above, and that `common` accepts both account kinds once the app
  registration's "Supported account types" is "Accounts in any organizational directory and
  personal Microsoft accounts".
- The token answer's fields: `token_type`, `scope`, `expires_in`, `ext_expires_in`,
  `access_token`, `refresh_token` (with `offline_access`), `id_token` (with `openid`). The form of
  `scope` (`Mail.Send` or `https://graph.microsoft.com/Mail.Send`; with or without `openid`,
  `email`, `profile`, `offline_access`). Whether Microsoft adds `User.Read` on its own (new app
  registrations list it under API permissions by default; remove it there if it can be).
- Consent accumulates per app and account: a grant can carry every scope the person ever consented
  to for our app. We never ask for more than these, so this should hold; check that an admin's
  tenant-wide consent doesn't add others.
- ID token claims: `iss` `https://login.microsoftonline.com/<tid>/v2.0`, `aud` (our client id),
  `exp`, `tid`, `email` (present for personal accounts; for work accounts only when the user has a
  mail address and the `email` scope was asked), `preferred_username`. We don't check the
  signature (the token comes straight from the token endpoint over TLS; OpenID Connect Core
  §3.1.3.7). **The `email` claim of a work account is not verified by Microsoft** (the "nOAuth"
  issue): it only labels the connection here, since Graph sends as the signed-in mailbox whatever
  it says, but check whether `xms_edov` or the `verified_primary_email` optional claim should be
  required.
- Personal accounts' `tid` is `9188040d-6c67-4c5b-b112-36a304b66dad`.
- Refresh tokens: 90 days of inactivity for most accounts, 24 hours for single-page apps (we are a
  web app with a secret); a password change or admin revocation ends them (`invalid_grant`,
  AADSTS50173, AADSTS700082).
- A work tenant whose admin requires admin consent: the person can't consent alone and the
  callback gets `error=access_denied` / AADSTS65001; the portal shows the provider's refusal.

Microsoft Graph:

- `POST /v1.0/me/sendMail` with `Mail.Send` only answers 202 Accepted and an empty body.
- `internetMessageHeaders` takes only names starting `X-` (or `x-`); the value is kept on the sent
  message.
- `replyTo` is kept as given (this is how replies come back).
- `body.contentType: "Text"` sends plain text; Graph doesn't wrap it in HTML.
- Whether Graph keeps a subject with line breaks (we send none).
- Limits: Exchange Online allows about 10,000 recipients a day and 30 messages a minute per
  mailbox; Graph throttles with 429 and `Retry-After`. Outlook.com has lower daily limits. We send
  one message per approved attempt and don't track these yet; a 429 fails the action (and, the
  attempt being recorded, it is not sent again by a retry).
- Errors: 401 `InvalidAuthenticationToken`, 403 `ErrorAccessDenied`, 404 or 403
  `MailboxNotEnabledForRESTAPI` (no Exchange Online licence, or an on-premises mailbox), 400
  `ErrorInvalidRecipients`. We refresh once on 401 and fail on the rest with Graph's message.

The Entra app (owner):

- A multi-tenant app registration "Mezonas" in Mezonas' own Entra tenant, supported account types
  "any organizational directory and personal Microsoft accounts", a web platform with the redirect
  URIs `https://staging.mezonas.com/connections/outlook/callback`,
  `https://app.mezonas.com/connections/outlook/callback` and
  `http://localhost:8787/connections/outlook/callback`, a client secret (24 months at most; note
  its expiry), and delegated `Mail.Send`, `openid`, `email`, `offline_access` under API
  permissions. **Publisher verification** (a Microsoft Partner Network id tied to mezonas.com) so
  work tenants show a verified publisher and allow user consent.

### Attachments (P-3, docs/plan.md §1.65)

- Each file goes in `message.attachments` of the `sendMail` body as
  `{"@odata.type": "#microsoft.graph.fileAttachment", name, contentType, contentBytes}` (base64).
- Graph's limit for a request is 4 MB (from memory, UNCHECKED). A larger file needs an upload
  session on a draft message, which needs `Mail.ReadWrite`, a scope we don't ask for. So we send at
  most 3 MB of files in one email (`OUTLOOK_ATTACHMENT_LIMITS`, 4 MB in base64), at most five,
  and refuse more with words the approver can read.

## Not built

- Reading, searching and replying inside a thread (`Mail.Read`, `Mail.ReadWrite`): replies come
  back by forwarding (ARCHITECTURE §6.5).
- Sending as a shared mailbox or another user (`Mail.Send.Shared`, `/users/{id}/sendMail`).
- A test email from the portal (Gmail's `sendToSelf`).
- A client user connecting their own Outlook (Gmail's `PERSONAL_CONNECTORS` rule): only the client
  admin connects Outlook for now.
- HTML: plain text only, like `email.send` (PDFs and images up to 3 MB in all can be attached,
  P-3). Larger files (upload sessions need `Mail.ReadWrite`).
