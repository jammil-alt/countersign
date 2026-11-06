# Google Chat: facts to verify against Google

Built against a fake (`./fake.ts`), from Google's documentation as far as this build could reach
it (2026-11-06: `developers.google.com` was not reachable from the build machine; what is below
was confirmed through search results quoting Google's pages, or is marked as unchecked). Check each
item before the first client goes live, and correct the code or this file.

## Inbound requests (the app's HTTP endpoint)

- **Checked (search, Google's "Verify requests from Google Chat"):** with the Chat API's
  *Authentication Audience* set to **Project Number**, each request carries
  `Authorization: Bearer <JWT>` signed by `chat@system.gserviceaccount.com`; `iss` is that
  address and `aud` is the Cloud project number; an unverified request should get 401. The
  official samples fetch the signing certificates from
  `https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com`
  (x509 PEM by key id), which is what `auth.ts` uses (the JWK form of that URL also exists but
  appears only in third-party posts).
- **Unchecked:** that the token's header always names its key (`kid`) and `alg` is RS256. A token
  without a `kid` is refused (`unknown_key`).
- **Unchecked:** the certificate endpoint's `Cache-Control: max-age` (we keep keys that long,
  1 hour without one, 24 hours at most, and refetch at most once a minute for an unknown key).
- **Owner setting:** the Chat API configuration must use *Project Number* as the audience, not
  *HTTP endpoint URL* (that mode sends a Google ID token with a different issuer and audience,
  which this endpoint refuses). Chat apps built as **Google Workspace add-ons** sign with
  `service-<project number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com` and send a different
  event format: not supported; configure a plain Chat API app.
- **Unchecked:** the interaction event shape we read: `type` (`ADDED_TO_SPACE`, `MESSAGE`,
  `REMOVED_FROM_SPACE`), `space.name`, `space.spaceType` (`SPACE`, `GROUP_CHAT`,
  `DIRECT_MESSAGE`) with the older `space.type` (`ROOM`, `DM`) and `singleUserBotDm`,
  `space.displayName`, `message.argumentText` (the text after the app's mention), `user.type`
  (`HUMAN`, `BOT`), `user.displayName`.
- **Unchecked:** that an app added to a space by an @mention gets `ADDED_TO_SPACE` with the
  mentioning `message` (we accept a code there too), and that in a space the app receives
  `MESSAGE` only when it is mentioned (which is why it answers every one with a fixed line).
- **Unchecked:** the synchronous reply: a JSON body `{"text": "…"}` posts a message in the space;
  `{}` posts nothing; the answer must come within 30 seconds.
- **Unchecked:** `REMOVED_FROM_SPACE` arrives when the app is removed from a space and when the
  space is deleted.

## Outbound (posting as the app)

- **Checked (search, `spaces.messages.create` reference):** `requestId`: "Specifying an existing
  request ID returns the message created with that ID instead of creating a new message";
  reusing one with a different authenticated user is an error.
- **Checked (same):** `messageId`, a client-assigned id, must begin with `client-`, at most 63
  characters of lowercase letters, digits and hyphens; a Chat app can't use the same custom id
  for two messages. We send both, derived from the action's key.
- **Unchecked:** the status Chat answers when the `messageId` already exists in the space (we
  read 409 `ALREADY_EXISTS` and then `GET spaces/{space}/messages/client-…`); how long Chat
  remembers a `requestId` (if it forgets, the `messageId` still stops a second post).
- **Unchecked:** that an app with the `chat.bot` scope may `GET` its own message by its
  client-assigned id.
- **Unchecked:** the text limit (4,096 characters; we cap model text at 4,000 and the posted
  text at 4,096) and that `<users/all>`, `<users/{id}>` and `<url|label>` are the only markup in
  plain text that mentions people or hides a link (`text.ts` drops every `<…/…>` without a scheme).
- **Unchecked:** that 403 or 404 on create means the app is no longer in the space.
- Service account sign-in (standard OAuth 2.0 for service accounts): a JWT with `iss` the
  account's email, `scope` `https://www.googleapis.com/auth/chat.bot`, `aud`
  `https://oauth2.googleapis.com/token`, one hour, RS256 with the key's `private_key_id` as
  `kid`, exchanged with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`. The key file's
  own `token_uri` is not used.

## Publishing and each client's Workspace

- **Unchecked:** that a Chat app used outside Mezonas' own Workspace must be published on the
  **Google Workspace Marketplace** (public listing, with Google's app review), and whether a
  private or unlisted listing is enough while there are few clients.
- **Unchecked:** what each client's **Google Workspace admin** must do: allow the Marketplace app
  (Admin console → Apps → Google Workspace Marketplace apps → allow, or install it for the
  domain), and allow Chat apps for their users (Admin console → Apps → Google Workspace →
  Google Chat → Chat apps). Personal Gmail accounts can't add third-party Chat apps (unchecked).
- **Unchecked:** whether spaces with external members (`externalUserAllowed`) can add the app.
- **Unchecked:** whether a Chat app can remove itself from a space; disconnecting a space in the
  portal only unbinds it (the app stays a member until someone removes it).
- The `chat.bot` scope needs no OAuth consent screen or verification (no user data is granted);
  unchecked whether the Marketplace review asks for one anyway.
