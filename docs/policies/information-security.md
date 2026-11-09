# Information security policy

**Twelve Thirty-Four Consulting LLC, doing business as Mezonas**
Version 1.0 · Adopted 2026-11-09 · Owner: Jammil, Founder & CEO (security officer) · Next review: 2027-11-09

## 1. Purpose and scope

This policy says how we protect our clients' data and the systems that hold it. It covers everyone
who works on Mezonas (staff and contractors), every system that stores or processes client data, and
every device used to reach those systems.

How each control is built is in `docs/security.md`; this policy is what we commit to.

## 2. Roles

- **Security officer: Jammil.** Owns this policy, approves exceptions, leads incident response, and
  runs the reviews in §11.
- **Everyone with access** follows this policy, finishes the yearly training, and reports anything
  suspicious to the security officer the same day.

## 3. Access control

- **Least privilege.** People get only the access their work needs. Client access in the back office
  is limited to the clients they serve. Production database access (`cs_owner`) is the security
  officer's only.
- **Named accounts only.** No shared logins. Every person has their own account on each system.
- **Multi-factor authentication everywhere.** Required in our app for every user, staff and client.
  Staff use **passkeys or hardware security keys** on the systems that hold client data or can change
  production: GitHub, Google Workspace, Cloudflare, Neon, WorkOS, Intuit, Plaid, Sentry and Stripe.
- **Sessions** in our app end after 30 minutes idle and 12 hours in total.
- **Joining:** access is granted by the security officer, at the lowest role that works.
- **Leaving:** all access is removed within one business day of someone leaving or changing role.
- **Quarterly access review:** the security officer reviews every account in our app (`/ops/audit` →
  Access review, saved as a dated CSV) and on each system listed above, and removes what isn't needed.
- **Non-human access** uses scoped OAuth tokens or API keys, stored as encrypted deployment secrets,
  never in code or logs, and rotated when anyone who could see them leaves.

## 4. Protecting data

- **Client isolation:** each client's data is separated by database row-level security that our
  application's role can't bypass.
- **Encryption:** TLS 1.2 or higher in transit; AES-256 at rest. Clients' tokens, keys and logins are
  encrypted with that client's own key, never shown to anyone (us included), never logged and never
  sent to an AI model.
- **Least data:** we read only what a feature needs (for example, Plaid transactions and balances;
  Gmail send only). Card numbers are never stored.
- **No client data on personal devices or personal accounts.** Client data stays in our systems. It is
  not downloaded except to answer a client's own request, and such files are deleted once sent.
- **Devices** used for Mezonas have full-disk encryption, a screen lock of 5 minutes or less, current
  operating system updates, and no shared users.

## 5. Changes to the product

- Every change is a pull request to a protected `main` branch, with passing checks (lint, typecheck,
  tests, CodeQL) before it merges. No one pushes straight to `main`.
- Database migrations, CI and deploy changes, and sign-in changes each get their own pull request.
- Production is deployed only from a tagged release, after the same change has run on staging.

## 6. Vulnerabilities and patching

- Dependabot and CodeQL scan every change and the code weekly; secret scanning with push protection is
  on.
- Fix within: **critical, 7 days; high, 30 days; medium and low, at the next monthly update.**
- Dependabot's grouped updates are merged monthly, which keeps libraries and runtimes off end-of-life
  versions. Any end-of-life component is replaced within 90 days.
- Staff devices take operating system and browser security updates within 14 days.

## 7. Logging and monitoring

- Every request and every write to a client's tool is in the audit log: who, what, when, from where,
  and, for writes, the record's state before and who approved it. The log can't be edited and is kept
  6 years.
- Errors alert the security officer through Sentry. Error reports carry no client content.

## 8. Vendors

- Vendors that receive client data are listed on `mezonas.com/subprocessors` and in
  `packages/core/src/compliance/processors.ts`.
- Before adding one: check its security (SOC 2 or ISO 27001 report, or an equivalent), that it won't
  train on our clients' data, and its data processing terms. Re-check each one yearly.
- Clients are told before a new subprocessor receives their data.

## 9. Incidents

1. **Report** anything suspicious to the security officer at once.
2. **Contain:** revoke keys or tokens, disconnect affected connections, block access.
3. **Investigate** from the audit log, Sentry and the providers' logs; keep a written record.
4. **Notify** affected clients without undue delay and within **72 hours** of confirming that their
   data was exposed; notify Plaid, Intuit and other providers as their agreements require, and
   authorities as the law requires.
5. **Learn:** within two weeks, write down the cause and the fix, and change this policy if needed.

## 10. Backups and continuity

- Neon keeps 7 days of point-in-time history of the production database; original documents in R2 are
  written once and never changed.
- A restore is tested every quarter and the result recorded (`docs/operations.md` §4).

## 11. Training, review and exceptions

- Everyone with access reads this policy and the data retention policy when they join and every year,
  and confirms it in writing.
- The security officer reviews this policy every year and after any incident or major change.
- An exception needs the security officer's written approval, a reason and an end date.
- Breaking this policy can mean losing access and, for staff or contractors, ending the engagement.

## Record

| Date | Version | Change | Approved |
|---|---|---|---|
| 2026-11-09 | 1.0 | First version | Jammil |
