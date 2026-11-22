# Incident response policy

**Twelve Thirty-Four Consulting LLC, doing business as Mezonas**
**Draft for the owner to adopt.** Version 0.1 · Drafted 2026-11-22 · Owner: Jammil, Founder & CEO (security officer) · Not yet adopted

> This is a draft (docs/plan.md §1.218). It expands the information security policy's §9 into the
> procedure SOC 2 CC7.3–CC7.5 asks for. It takes effect when the owner adopts it: set the version
> to 1.0, the adoption date and the next review in the header, in the Record below and in
> `POLICIES` (`packages/core/src/compliance/controls.ts`). Notice periods are our commitments as
> written today; counsel should confirm them against client contracts and the law before adoption.

## 1. Purpose and scope

This policy says what we do when something may have gone wrong with the security of our clients'
data or our systems: who decides, in what order we act, who we tell and by when, and what we keep.
It covers everyone who works on Mezonas and every system listed in the information security policy.

## 2. What counts

- **Security event:** anything that might affect security: an alert, an odd sign-in, a report from
  a client or a vendor, a lost laptop, a failed check.
- **Incident:** an event that has, or likely has, affected the confidentiality, integrity or
  availability of client data or of the product. Examples: someone reading a client's data who
  shouldn't; a write to a client's tool nobody approved; a leaked key; one client seeing another's
  data; the product down for clients for more than an hour.
- **Breach:** an incident where client data was exposed to someone who shouldn't have it.

## 3. Severity

| Severity | Meaning | Examples |
|---|---|---|
| **1, critical** | Client data exposed or changed, or likely; or the product down for every client | A leaked secret with access to client data; one client seeing another's records; an unapproved write to a client's books |
| **2, high** | A control failed, no sign yet of data exposed; or the product down for some clients | Row-level security found off on a table; a connector token logged; a vendor reporting a breach on their side |
| **3, low** | An event to look into, contained | A phishing email reported and not opened; one failed scan finding |

The security officer sets the severity and changes it as facts come in.

## 4. Roles

- **Incident lead: the security officer.** Decides, coordinates and speaks to clients. If they
  can't be reached within an hour for a severity 1, whoever found it starts containment (§5.2) and
  keeps trying.
- **Everyone with access:** reports at once and helps as asked; doesn't discuss the incident
  outside the people working on it.

## 5. Procedure

1. **Report.** Tell the security officer at once, by phone or text for severity 1 or 2, with what
   you saw and when. Don't delete anything.
2. **Contain.** Stop it getting worse, in this order as it applies:
   - revoke or rotate the key, token or secret (Cloudflare secrets, Neon roles, WorkOS, providers);
   - disconnect the affected client connection, or retire the client's agents;
   - block the account or the address (WorkOS, Cloudflare);
   - turn a feature off with its switch, or deploy the previous release.
3. **Investigate.** From the audit log (`/ops/security/audit`), Sentry, Cloudflare's and Neon's
   logs, and the providers' logs: what happened, since when, which clients and which data. Keep a
   written timeline as you go.
4. **Notify** (§6), as soon as the facts allow, not when the investigation is finished.
5. **Recover.** Fix the cause, restore data if needed (`docs/operations.md` §4), check the fix on
   staging, then release.
6. **Learn.** Within two weeks: a short written review of the cause, what worked, what didn't, and
   the changes to make, each tracked to done. Update this policy or the register if needed.

## 6. Who we tell, and by when

| Who | When | How |
|---|---|---|
| Affected clients | Without undue delay, and within **72 hours** of confirming their data was exposed | Email to the client's admins, then a call; what happened, what data, what we have done, what they should do |
| Clients in HIPAA mode | As above, and within **60 days** at most of discovery (HIPAA §164.410), with what the BAA asks for | As above, plus the BAA's contact |
| Providers (Intuit, Plaid, Google and others) | As each agreement requires, usually within 24 to 72 hours | Their security contact |
| Authorities | As the law requires where the affected people are | Through counsel |
| Our vendors | When their system is involved | Their security contact |

Nobody outside the incident hears about it before the affected clients do.

## 7. Keeping records

For every incident of severity 1 or 2, keep for six years: the timeline, the decisions and who
made them, the notices sent with their dates, the review, and the changes made. The audit log is
kept six years in any case.

## 8. Practice

Once a year, walk through a likely incident against this policy (the incident drill routine,
`ROUTINES` in `packages/core/src/compliance/controls.ts`), write down what to change and change it.

## 9. Review and exceptions

The security officer reviews this policy every year, after every severity 1 or 2 incident and
after each drill. An exception needs the security officer's written approval, a reason and an end
date.

## Record

| Date | Version | Change | Approved |
|---|---|---|---|
| 2026-11-22 | 0.1 | First draft, for the owner to adopt | Not yet |
