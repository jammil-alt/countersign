# Slack connector (posts to picked channels): notes

Written 2026-11-06 for W4-C (`docs/plan.md` §1.56; ARCHITECTURE §6.11, row 6). Slack's
documentation was not checked from the build environment, so the connector and its fake
(`fake.ts`) follow Slack's OAuth v2 and Web API as we know them. Nothing has been checked against
Slack's live service. Every item under "To verify" must be checked against Slack's current docs
and a test workspace (a free workspace is enough; one on Enterprise Grid for the org-wide case)
before a client connects, and the connector and fake fixed where they differ.

## What the connector does

- Sign-in: Slack OAuth v2. `https://slack.com/oauth/v2/authorize?client_id&scope=chat:write,channels:read&redirect_uri&state`
  (bot scopes only, comma-separated; no `user_scope`). The code is exchanged at
  `POST https://slack.com/api/oauth.v2.access` (form: `client_id`, `client_secret`, `code`,
  `redirect_uri`). The redirect is the portal page `<origin>/connections/slack/callback`, through
  the generic OAuth routes (state signed with `OAUTH_STATE_SECRET`, checked against the session).
- The callback refuses, storing nothing and revoking the tokens Slack gave (best effort): an
  org-wide (Enterprise Grid) install (`is_enterprise_install`, or no `team`), a token type other
  than `bot`, a grant without `chat:write`, a grant with any bot scope beyond `chat:write` and
  `channels:read`, a user token (`authed_user.access_token`), and an expiring token (a
  `refresh_token` or `expires_in`: token rotation must stay off on our app).
- Credentials (vault, the client's own key): the bot token, `bot`, the scopes, the team id, the
  bot user id and the app id. `connection.config`: `teamId`, `teamName` (also `accountName`, shown
  on the Connections card), `botUserId`, `appId`, `scopes`, and later `picked`. The team id is the
  connection's account.
- Channels: `GET https://slack.com/api/conversations.list?types=public_channel&exclude_archived=true&limit=200`
  (and `cursor` from `response_metadata.next_cursor`), at most 10 pages (2,000 channels), for the
  client admin's picker only (not an agent tool). Archived and private channels are left out. Each
  channel shows whether the bot is in it (`is_member`).
- Picks: `config.picked = {teamId, channels: [{id, name}]}`, at most 50, set by the client admin
  through `PUT /api/connections/slack/channels` with channel ids; names come from Slack's list,
  never from the request. Picks made in another workspace don't count (a reconnect to another
  workspace leaves none picked).
- `slack.message.post`: external, verb `create`, entity `message`, behind approval by default.
  Input `{channel, text}` only (strict: no blocks, attachments or other fields). `channel` is a
  picked channel's name (with or without `#`, any case) or id; anything else is refused before
  approval and again at the post (the admin may unpick in between). `text` is plain text, 1 to
  3,000 characters.
- The message (`slack/text.ts`): control characters dropped (line breaks and tabs kept), `@channel`,
  `@here` and `@everyone` given a word joiner (U+2060) after the `@`; then one `section` block with
  a `plain_text` text object (shown as written: no mrkdwn, links or mentions), and the top-level
  `text` (used for notifications) with Slack's three escapes (`&` `&amp;`, `<` `&lt;`, `>` `&gt;`),
  so no `<!channel>`, `<!here>`, `<@U…>`, `<#C…>`, `<!subteam^…>` or `<url|label>` can form.
  `parse: "none"`, `link_names: false`, `unfurl_links: false`, `unfurl_media: false`.
  `POST https://slack.com/api/chat.postMessage` with the bot token as Bearer and a JSON body.
- Posted once: `chat.postMessage` takes no idempotency key and we hold no history scope to look
  for our message, so the attempt is recorded first (`raw_record` `WriteAttempt`, per key and
  attempt number, claimed once). Slack's answer decides what follows:
  - `ok: true`: the result is recorded once (`WriteDone`); a re-run returns it.
  - `ok: false` or HTTP 429: Slack posted nothing (`WriteRefused`); the action fails with plain
    words (`not_in_channel`: add the app to the channel first) and a run of the same action may try
    again under the next attempt number (at most 5).
  - no answer (network error, timeout), a 5xx or an answer we can't read: the attempt stays open,
    and a run of the same action never posts again: it fails as unconfirmed and the operator gets
    an item to check the channel (`UnconfirmedWriteError`, with the workspace, channel and time).
- Token errors (`invalid_auth`, `not_authed`, `token_revoked`, `token_expired`,
  `account_inactive`, `missing_scope`, `no_permission`, …) mark the connection as needing the client
  to install the app again.
- Disconnect: `POST https://slack.com/api/auth.revoke` with the bot token (an already revoked token
  is not an error), then the platform drops the credentials and the vault's read model.

## To verify

Slack OAuth v2:

- The authorize URL and parameters above; that bot scopes are comma-separated in `scope` and that
  a grant's `scope` comes back comma-separated.
- The `oauth.v2.access` answer: `ok`, `access_token` (`xoxb-…`), `token_type: "bot"`, `scope`,
  `bot_user_id`, `app_id`, `team {id, name}`, `enterprise` (null or `{id, name}`),
  `is_enterprise_install`, `authed_user {id}` (and `access_token`, `scope`, `token_type` only when
  `user_scope` was asked). With token rotation on: `refresh_token` and `expires_in` (we refuse
  those). Whether the client credentials may also be sent as HTTP Basic (we send them in the form).
- Whether `redirect_uri` must exactly match one of the app's redirect URLs, and whether Slack
  accepts `http://localhost:8787/...` for local work (Slack has required https for redirect URLs;
  local sign-in may need a tunnel).
- A grant can carry more scopes than asked when the app's configuration lists more bot scopes, or a
  reinstall adds earlier ones: we refuse any but `chat:write` and `channels:read`, so the app's
  "Bot Token Scopes" must list exactly those two.
- Error answers: `invalid_code`, `bad_redirect_uri`, `invalid_client_id`, `bad_client_secret`,
  `oauth_authorization_url_mismatch`; the callback's `error=access_denied` when the person
  cancels (the portal shows the provider's refusal).
- Enterprise Grid: an org-wide install answers `is_enterprise_install: true` and `team: null`; an
  install into one workspace of a Grid org answers a `team` and an `enterprise`. We keep the
  second.

Web API:

- `chat.postMessage` with `chat:write` posts only where the bot is a member (`not_in_channel`
  otherwise); `chat:write.public` would lift that for public channels (we don't ask for it). The
  answer: `{ok, channel, ts, message}`.
- `blocks` with one `section` of `plain_text` (`emoji: true`): shown literally, with no mention,
  link or mrkdwn parsing; whether `plain_text` needs `&`, `<`, `>` escaped (we send it unescaped,
  so it shows as written); its 3,000-character limit. The top-level `text` is used for
  notifications when `blocks` are given.
- `parse: "none"` and `link_names: false` (whether `link_names` still turns `@channel` into a
  mention in `text`; the word joiner is there in case it does, and must not show).
- Whether `chat.postMessage` dedupes anything (`client_msg_id` is documented only for messages
  posted by clients; we don't rely on it).
- Rate limits: `chat.postMessage` about one message a second per channel (special tier), 429 with
  `Retry-After` and `{ok: false, error: "ratelimited"}`; `conversations.list` Tier 2 (about 20 a
  minute). We post one message per approved attempt and list only when the admin opens the picker.
- `conversations.list`: `types=public_channel`, `exclude_archived=true`, `limit` up to 1,000
  (we ask 200), `response_metadata.next_cursor` empty at the end; `is_member`, `is_archived`,
  `is_private` on each channel; needs `channels:read`.
- `auth.revoke`: answers `{ok: true, revoked: true}`; whether revoking the app's only bot token
  also uninstalls the app from the workspace, or the app stays listed under "Installed apps" until
  an admin removes it there (the portal's words assume it may stay).
- When the client removes the app in Slack, the next call answers `token_revoked` or
  `invalid_auth` (we have no Events API endpoint for `app_uninstalled` or `tokens_revoked`).
- Channel ids start with `C` (public) or `G` (older private channels) and are upper-case letters
  and digits; team ids `T`, user ids `U` or `W`, app ids `A`, enterprise ids `E`.
- Slack's error codes we map: `not_in_channel`, `channel_not_found`, `is_archived`,
  `restricted_action`, `ratelimited`, `msg_too_long`, `no_text`, and the token errors above.

The Slack app (owner):

- An app "Mezonas" made at `api.slack.com/apps` in a workspace of Mezonas' own, with:
  - OAuth & Permissions: redirect URLs `https://staging.mezonas.com/connections/slack/callback`,
    `https://app.mezonas.com/connections/slack/callback` (and a local one if Slack allows it);
    Bot Token Scopes `chat:write` and `channels:read` only; no User Token Scopes; **token rotation
    off**.
  - Basic Information: the app's name, icon (the Mezonas mark) and a short description; the client
    id and client secret become `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`.
  - Manage Distribution: **public distribution** turned on (so other workspaces can install it),
    after removing any hard-coded token. Listing in the Slack Marketplace is not needed for that
    and is a separate review.
- Event Subscriptions, Interactivity and slash commands: off.

## Not built

- Private channels (needs `groups:read` to list them, and the bot invited there).
- Reading messages, threads or replies (no history scope; ARCHITECTURE §6.11).
- Replying in a thread (`thread_ts`), editing or deleting a posted message (`chat.update`,
  `chat.delete`; delete is off everywhere).
- Formatting, links, mentions and files: plain text only.
- Slack's Events API (`app_uninstalled`, `tokens_revoked`): a removed app shows up at the next
  call.
- A test post from the portal (Gmail's test email).
