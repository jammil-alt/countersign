# UI plan: the owner's prototype, page by page

Status: **draft for the owner to adjust** (2026-11-06). Source: [`docs/design/prototype.html`](design/prototype.html), the owner's clickable prototype (open it in a browser; hash routing, `#Start` lists every screen). It is built on the Mezonas design system's tokens (`packages/design-system/tokens.css`), with sample data for Harbor Millwork.

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

Sidebar:
- The Table
- Your Desk (count)
- Runs
- Your agents (one row each, with status)
- Your business: Weekly Table, Accounts, People, Settings
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
| C8 | Weekly Table (`#C8-Weekly`) | `/weekly` | none | Weekly Table (Friday draft, Monday send) |
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
| Requests | `/requests` | the client asks us for a change; could live inside Sloan or the Desk (owner's call) |
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
