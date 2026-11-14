# apps/site: mezonas.com

The public website: what Mezonas is, and the legal pages Google's OAuth verification for Gmail
needs on our own domain (a homepage that describes the app, with a privacy policy linked from it).

| Path | Page |
|---|---|
| `/` | What we do: the hero, the tools we work in, the connectors, the team, the gap chart and the purchasing run |
| `/hire` | Hire, don't build: three paths, the use cases, how we work with you, and the comparison |
| `/security` | Security: data security and integrity, the masking demo, the Worksheet and what we're allowed to do |
| `/terms` | Terms of service (B2B managed service) |
| `/privacy` | Privacy policy, with the Google user data section and Google's Limited Use sentence |
| `/subprocessors` | Our providers and the services clients connect themselves |
| `/sms-terms` | Text message terms for the people clients text (A2P 10DLC review): who sends, opt-in (the person's own sign-up, docs/plan.md §1.98), the sign-up at `#opt-in` (the sign-up page, the invitation email and the confirmation text, with screenshots from `src/sms-signup/`, and the START keyword; every 10DLC campaign links here), what the messages are, frequency, rates, STOP and HELP, carriers |
| `/no-measure` | How we measure the site and how to opt out. Built only while measuring is on ("Measuring" below); `noindex`, not in the sitemap |
| `/guides`, `/guides/<slug>` | Published guides, served by the Worker from R2 while guides are on ("Guides" below); off, the 404 page |
| anything else | `404.html` |

## How it is built

Plain HTML and CSS. `build.mjs` (Node, no dependencies) wraps each page in `src/pages/` in
`src/layout.html` (header, the call to action, footer with "Terms and policies", favicon, meta
tags), renders the marketing pages' diagrams and demos written as `{{component name}}`
(`src/components.mjs`, from the lists in `src/content/`), inlines icons written as
`{{icon mz-name}}`, highlights bracketed placeholders, and copies the design system's
`tokens.css`, component CSS, Geist fonts and logos from `@countersign/design-system`, and the
connectors' logos from `src/logos`, into `dist/`. No framework and no cookies.

The pages' copy is in `src/pages/*.html`; the lists the demos show (team, connectors, gap rows,
the purchasing run, use cases, the four steps, the security lists) are in `src/content/*.mjs`, so
they change without touching a component. Every state a demo shows is rendered into the page;
`src/site.js` (one small file, `defer`) only switches between them on a 1.1-second clock while a
demo is on screen, and holds still with reduced motion. It fetches nothing, stores nothing and
sends nothing (`src/site.test.ts` checks). Without scripts, each demo shows its first state.
Measuring is separate: off unless it is turned on, and then one inline script ("Measuring"
below).

The connectors shown are the owner's list (`src/content/what.mjs`), with their logos in
`src/logos`. Third-party logos are kept as delivered (Biome skips the folder).

The site imports nothing from the platform: its only workspace dependency is the design system's
files, and it has no runtime dependencies (`scripts/check-deps.mjs` holds it to that). The
Worker's code, `src/worker.ts`, imports nothing at all.

```sh
pnpm --filter @countersign/site build   # writes apps/site/dist
pnpm --filter @countersign/site test    # builds into a temp folder and checks it
```

`pnpm --filter @countersign/site dev` builds the site and serves it with `wrangler dev`, as the
Worker `mezonas-site` serves it (`wrangler.jsonc`: static assets, `/terms` from `terms.html`,
`404.html` for anything else; the Worker's code runs first only for `/guides`, `/guides/*` and
`/sitemap.xml`). It deploys from `main` (`deploy.yml`, job `site`); the custom domains and the
DNS steps are in `docs/operations.md`, "The public site".

Each page starts with its front matter in an HTML comment: `title`, `description`, and
`legal: true` for the legal pages, or `only: measure` for a page built only while measuring is
on. A legal page with a placeholder left shows the "Draft for legal review" note at the top; it
disappears when the last placeholder on that page is filled in.

`src/site.test.ts` checks that every page builds with a title, description, favicon, landmarks and
headings in order; that every internal link, anchor and asset resolves; that `/privacy` has the
Limited Use sentence word for word and links Google's policy; that the carriers' SMS sentences,
STOP and HELP are word for word on `/privacy` and `/sms-terms`; that the company name is on the
legal pages; that the landing page links to all four legal pages; that every placeholder is listed below; and that no page has an exclamation
mark or "AI-powered". `src/measure.test.ts` checks measuring both ways and runs the page's script
in a stub browser; `src/worker.test.ts` checks the Worker's routing with guides off and on.

## Measuring

Off unless the build's environment has `MEZONAS_MEASURE_URL`: the collector's address with the
client's and the site's ids, `https://<collector host>/api/in/marketing/<client id>/<site id>`
(the Marketing pack's collector, `docs/plan.md` §1.72; the Mezonas client and its site are set up
from the back office). Off, the built site is byte for byte what it was before measuring existed:
the `data-track` names in the sources are taken out and nothing is added. On:

- every page but `/no-measure` carries `src/measure.js` inline, before `</body>`, sending to that
  address: a view (path, campaign tags, referrer), time engaged and scroll quarter when the page
  is left, a click on a `data-track` element with where it sits, and a `form[data-form]` coming
  into sight (the site has no form today). The body is `text/plain` by `sendBeacon`; nothing is
  stored in the browser and no cookie is set. With Do Not Track or Global Privacy Control, the
  script sends nothing, and the collector would not count it either;
- `/no-measure` is built and every footer links to it. With no cookies and no storage there is
  nothing for a switch on that page to keep, so the opt-out is Do Not Track or Global Privacy
  Control, and the page says so;
- the build fails unless `/privacy` has the measurement section and links `/no-measure` (the draft
  is `docs/marketing/privacy-measurement-draft.md`, for the owner and the lawyer), and fails on an
  address that is not https, or on a `data-track` name used twice on a page.

To turn it on (owner): apply the reviewed privacy section to `src/pages/privacy.html` (and
`/subprocessors` if the lawyer asks), then set the repository variable `MEZONAS_MEASURE_URL` and
pass it to the `site` job's build step (`docs/operations.md`, "The public site"). Clicks on
`hero-talk`, `nav-contact`, `footer-contact` and `contact-email` are the natural goals for the
site's settings in the back office.

### Tracked names

Each link and button on the marketing pages (`/`, `/hire`, `/security`), and the header, call to
action and footer on every page, has a `data-track` name, unique on its page. A new tracked element gets a name here too
(`src/measure.test.ts` checks both ways).

| Name | Element |
|---|---|
| `nav-logo-home` | Header: the logo |
| `nav-what-we-do` | Header: What we do |
| `nav-hire` | Header: Hire, don't build |
| `nav-security` | Header: Security |
| `nav-contact` | Header: Get your diagnostic |
| `nav-menu` | Header, on a phone: the menu button (opens or closes the tabs) |
| `cta-start` | Call to action, every page: Get started (an email to us) |
| `contact-email` | Call to action, every page: the email address (text, not a link; a click or tap on it) |
| `footer-terms` | Footer: Terms of service |
| `footer-privacy` | Footer: Privacy policy |
| `footer-subprocessors` | Footer: Subprocessors |
| `footer-sms-terms` | Footer: Text message terms |
| `footer-no-measure` | Footer: How we measure (only while measuring) |
| `footer-contact` | Footer: Contact |
| `hero-talk` | What we do: "Get your diagnostic" |
| `hero-run` | What we do: "Watch a purchase" |
| `connectors-all` | What we do, Connectors: the All filter |
| `connectors-acct` | What we do, Connectors: the Accounting filter |
| `connectors-pay` | What we do, Connectors: the Payments and banking filter |
| `connectors-crm` | What we do, Connectors: the CRM and sales filter |
| `connectors-comm` | What we do, Connectors: the Email and chat filter |
| `connectors-files` | What we do, Connectors: the Files filter |
| `connectors-mkt` | What we do, Connectors: the Marketing filter |
| `connectors-ask` | What we do, Connectors: "Ask about your stack" |
| `gap-today` | What we do, gap chart: Today |
| `gap-with` | What we do, gap chart: With Mezonas |
| `run-toggle` | What we do, purchasing run: Pause, Play or Replay |
| `run-stage-1` | What we do, purchasing run: stage 1, Crew asks |
| `run-stage-2` | What we do, purchasing run: stage 2, Pia builds the list |
| `run-stage-3` | What we do, purchasing run: stage 3, Pia asks vendors |
| `run-stage-4` | What we do, purchasing run: stage 4, Compares quotes |
| `run-stage-5` | What we do, purchasing run: stage 5, You sign |
| `run-sign` | What we do, purchasing run: Sign |
| `run-quotes` | What we do, purchasing run: See all quotes |
| `usecase-sales` | Hire, don't build: the use case `sales` (`src/content/hire.mjs`) |
| `usecase-quote` | Hire, don't build: the use case `quote` (`src/content/hire.mjs`) |
| `usecase-buy` | Hire, don't build: the use case `buy` (`src/content/hire.mjs`) |
| `usecase-paid` | Hire, don't build: the use case `paid` (`src/content/hire.mjs`) |
| `usecase-close` | Hire, don't build: the use case `close` (`src/content/hire.mjs`) |
| `usecase-jobs` | Hire, don't build: the use case `jobs` (`src/content/hire.mjs`) |
| `usecase-cash` | Hire, don't build: the use case `cash` (`src/content/hire.mjs`) |
| `process-find` | Hire, don't build, how we work with you: Find |
| `process-design` | Hire, don't build, how we work with you: Design |
| `process-build` | Hire, don't build, how we work with you: Build |
| `process-run` | Hire, don't build, how we work with you: Run |
| `process-toggle` | Hire, don't build, how we work with you: Pause or Play |
| `mask-real` | Security, the masking demo: What you see |
| `mask-ai` | Security, the masking demo: What the AI sees |
| `security-privacy` | Security: the privacy policy link |
| `security-subprocessors` | Security: the subprocessors link |
| `no-measure-privacy` | `/no-measure`: the privacy policy link |

Guide pages add `guide-all` and `guide-talk`, and the guides index `guides-<slug>` for each guide
(`src/worker.ts`).

## Guides

Published guides are written in the back office (the Marketing area's content) and published by
the platform's `website.publish` into the R2 bucket bound as `SITE_CONTENT`
(`docs/marketing-plan.md` §11.4): `site/mezonas.com/guides/<slug>.json` (`title`, `description`,
`html`, the checked body, and `publishedAt`), `site/mezonas.com/sitemap.json` (the guides live now)
and `site/mezonas.com/redirects.json`. The Worker (`src/worker.ts`) serves them only when the
bucket is bound **and** the var `SITE_GUIDES` is `on`; otherwise it hands `/guides*` and
`/sitemap.xml` to the static files, so they answer as before (the 404 page, the static sitemap).

On, `/guides/<slug>` is the guide wrapped in the site's layout at serve time (the built 404 page's
header, footer, styles and, when the build measures, the script; its head and main content
replaced), with Article structured data; `/guides` lists the live guides; `/sitemap.xml` is the
static one with `/guides` and each guide added; a guide that is not live but has a redirect
answers 301. A body with active content (scripts, frames, forms, styles, event handlers,
`javascript:` addresses) is refused as if missing. If R2 fails, a guide answers 503 and the
sitemap falls back to the static one; the API and the database are never on the path.

To turn it on (owner): create the bucket `mezonas-site-content`, bind it to `apps/api` (writes)
and to this Worker (reads), and uncomment the `r2_buckets` and `vars` lines in `wrangler.jsonc`.

## Placeholders to fill in

The legal text is a draft for the owner's lawyer, not legal advice. The company is Twelve
Thirty-Four Consulting LLC (the name on the owner's Twilio compliance profile; its EIN is not
published). The owner filled in the bracketed placeholders on 2026-11-05: contact and privacy
email, the location (Dallas, Texas; no street address, owner 2026-11-05), Texas law, deletion within 30 days and backups expiring within a further
30 days. The AI providers' API data terms (no training, limited retention for misuse checks) and the
international transfer safeguards (providers' data processing terms, standard contractual clauses)
are written from the providers' published commercial terms and are for the lawyer to confirm.

Also for the owner and the lawyer to confirm (stated as draft terms, not placeholders): 30 days'
notice for changes to the terms and to the subprocessor list, 30 days' notice to end the service
and 15 days to cure a breach, 30 days to ask for an export after the service ends, the liability
cap (fees paid in the 12 months before a claim), and the age of 16 in the children section.

## Keeping it true

The privacy policy and the subprocessors list describe how the platform works today. When the
platform changes, update them in the same PR:

- a new provider (a Worker secret or binding for a new outside service): add it to `/subprocessors`
  and give clients notice as the page says;
- Gmail: the policy says we ask only for `gmail.send` and read no mailbox through Google (owner,
  2026-11-05). Asking Google for any other scope needs this policy changed first, and a new
  verification;
- texts: `/sms-terms` and the privacy policy's "Text messages" section describe consent per
  contact and channel, STOP and START, and quiet hours as `apps/api/src/messaging/contacts.ts`,
  `apps/api/src/routes/twilio-hooks.ts` and `packages/connectors/src/twilio/` handle them. The
  carriers' sentences are word for word and tested;
- what forwarded email keeps (`packages/connectors/src/upload/forwarding.ts`), what Sentry receives
  (`apps/api/src/observability/sentry.ts`, `apps/web/src/observability.ts`), and how secrets are
  encrypted (`packages/connectors/src/credentials.ts`, `tenant-keys.ts`).

Then change the "Last updated" date on each page you touched.
