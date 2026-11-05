# apps/site: mezonas.com

The public website: what Mezonas is, and the legal pages Google's OAuth verification for Gmail
needs on our own domain (a homepage that describes the app, with a privacy policy linked from it).

| Path | Page |
|---|---|
| `/` | Landing page: what we do, how it works, how we keep data safe, contact, and "Terms and policies" at the bottom |
| `/terms` | Terms of service (B2B managed service) |
| `/privacy` | Privacy policy, with the Google user data section and Google's Limited Use sentence |
| `/subprocessors` | Our providers and the services clients connect themselves |
| anything else | `404.html` |

## How it is built

Plain HTML and CSS. `build.mjs` (Node, no dependencies) wraps each page in `src/pages/` in
`src/layout.html` (header, footer, favicon, meta tags), inlines icons written as
`{{icon mz-name}}`, highlights bracketed placeholders, and copies the design system's
`tokens.css`, component CSS, Geist fonts and logos from `@countersign/design-system` into
`dist/`. Nothing runs in the browser: no framework, no analytics, no cookies.

The site imports nothing from the platform: its only workspace dependency is the design system's
files (`scripts/check-deps.mjs` holds it to that).

```sh
pnpm --filter @countersign/site build   # writes apps/site/dist
pnpm --filter @countersign/site test    # builds into a temp folder and checks it
```

Each page starts with its front matter in an HTML comment: `title`, `description`, and
`legal: true` for the legal pages. A legal page with a placeholder left shows the "Draft for legal
review" note at the top; it disappears when the last placeholder on that page is filled in.

`src/site.test.ts` checks that every page builds with a title, description, favicon, landmarks and
headings in order; that every internal link, anchor and asset resolves; that `/privacy` has the
Limited Use sentence word for word and links Google's policy; that the landing page links to all
three legal pages; that every placeholder is listed below; and that no page has an exclamation
mark or "AI-powered".

## Placeholders to fill in

The legal text is a draft for the owner's lawyer, not legal advice. These are left in brackets,
highlighted on the page:

| Placeholder | Where | What goes there |
|---|---|---|
| `[Legal entity name]` | `/terms` (intro, contact), `/privacy` (who we are, contact) | The company that operates Mezonas |
| `[address]` | `/terms` (contact), `/privacy` (contact) | Its postal address |
| `[contact email]` | `/` (contact), `/terms` (contact) | The address clients and prospects write to |
| `[privacy contact email]` | `/privacy` (rights, contact), `/subprocessors` (questions) | The address for privacy requests |
| `[state]` | `/terms` (governing law) | The state whose law governs, and whose courts hear disputes |
| `[to confirm with each provider]` | `/privacy` (AI model processing) | Whether Anthropic and OpenAI keep API data, for how long, and whether they may train on it, under the terms we accepted |
| `[deletion period]` | `/privacy` (retention) | How long after the end of service, or a request, we take to delete a client's data |
| `[backup retention period]` | `/privacy` (retention) | How long database backups keep deleted data (Neon's restore window as configured) |
| `[transfer safeguards to confirm]` | `/privacy` (international transfers) | The mechanism for moving data between countries, such as standard contractual clauses |

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
- what forwarded email keeps (`packages/connectors/src/upload/forwarding.ts`), what Sentry receives
  (`apps/api/src/observability/sentry.ts`, `apps/web/src/observability.ts`), and how secrets are
  encrypted (`packages/connectors/src/credentials.ts`, `tenant-keys.ts`).

Then change the "Last updated" date on each page you touched.
