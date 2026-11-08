# LinkedIn connector (company page posts): notes

Written 2026-11-08 for M49 (`docs/plan.md` §1.77; `docs/marketing-plan.md` §4.2, D8). LinkedIn's
documentation was not checked from the build environment and no app exists yet: the connector and
its fake (`fake.ts`) follow LinkedIn's OAuth 2.0 and the versioned REST API (Community Management
API) as we know them. Check every item under "To verify" against LinkedIn's current docs and a
test page before a client connects, and fix the connector and the fake where they differ.

## What the connector does

- Off until the owner sets `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` (and
  `OAUTH_STATE_SECRET`): the portal shows "not available yet" (`isConfigured`), like Outlook.
- Sign-in: `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id&redirect_uri&state&scope=w_organization_social r_organization_admin`;
  the code is exchanged at `POST https://www.linkedin.com/oauth/v2/accessToken` (form:
  `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret`). The
  redirect is the generic OAuth callback (`<origin>/connections/linkedin/callback`).
- The callback refuses, storing nothing: a grant without `w_organization_social`, a grant with any
  scope beyond the two we ask for (e.g. `w_member_social`: we never post as a person), and a
  person who administers no company page.
- Pages: `GET https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`,
  then `GET /rest/organizations/<id>` for each page's `localizedName` (at most 20 pages). Kept in
  `connection.config` (`pages`, `accountName`, `scopes`); the first page is the connection's
  account. Every REST call sends `LinkedIn-Version: 202510` and `X-Restli-Protocol-Version: 2.0.0`.
- Credentials (vault, the client's own key): the access token, its expiry, the refresh token and
  its expiry when LinkedIn gives one, the scopes. A 401 or an expired token refreshes once
  (`grant_type=refresh_token`); a refused refresh asks the client to connect again.
- `linkedin.post`: external, verb `create`, entity `post`, **always signed** (`approval: 'always'`,
  §1.73): it waits for a person whatever the matrix, step or mode. Input `{text, page?}`: plain
  text, 1–3,000 characters; `page` is one of the connection's pages, and may be left out when there
  is one. `POST https://api.linkedin.com/rest/posts` with `author: urn:li:organization:<id>`,
  `commentary` (LinkedIn's "little text", every markup character escaped so nothing becomes a
  mention, hashtag or format), `visibility: PUBLIC`, `distribution.feedDistribution: MAIN_FEED`,
  `lifecycleState: PUBLISHED`. LinkedIn answers 201 with the post's URN in `x-restli-id`; the
  output is the URN, `https://www.linkedin.com/feed/update/<urn>/` and the page.
- Once only: the posts API takes no idempotency key, so the attempt is recorded before the call
  (the platform's write attempts, as Slack's). A 4xx posted nothing and may be tried again (three
  attempts at most); a lost answer or a 5xx leaves the attempt open and the action fails as
  unconfirmed for the operator to check the page.
- Disconnect revokes the token (`POST https://www.linkedin.com/oauth/v2/revoke`), best effort.
- Not a processor in `packages/core/src/compliance`: the page is the client's own, and only the
  client signs in to it, like Slack.

## To verify

- The app: owned by the Mezonas company page, with the Community Management API product approved
  (LinkedIn reviews it; development tier first). Whether development tier can post to our own
  page for testing.
- The scope names (`w_organization_social`, `r_organization_admin`), whether `scope` comes back
  comma- or space-separated (both are read), and whether LinkedIn adds scopes we didn't ask for.
- Refresh tokens: whether Community Management apps get them (programmatic refresh), their life,
  and whether refresh rotates the refresh token.
- `organizationAcls`: the parameter names (`q=roleAssignee`), the element's field (`organization`
  or `organizationTarget`), paging beyond 10.
- `posts`: the body above for a text-only post; the URN header name (`x-restli-id`); the error
  answers for a duplicate post and for too long a text; the current `LinkedIn-Version` to pin.
- "little text" escaping: the exact reserved characters.
- The revoke endpoint and whether it needs the client secret.
