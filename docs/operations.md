# Operations

How Mezonas is deployed and what a person has to create by hand. It follows the same setup
patterns as Plenary Labs (Cloudflare Workers + Workflows, Neon through Hyperdrive, R2, WorkOS, GitHub
Actions) but shares nothing with it: its own Neon project, Workers, buckets, WorkOS application, keys
and secrets.

Status: **nothing is provisioned yet.** Next: add the bootstrap keys (§1), run Actions → Bootstrap
cloud, save `NEON_PROJECT_ID`. Until then CI and deploy skip their Neon and deploy steps with a notice.

## Environments

Mezonas is the product name and the name of every public resource; `countersign` stays the code name
(repo, packages, database, roles). The domains are on the **mezonas.com** zone, already in Cloudflare.

| | Staging | Production |
|---|---|---|
| Deployed by | every push to `main` (`deploy.yml`) | a `v*` tag, or Actions → Deploy → production |
| Address | `https://staging.mezonas.com` | `https://app.mezonas.com` |
| Worker | `mezonas-staging` (`wrangler deploy --env=staging`) | `mezonas` (`--env=production`) |
| Neon project / branch | `mezonas` / `staging` | `mezonas` / `main` |
| Hyperdrive | `mezonas-db-staging` → `staging` as `cs_worker` | `mezonas-db` → `main` as `cs_worker` |
| R2 bucket | `mezonas-staging` | `mezonas` |
| Email forwarding | `in.staging.mezonas.com` | `in.mezonas.com` |
| Code service Worker (apps/mfa) | `mezonas-codes-staging` | `mezonas-codes` |
| Code service address (Twilio's webhooks only) | `https://codes-staging.mezonas.com` | `https://codes.mezonas.com` |
| Agent email (code service) | `agents.staging.mezonas.com` | `agents.mezonas.com` |
| WorkOS | staging environment | production environment |
| MCP server (Claude connector, operators) | `https://staging.mezonas.com/mcp` | `https://app.mezonas.com/mcp` |
| Rate limit namespace (`MCP_RATE_LIMIT`) | `1101` | `1102` |

`apps/api/wrangler.jsonc`'s top level is local development only (dev sign-in) and is never deployed:
`deploy.yml` always passes `--env=staging` or `--env=production`. The custom domains are created by
`wrangler deploy` (`custom_domain: true`); the apex `mezonas.com` and `www.mezonas.com` are the public
site's (see "The public site" below), and other records on the zone (e.g. `datum.mezonas.com`) are
untouched.
App on `app.mezonas.com`, staging on `staging.mezonas.com` (owner, 2026-11-03).

CI never connects to Neon: client data never reaches a CI runner (`docs/plan.md` §1.35). Neon
holds no `ci-run…` branches any more.

## 1. What a person must create

Most of Neon and Cloudflare is created by the **Bootstrap cloud** workflow (`.github/workflows/bootstrap.yml`,
Actions → Bootstrap cloud → Run workflow). A person only provides the keys and does what needs a
dashboard.

### Keys for the bootstrap (GitHub → Settings → Secrets and variables → Actions)

1. **Neon API key** (Neon → account menu → Account settings → API keys, or an organization's API key
   if Mezonas should live in a Neon organization) as the secret `NEON_API_KEY`.
2. **Cloudflare API token** with Hyperdrive edit, Workers R2 Storage edit, Workers Scripts edit,
   Workflows edit and account read, plus Zone · Workers Routes edit and Zone · DNS edit on
   `mezonas.com` (for the custom domains), as the secret `CLOUDFLARE_API_TOKEN`; the account id as the secret
   `CLOUDFLARE_ACCOUNT_ID`. The same token is used by `deploy.yml`.

### What the bootstrap creates (re-runnable; it looks before it creates)

1. The Neon project `mezonas`, Postgres 16, in the region given when running the workflow (the owner
   chose the same region Plenary Labs uses, `aws-us-east-2`, which is the workflow's default),
   unless the `NEON_PROJECT_ID` variable already names one. The API Worker is placed in the same
   region (`placement` in `apps/api/wrangler.jsonc`, docs/plan.md §1.82): move both together.
2. Role `cs_owner` (Neon-managed is fine for the owner) and database `countersign` on `main`; branch
   `staging` from `main`.
3. On each branch, with SQL: `cs_runtime` (NOLOGIN) and `cs_worker` (LOGIN, member of `cs_runtime` only).
   `cs_worker` is never created through Neon's console or API: Neon-managed roles join `neon_superuser`
   and would skip row-level security. Each run gives it a new random password per branch, which exists
   only inside the job and in Hyperdrive.
4. Hyperdrive `mezonas-db` (→ Neon `main` as `cs_worker`) and `mezonas-db-staging` (→ `staging`).
5. R2 buckets `mezonas` and `mezonas-staging`.

After the first run: save the project id from the run summary as the repository **variable**
`NEON_PROJECT_ID`, and the Hyperdrive ids go in `apps/api/wrangler.jsonc` (M0; ids are not secrets).

### By hand

1. **R2 S3 credentials** for signed URLs (Cloudflare → R2 → Manage API tokens, read-only on the
   environment's bucket): Worker secrets `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, plus
   `STORAGE_ENDPOINT` (`https://<account id>.r2.cloudflarestorage.com`) and `STORAGE_BUCKET`. Optional:
   without them the Worker signs its own 5-minute links (`/api/files/:token`, keyed from
   `ENCRYPTION_KEY`) and streams the file from the R2 binding (`apps/api/src/storage.ts`).
2. **Custom domains**: nothing by hand. `wrangler deploy` creates `staging.mezonas.com` and
   `app.mezonas.com` on the `mezonas.com` zone; make sure no existing DNS record uses those names.
3. **Email forwarding** (built: stream D, `apps/api/src/email.ts`). Cloudflare Email Routing has
   **one catch-all per zone**, not one per subdomain (owner, 2026-11-09), and staging and production
   share `mezonas.com`. So:
   - Cloudflare → `mezonas.com` → Email → Email Routing → Subdomains: add `in.staging.mezonas.com`,
     `agents.staging.mezonas.com`, `in.mezonas.com` and `agents.mezonas.com`, letting Cloudflare add
     each one's MX and SPF records. Mail for `mezonas.com` itself is not routed.
   - Routing rules → **Catch-all address** → **Send to a Worker** → `mezonas` (production). Until
     production's first deploy it stays `mezonas-staging`.
   - Staging gets **one custom address rule per address in use** → Send to a Worker →
     `mezonas-staging`: each staging client's forwarding address (the back office shows it) and each
     agent identity's address you test with. Rules match exact addresses only. A staging address
     without a rule reaches production, which doesn't know it and drops it.
   - Each environment's `email()` takes its forwarding domain and its agent domain: mail to
     `AGENT_EMAIL_DOMAIN` is handed to that environment's code service through `CODES`
     (`apps/api/src/mail-route.ts`), the rest is forwarding. The code service needs no rule of its
     own.
   - Every client's address is `<client label>-<26 characters>-<8 characters>@<subdomain>`, made by
     the app, and the Worker drops anything that is not exactly a client's current address.
   - Worker var `EMAIL_FORWARDING_DOMAIN` = that subdomain, in the environment's `vars` in
     `apps/api/wrangler.jsonc` (`in.staging.mezonas.com` / `in.mezonas.com`). Until it is set, the
     portal says forwarding isn't switched on and `email()` drops everything.
   - No binding: inbound mail reaches the Worker's `email()` export without one. (`send_email` is only
     for sending, which v1 doesn't do.)
   - Check: the portal's Connections page shows the client's address; mail from an allowed sender with
     a PDF shows up under Recent documents as "Forwarded"; the Worker logs `forwarded email dropped:
     <reason>` for the rest. Messages over 25 MB are dropped (Email Routing's limit).
4. **The code service** (Access phase 2, `apps/mfa`; ARCHITECTURE §6.9). See the checklist under
   "The code service" below.
5. **WorkOS**: Mezonas' own staging and production environments; redirect URIs
   `https://staging.mezonas.com/api/auth/callback` and `https://app.mezonas.com/api/auth/callback`;
   on each environment's application, a default **Sign-out URI** (`https://staging.mezonas.com/`,
   `https://app.mezonas.com/`), which sign-out sends as `return_to`; without it WorkOS shows
   `app-homepage-url-not-found` after signing out (the old app homepage URL is only a deprecated
   fallback); Worker secrets `WORKOS_CLIENT_ID`,
   `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD` (at least 32 random characters). For the Claude
   connector, each environment's AuthKit domain in `WORKOS_AUTHKIT_DOMAIN` ("MCP server" below).
   For HIPAA, SOC 2 and PCI (`docs/plan.md` §1.35), on both environments: **multi-factor
   authentication required** for email and password sign-ins (Authentication → Features →
   Multi-factor auth), and the AuthKit session no longer than ours (Applications → the app →
   Sessions → Session lifetime: maximum 12 hours, inactivity 30 minutes; access token duration
   stays 5 minutes). Our own cookie enforces both limits anyway, and an idle or expired session
   also ends WorkOS's, so the next sign-in asks for the password and code again.


### The public site (mezonas.com)

`apps/site` (`docs/plan.md` §1.29): the landing page, terms, privacy policy and subprocessors, as
static files on the Worker **`mezonas-site`** (`apps/site/wrangler.jsonc`). The Worker has a little
code (`src/worker.ts`) that runs first only for `/guides`, `/guides/*` and `/sitemap.xml`; with
guides off, as deployed, it hands those to the static files too, so they answer as before.
There is one site for staging and production: `deploy.yml`'s `site` job builds it and runs
`wrangler deploy` on every push to `main` (and on a manual run from `main`), never from a `v*` tag.
It needs only the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the token
already has Workers Scripts edit, Workers Routes edit and DNS edit on `mezonas.com`.

`wrangler deploy` attaches the custom domains `mezonas.com` and `www.mezonas.com` and creates their
DNS records and certificates itself. It cannot attach a name another DNS record already holds, so
the first deploy fails until the parking records are gone.

DNS today (owner, 2026-11-05): DNS for `mezonas.com` is in Cloudflare (nameservers
`coen.ns.cloudflare.com` and `lady.ns.cloudflare.com`); GoDaddy is only the registrar, with no
forwarding. The parked page comes from two proxied apex `A` records in Cloudflare,
`15.197.148.33` and `3.33.130.190`, and `www.mezonas.com` is a `CNAME` to `mezonas.com`.

What the owner does, once:

- [ ] **Delete three records.** Cloudflare → `mezonas.com` → DNS → Records: delete
      `A mezonas.com 15.197.148.33`, `A mezonas.com 3.33.130.190` and `CNAME www → mezonas.com`.
      Nothing else.
- [ ] **Keep everything else**, in particular: the apex `TXT google-site-verification=…` (Search
      Console verification, now verified; removing it unverifies the domain), the `_domainconnect`
      `CNAME`, `staging.mezonas.com` (Worker `mezonas-staging`), `codes-staging` (the code service),
      and the Worker routes `chore-admin`, `chore-tracker`, `datum` and `dev.datum`, which belong to
      other projects and must not be touched. `app.mezonas.com` has no record yet (the production
      app is not deployed).
- [ ] **Deploy.** Merge the deploy PR (`claude/site-deploy`), or, if it is already merged, re-run
      the `site` job of the latest Deploy run on `main` (Actions → Deploy → the run → Re-run failed
      jobs). The custom domains create their own records; they show in DNS as type "Worker".
- [ ] **Check** `https://mezonas.com`, `/terms`, `/privacy`, `/subprocessors` and
      `https://www.mezonas.com`.
- [ ] **Then submit Google's verification.** The site must be live first: Google checks the
      homepage and its privacy policy link on the verified domain. Homepage `https://mezonas.com`,
      privacy policy `https://mezonas.com/privacy`, terms `https://mezonas.com/terms`. Fill in the
      legal pages' placeholders before submitting (`apps/site/README.md`); while any remain, those
      pages say "Draft for legal review".

`www` serves the same pages, each with a canonical link to the apex (a redirect by host in the
Worker would make its code run first for every request). To make `www` a redirect instead
(optional): Cloudflare → `mezonas.com` → Rules → Redirect Rules → template "Redirect from WWW to
root" (301, keep the path); Redirect Rules run before the Worker.

**Measuring and guides are off until the owner turns them on** (`docs/plan.md` §1.72, the "Site:"
rows; `apps/site/README.md`). A merge changes nothing for visitors. Each is a separate step:

- [ ] **Measuring.** After the lawyer has read `docs/marketing/privacy-measurement-draft.md`:
      put the reviewed section into `apps/site/src/pages/privacy.html` (the build refuses to
      measure until `/privacy` drops "This website uses no analytics" and links `/no-measure`);
      set up the Mezonas client's site in the back office (Marketing → Sites) with its goals
      (`hero-talk`, `nav-contact`, `footer-contact`, `contact-email`); add a repository variable
      `MEZONAS_MEASURE_URL` (Settings → Secrets and variables → Actions → Variables) holding
      `https://<collector host>/api/in/marketing/<client id>/<site id>`, staging's host until
      production's first release (`docs/marketing-plan.md` D2); and pass it to the `site` job's
      "Build the site" step in `deploy.yml` (`env: MEZONAS_MEASURE_URL: ${{ vars.MEZONAS_MEASURE_URL }}`;
      a change to the deploy workflow, in its own PR). Unset or empty, the site builds exactly as
      today. The collector's own host (`collect.mezonas.com`, plan F3) is its own PR.
- [ ] **Guides.** Create the R2 bucket `mezonas-site-content`, bind it as `SITE_CONTENT` to
      `apps/api` (which publishes) and to `mezonas-site` (which reads), and set `SITE_GUIDES` to
      `on`: uncomment the two lines in `apps/site/wrangler.jsonc`. Without both, `/guides` is the
      404 page and `/sitemap.xml` the static one. Once guides are live, submit
      `https://mezonas.com/sitemap.xml` in Search Console.

Deploying the Worker's code needs no change to `deploy.yml`: `wrangler deploy` bundles
`src/worker.ts` (from `main` in `wrangler.jsonc`) with the static files, using the same token.

### The code service (Access phase 2)

A Worker of its own (`apps/mfa`) that receives second-factor codes for agents' accounts on other
sites and hands each one, once, to a sign-in in progress. It has its own key, its own Durable Object
storage and its own Twilio subaccount; apps/api reaches it only through the `CODES` service binding.
`deploy.yml` deploys it before apps/api, creates its Durable Objects (migration `v1`) and its custom
domain, and generates `MFA_ENCRYPTION_KEY` once. What a person does, per environment:

- [x] **Confirm the names.** The owner confirmed the domains in the table above (2026-11-09):
      `codes-staging.mezonas.com`, `codes.mezonas.com`, `agents.staging.mezonas.com` and
      `agents.mezonas.com`. Make sure no DNS record already uses them.
- [ ] **Deploy once** (a push to `main` for staging), so the Worker exists before the next steps.
- [ ] **Email Routing for the agent domain.** The agent subdomain (`agents.staging.mezonas.com` /
      `agents.mezonas.com`) is added under Email Routing → Subdomains, and its mail reaches the
      environment's apps/api with the rest of the zone's (one catch-all per zone, "By hand" step 3),
      which hands it to the code service through `CODES` (`AGENT_EMAIL_DOMAIN` in
      `apps/api/wrangler.jsonc`). On staging, each agent address you test with needs its own custom
      rule to `mezonas-staging`. Every identity's address is `agent-<12 characters>@` that
      subdomain; the code service drops anything else, without a bounce.
- [ ] **The codes Twilio subaccount.** In Mezonas' Twilio account, create a subaccount for codes per
      environment (e.g. "Mezonas codes (staging)"), separate from the subaccounts clients text from.
      Put its own Account SID and Auth Token in the GitHub environment as `MFA_TWILIO_ACCOUNT_SID` and
      `MFA_TWILIO_AUTH_TOKEN`, then redeploy. Numbers are bought by the service only when an identity
      needs one (US local numbers, a monthly cost each) and released when the identity is deleted.
      Without these secrets, email and authenticator codes still work; adding a phone answers
      `not_configured`.
- [ ] **Check the assumptions** in `apps/mfa/NOTES.md`, "To verify", with real messages: an email
      from a domain with DMARC to an identity's address should log `email.received` with `spf`,
      `dkim` and `dmarc` all true (Workers logs of the code service); a text to an identity's number
      should log `sms.received`. Logs never contain codes.
- [ ] **Email codes stay off until verified.** `EMAIL_CODES` is `off` in `apps/mfa/wrangler.jsonc`
      for every environment: emailed codes never fill a wait and an email wait answers "email codes
      are off until verified" (texts and authenticator codes work). To turn them on for an
      environment, follow `apps/mfa/NOTES.md`, "Turning email codes on":
      1. a genuine message from a domain with DMARC logs `spf`, `dkim` and `dmarc` all true;
      2. a message sent with a forged `Authentication-Results: mx.cloudflare.net; spf=pass;
         dkim=pass; dmarc=pass header.from=<domain>` header at the top, from a domain that fails
         DMARC for that sender, logs `dmarc` false and fills no wait;
      3. only then set `"EMAIL_CODES": "on"` in that environment's `vars`, in a reviewed PR, and
         note the date and who checked in `docs/plan.md` §1.26. If step 2 passes as authentic,
         leave it off.
- Nothing else by hand: there is no database, bucket or Hyperdrive for the code service, and
  `MFA_ENCRYPTION_KEY` is never set by a person. Replacing it would make stored authenticator secrets
  unreadable (rotation is not built yet; `apps/mfa/NOTES.md`).

### Browser logins (Access phase 3)

Agents sign in to websites with no API as a client's agent account, on Cloudflare Browser Run, signed
in by our code (docs/plan.md §1.26). The code is deployed with apps/api; what a person does:

- [ ] **Turn on Browser Run** for the Cloudflare account (Workers & Pages → Browser Rendering; it
      needs the Workers Paid plan). Check its limits for the account: concurrent browsers, browsers
      per minute, and that `guardrails` (allowed domains) and `recording: false` are accepted.
- [ ] **Merge the binding PR** (`claude/browser-binding`) only after that: it adds `"browser":
      {"binding": "BROWSER"}` to `apps/api/wrangler.jsonc`, and a deploy with the binding fails on an
      account without Browser Run. Without the binding, website logins show "Not available yet" and
      agents' browser tools are refused.
- [ ] **Add the first real site** in the back office (Websites → Add a site), after checking its
      terms allow automated access; write who checked and when in the notes. Pick a low-tier site
      (supplier portal, price list, invoice downloads) and allow only the pages the pilot reads, e.g.
      `https://portal.example.com/invoices*`. Emailed codes are off until the code service's email
      check is done (above), so start with a site that sends codes by text, uses an authenticator
      app or has no second factor, or do that check first. Fill in the selectors from the site's
      login page (browser developer tools) and set `signedIn` to something only a signed-in page has.
- [ ] **Offer it to the pilot client** (the client's Connections settings: offer "Website logins").
      The client admin sets the login up on Access: confirms the account is theirs and the terms
      allow it, makes the agent's account on the site with the shown address (and number), with the
      smallest role, then enters its username and password. Bind the agent as `browser:<slug>` on its
      Operation panel and give it a read-only grant.
- [ ] **Watch the first runs**: the connection's log has a `browser_session` line per call (pages,
      screenshots, signed out); a CAPTCHA, an unusual page or two failed sign-ins stop the login and
      put an item in your inbox and the client admin's. Re-entering the login on Access starts it
      again.

### Intuit (QuickBooks Online, from M9)

Done by the owner (2026-11-05):

- Intuit developer app **"Mezonas"**, development keys (sandbox companies only).
- Scope `com.intuit.quickbooks.accounting` only.
- Redirect URIs `https://staging.mezonas.com/api/connections/qbo/callback` and
  `http://localhost:8787/api/connections/qbo/callback`. That route (the same forwarder Gmail uses)
  passes Intuit's parameters to the portal page `/connections/qbo/callback`, which finishes the
  sign-in in the client admin's session.
- The operator's own sign-in to the Sandbox client (plan §1.5, to connect the sandbox company above)
  uses the same redirect URIs: the forwarder sends a signed back-office state to
  `/ops/connections/qbo/callback`. No new redirect URI is needed at Intuit, Google, Zoho, Podio, Ramp or HubSpot.
- Webhook endpoint `https://staging.mezonas.com/api/connections/qbo/webhook`, subscribed to Account,
  Bill, Item, Purchase and Vendor. Intuit has no webhook for Attachable: attachments arrive by CDC
  (every 15 minutes, and on any webhook).
- Sandbox company: realm `9341458640918607` (QBO Plus, US).
- GitHub staging secrets `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_WEBHOOK_VERIFIER`.

Still to do:

1. `deploy.yml` copies the three secrets into the Worker when set (#70). QuickBooks also needs
   `OAUTH_STATE_SECRET` and `ENCRYPTION_KEY`, which staging has. Until the client id and secret are
   set, the portal shows QuickBooks as "not available yet"; without the verifier the webhook answers
   503.
2. `QBO_ENV` is a var in `wrangler.jsonc`: `sandbox` locally and on staging, `production` in
   production. There is no `QBO_REDIRECT_URI`: the redirect URI is `APP_ORIGIN` +
   `/api/connections/qbo/callback`.
3. The sync runs as its own Workflow, `QboSyncWorkflow` (binding `QBO_SYNC`; `mezonas-staging-qbo-sync`
   on staging). Wrangler creates it on the next deploy; nothing to do by hand.
4. Offer QuickBooks to the Sandbox client in the back office, sign in from its portal with the
   sandbox company, and walk the "against the sandbox company" list in
   `packages/connectors/src/qbo/NOTES.md`.
5. Production: Intuit's app review for production keys, then the production redirect URI
   `https://app.mezonas.com/api/connections/qbo/callback` and webhook
   `https://app.mezonas.com/api/connections/qbo/webhook`, and the production secrets.
6. **The webhook's verifier token** (docs/plan.md §1.81). Intuit shows one per key set: the
   development keys' on the Development tab, the production keys' on the Production tab
   (Webhooks → "Show verifier token"). Put each in its GitHub environment as the secret
   `QBO_WEBHOOK_VERIFIER` (Settings → Environments → `staging` for the development one,
   `production` for the production one); the next deploy copies it into the Worker. Never put it
   in `wrangler.jsonc`, a commit or a message. Without it the webhook answers 503. Check after a
   deploy: an unsigned POST answers 401 (`curl -sS -X POST <url> -d '{}'`); Intuit's "Send test
   notification", if offered, answers 200 and shows as "qbo webhook received" in the Worker's logs.

### Google (Gmail, send only, M10)

Gmail only sends: an agent emails a contact from a mailbox the client connected, after approval.
Reading mail is done by forwarding (ARCHITECTURE §6.5); we never ask Google for a read scope. What
we couldn't check against Google's docs is in `packages/connectors/src/gmail/NOTES.md`, "To verify".

1. The Google Cloud project `mezonas` with the Gmail API enabled (done, 2026-11-05).
2. The web OAuth client "Mezonas web" with redirect URIs `https://staging.mezonas.com/api/connections/gmail/callback`,
   `https://app.mezonas.com/api/connections/gmail/callback` and
   `http://localhost:8787/api/connections/gmail/callback` (done, 2026-11-05). The Worker sends people
   back to `<APP_ORIGIN>/api/connections/gmail/callback`, which matches these; set the var
   `GOOGLE_REDIRECT_URI` only to use another one.
3. The consent screen's scopes: **`gmail.send`** (sensitive) plus **`openid`** and **`email`**
   (Google's basic sign-in scopes, non-sensitive), which tell us which address connected; Gmail's
   send scope alone can't. Nothing else. The owner is reducing the list to `gmail.send`; add `openid`
   and `.../auth/userinfo.email` beside it. We never ask for `gmail.readonly`, `gmail.labels`,
   `gmail.compose`, `gmail.modify` or any other restricted scope (owner, 2026-11-05: no CASA), and
   the connector refuses a grant that carries one. Asking for any other Gmail scope needs the privacy
   policy changed first (`apps/site`).
4. Worker secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` copied like the other API keys by `deploy.yml`, and
   `OAUTH_STATE_SECRET`, which Zoho and Podio already use. Until all three are set the portal shows
   Gmail as "Not available yet".
5. While the consent screen is in **Testing**: only listed test users can connect, Google shows a
   warning screen, and refresh tokens expire after 7 days, so a test mailbox must be reconnected
   weekly (the connection shows "Needs reconnecting" and the supervisor raises it).

What the owner still needs for Google's verification (standard review for a sensitive scope; no
CASA):
- **The live site.** `https://mezonas.com` (`apps/site`) live on the verified domain, with the
  privacy policy (its Google section and the Limited Use statement) linked from the homepage. The
  site's deploy is its own PR (`claude/site-deploy`, plan §1.29), held until the apex DNS records
  are cleared.
- **Domain verification** in Search Console and the domain on the consent screen's authorized
  domains (done, 2026-11-05).
- **A demo video** (unlisted, on YouTube): the consent screen in English with the client id visible
  in the address bar, a person connecting Gmail from the portal's Connections page, an agent's
  reach-out email waiting for approval in the inbox, approving it, the email arriving from that
  mailbox, the reply coming back through the forwarding address, and disconnecting (which revokes
  the grant).
- **The scope's reason**, for `gmail.send`: "A person at a client business connects their Gmail so
  that agents can send the emails that person's team has approved (for example asking a vendor for a
  missing invoice), from their own address. Each message is shown to a person for approval before it
  is sent. We never read the mailbox; replies reach us only when the client forwards them."
- Then switch the consent screen to "In production" and submit for verification. Refresh tokens
  stop expiring after 7 days once it is in production.

### Google Drive and Outlook (W3-B, M29)

Built against fakes only; what we couldn't check is under "To verify" in
`packages/connectors/src/gdrive/NOTES.md` and `packages/connectors/src/outlook/NOTES.md`. Both are
registered everywhere and show "Not available yet" until their keys are set.

Google Drive uses the same Google project and OAuth client as Gmail ("Mezonas web"):
1. Enable the Google Drive API in the project `mezonas`.
2. Add the scope `https://www.googleapis.com/auth/drive.file` to the consent screen (non-sensitive:
   only the files Mezonas makes).
3. Add the redirect URIs `https://staging.mezonas.com/connections/gdrive/callback`,
   `https://app.mezonas.com/connections/gdrive/callback` and
   `http://localhost:8787/connections/gdrive/callback` to the client.
4. Drive's disconnect drops our tokens without revoking at Google, so it can't end a Gmail
   connection made by the same Google account on the shared client (plan §1.52). To have it revoke,
   give Drive an OAuth client of its own (two more secrets) and turn the revoke back on.

Google Sheets (W4-D) uses the same project and OAuth client, with `drive.file` only (already on
the consent screen for Drive): agents open only the sheets the client picks with Google's Picker.
Built against a fake; what we couldn't check is under "To verify" in
`packages/connectors/src/gsheets/NOTES.md`.
1. Enable the **Google Sheets API** and the **Google Picker API** in the project `mezonas`.
2. Add the redirect URIs `https://staging.mezonas.com/connections/gsheets/callback`,
   `https://app.mezonas.com/connections/gsheets/callback` and
   `http://localhost:8787/connections/gsheets/callback` to "Mezonas web".
3. Add `https://staging.mezonas.com`, `https://app.mezonas.com` and `http://localhost:8787` to the
   client's **Authorized JavaScript origins**: the picking page gets the Picker's token from Google
   Identity Services in the browser.
4. Make a **browser API key** (APIs & Services, Credentials): application restriction "Websites"
   with `https://staging.mezonas.com/*`, `https://app.mezonas.com/*` and `http://localhost:8787/*`;
   API restriction: the Google Picker API only. It is `GOOGLE_PICKER_API_KEY`.
5. The project's **number** (Cloud console, project settings; not the project id) is
   `GOOGLE_PROJECT_NUMBER`: the Picker's app id, so a picked sheet is granted to our client.
6. Set both as secrets of the GitHub environment (`staging` first); `deploy.yml` copies them once
   it is wired. Disconnect drops our tokens without revoking at Google, as Drive.

Outlook needs an Entra app of Mezonas' own:
1. A multi-tenant app registration "Mezonas" (supported accounts: any organizational directory and
   personal Microsoft accounts), web platform, redirect URIs
   `https://staging.mezonas.com/connections/outlook/callback`,
   `https://app.mezonas.com/connections/outlook/callback` and
   `http://localhost:8787/connections/outlook/callback`.
2. Delegated API permissions `Mail.Send`, `openid`, `email`, `offline_access` (remove the default
   `User.Read` if it can be; the connector accepts it but never uses it). No read permission.
3. A client secret (note its expiry, 24 months at most) as the Worker secrets
   `OUTLOOK_CLIENT_ID` (the application id) and `OUTLOOK_CLIENT_SECRET`, copied like the
   others by `deploy.yml` when set.
4. Publisher verification (a Microsoft Partner Network id tied to mezonas.com), so work tenants
   show a verified publisher and allow their users to consent.

### Slack (W4-C)

Built against a fake only; what we couldn't check is under "To verify" in
`packages/connectors/src/slack/NOTES.md`. Registered everywhere; "Not available yet" until its keys
are set. Slack needs an app of Mezonas' own:
1. Make an app "Mezonas" at `api.slack.com/apps` in a Slack workspace of Mezonas' own (from
   scratch, not a manifest with tokens), with the Mezonas mark as its icon.
2. OAuth & Permissions: redirect URLs `https://staging.mezonas.com/connections/slack/callback` and
   `https://app.mezonas.com/connections/slack/callback` (and
   `http://localhost:8787/connections/slack/callback` if Slack accepts it); Bot Token Scopes
   `chat:write` and `channels:read` only (the connector refuses a grant with any other); no User
   Token Scopes; token rotation **off** (the connector refuses expiring tokens).
3. Manage Distribution: turn on public distribution, so clients can install it into their own
   workspaces. Marketplace listing is not needed.
4. Basic Information: the client id and client secret become the Worker secrets `SLACK_CLIENT_ID`
   and `SLACK_CLIENT_SECRET`, copied like the others by `deploy.yml` when set.
5. Leave Event Subscriptions, Interactivity and slash commands off.

### Google Chat (W4-E, plan §1.60)

A Google Chat app of Mezonas' own posts to the spaces a client connects. Built against a fake; what
we couldn't check (Marketplace publishing, each Workspace admin's steps) is in
`packages/connectors/src/gchat/NOTES.md`. Registered everywhere; "Not available yet" until both
secrets are set.
1. In the Google Cloud project (its own, or `mezonas`), enable the **Google Chat API**.
2. A **service account** (e.g. `mezonas-chat`), no roles needed; create a JSON key. Its whole JSON
   is the Worker secret `GOOGLE_CHAT_SERVICE_ACCOUNT` (one secret; it is never logged or shown).
3. The Chat API's **Configuration**: app name "Mezonas", avatar (the design system's mark), a
   description; functionality "Join spaces and group conversations" (1:1 messages can stay on: the
   app only answers there); connection settings **HTTP endpoint URL**
   `https://app.mezonas.com/api/hooks/gchat` (staging: `https://staging.mezonas.com/api/hooks/gchat`,
   on a project of its own or a second app); **Authentication Audience: Project Number**. The
   project number (Cloud console, project info) is the Worker secret `GOOGLE_CHAT_PROJECT_NUMBER`.
   Visibility: Mezonas' own Workspace while testing.
4. Publish the app on the **Google Workspace Marketplace** (the Marketplace SDK in the same
   project: the Chat app integration, listing, privacy policy and terms on mezonas.com, and Google's
   review) so clients' Workspaces can install it.
5. Each client's **Google Workspace admin** allows the Marketplace app for their users (or installs
   it for the domain) and lets users use Chat apps. Then the client admin, in the portal's
   Connections, connects Google Chat, gets a code, adds Mezonas to a space and sends
   `@Mezonas <code>` there.

### WhatsApp through Meta (W4-A, plan §1.57)

A client connects its own WhatsApp Business number from the portal with Meta's Embedded Signup.
Built against a fake Graph API; what we couldn't check is under "To verify" in
`packages/connectors/src/whatsapp_meta/NOTES.md`. Registered everywhere; "Not available yet" until
the four secrets below and `OAUTH_STATE_SECRET` are set, and `/api/hooks/whatsapp_meta` answers 503
until `META_APP_SECRET` and `META_WEBHOOK_VERIFY_TOKEN` are.
1. **Business verification** of Mezonas' Meta business (Business Settings → Security Center): the
   long pole, start it first.
2. Register Mezonas as a **Tech Provider** (WhatsApp Business Platform; we don't pay for clients'
   messages, so not a Solution Partner) and accept the terms.
3. A Meta **app** of type *Business* with *WhatsApp* and *Facebook Login for Business*. Its App ID is
   the Worker secret `META_APP_ID` (public, but set like the others); Settings → Basic → App secret
   is `META_APP_SECRET` (the secret, never an access token: it verifies every webhook).
4. **App review** for Advanced access to `whatsapp_business_messaging` and
   `whatsapp_business_management`; until then only the app's testers can finish the sign-up.
5. Facebook Login for Business → **Configurations**: a *WhatsApp Embedded Signup* configuration
   with a system-user access token (no expiry) and those two permissions. Its id is
   `META_CONFIG_ID`. Allowed domains for the JS SDK: `staging.mezonas.com` and `app.mezonas.com`.
6. WhatsApp → Configuration → **Webhook**: callback URL `https://app.mezonas.com/api/hooks/whatsapp_meta`
   (staging: `https://staging.mezonas.com/api/hooks/whatsapp_meta`, on a second app or the app's
   test mode); verify token: a long random string of our own, the Worker secret
   `META_WEBHOOK_VERIFY_TOKEN`. Then subscribe to the **`messages`** field (subscribing to nothing
   passes the handshake and delivers nothing).
7. The app's Graph version set to **v26.0** (the code pins it in every URL).
8. No Mezonas system user is needed for clients (each client's sign-up gives its own token); one is
   useful only to test on Mezonas' own test number.
Then the operator offers "WhatsApp (your own number)" to a client, and its admin clicks **Connect
WhatsApp (your own number)** in Connections, picks the business, account and number in Meta's
window, and verifies the number there. Group messages stay off unless the operator turns them on
for the client (`PUT /api/ops/clients/:id/messaging/whatsapp-groups`), once Meta's groups API is
verified (NOTES.md).

### Worker secrets (set by `deploy.yml`, never by hand)

The deploy workflow loads the Worker's secrets into Cloudflare after each deploy:
- `WORKOS_API_KEY`, `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`: copied from the GitHub **environment** (`staging` or
  `production`) on every deploy, so rotating a key is "update the GitHub secret, redeploy".
- `ENCRYPTION_KEY` (32 random bytes, base64) and `WORKOS_COOKIE_PASSWORD`: generated once inside the job
  when the Worker doesn't have them yet, and never shown or stored anywhere else. If the job can't read
  the Worker's existing secrets it stops instead of generating, so `ENCRYPTION_KEY` is never replaced by
  accident (replacing it would make stored connection credentials unreadable; rotation is described in
  `packages/connectors/src/credentials.ts`). Since Access phase 1 (`docs/plan.md` §1.26) it wraps each
  client's own data key (`tenant_key`) rather than encrypting credentials itself. To rotate it: set the
  new key as `ENCRYPTION_KEY` and the old one as `ENCRYPTION_KEY_PREVIOUS`; the hourly cron re-wraps
  every client key and re-encrypts any v1 credentials; drop the old key once no `tenant_key` row's
  `wrapped_key->>'kid'` and no v1 envelope names it.
- The code service (`mezonas-codes-staging` / `mezonas-codes`) gets its own secrets, in its own
  step before apps/api deploys: `MFA_TWILIO_ACCOUNT_SID` and `MFA_TWILIO_AUTH_TOKEN` (the codes
  subaccount) copied when set, and `MFA_ENCRYPTION_KEY` (32 random bytes, base64) generated once
  inside the job exactly as `ENCRYPTION_KEY` is, never replacing an existing one. apps/api never has
  these, and the code service never has apps/api's.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (Gmail, M10; see "Google" above) and `QBO_CLIENT_ID`,
  `QBO_CLIENT_SECRET`, `QBO_WEBHOOK_VERIFIER` (QuickBooks Online, M9) are copied like the API keys when
  set. Staging has the development keys of both apps (2026-11-05).
- The new connectors (plan §1.52), copied like the API keys when set: `OUTLOOK_CLIENT_ID` and
  `OUTLOOK_CLIENT_SECRET` (Outlook), `RAMP_CLIENT_ID` and `RAMP_CLIENT_SECRET` (Ramp),
  `HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET` (HubSpot), `PLAID_CLIENT_ID` and `PLAID_SECRET`
  (the Plaid bank and card feed). Google Drive uses `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
  Each connector stays "Not available yet" until its keys and `OAUTH_STATE_SECRET` are set. Add
  each as a secret of the GitHub environment (`staging` first), then redeploy.
- Needed by the Zoho CRM connector (stream G, 2026-11-04): `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` (a Server-based client in Zoho's API console,
  multi-DC on, redirect URI `<APP_ORIGIN>/connections/zoho_crm/callback`) copied like the API keys, and
  `OAUTH_STATE_SECRET` (48 random bytes, base64) generated once like `ENCRYPTION_KEY`; replacing it only
  breaks sign-ins in progress. Until all three are set, Zoho CRM shows "Not available yet" in the portal.
  Webhooks need no secret beyond `ENCRYPTION_KEY`.
- Needed by the Podio connector, the same way: `PODIO_CLIENT_ID`, `PODIO_CLIENT_SECRET` (an API key
  from Podio's account settings, its domain set to the app origin, redirect URI
  `<APP_ORIGIN>/connections/podio/callback`).
- Google Drive (W3-B, plan §1.52) needs no new secret: it signs in with `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` (see "Google Drive and Outlook" above) and `OAUTH_STATE_SECRET`.
- Google Sheets (W4-D, plan §1.52) signs in with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` too.
  Its picking page needs two more values, public (Google restricts them to our origins) but set
  like the others, copied when set: `GOOGLE_PICKER_API_KEY` (a browser API key) and
  `GOOGLE_PROJECT_NUMBER` (the project's number). Without them Sheets connects, but no sheet can
  be picked ("Choosing sheets isn't set up here yet").
- Needed by the Outlook connector (W3-B, plan §1.52), the same way: `OUTLOOK_CLIENT_ID` and
  `OUTLOOK_CLIENT_SECRET` (the Entra app's application id and a client secret, redirect URI
  `<APP_ORIGIN>/connections/outlook/callback`). Until both and `OAUTH_STATE_SECRET` are set, Outlook shows "Not available yet" in the portal.
- Needed by the Ramp connector (W3-B, docs/plan.md §1.52), the same way: `RAMP_CLIENT_ID`,
  `RAMP_CLIENT_SECRET` (a Ramp developer app, scopes `transactions:read users:read receipts:write
  business:read`, redirect URI `<APP_ORIGIN>/connections/ramp/callback`). New transactions are read
  every 15 minutes by the cron; nothing else to set.
- Needed by the HubSpot connector, the same way: `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` (a
  HubSpot public app in a developer account, scopes `oauth` and `crm.objects.{contacts,companies,deals}.{read,write}`,
  redirect URI `<APP_ORIGIN>/connections/hubspot/callback`). Until the id, the secret and
  `OAUTH_STATE_SECRET` are all set, each shows "Not available yet" in the portal. `deploy.yml`
  copies the four secrets into the Worker (#134).
- Needed by the bank and card feed (`bankfeed`, Plaid; plan §1.52): `PLAID_CLIENT_ID` and
  `PLAID_SECRET` (the secret of the environment `PLAID_ENV` names: Plaid's sandbox secret on
  staging, its production secret in production), copied like the API keys; `PLAID_ENV` is a var in
  `wrangler.jsonc` (`sandbox` locally and on staging, `production` in production). In Plaid's
  dashboard: allowed redirect URIs `<APP_ORIGIN>/connections/bankfeed/callback` for each
  environment (`https://staging.mezonas.com/…`, `https://app.mezonas.com/…`, and
  `http://localhost:8787/…` for sandbox), the Link customization's name "Mezonas", and OAuth
  institution registration (the company profile and the questionnaire Plaid asks for before
  production). No webhook URL is set in the dashboard: each item's Link token names
  `<APP_ORIGIN>/api/connections/bankfeed/webhook/<client id>`. Until both secrets and
  `OAUTH_STATE_SECRET` are set, the feed shows "Not available yet". What to check in Plaid's
  sandbox first: `packages/connectors/src/bankfeed/NOTES.md`.
- Needed by the Slack connector (W4-C, plan §1.56), the same way: `SLACK_CLIENT_ID` and
  `SLACK_CLIENT_SECRET` (our Slack app's client id and secret, redirect URL
  `<APP_ORIGIN>/connections/slack/callback`; see "Slack" above). Until both and `OAUTH_STATE_SECRET` are set, Slack shows "Not available yet".
- Needed by the Google Chat connector (W4-E, plan §1.60), the same way:
  `GOOGLE_CHAT_SERVICE_ACCOUNT` (the service account's key JSON, as one secret) and
  `GOOGLE_CHAT_PROJECT_NUMBER` (the audience of Chat's tokens; see "Google Chat" above).
  Until both are set, Google Chat shows
  "Not available yet" in the portal and `/api/hooks/gchat` answers 503.
- Needed by WhatsApp through Meta (W4-A, plan §1.57), the same way: `META_APP_ID`,
  `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` and `META_CONFIG_ID` (see "WhatsApp through Meta"
  above), copied by `deploy.yml` when set. Until all four and `OAUTH_STATE_SECRET` are
  set, it shows "Not available yet"; without the secret or the verify token,
  `/api/hooks/whatsapp_meta` answers 503.
- Needed for texts and WhatsApp (plan §1.22; wiring into `deploy.yml` is the coordinator's):
  `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` of Mezonas' own Twilio account, copied like the API
  keys. They only make each client's subaccount; the subaccounts' tokens are encrypted in the
  clients' connections. `APP_ORIGIN` must be set, since Twilio is pointed at
  `<APP_ORIGIN>/api/twilio/<client>/messages` and `/status` and signs requests over those URLs.
  What to check in Twilio before a client goes live: `packages/connectors/src/twilio/NOTES.md`.
  US texting registration by API (P-8, plan §1.70) also needs two plain settings (not secrets), set
  as Worker variables per environment in `apps/api/wrangler.jsonc`: `TWILIO_PRIMARY_PROFILE_SID` (the BU SID of Mezonas' approved
  ISV primary customer profile in Trust Hub) and `TWILIO_A2P_EMAIL` (a Mezonas address Trust Hub
  writes to about each client's profile and trust product). Without them the back office's
  "Submit to Twilio" answers 503. Submitting charges Twilio's registration fees to Mezonas' account;
  they come back as the client's credits. Run the mock brand checklist in NOTES.md once first.
- Needed for calls (plan §1.23; wiring into `deploy.yml` is the coordinator's): `ELEVENLABS_API_KEY`
  (Mezonas' ElevenLabs workspace, Conversational AI) and `ELEVENLABS_WEBHOOK_SECRET` (the signing
  secret of ElevenLabs' post-call webhook, pointed at `<APP_ORIGIN>/api/elevenlabs/post-call`; it
  also keys each call's tool token). Calls use the Twilio secrets above and `APP_ORIGIN` (Twilio is
  pointed at `<APP_ORIGIN>/api/twilio/<client>/voice`, `/voice/answer` and `/voice/status`; the voice
  agents' tools at `<APP_ORIGIN>/api/voice/<client>/tools/…`). Without the ElevenLabs secrets, calls
  ringing in still reach voicemail or the forward, and no agent places a call. What to check first:
  `packages/connectors/src/elevenlabs/NOTES.md`.
- Needed by billing (plan §1.32: Mezonas works out each bill, Stripe only bills it), copied like
  the API keys by `deploy.yml` when set: `STRIPE_SECRET_KEY` (Mezonas' own Stripe account, a secret
  or restricted key; test mode on staging, live mode on production) and `STRIPE_WEBHOOK_SECRET` (the
  `whsec_…` signing secret of the webhook endpoint `https://<domain>/api/billing/stripe/webhook`).
  Without the key, billing is off: no client can be set up and no statement is sent, though the
  daily record and the statements are still kept for clients already set up. Without the webhook
  secret, Stripe's events are refused, so paid and failed invoices don't show. Allow `api.stripe.com`
  in the network if it is restricted. Set-up: "Setting up Stripe" below.

#### Setting up Stripe (billing)

Stripe holds only customers and invoices. There are no products, prices, subscriptions or meters
to create: prices are set in `/ops/billing` and on each template's and client agent's Settings tab.

1. Make a **separate Stripe account for Mezonas** (Twelve Thirty-Four Consulting LLC), not Plenary
   Labs' account. Nothing is shared with Plenary Labs (CLAUDE.md). Start in test mode for staging.
2. Make an API key: Developers → API keys. A restricted key needs write access to **Customers**,
   **Invoices** and **Invoice items**, and read access to the same. Use the secret key if you don't
   want a restricted one. Keep test and live keys apart: test mode for staging, live mode for
   production.
3. Add a webhook endpoint: Developers → Webhooks → Add endpoint, URL
   `https://<domain>/api/billing/stripe/webhook` (staging's and production's own domain), with these
   five events: `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided`,
   `invoice.marked_uncollectible`. Copy its signing secret (`whsec_…`).
4. Save the two secrets per environment as GitHub environment secrets (`staging`, `production`):
   `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. `deploy.yml` copies them into the Worker on the
   next deploy.
5. In Stripe's settings, set the invoice emails, the company name and the payment methods shown on the
   hosted invoice page (Settings → Billing → Invoices, and Settings → Payments). Stripe emails each
   invoice, so set a billing email when you set a client up.
6. In `/ops/billing`, set the credit price, the default agent price and credits, and the template
   prices. Leave auto-send off until the first statements have been checked by hand. Then set each
   client up from its page (this creates the Stripe customer).

What to check against Stripe's docs and a test-mode account before the first real invoice:
`packages/connectors/src/stripe/NOTES.md` (UNCHECKED items).
- Needed for email reach-outs (plan §1.25; wiring into `deploy.yml` is the coordinator's):
  `RESEND_API_KEY` (Mezonas' Resend account: it only makes each client's domain and a sending key
  restricted to it, which is encrypted in the client's `resend` connection),
  `RESEND_FALLBACK_DOMAIN` (our own verified sending domain, e.g. `mail.mezonas.com`, used until a
  client's domain is verified) and `RESEND_FALLBACK_DOMAIN_ID` (Resend's id for it, so fallback keys
  can send only from it). Replies come back through `EMAIL_FORWARDING_DOMAIN` to each client's
  forwarding address. What to check first: `packages/connectors/src/resend/NOTES.md`.

### GitHub summary

| Kind | Where | Name |
|---|---|---|
| Repository secret | Settings → Secrets and variables → Actions | `NEON_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Repository variable | same page, Variables tab | `NEON_PROJECT_ID` |
| Environment secret | Settings → Environments → `staging` / `production` | `WORKOS_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (one per environment; a repository secret also works) |
| Environment secret (when each provider is set up) | same place | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (texts and calls), `ELEVENLABS_API_KEY`, `ELEVENLABS_WEBHOOK_SECRET` (calls), `RESEND_API_KEY` (email), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (billing): the deploy copies each into the Worker only when it is set, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` (Zoho CRM), `PODIO_CLIENT_ID`, `PODIO_CLIENT_SECRET` (Podio), `RAMP_CLIENT_ID`, `RAMP_CLIENT_SECRET` (Ramp), `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` (HubSpot), `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET` (Outlook), `PLAID_CLIENT_ID`, `PLAID_SECRET` (bank and card feeds), `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` (Slack), `GOOGLE_PICKER_API_KEY`, `GOOGLE_PROJECT_NUMBER` (Google Sheets' picking, public values), `GOOGLE_CHAT_SERVICE_ACCOUNT`, `GOOGLE_CHAT_PROJECT_NUMBER` (Google Chat), `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_CONFIG_ID` (WhatsApp through Meta) |
| Environment secret (the code service) | same place | `MFA_TWILIO_ACCOUNT_SID`, `MFA_TWILIO_AUTH_TOKEN`: the codes Twilio subaccount, copied into the code service's Worker only |
| Environment variable (email) | Settings → Environments → Variables | `RESEND_FALLBACK_DOMAIN`, `RESEND_FALLBACK_DOMAIN_ID`: our own sending domain until a client's is verified; passed to the Worker as vars |

### Error tracking (Sentry)

Errors from the Worker (API routes, the cron, `RunWorkflow`) and from the browser go to Sentry
org `twelve-thirty-four-consulting`, projects **`mezonas-api`** and **`mezonas-web`** (separate
from Plenary Labs' projects; nothing is shared but the Sentry account). Off wherever no DSN is
given: local development and tests never send.

| GitHub | Name | What |
|---|---|---|
| Repository variable (or secret) | `SENTRY_DSN_API` | mezonas-api's DSN; the deploy passes it to the Worker as `SENTRY_DSN` |
| Repository variable (or secret) | `SENTRY_DSN_WEB` | mezonas-web's DSN; built into the page as `VITE_SENTRY_DSN` |
| Repository secret | `SENTRY_AUTH_TOKEN` | Uploads source maps for each release (the commit) |
| Repository variables (optional) | `SENTRY_ORG`, `SENTRY_PROJECT_API`, `SENTRY_PROJECT_WEB` | Default to the names above |

DSNs are not secrets (they only let a client send events). What is sent is held to what
debugging needs: no request bodies, cookies, headers but the user agent, query strings, emails,
IPs, model inputs or outputs, database query values or local variables; messages are cut short
and anything shaped like a key or token is removed (`apps/api/src/observability/sentry.ts`,
`apps/web/src/observability.ts`, with tests).

**What reaches it** (`docs/plan.md` §1.61). Unhandled errors; errors the Worker catches and carries
on from (`handled: yes`, with a `job` tag for the cron's passes and background work or a `kind`
tag for the Worker's own plumbing, and `client` with the client's id); answers that break a
route's contract (`kind: contract`, `route`); and the hourly **platform health** pass: failed live
runs and failed writes to clients' tools, one issue per error key (`ops_health` tag; the event's
extras hold up to five run or action ids for the MCP server's `run_get`), and once a day runs,
approvals and connections that are stuck. The **cron monitor** `mezonas-cron` (Sentry → Crons)
checks in every minute and opens an issue after three missed or failed ticks in a row. In the
browser: screen crashes, unreachable API calls (not when the page is being left), 5xx answers
and answers that break the contract (`kind`). Feedback from the Feedback button stays in
`/ops/feedback` and the MCP server's `feedback_list`, not Sentry (screenshots can show client data).

**Alerts** (set once in Sentry → Alerts; nothing in the repository sets them):

| Alert | When | To |
|---|---|---|
| Production, at once | A new or regressed issue in `environment:production` (both projects), or an `ops_health` issue at level error | Email and phone, the owner |
| Production volume | An issue seen more than 20 times in an hour in production | Email, the owner |
| Staging, daily | New issues in `environment:staging` | The daily email digest only |
| Cron | The `mezonas-cron` monitor fails (production) | Email and phone; it is set on the monitor itself |

Turn on the GitHub integration (Settings → Integrations → GitHub, repository
`jammil-alt/countersign`) so an issue links to its commit and a fix can resolve it: a commit or
PR that says `Fixes MEZONAS-API-12` resolves the issue in that release, and Sentry marks it
**regressed** if it comes back after.

**Triage, once a week (15 minutes)**, or when an alert arrives. Bring the inbox to zero:

1. Sentry, `is:unresolved` in `mezonas-api` and `mezonas-web`, production first, by frequency.
   Each issue gets one of: a fix (an issue or PR that names it), **resolve** (fixed, or it was
   one-off), **archive until it escalates** with a note saying why (a known outside cause), or
   **ignore** for an expected `ops_health` key (an `escalated` run is the agent working as asked).
   Never leave noise unresolved: an inbox nobody reads hides the issue that matters.
2. `ops_health` on the MCP server (or the Crons and `ops_health` issues in Sentry): anything stuck
   gets looked at with `run_get` or `connections_list`.
3. `/ops/feedback` (or `feedback_list`): resolve with a note or link to the fix.
4. Anything that needs code becomes a GitHub issue naming the Sentry issue; a Claude Code session
   with the Sentry connector can read the stack trace, find the cause and open the fix PR.

A fix ships with a test that fails without it (the error's input as a fixture where it can be).

### The first production release

Production (`https://app.mezonas.com`) has never been deployed. In this order (owner and Claude,
2026-11-09):

**On `main` first:** the migrations PR, then the code PRs, then this file's config PR with the two
WorkOS values below. Each PR's checks pass before it merges.

**The owner's setup (once):**
1. **DNS:** no record uses `app`, `codes`, `agents` or `in` on `mezonas.com`. The deploy creates
   `app.mezonas.com` and `codes.mezonas.com` itself.
2. **WorkOS → Production environment:** redirect URI `https://app.mezonas.com/api/auth/callback`;
   default sign-out URI `https://app.mezonas.com/`; Multi-factor auth required (Authentication →
   Features); session 12 hours, inactivity 30 minutes (Applications → the app → Sessions). Its
   client id and AuthKit domain go in `apps/api/wrangler.jsonc` (`env.production.vars`,
   `WORKOS_CLIENT_ID` and `WORKOS_AUTHKIT_DOMAIN`) by PR: they aren't secrets.
3. **GitHub → Settings → Environments → `production`:**
   - secrets `WORKOS_API_KEY`, `ANTHROPIC_API_KEY`, and `RESEND_API_KEY` with the variables
     `RESEND_FALLBACK_DOMAIN` and `RESEND_FALLBACK_DOMAIN_ID` (the buyer emails RFQs and POs);
   - Sentry's `SENTRY_DSN_API`, `SENTRY_DSN_WEB` (and `SENTRY_AUTH_TOKEN` as a repository secret,
     if not there yet);
   - **Required reviewers:** the owner, so no production deploy runs without that click.
   - Not by hand: `ENCRYPTION_KEY`, `WORKOS_COOKIE_PASSWORD` and `OAUTH_STATE_SECRET` are generated
     inside Cloudflare on the first deploy. Never replace `ENCRYPTION_KEY`.
   - Later, as each review lands, with no new release: `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`,
     `QBO_WEBHOOK_VERIFIER` (Intuit), `PLAID_CLIENT_ID`, `PLAID_SECRET` (Plaid), then a redeploy
     (Actions → Deploy → production). Until then QuickBooks and bank feeds show "Not available
     yet" in production.

**The release:**
1. Tag `v0.1.0` on `main` (or Actions → Deploy → production) and approve it. It runs the full
   check, applies every migration to Neon `main`, deploys the code service and the app, and runs
   `scripts/smoke.sh https://app.mezonas.com`.
2. Check from outside: `curl -sS https://app.mezonas.com/api/health` answers 200;
   `curl -sS -X POST https://app.mezonas.com/api/connections/qbo/webhook -d '{}'` answers 401
   (once `QBO_WEBHOOK_VERIFIER` is set; 503 before).
3. **Email Routing** (Cloudflare → `mezonas.com` → Email → Email Routing; one catch-all for the
   whole zone, "By hand" step 3), now that the Worker exists:
   - Subdomains: add `in.mezonas.com` and `agents.mezonas.com`.
   - First, a custom address rule → Send to a Worker → `mezonas-staging` for each staging address
     still in use (each staging client's forwarding address, any agent address being tested), so
     staging keeps its mail.
   - Then the catch-all → Send to a Worker → `mezonas` (it was `mezonas-staging`). Production's
     `email()` hands `agents.mezonas.com` mail to the code service itself.
4. **The first operator:** Actions → **Add operator** → `production`, your email and name ("Run the
   seed first" unticked). On an empty production it also creates the first client, Mezonas, so
   you have somewhere to be an operator of. Sign in at `https://app.mezonas.com`.
5. **The platform templates** (the seed never runs on production): signed in to the back office,
   open the browser's console and run, once:
   ```js
   for (const [slug, version] of [["bill-clerk", 1], ["builder", 1], ["coordinator", 1],
     ["document-clerk", 1], ["supervisor", 3]]) {
     const r = await fetch(`/api/ops/platform-templates/${slug}/install`, { method: "POST",
       headers: { "content-type": "application/json" }, body: JSON.stringify({ version }) });
     console.log(slug, r.status);
   }
   ```
   Each answers 200 (and 200 again if run twice). Pack templates (the Bookkeeper) install
   themselves when a pack is switched on.
6. **Clients:** finish the Mezonas client from step 4 (`### Mezonas, our own client` below: its
   internal flag, approvals, packs) and create the first real client; switch on their packs; build or fork their agents as on staging.

### The first operator

A fresh environment has no users, and sign-in only admits invited addresses, so the first operator
is invited from GitHub: Actions → **Add operator** → target, email (the address you sign in to
WorkOS with), name. It creates an `app_user` row that your first WorkOS sign-in with that verified
email claims, and an operator membership in every client. An operator's access comes from those
memberships, so an environment with no client at all (production on its first day) gets its first
client, **Mezonas** (America/Chicago), and you become its operator; without one, signing in shows
"You don't have access to this" and nobody could create a client. On staging it can run the seed
first (Sandbox and Demo clients, the platform templates); the seed never runs on production, and
the workflow refuses to run there with "Run the seed first" ticked (it is ticked by default). Safe to
run again, e.g. after new clients exist: it never adds a second first client.

### MCP server (Claude connector for the back office and for clients)

Mezonas as a Claude connector: `https://staging.mezonas.com/mcp` and `https://app.mezonas.com/mcp`,
one code, each with its own WorkOS environment, users and data. One URL for everyone; who signs in
decides what it does:

- **Operators** (`docs/plan.md` §1.34): it reads what the back office shows for the clients you
  serve, and its one write (resolving feedback) takes two calls, a preview and a confirm.
- **A client's admin or user** (§1.86): it reads what their portal shows them (overview, inbox,
  runs, connections, requests, records, documents, reports), for their own business only. It
  changes nothing; approvals and answers stay in the portal.

Off until `WORKOS_AUTHKIT_DOMAIN` is set for the environment (it is set for staging and
production).

Sign-in is WorkOS AuthKit acting as the OAuth server for MCP clients: Claude registers itself
with AuthKit, you sign in on AuthKit's page with your usual WorkOS sign-in, and AuthKit issues a
short-lived token for `<environment>/mcp` that the Worker checks against AuthKit's keys. Nothing
new to store: no new secret, no table (confirm tokens are sealed with `WORKOS_COOKIE_PASSWORD`).

**In WorkOS, for each environment (Staging first, then Production)** (dashboard names as of
writing; UNCHECKED, WorkOS renames them now and then):

1. Choose the environment (Staging / Production) at the top of the dashboard.
2. Applications → Configuration (or Connect → Configuration): turn on **Dynamic Client
   Registration** (and, if offered, **Client ID Metadata Documents**). This is what lets
   claude.ai register itself as an OAuth client of AuthKit.
3. Domains (Authentication → AuthKit): copy the **AuthKit domain**, e.g.
   `https://<something>.authkit.app` (or your custom auth domain if you set one).
4. In `apps/api/wrangler.jsonc`, set `WORKOS_AUTHKIT_DOMAIN` under that environment's `vars` (it
   is not a secret), merge to main (staging) or tag a release (production). Check:
   `curl https://staging.mezonas.com/.well-known/oauth-protected-resource` answers JSON naming the
   AuthKit domain.
5. If AuthKit lets you restrict which redirect URIs dynamic clients may use, allow
   `https://claude.ai/api/mcp/auth_callback` (claude.ai's connector callback; UNCHECKED).

**In claude.ai** (once per environment): Settings → Connectors → **Add custom connector** → name it
"Mezonas staging" (or "Mezonas"), URL `https://staging.mezonas.com/mcp` (or
`https://app.mezonas.com/mcp`) → Add → Connect. Sign in on the AuthKit page with the address you
use for the back office. Then ask Claude "whoami in Mezonas staging" to see the environment and
your clients.

**For a client** the steps are the same: they add a custom connector with the production URL
`https://app.mezonas.com/mcp` and sign in with the address they use for their portal. Someone
who has never signed in to the portal signs in there once first. Someone in more than one business
is asked which one; whoami lists them.

If connecting fails:

| You see | Why | What to do |
|---|---|---|
| 403 "sign in to Mezonas in a browser once" | Your WorkOS user has never signed in to this environment's back office or portal, so no Mezonas user carries its WorkOS id yet | Sign in at `https://staging.mezonas.com` (or `https://app.mezonas.com`) once, then Connect again |
| 403 "not a member of any business" | The account has no operator or client membership here | Invite them to the client first (or add the operator) |
| Only the client tools, as an operator | You signed in with a client user's address | Disconnect and sign in with your operator account |
| 401 "the access token is not for this server" on every call | AuthKit did not put this server's URL in the token's `aud` (RFC 8707 resource indicator; UNCHECKED) | Look at a token's `aud` in the Worker log or WorkOS, and set `MCP_AUDIENCE` to it under the environment's `vars`. Empty means the default (the `/mcp` URL); there is no way to turn the check off |
| 503 "the sign-in service can't be reached" | The Worker could not read AuthKit's metadata at `<domain>/.well-known/oauth-authorization-server` | Check `WORKOS_AUTHKIT_DOMAIN` |
| 503 "the MCP server is not set up here" | `WORKOS_AUTHKIT_DOMAIN` is set but WorkOS sign-in is not fully on (client id, API key, cookie password) | Fix WorkOS sign-in first |
| 429 | More than 120 calls a minute from you (Cloudflare rate limiting, `MCP_RATE_LIMIT`) | Wait a minute |

To cut a connector off: remove the person's memberships (takes effect on the next call),
or end their sessions in WorkOS (tokens last as long as AuthKit's access-token lifetime, a few
minutes by default; nothing here refreshes them). Every tool call is a log line
`{"event":"mcp.tool_call",…}` in Workers Logs, with the person, `audience` (`ops` or `client`),
the tool, its arguments (never a confirm token) and the outcome; each read is also a row in the
audit log (`mcp GET /api/…`).

Locally the MCP server is off (`WORKOS_AUTHKIT_DOMAIN` is empty in `wrangler.jsonc`); the tests in
`apps/api/src/mcp.test.ts` run it against a fake AuthKit.

## 1.1 Onboarding a client (managed service)

Done by the operator in the back office once M5–M6 ship: create the client → invite the client admin
(WorkOS invitation) → offer the QuickBooks and Gmail connectors and set their permission matrices; the
client admin signs in to each from the portal's Connections page (we never handle their credentials) →
set the Gmail ingestion query → enable packs → fork templates into the client (e.g. Pia) and customize them for the client's data and
flows, bind the client's connections → test-run on the client's data → publish and activate → choose who
approves writes (client admin by default, or the operator).

The client's other people can be invited the same way, by address (client settings, or the portal's
Team), or from the directory: "Invite to sign in" on an employee, a contractor or anyone in the
client's own organization who has an email (the client's Directory tab, or the portal's Contacts).

### Adding the supervisor to a client

The supervisor (`docs/plan.md` §1.28) watches one client's runs, connections, website logins, codes
and waiting items, and tells the client admin in plain steps and us with the details. It changes
nothing itself.

1. **The template must be installed.** It is the platform template `supervisor`
   (`packages/db/seed/agents/supervisor.v1.json`). On staging, run the seed again (Actions → **Add
   operator** with "Run the seed first", or `pnpm --filter @countersign/db run db:seed`); it adds
   templates that are missing and changes nothing else. The seed never runs on production, so there
   the template is created by hand until a template-only install exists: back office → Templates →
   new template `supervisor` with that file's bundle, then publish it.
2. **Add it.** New clients: "Add the supervisor" is ticked on the new-client form. Existing clients:
   the client page → Health → **Add the supervisor**. Either way it is forked from the template's
   live version and published as the client's agent `supervisor` ("Account check"); a client that
   has one keeps it.
3. **Test and activate it** like any agent: test-run `daily-check` (a test run reads and writes
   nothing; its output says what it would have reported), then Activate. It needs no connection.
4. **What it does then.** On every failed live run and every connection that needs a person it looks
   into it (the model, with the health tools and, at most, one question to the agent involved) and
   reports: one item for the client admin, one for us, once per open issue. Every day at 08:00 in the
   client's timezone it checks the account and writes the summary on the client's overview.
5. **Settings** (client settings JSON, `supervisor`): `reminderHours` (default 24: an issue still
   open is reminded after this long) and `waitingHours` (default 48: items waiting on the client
   longer than this are reported).

To stop it, pause the agent. Its findings stay in the inbox until someone marks them done.

### Adding the Bill clerk to a client

The Bill clerk (`docs/plan.md` §1.30) matches each read vendor invoice to its bill in QuickBooks
and, after approval, itemizes the bill, attaches the invoice and notes it in the memo.

1. **The template must be installed**: `bill-clerk` (`packages/db/seed/agents/bill-clerk.v1.json`),
   as for the supervisor above (the seed on staging, by hand on production).
2. **The client connects QuickBooks** from the portal's Connections page, and the first sync runs.
3. **Fork it** into the client from the template, bind its QuickBooks connection (Operation), and
   publish. It can't publish without the binding.
4. **Test-run** `invoice-read` with a read invoice's `document.extracted` payload (`documentId`,
   `extractionId`, `lineCount`, `totalsValid: true`): it proposes its changes and writes nothing.
   Then Activate.
5. **What it does then.** On every invoice read with totals that add up, it finds the bill (same
   vendor, total to the cent, ± 7 days, document number). No bill, or several: the client admin is
   asked, nothing is written. One bill with fewer lines than the invoice and the same total: three
   approvals in turn (itemize, attach, memo), each written once.

### Switching on the Purchasing area (the Materials pack)

The Materials pack (`docs/plan.md` §1.63, ARCHITECTURE §12.0–§12.4) gives a client a catalog of what
it buys, each vendor's name for each item, a match for every invoice line and a price history. It
ships tools and skills only; the agents that use it are built in the Agent lab.

1. **Migration 0032 must be applied** (it is on staging once its PR merges).
2. **Switch it on** for the client: back office → Packs → the client's **Switch on**, or the
   client's Settings → Packs. Nothing else is installed, and it is logged.
3. **Build or fork an agent** in the Agent lab that lists the pack's skills (`materials.match-lines`,
   `materials.record-prices`, `materials.price-check`, `materials.vendor-compare`,
   `materials.weekly-digest`). An agent using them can't be activated for a client without the pack.
4. **Where the results show:** the client's portal Reports (Price watch, Catalog, each with a CSV);
   the same for the back office under the client (`/ops/clients/:id/reports/materials/prices`);
   unsure matches arrive in the inbox as a match review card, and each answer teaches the catalog.

### Switching on the Bookkeeping area (bank transactions into QuickBooks)

The Bookkeeping pack (`docs/plan.md` §1.79) books a client's bank and card transactions in its
QuickBooks: each one matched with what is already there, booked by the client's rules or proposed
from its chart of accounts, a person deciding what isn't sure, and every write signed.

1. **Migrations 0039 and 0040 must be applied.** Plaid's keys must be set (`PLAID_CLIENT_ID`, `PLAID_SECRET`,
   above) and QuickBooks' (`QBO_*`).
2. **The client connects QuickBooks and its banks** from the portal's Connections page. Each bank is
   its own connection ("Connect another bank"); the first QuickBooks sync brings the chart of
   accounts.
3. **Switch on the Bookkeeping pack** for the client (Packs → Bookkeeping → Switch on). The
   Bookkeeper template is installed the first time any client gets it.
4. **Link the accounts**: the client's page → Packs → Bank transactions → "Read the feed now", then
   for each bank or card account pick its QuickBooks account and what we do with it: **Book in
   QuickBooks** (we write it after a person signs), **Suggest only** (the client keeps QuickBooks'
   own bank feed for that account and enters it there; we match it once it is in), or **Off**. Set
   "Book from" to the first day not yet in the books. Nothing is booked until an account is on.
5. **Add the rules you already know** (Rules on the same page): a payee, money in or out, an
   account. More are learned from the client's approvals.
6. **Fork the Bookkeeper** into the client (Agents → New agent → from a template), bind its
   QuickBooks connection and its bank feed, publish and take it through trial as usual. It runs every
   morning in the client's time zone, every Monday asks the client what its undescribed accounts
   are for, and on the 3rd of each month reconciles each linked account against QuickBooks for last
   month (asking a person to sign off any month that isn't balanced). "Check a deposit against its
   payout statement" is run by hand with the deposit and the statement's document.
7. **What the client sees**: Reports → Bank transactions and Reconciliations (read only); the
   booking review card, the account questions and the reconciliation card in its Desk; each
   QuickBooks write as an approval. The chart, its notes and
   the rules are the back office's.

### Mezonas, our own client (the Marketing area, `docs/plan.md` §1.72)

Mezonas is served as its own first client, so the Marketing pack measures `mezonas.com` exactly
as it will a client's site. Once per environment (staging, then production):

1. **Migration 0037 must be applied.**
2. **Create the client** in the back office: **Mezonas**, time zone America/Chicago. Invite no
   client people: we work it from the back office.
3. **Its settings:** approvals delegated to us (the client's Settings), and the internal flag:
   `PATCH /api/ops/clients/<id>/settings` with `{"internal": true, "reason": "Mezonas, our own
   client"}` (no switch on the screen yet). Internal means: never billed (set up no Stripe
   customer for it), no Weekly Table, real data.
4. **Switch on the Marketing pack** for it (Packs → Marketing → Switch on).
5. **Add the site:** `POST /api/ops/clients/<id>/packs/marketing/actions/add-site` with
   `{"domain": "mezonas.com", "name": "mezonas.com", "goals": ["hero-talk", "contact-email"]}`
   (a screen comes with M44). The answer has the site's id.
6. **The snippet** posts to `<app origin>/api/in/marketing/<client id>/<site id>`. It goes on the
   site in its own PR, after the privacy wording is reviewed (`docs/marketing-plan.md` F1, F2).

Figures are built nightly at 03:41 UTC; the report is under the client
(`/ops/clients/<id>/reports/marketing/overview`).

### Offering the Marketing area to a client (M50, `docs/plan.md` §1.78)

For a client that wants its own website measured, its search figures and the marketing agents.
Before the first client: the lawyer has read `docs/marketing/processor-terms-draft.md` and the
terms carry the processor wording (we count the client's visitors for it). Not for a client in
HIPAA mode: the platform stores nothing its site sends until the owner decides (§1.2 below).

1. **Switch on the pack** for the client: Packs → Marketing → Switch on (or the client page's
   Packs tab). It installs the pack's templates the first time any client gets it.
2. **Add the site**: the client's Marketing pages (`/ops/clients/<id>/marketing`) → Sites (its
   domain without `www.`, a name, and the goals: the `data-track` names of the clicks that count, such as
   "Book a visit"). One client may have several sites.
3. **Paste the snippet**: the site's row on Sites shows it. Send it to the client's web person:
   it goes once before `</body>` on every page. Elements to count get `data-track="<name>"`.
   Nothing else changes on their site: no cookies, no banner of ours. The client's own privacy
   notice must say they count visits (the draft's §4 gives words to adapt). Figures show the
   morning after the first visits (03:41 UTC).
4. **Connect Search Console** (one of two ways), from the client's portal by its client admin
   (never by us; invariant 8):
   - **Google sign-in** ("Google Search Console (Google sign-in)"): offer it to the client, and the
     client admin connects it with the Google account that has the site in Search Console. Needs
     `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `OAUTH_STATE_SECRET` (as Gmail), the redirect
     URI `<APP_ORIGIN>/connections/gsc_oauth/callback` on the Google OAuth client, and the scope
     `webmasters.readonly` in Google's verification (until it is verified, a refresh token ends
     after 7 days and the connection asks to be reconnected weekly).
   - **A service account** ("Google Search Console"): the client adds a Google Cloud service
     account to its property as a Restricted user and enters the property and the account's JSON
     key in the portal.
5. **Connect Bing**: offer "Bing Webmaster Tools"; the client admin enters the site URL and an API
   key from Bing Webmaster Tools (Settings → API access).
6. **Point the site's search figures** at the connections: the client's Marketing pages → Search
   → the site's Google and Bing rows. With Google sign-in this also picks the property of that
   site among those the account can read (its Domain property, else its URL-prefix one); if the
   account can't read the site, it says so. The first import comes within the hour (16 months of
   history), then nightly at 03:11 UTC.
7. **Fork the templates** you want into the client (Agent lab, or the client's Agents → New agent
   → from a template: Weekly site report, Titles and descriptions, Article drafts, Forum watch,
   Social posts), as for any client. Each starts with approval on; publishing a guide and posting
   are always signed by a person. Point their schedule and connections at the client's own.
8. **Publishing guides** to a client's own site needs a CMS connection (WordPress, Webflow: not
   built until a client asks). Until then article drafts stay drafts for the client to copy.

**What the client sees**, in its portal under Reports, read only: **Website** (visits, goals,
pages, sources; 7, 28 or 90 days), **Search** (Google and Bing: times shown, clicks, positions,
top searches, close to page one) and **Weekly report** (each week's report and its three
suggested actions with where each stands). It never sees visits one by one, content, the claims
list or the forum watch: those stay in the back office. Approvals for its marketing agents reach
its Desk like any other agent's.

## 1.2 Compliance: HIPAA mode, retiring a client, the audit log (`docs/plan.md` §1.35)

**HIPAA mode.** A client whose records hold health information is put in HIPAA mode on its
Settings page in the back office (with a reason). It can only be switched on once every vendor that
would receive its data has a signed BAA. Those vendors are listed in `BAA_PROCESSORS` in
`apps/api/wrangler.jsonc`, per environment. Add a vendor there by pull request only after its BAA
is signed, and keep the signed copy. The ids are `cloudflare`, `neon`, `workos`, `anthropic`,
`openai`, `twilio`, `meta_whatsapp`, `elevenlabs` and `resend`. The first three are needed for any
HIPAA client. `anthropic` is needed for agents and document reading. M50: website measurement is
held for a client in HIPAA mode whatever is listed: its site's beacons are answered and nothing is
stored, until the owner decides (`docs/marketing/processor-terms-draft.md` §6). Web research
(`anthropic_web`) and Hacker News (`hackernews`) are refused to it until listed.

**Retiring a client.** On the client's Settings page, Retire client (a reason, and the client's
name typed again). Its users lose access at once, its agents are retired and its tools are
disconnected. Then:
1. By hand, the same day, close what other vendors keep for it:
   - its Twilio subaccount (texts, voicemails);
   - its ElevenLabs agents and call transcripts;
   - its Resend sending domain;
   - its Stripe customer, after the last invoice;
   - its Sentry events, if any name it.
2. 30 days later, the hourly cron deletes its files (`tenants/<id>/` in R2) and records
   `client.purge_files` in the audit log.
3. Then the owner purges its rows, as `cs_owner`:
   `DIRECT_DATABASE_URL=<cs_owner url> pnpm --filter @countersign/db run db:purge-client -- <client id>`.
   It refuses to run until the 30 days have passed and step 2 is done. It briefly locks each table, so run it at a
   quiet hour. The audit log keeps the client's rows (ids only). Neon's point-in-time history
   holds the deleted rows until its restore window passes.

**Exporting a client's data.** The terms promise an export on request until 30 days after the
service ends. Start it with `POST /api/ops/clients/<id>/exports` (a reason is optional) and list it
with `GET /api/ops/clients/<id>/exports`; once ready, the list carries a link that works for 5
minutes. Download it and send it to the client yourself: the client can no longer sign in once
retired. It runs as its own Workflow, `ExportWorkflow` (binding `EXPORT_WORKFLOW`;
`mezonas-staging-export` on staging), which wrangler creates on the next deploy. The ZIP lives
under the client's files, so it is deleted with them; start a retired client's export well before
its 30 days end (the deletion waits for an export being built, up to a day). Client admins download
their accountant export and their own audit log from `/api/exports/accountant` and
`/api/exports/audit` (`?from=YYYY-MM-DD&to=YYYY-MM-DD`).

**Test suites.** `POST /api/ops/tests/run` runs a skill's or template's test cases as its own
Workflow, `TestSuiteWorkflow` (binding `TEST_SUITE_WORKFLOW`; `mezonas-staging-test-suite` on
staging), which wrangler creates on the next deploy. Skill cases call the model live (they need
`ANTHROPIC_API_KEY`) and never reach a client's tools; template cases are test runs in the Sandbox
client.

**The audit log and access review** are at `/ops/audit` (operators only). Review access every
quarter: remove anyone listed who should no longer be there, then save the CSV with the review's
date. Audit rows are kept for 6 years. Removing older rows is a manual owner task: the trigger must
be disabled, as in `db:purge-client`.

**Settings outside the code** (set by the owner, 2026-11-06; `docs/security.md` has the record):
- WorkOS, both environments: Multi-factor auth on (Authentication → Features), and Session lifetime
  of 12 hours with 30 minutes' inactivity (Applications → the app → Sessions). Access token duration
  stays 5 minutes.
- Cloudflare, zone `mezonas.com` (Free plan): the rate-limiting rule "API rate limit" (URI path
  `/api/*` except the webhook paths `/api/twilio/`, `/api/voice/`, `/api/elevenlabs/`,
  `/api/hooks/`, `/api/billing/stripe/` and `/api/connections/qbo/webhook`; 50 requests per 10
  seconds per IP, then blocked for 10 seconds). Always Use HTTPS on. Minimum TLS 1.2. The
  encryption mode stays Full (automatic), and Cloudflare's own HSTS stays off, since the app sends
  its own. Add a new webhook path to the rule's exclusions when one is added.
- GitHub: dependency graph, Dependabot alerts and security updates, secret scanning with push
  protection, CodeQL Default setup off (we run `codeql.yml`), and the ruleset "Protect main": a pull
  request, the checks `checks / check`, `checks / static` and `analyze`, no force pushes or
  deletion, admin bypass.
- Neon, project `mezonas` (Launch): History window 7 days (Settings → Postgres).

## 2. What CI does

- **`ci.yml`**: on every non-draft pull request (and by hand), runs `checks.yml`. Drafts cost nothing;
  marking a PR ready runs the check.
- **`checks.yml`**: install, Biome lint, layering check, typecheck, then tests against a Postgres 16 +
  pgvector service container set up with Neon's roles (`scripts/setup-postgres.sh`), which also applies
  every migration from scratch. It never connects to Neon. It used to copy `main` to a throwaway
  branch; that would put client data on a runner, and Neon refuses schema-only branches on this
  project (our SQL-made `cs_runtime` role counts as a "legacy web access role"). A migration that only
  fails on real rows (a new `not null` on old data) fails on staging first: `deploy.yml` migrates
  staging in a transaction before its Worker deploys, and production only from a later tag.
- **`codeql.yml`**: CodeQL's security queries on ready pull requests, pushes to `main` and weekly.
  Findings are under Security → Code scanning.
- **Dependabot** (`.github/dependabot.yml`): security updates as GitHub learns of them; npm and
  Actions version updates monthly, one grouped pull request each, majors included. Turn on Dependabot alerts and security updates, and
  secret scanning with push protection, in the repository's Settings → Code security.
- **`bootstrap.yml`**: by hand only; creates or updates the Neon project, branches and roles, Hyperdrive
  configs and R2 buckets (§1). Safe to re-run; each run rotates `cs_worker`'s passwords.
- **`deploy.yml`**: on push to `main` (staging) or a `v*` tag (production): the full check, then
  migrates the target's Neon branch as `cs_owner`, deploys the code service (`apps/mfa`) and its
  secrets, builds `apps/web` and runs `wrangler deploy` for apps/api (whose `CODES` binding needs the
  code service deployed first). Its `site` job builds `apps/site` and deploys `mezonas-site`, from
  `main` only. After the Worker deploys, **`scripts/smoke.sh`** checks the app from the outside
  (`/api/health` answers, the page and its script load, `/api/session` refuses with a JSON 401),
  retrying for 2 minutes; a failure marks the deploy failed. Run it by hand against either
  environment: `scripts/smoke.sh https://staging.mezonas.com`.
- **The screen sweep** (`checks.yml`'s `sweep` job, `apps/web/e2e/route-sweep.mjs`): beside the
  tests, on the seeded database, the built app runs on `wrangler dev` with the dev sign-in and real
  Chromium opens every screen of the back office (as the operator) and the portal (as the Demo
  client's admin). It starts from each route without parameters and follows the links the screens
  show, one page per route, so new screens are swept without editing it. A page fails on a crash
  (an empty `#root`), a page error, a console error, an `/api` answer of 500 or more, or a link to
  "Not found". It clicks and submits nothing. Routes no seeded link reaches (a run, a document) are
  listed as a note, not a failure; they are covered once the seed has such rows. It runs in light
  and dark at desktop width and in dark at phone width (390×844), where a page that scrolls
  sideways also fails. Then **the walkthroughs** (`apps/web/e2e/walkthroughs.mjs`) click through the
  prototype's two paths (`#Start`), the client's morning and the back office's, by the links each
  screen shows (opening the menu on a phone), in dark at desktop width and light at phone width.
  They are read-only: a request that would change anything fails the step, except in "Sign and
  undo", which signs the one change the e2e seed puts on the Demo client's Desk (on the in-memory
  testkit, never executed) and undoes it inside the window, so it waits again. The job seeds with
  `SEED_E2E=1` for that; staging's seed (Actions → **Add operator**) never sets it, because the
  seeded run has no Workflow instance and, signed and left past the window, would have the cron
  retry its approval every minute for 24 hours. Locally: seed with `SEED_E2E=1`
  (`docs/local-development.md`). A step the seed can't
  support (no client agent, no run) is skipped with a note. Docs-only pull requests skip both.
  Locally: `pnpm dev`, then `pnpm --filter @countersign/web sweep`; `SWEEP_LOOKS` picks the looks
  (`desktop-light`, `desktop-dark`, `phone-light`, `phone-dark`) and `SWEEP_SHOTS=<folder>` saves a
  screenshot of every page in each (`apps/web/e2e/harness.mjs`).

## 3. Migrations

- Applied by `deploy.yml` before the Worker is deployed, so the new schema is always in place before
  code that needs it. Migrations must therefore keep the previous Worker working (add, then use;
  stop using, then drop).
- Never edit a migration that has reached `staging` or `main`. Add a new one.

## 4. Backups and restore

Neon point-in-time restore covers both branches. To inspect the past without touching production,
create a branch from a timestamp and connect to it directly.

Test a restore every quarter (SOC 2 A1.3, HIPAA §164.308(a)(7)):
1. Create a branch from a timestamp an hour back.
2. Count the rows of a few tables against `main`.
3. Delete the branch.
4. Note the date and the result.

Set Neon's history retention to at least 7 days on the production project.
