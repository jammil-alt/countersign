# Gmail connector (send only): notes

Written 2026-11-05 for M10 (`docs/plan.md` §4, §1.31; ARCHITECTURE §6.4). Google's documentation
was not reachable from the build environment, so the connector and its fake (`fake.ts`) follow
Google OAuth 2.0 and the Gmail API as we know them. Nothing has been checked against Google's live
services. Every item under "To verify" must be checked against Google's current docs and a test
mailbox before a client connects, and the connector and fake fixed where they differ.

## What the connector does

- Sign-in: authorization code flow with `access_type=offline`, `prompt=consent` (so a reconnect also
  gets a refresh token) and `include_granted_scopes=false`. Scopes: `openid`, `email` and
  `https://www.googleapis.com/auth/gmail.send`. No other Gmail scope is ever asked for.
- `openid email`: `gmail.send` alone can't tell us which address signed in (`users.getProfile`
  needs a read scope). The token answer's ID token carries the address; we keep it as the
  connection's account (`externalAccountId`), show it on Connections, and send From it. Both are
  Google's basic sign-in scopes (non-sensitive), not Gmail scopes, so they add nothing to the review
  beyond listing them on the consent screen. The privacy policy says so (`apps/site`).
- The callback refuses a grant without `gmail.send` (a person can untick it on Google's screen), a
  grant with any scope beyond those three (or `userinfo.email`, the long name of `email`), an
  unverified address, and an ID token for another client id or long expired. Nothing is stored then.
- Tokens (access, refresh, expiry, granted scopes, address) are encrypted in the vault with the
  client's own key, like every connection's credentials. No route returns them.
- Refresh: before expiry (5 minutes' margin) and once more after a 401, at Google's token endpoint.
  `invalid_grant` means the grant is gone (revoked, or the refresh token expired): the connection is
  marked as needing a person to connect again.
- Disconnect: the refresh token is revoked at Google (that ends the whole grant), then the stored
  credentials are dropped. A 400 from revoke means it was already revoked and is not an error. A
  revoke that fails for another reason doesn't stop the disconnect (the platform's rule for every
  connector).
- `gmail.send`: external, verb `create`, behind approval by default. It builds the message itself
  (`mime.ts`): `From` the connected address, `To` the contact, `Reply-To` the client's forwarding
  address tagged `+<reach-out id>` (none if the client has no forwarding address yet), the subject
  as RFC 2047 encoded words when it isn't plain ASCII, `Date`, our own `Message-ID`
  (`<idempotency key>.mezonas@<sender's domain>`), `text/plain; charset=UTF-8`, body in base64.
  Header values can't carry line breaks; addresses and the Message-ID are checked.
- Sent once: Gmail takes no idempotency key and `gmail.send` can't list sent mail, so the send is
  recorded as started (a raw record per key) before Gmail is called. A re-run after a crash returns
  what was recorded; a send that was started and never recorded is never sent again: the action
  fails and the operator gets an item to check the mailbox (`UnconfirmedWriteError`).

## To verify

OAuth (Google Identity):

- The endpoints: `https://accounts.google.com/o/oauth2/v2/auth`, `https://oauth2.googleapis.com/token`,
  `https://oauth2.googleapis.com/revoke` (POST, form body `token=…`).
- `prompt=consent` with `access_type=offline` returns a refresh token on every consent, including a
  reconnect of an account that already granted us access.
- `include_granted_scopes=false` (or leaving it out) keeps scopes granted earlier out of the new
  token. We refuse a grant with extra scopes rather than keep it.
- The token answer's fields: `access_token`, `expires_in` (3599), `refresh_token`, `scope`
  (space-separated, with the long names, e.g. `https://www.googleapis.com/auth/userinfo.email` for
  `email`), `token_type`, `id_token`. A refresh answer has no new `refresh_token` and no `id_token`.
- Granular consent: whether a person can untick `gmail.send` on the consent screen for our app
  type, and that the token's `scope` then leaves it out (we refuse such a grant).
- The ID token's claims: `iss` (`https://accounts.google.com` or `accounts.google.com`), `aud` (our
  client id), `exp`, `email`, `email_verified` (boolean). We don't check its signature, since it
  comes straight from the token endpoint over TLS (OpenID Connect Core §3.1.3.7); confirm Google's
  docs allow that.
- Errors: `invalid_grant` for a revoked or expired refresh token and for a reused code;
  `invalid_client` for a wrong secret. Errors come with HTTP 400 or 401 and a JSON body.
- Revoke: 200 on success, 400 `invalid_token` for a token already revoked; revoking the refresh
  token also revokes its access tokens.
- Testing status: refresh tokens expire after 7 days for an app in "Testing" whose scopes include
  more than the basic profile ones, so test users must reconnect weekly until the app is verified
  and "In production". Only listed test users (up to 100) can sign in while in Testing.
- Refresh tokens can also stop working when a person changes their Google password (for Gmail
  scopes), after 6 months unused, or past the limit of live refresh tokens per account and client
  (we hold one per connection).

Gmail API:

- `POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send` with JSON `{raw}` (the whole
  RFC 2822 message, base64url) and `Authorization: Bearer`. The answer: `{id, threadId,
  labelIds: ["SENT"]}`.
- Whether `raw` must keep or drop base64 padding (we keep it, as Google's Python examples do).
- That `gmail.send` is enough for `messages.send` with `raw`, and nothing else is needed.
- From: Gmail sends as the signed-in account and replaces a `From` it doesn't own (a send-as alias
  is kept). We always set the signed-in address, so this only matters for aliases (not built).
- Whether Gmail keeps our `Message-ID` header or replaces it. Replies are matched by the `+tag` in
  the reply-to address and the sender's address, not by `In-Reply-To`, so matching doesn't depend
  on it.
- Whether Gmail keeps the `Reply-To` header as given (it should; this is how replies come back).
- Size limit for `raw` with `messages.send` (we send plain text of at most 10,000 characters).
- Sending limits: about 500 recipients a day for a consumer Gmail account and about 2,000 for
  Google Workspace, plus per-user API quota units (`messages.send` costs 100 units). We send one
  message per approved attempt and don't track these limits yet; a 429 or a 403 rate-limit error
  fails the action.
- Errors: 401 for a bad or expired token, 403 for missing scope or a disabled account, 400 for a
  bad `raw`, 429 and 5xx for limits and outages. We refresh once on 401 and fail on the rest, with
  Gmail's message.

Google's review:

- `gmail.send` is a **sensitive** scope (not restricted): Google's standard verification, no CASA
  security assessment. Check this on Google's current scope list before submitting.
- What verification asks for: the app's homepage on a verified domain (`https://mezonas.com`), a
  privacy policy on the same domain with the Limited Use statement, an authorized domain on the
  consent screen, a demo video showing the consent screen (with the client id in the address bar)
  and how the scope is used, and a written reason for each sensitive scope.
- The reason we give for `gmail.send`: "A person at a client business connects their Gmail so that
  agents can send the emails that person's team has approved (for example asking a vendor for a
  missing invoice), from their own address. Each message is shown to a person for approval before
  it is sent. We never read the mailbox; replies reach us only when the client forwards them."
- Whether listing `openid` and `email` beside `gmail.send` on the consent screen changes anything in
  the review (they are non-sensitive).

## Not built

- Reading, searching, labels and drafts (restricted scopes, CASA): replies come back by forwarding
  (ARCHITECTURE §6.5). Workspace domain-wide delegation, if a client asks, is a later step.
- Replying inside an existing Gmail thread (`threadId`, `In-Reply-To`, `References`): each reach-out
  email starts its own thread.
- Send-as aliases and a display name in `From`: we send as the bare connected address.
- HTML and attachments: plain text only, like `email.send`.
- Counting sends against Gmail's daily limits, and bounces (they arrive in the mailbox, which we
  can't read).
- More than one Gmail connection per client: v1 keeps one connection per connector per client, so a
  client connects one mailbox (an agent's own, a shared one or a person's).
