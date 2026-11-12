# Microsoft Teams: facts to verify against Microsoft

Built against a fake (`./fake.ts`), from Microsoft's documentation on `learn.microsoft.com` as
read on 2026-11-12 (Bot Connector authentication, send and receive messages, proactive messages,
channel and group conversations, conversation events, message formatting, Azure Bot registration).
What is marked **Checked** was read there; everything else is unchecked. Check each item before the
first client goes live, and correct the code or this file.

## Why a bot

- Microsoft Graph's `POST /teams/{id}/channels/{id}/messages` takes application permission only
  for migrations; the delegated `ChannelMessage.Send` posts as a person (work accounts only).
- Office 365 connector webhooks in Teams were switched off in May 2026.
- So Mezonas posts as itself through a **Teams bot**: an Azure Bot resource with an Entra app of
  ours, installed by the client's admin in their team, posting proactive messages to channels the
  client bound with a code. No per-client tokens, no Graph permissions.

## Identity and the outbound token

- **Checked (Azure Bot registration):** "Multi-tenant bot creation will be deprecated after July
  31, 2025"; new bots are single-tenant or user-assigned managed identity. A managed identity
  works only inside Azure App Service or Functions, so we use **single-tenant**: app id, secret
  and the bot's own Entra tenant id.
- **Checked (Bot Connector authentication):** a single-tenant bot's token is
  `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with
  `grant_type=client_credentials`, `client_id`, `client_secret`,
  `scope=https://api.botframework.com/.default`; the answer has `access_token` and `expires_in`
  (3600); Microsoft says to cache it and send it only to the Bot Connector.
- **Unchecked, first to check:** that a single-tenant bot's token is accepted when posting into
  **another organisation's** Teams (the client's tenant), and that a single-tenant Teams app can be
  installed outside our tenant. If not, Mezonas needs a multi-tenant bot that predates the cutoff
  or Microsoft's current answer for ISVs (for example the Microsoft 365 Agents SDK's identity).
- **Unchecked:** whether Entra's answer for a wrong secret is 401 `invalid_client` (we show the
  error code only, never the description).

## Inbound activities (the messaging endpoint)

- **Checked:** `Authorization: Bearer <JWT>`; OpenID metadata at
  `https://login.botframework.com/v1/.well-known/openidconfiguration` (a static URL, "hardcode
  it"), whose `jwks_uri` is `https://login.botframework.com/v1/.well-known/keys`; keys in JWK form
  with an extra `endorsements` list per key; refresh the keys at least once every 24 hours; `iss`
  `https://api.botframework.com`; `aud` the bot's app id; five minutes' clock skew; RS256; a
  `serviceUrl` claim that matches the activity's `serviceUrl`; an endorsement check for the
  channel id, answered with 403 when missing.
- **Unchecked:** that every key carries `endorsements` including `msteams` (we refuse a key that
  doesn't, with 403); that the keys' answer has a usable `Cache-Control` (we keep them 24 hours at
  most, refetching at most once a minute for an unknown `kid`).
- **Unchecked:** that a **single-tenant** bot still receives tokens issued by
  `https://api.botframework.com` from Teams (the Emulator and skill paths use Entra issuers,
  which we refuse).
- **Unchecked:** that `serviceUrl` in the claim and in the activity are byte-for-byte equal
  (trailing slash included); we compare exactly.
- **Unchecked:** that `recipient.id` is `28:<app id>` on every activity (we refuse an activity
  addressed to another bot id, compared case-insensitively).
- **Checked (channel conversations):** in channels a bot receives a message only when it is
  @mentioned; the text carries `<at>Name</at>` markup and an `entities` mention. **Unchecked:**
  that a channel message's `channelData` has `team.id`, `channel.id` and `tenant.id` (we fall back
  to the conversation id before `;messageid=` for the channel), and that names are usually absent.
- **Checked (conversation events):** `conversationUpdate` with `membersAdded` naming the bot
  (`channelData.eventType` `teamMemberAdded`) when it is installed in a team; `membersRemoved`
  naming it when removed; `channelDeleted`, `channelRenamed`, `teamRenamed`, `teamDeleted` with
  `channelData.channel` / `channelData.team`. `installationUpdate` with `action` `add` / `remove`
  also exists (we treat `remove` as removal). Our handling: install → nothing; removal or team
  deleted → unbind the team's channels; channel deleted → unbind it; renames → update the labels.
- **Unchecked:** whether the Bot Connector waits for our HTTP answer or needs a 200 quickly
  (replies are separate calls, so the endpoint can answer 200 with an empty body at once).

## Outbound (posting as the bot)

- **Checked (bot v3 proactive messaging, "Creating a channel conversation"):** a new post in a
  channel is `POST {serviceUrl}/v3/conversations` with `isGroup: true`, `channelData` naming the
  channel (and tenant), and the `activity`. **Unchecked:** the exact body Teams needs today (we
  send `channelData.channel.id`, `channelData.tenant.id`, `tenantId`, no `bot`), and the answer's
  shape `{ "id": "<channel>;messageid=<id>", "activityId": "<id>" }` (we need `id`).
- **Checked:** replies in a thread are `POST {serviceUrl}/v3/conversations/{conversationId}/
  activities/{activityId}`; the bot's fixed lines use this.
- **Checked (proactive):** public service URL `https://smba.trafficmanager.net/teams/`; GCC
  `https://smba.infra.gcc.teams.microsoft.com/teams`; GCC High and DoD on `.us` hosts; "avoid
  hardcoding them", use the activity's. We send the token only to `smba.trafficmanager.net`
  (any path), taking the URL from the binding's activity. **Unchecked:** that regional service URLs
  for commercial tenants are always on that host.
- **Checked (format):** Teams reads a subset of Markdown and HTML by default; `textFormat`
  `extendedmarkdown` turns on more. **Unchecked:** that `textFormat: "plain"` makes Teams show the
  text as written. `text.ts` neutralises tags, mentions, labelled links, images and reference
  links either way.
- **Checked:** a blocked or uninstalled bot gets 403 with `subCode: MessageWritesBlocked`.
  **Unchecked:** what a removed bot or deleted channel answers on create (we read any 403/404 as
  "removed from the team"), and that 4xx answers never come after the post was made (we let a
  refused attempt retry).
- **Checked (channel conversations):** bots can't post in **private** channels. **Unchecked:**
  shared channels (`supportedChannelTypes` in the manifest; we don't declare them).
- The Bot Connector has no idempotency key and the bot can't read the channel, so a post is
  recorded as an attempt before it is sent; a lost answer is never re-sent (`UnconfirmedWriteError`).
- **Unchecked:** `GET {serviceUrl}/v3/teams/{teamId}` (`name`) and
  `GET {serviceUrl}/v3/teams/{teamId}/conversations` (`conversations[]` with `id`, `name`; the
  General channel without a name) for the portal's labels.

## What the owner sets up

1. **Entra app registration** in Mezonas' own Microsoft 365 tenant: single tenant, a client secret
   (note its expiry and rotate it before then). Its *Application (client) ID* is
   `TEAMS_BOT_APP_ID`, the secret `TEAMS_BOT_APP_SECRET`, the *Directory (tenant) ID*
   `TEAMS_BOT_TENANT_ID` (Worker secrets, staging and production each their own).
2. **Azure Bot resource** (type *Single Tenant*, "use existing app registration" with that app id),
   messaging endpoint `https://<api host>/api/hooks/teams`, and the **Microsoft Teams** channel
   turned on under *Channels*. Global data residency unless a client needs otherwise (unchecked).
3. **Teams app package**: a zip of `manifest.json` and two icons (`color.png` 192×192,
   `outline.png` 32×32 white on transparent). Minimal manifest (schema version to confirm against
   the current list; `isNotificationOnly` must stay false, or the code mention never arrives):

   ```json
   {
     "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.19/MicrosoftTeams.schema.json",
     "manifestVersion": "1.19",
     "version": "1.0.0",
     "id": "<TEAMS_BOT_APP_ID>",
     "developer": {
       "name": "Mezonas",
       "websiteUrl": "https://mezonas.com",
       "privacyUrl": "https://mezonas.com/privacy",
       "termsOfUseUrl": "https://mezonas.com/terms"
     },
     "name": { "short": "Mezonas", "full": "Mezonas" },
     "description": {
       "short": "Updates from your Mezonas agents in the channels you connect.",
       "full": "Mezonas posts updates from your agents in the Teams channels you connect with a code from your Mezonas portal. It can't read your messages."
     },
     "icons": { "color": "color.png", "outline": "outline.png" },
     "accentColor": "#23415E",
     "bots": [
       {
         "botId": "<TEAMS_BOT_APP_ID>",
         "scopes": ["team"],
         "isNotificationOnly": false,
         "supportsFiles": false,
         "supportsCalling": false,
         "supportsVideo": false
       }
     ],
     "validDomains": []
   }
   ```

4. **Distribution**, one of (unchecked which suits a few clients best):
   - per client: the client's Teams admin uploads the zip as a custom app (Teams admin center →
     Manage apps → Upload new app), with custom apps allowed by their app setup policy; or
   - the Teams Store: submit through Microsoft Partner Center (Microsoft's validation; publisher
     verification of the Entra app likely required).
5. Each client: their admin adds the Mezonas app to the team, then someone posts
   `@Mezonas MZ-XXXX-XXXX-XXXX` (the code from the portal) in each channel to connect.
