# What's open

The one forward plan: everything still to do, by area, with the **To do** list on top in priority
order. Updated 2026-11-26, after a scrub of every plan document against the code (`docs/README.md`
lists each document and its status). The plan documents and `docs/plan.md` stay the record of what
was built and why; this page says only what is left.

How to keep it (CLAUDE.md, "Nothing left for later goes unrecorded"): each PR adds a line here for
what it leaves for later and ticks or removes what it finishes. Item ids (P1, K1, S1, M2, D4, A2…)
are kept because other documents cite them.

Marks: **[code]** a PR, **[owner]** a step only the owner can take (an account, a key, a
setting), **[decision]** the owner's call, **[check]** a look on staging or against a live service.

## To do

Now:

- [ ] **Every key in production** [owner]. GitHub → Settings → Environments → `production`, then
  Actions → Deploy → production to copy them into the Worker (`docs/operations.md`, "Worker
  secrets"). Which are already there can't be seen from a session; check the list against it.
  - For clients now: `WORKOS_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (dictation),
    `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` with the variables `RESEND_FALLBACK_DOMAIN` and
    `RESEND_FALLBACK_DOMAIN_ID`, `SENTRY_DSN_API` and `SENTRY_DSN_WEB`,
    `TWILIO_VERIFY_API_KEY_SID` and `TWILIO_VERIFY_API_KEY_SECRET` (done 2026-11-18, A2),
    `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
  - As each provider goes live (§9): `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`,
    `QBO_WEBHOOK_VERIFIER`; `PLAID_CLIENT_ID`, `PLAID_SECRET`; `STRIPE_SECRET_KEY`,
    `STRIPE_WEBHOOK_SECRET`; `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`; `ELEVENLABS_API_KEY`,
    `ELEVENLABS_WEBHOOK_SECRET`; `META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_ID`,
    `META_WEBHOOK_VERIFY_TOKEN`; `OUTLOOK_*`, `RAMP_*`, `HUBSPOT_*`, `ZOHO_*`, `PODIO_*`, `SLACK_*`
    (client id and secret each); `GOOGLE_CHAT_SERVICE_ACCOUNT`, `GOOGLE_CHAT_PROJECT_NUMBER`;
    `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER`; `BILL_DEV_KEY`; `MFA_TWILIO_ACCOUNT_SID`,
    `MFA_TWILIO_AUTH_TOKEN` (the code service, browser logins); optional `XAI_API_KEY`,
    `GEMINI_API_KEY`.
  - Not copied by `deploy.yml` yet [code, one CI PR]: `ONEDRIVE_CLIENT_*`, `EXCEL_CLIENT_*`,
    `OUTLOOK_CALENDAR_CLIENT_*`, `TEAMS_BOT_*`, `LINKEDIN_CLIENT_*`.
  - Never by hand: `ENCRYPTION_KEY`, `WORKOS_COOKIE_PASSWORD`, `OAUTH_STATE_SECRET`,
    `MFA_ENCRYPTION_KEY` (generated in Cloudflare on deploy; never replace `ENCRYPTION_KEY`).
- [ ] **SSO in WorkOS production** [owner]. WorkOS → Production: Google and Microsoft sign-in on
  (Authentication → Social login) with Mezonas' own OAuth clients, not WorkOS's test ones;
  enterprise SSO (SAML or OIDC) set up per client organization when a client asks, in that
  organization's settings. SSO sign-ins skip our second step (`SECOND_FACTOR_EXEMPT_METHODS`);
  Google and Microsoft sign-ins don't. Same pass: sessions 12 hours and 30 minutes idle,
  branding, and A3 (§1.2).
- [ ] **Finish production after today's deploy** [owner]: approve the Claude connection to
  production, install the platform templates, each client's Sloan, the Mezonas client, Email
  Routing for `in.mezonas.com`, then the sign-in checks and WorkOS multi-factor off (§1.1).
- [ ] **#711 onto staging** [code]: both deploys of `bb05507a` failed the sweep (§2).
- [ ] **Apple Developer Program** (organisation, D-U-N-S for Twelve Thirty-Four) [owner]: gates the
  iPhone build and push (M3) and the Mac app's signing (D5). Start first: approval can take days.
- [ ] **Phone app, accounts** [owner]: an Expo account, `eas init`, `EAS_PROJECT_ID` (M2); a
  Firebase project for Android push, its `google-services.json` and FCM key (M4).
- [ ] **Phone app, code** [code]: `deploy.yml` copies `MOBILE_SIGNIN`, `MOBILE_PUSH` and
  `EXPO_ACCESS_TOKEN`, with Expo's enhanced push security on (M6); universal and app links in
  place of `mezonas://` before production (M8); the evidence panel on the phone's Desk (M11).
- [ ] **Phone app, on staging** [check]: development builds on an iPhone and an Android phone,
  then M5's checks and A8's phone approval of a sign-in.
- [ ] **Phone app, decisions and store** [decision]: M7, M9, M10 and A9; the store listing and
  TestFlight testers.
- [ ] **Desktop app, signing** [owner]: the Apple Developer ID (Mac, notarised) and Azure Trusted
  Signing or an OV certificate (Windows) (D5).
- [ ] **Desktop app, updates** [code, own PR]: an R2 bucket behind `downloads.mezonas.com/desktop/`
  (what `electron-builder.yml` already points at) and a release workflow that builds on macOS and
  Windows runners and uploads there (D6).
- [ ] **Desktop app, on a Mac and a PC** [check]: run it against staging with `MOBILE_SIGNIN=on`
  and check `packages/connectors/src/desktop/NOTES.md` (D4).
- [ ] **Desktop app, code and decisions**: removing a phone also ends that person's desktop
  sessions (D7) [code]; a screen listing a client's computers (D9) [code]; the owner's review of
  §1.151's decisions (D1) [decision]. D8 is the next version, not the finish.

Next:

- [ ] **The buyer on staging**: P1–P5 [owner], then build it in v5 and run the done-when (§3).
- [ ] **The pack templates rebuilt in v5** [code]: every pack ships none since #707 (§2).
- [ ] **Search Console** (S6) [owner]: start now, it collects from the day it is verified.
- [ ] **The site live**: S1–S4 (§8).
- [ ] **The Bookkeeper**: K1–K2 [owner], then K4–K8 once its template is rebuilt (§4).
- [ ] **Plaid attestation** by 2027-04-10 (Plaid's deadline 2027-05-10) [owner] (§14.3).

## Where things stand

- **Built:** everything through M69 (`docs/plan.md` §4), the work recorded through §1.244 and the
  step model (`docs/step-model-plan.md` §13d), migrations through 0102. Every provider is built
  against a fake: nothing has run against live QuickBooks, Gmail, Resend, Twilio, Meta,
  ElevenLabs, Stripe, Plaid, Search Console or the others.
- **Production** (`app.mezonas.com`): purged for the step model on 2026-11-26 (Purge agents run 4,
  06:23 UTC) and deployed by hand from `269a3b70` the same day (Deploy run 606, 13:32 UTC:
  migrations through 0102, #707 included, sign-in codes on). No `v*` tag yet.
- **Staging** (`staging.mezonas.com`): purged and seeded in v5 on 2026-11-25. `main` is at
  `bb05507a` (#711), which isn't on staging: its deploys failed (§2).
- **Agents:** the platform's (the Builder, Sloan, the Coordinator, the Document clerk, the Bill
  clerk) are seeded in v5. **No pack ships a template** until each is rebuilt in v5.
- **Templates to production** (`docs/plan.md` §1.118): planned, not built. Only a template's
  tested set-up moves from staging to production, never client agents or their data.

## 1. Production, sign-in and deploys

### 1.1 Production after today's deploy

| # | Step | Kind |
|---|---|---|
| R1 | Approve this Claude connection to production (the link the MCP shows), so sessions can read it. | owner |
| R2 | Install the platform templates (`docs/operations.md`, "The first production release", step 5) and check each client's Sloan. | owner |
| R3 | The Mezonas client (`docs/operations.md`, "Mezonas, our own client") and the first real client. | owner |
| R4 | Email Routing: `in.mezonas.com` and `agents.mezonas.com`, staging's addresses first, then the catch-all to `mezonas` (`docs/operations.md`, "The first production release", step 3). | owner |
| R5 | Sign-in codes are on in production: sign in, set up a method, save the recovery codes, approve one Claude connection, then WorkOS → Production → Multi-factor auth **off** (A5). Everyone sets up once; WorkOS's enrolments don't carry over. | owner |
| R6 | The external checks: `/api/health`, `/api/ready` with the commit, the QBO webhook's 401 once its verifier is set. | check |
| R7 | Tag `v0.1.0` on `main` at the next deploy, so production has a tag to roll back to. | owner |
| R8 | A written production rollback (only staging's smoke-test rollback is written down; E15). | code, docs |
| R9 | Sentry: point `mezonas-web`'s GitHub code mapping at `jammil-alt/countersign` (it points at Plenary Labs'); cancel the stuck staging run behind MEZONAS-API-1; check that Sentry's alerts reach the phone. | owner |
| R10 | H3: caching off on the two Hyperdrive configs; let `staging` deploy the `claude/*` branches that quick-deploy. | owner |

### 1.2 Sign-in (`docs/operations.md`, "Sign-in codes" and "By hand")

| # | Step | Kind |
|---|---|---|
| A3 | WorkOS production: Dynamic Client Registration and Client ID Metadata Documents on (Applications → Configuration). Check: `curl https://app.mezonas.com/.well-known/oauth-authorization-server` lists `registration_endpoint`. Without it Claude stops at "application not found". | owner |
| A4 | Staging: finish the switch-over (set up a method with a fresh key, recovery codes, one Claude connection), then WorkOS → Staging → Multi-factor auth off. | owner |
| A6 | WhatsApp codes for clients: a WhatsApp sender of our own on the Verify service (Meta Business verification is the slow part), then `TWILIO_VERIFY_WHATSAPP: on` (a one-line PR). | owner, code |
| A7 | Check Twilio Verify for real: `packages/connectors/src/twilio/VERIFY_NOTES.md`, "To verify". | check |
| A8 | Approving a sign-in on the phone: check once the app is live (§6). | check |
| A9 | Not built: an email when a sign-in request is turned down; a phone approving a Claude connection; the desktop app approving. | decision |
| A10 | WorkOS on both environments: branding (logo, colours, favicon; `docs/operations.md`, "By hand"), `auth.mezonas.com` if the plan allows; then `packages/auth/NOTES.md`'s unchecked list, first whether a new address can sign up without a WorkOS invitation. | owner, check |
| A11 | Confirm the approval link also applies to clients' Claude connections (`docs/plan.md` §1.120, "Who"). | decision |

## 2. The step model: follow-ups (`docs/step-model-plan.md` §13d)

- **#711 isn't on staging** [code]: Deploy runs 607 and 608 of `bb05507a` failed the sweep, five
  failures on `/ops/templates/bill-clerk/workflows/invoice-read` where navigation clicks time out,
  probably #711's new side drawer.
- **The pack templates, rebuilt one by one in v5** [code]: the Bookkeeper, Close, Bills to pay
  (AP), Vendor contracts and invoice review (Materials), Spreadsheet to Zoho (Sales), and the
  Marketing set. Each `templates` list is empty since #707.
- **The Invoice item matcher** (§11), built in the new builder: the model's acceptance test [code].
- **Promotion scrubs for v5** (invariant 11) [code]: a loosened `contact.messages`, `rules.values`,
  `ai.values` and `rules.rows` with record literals aren't scrubbed on promotion; a loosened
  `contact.messages` isn't held to act mode at publish (the gate still checks each send).
- **Coverage to rebuild on v5 agents** [code]: Bookkeeping write-once, close, reconcile, `expand`
  and the Builder suite and evals (their subjects were deleted with v4).
- **"Test some of the steps"** refuses every workflow: it was v4 only [code].
- **The rest of §12** [code]: the skill's `mode` (R4; v5 Loops still use it), the tool-only skills
  (R1), duplicate settings (R5), dropped skills (R6), replaced pack actions (R7), the old "how it
  ends" code (R8), the packs' superseded map (R9), vendor-item embeddings (R10, its own migration).
- **The engine taking v5 shapes directly**; today `step-model.ts` loads each as an engine step [code].
- **v5 automations**: still version 2; no Builder chat or Try of their own; renaming an input
  doesn't rewrite the steps that read it [code].
- **Turn on** is only on a client's Progress tab; the v5 builder has Publish only [decision].
- **One main workflow at publish**: `oneProcessProblems` went with v4; rebuild the rule in v5 or
  drop it (Sloan keeps four workflows as the owner's exception) [decision].
- **Lanes**: ways in drawn as lanes into the main workflow on one chart [code, if wanted].
- **Try the v5 builder on staging** (once #711 is there): a template from Describe it, a try, Turn
  on at a test client, then a client's agent customised and its template updated [check].
- A native read of the run timeline's output wording in five languages [owner].

## 3. Purchasing: the buyer on staging

Goal: M42's done-when on staging. A person emails the buyer; it opens a purchase request and
matches the lines; an unsure line is answered on a card; two vendors get an RFQ by email; one
replies with a PDF, one goes silent and expires; the vendor is picked on a card; the PO PDF is
emailed and the QuickBooks purchase order is created; every write is approved once.

| # | Step | Kind |
|---|---|---|
| P1 | Email Routing for `in.staging.mezonas.com`: the subdomain, then a catch-all → Send to a Worker → `mezonas-staging`. Without it nothing reaches the agent. | owner |
| P2 | An email channel for RFQs and POs: Resend (`RESEND_API_KEY`, `RESEND_FALLBACK_DOMAIN`, `RESEND_FALLBACK_DOMAIN_ID`, the domain verified) or Gmail (a test user on the consent screen; its token ends after 7 days until Google's verification). Resend is the quicker. | owner |
| P3 | Intuit sandbox keys: `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` in the staging environment, redirect URI `https://staging.mezonas.com/api/connections/qbo/callback`, webhook at staging. | owner |
| P4 | Confirm `ANTHROPIC_API_KEY` in the staging environment (`LLM_MODE` is `live` there). | owner |
| P5 | The real-mail check before production's purchasing: `packages/connectors/src/upload/NOTES.md` on `in.staging.mezonas.com` (genuine, forged top header, spoofed envelope, Microsoft 365 sender, out-of-office then the real quote). Inbound mail trusts only Cloudflare's own verdict, so genuine mail could fail closed. | check |
| P6 | In the app: the Sandbox client, the Materials pack on, QuickBooks connected to the sandbox company (`9341458640918607`) and synced, bill prices imported, the vendors' contacts in the Directory (consent, role, email). | owner |
| P7 | Build the buyer in v5: `apps/api/src/purchasing-email.test.ts` is the working recipe (a v5 workflow); set `qbo_account_id`; bind the email channel and QuickBooks. | owner, code |
| P8 | Run the done-when with real email from a test inbox; walk `qbo/NOTES.md`, "Against the sandbox company" 1 to 9. | check |
| P9 | Before the first purchasing client: a staging run with real invoices (the goldens don't cover how real vendors word their packs). | check |

Decisions [decision]: the RFQ email's wording and language (English only today; C2.5); whether a
vendor with nobody who agreed to email is asked once the client says so; the default wait for
quotes (we suggest 2 days); the PO lines' expense account when an item has none.

Gaps, only if the test shows they matter [code]: a reply from a colleague's address isn't shown
on the thread line or addable as a contact; a line with no pack size and no SKU gets no automatic
match, and earlier wrongly filed price observations aren't re-filed; no screen shows or changes a
catalog item's QuickBooks item; the portal channel for conversations (§1.66); a request line
doesn't keep the vendor item it matched, so quotes in boxes aren't sized by that vendor's box.

## 4. Bookkeeping: bank transactions into QuickBooks

Built against the fakes (`docs/plan.md` §1.79, M51–M57, the double-write fixes of §1.187).
**Off for clients** until the steps below. The Bookkeeper template is gone with v4: rebuild it in
v5 first (§2).

| # | Step | Kind |
|---|---|---|
| K1 | Plaid sandbox keys in staging; redirect URIs for staging, production and localhost in Plaid's dashboard; Link's name "Mezonas". | owner |
| K2 | Walk `packages/connectors/src/bankfeed/NOTES.md` in Plaid's sandbox. | check |
| K3 | Plaid production: the review and the OAuth banks' registration (weeks). Start early. | owner |
| K4 | QuickBooks' checks (P3's keys): `qbo/NOTES.md`, "The chart of accounts" and "Booking bank transactions", check 6 (the same-day query by the transaction's mark) before any client. | check |
| K5 | Run the rebuilt Bookkeeper on the Sandbox (`docs/operations.md`, "Switching on the Bookkeeping area"). | check |
| K6 | Plaid's price per bank (absorbed or credits); `book_confidence_auto` (0.85); whether learned rules need a person's yes first. | decision |
| K7 | Fluent review of the Bookkeeping portal words. | owner |
| K8 | QuickBooks' register and Plaid's balances in their sandboxes, then one Sandbox month reconciled by the rebuilt Bookkeeper. | check |
| K9 | The Close pack: `qbo.journal.create` on the QuickBooks sandbox (`qbo/NOTES.md`, "Journal entries"). | check |
| K10 | Books health: the sign of a liability's `CurrentBalance` and Undeposited Funds' `AccountSubType` on the sandbox. | check |
| K11 | Matching: a back-office screen for saved rules and "save as rule" on the reconciliation card; a pack tool running the ROMCO configuration. | code |

## 5. Messaging: Sloan, Reggie and agents' own lines

- **Sloan by email and text** is built (§1.150). On staging it needs P1, P2, and for texts the
  client's Twilio number with its texting registration and the person signed up [owner].
  Whether Sloan may pause a service on a text (Twilio doesn't prove the sender) [decision].
- **Reggie by email and text** [code, own PR]: needs Mezonas' own number and campaign.
- **An agent's own line** (§1.160) is built. Whether the account's own number is billed too
  [decision]; the by-hand checks against a real subaccount (`twilio/NOTES.md`, "Calls that carry
  the client's name") before the first client's calls [check].
- **Spreadsheets and Zoho** (§1.164) is built; its template is to rebuild in v5 (§2). Zoho's field
  list, scope and 50-field limit on the Mezonas Dev org [check]; which client first, the fields
  matched on, and whether unmatched rows make new leads [decision]; the portal's "attach PDFs or
  images" message doesn't name spreadsheets [code].

## 6. The phone app (`docs/plan.md` §1.116, `apps/mobile/README.md`)

Merged unfinished; built and tested against fakes, never run on a phone. Off until
`MOBILE_SIGNIN=on` and `MOBILE_PUSH=on`.

| # | Step | Kind |
|---|---|---|
| M2 | An Expo account; in `apps/mobile`: `npx eas-cli login`, `npx eas-cli init`; the project id in `EAS_PROJECT_ID`. | owner |
| M3 | iPhone: the Apple Developer Program (organisation, $99 a year, D-U-N-S), register the phone (`eas device:create`), `eas build --profile development --platform ios` with EAS making the certificates and APNs key. Bundle id `com.mezonas.app`. | owner |
| M4 | Android: `eas build --profile development --platform android`; for push a Firebase project, `google-services.json` as the EAS file variable `GOOGLE_SERVICES_JSON`, the FCM v1 key via `eas credentials`. The Play Console ($25) only for the store. | owner |
| M5 | Try it on staging: `MOBILE_SIGNIN=on` and `MOBILE_PUSH=on` with `wrangler secret put` (until M6), sign in, set up the phone, a Desk item on the Sandbox; the notification within 5 minutes, Face ID to sign, `inbox.device_signed` in the audit log, Undo within 60 seconds, removing the phone stops notifications. | check |
| M6 | Expo's enhanced push security on; `deploy.yml` copies `MOBILE_SIGNIN`, `MOBILE_PUSH` and `EXPO_ACCESS_TOKEN` (its own PR), before production's `MOBILE_PUSH=on`. | owner, code |
| M7 | A longer session for an unlocked registered phone; whether a remembered browser lets a phone sign-in skip the code; whether operators get the app; the store listing; TestFlight testers. | decision |
| M8 | Universal links (iOS) and app links (Android) in place of `mezonas://`, before production's `MOBILE_SIGNIN=on`. | code |
| M9 | When to refuse a `mezonas-sign:v1` signature that comes with an answer or a note. | decision |
| M10 | Whether a release-code card may be resolved from a phone without a signature; whether a phone may turn human release off; test first whether an admin's phone undoing a rejection lets an `ifNoAnswer: proceed` step go on. | decision, check |
| M11 | The evidence panel on the phone's Desk (the web inboxes have it, §1.211). | code |

## 7. The desktop app (`docs/plan.md` §1.151, `apps/desktop/README.md`)

The app, its API (§1.204) and the `desktop` connector are merged; never run on a Mac or a PC.

| # | Step | Kind |
|---|---|---|
| D1 | Review §1.151's decisions: Electron; closed workbooks only; only files added after a folder is given; drive paths only; a long poll. | decision |
| D4 | A Mac and a PC: `node apps/desktop/node_modules/electron/install.js`, then `MEZONAS_API_URL=https://staging.mezonas.com pnpm --filter @countersign/desktop start`, with `MOBILE_SIGNIN=on` on staging; check each item in `desktop/NOTES.md` (Excel's owner file, a written workbook opens without repair, OneDrive-synced folders, Mac privacy prompts). | check |
| D5 | Signing: the Apple Developer ID (the same account as M3) for signing and notarising; Azure Trusted Signing or an OV certificate for Windows. Without them Gatekeeper and SmartScreen warn. | owner |
| D6 | The update feed: an R2 bucket behind `downloads.mezonas.com/desktop/` and a release workflow on macOS and Windows runners (its own PR). | owner, code |
| D7 | Removing a phone also ends that person's desktop sessions (both are `ph` sessions). | code |
| D9 | A back-office screen listing a client's computers (today they show as Desktop app connections). | code |
| D8 | Next version: signing Desk items in the app (Touch ID, Windows Hello), the Office add-in for open workbooks, Word, QuickBooks Desktop (Web Connector), files already in a folder, network shares, managed installs. | later |

## 8. The marketing site and the Marketing area (`docs/marketing-plan.md`)

The site's job ran in today's deploy; whether `mezonas.com` answers isn't checked from a session.

| # | Step | Kind |
|---|---|---|
| S1 | Delete the three parking records (`A mezonas.com 15.197.148.33`, `A mezonas.com 3.33.130.190`, `CNAME www`); keep the `google-site-verification` TXT. | owner |
| S2 | Check `/`, `/hire`, `/security`, `/terms`, `/privacy`, `/subprocessors`, `/sms-terms` and `www`; re-run the `site` job if needed. | check |
| S3 | The lawyer's read of the terms (notice periods, liability cap, age 16, the AI providers' terms). | owner |
| S4 | Google's OAuth verification once the site is live, with `gmail.send`, `webmasters.readonly`, `calendar.events.owned` and `drive.file`; remove `gmail.readonly`, `gmail.labels`, `gmail.compose` first. | owner |
| S5 | The Mezonas client on staging and production: internal, approvals to us, Marketing pack on, `mezonas.com` and its goals. | owner |
| S6 | Search Console: a service account (no roles), its JSON key, added to the property as Restricted, entered in the Mezonas client's connection. | owner |
| S7 | Bing Webmaster Tools: import from Search Console, an API key. | owner |
| S8 | Measuring: the lawyer reads `docs/marketing/privacy-measurement-draft.md`, the section into `/privacy`, the variable `MEZONAS_MEASURE_URL` and a `deploy.yml` PR passing it to the site build. | owner, code |
| S9 | The collector's host `collect.mezonas.com` (and `collect.staging.`): DNS and its PR (no route in `wrangler.jsonc` yet). D2: point it at production now that production is current, or at staging. | owner, code, decision |
| S10 | Guides: the R2 bucket `mezonas-site-content`, the `SITE_CONTENT` binding (still commented out in `apps/site/wrangler.jsonc`), `SITE_GUIDES=on`, `INDEXNOW_KEY`, `/sitemap.xml` in Search Console. | owner, code |
| S11 | The claims list: read `docs/marketing/claims.md`, load it (`seed-claims`), point the Website connection at mezonas.com. | owner |
| S12 | The marketing agents: rebuild the set in v5 (§2), then fork it into the Mezonas client; `MARKETING_RESEARCH=on` and its search vendor; a LinkedIn developer app on the company page. | code, owner |
| S13 | Before a client gets the area: the lawyer's read of `docs/marketing/processor-terms-draft.md`; a CMS connector only when a client asks. | owner |
| S14 | The site's "Get started" button is a mailto; a form (cases W1) if wanted. The site still calls Sloan "your manager agent". | code, decision |

## 9. Connectors and providers

Each is built against a fake. What is unchecked is in its folder's `NOTES.md`
(`packages/connectors/src/<name>/NOTES.md`; the count is its unchecked items). To go live: the
owner's account and keys, then one pass of "To verify" against the real service.

| Connector | Unchecked | What the owner needs |
|---|---|---|
| QuickBooks (`qbo`) | 22 | Sandbox: P3. Production: Intuit's app review and security questionnaire, production keys. Risk: after a long gap, deletions of an entity with 1,000+ changes can be missed (the sync says "qbo CDC cap"). |
| Gmail (`gmail`, send only) | 27 | Google's verification (S4). |
| Resend (`resend`) | 23 | Account, key, domain (P2); the webhook `https://<app host>/api/hooks/resend` for `email.delivered` and `email.bounced`, its secret as `RESEND_WEBHOOK_SECRET`. |
| Outlook (`outlook`) | 17 | Entra app, publisher verification, `OUTLOOK_CLIENT_*`. |
| OneDrive, Excel, Outlook Calendar | 9, 17, 16 | An Entra app each, publisher verification, `deploy.yml` to copy their secrets (its own PR). First checks: `Files.ReadWrite.AppFolder` for work accounts; Excel's quote prefix. |
| Teams (`teams`) | 28 | An Azure Bot (single tenant), `TEAMS_BOT_*`, the endpoint `/api/hooks/teams`, the app package. First: can a single-tenant bot post in another organisation's Teams. |
| Google Calendar (`gcal`) | 14 | `calendar.events.owned` with S4. |
| Google Drive, Sheets | 17, 20 | `drive.file` with S4; `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER`. |
| Google Chat (`gchat`) | 20 | Chat app, service account, `GOOGLE_CHAT_*`. |
| Slack (`slack`) | 18 | Slack app, `SLACK_*`. |
| Twilio (`twilio`) | about 150 | Account and keys; subaccounts per client; which countries first; a US client's A2P registration against the real Trust Hub. |
| WhatsApp through Meta | about 70 | Meta app, Tech Provider, `META_*`. |
| ElevenLabs | about 40 | Account, key, webhook secret; its own workspace (§14.4). |
| Texts and calls, all three | | **Legal review** before any live call or text: consent, calling hours, recording consent, AI disclosure; the relationship basis (§1.97) and the texting sign-up (§1.98) under the TCPA and CTIA. |
| Code service (`apps/mfa`) | | Confirm the domains; Email Routing for `agents.staging.mezonas.com`; the codes Twilio subaccount; email codes on (`apps/mfa/NOTES.md`). |
| Browser logins (`browser`) | | Browser Run on; the first real low-tier site; legal review of agent accounts. |
| Plaid (`bankfeed`) | 29 | §4 (K1–K3); BAA (until then not for HIPAA clients). |
| Ramp (`ramp`) | about 19 | Developer app, `RAMP_*`. |
| BILL (`billcom`) | 8 | A developer key (sandbox first), a dedicated BILL user entered by the client admin; production after BILL's review. Decide: our user's BILL role; BILL on the subprocessors page; its BAA; whether payments stay off (`billcom.payment.create` is refused until BILL's trusted session goes through the code service). |
| Odoo (`odoo`) | about 14 | An Odoo 17 trial on the Custom plan; per client an internal user and API key. |
| Stripe (billing) | about 9 | Account and keys; the prices (§15). |
| Zoho CRM (`zoho_crm`) | about 35 | `ZOHO_CLIENT_*` in both environments, the first connection to the Mezonas Dev org. |
| HubSpot, Podio | about 9, 11 | A developer app each. |
| Marketing: Search Console, Bing, Website, LinkedIn, Hacker News | 14, 9, 8, 7, 5 | §8 (S6, S7, S10, S12). |
| Webhooks (Zapier) | 0 | Works; the published Zapier app is later. |

Also open: new connections are bound with the agent's grants, not narrowed to what it needs
(`docs/connectors-plan.md` §5.5) [decision]. Not planned until the owner picks one: Zoho Books,
Inventory and Expense; SharePoint.

## 10. Back office: onboarding, setup, forms, the Dev queue, area owners

Onboarding (`docs/cases-plan.md` §7, `docs/plan.md` §1.149) [code]:
- O4, talk it through with Sloan, across the setup chapters: designed as a v3 workflow, so
  redesign it on v5 first [decision].
- O5: the scope and signing (`intake_scope`, Turn on checking the scope), facts into the knowledge
  base, fit-gap, the "scope ready" and "what happens next" emails (still `unsupported`).
- Reggie filing facts and suggesting what to cover; Reggie's to-do tools, outbound email for asks,
  chasing missing connections (§1.124.4).
- O6, voice.
- Smaller: a client file's documents (no storage); pack and template questions in English only;
  people added to an existing client still get WorkOS's invitation; first-look lines filed as
  `seen` facts; setup's server-side words in six languages; tries that stop at a person step; a
  browser look at setup in both themes with the v5 Bill clerk's seats [check].
- The owner's to confirm: "lost" for the 12-month deletion; every bounce leaves a to-do; Send it
  again for invites only; whether the deal page's "Set up the account" card stays [decision].
- Unchecked against Resend: its webhook header names and tag shape (`resend/NOTES.md`) [check].

Forms (`docs/forms-plan.md`) [code]: F-4 dictation per question and the one-time code (whether a
code is required [decision]); F-5 talk it through; F-6 saved forms and the editor, Request info by
hand, texts and WhatsApp, passing a form on; the Desk door for client users. Link lifetime and
passing on were never confirmed; saved forms were to be "versioned like automations" [decision].

The Dev queue (§1.125): the daily scheduled task (`docs/operations.md`) [owner]; the seed
requests from the AR aging and management report builds filed on staging [owner]; "In
production" for a request filed on staging needs a cross-environment read [code].

Area owners (§1.117): the name pool of 40 short names [owner].

The walk-through (`STAGING_QA.md`): one way to start a client (New client, Sign up now, New deal
and Invite differ) and the words (Areas or Packs, owners, processes, supervisor, lead, Reggie,
Sloan, Kit) [decision]; schedule wording is 12-hour; deal and contact time zones are free text; a
dependent write inside one skill reads its before state in a test run [code]; the Your call badge
on Library and New client, and why `GET …/skills` hangs on staging [check].

## 11. Builder, SOP and assurance

- G6 `manual.read` for every agent (new fixtures with a key) [code]; G7 governance in the other
  model calls (the owner's review, confer, path choice, chat, the Builder) [code]; G8 a run-level
  pin of the governance versions, with the guardrails as seeded rows [code, migration]; G9 the
  guardrails in other languages [owner]; G13 whether a client user may read "What you can adjust"
  [decision].
- SOP (`docs/sop-plan.md` §7): an accountable person per agent, share links outside the client's
  team, the back office's view of the SOP (route built, no screen) [decision]; then S3 (share
  links, the accountable person, packs' own controls) [code, after the owner]; the chart's chip
  still says "code" where the Do form says "Rules" [code]; references (the client's policies, the
  agents it takes over from, its knowledge base) [code]; icons `mz-agent`, `mz-ai`, `mz-rules`
  with the designer [owner]; check whether the v5 Builder writes each step's purpose (SOP-B) and
  look at a revision on staging (SOP-T) [check].
- Assurance (`docs/agent-assurance-plan.md`): A3 attack cases, now on v5 agents, recorded with a
  key [code]; whether an attack check in review holds the trial (recommended) [decision]; read
  each provider's own terms page and set `read: "page"` in `packages/core/src/assurance/terms.ts`
  (until then `no_training` is In review on every AI agent) [code]; confirm our Gemini key is on a
  billed project [owner]; accept that Intuit grants what we ask, or leave K21 open [decision];
  adopt the two retention rows as policy [owner].

## 12. Run quality: the verifier, evals, metering and costs

- The verifier's model (about 1–2 cents a write on the agent's model; a smaller one under 0.2
  cents would be a new `oversight.verifyModel`) [decision]; how often it's wrong (count overruled
  disagreements on staging) [check].
- Re-record with a live key (`LLM_MODE=record`): the eval harness's answers, the verifier's, the
  process interview's [code].
- File and email intake (§1.213): a back-office screen for report profiles; a screen of platform
  alerts so the Desk shows intake's; reports from portal uploads and in an email's body [code].
- Metering: a run view that adds a run's metered rows [code]. Not counted: deal emails, the Dev
  queue's notices, texts to the agents' code numbers, BILL's per-payment fee once payments exist
  [code]. Unit costs are placeholders (`UNIT_COSTS_CHECKED_ON = "unverified"`); model, embedding
  and transcription prices unverified [check]. One live transcription to check OpenAI's `usage`
  shape (H5) [check].
- H1: one live run each of a conversation step, an agent-chosen path, an agent-judged repeat, an
  oversight review of a failed step and an AI second check [check]. H8: LinkedIn's and HubSpot's
  dead-grant codes from a live call [check].
- The process interview (§1.217): sending the link from Mezonas, filing answers into an intake,
  six languages, the reuse check's judge on interviews [code].

## 13. Performance and code health (`docs/audit-plan.md`)

Open from the 2026-11-11 audit, all [code]: responses that wait on background work (1.7); waiting
runs still poll every 2 s, the portal's Runs list every 5 s (2.2); go-live asked once per agent on
ClientOverview (2.6); lists by the page beyond the back office's Runs (3.1–3.5); per-screen
splitting toward 300 kB first load, core's single export (4.2, 4.6, 10.3; today 301.9 kB of 335);
feedback status on its own route, no ETags (5.4, 5.5); 6.5–6.14 (re-measure 6.10 after the step
model); indexes (7.1–7.7, a migration PR); the cron (8.1–8.5); clean-ups 10.1–10.12 (no shared
OAuth client, 528 `as unknown as`, `log/` not renamed). 5.3: count audit rows per hour on staging
[check].

## 14. Security, compliance and trust

### 14.1 Enterprise readiness (`docs/enterprise-readiness.md`)
Which accounting system or ERP the pilots use [decision]. E2 a closed-period lock (nothing reads
`BookCloseDate`); E3 a signature always on vendor bank and remit-to fields; E4 a hard kill switch
(draft PRs #666, #668, #705, not merged); E5 a generic stale-write check (some connectors have
their own); E1 a lock around token refresh, only if `invalid_grant` shows [code]. E7 the security
packet, E11 the onboarding checklist, E12 runbooks, E15 the production rollback (R8) [docs].

### 14.2 HIPAA, SOC 2 and PCI (`docs/hipaa-plan.md`)
- T3 a page for the client's audit log (the CSV export exists; LOG-3 in `controls.ts` still says
  not built) [code]; T4 a yearly task for audit retention past 6 years [owner]; T9 Sentry's BAA or
  strict scrubber tests [decision]; T10 a penetration test [owner, later].
- Before any BAA is recorded: `BAA_PROCESSORS` empty on both environments and no tenant in HIPAA
  mode [check]. Before the first purge of a retired client: time `purgePlan` on a Neon branch of
  production [check].
- `docs/security.md` §10 "Still to set": passkeys, Intuit's and Plaid's second factors, the scan as
  a required check, `ALERTS_TOKEN`, the bank-feed webhook exclusion [owner].
- Administrative [owner]: a security officer, the risk analysis, vendor BAAs and the client BAA and
  DPA, acceptable use, sanctions, training, background checks; adopt the three draft policies in
  `docs/policies/` and set them to 1.0 there and in `POLICIES`; counsel on the incident response
  notice periods; the information security policy's §3 wording; the first deletion drill on
  staging; 2026-Q4's access review before 31 December; the SOC 2 tool and when Type II starts
  [decision]; confirm PCI SAQ A.
- Not built [code]: a Purge client workflow input for the drill, the S-3 evidence pack, vendor
  reviews and training recorded in the product.

### 14.3 Plaid attestation (`docs/plaid-plan.md`), by 2027-04-10
[owner]: the vendor-console settings (`docs/security.md` §10); Plaid's "Reason for data access";
the accounts inventory (Intuit, Plaid, DNS, Twilio, Resend, ElevenLabs and the model consoles are
blank) and the first access review; the leaver test with a dummy user, logged; written policy
confirmation from everyone with access; the evidence folder, then attest. [decision]: deleting one
bank's transactions on a client's request; staging behind Cloudflare Access.

### 14.4 Trust (`docs/marketing/trust-plan.md`)
- [code]: record operators' model calls (the Builder, ops questions, the test bench; a migration);
  masking (needs an ARCHITECTURE version first); a self-serve full export; vendor deletion on
  retirement (T5); a contract test that no pay verb exists; ElevenLabs retention fields; the site's
  security page still says "Enterprise terms", "enterprise-grade" and "Nothing posts without
  approval".
- [owner]: the model providers' terms on file and which plan the Ops MCP connector runs under; ask
  for zero retention; ElevenLabs in its own workspace; the DPA with counsel.
- [decision]: masked names; documents read as text first; the data receipt in scope; deletion
  timing; the security page's wording.

### 14.5 Registers (`docs/eol-inventory.md`)
Replace the *confirm* dates with checked ones [check]; record work devices (GOV-6) [owner]; the
next quarterly review, about February 2027 [owner].

## 15. Owner decisions not listed above

- **Billing**: the credit allowance per agent; whether allowances pool (built pooled); the
  prices; whether a client agent's test runs, paused days, trial and sign-off days are billed.
- **Wave 2 confirmations** (§7 item 8): Sloan's name and the merge from "Account check"; the agent
  address form; client test cases never gating shared skills; who sets "on its own".
- **Smaller defaults** (§7 item 10): the 60 s undo window; US federal holidays only; notification
  texts only from the client's own number; replay as a test run in the same client.
- **Matching** (§1.215): `invoice_two_systems`' 30-day window and a cent of tolerance; an equal
  amount alone never auto-matches; fuzzy weights; a rule's match stored as `exact`.
- **Books health** (§1.216): only reconciliations signed off in Mezonas count; the thresholds;
  whether to backfill more than 90 days.
- **Packs and areas** (§1.230–§1.235): a HIPAA client and a pack with our vendors; Close's
  accruals on by default or opt-in, and the default accrual account; AP's Bills to pay instead of
  invoice review (with both, each invoice runs twice), and an approved bill final in our records;
  the statement's counters and its audience; "Needs us" rules; usage shown to client admins only;
  deleting a learned note removes its row.
- **Repeat and choices**: whether the portal shows an agent's reason for a choice; `between` in
  business hours; more than 10 passes.
- **Texting**: a forwarded invitation can still learn a number is a client's contact (H10).
- **Reports**: reports by email; filtering by a KPI's value (`docs/reporting-plan.md`).

## 16. Language and legal

- A **fluent speaker's review** of Spanish, French, Portuguese, Italian and German: the portal's
  message files, `TIMELINE_WORDS`, `runAgent`'s language instruction, every `// fluent review`
  (the chart #578, setup #601, Procedures #602), the resume screen (H7), the handoff (§1.219),
  Bookkeeping (K7), the statement (§1.234), the governance copy (G9) and the output wording (§2).
- **Legal**: the site's terms and privacy (S3), measurement wording (S8), processor terms (S13),
  calls and texts (§9), agent accounts on third-party sites, the incident response notice periods
  (§14.2), the DPA (§14.4).

## 17. Later, not started

- **The FP&A pack** (`docs/fpa-plan.md`): the owner said not yet (2026-11-16); its team design
  predates the step model and needs redoing on v5 first.
- **Templates to production** (§1.118).
- "Ask an agent" and "Report to an agent" step kinds: dropped.

## 18. Docs housekeeping

- `docs/ARCHITECTURE.md` (v0.24): fold in the Marketing area, the Bookkeeping area, the eval
  harness (§1.212) and metering (§1.210).
- `docs/audit-plan.md`: tick what merged (4.7, 5.1, 5.2, 9.1–9.6).

## Finished ids still cited elsewhere

Code and older documents cite these; they are done and kept here only so the citation resolves.
A1: WorkOS multi-factor required on both environments (owner, 2026-11-16), until A5 turns it off.
A2: our own second step, its Twilio subaccounts, Verify services and keys for both environments
(2026-11-18), on in production since the 2026-11-26 deploy. D2, D3: the desktop API and its
migration 0080 (#546, #548). G3, G4: a try on a Sandbox record, decisions' words changed on the
card (Wave Y, #589, #599).
