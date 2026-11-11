# BILL connector: notes

Written 2026-11-10 without network access to BILL's developer docs (`developer.bill.com`), a BILL
developer key or a BILL sandbox organization. What the owner's brief gave from BILL's docs is
marked **from the brief**; everything else is **UNCHECKED** until the owner's developer key exists
and a sandbox organization is connected. The fake (`./fake.ts`) answers in the shapes listed here,
so a fact that turns out wrong is fixed in three places: this file, `./api.ts` / `./records.ts` /
`./index.ts`, and the fake.

## Hosts, keys and sign-in

| Fact | Status |
|---|---|
| v3 REST API at `https://gateway.stage.bill.com/connect/v3` (sandbox) and `https://gateway.prod.bill.com/connect/v3` (production); `BILL_ENV` picks one | from the brief |
| `POST /v3/login` with JSON `{username, password, organizationId, devKey}` answers a `sessionId` | from the brief |
| Every later request sends `devKey` and `sessionId` as headers | from the brief |
| The login answer also has `organizationId`, `userId` and `trusted` (whether the session is MFA-trusted) | **UNCHECKED**: we read `trusted` only to know it; nothing relies on it |
| A sandbox developer key works only against the sandbox host, a production key only against production | **UNCHECKED** |
| A login is refused with a 4xx and an error naming why; a wrong developer key is told apart by its message mentioning the dev key (we then refuse as "not set up here" instead of putting the client's connection in error) | **UNCHECKED**: the codes (the fake uses `BDC_1101` for the key and `BDC_1102` for the login) |
| Sessions end after about 35 minutes without a call, and on `POST /v3/logout` | **UNCHECKED**. We sign out at the end of every tool call (or skill run that holds the session) |
| An ended session answers 401, or v2's code `BDC_1109` ("Session is invalid") | **UNCHECKED**. We sign in again once and repeat the request; a second refusal needs a person (the connection goes to `error`) |
| How many sessions one BILL user may have at once | **UNCHECKED**. Each call has its own; two runs at once have two |
| The organization id starts with `008` and is in Settings, Profiles, Organization | **UNCHECKED** (the vault's hint says so) |
| A dedicated BILL user with a role below Administrator (e.g. Accountant, Clerk) can read vendors, bills and payments and create and change bills and vendors | **UNCHECKED**: which role is the smallest that does the job. The owner should pick one and say so in the portal's hint |
| Rate limit: about 20,000 requests an hour per developer key | **UNCHECKED** (brief: "reportedly"). We send no throttle; a 429 is a retryable refusal. BILL is also said to limit concurrent requests per organization: **UNCHECKED** |

## API used

All under the v3 base, with `devKey` and `sessionId` headers.

| Use | Endpoint | Status |
|---|---|---|
| Lists (vendors, bills, payments) | `GET /<thing>?max=<1..100>&page=<cursor>&filters=<…>` → `{results, nextPage, prevPage}` | **UNCHECKED**: the names `max`, `page`, `nextPage`, `results` |
| Filters | `filters=field:op:"value",field:op:value` with ops `eq`, `sw` (starts with), `gte`, `lte`; booleans bare (`archived:eq:false`) | **UNCHECKED**: the syntax, which fields can be filtered, and whether `sw` is case-insensitive. Our filters are applied again to the page BILL gives, so a filter BILL ignores never widens a result (it may make a page shorter) |
| Vendors | `GET /vendors`, `GET /vendors/{id}`, `POST /vendors`, `PATCH /vendors/{id}` | from the brief (list/search, get, create, update) |
| Vendor fields | `id`, `name`, `accountType` (`BUSINESS`/`PERSON`), `email`, `phone`, `accountNumber`, `address {line1, line2, city, stateOrProvince, zipOrPostalCode, country}`, `archived`, `createdTime`, `updatedTime` | **UNCHECKED**: the field names, whether `accountType` is required on create, whether an address or payment details are required, and the country's form (we pass what the agent gives) |
| Bills | `GET /bills`, `GET /bills/{id}`, `POST /bills`, `PATCH /bills/{id}`, `POST /bills/{id}/archive` | from the brief (list, get, create, update, archive); the archive path is **UNCHECKED** |
| Bill fields | `vendorId`, `invoice {invoiceNumber, invoiceDate}`, `dueDate`, `description`, `billLineItems [{amount, description, chartOfAccountId}]`, `amount`, `dueAmount`, `paymentStatus` (`UNPAID`, `PARTIAL`, `SCHEDULED`, `PAID`), `approvalStatus`, `archived` | **UNCHECKED**: the names, the payment statuses, whether a line can name an item instead of an account |
| Several bills in one call | `POST /bills/bulk` | from the brief; **not used**: one bill per external action, so each is approved, undone and checked for a duplicate on its own |
| A PATCH merges nested objects | **UNCHECKED**. We send both `invoice` fields whenever either changes |
| Clearing a field with `null` in a PATCH | **UNCHECKED**. So an update whose before value was empty has no undo |
| BILL refuses to change or archive a bill with a payment scheduled or made | **UNCHECKED**. We refuse it ourselves first (payment status other than `UNPAID`) |
| Archived bills can be restored (`POST /bills/{id}/restore`) | **UNCHECKED**; not used (archive's own undo is `none`) |
| Duplicate invoice numbers: BILL warns or refuses a second bill with the same vendor and invoice number | **UNCHECKED**. We look ourselves: a vendor's open bills (up to 1,000), numbers compared on letters and digits |
| Idempotency keys on creates | **UNCHECKED** whether v3 takes one. We use none: a retried create finds its own earlier write (a bill: same vendor, number, total and line count; a vendor: same name and fields, made in the last day; a document: same file name on the bill) and reports it done |
| Amounts | JSON numbers in dollars on the wire, both ways | **UNCHECKED** (dollars, not cents). Read through text into decimals (`dec(String(n))`); written from the decimal's text (`billcomJson`), never through a float |
| Currency | v3 records name none for a US organization; a 3-letter `currency` is read when present | **UNCHECKED**. Bills we create must say `USD`; other currencies are refused until a non-US organization is checked |
| Payments | `GET /payments`, `GET /payments/{id}`; `POST /payments` and `/payments/bulk` need an MFA-trusted session | from the brief. Payment fields (`vendorId`, `vendorName`, `amount`, `status`, `processDate`, `billPayments [{billId, amount}]`) are **UNCHECKED** |
| Bill documents | `POST /attachments/bills/{billId}?name=<file name>` with the file's bytes as the body and its type as `Content-Type`, answering `{id, …}`; `GET /documents/bills/{billId}` lists them as `{results: [{id, name}]}` or an array | **UNCHECKED**: both paths, the body (raw bytes or multipart), the answer, the accepted types (we send PDF, PNG, JPEG, GIF, TIFF) and the size limit (we refuse above 10 MB) |
| Errors | an array of `{timestamp, code, severity, category, message}` (or one such object) | **UNCHECKED**. 400/422 → `invalid_input`, 403 → `forbidden`, 404 → `not_found`, 409 → `conflict`, 429 → `rate_limited` (retryable): each a refusal, not written. A 5xx, no answer, or an answer that doesn't read after a write was sent is an unconfirmed write (the operator checks); on a read it is retryable |

## Ids

Tool inputs that go into a URL path or a filter are BILL ids of letters and digits only
(`BillcomId`), and filter text has no quotes or backslashes. **UNCHECKED** that every BILL id is
letters and digits (vendors `009…`, bills `00n…`, organizations `008…`).

## Not built

- Payments (`billcom.payment.create` refuses): BILL needs an MFA-trusted session, so a payment
  needs the BILL user's second factor through our code service (`apps/mfa`), as browser logins
  do. Until then the tool refuses before calling BILL; its entity starts off and it is always
  signed by a person (docs/open.md).
- Webhooks or a poll for new bills (no `billcom.*` events yet).
- Checking the login when the client admin enters it (the vault's form stores it as entered; the
  first call shows whether BILL takes it, and a refusal puts the connection in `error`).
- Vendor archive, bill restore, vendor credits, approvals in BILL, recurring bills.

## To verify (sandbox first)

1. Sign in with the sandbox developer key and a dedicated sandbox user; read `trusted` and the
   session's lifetime.
2. Each list with `max`, `page` and one filter; check `nextPage` and the filter syntax.
3. Create a vendor (with and without an address) and a bill with two lines; read both back and
   compare the field names with `./records.ts`.
4. PATCH a bill's due date only and its invoice number only; see what happens to `invoice`.
5. Archive the created bill; try to archive a paid one and note the error.
6. Attach a PDF to a bill; list the bill's documents.
7. Send a request with an ended session and note the status and code; send 0 for `max` and note
   a validation error's shape.
8. Try `POST /payments` without an MFA-trusted session and note the refusal (no money moves).
