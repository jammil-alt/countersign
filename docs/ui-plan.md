# UI plan: the owner's prototype, page by page

Status: **UI-0 to UI-4 built and on staging** (2026-11-06). See [Status](#status) at the end. Source: [`docs/design/prototype.html`](design/prototype.html), the owner's clickable prototype (open it in a browser; hash routing, `#Start` lists every screen). It is built on the Mezonas design system's tokens (`packages/design-system/tokens.css`), with sample data for Harbor Millwork.

The API for almost everything here exists already (built "API first", `docs/plan.md` §8). This plan turns it into screens. It replaces the rule "UI only where a screen would break" (plan §8.1) for the pages listed below.

## Rules for every page

- **Design system only:** tokens and component classes (`ds-*`, `dt-*`, `mz-*`). The prototype's inline styles and helpers (`card`, `stack`, `g16`, `title`) become token-based classes in `apps/web`; no raw hex colours, no new colours, fonts, radii or shadows. Light and dark themes both work.
- **Colour meanings:**
  - slate: brand, actions, selection;
  - copper: people (the lead, sign-offs, person steps);
  - gold: waiting on you, always with a word;
  - risk: errors;
  - positive: done.

  Agents' work stays ink.
- **Voice:** plain words, sentence case, "we" and "you", the result and its number first.
- **Languages:** every new portal string in all six languages, the five non-English ones flagged for a fluent review. Back office strings are English.
- **Real data only.** Each page reads the existing routes in `packages/core/src/api/*`. Where the prototype shows something no route serves, the page leaves it out and lists it under "Not served yet" in its PR; it never fakes data.
- **Invariants hold** (CLAUDE.md): no portal page shows bundles, instructions, prompts or cost; secrets are never shown; approval stays on by default; client isolation as today.
- **Tests:** a Vitest + Testing Library test per page (renders with the API mocked, main action works), and the route sweep (#141) covers every route. Old routes redirect to their new home; none 404s.

## The 20 screens in the prototype

### Client portal

Sidebar (as QA round 1 left it, 2026-11-07):
- The Table
- Your Desk (count; the only place it is linked, the top bar has no Desk link)
- Runs
- Your agents (one row each, with status)
- Your business: Accounts, People, Settings
- More (folded): Records; Knowledge and Conversations for the client admin
- Sloan
- Your Mezonas lead

| # | Screen (prototype id) | Route | Replaces today | Main APIs |
|---|---|---|---|---|
| C1 | The Table (`#Main`) | `/` | Overview, Service | the Table, KPIs, credits, go-live stages |
| C2 | Agent, e.g. Pia (`#C2-Agent`) | `/agents/:slug` | `services/:id` | run controls (pause, resume), output, access, latest changes |
| C3 | Your Desk (`#C3-Desk`) | `/desk` | `inbox` | inbox: sign, send, not now, undo, edit, batch, snooze |
| C4 | Accounts and vault (`#C4-Accounts`) | `/accounts` | `connections`, `access`, `access release` | connections, permission matrix, grants, vault (write-only), browser logins, human release |
| C5 | People (`#C5-People`) | `/people` | `contacts`, `directory`, `people` | directory, contact autonomy, voice samples |
| C6 | Sloan (`#C6-Sloan`) | `/sloan` | none | threads, the account agent, `/commands` |
| C7 | Settings and billing (`#C7-Settings`) | `/settings` | `settings`, `billing`, approver rules | settings, statements, credits, sign-off limits (approver rules) |
| C8 | Weekly Table (`#C8-Weekly`) | `/?view=weekly` (a tab of The Table; `/weekly` redirects) | none | Weekly Table (Friday draft, Monday send) |
| C9 | Runs (`#C9-Runs`) | `/runs` | `runs` | runs |
| C10 | Run detail (`#C10-RunDetail`) | `/runs/:id` | `runs/:id` | run timeline, changes with before and after, audit trail |

### Back office

Sidebar:
- Command center
- Escalations (count)
- Runs
- Clients (one row each, with count)
- Build: Agent lab, Skills and automations, Connectors
- Business: Usage and billing, Feedback

| # | Screen (prototype id) | Route | Replaces today | Main APIs |
|---|---|---|---|---|
| O1 | Command center (`#O1-Command`) | `/ops` | ops home | command center, ⌘K search |
| O2 | Agent lab (`#O2-Lab`) | `/ops/lab` | `templates` | templates, forks, versions, update merges, promotions |
| O3 | Connectors (`#O3-Connectors`) | `/ops/connectors` | `connectors` | connectors catalog, offers per client |
| O4 | Skills and automations (`#O4-Skills`) | `/ops/skills` | `skills` | skills, automations |
| O5 | New agent, by conversation (`#O5-NewAgent`) | `/ops/clients/:id/agents/new`, `/ops/templates/new` | the old new-agent form | the Builder conversation (#133) |
| O6 | Workflow builder (`#O6-Builder`) | `/ops/…/agents/:slug/workflow` | today's builder | workflow schema and validator, Builder chat |
| O7 | Triggers (`#O7-Triggers`) | `/ops/…/agents/:slug/triggers` | none | the six trigger kinds |
| O8 | New skill (`#O8-NewSkill`) | `/ops/skills/new` | the old skill form | skill drafts from examples, test cases |
| O9 | Runs (`#O9-Runs`) | `/ops/runs` | `runs` | runs across clients, failures, retries |
| O10 | Run detail (`#O10-RunDetail`) | `/ops/runs/:id` | `runs/:id` | run, raw data, oversight decisions, checkpoints, model calls |

## Pages the prototype doesn't show (drafted in its style, for the owner to adjust)

These exist today, or the API serves them, but they aren't in the prototype. We draft each in the prototype's style, and the owner adjusts on staging.

### Client portal

| Page | Route | Why it's needed |
|---|---|---|
| Records and record detail (with receivables) | `/records`, `/records/:id` | already live; receivables have an API but no screen |
| Documents: detail and upload | `/documents/:id`, `/upload` | linked from runs and records; upload is how invoices arrive |
| Reports (pack reports, e.g. Materials) | `/reports/*` | pack screens; reachable from the agent page |
| Requests | `/sloan?mode=change` (`/requests` redirects) | the client asks us for a change: Sloan's "Ask for a change" |
| Knowledge | `/knowledge` | what agents know about the business |
| Conversations (WhatsApp capture) | `/conversations` | keep and download switches per conversation (M33) |
| Team | `/settings/team` | invite members, roles (the Desk's team API) |
| Exports | `/settings/exports` | accountant export and audit export (client admin) |
| Connect flows | `connections/:connector/callback`, Sheets picker, WhatsApp signup, access release | keep working; restyle only |
| Sign-in | `/sign-in` | restyle to match |

### Back office

| Page | Route | Why it's needed |
|---|---|---|
| Escalations | `/ops/inbox` | in the sidebar, with no screen in the prototype |
| Client page | `/ops/clients/:id` | what a client row opens. Tabs: overview and go-live stages, agents, connections, messaging and conversations, knowledge, directory, documents, records, settings, exports |
| New client (onboarding) | `/ops/clients/new` | creating a client and inviting its admin |
| Update merge | `/ops/agents/:id/merge` | template updates into a client agent; inside Agent lab |
| Test bench | inside the agent page | test cases and test runs before publish |
| Agent page (back office) | `/ops/clients/:id/agents/:slug` | overview, versions, publish, activate, settings, around O6 and O7 |
| Usage and billing | `/ops/usage`, `/ops/billing` | in the sidebar, with no screen in the prototype |
| Feedback | `/ops/feedback` | in the sidebar, with no screen in the prototype |
| Audit log | `/ops/audit` | compliance (SOC 2, HIPAA) |
| Website logins | `/ops/browser-sites` | allowed sites for browser connections |
| Requests (all clients) | `/ops/requests` | clients' change requests |

## Waves

Each wave is a set of parallel streams, each stream one PR, merged on green in order.

| Wave | Streams | Notes |
|---|---|---|
| UI-0 | **Shell**: both sidebars and top bars, ⌘K search, the client and agent switchers, theme, shared page parts (cards, stat tiles, status chips, step list, before/after diff) as design-system classes; the new route map with redirects | Everything else builds on it; merges first |
| UI-1 | **Client**, four streams: (a) The Table and the agent page; (b) Desk; (c) Accounts and vault, People; (d) Runs, run detail, Weekly Table, Settings and billing, Sloan | |
| UI-2 | **Back office**, four streams: (a) Command center, Escalations, runs and run detail; (b) Agent lab, update merge, back-office agent page, test bench; (c) New agent, workflow builder, triggers; (d) Skills and automations, new skill, Connectors | can run alongside UI-1 |
| UI-3 | **Pages not in the prototype**, three streams: client extras; back-office client page and new client; usage, billing, feedback, audit, website logins, requests | drafts for the owner |
| UI-4 | Playwright end-to-end through the UI (the two walkthroughs, `#Start`), route sweep, both themes, phone width | |

## Open for the owner

1. Where requests live: their own page, inside Sloan, or on the Desk.
2. Whether "Accounts and vault" also holds the permission matrix, or the matrix stays on each connection's own page.
3. The back-office agent page: one page with tabs (Overview, Workflow, Triggers, Runs, Versions, Tests, Settings), as in v1 screen 7.
4. The phone layout: the prototype is desktop. We make every page usable at phone width unless you say otherwise.

## Status

UI-0 to UI-3 are merged to `main` (staging). No migrations; one small contract change (#163: portal inbox items carry the agent asking, `service: {id, name}`).

| Wave | Stream | PR | Pages |
|---|---|---|---|
| UI-0 | Shell, routes, shared parts | #157 | both shells, ⌘K search, switchers, theme, route tables (`apps/web/src/{portal,ops}/routes.tsx`), redirects, `apps/web/src/ui` parts |
| UI-1 | a | #160 | C1 The Table, C2 agent page |
| UI-1 | b | #163 | C3 Your Desk |
| UI-1 | c | #161 | C4 Accounts and vault, C5 People |
| UI-1 | d | #159 | C6 Sloan, C7 Settings, C8 Weekly Table, C9 Runs, C10 run detail |
| UI-2 | a | #162 | O1 Command center, Escalations, O9 Runs, O10 run detail |
| UI-2 | b | #158 | O2 Agent lab, update merge, back-office agent page (tabs), test bench |
| UI-2 | c | #165 | O5 New agent by conversation, O6 workflow builder, O7 Triggers |
| UI-2 | d | #164 | O4 Skills and automations, O8 New skill, O3 Connectors |
| UI-3 | a | #167 | records and receivables, upload, documents, reports, requests, knowledge, conversations, team, exports, connect flows, sign-in |
| UI-3 | b | #168 | back-office client page (ten tabs), clients list, new client |
| UI-3 | c | #166 | usage and billing, feedback, audit log, website logins, requests |
| UI-4 | End to end | #171, #173, #174 | the two walkthroughs on seeded data in light and dark, desktop and phone, read-only except signing and undoing the e2e Desk item (seeded only with `SEED_E2E=1`, never on staging); run by CI's `sweep` job |
| Follow-ups | | #170, #172 | this status; 10 s first-load waits in tests, long words wrap in the Builder chat |

### Decisions taken (owner to adjust)

- Open question 1: Requests is Sloan's "Ask for a change" (`/sloan?mode=change`); `/requests` redirects there (QA round 1; it was its own page until then).
- Open question 2: each connection's permission matrix sits on Accounts, folded, one per tool; approver rules live in Settings ("Sign-off").
- Open question 3: the back-office agent page is one page with tabs (Overview, Workflow, Triggers, Runs, Versions, Tests, Settings).
- Open question 4: every page is built to work at phone width; UI-4 checks it.
- Portal agent addresses are `/agents/:id` (service id): no portal route serves a slug.
- Theme (light, dark, system) is kept per browser.
- Client users see Settings (their own notifications, language, approver rules); company sections stay admin-only.
- The matrix keeps the app's Auto / Approval / Off words and colours: gold is kept for "waiting on you".
- New agent and new skill start as a Builder conversation; the by-hand skill form stays while model keys are missing.
- Usage and Billing share the "Usage and billing" heading with tabs.
- Offering a connector to a client lives on Connectors (owner: also on the client's Connections page?).

### QA round 1: navigation and fewer places (2026-11-07, `claude/qa-nav-simplify`)

The owner's first click-through as a client asked for one home per thing. Every old address still lands (a redirect keeps its query and hash, and merges it with the new home's own: `/weekly?week=…` → `/?view=weekly&week=…`).

- **Sidebar:** The Table, Your Desk, Runs; Your agents; Accounts, People, Settings; a folded More with Records (and Knowledge and Conversations for the admin); the Sloan card and the lead.
- **Your Desk once:** the portal's top bar has no Desk link; on a phone the menu button carries the waiting count. The back office keeps Escalations in its top bar.
- **Weekly Table:** a tab of The Table (`/?view=weekly`), shown only once a week was sent; the tab is its one button (the header and agent-page buttons are gone). `/weekly` redirects.
- **Reports:** no sidebar item; the agent page links its activity and pack reports; `/reports/*` works as before.
- **Billing:** only under Settings (`/settings/billing`); `/billing` redirects.
- **Upload:** one entry, Records' "Upload documents" (`/upload`). Accounts keeps the forwarding address with a link to Records.
- **Contact:** Sloan is the one place to ask: "Ask Sloan" and "Ask for a change" are its two tabs. The Feedback button reads "Report a problem with the app".
- **People:** People and Organizations are the tabs; consent and messages, who agents reach, voice samples and import sit behind the page's More menu, for the admin only.
- **Settings:** Notifications is hidden until we send these emails (`emailsOn`); Language saves as it is chosen.
- The route sweep also opens views chosen by a query (`/?view=weekly`, `/sloan?mode=change`); the client walkthrough follows this sidebar (Weekly Table tab, People's More, Billing in Settings, Records then Upload documents, Ask for a change).

### Not served yet (the prototype shows it; no route serves it, so the page leaves it out)

- **The Table, agent page:** each agent's role line and why it's still setting up; relative times; price-change and time-spent tiles; receipts on latest entries; Desk items due today.
- **Desk:** a Messages view and the lead's replies; "Sign from your phone"; a period filter; the summary table across customers; undoing "Not now".
- **Accounts, People:** "Changes this week"; who connected a tool; which agents use each record type; a person's tags and reachable hours; which agent sent each message; "Agents in touch" for client users.
- **Runs, run detail (portal):** what happened on each run, who started it, how many changes; a "Changed my tools" tab; a "Signed by" filter; the workflow name, version and checker; a Documents tab; before state of changes already made.
- **Weekly Table:** money figures; a portal view of the lead thread. **Settings:** plan price, next invoice, payment method, per-agent credits. **Sloan:** linking a drafted change to its message; "Message Ana".
- **Command center, runs (back office):** client leads; each agent's step and step count; template versions; "Open as client"; total counts and quick-view counts; Slow view; Tries; Compare; version per run; Documents tab and per-run audit; client-view switch; which connection failed; "Ask client to reconnect".
- **Agent lab:** where a template came from; editing a template's client view; cost per run over the last 100 runs.
- **Builder, triggers:** "Draft the new skill"; quick replies; per-connector access levels and names; inline approval on step cards; a client's hooks for the operator (URL, last payload, test send); the agent's text and WhatsApp number; per-trigger on/off.
- **Skills, connectors:** New automation outside the builder; test results on skill cards; a Beta status; used-by split; numbered decision rules; "Copy from a skill"; New connector; health checks; manifest version; named error causes.
- **Client extras:** a receivable's own page and totals owed; a customer's organization page; changing a person's role or removing someone; paging documents past the latest 20.
- **Back-office client page, business:** opening a thread; health over time; cost and runs per agent; billing history and trends; counts for Feedback and Requests.

### Translations to review

Every new portal string is in all six languages; es, fr, it, de and pt-BR need a fluent read (each PR lists its strings). Least sure: "The Table", "Your Desk", "Your sign", "No extra limit", "Voice samples", "Vault".
