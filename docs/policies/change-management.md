# Change management policy

**Twelve Thirty-Four Consulting LLC, doing business as Mezonas**
**Draft for the owner to adopt.** Version 0.1 · Drafted 2026-11-22 · Owner: Jammil, Founder & CEO (security officer) · Not yet adopted

> This is a draft (docs/plan.md §1.218). It writes down how we already change the product, so an
> auditor can test it against SOC 2 CC8.1. It takes effect when the owner adopts it: set the
> version to 1.0, the adoption date and the next review in the header, in the Record below and in
> `POLICIES` (`packages/core/src/compliance/controls.ts`).

## 1. Purpose and scope

This policy says how a change reaches the product and the systems around it, so every change is
authorised, reviewed, tested and can be undone. It covers the code in the `countersign`
repository, the database's schema, the deployment workflows, and the settings of the systems that
run the product (Cloudflare, Neon, WorkOS, GitHub and the connectors' provider consoles).

The information security policy (§5) states the rules in short; this policy is the procedure.

## 2. Roles

- **Security officer:** approves this policy and its exceptions, approves production releases,
  and owns the settings of the provider consoles.
- **Author:** whoever makes the change (a person, or an agent working for one). The author is
  responsible for its tests and its description.
- **Reviewer:** someone other than the author where the team allows it. Until there is a second
  engineer, the security officer reviews the pull request, and the automated checks below are the
  independent review.

## 3. Every change is a pull request

1. Work happens on a branch, never on `main`. The pull request is opened as a draft with the
   branch's first push.
2. The description says what changes and why, the decisions taken, and how it was tested.
3. `main` is protected (GitHub ruleset "Protect main"): no direct pushes, no force pushes, and a
   pull request merges only when its required checks pass.
4. **Required checks** (`.github/workflows/checks.yml`): formatting and lint, the package layering
   check, typecheck, the unit and database tests, the web app's size budget, and CodeQL; the
   dependency and secret scans run beside them. A red check is fixed at its cause; a test is never skipped, retried until
   green or quarantined to get a change through.
5. **Kept apart:** database migrations, CI and deployment workflow changes, and sign-in changes
   each go in their own pull request, so each can be reverted alone.

## 4. Database changes

- A migration is never edited once it has reached staging or `main`; a new one is added.
- A migration must keep the previous Worker working, because migrations apply before the new
  Worker deploys. Columns are added before they are used and dropped only after nothing reads them.
- Each migration has a test of its rules: row-level security, grants, and what may never change.

## 5. From merge to production

1. Every merge to `main` deploys to **staging** (`deploy.yml`), migrations first.
2. **Production** deploys only from a `v*` release tag, after the same commit has run on staging,
   and waits for the production environment's approval in GitHub (the security officer).
3. A hand-run deploy (`quick-deploy.yml`) goes to staging only, carries no new migrations, and is
   for trying a branch, never for production.
4. Each production release's tag and deploy run are its record (GitHub).

## 6. Emergency changes

When production is down or client data is at risk, the security officer may shorten the steps:
the change still goes through a pull request and the required checks, but may be released before
it has run on staging. Within two business days, the security officer writes down why, what was
skipped and the follow-up, in the pull request.

## 7. Settings outside the code

Changes to a provider's console (Cloudflare, Neon, WorkOS, GitHub, Intuit, Google, Plaid and the
rest) are made by the security officer only, from a named account with a passkey or security key.
A change that weakens a control (a firewall rule, a sign-in setting, a role) is written down in
`docs/security.md` or `docs/operations.md` in the same week, through a pull request.

## 8. Rolling back

Every release can be undone by deploying the previous tag. A migration is undone by a new
migration, never by editing or deleting the old one. The restore test (`docs/operations.md` §4)
shows the database can be brought back from its history.

## 9. Evidence

- Each change: its pull request, with its checks and approval (GitHub).
- Each release: its tag and the deploy run (GitHub Actions).
- Each emergency change: the written reason in its pull request.

## 10. Review and exceptions

The security officer reviews this policy every year with the others. An exception needs the
security officer's written approval, a reason and an end date.

## Record

| Date | Version | Change | Approved |
|---|---|---|---|
| 2026-11-22 | 0.1 | First draft, for the owner to adopt | Not yet |
