# Vendor management policy

**Twelve Thirty-Four Consulting LLC, doing business as Mezonas**
**Draft for the owner to adopt.** Version 0.1 · Drafted 2026-11-22 · Owner: Jammil, Founder & CEO (security officer) · Not yet adopted

> This is a draft (docs/plan.md §1.218). It expands the information security policy's §8 into the
> procedure SOC 2 CC9.2 asks for. It takes effect when the owner adopts it: set the version to 1.0,
> the adoption date and the next review in the header, in the Record below and in `POLICIES`
> (`packages/core/src/compliance/controls.ts`).

## 1. Purpose and scope

This policy says how we choose, check and keep track of the vendors that receive our clients'
data or run the systems that hold it, and how we stop using one. It covers every vendor listed in
`packages/core/src/compliance/processors.ts` (shown at `/ops/security/vendors` and on
`mezonas.com/subprocessors`), and the vendors kept out of client data (Stripe, Sentry, GitHub) for
what they do hold.

## 2. Tiers

| Tier | Who | What we ask |
|---|---|---|
| **Critical** | Runs the product or holds all client data: Cloudflare, Neon, WorkOS | Everything in §3, reviewed every year, and a plan if they fail (§6) |
| **Client data** | Receives some client data: model providers, messaging, Plaid, the connectors' providers | Everything in §3, reviewed every year |
| **No client data** | Holds none by design: Stripe (billing only), Sentry (scrubbed errors), GitHub (code) | Its security report, and a check each year that it still holds none |

## 3. Before we use a vendor

The security officer checks, and writes down in the vendor's review (§5):

1. **Its security:** a current SOC 2 Type II or ISO 27001 report, or an equivalent we accept with a
   reason. Read its exceptions and its complementary user controls; note any we must do ourselves.
2. **Its data terms:** a data processing agreement; where the data is stored; that it does not
   train models on our clients' data; how long it keeps it and how it deletes it.
3. **A BAA**, where clients in HIPAA mode will use it (`docs/hipaa-plan.md` §4). Until one is
   signed, the product keeps HIPAA clients' data away from it (`BAA_PROCESSORS`).
4. **What it gets:** the least data the feature needs, named in `processors.ts`. A feature that
   sends client data to a new vendor can't ship without naming it there (invariant 14).
5. **Clients told:** the subprocessor list is updated, and clients are told before the new vendor
   receives their data.

## 4. While we use a vendor

- Its accounts follow our access rules: named accounts, passkeys or security keys, and the
  quarterly access review of each console.
- Its keys are kept as encrypted deployment secrets and rotated when someone who could see them
  leaves.
- A security notice from a vendor is handled as a security event under the incident response
  policy.

## 5. Every year

For each vendor, the security officer records the date and:

- its current security report, read, with anything that changed;
- whether its data, training and retention terms still hold;
- its BAA status, where it applies;
- whether we still need it, and whether it still gets only what it needs.

The record is kept with the policies (the vendor review routine, `ROUTINES` in
`packages/core/src/compliance/controls.ts`).

## 6. When a critical vendor fails

For Cloudflare, Neon and WorkOS, keep a short note of what we would do if each were unavailable
for a day or gone for good: what stops, what clients are told, and where we would move. Review it
with the yearly vendor review.

## 7. Stopping a vendor

Remove its keys and accounts, turn the feature off, ask it to delete our clients' data and keep its
confirmation, and update `processors.ts` and the subprocessor list.

## 8. Review and exceptions

The security officer reviews this policy every year with the others. An exception needs the
security officer's written approval, a reason and an end date.

## Record

| Date | Version | Change | Approved |
|---|---|---|---|
| 2026-11-22 | 0.1 | First draft, for the owner to adopt | Not yet |
