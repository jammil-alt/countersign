# Marketing and search: plan

Status: plan of 2026-11-08. The owner approved building it as a pack with Mezonas served as its
own client, worked from the back office (2026-11-08). M43 (measurement) is under way:
`docs/plan.md` §1.72 and M43. The rest of ARCHITECTURE v0.16 (§9 below) follows with each
milestone.

Source: the owner's Plenary Labs marketing portal (`jammil-alt/plenary-labs`,
`docs/specs/marketing-portal/PLAN.md` and `phase-0.md`, migrations 0085–0091, `apps/api/src/{site,search,content,marketing}`,
`apps/site/src/analytics.ts`, `packages/schema/src/{site-analytics,marketing,marketing-agents,content}.ts`,
`docs/marketing/claims.md`). Code may be copied from it; nothing is shared (CLAUDE.md, "Separate
from Plenary Labs").

---

## 0. In short

Plenary built its marketing portal as a separate system inside its ops console: its own agent
registry, scheduler, caps, proposals queue and activity log, all for one website. Mezonas already
has every one of those as a platform part. So the build here is different in one way that matters:

**Marketing is a business area (a pack), and Mezonas is its first client.**

- A new pack, `packs/marketing` (the **Marketing area**, ARCHITECTURE §12.0): site measurement,
  search figures, content and the claims list, with their tables, tools, skills, events, reports
  and screens. Every table carries `tenant_id` with forced RLS, like any area.
- A new client, **Mezonas** ("client zero"): a normal tenant, like the Sandbox, with approvals set
  to the operator. The Marketing area is enabled for it, its connections are mezonas.com, Search
  Console and Bing, and its agents are forks of the marketing templates.
- The back office gets a **Marketing** entry that opens the Mezonas client's marketing screens.
  The same screens work for any client with the pack enabled, and the portal gets read-only
  reports for them later (M50).
- The agents are **templates** built from the pack's skills: the weekly report, titles and
  descriptions, article drafts, forum watch, and (last) social posts. Their runs, schedules,
  budgets, approvals, activity and cost are the platform's own.

That gives the owner "manage mezonas.com first, then offer it to clients" without a second build:
the client version is the same pack enabled for another tenant, with that client's own site,
connections and claims list.

## 1. What carries over, and where it lands

| Plenary (bespoke) | Mezonas (already there, or the pack) | Notes |
|---|---|---|
| `marketing_agent` registry, `MARKETING_AGENT_KEYS` | Templates and client agents (§9.3), shipped by the pack | Versioned, forked, merged and promoted like every agent |
| Hourly dispatcher cron reading schedules | Schedule triggers (§10.8) | In the client's time zone |
| Monthly spend cap per agent, `llm_call` ledger | `budgets.maxCostUsd` per run (§9.1), `model_call`, usage per client and agent (§13) | A monthly cap per client agent: verify it exists before M47; if not, a small platform addition, not a pack table |
| `marketing_proposal` and its approval queue | `external_action` behind approval on the inbox and the Desk (invariant 8); drafts as the area's own records | Publishing is an external action; a draft is an internal record |
| `marketing_activity` (append-only) | The run log and `audit_event` (invariant 14) | |
| Weekly report screen | A pack report, linked from the client's Weekly Table (§11.4) | |
| Claims lint, `docs/marketing/claims.md` | The pack's `content.check` tool and the client's claims list (per client data, seeded for Mezonas) | Refuses, never just flags |
| Figures check ("every number came from the figures") | A deterministic check in the report skill's output validation | Model second (invariant 7) |
| `llm_purpose` values, `AI_PURPOSE_LABELS` | Skill ids on `model_call` | |
| Ops MCP scopes `marketing:read` | The ops MCP (`docs/plan.md` §1.34): read tools added after M44 | |
| Search import (`search/google.ts`, `bing.ts`) | Connectors `gsc` and `bing_webmaster` (`packages/connectors`) | Copy the request code, against fakes first |
| HN forum search (`marketing/forum.ts`) | Connector `hackernews`: read only, no auth | |
| Site beacon (`apps/site/src/analytics.ts`, `public/track.js`) | The pack's collector route plus a small script in each measured site | The pure parts copy across nearly as is |
| `site_article`, guides, sitemap, IndexNow | The pack's content tables; publishing through a `website` connector (§4.5) | |
| Staging traffic generator (`site/sample.ts`, `search/sample.ts`) | The pack's demo data (like `packs/materials/src/demo.ts`), on the Sandbox and on staging's Mezonas client | |

New on the platform side (each small, and each useful beyond marketing):

1. **Client zero**: a Mezonas client, created from the back office in each environment (not
   seeded), with delegated approvals and `settings.internal` (real data, never billed, no Weekly
   Table). Built in M43 (`docs/plan.md` §1.72).
2. **Web research tools** (`web.search`, `web.fetch`): article drafting needs them, Mezonas has none
   (`packages/llm` has no server-side tools today). Results are tool results, never instructions
   (invariant 9); the vendor is named in `packages/core/src/compliance` (invariant 14).
3. **Verbs a person always signs**: a connector manifest can mark a verb `approval: 'always'`
   (publish, post), so no matrix, step or mode can make it automatic. Invariant 8 already defaults
   to approval; this makes "nothing goes public unsigned" a rule in code, as Plenary's was.

## 2. What is different here (findings)

Each has a decision in §7 or a fix in the milestone that builds it.

| # | Finding | Consequence |
|---|---|---|
| F1 | **mezonas.com runs no code.** `apps/site` is static assets only; `/privacy`, the README and `docs/plan.md` §1.29 say "no analytics, no cookies"; nothing runs in the browser. | Measurement adds a small script to the site and changes the privacy policy. Stays cookie-free with no stored IP, as Plenary's (its G7: flag only, times to the hour, opt-out page, GPC and Do Not Track). The policy change goes through the lawyer with the rest (§1.29). Serving guides (M46) also gives the site Worker its first code. |
| F2 | **One site, two APIs, no production yet.** The site deploys from `main` for every environment; production has had no release. Events must reach the production database, and data can't be backfilled. | Owner decision (§7, D2). Default: the collector runs on production from the first `v*` tag; until then the script points at staging, and staging's figures are thrown away at the switch. Search Console needs none of this: it keeps 16 months and is imported on day one. |
| F3 | **The beacon would carry the app's cookie.** `mezonas.com` and `app.mezonas.com` are the same site, so a `sendBeacon` to the app's host sends a signed-in operator's session cookie. | The collector gets its own host, `collect.mezonas.com` (and `collect.staging.mezonas.com`), routed to `apps/api` outside `mount()` and its session middleware, and never reads a cookie. Verify the session cookie is host-only. Its own PR (a `wrangler.jsonc` route and DNS). |
| F4 | **For clients, their visitors become our data to keep.** A client's site analytics is that client's data under RLS, and Mezonas is its processor. | The terms and privacy policy gain processor wording before M50; a client in HIPAA mode (§1.35) has site measurement refused until the owner decides (a clinic's page views can be health data). No new vendor: Cloudflare and Neon only. |
| F5 | **No bot score** (Bot Management is Enterprise), as Plenary's G2. | Same method: count only views the script confirms, a user-agent list, a rate ceiling per visit hash; "filtered by heuristics". |
| F6 | **Referrer paths and competitor rankings** (Plenary's G3, G4). | Same answers: tagged links are the only reliable source per post; no rank tracking, so agents never claim anything about other sites. |
| F7 | **Reddit and Indie Hackers** (Plenary's G12). | Hacker News only; a person can paste any thread. |
| F8 | **No staging site.** | Staging's `website` connection is a fake (as every provider here starts); drafts are seen through preview links. A staging copy of the site is not needed. |
| F9 | **Model-written public text** is close to v1's "Out" list (model-written messages from agents other than Sloan). | Nothing here sends a message. Articles, titles and replies are drafts; publishing is an external action a person signs (an always-signed verb, §1); forum replies are posted by a person by hand. Recorded as an exception in v0.16. |
| F10 | **No claims list for Mezonas.** The site test bans "!" and "AI-powered"; nothing else is written down. | A first draft, `docs/marketing/claims.md`, for the owner (§8). Candidates: approval on by default; we never see a client's passwords; clients sign in to their own tools. Never: "HIPAA compliant", "SOC 2 certified" or customer names until true and agreed. |
| F11 | **What a sign-up is.** mezonas.com has no form: the goal is "Talk to us" (`#contact`) and the contact email. | The conversion is a tracked click on the contact links (`data-track`), until a contact form exists. A form would be its own change, with the same "flag only" rule. |
| F12 | **The marketing screens are not in the owner's prototype** (`docs/design/prototype.html`). | The Plenary design (`docs/design/marketing-portal.html` there) is the layout reference; screens are built from the Mezonas design system's classes and tokens. Ask the owner for a design pass before M44, or build from the brief. |

## 3. KPIs

Plenary's §2 carries over unchanged, with these differences:

| KPI | Here |
|---|---|
| Sign-up, sign-up rate | **Contact**: a tracked click on "Talk to us" or the contact email (F11) |
| Visit | Hash of (daily salt per site, IP, user agent); the salt is deleted after its day |
| Everything per site | Every figure is per site of a client (`site_id`, `tenant_id`) |
| Agent cost | `model_call` per client agent, as every agent's |

## 4. Architecture

### 4.1 The Marketing pack

`packs/marketing`, following `packs/materials`: `manifest.ts`, `schema.ts`, `tools.ts`, `api.ts`,
`reports.ts`, `demo.ts`, screens under `apps/web/src/packs/marketing/`. Its manifest declares:

- **Tables** (§4.3, §4.4, §4.5), all `tenant_id` + forced RLS + `cs_runtime` grants, comment
  `pack:marketing`.
- **Tools.** Reads (`none`): `site.figures` (a period's totals, pages, sources, with small samples
  marked), `site.page` (one page in depth), `search.figures` (queries, pages, "close to page one",
  "losing ground", with the date the data runs to), `content.get`, `forum.threads`. Internal:
  `content.draft` (a new draft version), `content.check` (the publish checks and the claims lint,
  pure), `report.record`. External, behind approval: `site.publish` and `site.meta` on the
  `website` connection; `linkedin.post` later.
- **Skills**: weekly site report, titles and descriptions, article draft (research then write),
  forum reply draft; each with its settings and test cases (§9.10).
- **Templates**: the agent set (§4.6). `// DECISION` to confirm: Materials ships no templates, but
  here the agent set is the point, so the pack ships them as template v1 rows.
- **Events**: `site.contact`, `search.imported`, `content.published`.
- **Screens**: §4.7.

### 4.2 Connections

| Connector | Auth | Tools and sync | Notes |
|---|---|---|---|
| `website` (built in) | None to measure; to publish, the target (§4.5) | Measures through the collector; `site.publish`, `site.meta` (always signed) | One per site. Its settings: the domain, the site key, the paths it may publish under |
| `gsc` | Service account key in the client's vault (default), later Google OAuth (`webmasters.readonly`) | Nightly sync: one `raw_record` per site, day and dimension set; the pack normalises into its tables | OAuth waits for Google's verification: an app in testing gets refresh tokens that end after 7 days. Add the scope to the verification already pending. (UNCHECKED whether Google counts it as sensitive) |
| `bing_webmaster` | API key in the vault | Nightly sync, as `gsc` | One key per Bing user |
| `hackernews` | None | Read: search and thread | Public; no key |
| `linkedin` (M49) | OAuth, Community Management API | `linkedin.post` (always signed) | Needs LinkedIn's approval of the app |
| `wordpress`, `webflow` (M50, for clients) | OAuth or application password | `site.publish`, `site.meta` | Only if a client asks |

The client signs in to its own tools (invariant 8); for Mezonas the owner does. Secrets stay in
the vault (invariant 13).

### 4.3 Measurement

```
page (inline script) ──sendBeacon──▶ collect.mezonas.com/e/<site key> ──▶ apps/api collector
                                      adds the visit hash, location, UA family, source;   │
                                      drops the IP and the user agent; ignores cookies     ▼
                                                                   site_event, site_visit (per tenant)
                                                                   nightly rollups and retention sweep
```

- The collector is a plain route in `apps/api` on its own host (F3): no session, a rate limit per
  site key, a 16 KB body cap, 204 always, and it never slows the page. The site key names the
  tenant and site; writes go through `withTenant()` for that client only.
- **Daily salt** per site in a table, deleted after its day, never derived from a secret.
- **Tables** (one migration, 0037): `site` (a client's measured site: domain, key, retention),
  `site_salt`, `site_event` (90 days), `site_visit` (13 months; `contacted` flag, no contact id,
  times to the hour), `site_daily_page`, `site_daily_source`, `site_daily_total`,
  `site_daily_click`, `site_bot_daily` (kept). From Plenary 0085 and 0086, with `tenant_id` and
  `site_id` added and `waitlist_attribution` left out.
- **As built (M43)**: the collector is a generic platform route, `POST /api/in/:pack/:tenantId/:target`,
  answering 204 to everything; the site's id is the target. Goals are a click on one of the site's
  goal elements. See `docs/plan.md` §1.72.
- **mezonas.com**: `build.mjs` inlines the script into the layout; tracked elements get
  `data-track` names (`hero-talk`, `nav-how-it-works`, `contact-email`, …), checked unique by
  `site.test.ts`; `/no-measure` (opt-out), Do Not Track and Global Privacy Control honoured; the
  privacy policy's measurement section (from Plenary's `privacy-draft.md`, rewritten for Mezonas).
- **For a client**: the same script as a snippet with their site key, shown on the site's
  connection page.

### 4.4 Search

The `gsc` and `bing_webmaster` syncs pull query × page × date and page × date, final data only,
idempotent per date, with 16 months of history the first time. Tables (migration 0038):
`search_query_daily`, `search_page_daily`, `search_source` (per connection: data runs to, last
error in our words). The raw records stay as the connector framework keeps them (§12.0 rule 3).

### 4.5 Content and publishing

- **Tables** (migration 0039): `content_page` (site, path, kind `guide`, fixed once published),
  `content_version` (immutable, like `skill_version`: title, description, Markdown body, target
  queries, who or which `agent_version_id`, why), `content_redirect`, and the client's
  `claims_list` (versioned; seeded for Mezonas from `docs/marketing/claims.md`).
- **Checks** (`content.check`, pure, shared by the editor and `site.publish`): title ≤ 60 and
  description ≤ 155 characters, one `h1`, internal links resolve, the claims lint, no "!" and no
  "AI-powered". A `refuse` blocks publishing.
- **Publishing mezonas.com**: `site.publish` writes the rendered page to R2
  (`mezonas-site-content`, production only), plus the sitemap; the site Worker serves `/guides/*`
  and `/sitemap.xml` from it (`run_worker_first` for those paths) and keeps the rest static. It
  pings IndexNow. If the API or database is down, the site still serves the last copy.
- **Core pages stay in git** (Plenary's 4c: decided later). The titles agent's proposals for a
  core page are recorded when signed, and a person opens the PR.
- **Preview links**: short-lived signed URLs, `noindex`.

### 4.6 The agent set

Templates in the pack, forked into the Mezonas client; each in rising order of risk.

| Agent | Trigger | Reads | Writes | Guardrails in code |
|---|---|---|---|---|
| Weekly site report | Schedule, Monday morning | `site.figures`, `search.figures` | A report record; three suggested actions with Done / Not now | Every number in the report must be in the figures it was given; "what we can't know" section |
| Titles and descriptions | Schedule, weekly | Search figures for pages with impressions and low CTR | Proposes `site.meta` (now and proposed) | Length limits; claims lint; at most N a day; always signed |
| Article drafts | Manual (with a topic) or weekly | Search queries, `web.search`, `web.fetch` | A `content_version` draft; never publishes | May cite only what its research found; claims lint; the person publishes |
| Forum watch | Schedule, every few hours; manual with a pasted thread | `hackernews` | A reply draft for a named person to post by hand | Opens with "I work at Mezonas"; no link to our site; no "!"; each thread once; never posts |
| Social posts (M49) | Manual | Published content, reports | Proposes `linkedin.post` | Company page only; always signed |

Each agent's model spend shows on the Mezonas client's usage like any client's. Marketing data
never reaches another client's agent (invariant 1), and forks of these templates carry no
Mezonas data (invariant 11).

### 4.7 Screens

Back office, `/ops/marketing/…` opening the Mezonas client (and `/ops/clients/:id/marketing/…` for
any client with the pack): **Overview**, **Pages** (one page in depth), **Sources** (campaign and
referrer in depth), **Journeys**, **Audience** (country table into regions and cities, day by
hour, device), **Visits** (one visit's timeline, its day only), **Search**, **Content** (editor,
checks, search-result preview, versions), **Weekly report**. Agents, runs and approvals are the
platform's own screens. Every screen: small samples and partial days marked, "data runs to" on
search figures, the privacy footer, the filtered-bot count, and phone width.

Portal (M50): Overview, Search and the weekly report, read only; Content approvals on the Desk.

## 5. Milestones

After M42 (P-9, purchasing end to end by email). Migrations, the collector's host and the
site Worker's first code each get their own PR (CLAUDE.md). Each milestone ends green.

| Milestone | What | Migration | Needs |
|---|---|---|---|
| **Phase 0** (owner, no code) | §8 | — | — |
| **M43** Measurement | Client zero; the pack skeleton and manifest; `website` connector; collector on its own host; the script, `data-track` names and `/no-measure` on mezonas.com; bot heuristics; nightly rollups and the retention sweep; privacy policy update | 0037 | D1, D2, privacy wording reviewed |
| **M44** Read screens | Overview, Pages, Sources; then Journeys, Audience, Visits; demo traffic on staging and the Sandbox; ops MCP read tools | — | A design pass or the brief (F12) |
| **M45** Search | `gsc` and `bing_webmaster` connectors against fakes, then live; 16 months of history; the Search screen | 0038 | Search Console and Bing set up (§8) |
| **M46** Content | Content tables, editor and checks, the claims list, `site.publish` and the always-signed verb, the site Worker serving `/guides/*` and the sitemap from R2, IndexNow, preview links | 0039 | Claims list reviewed |
| **M47** Agents 1 | The weekly report and titles templates; the figures check; the monthly cap if missing | — | M44, M45 |
| **M48** Agents 2 | `web.search` / `web.fetch` platform tools; article drafts; `hackernews` connector and the forum watch | — | M46 |
| **M49** Social posts | `linkedin` connector and the social posts template | — | LinkedIn's app approval |
| **M50** For clients | Enable the pack for a client: site key and snippet, the portal reports, processor wording in the terms and privacy policy, HIPAA refusal, Google OAuth for `gsc`, a CMS publishing connector if a client needs one | maybe | Google verification with the scope; legal |

Done for M43 when a week of mezonas.com data sits within a sensible band of Cloudflare's own
analytics and no IP address is in the database, Workers Logs or Sentry. Done for the agents when
each has run on replayed fixtures (`LLM_MODE=replay`) and on the live model within its budget, and
every proposal traces to its evidence and cost.

## 6. What to copy from Plenary Labs

Copied and renamed (no `@sfg/*` import, no shared resource):

| Plenary file | Here | Change |
|---|---|---|
| `apps/site/src/analytics.ts`, `public/track.js` | `packs/marketing/src/measure/` and the site's inline script | Add tenant and site; contact instead of waitlist |
| `apps/api/src/site/{events,rollup,jobs,sample}.ts` | Pack tools, rollup jobs, `demo.ts` | Run inside `withTenant()` |
| `apps/api/src/search/{google,bing,rows,store,sample}.ts` | `packages/connectors/src/{gsc,bing_webmaster}/` and the pack's normaliser | Through the connector framework, with fakes and `NOTES.md` |
| `apps/api/src/content/{checks,claims,markdown,indexnow}.ts` | `packs/marketing/src/content/` | The claims list is per client data |
| `apps/api/src/marketing/figures-check.ts`, `weekly-report.ts`, `titles.ts`, `articles.ts`, `forum.ts` | Skills and their output checks | Prompts become skill instructions; the checks stay code |
| `packages/schema/src/{site-analytics,marketing,content}.ts` | `packs/marketing/src/schema.ts`, API contract in `packages/core` | Zod at every boundary |
| `docs/specs/marketing-portal/privacy-draft.md` | `/privacy` measurement section | Rewritten for Mezonas, to the lawyer |
| QA specs `qa/features/{ops-marketing,site-analytics,search-import,site-content,marketing-agents}.qa.md` | Test cases and the API end-to-end checks | |

Not copied: `marketing_agent`, `marketing_agent_run`, `marketing_proposal`, `marketing_activity`,
the dispatcher cron and `MARKETING_APPROVERS`: the platform already has them (§1).

## 7. Decisions

Defaults apply until the owner says otherwise.

| # | Decision | Default |
|---|---|---|
| D1 | Measure mezonas.com at all (F1) | Yes: cookie-free, no stored IP, flag only, opt-out page, GPC and Do Not Track |
| D2 | Where mezonas.com's events go before production's first release (F2) | Staging until the first `v*` tag, then production; staging's figures are not carried over. Alternative: cut the first production release for the collector early |
| D3 | Build as a pack with Mezonas as client zero | **Decided** (owner, 2026-11-08): a pack; Mezonas a true client, worked from the back office |
| D4 | The pack ships the agent set as templates | **Decided** (owner, 2026-11-08): yes |
| D5 | Search Console auth for Mezonas | Service account key in the vault now; OAuth for clients once Google verifies the scope |
| D6 | Forums | Hacker News only |
| D7 | Rank tracking | None; no claims about other sites |
| D8 | Social | LinkedIn company page only, last |
| D9 | Core pages in the database | No; guides only. Core pages change by PR |
| D10 | Web research vendor for article drafts | The model vendor's server-side search and fetch (Anthropic), named in compliance |
| D11 | Retention | Raw events 90 days, visits 13 months, daily totals kept |
| D12 | Offering it to clients (M50) | After Mezonas has run it for a few weeks, and after legal review of the processor wording |

## 8. Owner tasks (phase 0)

Never paste a key into a chat or a commit; each goes into the vault or a Worker secret when its
milestone is built.

1. **Google Search Console, now** (it starts collecting the day it is verified): add a Domain
   property for `mezonas.com`, put its TXT record on the Cloudflare zone, verify. Submit
   `https://mezonas.com/sitemap.xml` once M46 is live.
2. **A Google Cloud service account** (before M45): enable the Search Console API, create the
   account (no project roles), make a JSON key, add the account to the property as Restricted.
3. **Bing Webmaster Tools** (after 1): import from Search Console, generate an API key.
4. **Review**: the claims list draft (`docs/marketing/claims.md`, written in M46, or before if you
   want to write it), and the privacy policy's measurement section (with the lawyer, with the
   other legal review already waiting).
5. **D2**: when production's first release happens, or whether to cut one early for the collector.
6. **DNS**: `collect.mezonas.com` and `collect.staging.mezonas.com` (M43's route PR says how).
7. **LinkedIn** (only for M49): a developer app owned by the company page, then the Community
   Management API.

## 9. What changes in the docs when approved

- `docs/ARCHITECTURE.md` v0.16: §1 scope (the Marketing area in, the F9 exception), §12.0's area
  table (Marketing, built), §12.5 the Marketing pack, §6 the four connectors, §5 the tables, §14
  the routes and the collector, §17 the new secrets and vars.
- `docs/plan.md`: §1.72 for these decisions, §4 M43–M50, §8.3 migrations 0037–0039.
- `docs/plan.md` §1.29 and `apps/site/README.md`: the site measures, and serves guides.
- `CLAUDE.md` status and layout (`packs/marketing`, the new connectors).

## 10. Risks

- **The privacy promise.** The site says "no analytics" today. The change must be true in the
  policy, the code and the logs on the same day (F1, F3).
- **Public text.** The always-signed verbs, the claims lint and the forum rules are code with
  tests, not prompts.
- **Small numbers.** mezonas.com's traffic will be small for a while: small-sample marks and
  partial days matter more here than in Plenary.
- **Scope.** Each milestone stands alone; M43–M46 are useful without any agent.
