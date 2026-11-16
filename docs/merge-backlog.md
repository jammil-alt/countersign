# Unmerged branches: the merge plan (2026-11-15)

On 2026-11-15 we found 11 branches of finished work that never reached `main`, so never reached
staging. Most had no PR. Two others had their PR merged, then got one more commit that nobody
opened a PR for. This page lists what is on them, what must be decided first, and the order to
merge them in. Strike a row through, or delete it, as each one lands. When the page is empty,
delete it.

To stop this happening again, every pushed branch now gets a draft PR: CLAUDE.md asks for it, and
`.github/workflows/draft-pr.yml` opens one if a push finds none (`docs/operations.md` §2).

## Where we paused (2026-11-16)

**Merged to `main` (on staging):**
- #300 (docs) and #302 (builds, voice typing).
- #303: draft-PR rule.
- #304: Twilio, ElevenLabs, Zoho.
- #306: price checker step 2.
- #307: the Builder's previous/next step.
- #308 and #309: migration 0054 and the event dispatch code.
- #310: Odoo.
- #311: Microsoft 365 and calendars.
- #315: CodeQL v4.
- #316: OSV-Scanner and patch deadlines.
- #317: Node 24.
- #318: security register.
- #319 and #320: Dependabot.

Rows 1–8 below are done. The stale branches are deleted.

**Open, in merge order.** Each migration takes the next number when it merges. Rebase each PR onto
`main` first; `docs/plan.md` sections conflict where they meet.

1. **Token counts:**
   - #327: migration 0055 (`model_call.action`).
   - #324: the code (plan §1.115).
   - Built and checked, except one rerun of the web suite after main's last merges.
   - Decide first: the trust-claims plan's `purpose` column on `model_call` (item 13). One column
     should cover both.
2. **Phone app:**
   - #321: migration 0056. Re-chain it after 0055.
   - #322: sign-in.
   - #323: the app (§1.116).
   - Push stays off (`MOBILE_PUSH`) until the store accounts exist.
   - Expect a lockfile conflict with #320.
3. **Area owners:**
   - #312: migration, numbered 0054 on its branch. Renumber it to 0057.
   - #313: the code (§1.117, ARCHITECTURE v0.19).
   - Expect a small conflict in `Sloan.tsx` with #305.
4. **Removing a person:** #325.
   - Built, and the targeted tests pass. Left: the full web, api and db suites.
   - The `remove-operator.yml` workflow is not started; it goes in its own PR.
   - Its plan section is also numbered §1.115. Renumber it to §1.119.
   - Access ends within 5 minutes (owner).
   - Owner to confirm:
     - Removing an operator hands their open items to the other operators and clears them as a
       client's lead.
     - An operator can remove a client's last admin.
5. **Plan §1.118:** templates from staging to production (#314, docs only). Then build T-1 to T-4.

**Not started:**
- **The Claude connector's approval link.** Ported from `c194789f` onto main's second step as
  `docs/plan.md` §1.120, in its own draft PR, #372. It
  also gates clients' Claude connections; the owner to confirm that.
- **The compliance docs, rewritten** (audit piece 8): the Plaid attestations, the EOL inventory, the
  joining and leaving checklist, and the `security.md` and `hipaa-plan.md` edits. Leave out what the
  policies contradict (the audit's notes).
- **The trust claims plan** (`fe7dbcac`), refreshed. Keep the masking promise on the Security page
  (owner).
- **HIPAA mode for the Claude connector, the Builder and questions** (audit T1/T2): later, when the
  first HIPAA client comes (owner: none yet, no PHI flows).
- **Dropped:** `c2747d76`, the sign-in change refusing Google. It contradicts the owner's decision that
  Google sign-ins get a code.

**Owner answers recorded:**
- WorkOS multi-factor is on.
- Removal within 5 minutes is fine.
- Keep the masking promise.
- No HIPAA block now.

**Still open for the owner:** the phone app's questions in #323, and §1.118's two open points.

## How we checked

Most PRs here are squash-merged, so a branch's commits are never on `main` even after it lands.
"Commits main lacks" over-counts. For each branch we used three checks:

- whether each commit's change is already applied on `main`;
- whether its features exist on `main` (files, tables, connectors);
- a trial merge into `main` at `bf13591a`, counting conflicting files.

## What's on them

| # | Branch | Date | What | Size | Conflicts with main | Migration | Plan § on the branch |
|---|---|---|---|---|---|---|---|
| 1 | `claude/twilio-troubleshoot-test-3fb4b4` | 11-13 | ElevenLabs `end_call` as a built-in tool, TwiML answered as a JSON string; Zoho CRM developer and sandbox hosts; phone numbers take calls by default | 15 files | 0 | none | none |
| 2 | `claude/security-docs-tiered-compliance-7cfd8e-x2qy5h` | 11-14 | Security register: what sign-in asks for today; Cloudflare and Sentry recorded. Pushed after #291 merged. | 4 files | 0 | none | none |
| 3 | `claude/serene-curie-fmcd1c` | 11-09 | Docs: the trust claims plan (what we keep, what we change) | 1 file | 0 | none | none |
| 4 | `claude/busy-euler-cgu5kr` | 11-11 | Price checker step 2: find Mezonas's copy of QuickBooks bills. Pushed after #268 merged. | 7 files | 1 (`packages/documents/src/index.ts`) | none | none |
| 5 | `claude/quirky-pasteur-eh22x5` | 11-14 | Builder: each step's previous and next step, checked before they change; ask the Builder to resolve a move; add a step from either side | 8 files | 3 (Builder screens, plan) | none | §1.101 (taken by Reggie) |
| 6 | `claude/dreamy-cray-zm9yyb` | 11-14 | Each event dispatched in its own savepoint; an event that keeps failing is set aside | 12 files | 3 (plan, migration meta) | 0050 (taken) | §1.102 (taken) |
| 7 | `claude/odoo-connectors-crm-erp-aa31fe-x5spfp` | 11-12 | Odoo connector: CRM, sales, purchasing, invoicing, inventory | 21 files | 2 (`skill-hashes.test.ts`, plan) | none | §1.97 (taken) |
| 8 | `claude/optimistic-heisenberg-k8eol2` | 11-13 | Microsoft 365 and calendars: OneDrive, Excel, Teams, Outlook Calendar, Google Calendar; one Microsoft sign-in shared by the connectors | 73 files | 2 (`skill-hashes.test.ts`, plan) | none | §1.97 (taken), M58 |
| 9 | `claude/clever-volta-s13mur` | 11-09 | Node 24; CodeQL v4, OSV-Scanner and a patch-deadline workflow; removing a client's person or an operator with access ending at once (`remove-operator.yml`); sign-in only where a second factor is certain; HIPAA mode for the MCP connector, the Builder and plain-words questions; the Plaid attestations | 62 files | 16 | none | none |
| 10 | `claude/vibrant-darwin-9r6iln` | 11-06 | Back-office token counts by client, agent, model and action. Its other half, Grok and Gemini, is already on `main`. | 46 files | 27 (mostly the half already merged) | 0032 (taken) | §1.62 (taken) |
| 11 | `claude/zealous-edison-prm7z7` | 11-14 | The phone app (`apps/mobile`, Expo) and its server side: sign-in handoff, phones, push, signing with Face ID | 85 files | 6 (`app.ts`, `auth/seal.ts`, plan, operations, migration meta) | 0048/0049 (taken) | §1.99 (taken) |
| 12 | `claude/clever-allen-i6npwp` | 11-12 | Area owners (O1–O8): an owner per business area, chat with an owner, owner-drafted changes, Sloan as the chat, Home and conversation history | 87 files | 14 (`execute.ts`, oversight, core index, ARCHITECTURE, CLAUDE.md, plan, migration meta) | 0048 (taken) | §1.96 (taken), ARCHITECTURE v0.17 §10.15 (main's v0.17 is different) |

## Decisions for the owner first

These change what gets merged, so they come before the work in wave 4.

| # | Branch | Question | Our recommendation |
|---|---|---|---|
| D1 | 12, area owners | Still wanted? It was designed before Reggie (§1.101), builds and the one conversation component (#302), which cover some of the same ground: Sloan as the chat, Home, conversation history. Main's ARCHITECTURE v0.17 is a different design. | Decide after #302 merges. If kept, rebuild it on top of #302 as ARCHITECTURE v0.18 rather than rebase it: 14 conflicts in the run and oversight core. |
| D2 | 11, phone app | Wanted now? It needs Apple and Google developer accounts and the store listings, and it changes sign-in (`packages/auth/src/seal.ts`). | Merge the server side and migration once the store accounts exist. The app itself can follow. |
| D3 | 10, token counts | Still wanted? The Usage screen has changed since 11-06. | Yes. Redo the remainder (the report, the screen, `model_call.action`) from the branch on today's Usage screen. A rebase would mostly re-resolve the half that already merged. |
| D4 | 9, compliance bundle | Which parts still stand? Main built its own second factor since (§1.100), so "a session only where a second factor is certain" may be covered already. | Split it into 5 PRs: Node 24; the scan workflows; de-provisioning with `remove-operator.yml`; the HIPAA mode checks; the Plaid doc. Drop the sign-in change if §1.100 covers it. |

**The owner's answers (2026-11-15):**

- **D1:** keep area owners; they are an important design feature. Take whichever path gets them in
  most easily.
- **D2:** merge the phone app into the repo now, server side and app, and finish it within the week
  once the store accounts exist.
- **D3:** keep the token counts; they are important.
- **D4:** check the bundle against all the compliance and security work merged after 11-09, then
  merge what still stands.

## The order

Each wave starts when the one before it is green on staging. Inside a wave, one PR at a time, in
the order listed: they touch the same few files (`docs/plan.md`, `skill-hashes.test.ts`, the
migration journal).

**Wave 0: the two open PRs.** Done: #302 and #300 merged on 2026-11-15.

**Wave 1: small, almost no conflicts.**

1. Twilio, ElevenLabs and Zoho (row 1). Check "numbers take calls by default" against the
   relationship basis (§1.97) before merging.
2. Security register (row 2).
3. Trust claims plan (row 3). Check it against the Security page as it is built now.
4. Price checker step 2 (row 4). Check it is still needed now that vendor contracts work
   without an accounting tool (§1.104).
5. Builder previous and next step (row 5). Merge it after #302, which also changes the Builder.

**Wave 2: event dispatch (row 6).** First its migration, alone (next free number, expected 0054),
then the code.

**Wave 3: connectors (rows 7 and 8).** No migrations. Odoo first (smaller), then Microsoft 365 and
calendars. Each needs its provider setup in `docs/operations.md` and the unchecked parts in its
`NOTES.md`. Both are already on the branches.

**Wave 4: after D1–D4.** The compliance split (row 9), token counts (row 10), the phone app
(row 11), area owners (row 12), each as decided.

## How each one is merged

1. **Start from main.** Make a new branch from `main` and run
   `git merge --squash origin/<old branch>`, so conflicts are resolved once, not commit by commit.
   Open its draft PR at the first push.
2. **Migrations go first, alone.** Drop the branch's migration SQL, its snapshot and its journal
   entry. Bring the schema change over, run `pnpm --filter @countersign/db db:generate` for the
   next free number, and keep the original header comment. Ship that in its own PR. It must keep
   the previous Worker working. Merge it, then the code.
3. **Plan sections take the next free number.** Renumber the branch's `docs/plan.md` section,
   then every `§1.x` the branch's code and docs cite (`git grep "§1.97"` on the branch's files).
4. **Green, then ready.** `pnpm check` passes locally, mark the PR ready, CI passes, merge.
5. **Delete the old branch**, and strike its row here.

Expected numbers, in the order above (the next free one at the time decides): migrations 0054
(event dispatch), then 0055 (`model_call.action`), 0056 (`person_device`), 0057 (area owners);
plan sections from §1.110.

## Branches to delete now

Already on `main` (squash-merged or landed another way), duplicates, or obsolete:

- `claude/m8a-catalog`, `claude/m8a-catalog-migration`, `claude/m8b-pia`,
  `claude/m8b-pia-migration`, `claude/wave1-integration`, `claude/wave2-integration`: the
  Materials pack and wave integrations, all on `main`.
- `claude/m41-marketing-migration`: landed as migration 0037.
- `claude/second-factor-migration`: landed as 0042 and §1.100.
- `claude/friendly-cerf-80rs0u`, `speed/docs`, `claude/great-gates-mt1eon`: the speed plan
  docs, on `main` as `docs/speed-run/` and `docs/audit-plan*.md`.
- `p1-materials-i18n`, `claude/odoo-connectors-crm-erp-aa31fe`,
  `claude/qa-sentry-prod-release-6ae2d6-l6y4u6`: no commits main lacks.
- `claude/twilio-troubleshoot-test-3fb4b4-o7glqh`: the same three commits as row 1.
- `dependabot/npm_and_yarn/dependencies-8e42f59124`: bumps `@anthropic-ai/sdk`, which #250 removed.

Also turn on Settings → General → "Automatically delete head branches", so a merged PR's branch
goes away. Any later push to that name then starts a new branch, and `draft-pr.yml` opens its PR.
