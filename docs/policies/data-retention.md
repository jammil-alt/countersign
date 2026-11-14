# Data retention and deletion policy

**Twelve Thirty-Four Consulting LLC, doing business as Mezonas**
Version 1.0 · Adopted 2026-11-09 · Owner: Jammil, Founder & CEO (security officer) · Next review: 2027-11-09

## 1. Purpose and scope

This policy says how long we keep each kind of data, and how and when we delete it. It covers all
client data (including data from Plaid, Intuit and Google), our users' account data, logs and
backups. Where the code enforces a rule, the table says how.

## 2. Principles

- We keep client data only while we provide the service to that client, and only what the service
  needs.
- A client controls its connections: disconnecting stops our access and deletes our stored token at
  once.
- When the service ends, or a client asks, we delete its data within 30 days, except what the law
  requires us to keep.
- Deletion is recorded in the audit log.

## 3. How long we keep each kind of data

| Data | Kept | How it is deleted |
|---|---|---|
| Client records from connected tools (QuickBooks records, bank and card transactions and balances from Plaid, bookings, reconciliations) | While the client uses the service | Purged with the client's rows within 30 days after the service ends (`db:purge-client`) |
| Documents and files a client uploads or forwards (invoices, statements, exports) | While the client uses the service | Deleted automatically 30 days after the client is retired (hourly job) |
| Forwarded email | Headers and attachments only; message bodies are never stored | As documents |
| Connection tokens, keys and logins (Plaid access tokens, Intuit and Google tokens, browser logins) | Until the client disconnects or leaves | Deleted on disconnect; the Plaid Item is removed (`/item/remove`) and Intuit and Google tokens are revoked. At exit the client's key is destroyed, which makes anything still encrypted with it unreadable |
| Second-factor and release codes | Until used, at most 10 minutes | Deleted automatically |
| Users' account data (name, email, role) | While the person has access, then with the client's data | Access removed by the client's admin or the security officer; the client's users are purged with its rows; the audit log keeps their id |
| Audit log | 6 years | Removed yearly by the security officer once older than 6 years. After a client's purge it keeps ids only |
| Website measurement (mezonas.com and clients' sites) | Raw events 90 days; visits 13 months; daily totals kept; the daily salt is deleted after its day | Deleted automatically (nightly job) |
| Error reports (Sentry) | Sentry's retention for our plan | Contain no client content, emails, IPs or keys |
| Data sent to AI model providers | Only for the task; never used for training | Held by the provider as its API terms state |
| Billing records (Stripe) | As tax law requires | Closed with the client's Stripe customer after the last invoice |
| Backups (Neon point-in-time history) | 7 days | Expire automatically, so deleted data leaves backups within 7 days |

## 4. When a client leaves or asks for deletion

1. On the day: retire the client in the back office. Its users lose access, its agents stop and every
   connection is disconnected (tokens deleted, Plaid Items removed, Intuit and Google access revoked).
   Close what other vendors hold for it (`docs/operations.md` §1.2).
2. If the client wants its data, export it before day 30.
3. Day 30: its files are deleted automatically; then the security officer purges its rows.
4. Within a further 7 days, backups have expired.

A client may ask us to delete specific data sooner; we do so within 30 days, or say why the law
requires us to keep it.

## 5. Bank data from Plaid

We use bank and card data only to keep the client's books and reconcile its accounts. We don't sell
it, share it for advertising, or use it to train models. When a client disconnects a bank, we stop
reading it at once and remove the Plaid Item; the transactions already read stay part of the
client's books until the client leaves or asks us to delete them, and are then deleted as in §4.

## 6. Review

The security officer reviews this policy every year and when we add a kind of data or a vendor, and
checks once a year that each automatic deletion in §3 still runs (the audit log records each one).

## Record

| Date | Version | Change | Approved |
|---|---|---|---|
| 2026-11-09 | 1.0 | First version | Jammil |
