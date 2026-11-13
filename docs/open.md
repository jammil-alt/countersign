# What's still open (2026-11-08)

One list of everything that is still open, gathered from `docs/plan.md`, `docs/marketing-plan.md`,
`docs/operations.md`, `docs/hipaa-plan.md` and each connector's `NOTES.md`. Those stay the
source for the details; this page says what is left and in what order. Priority (owner,
2026-11-08): **1. the purchasing agent working, 2. the marketing site, 3. the connectors and
the rest.**

## Where things stand

- **Built:** everything through M50 (`docs/plan.md` §4), migrations through 0038, merged to `main`
  and deployed to staging (`https://staging.mezonas.com/api/health` answers 200). That includes
  purchasing end to end by email (M42), message translation (M40), US texting registration (M41)
  and the whole Marketing wave (M43–M50).
- **Every provider is built against a fake.** Nothing has yet run against live QuickBooks, Gmail,
  Resend, Twilio, Meta, ElevenLabs, Stripe, Plaid, Search Console or the others.
- **No open PRs or issues** on GitHub. Production has had no release (no `v*` tag).
- Almost everything below is **a setup step, a key or a decision for the owner**, not code. Where
  code is still needed, it says so.

## 1. The purchasing agent (the buyer) working on staging

Goal: M42's done-when, on staging. A person emails the buyer; it opens a purchase request and
matches the lines; an unsure line is answered on a card; two vendors get an RFQ by email; one
replies with a PDF, one goes silent and expires; the vendor is picked on a card; the PO PDF is
emailed and the QuickBooks purchase order is created; every write is approved once
(`docs/plan.md` §1.71, M42).

### 1.1 Owner setup that blocks it

| # | Step | Where | Why |
|---|---|---|---|
| P1 | **Email Routing for `in.staging.mezonas.com`**: add the subdomain, then a catch-all rule → Send to a Worker → `mezonas-staging`. `EMAIL_FORWARDING_DOMAIN` is already set in `apps/api/wrangler.jsonc`. | `docs/operations.md`, "By hand" step 3 | The buyer's address (and every forwarded invoice) arrives through the Worker's `email()`. Without it nothing reaches the agent. |
| P2 | **An email channel to send RFQs and POs from.** Either: **Resend** (`RESEND_API_KEY` secret, `RESEND_FALLBACK_DOMAIN` and `RESEND_FALLBACK_DOMAIN_ID` variables in the GitHub staging environment, the sending domain verified in Resend); or **Gmail** (the "Mezonas web" OAuth client exists; add the sending account as a test user on the consent screen. In testing mode its token ends after 7 days, so reconnect weekly until Google's verification). Resend is the quicker one to keep working. | `docs/operations.md` "Worker secrets" (Resend), "Google" | Reach out needs a bound email channel; an unbound one is `not_allowed`. |
| P3 | **Intuit developer app, sandbox keys**: `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET` in the GitHub staging environment, redirect URI `https://staging.mezonas.com/api/connections/qbo/callback`, webhook pointed at staging. `QBO_ENV` is `sandbox` on staging already. | `docs/operations.md`, "Intuit" | QuickBooks vendor and PO creation, and the bill-price import. |
| P4 | **Confirm the model key** (`ANTHROPIC_API_KEY`) is in the staging environment. `LLM_MODE` is `live` there. | GitHub → Environments → staging | The reading skills (request, quote PDF) call the model. |

### 1.2 Then, in the app (no code)

1. Use the **Sandbox** client (or a pilot client). Switch on the **Materials pack** (Packs → Switch on).
2. **Connect QuickBooks** from the client's portal to the sandbox company (`9341458640918607`) and
   let the first sync run.
3. **Import bill prices** (the client's Packs tab, a date range) so the catalog has items, vendors'
   own words and prices.
4. **Directory:** each vendor that should get an RFQ needs its organization tied to the vendor and
   a person with an email, consent to email, purchasing or sales role. A vendor with nobody is
   listed and skipped; the agent never guesses an address.
5. **Build the buyer in the Agent lab** from the pack's skills (`comms.read-message`,
   `materials.read-request`, `materials.open-request`, the request-lines card, `materials.vendor-contacts`,
   `materials.quote.create` and `quote.document`, reach out in a `for_each`, `quote.mark-sent`,
   `read-quote`, the vendor-choice card, the PO PDF, `materials.vendor.qbo`, `materials.po.qbo-lines`,
   `qbo.purchaseorder.create`). `apps/api/src/purchasing-email.test.ts` is the working recipe: copy its
   workflow. Set the skill setting `qbo_account_id` (the expense account PO lines book to).
6. **Bind its channels and connections** (email channel from P2, QuickBooks), test-run it, then take it
   through trial (every write signed).
7. **Run the done-when** with real email from a test inbox, and walk the QuickBooks sandbox checks in
   `packages/connectors/src/qbo/NOTES.md` ("Against the sandbox company", 1 to 8).

### 1.3 Owner decisions for the buyer (`docs/plan.md` §1.71)

- The RFQ email's wording and language (plain English, built in code today).
- Whether a vendor with nobody who agreed to email is asked anyway once the client says so (today: skipped).
- The default wait for quotes (the reach-out's `timeout`; we suggest 2 days).
- The QuickBooks expense account for PO lines when the item has none (a per-agent skill setting today).

### 1.4 Known gaps (code, only if the test shows they matter)

- A vendor's reply that comes **after** the reach-out ended, or **from a colleague's address**, is
  dropped; a person enters it (§1.65, §1.71).
- RFQs are English only; the vendor's language is open.
- QuickBooks PO lines are account lines only (catalog items carry no QuickBooks item id).
- The portal channel for conversations (§1.66).
- **The vendor catalog** (`vendor_item`, plan §1.88): each vendor's items for the client with pack size,
  unit conversion, last price and preferred vendor. Planned; one migration.

## 1b. The Bookkeeper (bank transactions into QuickBooks)

Built against the fakes (`docs/plan.md` §1.79, M51–M56): the chart of accounts synced from
QuickBooks with notes on what each account is for, the Bookkeeping pack, the QuickBooks writes
(purchase, deposit, transfer), several banks per client, the Bookkeeper template and the screens,
and reconciliation (§1.80, M57: each linked account against QuickBooks monthly, a deposit against
its payout statement, signed off on a card). To go live:

| # | Step | Notes |
|---|---|---|
| K1 | **Plaid sandbox keys**: `PLAID_CLIENT_ID` and the sandbox `PLAID_SECRET` in the GitHub staging environment; redirect URIs `https://staging.mezonas.com/connections/bankfeed/callback` (and production's, and `http://localhost:8787/…`) in Plaid's dashboard; Link's name "Mezonas". | `docs/operations.md`, Plaid |
| K2 | Walk `packages/connectors/src/bankfeed/NOTES.md` in Plaid's sandbox. | Nothing has run against real Plaid. |
| K3 | **Plaid production**: the review (company profile, security questionnaire, use case) and the OAuth banks' registration (Chase and the like take weeks). | Start early. |
| K4 | Intuit sandbox keys (P3 above), then the checks in `packages/connectors/src/qbo/NOTES.md` ("The chart of accounts", "Booking bank transactions"). | Shared with the buyer. |
| K5 | Run the Bookkeeper on the Sandbox: `docs/operations.md`, "Switching on the Bookkeeping area". | |
| K6 | Decide: Plaid's price per bank (absorbed or credits); `book_confidence_auto` (0.85 today); whether learned rules need a person's yes first. | `docs/plan.md` §1.79 |
| K7 | Fluent review of the Bookkeeping portal words (one block per language, the reconciliation block too). | |
| K8 | Check QuickBooks' register (`qbo/NOTES.md`, "The register, for reconciliation") and Plaid's balances (`bankfeed/NOTES.md`) in their sandboxes, then reconcile one Sandbox month by hand: the Bookkeeper's "Every month" workflow, run now. | Migration 0040 applied. |

## 2. The marketing site (mezonas.com)

This session's network can't reach `mezonas.com`, so whether it is live is **not checked here**.
The checklist in `docs/operations.md` ("The public site") is still unticked.

### 2.1 Get the site live

| # | Step | Notes |
|---|---|---|
| S1 | Delete the three parking records (`A mezonas.com 15.197.148.33`, `A mezonas.com 3.33.130.190`, `CNAME www`); keep everything else, especially the `google-site-verification` TXT. | `docs/operations.md`, "The public site" |
| S2 | Re-run the `site` job of the latest Deploy on `main`; check `/`, `/hire`, `/security`, `/terms`, `/privacy`, `/subprocessors`, `/sms-terms` and `www`. | The job already exists in `deploy.yml`. |
| S3 | **Lawyer's read of the legal pages**: the draft terms listed in `apps/site/README.md` ("Placeholders to fill in": notice periods, the liability cap, age 16, the AI providers' terms). | Placeholders are filled; the terms themselves are drafts. |
| S4 | **Submit Google's OAuth verification** once the site is live (homepage, `/privacy`, `/terms`), with `gmail.send` and, for M50, `webmasters.readonly`. Remove `gmail.readonly`, `gmail.labels` and `gmail.compose` from the consent screen first. | Unblocks Gmail beyond test users and `gsc_oauth` beyond 7-day tokens. |

### 2.2 Measuring, guides and search (each off until switched on)

| # | Step | Notes |
|---|---|---|
| S5 | Create the **Mezonas client** on staging (and later production): internal flag, approvals to us, Marketing pack on, site `mezonas.com` with its goals. | `docs/operations.md`, "Mezonas, our own client" |
| S6 | **Search Console**: a Google Cloud service account (no roles), its JSON key, added to the property as Restricted; enter it in the Mezonas client's connection. | `docs/marketing-plan.md` §8 tasks 1–2. Start now: it collects from the day it is verified. |
| S7 | **Bing Webmaster Tools**: import from Search Console, generate an API key, enter it. | §8 task 3 |
| S8 | **Measuring**: the lawyer reads `docs/marketing/privacy-measurement-draft.md`; the reviewed section goes into `/privacy`; the repository variable `MEZONAS_MEASURE_URL`; a small `deploy.yml` PR passing it to the site build. | Code: the one-line `deploy.yml` PR (its own PR). |
| S9 | **The collector's host** `collect.mezonas.com` (and `collect.staging.`): DNS and its own PR. Decide **D2**: cut production's first release for it, or point at staging until then. | `docs/marketing-plan.md` §8 tasks 5–6. Code: the host PR. |
| S10 | **Guides**: create the R2 bucket `mezonas-site-content`, bind `SITE_CONTENT` to `apps/api` and the site, set `SITE_GUIDES=on` (uncomment two lines in `apps/site/wrangler.jsonc`); `INDEXNOW_KEY` once the site serves its key file; submit `/sitemap.xml` in Search Console. | Code: the binding PR. |
| S11 | **Claims list**: read `docs/marketing/claims.md`, load it for the Mezonas client (`seed-claims`), point the Website connection at mezonas.com. | Content can't publish without it. |
| S12 | **The marketing agents**: fork the templates into the Mezonas client (weekly report, titles, article drafts, forum watch); `MARKETING_RESEARCH=on` and its search vendor for article research; a **LinkedIn** developer app on the company page (Community Management API) for social posts. | M47–M49 |
| S13 | Before offering it to a client: the lawyer's read of `docs/marketing/processor-terms-draft.md`; a CMS connector only when a client asks. | M50 |

## 3. Connectors and providers

Each is built and tested against a fake; what is unchecked is in its folder's `NOTES.md`
(`packages/connectors/src/<name>/NOTES.md`). To go live each needs the owner's account and keys,
then one pass of its "To verify" list against the real service.

| Area | Connector | What the owner needs to do |
|---|---|---|
| Accounting | QuickBooks (`qbo`) | Sandbox: §1 P3. Production: Intuit's app review and security questionnaire, production keys. 13 doc checks and 8 sandbox checks in `NOTES.md`. |
| Email | Gmail (`gmail`, send only) | Google verification (S4). |
| Email | Resend (`resend`) | Account, `RESEND_API_KEY`, fallback sending domain (§1 P2). |
| Email | Outlook (`outlook`, send only) | Entra app, publisher verification, `OUTLOOK_CLIENT_ID`/`SECRET`. |
| Texts and calls | Twilio (`twilio`) | Account and keys; per-client subaccounts (default) or the client's own; which countries first; run a US client's A2P registration (M41) against the real Trust Hub. |
| Texts and calls | WhatsApp through Meta (`whatsapp_meta`) | Meta app, register as a Tech Provider, `META_*` secrets. |
| Texts and calls | ElevenLabs (`elevenlabs`) | Account, `ELEVENLABS_API_KEY`, webhook secret. |
| Texts and calls | All three | **Legal review** of consent, calling hours, recording consent and AI disclosure per country, before any live client call or text. |
| Access | Code service (`apps/mfa`) | Confirm the domains; Email Routing for `agents.staging.mezonas.com`; the codes Twilio subaccount; then turn email codes on (`apps/mfa/NOTES.md`). |
| Access | Browser logins (`browser`) | Turn on Browser Run; then merge the `BROWSER` binding PR (`claude/browser-binding`, jammil-alt/countersign#55); the first real low-tier site; legal review of agent accounts. |
| Finance | Plaid (`bankfeed`) | §1b above (K1–K3): keys, sandbox checks, production review and OAuth banks; price per bank; BAA (until then not offered to HIPAA clients). Several banks per client is built. |
| Finance | Ramp (`ramp`) | Developer app, `RAMP_*`. |
| Finance | BILL (`billcom`, plan §1.87) | A BILL developer key, sandbox first (`BILL_DEV_KEY`; `docs/operations.md`), a dedicated BILL user's login entered by the client admin, then `NOTES.md`'s "To verify"; production after BILL's review. Decide: which BILL role our user gets; whether BILL goes on the site's subprocessors page (it is a processor, as Plaid is); BILL's BAA (until then not offered to HIPAA clients). **Code still needed for payments:** `billcom.payment.create` is defined, off and refused until BILL's MFA-trusted session can be reached through the code service (`apps/mfa`). |
| Finance | Stripe (billing) | Account and keys; the open prices (§4). |
| CRM | HubSpot, Zoho CRM, Podio | A developer app each (`HUBSPOT_*`, `ZOHO_*`, `PODIO_*`). |
| Google | Drive, Sheets | `drive.file` on the consent screen (with S4); `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER`. |
| Google | Chat (`gchat`) | Chat app, service account, `GOOGLE_CHAT_*`. |
| Chat | Slack (`slack`) | Slack app, `SLACK_*`; its timing. |
| Marketing | Search Console, Bing, Website, LinkedIn, Hacker News | §2 (S6, S7, S10, S12). Hacker News needs nothing but a check of its "To verify". |
| Other | Webhooks (Zapier) | Works today; the published Zapier app is later (`webhook/NOTES.md`). |

## 4. Everything else

### Production's first release

No `v*` tag yet. Before it: `app.mezonas.com` free in DNS, WorkOS production (redirect and sign-out
URIs, MFA, session limits), production secrets, Email Routing for `in.mezonas.com`, the platform
seed's templates installed by hand on production, and the Mezonas client created there. D2 (§2) may
bring this forward.

### The phone app (owner, 2026-11-13; `docs/plan.md` §1.97, `apps/mobile/README.md`)

Built and tested against fakes; nothing has run on a phone or against Expo yet. To test it:

| # | Step | Notes |
|---|---|---|
| M1 | **Merge migration 0048 first** (its own PR), let it reach staging, then the app's PR. | 0048 adds `person_device` and widens the notification channel check; the previous Worker keeps working. |
| M2 | **An Expo account**, then in `apps/mobile`: `npx eas-cli login`, `npx eas-cli init` (makes the project; put its id in `EAS_PROJECT_ID` for builds, or in `app.config.ts`'s env). | Push tokens need the project id; without it the app skips notifications and still signs. |
| M3 | **iPhone**: the Apple Developer Program (organisation account, $99 a year, D-U-N-S for Twelve Thirty-Four), then `npx eas-cli build --profile development --platform ios` and let EAS make the certificates and the push key (APNs). Register your phone with `npx eas-cli device:create` first. | Bundle id `com.mezonas.app`. Approving the developer account can take a day or more: start it first. |
| M4 | **Android**: `npx eas-cli build --profile development --platform android` installs from a link. For push, a Firebase project and its FCM v1 service-account key uploaded with `npx eas-cli credentials`. The Play Console ($25 once) only for the store. | Package `com.mezonas.app`. |
| M5 | **Try it on staging**: sign in from the app (WorkOS in the system browser), set up the phone (notifications, Face ID), make a Desk item on the Sandbox (any approval), and check: the notification arrives within 5 minutes with a count only, tapping opens the Desk, signing asks for Face ID, the audit log has `inbox.device_signed`, Undo works within 60 seconds, removing the phone in Settings stops its notifications. | Nothing in WorkOS changes: the sign-in returns to `/api/mobile/handoff` on our own origin. |
| M6 | Later: Expo's **enhanced push security** on, and `EXPO_ACCESS_TOKEN` as a Worker secret (a small `deploy.yml` PR). | Until then anyone holding a phone's token could send it a notification through Expo. |
| M7 | Owner decisions: a longer session for an unlocked registered phone (today 30 idle minutes, as the browser); whether operators get the app; the store listing (name, screenshots, privacy answers); TestFlight testers. | `docs/plan.md` §1.97 "Not in this pass". |

### Sign-in codes and the Claude connector (owner, 2026-11-10)

| # | Step | Notes |
|---|---|---|
| A1 | **Now: WorkOS multi-factor set to optional** on staging and production (WorkOS dashboard → the environment → Authentication → Multi-factor auth). | Owner's call, 2026-11-10: a code on every sign-in is too much for now. HIPAA today requires "person or entity authentication", not multi-factor; the proposed rule that would require it is not final (projected July 2027). Until A2 ships, sign-in is the password (or Google) alone, operators included. **No HIPAA client signs in before A2.** `docs/operations.md` and `docs/security.md` still describe multi-factor as required: that is the target, restored by A2. |
| A2 | **Next: our own second step (`docs/plan.md` §1.83) with "remember this browser for 30 days"**, then multi-factor back on. | Code (sign-in PR after migration 0042). Needs Twilio Verify (`TWILIO_VERIFY_SERVICE_SID`). After it ships and one sign-in is checked: WorkOS's own multi-factor stays off (ours replaces it, so nobody is asked twice). |
| A3 | **WorkOS production: Dynamic Client Registration and Client ID Metadata Documents on** (Applications → Configuration), as on staging. | Without it, connecting Claude to `https://app.mezonas.com/mcp` stops at "application not found" (`docs/operations.md`, "MCP server"). Check: `curl https://app.mezonas.com/.well-known/oauth-authorization-server` lists `registration_endpoint`. |

### Owner decisions still open (`docs/plan.md` §7 and the sections named)

- **Billing**: the credit allowance per agent, whether allowances pool across a client's agents
  (built pooled), the prices; whether a client agent's own test runs and paused days are billed
  (§1.24, §1.32); whether trial and sign-off days are billed (§7 item 8e).
- **Before Wave 2 confirmations** (§7 item 8): Sloan's name and the merge from "Account check"; the
  agent address form; client test cases never gating shared skills; who sets "on its own".
- **Smaller defaults** (§7 item 10): the 60 s undo window, US federal holidays only, notification
  texts only from the client's own number, replay as a test run in the same client.

### The process model's urgent notices (code; `docs/plan.md` §1.86, runtime wave 2c)

- An urgent notice's person is told at once by email and text from the notify step itself
  (`apps/api/src/notify/urgent.ts`), not through the `notification` outbox, so those sends have no
  `notification` row (no retries after a failed send, no line in the notification counts; a failed
  send is reported and the card waits for the items-waiting pass). Making it an outbox kind of its
  own (`urgent`, never held for quiet hours) needs a migration of `notification_kind_check`; do it
  in its own PR, then send from the outbox.

### Language and legal

- A **fluent speaker's review** of the five translations (Spanish, French, Portuguese, Italian,
  German): the portal's message files, `TIMELINE_WORDS`, the language instruction in `runAgent`, and
  every pass since (§1.18, §1.27 invite strings, the Requests screens).
- **Legal**: the site's terms and privacy (S3), measurement wording (S8), processor terms (S13),
  calls and texts, agent accounts on third-party sites.

### HIPAA, SOC 2 and PCI (`docs/hipaa-plan.md`)

- Technical: **T1** (the Ops MCP connector doesn't check HIPAA mode) and **T2** (the Builder's model
  calls) are small code changes worth doing before a HIPAA client; T3 (clients' own audit log page)
  next; T4–T10 are notes or later.
- Administrative: a security officer, the risk analysis, policies, training, sanctions, the client
  BAA and DPA, vendor BAAs, whether to use a compliance tool and when to start SOC 2's Type II period.

### Docs housekeeping

- `docs/ARCHITECTURE.md` is still v0.15: the Marketing area's v0.16 changes are listed in
  `docs/marketing-plan.md` §9, and the Bookkeeping area's in `docs/plan.md` §1.79; neither is
  written into it yet.
- `docs/hipaa-plan.md` §1 ("Merge the code") lists PRs that were merged long ago.

## Suggested order

1. **This week, purchasing and bookkeeping:** P1–P4 and K1–K2, then §1.2 on the Sandbox with the QuickBooks sandbox; answer
   the four §1.3 decisions as the test shows them. In parallel, start S6 (Search Console collects
   from the day it is verified).
2. **Next, the site:** S1–S4, then S5 and S7; S8–S11 once the lawyer has read the drafts.
3. **Then providers in the order clients need them:** Resend or Gmail (already done by then),
   Twilio and the legal review, Stripe with the billing decisions, then the rest of §3.
