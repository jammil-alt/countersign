# Lockdown: one switch that stops everything for a client, or for every client

Owner, 2026-11-24: "a kill switch that locks down the account, stops all writes and reads."
The entry in `docs/plan.md` is §1.243. K0 (the migration), K1 (the database layer) and K2 (the API) are built; K3 onwards are not. Outside ARCHITECTURE v0.15's v1 scope by the
owner's decision.

## 1. Why

The incident response policy (`docs/policies/incident-response.md` §5.2) says to contain first. The
switches we have today each cover a part, and none stops what is already running:

| Switch today | What it misses |
|---|---|
| Pause all (client admin) | Runs already going finish; the account agent stays on; one client only; the operator has no Pause all |
| Pause one agent (operator) | One agent at a time; runs already going finish |
| A connection's verb set to Off | One connection and one verb at a time |
| Disconnect a connection | One connection at a time; the client signs in again afterwards |
| Retire the client | Can't be undone; files deleted 30 days later. Offboarding, not containment |
| Roll back, rotate secrets | Replace code or keys; don't stop work in flight |

A lockdown is one switch, undone as easily as it is set, that takes effect on the next database
call everywhere, for one client or for all of them.

## 2. What a lockdown does

**While a client is locked:**

| Area | What happens |
|---|---|
| Our copy of its data | Nothing reads or writes it: portal, phone app, desktop app, back office, the MCP connector, crons, exports, Sloan and Reggie. Answers are `423` `client_locked` |
| Its tools (QuickBooks, Gmail, Zoho CRM and the rest) | No read and no write. No sync, no tool call, no browser sign-in. Connection secrets can't be opened |
| AI providers | Nothing of the client's is sent to any model |
| Runs | None starts. Runs in progress stop at their next step and their Workflow instances are ended. They are marked "Stopped: account locked" and do not resume by themselves |
| Writes waiting for approval | Can't be approved while locked. Those of the stopped runs close as "Stopped: account locked" |
| Coming in (webhooks, forwarded email, WhatsApp, texts, forms, the measuring beacon) | Answered as usual so providers don't retry or switch off our hooks, then dropped. Only the count per kind is kept on the lock. Email is never bounced (`apps/api/src/email.ts`'s rule) |
| Sign-ins | The client's people can't sign in to it. A session already open gets the locked page on its next request |
| Still works | The audit log (every refused request still writes its row); turning the lockdown off; the security officer's read-only investigation (below) |

**Everything locked** (the platform lockdown) does the same for every client at once, and also
keeps every operator but the security officer out of the back office.

**Investigation.** Only the security officer, signed in with a fresh second factor, may read a
locked client's data, in the back office, read only. Those reads run in a read-only database
transaction (`set transaction read only`), so a bug can't write. Each read writes its audit row
as any other does.

## 3. How it is enforced

One check, in the database, on the path every piece of client data already takes.

Every read or write of client data goes through `inScope` (`packages/db/src/client.ts`:
`withTenant`, `withTenants`, `withOperator`), which sets `app.tenant_ids` for row-level security
(invariant 1). The lockdown goes in that same statement:

- A SQL function, `app_scope_tenant_ids(ids, mode)`, returns the ids that aren't locked. When the
  platform is locked it returns none.
- `withTenant` (one client: a run, a portal request, a webhook) raises `client_locked` when its
  client is locked. The transaction aborts, so nothing after it runs, even code we forgot.
- `withTenants` and `withOperator` (sweeps and the back office's lists across clients) drop the
  locked clients from the scope instead of failing. Row-level security then hides their rows,
  so one locked client doesn't break the back office for the others.
- The investigation scope (`investigate: true`, security officer only) keeps the locked clients
  and makes the transaction read only.

It is part of the statement `inScope` already sends, so it adds no round trip and has no cache.
Once the lock commits, the next transaction in every Worker isolate sees it.

Because every route, cron, Workflow step and webhook handler opens one of these scopes before it
touches client data, they are all covered by this one check. On top of it:

| Where | Change |
|---|---|
| `apps/api` error mapping | `client_locked` becomes `423` with a plain message; never a 500, never reported to Sentry as an error |
| Workflow steps (`apps/api/src/runs/workflow.ts` and the others) | `client_locked` is a `NonRetryableError`, so a step doesn't retry for hours |
| The lock itself | In one transaction: set the lock, mark running runs stopped, close their waiting approvals. Then end each run's Workflow instance (`terminate()`). An instance that can't be ended still stops at its next step |
| Crons (`apps/api/src/scheduled.ts`) | Already sweep clients through `withTenants`, so locked ones drop out. A job that opens `withTenant` per client treats `client_locked` as "skip" |
| Inbound handlers | Catch `client_locked`, answer as usual, add 1 to the lock's count for that kind |
| Sessions (`packages/db/src/queries.ts` memberships) | Leave out locked clients, as retired ones are, except for the security officer |
| Connection secrets | Opened only inside a client scope, so they can't be opened while locked. Nothing extra |

**Outside the app (break-glass).** If the Worker or the database may itself be compromised, the
app's own switch isn't enough. A Cloudflare WAF custom rule, "Mezonas lockdown", is created
switched off. It blocks every request to `app.mezonas.com` and `staging.mezonas.com` except
`/api/health`. `lockdown.yml` (by hand: environment, on or off) switches it through Cloudflare's
API. While it is on, webhooks fail and providers retry, which is what we want then. The status page
stays up because it is hosted elsewhere.

## 4. Who can do what

| Action | Who | How |
|---|---|---|
| Lock a client | Any operator who serves it | Back office, the client's page: "Lock down this account". Type the client's name and a reason |
| Lock everything | Any operator | Back office, Security: "Lock down every account". Type "lock everything" and a reason |
| Lock our own account | A client admin | Portal, Settings: "Lock our account", with a reason (question 2) |
| Unlock | The security officer only, with a fresh second factor | The same places: "Unlock", with a note on what was found |
| Break-glass edge rule | The owner | `lockdown.yml`, or the Cloudflare dashboard |

Any operator may lock because the policy lets whoever finds an incident start containment if the
security officer can't be reached within an hour. Only the security officer unlocks.

**Telling people.** Locking a client emails its admins at once: "We've locked your Mezonas account
while we look into a security concern. Your agents are stopped and nothing reads or changes your
tools. We'll contact you within [24 hours]." It contains no record content (T8). The security
officer gets a text and an email for every lock. This is not the breach notice: that follows the
policy's §6 once the facts are known.

**Undoing it.** Unlocking changes nothing else. Agents start on their next trigger. Stopped runs
stay stopped, and what came in while locked is not replayed. The back office shows the counts
(as `missedWhilePaused` does), and the operator runs anything by hand. Paused agents stay paused.

## 5. Stronger options, offered on the lock's page

Each is its own button, after the lock, because each is harder to undo:

- **Revoke the client's sign-ins at each provider** (Zoho, QuickBooks, Google and the rest): what
  Disconnect does, for every connection. The client signs in again after the unlock. Use it when
  tokens may have leaked.
- **Replace the client's key**: wrap its secrets under a new data key (`rewrapClientKeys`,
  `reencryptClientCredentials`).

## 6. Data

Migration (own PR, additive, the previous Worker keeps working):

- `tenant.locked_at timestamptz null` and `tenant.lock json null`: who, when, why, which side
  (`operator` or `client`) and the inbound counts.
- `platform_lock`, one row at most: who, when, why.
- `app_scope_tenant_ids(ids uuid[], mode text)`: the function in §3. It raises SQLSTATE `MZLCK`
  (`client_locked`) in mode `one`, and holds mode `investigate` to a read-only transaction.
- Each lock and unlock is a `tenant_change` row (platform locks: one per client) and an audit row.

## 7. On screen

- Back office: the button on the client's page (risk colour); a risk banner on every back-office
  page while any client, or everything, is locked: "Locked: Acme Ltd, since 14:02, by Jammil.
  Reason: …". The investigation view says "Read only" at the top.
- Portal, phone and desktop: one page, with no data on it: "Your account is locked. We stopped
  your agents and everything that reads or changes your tools while we look into a security
  concern. We'll contact you." Plus a contact link.

## 8. Checked by

- A contract test that walks every route in the API contract (`packages/core/src/api`) with a
  locked client and expects `423` or a scope without it. Portal, ops, MCP, desktop and phone
  routes alike, as the invariant 11 tests do.
- DB tests on local Postgres: `withTenant` raises; `withTenants` and `withOperator` drop the locked
  client; the platform lock drops all; investigation is read only (an insert fails).
- A run locked between two steps stops at the second, doesn't retry, and is marked stopped.
- Every cron job runs with a locked client and touches none of its rows.
- Each inbound kind answers as usual, stores nothing, and counts.
- Unlocking by anyone but the security officer is refused; unlocking resumes nothing by itself.
- A drill on staging, added to the yearly incident drill: lock the Sandbox client during a run and
  time how long until the run stops.

## 9. Build, in streams

Each ends green (`pnpm check`).

| Stream | What | Migration |
|---|---|---|
| **K0** (built) | The migration (§6), 0101 | Own PR |
| **K1** (built) | `packages/db`: every scope through `app_scope_tenant_ids` (`inScope`, `withSession`, `narrowToTenant`); `ClientLockedError` and `isClientLocked`; `withInvestigation` and a session's `investigate`; `admitTenant`; `lockClient`, `unlockClient`, `lockEverything`, `unlockEverything`, `lockState`, `countLockedInbound` (`src/lockdown.ts`); the one scope set outside `packages/db` (creating a client, `apps/api/src/routes/ops-clients.ts`) through `admitTenant`; DB tests | After K0 |
| **K2** (built) | `apps/api`: 423 everywhere; Workflow steps end without retries (`stepUnlessLocked`); crons and sweeps leave locked clients out; providers' inbound answered as usual and counted, email dropped and counted; the lock and unlock routes (ops, everything, the client's own) with runs stopped and notices sent; the security officer (`SECURITY_OFFICER_EMAILS`) and recent sign-in; `?investigate=1`; audit rows for locked clients; the walk over every portal route | None (0101 amended before merge: the audit insert policy) |
| **K3** | `apps/web` (and the phone and desktop apps' locked page): the controls, the banner, the locked page | None |
| **K4** | The break-glass edge rule: `lockdown.yml` and a Cloudflare API token scoped to WAF rules on `mezonas.com` (the owner creates it) | Own PR (workflow) |
| **K5** | Docs: `docs/security.md`, the incident response policy's §5.2 (lock first), `docs/operations.md` (a runbook), the register (`INC-2`, `packages/core/src/compliance/controls.ts`) | None |

## 10. Questions for the owner

Each has a default the plan uses until answered.

1. **Who may lock?** Default: any operator; only the security officer unlocks.
2. **May a client admin lock their own account?** Default: yes. They may unlock it too if they
   locked it; an operator's lock only the security officer lifts.
3. **What comes in while locked:** dropped and counted (default), or kept for after?
4. **Tell the client automatically on lock?** Default: yes, the short email in §4. What contact
   time do we promise?
5. **The edge rule on staging too?** Default: yes, a rule for each host, switched separately.
