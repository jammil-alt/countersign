# Connectors: one place for the client, access set by what agents need

> **Status (2026-11-26): Done.** C1–C6 built (§1.161, migration 0070); "Nothing here is built yet" below is out of date. Least-access grants (§5.5) are open: `docs/open.md` §9.

Agreed by the owner (2026-11-20): the design and the seven decisions in §10 as recommended, plus
§7.1 (our changes go to the client to approve) and §7.2 (the client may authorize them in advance). Nothing here is built yet. The decisions go into
`docs/plan.md` §1 and the build into its milestones (§9 below).

## 0. What the owner asked

- The client gets **one Connectors item**: sign in to any connector we have, and set what agents may
  read and change there. It is the only connector screen a client sees.
- A **Built for you** section for connectors we make for that client alone, when they use a tool we
  don't cover.
- When we set up a template or a client agent, we know whether the client has the connectors it needs,
  or whether connecting them and allowing access is part of that agent's onboarding.
- **No agent yet: a low-risk start.** Mostly read; write only where it makes sense. One reviewed
  default per connector.
- **Connecting for an agent: exactly what it needs.** Already connected: check the access and say
  what to change.
- **Tools and skills say what they need** (read or write, on which record type), so an agent's
  minimum access is worked out, never guessed.
- Clean, and close to Claude's own connector flow: a directory, a Connect button, the provider's
  sign-in, then a page of what the connector may do, grouped into reading and changing.

## 1. What we have today

Most of the parts exist. They are spread over three screens and two rules get in the way.

| Part | Where | State |
|---|---|---|
| The client's connections | Portal **Accounts** (`/accounts`, `apps/web/src/portal/screens/Accounts.tsx`) | Connected tools as rows, each opening its matrix, the agents using it and each agent's grant; a right rail with the vault (website logins, API keys) and the tools still to add, grouped by kind (`connections/groups.ts`). |
| Which connectors a client sees | `tenant.settings.connectors_offered` (`apps/api/src/routes/portal.ts`) | **Only offered ones**, plus upload and anything already connected. The operator must offer each connector first. |
| Connect cards during onboarding | Portal **Getting started** (`GettingStarted.tsx`) | Its own cards, reusing `startConnect`. Shows "connected", nothing about access. |
| What an agent may do | Portal agent **Settings** tab (`Agent.tsx`, "agent-reach") | Effective level per verb on each bound connection, read-only. |
| The matrix | `connection.permissions` (`packages/core/src/schemas/permissions.ts`) | Per verb `auto` / `approval` / `off`, plus per record type (`entities`) and scopes. For writes it is a ceiling. |
| Starting matrix | `ConnectorManifest.defaultPermissions`, the catalog's "default access for new clients" (`connector_setting`) | Platform fallback: read `auto`, create and update `approval`, delete `off`. **Writes start at Needs approval everywhere**, not off. |
| Grants | `agent_grant` (`packages/core/src/permissions/grants.ts`, ops `GrantsPanel.tsx`) | The binding is the grant; limits only narrow it (per verb, per record type, a tool subset). |
| What a tool needs | `ToolSpec`: `verb`, `entity`, `connector`, `sideEffect` | Complete for connector tools. |
| What a skill needs | `SkillDefinition`: `tools`, `reads`, `requiresConnectors` | `requiresConnectors` names a connector but **not the verb or record type**. |
| What a step and a draft need | `process/data-use.ts`, `setup/checklist.ts` (`draftWriteUses`) | Per step: connectors and packs. Per draft: where it writes. Words for the builder; not a gate, not compared with the client's matrix. |
| Onboarding items | `SetupItem` kind `connect` (`setup/item.ts`) | Done when the connector is **connected and bound**. Access is not checked. |
| Custom work for one client | Website logins with recorded scripts (`browser`), webhooks (`docs/connect-zapier.md`), the Dev queue (§1.125) | No idea of a connector that exists for one client only. |

Two rules shape the design:

1. **"The client may tighten, never loosen"** (ARCHITECTURE §6.1, invariant 8). With a low-risk start
   that leaves writes off, a client could never turn on what their own agent needs.
2. **Offered only.** A client can't see what we have unless we offer it first.

## 2. The design in one paragraph

The portal's **Accounts** becomes **Connectors**. It has three parts: **Connected**, **Built for you**
and **Browse** (every live connector, grouped by kind, with a search). Each connector opens to one page:
Connect (the provider's sign-in), then **What agents can do**, split into **Read** and **Change** like
Claude's read-only and write tools, a row per record type. A new connection starts from the
connector's **low-risk default**. Each agent has a computed list of **needs** (connector, record type,
verb), built from its steps' tools and skills. Where a need isn't met, the connector's page shows
it in gold with one button: **Allow what Buyer needs**. Getting started, the agent's page and the back
office all open this same page; none has its own connect flow.

## 3. The client screens

A mockup of these is in `docs/design/connectors.html`.

### 3.1 Connectors (`/connectors`, in the sidebar where Accounts is)

- **Header**: "Connectors". Subtitle: "The tools your agents work in. You sign in; you decide what they
  may read and change."
- **Needs banner** (signal, with words), only when an agent is waiting: "2 agents need something from
  you · Buyer: connect QuickBooks · Bookkeeper: allow creating deposits". Each opens the connector's
  page with that agent picked.
- **Connected**: one row per connection: mark, name, account (company or address), status chip,
  "Used by Buyer, Bookkeeper", a one-line summary of access ("Reads 9 · changes 3 with your
  approval"). A broken one says so in risk with "Sign in again".
- **Built for you**: connectors made for this client alone (§6), and the websites an agent signs in to
  for them. Last card: **Ask for a connector**: "Use a tool we don't list? Tell us which and what the
  agent should do there." It opens a Request to the client's lead (§1.124).
- **Browse**: every connector that is live for this client, grouped as today (Money, Email, Messages,
  Files, Sales, Web, Other), with a search box. **Recommended for you** first: what we offered, and
  anything an agent needs. Each card: mark, name, one line, how it connects ("You sign in" / "You
  enter a key" / "Nothing to sign in to").

### 3.2 A connector's page (`/connectors/:connector`, a page, not a modal)

Not connected:

- Mark, name, what it does in one or two lines, **Connect** (slate, primary).
- **What it can do once connected**: the Read and Change lists below, showing the low-risk default, so
  the client sees before signing in what agents will be allowed.
- Who may connect it: a client admin; a person's own account (Gmail) any client user, as today.

Connected:

- Account, status, last sync, **Disconnect**, **Sign in again**; the tool's own setup (Slack channels,
  Sheets, webhooks) as today.
- **What agents can do**, two groups, each with a group-level control like Claude's:
  - **Read** — group control *On* / *Off*. A row per record type: "Bills", "Vendors",
    "Invoices"… each On or Off. (Reads are never "ask first": a read either runs or doesn't.)
  - **Change** — group control *Ask me first* / *Off* (and, where we have set it, *On its own*,
    see §5.3). A row per record type and verb in plain words: "Create bills", "Update bill lines",
    "Add notes to invoices", "Send email". Each row: *Ask me first*, *Off* (*On its own* shown only
    where it may be chosen).
  - Each row folds open to the tools behind it and the agents that use it.
  - **Delete** never appears: it stays off.
- **Used by**: each agent bound to it, with "Has what it needs" (positive) or "Needs: create purchase
  orders" (signal) and the fix button.
- **History**: who changed what and when (`connection_change`, already kept).

With an agent picked (`/connectors/qbo?for=<agent>`), the rows that agent needs are marked "Buyer
needs this", and a gold strip at the top says what's missing with one button: **Allow what Buyer
needs**. It sets exactly those rows, no more, and records who allowed it.

### 3.3 Everywhere else opens this page

- **Getting started**: a Connect card says "Connect QuickBooks for the Buyer" and opens
  `/connectors/qbo?for=…`. Done when connected **and** the Buyer's needs are met.
- **The agent's page** (portal): its Settings tab lists "Connectors this agent uses" with
  Ready / Needs something, each opening the connector's page with the agent picked. The per-verb
  grid there goes (it lives on the connector's page).
- **The vault** stops being a rail: website logins are rows of **Built for you**; an API-key
  connector's key is entered on its own page. The vault stays the store, not a screen.
- `/accounts` and `/accounts#vault` redirect to `/connectors`.

## 4. What tools and skills need

### 4.1 Tools: already enough

A connector tool already says `connector`, `verb`, `entity` (or `entityInput`) and `sideEffect`.
That is the need: `qbo.bill.create` needs *create bills on QuickBooks*. No change.

### 4.2 Skills: say the need, not only the connector

`requiresConnectors: string[]` says "QuickBooks" but not what on it. Add:

```ts
// SkillDefinition, optional so stored versions parse; replaces requiresConnectors for new ones
needs: z.array(z.object({
  connector: z.string(),
  verb: Verb,
  entity: EntityId.optional(),     // absent: the connector's verb as a whole
  why: z.string().max(200),       // "to read the vendor's last bills"
})).max(30).optional()
```

- A skill's needs are **its tools' needs** (from `tools` and `reads`) plus any it declares in `needs`
  (a skill that reaches a connector some other way: through a channel, a pack tool). Code works them
  out; nobody types the ones a tool already says.
- A stored skill with only `requiresConnectors` reads as "read on that connector" (the least it can
  mean). A test fails any built-in skill whose `requiresConnectors` isn't covered by its tools or
  `needs`.
- The Library shows them: on a skill, "Needs: QuickBooks · read bills, vendors · create bills".

### 4.3 An agent's needs: computed, never stored

A pure function in `packages/core/src/permissions/needs.ts`, beside `data-use.ts`:

```ts
agentNeeds(bundle, typing) → ConnectorNeed[]
// ConnectorNeed = { connector, entity?, verb, level: 'on' | 'ask' | 'auto', because: StepRef[] }
```

- Walks every step (as `data-use.ts` does), takes each step's tools and skill needs.
- `level`: a read needs **on**; a write needs at least **ask** (Needs approval); a write step the
  operator set to run without approval, in an agent in `act` mode, *wants* **auto**. "Wants" is shown
  as a suggestion, never as a blocker: the step still runs, asking first.
- Templates have needs too (the same function on the template's bundle).

### 4.4 Checking a client: gaps and fixes

```ts
accessGaps(needs, { connections, grants }) → Gap[]
// Gap = { connector, kind, need, fix }
// kind: 'not_connected' | 'broken' | 'not_bound' | 'off_on_connection' | 'off_in_grant' | 'scope_excludes'
```

Each gap names its fix in words and who can make it: the client (connect, sign in again, allow a
row), or us (bind the connection, widen the grant). The same function feeds the portal's gold strip,
the agent's Settings tab, Getting started, the back office's readiness panel, and the setup guard.

## 5. Permissions

### 5.1 No agent yet: the low-risk default per connector

Each connector's manifest gets a reviewed `defaultPermissions` with `entities`: **reads on, writes
off**, except writes that are low risk and that a client expects on connecting, which start at
**Ask me first**. Delete stays off. The platform fallback for a connector without one changes from
"create and update ask first" to "**writes off**".

The proposal for the main connectors (to review with the owner, one line each):

| Connector | Read | Starts at Ask me first | Starts Off |
|---|---|---|---|
| QuickBooks | everything | attach a document; add a note to an invoice | create bills, purchases, vendors, POs, deposits, transfers, accounts, classes, locations; update lines, memos, item costs |
| Gmail / Outlook | — (send only) | send email | — |
| Slack, Teams, Google Chat | channels it's added to | post a message | — |
| Google Drive / OneDrive | the folders chosen | add a file | update a file |
| Google Sheets / Excel | the sheets chosen | add rows | update rows |
| BILL | everything | attach a document | create or update bills and vendors; **payments** |
| Ramp | everything | upload a receipt | — |
| HubSpot / Zoho CRM | everything | add a note or task | create or update records |
| Stripe | everything | — | everything else |
| Bank feed (Plaid) | everything | — (read only) | — |
| Twilio / WhatsApp | — | send a message | — |
| Google / Outlook Calendar | everything | create an event | update an event |
| Podio / Odoo | everything | add a comment, note, task or activity | create or update records, confirm, post or validate |
| Webhooks / Resend | — | send an event / send email | — |
| Desktop app | the folders given | add a file; add rows | — |
| Website, LinkedIn, website logins, Search Console, Bing, Hacker News, upload | everything | — (read only) | publish, post or submit |

Rule of thumb: on by default to **ask first** only if a wrong one is cheap to take back (a note, an
attachment, a message a person reads first). Anything that moves money, creates a record in the books
or changes one someone else made starts off.

The catalog's "default access for new clients" (operator-set) still overrides the manifest's.

Built in C2: each manifest's `askFirst` rows, with the reviewed list held as a snapshot in
`apps/api/src/connector-defaults.test.ts` (`docs/plan.md` §1.161).

### 5.2 Connecting for an agent

When the connection is made from an agent's need (`?for=<agent>`), it starts from the low-risk default
**plus the agent's needs** at their minimum level (reads on, writes ask first). The page shows the
added rows as "Turned on for Buyer" before the client signs in, so nothing is a surprise.

### 5.3 Already connected: check and suggest

Adding or updating an agent (a fork, an update merge, a new version) runs `accessGaps`. Each gap
shows on the connector's page, the agent's page, Getting started and in the back office, with its
fix. The client's fix is one button that sets exactly the missing rows. An agent with a gap in a
read or write it needs is held at its current stage (the setup guard, §5.5) and its runs say why
when they reach that step ("Needs: create purchase orders on QuickBooks").

### 5.4 Who may change what (an invariant change, for the owner)

Today a client may only tighten. With writes starting off, the client must be able to turn on what
their agent needs. Proposed rule, replacing ARCHITECTURE §6.1's "tighten, never loosen" and the
matching words in invariant 8:

- A **client admin** may turn any read on or off, and set any write between **Off** and **Ask me
  first**. Turning a write on is their consent for their own data. Every change is a
  `connection_change` row with the person.
- Only **we** propose **On its own** (and it only runs where the step, the grant and the agent's
  `act` mode also allow it, as today). The client may always take it back to Ask me first or Off,
  at once.
- **We never loosen a client's connection by ourselves** (§7.1): anything of ours that lets agents
  do or reach more is a request the client admin approves, unless the client has authorized that
  kind of change on that connector in advance (§7.2). Tightening applies at once. On its own is
  always a request.
- Delete stays off for everyone.
- A client turning something off that an agent needs is allowed and shows as a gap at once (the
  agent asks or stops at that step; it never works around it).

This keeps "approval is on by default" (every write a client turns on asks first) and "only the
operator lets a write run on its own".

### 5.5 Grants: least access by default (proposal)

Today a binding grants the whole connection; limits only narrow. Proposed: binding an agent sets its
grant to **its needs** (the tools and record types it uses). The connection may allow more for other
agents; this agent gets only what it uses. A new version that needs more shows a gap "Widen Buyer's
access: create vendors" that we fix in the back office (or the client allows, if the connection row
is off). Old grants (no limits) keep working as today.

## 6. Built for you: connectors for one client

When a client uses a tool we don't cover:

1. The client asks from **Ask for a connector**, or the lead files it. It becomes a Dev queue request
   (§1.125) with the tool, what the agent should do there, and how it signs in.
2. We build it like any connector (a folder in `packages/connectors`, a manifest, tools with verbs
   and record types, its low-risk default) and mark it **custom**: `connector_setting` gains
   `clients uuid[]`. A custom connector is shown, offered and bindable only for those clients;
   everyone else never sees it, in the portal, the Library or the builder's palette.
3. It appears under **Built for you** with the same page, Connect flow and permissions as any other.
4. Promoting it to everyone later is clearing the list.

Also under Built for you, with no new code: the websites an agent signs in to for this client
(browser connections and their recorded scripts) and the client's webhooks.

Not in this: a client building their own connector, or a generic "any REST API" connector. The
first breaks "the operator builds"; the second we can add later as one connector with its own risks.

## 7. The back office

- **Template** (Agent lab): a **Needs** panel: per connector, the record types and verbs the template
  reads and changes, from `agentNeeds`. Shown before publishing; part of the template's manual.
- **New client agent / fork**: a **Readiness** panel per connector: Ready, Not connected, Needs access
  (which rows), Not bound, Grant too narrow. Our fixes are buttons (bind, widen grant); the client's
  fixes are a **Send to client** button: a change request (§7.1) with exactly the missing rows,
  which also lands in the client's Getting started.
- **Setup checklist**: a `connect` item is done when connected, bound **and** gap-free; its label
  says what's missing.
- **Client file / health**: "Waiting on connectors" counts per client (the catalog's "waiting to
  connect" becomes gap-based).
- `connectors_offered` stays, meaning **recommended** (shown first), no longer "visible".

### 7.1 Our changes, the client's approval (owner, 2026-11-20)

We see every client's connectors, and we can change their settings, but a change that gives agents
more goes to the client to approve first.

**What we see.** The client's **Connectors** tab in the back office (today's
`/ops/clients/:id/connections`, reworked): the same three parts as the portal (Connected, Built for
you, Recommended), each connection with its account, status, the Read and Change rows, the agents
using it and their gaps, its history, and any **open requests**. Credentials never show, as today.

**How we change something.** On a connector's page in the back office, we edit the rows (and its
setup: Gmail query, Drive folders, Slack channels) as if it were ours. Nothing is saved yet. The
footer says what changed, row by row, and asks **why** (required, shown to the client). Then:

- **Only tighter** (a row to Off, Ask me first instead of On its own, fewer folders): **Apply now**.
  It applies at once, like today, and the client is told in their Inbox ("Ana turned off Create
  bills on QuickBooks: …"). We can always make things safer without waiting.
- **Anything looser** (a row on, a write to Ask me first or On its own, more folders or channels, a
  wider query): **Send to Hartley Millwork for approval**. Nothing changes until a client admin
  approves. A mixed change is sent whole. Where the client has authorized that kind of change on
  this connector (§7.2), it applies at once instead, and the client is told.

**The request** (a new record, `connection_change_request`):

- What changes (each row: from → to), why, who asked, for which agent if any, and the matrix it was
  made against.
- The client admin gets an **Inbox item**, signal gold, "Waiting on you": "Mezonas asks to change
  QuickBooks access", the rows as before → after in plain words, the reason, the agent it's for,
  and **Approve** / **Decline** (with an optional note back). Their usual notices (email, phone)
  carry it too. A client user sees it read-only.
- **Approve** applies exactly those rows as one `connection_change` naming both people (who asked,
  who approved) and the request.
- If the connection's settings changed since we asked (the client tightened something meanwhile),
  approving is refused and the request says **Out of date**; we send a new one. A request never
  overwrites a change the client made.
- One open request per connection: a new one replaces the old (marked **Replaced**). Open requests
  end after **14 days** (**Expired**). We can **Withdraw** one until it's answered.
- States: open, approved, declined, replaced, expired, withdrawn. Never deleted.

**The same request everywhere.** The Readiness panel's Send to client, the gold "Allow what Buyer
needs" strip in the portal, and our own edits are all a change request. When the client presses
Allow on their own page, it is their change and applies at once; when we send it, they approve it.

**Not a request:** an agent's grant (its limits within what the connection allows) stays ours, as
today; binding an agent; the Sandbox client (ours, we change it directly).

### 7.2 Changes by Mezonas: the client's standing say (owner, 2026-11-20)

Each connector's page in the portal has a section **Changes by Mezonas**, where the client admin
says how much we may change on that connection without asking each time:

| Choice | What we may then do without a request |
|---|---|
| **Ask me each time** (the default) | Nothing looser: every looser change is a request (§7.1). |
| **Allow what agents need** | Turn on the rows an agent's needs call for (§4.3), up to Ask me first. Anything else is a request. |
| **Allow any change** | Change any row and the tool's setup (folders, channels, the Gmail query), up to Ask me first. |

- **For how long**: *Until I turn it off*, or *For 30 days* (handy while agents are being set up).
  It ends by itself; the page says when.
- **On its own is always a request**, whatever the choice: a write that runs with nobody signing
  needs the client's yes each time it's set. Delete stays off.
- **Every change we make under it is told**: an Inbox notice (not waiting on anyone) with the rows
  before → after, our reason and the authorization it used ("You let Mezonas make changes agents
  need on QuickBooks, Nov 20"). The connection's history names both: who changed it, and who
  authorized and when.
- **The client can take it back at once**, and undo any change we made, from the same page.
  Taking it back doesn't undo past changes; it stops new ones.
- **Who**: only a client admin sets it; a client user sees it. We can't set it, and we can't ask
  for it through a request: it's always the client's own choice. Getting started may suggest
  *Allow what agents need, for 30 days* during onboarding, with the words above; the client picks.
- **In the back office**: the client's connector shows "Hartley Millwork lets us: make changes
  agents need, until Dec 20". When an edit fits it, the footer's button says **Apply now (Pat is
  told)**; when it doesn't, **Send for approval**, with the reason it doesn't fit ("Create bills
  isn't something an agent needs").
- Stored on the connection (`connection.mezonas_may`: choice, until, set by, set at); each change
  to it is a `connection_change`. A change applied under it records the authorization with it.

## 8. What changes in the code

| Where | Change | Migration |
|---|---|---|
| `packages/core/src/schemas/skill.ts` | `needs` on `SkillDefinition` | no (JSON in versions) |
| `packages/core/src/permissions/needs.ts` | `agentNeeds`, `accessGaps`, `needsMatrix` (the rows a need sets) | no |
| `packages/core/src/schemas/connector.ts` | `defaultPermissions` may carry `entities`; the platform fallback writes `off` | no |
| `packages/connectors/*/index.ts` | each connector's reviewed default (§5.1); a test that every connector has one | no |
| `packages/core/src/permissions/decide.ts`, `apps/api` matrix routes | the client-may-allow rule (§5.4) | no |
| `connector_setting` | `clients uuid[]` for custom connectors | **yes, its own PR** |
| `connection_change_request` (new, tenant table with RLS) | our requests and their answers (§7.1); `connection_change` gains the request's id | **yes, same PR as above** |
| `connection.mezonas_may` (new column) | the client's standing authorization (§7.2); `connection_change` gains the authorization it used | **yes, same PR as above** |
| `packages/core/src/permissions` | `withinAuthorization(change, mezonasMay, needs, now)`: whether an edit of ours fits, and why not | no |
| `packages/core/src/permissions` | `changeDirection(before, after)` (tighter / looser / mixed, matrix and setup), `requestStale(request, current)` | no |
| `apps/api` ops connection routes | `opsUpdateConnection` applies only tighter changes (else 409, "send it for approval"); new create / withdraw request routes; the Sandbox keeps direct edits | no |
| `apps/api` portal routes, inbox | approve / decline a request (client admin, audited); the Inbox item; the notices | no |
| `apps/api/src/routes/portal.ts` | every live connector, offered = recommended, custom filtered by client; needs and gaps per connection and per agent; "allow for agent" route | no |
| `apps/web/src/portal` | `/connectors` and `/connectors/:id`; Getting started cards and agent Settings link to it; Accounts and its vault rail retire | no |
| `apps/web/src/ops` | Needs panel, Readiness panel, Send to client | no |
| `packages/core/src/setup/checklist.ts` | `connect` done = no gaps | no |
| ARCHITECTURE §6.1, invariant 8 in `CLAUDE.md` | the new client rule (§5.4) | — |

Existing connections keep their stored matrices: nothing becomes stricter or looser on deploy.

## 9. Build order

Each ends green; the migration goes alone.

1. **C1 Needs** (core only): `needs` on skills, `agentNeeds`, `accessGaps`, tests over every
   template in the seed and the packs. No screen.
2. **C2 Defaults**: each connector's reviewed low-risk default, the new fallback, the test.
3. **C3 Migration**: `connector_setting.clients`, `connection_change_request` and
   `connection.mezonas_may` (alone).
4. **C4 API**: the portal routes (all live connectors, custom filter, needs and gaps, allow for an
   agent), the client-may-allow rule, change requests (create, withdraw, approve, decline, stale,
   expiry), ops edits tighter-only unless authorized (§7.2); contract tests (a client can't set On
   its own by itself, can't see another client's custom connector; an operator can't loosen a real
   client's connection without an approved request or an authorization that covers it, never sets
   On its own under one, and can't set the authorization; an ended authorization covers nothing;
   approving a stale request changes nothing).
5. **C5 Portal**: Connectors and the connector page with Changes by Mezonas; the change request
   and the notices in the Inbox; Getting
   started and the agent's Settings link in; redirects from `/accounts`.
6. **C6 Back office**: the client's Connectors tab with edit → apply or send; open requests;
   Needs, Readiness, Send to client; the setup guard on gaps; the catalog's waiting count.

## 10. Decisions for the owner

All seven agreed as recommended (owner, 2026-11-20: "this looks good"), with §7.1 added. Inside
§7.1 we picked, and the owner may change: tightening by us applies at once (the client is told);
requests expire after 14 days; one open request per connection. Inside §7.2: three choices (ask
each time, what agents need, any change); On its own is always a request even when authorized; a
30-day option; the authorization is per connector and only the client sets it.

1. **The client may turn a write on to Ask me first** (§5.4). *Recommended: yes.* Without it, writes
   off by default means every agent needs us to loosen the client's own tool.
2. **Show every live connector, not only offered ones** (§3.1). *Recommended: yes*, offered becomes
   "recommended"; `beta` shown with a Beta tag, `in_review` and `building` hidden; in HIPAA mode the
   ones it refuses are hidden.
3. **Permissions by record type, not by tool** (§3.2). Claude lists each tool; we have ~50 QuickBooks
   tools. *Recommended: by record type and verb*, tools listed when a row is opened.
4. **Least access for each agent's grant** (§5.5). *Recommended: yes, for new bindings.*
5. **The defaults table** (§5.1): yes as written, or line by line.
6. **The name**: "Connectors" (as Claude) or keep "Accounts". *Recommended: Connectors.*
7. **The vault as a screen goes** (§3.3). *Recommended: yes*; logins and keys live on their
   connector's page.
