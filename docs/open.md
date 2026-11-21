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
- **Templates to production** (owner, 2026-11-16): planned in `docs/plan.md` §1.118, not built. Only
  a template's tested set-up moves from staging to production, never client agents or their data.
- **Unmerged work:** on 2026-11-15, 11 branches of finished work had never reached `main`, most
  with no PR. What they hold and the order to merge them: `docs/merge-backlog.md`.
- Production is live from a hand-run deploy of `747d7ff`
  (2026-11-09, migrations through 0041) but has had no `v*` tag; its next release is an upgrade.
- Almost everything below is **a setup step, a key or a decision for the owner**, not code. Where
  code is still needed, it says so.

## 0. Enterprise readiness (2026-11-15)

The owner's list for the first enterprise and high-volume pilots, checked against the code, with
its gaps (E1–E16) and the open question of which accounting system they use:
`docs/enterprise-readiness.md`.

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
| P5 | **The real-mail check**, once P1 is done and before production's release: the checklist in `packages/connectors/src/upload/NOTES.md` on `in.staging.mezonas.com` (a genuine message, a forged top header, a spoofed envelope, a Microsoft 365 sender, an out-of-office then the real quote). | `docs/plan.md` §1.129 | Inbound mail trusts only Cloudflare's own `mx.cloudflare.net` verdict. If Cloudflare doesn't write it on top, genuine mail fails closed: forwarded invoices are refused and vendors' replies are kept as unverified. |

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

- A vendor's reply **from a colleague's address** is dropped. One that comes **after** the reach-out
  ended, or from the vendor's address but not proven, is kept on the thread without answering
  the reach-out (§1.129). Either way a person enters it (§1.65, §1.71).
- **More lines are held for a person** since the pack-size fix (`docs/plan.md` §1.144): a line
  with no clear pack size and no SKU gets no automatic match. Price observations filed wrongly
  before that fix stay as they are; nothing re-files them.
- **Before the first purchasing client: a staging run with real invoices.** The fakes and the
  goldens don't cover how real vendors word their packs.
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
its payout statement, signed off on a card).

**Bookkeeping stays off for clients** (PR #401, `docs/plan.md` §1.145). Two paths can still write
the same money twice. Neither is new: before #401 every re-send wrote both copies.

1. **Two signatures.** The earlier copy's write was already laid out for a signature when the bank
   sent the transaction again, and a person then also approves the new copy. Closing it needs a
   check right before each write: a template change after v4.
2. **Unrecorded deposits and transfers.** A deposit or transfer written but never recorded (the run
   stopped after the write). These don't sync back from QuickBooks, so the guard can't see them.

Code, before any client's Bookkeeping is switched on. Then, to go live:

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

## 1c. Sloan and Reggie by email and text (`docs/plan.md` §1.150)

Sloan is built: each client's people email `sloan.<client>-<id>@in.<env>.mezonas.com` and text the
account's number, and the answer comes back the same way. To use it on staging: Email Routing for
the forwarding domain (§1 P1), Resend for the answers (§1 P2), and for texts the client's Twilio
number with its texting registration approved and the person signed up for texts. Open for the
owner: whether Sloan may pause a service on a text (Twilio doesn't prove the sender). **Reggie** by
email and text is planned (§1.150), its own PR: it needs Mezonas' own number and campaign.

## 1d. An agent's own phone line, $10 a month (`docs/plan.md` §1.160)

Built (migration 0069 in its own PR, then the feature): a client admin asks for a number of an
agent's own from the agent's card or the Channels page; we buy one on the client's Messaging page
and pick the agent in the number's "Whose number" list. The agent then texts and calls from it,
texts to it go to that agent only (never Sloan), and each active day is billed at the line price.
To use it on staging: the client's Twilio subaccount, two numbers (the account keeps one), and the
line price on `/ops/billing` if not $10. Retiring an agent gives its line back to the account
(Messaging marks it Spare until it's given to another agent or released). Open for the owner:
whether the account's own number should be billed too, and the five non-English portal strings'
review. Built since: retiring a client releases its numbers and closes its Twilio subaccount within
the hour, and Messaging registers a client's numbers for signed calls (SHAKEN/STIR) and its caller
name (CNAM) once its texting registration's business profile is approved. Open: the by-hand checks
against a real subaccount (`packages/connectors/src/twilio/NOTES.md`, "Calls that carry the
client's name"), before the first client's calls.

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
| Accounting | QuickBooks (`qbo`) | Sandbox: §1 P3. Production: Intuit's app review and security questionnaire, production keys. 13 doc checks and 8 sandbox checks in `NOTES.md`. Known risk: after a long gap, deletions of an entity with 1,000 or more changes since the last sync can be missed (CDC cuts them off and queries can't see them); the sync reports "qbo CDC cap: deletions may be missed" when it happens. |
| Email | Gmail (`gmail`, send only) | Google verification (S4). |
| Email | Resend (`resend`) | Account, `RESEND_API_KEY`, fallback sending domain (§1 P2). |
| Email | Outlook (`outlook`, send only) | Entra app, publisher verification, `OUTLOOK_CLIENT_ID`/`SECRET`. |
| Microsoft | OneDrive (`onedrive`), Excel (`excel`), Outlook Calendar (`outlook_calendar`) | An Entra app each (`ONEDRIVE_CLIENT_*`, `EXCEL_CLIENT_*`, `OUTLOOK_CALENDAR_CLIENT_*`; `docs/operations.md`), publisher verification (the same Partner Network id as Outlook), `deploy.yml` to copy the secrets (its own PR), then each `NOTES.md`'s "To verify" with a work and a personal account. First checks: whether `Files.ReadWrite.AppFolder` works for work accounts (OneDrive), and whether Graph honours Excel's quote prefix (Excel). SharePoint is not built (plan §1.114). |
| Microsoft | Teams (`teams`) | An Azure Bot (single tenant) with its Entra app and secret (`TEAMS_BOT_*`), the messaging endpoint `https://<api host>/api/hooks/teams`, the Teams app package (manifest in `teams/NOTES.md`) uploaded per client or published to the Teams Store. First check: that a single-tenant bot can be installed and post in another organisation's Teams. |
| Google | Calendar (`gcal`) | `calendar.events.owned` on the "Mezonas web" consent screen (a sensitive scope: part of Google's verification, S4), the redirect URIs; then `gcal/NOTES.md`'s "To verify" (Google's docs couldn't be read while building). |
| Texts and calls | Twilio (`twilio`) | Account and keys; per-client subaccounts (default) or the client's own; which countries first; run a US client's A2P registration (M41) against the real Trust Hub. |
| Texts and calls | WhatsApp through Meta (`whatsapp_meta`) | Meta app, register as a Tech Provider, `META_*` secrets. |
| Texts and calls | ElevenLabs (`elevenlabs`) | Account, `ELEVENLABS_API_KEY`, webhook secret. |
| Texts and calls | All three | **Legal review** of consent, calling hours, recording consent and AI disclosure per country, before any live client call or text. In it, counsel checks the **relationship basis** (`docs/plan.md` §1.97), now for calls (an automated assistant, an artificial voice under the TCPA) and email only, and the **texting sign-up** that replaced it for texts (§1.98): the words beside the box, the invitation email, the confirmation text and the 10DLC opt-in, against the TCPA and the CTIA's messaging principles. |
| Access | Code service (`apps/mfa`) | Confirm the domains; Email Routing for `agents.staging.mezonas.com`; the codes Twilio subaccount; then turn email codes on (`apps/mfa/NOTES.md`). |
| Access | Browser logins (`browser`) | Turn on Browser Run; then merge the `BROWSER` binding PR (`claude/browser-binding`, jammil-alt/countersign#55); the first real low-tier site; legal review of agent accounts. |
| Finance | Plaid (`bankfeed`) | §1b above (K1–K3): keys, sandbox checks, production review and OAuth banks; price per bank; BAA (until then not offered to HIPAA clients). Several banks per client is built. |
| Finance | Ramp (`ramp`) | Developer app, `RAMP_*`. |
| Finance | BILL (`billcom`, plan §1.87) | A BILL developer key, sandbox first (`BILL_DEV_KEY`; `docs/operations.md`), a dedicated BILL user's login entered by the client admin, then `NOTES.md`'s "To verify"; production after BILL's review. Decide: which BILL role our user gets; whether BILL goes on the site's subprocessors page (it is a processor, as Plaid is); BILL's BAA (until then not offered to HIPAA clients). **Code still needed for payments:** `billcom.payment.create` is defined, off and refused until BILL's MFA-trusted session can be reached through the code service (`apps/mfa`). |
| ERP | Odoo (`odoo`, plan §1.113) | Nothing for the deployment. An Odoo 17 trial database on the Custom plan (Odoo Online answers the external API only there, unchecked), then `NOTES.md`'s "To verify". Per client: they make an internal Odoo user for us with the smallest rights and an API key, and enter both in the portal; tell clients on Odoo Online's cheaper plans that the API isn't available to them. |
| Finance | Stripe (billing) | Account and keys; the open prices (§4). |
| CRM | Zoho CRM (`zoho_crm`) | API console client and the CRM Developer Edition test org made (2026-11-12, `zoho_crm/NOTES.md` "Live setup"). Next: `ZOHO_CLIENT_ID` and `ZOHO_CLIENT_SECRET` in both GitHub environments, then the first connection to the test org and `NOTES.md`'s unchecked list. |
| CRM | HubSpot, Podio | A developer app each (`HUBSPOT_*`, `PODIO_*`). |
| Zoho | Books, Inventory, Expense | Test org "Mezonas Test" set up (2026-11-12; trials end about 2026-11-26, then free plans). **No connector built, and none planned yet**: outside v1 scope until the owner picks one. |
| Google | Drive, Sheets | `drive.file` on the consent screen (with S4); `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER`. |
| Google | Chat (`gchat`) | Chat app, service account, `GOOGLE_CHAT_*`. |
| Chat | Slack (`slack`) | Slack app, `SLACK_*`; its timing. |
| Marketing | Search Console, Bing, Website, LinkedIn, Hacker News | §2 (S6, S7, S10, S12). Hacker News needs nothing but a check of its "To verify". |
| Other | Webhooks (Zapier) | Works today; the published Zapier app is later (`webhook/NOTES.md`). |

## 4. Everything else

### Back office work: Sales, onboarding and Build (merged 2026-11-17; onboarding O1–O3 merged)

One to-do list (Your call), Sales (new accounts and expansion), onboarding and Build (issues, agent
builds and enhancements in one work order), with Reggie doing most of the work. Build, Sales, Your
call and Reggie with Autopilot are built and merged on 2026-11-17 in two PRs: the migrations
(0060–0063, PR #380) and the code on top of it (PR #383). Decisions: `docs/plan.md` §1.124 (M64–M68); what
each stream left open is in its "Not yet" row in §1.124.1–§1.124.4.

Onboarding's first part (steps O1–O3, `docs/plan.md` §1.149, M69, migration 0066) is built on
top of it and merged on 2026-11-17 (the migration, PR #417, then the code, PR #406): a client file of what we know about each prospect and
client; **Invite** from the lead record (a general, area or agents intake, filled from the file's
`theirs` facts) and **Sign up now** from a saved start, both logged as a deal at the right stage
(stages are a record, every account is in Sales); the branded invite from the lead at `hello@`
and the welcome page with sign-in by the invited address; **Getting started** in the portal (get to
the point: cards, "We think", Connect, Ask someone else, Different process in mind?); the build's
Requirements request reading its card. All against fakes. What it still needs:

- Code, next wave (`docs/cases-plan.md` §7): talk it through with Sloan (O4); the scope, signing,
  facts into the knowledge base and builds into fit-gap (O5); Reggie filing facts and suggesting
  what to cover; reminders and the remaining emails; voice (O6).
- Code, smaller: delivered and bounced from Resend's webhooks; "Just the account" still sends
  WorkOS's own invitation rather than a branded welcome-only email; a client file's documents (no
  storage yet); pack and template questions shown in English; the retention job for lost
  prospects; a "send it again" for an invite that didn't go (today it leaves the lead a to-do).
  The full list: `docs/plan.md` §1.149.5 and §1.149.6.
- The owner's call: whether the deal page's old "Set up the account" card stays now that Invite
  does the set-up.

The plan, its steps (B1–O6) and the owner's open questions: `docs/cases-plan.md`. The screens:
`docs/design/pipelines.html` and `docs/design/workflows.html` (onboarding not drawn yet).

Owner steps for onboarding's emails and sign-in (O1, `docs/plan.md` §1.149; how-to in
`docs/operations.md`, Resend under "Worker secrets" and WorkOS under "By hand"):

- **Resend**: verify `mezonas.com` (SPF, DKIM, DMARC) and send from `hello@mezonas.com` in
  production (`RESEND_FALLBACK_DOMAIN`); a mailbox or routing rule for `hello@`. Next to P2.
- **WorkOS**: Google and Microsoft sign-in switched on, Mezonas' logo and colours on the hosted
  sign-in and its code emails, `auth.mezonas.com` if the plan allows; then try a test invite to a
  real inbox on staging and check what `packages/auth/NOTES.md` lists, first whether a new address
  can sign up without a WorkOS invitation.

### The Dev queue (built 2026-11-17, `docs/plan.md` §1.125)

- **Owner:** create the daily scheduled task from `docs/operations.md` ("The Dev queue's daily
  task"); until then requests are built only when a session is asked.
- The seed requests from the AR aging and management report builds are filed on staging through the
  MCP tools once the Dev queue is deployed: date offsets and division in Reshape data, sort and
  top-N in "Filter, group and total a list", QuickBooks customer parent and is-job (answer first in
  the QuickBooks sandbox: `packages/connectors/src/qbo/NOTES.md`), and the P&L, balance sheet and
  AP aging reports.
- "In production" is stamped by production's own copy of a request; a request filed on staging
  shows it only after a cross-environment read, which isn't built.

### Area owners, owner chat and Home (designed 2026-11-12)

ARCHITECTURE v0.19 §10.15, `docs/plan.md` §1.117 and §10 (O1–O8). Built on
`claude/clever-allen-i6npwp` and brought onto main in two PRs: the migration on its own, then the
code. What is left of it is listed under §10's status. Waiting on the owner:
- The **name pool** (40 short names, `docs/plan.md` §1.117).
- The **public site** still calls Sloan "your manager agent" ("Every agent has a job, a manager and
  a person who checks its work", `apps/site`): new words for Sloan as the chat.

### Production's first release

Production is **live** (`https://app.mezonas.com/api/health` answers 200): Deploy run 207 put
`747d7ff` (PR #229) there by hand on 2026-11-09, migrations through 0041, and its cron runs every
minute against Neon `main`. No `v*` tag yet, so the first tagged release is an **upgrade** of a
live system (migrations 0042 onward on production; `docs/operations.md`, "The first production
release"). Before it: WorkOS production checked against A1 and A3 below, the production secrets,
Email Routing for `in.mezonas.com`, the platform templates installed by hand, and the Mezonas client.
A second hand-run production deploy (run 210, `5d27cfc`) waited for approval from 2026-11-09 and
was cancelled on 2026-11-14: approve only a deploy of current `main`. D2 (§2) may bring this forward.

Owner, in Sentry (2026-11-14 review): the `mezonas-web` project's GitHub code mapping points at
Plenary Labs' repository, so its suspect commits are Plenary Labs'; point it at
`jammil-alt/countersign` (Settings → Integrations → GitHub → Code mappings). And the staging run
behind MEZONAS-API-1 (an invoice read stuck as running since 2026-11-07) needs cancelling from
the back office.

### Pre-launch hardening: what's left (2026-11-17; `docs/plan.md` §1.126–§1.147)

PRs #384–#414 closed the launch audit's findings for the first clients. What they left open:

| # | What | Kind | Notes |
|---|---|---|---|
| H1 | **Live checks on staging**: one run each of a conversation step, an agent-chosen path, an agent-judged repeat, an oversight review of a failed step and an AI second check, on the default models. | Owner, after merge | §1.149. The fake model now refuses what the API refuses, but nothing has run these on the live models. |
| H2 | **The real-mail check** (§1 P5). | Owner, gate before production | §1.129. |
| H3 | **GitHub and Hyperdrive settings** from PR #384: caching off on the two existing Hyperdrive configs (`wrangler hyperdrive update <id> --caching-disabled`, or run Bootstrap with `rotate_password` unticked); the `production` environment with required reviewers and deployment limited to `main` and `v*` tags. If `staging` allows only `main` to deploy, allow the branches that quick-deploy (`claude/*`). | Owner, by hand | `production` done (checked 2026-11-18: required reviewer, `main` and `v*` tags, no administrator bypass). Hyperdrive caching and `staging`'s branches not checked. `docs/operations.md`. |
| H4 | **A per-site limit on the beacon** needs a Rate Limiting binding of its own, set well above the per-address limit; on the shared binding one address could empty a site's allowance. | Code and `wrangler.jsonc` | §1.141. Only a per-address limit today. |
| H5 | **Transcription records no usage**: voice typing's model calls have no cost or usage row. | Code | §1.139. They are limited per person (10 a minute, 200 a day). |
| H6 | **"Who is asking" on the Claude approval page**: the Claude client's name and where the request came from. | Migration on `mcp_session_approval`, then code | §1.130. Today the page shows when Claude asked and takes Claude's code. |
| H7 | **The portal's resume screen** doesn't show the events that arrived while an agent was paused (`missedEvents`); the back office's go-live panel does. | Code, copy in six languages | §1.137. |
| H8 | **`refresh_failing` connections** show as connected with an open finding; the ops MCP's `needsAttention` and the daily troubled list count only `status = 'error'`, so they don't list them. LinkedIn's and HubSpot's dead-grant codes come from their docs, not a live call. | Code; check live | §1.134. |
| H9 | **The web app's first load**: load each language's wording on demand, to bring it back under the old 470 kB. | Code | §1.146. 490 kB now; each screen loading only its own routes (audit 4.6) helps too. |
| H10 | **Texting edge cases**: a brand-new number submitted twice at once can hit the contact phone index and get a 500 (as before #411); after an invitation is used up by a skipped submit, the link still shows the form, and submitting it gives 409 `used`. | Code, small | §1.142. |

### The phone app (owner, 2026-11-13; `docs/plan.md` §1.116, `apps/mobile/README.md`)

Merged unfinished on purpose (owner, 2026-11-15), in three PRs: migration 0056, the sign-in
handoff, then the phones, push, signing and `apps/mobile`. Built and tested against fakes; nothing
has run on a phone or against Expo yet. Off until the steps below: no app build exists, and phone
sign-in stays off until `MOBILE_SIGNIN=on` and phone notifications until `MOBILE_PUSH=on`. To finish it:

| # | Step | Notes |
|---|---|---|
| M1 | **Merge migration 0056 first** (its own PR, re-chained after 0055), let it reach staging, then the sign-in PR, then the app's PR. | 0056 adds `person_device` and widens the notification channel check; the previous Worker keeps working. |
| M2 | **An Expo account**, then in `apps/mobile`: `npx eas-cli login`, `npx eas-cli init` (makes the project; put its id in `EAS_PROJECT_ID` for builds, or in `app.config.ts`'s env). | Push tokens need the project id; without it the app skips notifications and still signs. |
| M3 | **iPhone**: the Apple Developer Program (organisation account, $99 a year, D-U-N-S for Twelve Thirty-Four), then `npx eas-cli build --profile development --platform ios` and let EAS make the certificates and the push key (APNs). Register your phone with `npx eas-cli device:create` first. | Bundle id `com.mezonas.app`. Approving the developer account can take a day or more: start it first. |
| M4 | **Android**: `npx eas-cli build --profile development --platform android` installs from a link. For push, a Firebase project: its `google-services.json` as the EAS file variable `GOOGLE_SERVICES_JSON`, and its FCM v1 service-account key uploaded with `npx eas-cli credentials`. Account steps: `apps/mobile/README.md`, "Accounts". The Play Console ($25 once) only for the store. | Package `com.mezonas.app`. |
| M5 | **Try it on staging**: set `MOBILE_SIGNIN=on` and `MOBILE_PUSH=on` on staging's Worker with `wrangler secret put` (a dashboard variable is erased by the next deploy; `deploy.yml` copies neither yet), sign in from the app (WorkOS in the system browser, then the second step's code if it is on there), set up the phone (notifications, Face ID), make a Desk item on the Sandbox (any approval), and check: the notification arrives within 5 minutes with a count only, tapping opens the Desk, signing asks for Face ID, the audit log has `inbox.device_signed`, Undo works within 60 seconds, removing the phone in Settings stops its notifications. | Nothing in WorkOS changes: the sign-in returns to `/api/mobile/handoff` on our own origin. |
| M6 | Expo's **enhanced push security** on, and `MOBILE_PUSH` and `EXPO_ACCESS_TOKEN` copied by `deploy.yml` (a small PR of its own), before production's `MOBILE_PUSH=on`. | Until then anyone holding a phone's token could send it a notification through Expo. |
| M7 | Owner decisions: a longer session for an unlocked registered phone (today 30 idle minutes, as the browser, and the second step's code at each sign-in); whether a remembered browser may let a phone sign-in skip the code (today never); whether operators get the app (today refused at the handoff); (the phone app as a second-step method: built 2026-11-18, A8); the store listing (name, screenshots, privacy answers); TestFlight testers. | `docs/plan.md` §1.116 "Not in this pass". |
| M8 | Before production's `MOBILE_SIGNIN=on`: a page in the browser that asks the person to confirm before the handoff sends the session to the app, and the app's return on a universal link (iOS) and an app link (Android) instead of the `mezonas://` scheme, so only our app can receive the code. | Audit, 2026-11-17. The code is already useless without the app's PKCE verifier. |
| M9 | Signing follow-ups (audit, 2026-11-17): the signature covers the item, the decision, the fingerprint and the time, not a question's answer text or a note; a v2 signed text (`mezonas-sign:v2`) would add them. The time window is ±5 minutes, so a signature dated up to 5 minutes ahead is accepted. | Code. `deviceSignedText` in `packages/core/src/mobile/mobile.ts`. |
| M10 | Decide: whether a release-code card may be resolved from a phone without a signature; whether a phone session may turn human release off (a setting, not a card). Possible, not checked: an admin's phone undoes another person's rejection, then a step set to `ifNoAnswer: proceed` goes on at its deadline. | Owner decisions; the last one needs a test first. |

### The desktop app (owner, 2026-11-17; `docs/plan.md` §1.151, `apps/desktop/README.md`)

The app, core's protocol and the `desktop` connector are merged in one PR, built and tested against
fakes; nothing has run on a Mac or a PC yet, and the API doesn't take computers until D2 and D3. To
finish it:

| # | Step | Notes |
|---|---|---|
| D1 | Owner review of §1.151's decisions (Electron; closed workbooks only; only files added after a folder is given; drive paths only; a long poll). | Each is a `// DECISION` in the code. |
| D2 | **Code, its own PR: the migration.** `desktop_device` (client, connection, name, platform, the public key as a JWK, app version, last seen, `revoked_at`; tenant RLS, never deleted, as `person_device`) and `desktop_job` (client, device, the request, issued and expiry times, the result; RLS). | The previous Worker keeps working: new tables only. |
| D3 | **Code, its own PR: the API.** `POST/DELETE /api/desktop/devices` and `PUT …/folders` (client admin, session, `mount()`), the device's signed routes (`GET /api/desktop/jobs`, `POST …/jobs/:id/result`, `POST /api/desktop/files`; signature, time and key checked, `auditAlone`), `services.desktop` (queue a job, wait for its result), the connector registered in `platform.ts`, files into the documents capability. | Contract tests: no portal route returns the computer's key; a revoked computer's requests are refused. |
| D4 | **A Mac and a PC**: `node apps/desktop/node_modules/electron/install.js`, then `MEZONAS_API_URL=https://staging.mezonas.com pnpm --filter @countersign/desktop start`, with `MOBILE_SIGNIN=on` on staging. Check each item in `packages/connectors/src/desktop/NOTES.md` (Excel's owner file on both, a written workbook opens without repair, OneDrive-synced folders, Mac privacy prompts). | |
| D5 | **Signing certificates**: the Apple Developer ID (the same account as the phone, M3) for signing and notarising; for Windows, Azure Trusted Signing (or an OV certificate). | Without them Mac Gatekeeper and Windows SmartScreen warn on install. |
| D6 | **The update feed**: an R2 bucket of ours behind `downloads.mezonas.com/desktop/`, and a release workflow that builds on macOS and Windows runners and uploads there (its own PR). | |
| D7 | Before production: the handoff's audit row naming the desktop (`app: desktop`), and the same confirm page as M8 (another app could register `mezonas://` on a computer; the code is useless without the app's verifier). | |
| D8 | Next: signing Desk items in the app (Touch ID, Windows Hello), the Office add-in for open workbooks, Word, QuickBooks Desktop (Web Connector), sending files already in a folder, network shares, managed installs. | Owner's order. |

### Builds that work first (B0–B6, owner 2026-11-19; `docs/plan.md` §1.155, `docs/builder-plan.md`)

Built 2026-11-19 with no migration: a try on real examples in the POC, decisions on a build, the
agent manual, the setup checklist, client adjustments and feedback, and governance in three tiers
(ARCHITECTURE v0.20 §10.16). Left:

| # | What | Notes |
|---|---|---|
| G1 | **Run the builds again on staging** (the Nexonia expense agent, invoice intake) and count the operator's actions from New to a running trial. Target: under 15. | `docs/builder-plan.md` §9. Owner, once this is deployed. |
| G2 | **Merge #433** (Agree on "run the tests"; test cases cut off). | Part of B0 in the plan; not in this sprint's branches. |
| G3 | A POC try on **a Sandbox record** (today an uploaded document or a JSON input; a record's id can be given as JSON). A **skill** tried on a document (skill cases run on fixtures only, so the API answers 422). | Code. |
| G4 | Changing a decision's words directly from the Decisions card (today through the conversation, which marks it changed). A custom skill's step counted as writing in the high-risk check (only built-in skills are looked up). | Code. |
| G5 | **Known risks counted from runs** (`ManualKnownRisk.hits` stays empty), and **deleting** a learned note from the manual (shown, read only). | Code. §1.153 already lists the count. |
| G6 | `manual.read` given to every agent: today only when listed (`extraTools` or a skill), because adding it to every step changes every model request and the recorded fixtures. | Code, with new fixtures. |
| G7 | **Governance in the other model calls**: the owner's review, the AI check (confer), path choice, Sloan's and the area owners' chat, the Builder keep their own preambles; only agent and task steps, conversation turns and reach-out messages read the tiers. | Code. |
| G8 | **A run-level pin** of the governance versions read (today recorded per model call in its stored body; no column fits without a migration). The guardrails and standard policies as seeded rows (`builder-plan.md` §8 "Where kept") would need a table. | Migration, its own PR. |
| G9 | The guardrails and standard policies are in English for agents; only "How Mezonas agents work" is translated. A fluent speaker's review of the new portal copy (manual, setup checklist, adjustments, charter) joins the language review below. | Owner. |
| G10 | Setup checklist: the back office can't send a file item for the client; `setup` and `adjust` changes aren't in the back office's change list (who did what is on the checklist and in the manual); the intake form's fields have no guard and the Builder's decisions no parameter (the setting is worked out by code, `settingForDecision`). | Code. Adding fields changes the Builder's answer and its fixtures. |
| G11 | Client adjustments: **marking a step's own parameter** from the builder's step panel (the schema and the API take one; the definition editor marks the agent's skill parameters and schedules); limits on a date; a **setup answer written into the manual** as a change, as an adjustment is. | Code. |
| G12 | Feedback on the manual and requests past the bounds arrive as issues with what they are about on their created event; the **area owner's suggestions** (§10.15) don't read that link yet, so the operator turns them into a change by hand. | Code. |
| G13 | A client user who isn't limited reads "What you can adjust"; only the client admin changes it. Owner to confirm the client user may read it. | Owner decision. |

### Builds, simplified (owner, 2026-11-21; `docs/plan.md` §1.165, `docs/builder-plan.md` §11)

Step 1 is built: an agent described in the lab's New is drafted at once (one model call, a draft
that runs, a client's agent bound to its connections), and a build in intake can skip the
questions. Left:

| # | What | Notes |
|---|---|---|
| S-A | **Owner: the four answers** in `docs/builder-plan.md` §11.5 (one page with three steps; the high-risk check; agree cards for draft edits; where a client build's try runs). | S2 to S5 wait on them. |
| S-B | **Try it on staging**: New → Template → describe it → "Build it", on the Progress updating agent. The works-first rules have run against a scripted model only; the Builder's evals (§1.108) have no case for them yet. | Owner, once merged. Code: an eval case. |
| S-C | A client build's draft is still held by what its connection doesn't allow, and its POC by a test run the build's page can't start. | Code: S2 and S4. |
| S-D | A skill build has no draft-it-now. | Code, if wanted. |

### Sign-in codes and the Claude connector (owner, 2026-11-10)

| # | Step | Notes |
|---|---|---|
| A1 | **WorkOS multi-factor is on** (owner, 2026-11-16): required for every sign-in on staging and production (WorkOS dashboard → the environment → Authentication → Multi-factor auth). The rest of this row is the earlier state. | Owner's call, 2026-11-10 (since reversed): a code on every sign-in is too much for now. HIPAA today requires "person or entity authentication", not multi-factor; the proposed rule that would require it is not final (projected July 2027). Until A2 ships, sign-in is the password (or Google) alone, operators included. **No HIPAA client signs in before A2.** `docs/operations.md` and `docs/security.md` still describe multi-factor as required: that is the target, restored by A2. |
| A2 | **Our own second step (`docs/plan.md` §1.100)**: server, screens (2026-11-14) and the Claude connector's approval link (§1.120, 2026-11-16) built; no code left. To switch on: per environment, a Twilio subaccount for sign-in with a Verify service and a Standard API key (`TWILIO_VERIFY_API_KEY_SID`, `TWILIO_VERIFY_API_KEY_SECRET` in the GitHub environment), then `TWILIO_VERIFY_SERVICE_SID` under its `vars` in `apps/api/wrangler.jsonc` (2026-11-18: subaccounts, services, keys and both service ids done for staging and production; production turns on at its next release), then one sign-in and one Claude connection checked (`docs/operations.md`), then WorkOS multi-factor off for that environment (owner). | Until WorkOS multi-factor is off, a browser sign-in is asked twice once ours is on (WorkOS's code, then ours), and Claude asks for WorkOS's code and then our approval. Owner to confirm: the approval link also applies to clients' Claude connections (§1.120, "Who"). |
| A3 | **WorkOS production: Dynamic Client Registration and Client ID Metadata Documents on** (Applications → Configuration), as on staging. | Without it, connecting Claude to `https://app.mezonas.com/mcp` stops at "application not found" (`docs/operations.md`, "MCP server"). Check: `curl https://app.mezonas.com/.well-known/oauth-authorization-server` lists `registration_endpoint`. |
| A4 | **Staging: finish the switch-over** (owner; codes on since 2026-11-18). Sign in, set up a method (start the setup again for a fresh key: the first key was shared in a chat), save the 10 recovery codes, sign out and in once, approve one Claude connection (`/mcp`), then WorkOS → **Staging** → Multi-factor auth **off**. | `docs/operations.md`, sign-in codes, steps 4 to 6. |
| A5 | **Production: the first `v*` release**, which turns codes on there (and ships everything merged since `747d7ff`, migrations included; "Production's first release" below). Then the same checks as A4 and WorkOS → **Production** → Multi-factor auth **off**. | Everyone is signed out once and sets up again; WorkOS's enrolments don't carry over. |
| A6 | **WhatsApp codes** (clients only): per environment, a WhatsApp sender of our own (Meta Business verification, a number never on WhatsApp, a Messaging Service) attached to the Verify service, then `"TWILIO_VERIFY_WHATSAPP": "on"` under that environment's `vars` (a one-line PR). Until then WhatsApp isn't offered (PR #436). | `docs/operations.md`, sign-in codes, step 7. Meta's verification is the slow part. |
| A7 | **Check Twilio Verify for real**: every item under "To verify" in `packages/connectors/src/twilio/VERIFY_NOTES.md` (codes, TOTP factors, API-key auth, errors, rate limits), as A4 runs. | Built against an in-memory fake. |
| A8 | **Approving a sign-in on the phone** (`docs/plan.md` §1.154; PRs #429, #431, #432): built and tested against fakes; live only once the app is (M2 to M5 below) and push is on (M6). Then check on staging: a password sign-in offers the phone, the notification arrives, one Face ID, the right number signs in, a wrong number and "It wasn't me" stop it, the browser is remembered if asked. | Nothing tried yet on a real phone, Face ID or a real push. |
| A9 | Phone approval, not built: an email to the person when a request is turned down; a phone approving a Claude connection (§1.120); the desktop app approving (§1.151). Owner to say which, if any. | §1.154, "Not in this pass". |

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

### Automations, repeat and the agent's choice (code; ARCHITECTURE v0.17, `docs/plan.md` §1.99)

- Built 2026-11-14 on `claude/laughing-babbage-vyfvog`: M58 (the words back), M59 (`repeat`), M60
  (migration 0048, a commit of its own for its own PR), M61 (the agent chooses a path and says when
  a `repeat` is done). Open: the RFQ, QuickBooks and buyer examples on staging once those
  connectors are live, with their recorded model fixtures.
- Owner decisions open: whether the portal shows the agent's reason for a choice; `between` in
  business hours; more than 10 passes.

### Approvals bound to what was seen (code; audit 3.4, 2026-11-17)

- The portal and the phone send the fingerprint of the card as shown, and the API refuses an
  answer to a card that changed since (409 `changed`). Open: the back office's own resolve
  (`/api/ops/inbox/:id/resolve`) and the operator's step-in don't check one yet.

### Language and legal

- A **fluent speaker's review** of the five translations (Spanish, French, Portuguese, Italian,
  German): the portal's message files, `TIMELINE_WORDS`, the language instruction in `runAgent`, and
  every pass since (§1.18, §1.27 invite strings, the Requests screens), and the pre-launch
  hardening's new copy (`docs/plan.md` §1.126–§1.145: the two approval reasons of §1.133 first).
- **Legal**: the site's terms and privacy (S3), measurement wording (S8), processor terms (S13),
  calls and texts (the relationship basis for calls and email, §1.97, and the texting sign-up,
  §1.98, under the TCPA and CTIA), agent accounts on third-party sites.

### HIPAA, SOC 2 and PCI (`docs/hipaa-plan.md`)

- Technical: **T1** (the MCP server doesn't check HIPAA mode) is a small code change worth doing
  before a HIPAA client. **T2** is done: every model call outside a run,
  the Builder's included, goes through one entry point held to the clients' HIPAA mode
  (`docs/plan.md` §1.143). T3 (clients' own audit log page) next; T4–T10 are notes or later.
- **Before any BAA is recorded** (PR #414): check that `BAA_PROCESSORS` is empty on production and
  staging, a dashboard value included; run `select id, name from tenant where
  (settings->'compliance'->>'hipaa')::boolean` and expect no rows. Once a served client is in HIPAA
  mode without a BAA covering the model vendor, Reggie and questions across clients are refused for
  every operator who serves it, as are that client's Builder and builds (§1.143).
- **Before the first purge of a retired client:** time `purgePlan` and one test purge on a Neon
  branch of production (§1.143).
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
