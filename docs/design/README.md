# Design: v1 screens (starting point)

The owner's first design pass, built on the Groundwork design system. It is the starting point for the
UI, not a final spec: screens will be reworked as each page is built (owner, 2026-11-03).

| File | What |
|---|---|
| [`v1-screens.html`](v1-screens.html) | The design itself: a self-unpacking page with seven screens (open it in a browser). |
| [`screens/`](screens/) | A 1440×1000 capture of each screen, for reading without a browser. |
| [`tokens.css`](tokens.css) | The 137 Groundwork tokens the screens use (colour, type, spacing, radii, shadows, sizes). M0 copies them into `apps/web/src/styles/tokens.css`. |

## What the screens show

All seven are **back-office screens inside one client** (the `[Client] Millwork ▾` switcher in the
header). The client portal is not designed yet.

| # | Screen | Capture | Maps to (ARCHITECTURE §15) |
|---|---|---|---|
| 1 | Home: agents live, tasks done, updates to your tools, waiting on you; your agents as cards (live/draft, steps, version, tools, last run); needs you; latest updates to your tools | [1-home](screens/1-home.png) | Client overview in the back office (`/ops/clients/[id]`) |
| 2 | Connections: connected tools with sync state and "used by"; **a permission matrix per tool** (read / create / update / delete: auto, approval or off, plus scope); available connectors | [2-connections](screens/2-connections.png) | Client connections; §6, §9.5 |
| 3 | Skills library: categories (documents, data, writing, actions, custom), in → out, tools, used by; "Make a skill" with the Builder; skills are versioned and pinned | [3-skills](screens/3-skills.png) | `/ops/skills`; §9.2 |
| 4 | New agent: describe the job, tools it may use, how it starts, who approves; start from my description (Builder), blank, or a template; suggested workflow | [4-new-agent](screens/4-new-agent.png) | New client agent / fork; §9.3, §9.6 |
| 5 | Workflow builder: **a vertical list of numbered steps**, drag to reorder; **forks with ordered paths** (first rule that matches wins, then "otherwise"), paths join after the fork; palette of triggers, skills and actions; inspector with path rules | [5-workflow-builder](screens/5-workflow-builder.png) | The builder; §10 |
| 6 | Run: what it did (checked steps by type: trigger, skill, person, action), **changes to your tools with now / after this change**, approve and update, run cost | [6-run](screens/6-run.png) | Back-office run view; §10.3, §11 |
| 7 | Agent overview: live version, how it works (step chips), KPIs, what it found (Materials price alerts), works in, skills it uses, latest changes it made; tabs Overview / Workflow / Runs / Versions / Settings | [7-agent-overview](screens/7-agent-overview.png) | Client agent page; §9.3, §12 |

## Where the design and owner changed the architecture (v0.7–v0.8)

1. **Workflows are structured step lists, not free-form graphs.** Steps run top to bottom; a **fork** has
   ordered paths, each with rules (`field op value`, joined by and/or), plus "otherwise"; paths join after
   the fork. Step kinds: trigger, skill, action (changes a tool), person (ask or approve), fork, wait,
   notify. The builder is a nested, sortable list (drag and drop), so React Flow is no longer needed.
   Merging client customizations is simpler too: steps are matched by id, with no positions to reconcile.
2. **Each connection has a permission matrix** set per client: for each of read, create, update and
   delete, `auto`, `approval` or `off`, plus a scope (e.g. "AP folder only"). For writes it is a ceiling.
   **Approval is on by default and set per step** (owner, v0.8): a step that changes a tool waits for a
   person unless the operator switches its approval off, which is only offered where the connection
   allows `auto`. So the design's "automatic" counts only appear once the operator has chosen them.
   Every write is recorded with its before state, whether automatic or approved.
3. **Connections live in the client portal** (owner, v0.7): the screen-2 layout becomes a portal page
   where the client signs in to its own tools; the back office shows it with offering, permissions and
   configuration.
4. Agent avatars use the Groundwork persona colours; AI suggestions (the Builder) use the `--ai-*` tokens.

## In the design, not yet in v1 scope (decide when we get there)

- Connectors: Slack (later, owner), Google Drive (file PDFs), Ramp, bank accounts, Outlook, HubSpot. The
  MVP is QuickBooks plus upload with email forwarding (the design's "Upload and forwarding"); Gmail
  follows.
- Command bar "Ask an agent, or type / for a command" in the header (v1 has `/skill` commands in threads).
- Agents beyond Materials: Invoice intake, Collections follow-up, Card receipts.
- Platform name: still `[Platform name]`.
