# QuickBooks Online connector: notes

Written 2026-11-05. Intuit's developer docs (`developer.intuit.com`) could not be reached from the
build environment, and nothing has been called live. Everything below comes from what we knew of
the QBO v3 API before. The tests run against a fake QuickBooks (`fake.ts`) shaped the same way, so
**a mistake here is a mistake in the fake too**. Check each item under "To verify" against the docs
and the sandbox company (realm `9341458640918607`) before the shop's production QuickBooks is
connected.

## What we built on

| Fact | Where in the code |
|---|---|
| Authorize at `https://appcenter.intuit.com/connect/oauth2` with `client_id`, `response_type=code`, `scope`, `redirect_uri`, `state`; the callback carries `code`, `state` and `realmId` | `index.ts` (`authorize`, `handleCallback`) |
| Scope `com.intuit.quickbooks.accounting` only | `api.ts` `QBO_SCOPE` |
| Token endpoint `POST https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`, Basic auth (`client_id:client_secret`), form body `grant_type=authorization_code&code&redirect_uri` or `grant_type=refresh_token&refresh_token`; answer `access_token`, `refresh_token`, `token_type`, `expires_in` (3600), `x_refresh_token_expires_in` (about 100 days); `{"error":"invalid_grant"}` when the grant is gone | `api.ts` `qboTokenCall`, `qboRefresher` |
| Every refresh may return a new refresh token; the newest one must be stored every time | `oauth/tokens.ts` stores it; `qboRefresher` shares one refresh per refresh token in an isolate |
| Revoke at `POST https://developer.api.intuit.com/v2/oauth2/tokens/revoke`, Basic auth, JSON `{"token": "<refresh token>"}`; revoking the refresh token ends the grant | `index.ts` `revoke` |
| API base `https://sandbox-quickbooks.api.intuit.com` (sandbox) and `https://quickbooks.api.intuit.com` (production), paths `/v3/company/{realmId}/…`, `Accept: application/json` | `api.ts` |
| `minorversion=75` on every call (75 became the base minor version in 2025) | `api.ts` `QBO_MINOR_VERSION` |
| Query: `GET /query?query=select * from Bill where … orderby … startposition N maxresults M` (at most 1000), answer `QueryResponse.<Entity>[]`; string literals in single quotes, a quote escaped with a backslash | `api.ts` `query`, `qboLiteral` |
| Read: `GET /bill/{id}` → `{ "Bill": {…} }`; an unknown id answers 400 with `Fault.Error[].code` `610` (Object Not Found) | `api.ts` `read` |
| Update: `POST /bill` (`/purchase`, `/item`) with `Id`, `SyncToken`, `sparse: true` and the fields to change; a sparse `Line` replaces the whole line list; the answer is the new record with the next `SyncToken` | `tools.ts` |
| A stale `SyncToken` is refused with 400, `Fault.Error[].code` `5010` (Stale Object Error) | `api.ts` → `QboStaleObjectError` |
| `requestid` query parameter makes a write idempotent: the same id within Intuit's window gets the first answer | `api.ts` `qboRequestId` (from the external action's idempotency key) |
| Errors: `Fault.Error[{Message, Detail, code}]`, auth errors as lower-case `fault.error[]` | `api.ts` `readFault` |
| 401 means the access token expired: refresh once and retry | `api.ts` via `tokenManager.withAccessToken` |
| Throttling: about 500 requests a minute and 10 at once per company; over it, 429 | `api.ts` `RealmThrottle` (450/min, 10 at once, per isolate), 3 retries at 1 s, 2 s, 4 s or `Retry-After` |
| CDC: `GET /cdc?entities=Bill,Purchase,…&changedSince=<ISO time>` → `CDCResponse[].QueryResponse[]` with one block per entity; deleted records come as `{ "Id", "status": "Deleted", "MetaData.LastUpdatedTime" }`; at most 30 days back and 1000 objects per entity per answer, no paging | `sync.ts` |
| Attachable: `FileName`, `ContentType`, `Size`, `Note`, `AttachableRef[].EntityRef {type, value}`; notes have no file | `@countersign/core` `mapQboAttachable` |
| Download: `GET /download/{attachableId}` answers a short-lived link (text); the link needs no token | `api.ts` `download` |
| Upload: `POST /upload`, `multipart/form-data` with `file_metadata_0` (JSON Attachable with `AttachableRef`, `FileName`, `ContentType`) and `file_content_0` (the file); answer `AttachableResponse[].Attachable` | `api.ts` `upload` |
| List a record's attachments: `select * from Attachable where AttachableRef.EntityRef.Type = 'Bill' and AttachableRef.EntityRef.value = '145'` | `tools.ts` |
| Company name: `GET /companyinfo/{realmId}` → `CompanyInfo.CompanyName`, `Country` | `index.ts` `handleCallback` |
| Webhooks: one endpoint per app; header `intuit-signature` = base64 HMAC-SHA256 of the raw body under the app's verifier token; body `{ eventNotifications: [{ realmId, dataChangeEvent: { entities: [{ name, id, operation, lastUpdated }] } }] }`; Intuit wants a quick 200 | `webhook.ts`; apps/api `routes/qbo.ts` |
| No webhook for Attachable (owner, 2026-11-05: the app subscribes to Account, Bill, Item, Purchase, Vendor) | Attachments come from CDC, every 15 minutes and on any webhook |

## To verify

Against the docs:

1. The minor version: is 75 still the base, and does anything we read or send change with it?
2. CDC: the 30-day limit, the 1000-object cap per entity, whether `Attachable` and `VendorCredit`
   are accepted in `entities`, the `changedSince` formats accepted (we send UTC with `Z`), and the
   exact shape of a deleted record.
3. Throttling numbers (500 a minute, 10 at once per realm; separate limits for batch and for
   attachments?) and whether 429 answers carry `Retry-After`.
4. `requestid`: its maximum length (we send 36 hex characters), how long Intuit remembers it, and
   whether `/upload` honours it.
5. Sparse updates: whether a sparse `Purchase` update needs `PaymentType` and `AccountRef` (we send
   them unchanged), whether a sparse `Item` update needs `Name` (we send it unchanged), and that a
   sparse `Line` replaces the whole list (kept lines are sent back with their `Id`).
6. Whether QBO checks `Amount = Qty × UnitPrice` on item lines, and its rounding (we refuse lines
   where the amount is not qty × unit price rounded half up to cents).
7. Whether QBO gives new lines the ids of lines they replace (our "already done" check does not
   rely on line ids).
8. Query filters we use: `VendorRef = '…'` on Bill, `EntityRef = '…'` on Purchase, `Id in (…)`,
   `DocNumber`, `TxnDate` ranges, `DisplayName like '%…%'`, `Name like '%…%'`, and
   `AttachableRef.EntityRef.Type` / `.value` on Attachable. Also that `select * from Vendor` returns
   active vendors only.
9. Download: that `/download/{id}` answers the link as plain text, its lifetime, and the hosts it
   points at (we refuse anything that is not public `https`).
10. Upload: the multipart part names, which content types QBO takes, the size limit (we send our
    documents, at most 32 MB), and the answer's shape on a refusal.
11. Webhooks: the header name and encoding (base64, not hex); the classic `eventNotifications`
    body versus the CloudEvents array Intuit announced moving to (we read both: which one does the
    "Mezonas" app get, and from when?); retries and their timing.
12. Refresh tokens: whether an older refresh token keeps working for a while after a newer one is
    issued. If it does not, two isolates refreshing at once could disconnect a client (one isolate
    shares its refresh; across isolates we rely on Intuit giving the same answer). Watch for
    `invalid_grant` right after a refresh in the logs.
13. The current Intuit developer terms and what production keys need (app review, the security
    questionnaire, the EULA and privacy policy links: the public site has them, §1.29).

Against the sandbox company (`9341458640918607`, QBO Plus, US):

1. Sign in from staging's portal: the callback lands on `/api/connections/qbo/callback`, forwards to
   `/connections/qbo/callback`, and the connection shows "Harbor…" (the sandbox's real name).
2. The first sync: vendors, items, 90 days of purchases, bills and vendor credits, attachments as
   documents linked to their transactions, no runs started.
3. Create a bill in the sandbox with a PDF attached: the webhook starts a sync within a minute, the
   bill becomes a transaction and `transaction.created` starts an intake agent. The attachment
   arrives by the next 15-minute CDC (no webhook for Attachable).
4. Itemize that bill from a run, approved in the portal: lines replaced, `TotalAmt` unchanged,
   `SyncToken` moved on; edit the bill in QuickBooks while an approval waits and check the action
   fails as stale.
5. Attach an uploaded invoice: it shows in the bill's attachments in QuickBooks.
6. Update a memo and an item's purchase cost.
7. Disconnect from the portal: the app disappears from the sandbox company's connected apps.
8. Throttle by running a full sync and an agent at once; look for 429s in the logs.

## Accounts receivable and create bill (v0.12, W1-F, 2026-11-06)

Built the same way: against the fake, from what we knew of the API, nothing called live.

| Fact we built on | Where in the code |
|---|---|
| `Customer`, `Invoice` and `Payment` are queryable (`select * from Invoice where TxnDate >= …`) and accepted in CDC's `entities` | `sync.ts`, `@countersign/core` `QBO_SYNCED_ENTITIES` |
| Invoice: `CustomerRef {value, name}`, `DocNumber`, `TxnDate`, `DueDate`, `TotalAmt`, `Balance`, `PrivateNote`, `EmailStatus`, `Line[]` with `SalesItemLineDetail {ItemRef, Qty, UnitPrice}` and a `SubTotalLineDetail` line | core `QboInvoiceRaw`, `mapQboInvoice` |
| A payment lowers its invoices' `Balance` and moves their `SyncToken`, so CDC brings the invoices again; Payment `Line[].LinkedTxn[{TxnId, TxnType: "Invoice"}]`, `UnappliedAmt`, `PaymentRefNum` | `records.ts` `toPayment`; `fake.ts` `receivePayment` |
| A voided invoice keeps its row with `TotalAmt` 0, `Balance` 0 and a `PrivateNote` starting "Voided"; there is no void flag | core `isVoidedQboInvoice` |
| Report: `GET /reports/AgedReceivableDetail?report_date=YYYY-MM-DD&aging_method=Report_Date[&customer=<id>]`; columns carry `MetaData[{Name: "ColKey", Value}]` with keys `tx_date`, `txn_type`, `doc_num`, `cust_name`, `due_date`, `subt_amount`, `subt_open_bal`; rows are sections titled "Current", "1 - 30 days past due" … "91 or more days past due", data rows' `txn_type` cell has the transaction's `id`, the customer cell the customer's `id`; money as plain strings ("2280.50") | `ar.ts` `readAgingReport`, `fixtures/qbo/report-aged-receivable-detail.json` |
| Invoice filters `CustomerRef = '8'`, `Balance > '0'`, `DueDate < '…'`; Payment filter `CustomerRef = '…'`; `Bill` filter `DocNumber = '…'` matches exactly | `ar.ts`, `bill-create.ts` |
| A sparse Invoice update with only `Id`, `SyncToken`, `sparse` and `PrivateNote` changes the private note alone; `PrivateNote` holds at most 4000 characters | `ar.ts` `addNoteTool`, `QBO_PRIVATE_NOTE_MAX` |
| Create a bill: `POST /bill` with `VendorRef`, `DocNumber`, `TxnDate`, `DueDate`, `CurrencyRef`, `PrivateNote` and `Line[]` (both expense detail types), no `Id`; the answer is the bill with `Id` and `SyncToken` "0"; `requestid` makes it idempotent | `bill-create.ts` |

To verify (docs, then the sandbox company):

1. Every row above, especially the report's name, parameters, column keys, section titles and
   whether `aging_method=Report_Date` is the default; whether the report includes credit memos and
   journal entries (we keep invoices only).
2. How a voided invoice reads in the API and in CDC (our `void` rule), and whether a deleted
   invoice comes through CDC as `status: "Deleted"` like the other entities.
3. The `PrivateNote` limit (4000?) and that a sparse update with only `PrivateNote` leaves lines,
   totals and the email status alone.
4. Whether a new bill in a company with automated sales tax or a home-currency mismatch gets a total
   other than its lines (we fail the action for a person if so).
5. Webhooks: the Intuit app's subscription is Account, Bill, Item, Purchase and Vendor. Add
   Customer, Invoice and Payment so a payment syncs within a minute (CDC every 15 minutes covers it
   meanwhile).
6. Sandbox walk: connect, see invoices and payments sync (365 days), receive a payment and see the
   receivable become paid with `receivable.paid`, read the aging report and compare it with
   QuickBooks' own screen, add a note to an invoice, create a bill from an uploaded invoice.

## QuickBooks ingredients (P-2, 2026-11-07)

Built the same way: against the fake, from what we knew of the API, nothing called live.

| Fact we built on | Where in the code |
|---|---|
| `Account` is queryable with `AccountType in ('Expense', …)`, `Name like '%…%'`, `Active = true` / `Active = false`; it carries `Name`, `FullyQualifiedName` (parents joined by `:`), `AccountType` (words, e.g. "Cost of Goods Sold"), `AccountSubType` (one word, e.g. "SuppliesMaterialsCogs"), `Active`, `CurrencyRef` | `ingredients.ts` `accountQueryTool`, `records.ts` `toAccount` |
| `Class` is queryable the same way and carries `Name`, `FullyQualifiedName`, `Active` (and `SubClass`, `ParentRef`) | `ingredients.ts` `classQueryTool`, `records.ts` `toClass` |
| Name lists answer active records unless asked otherwise, and `Active in (true, false)` brings inactive ones too | `tool-kit.ts` `lineRefsProblem`, `ingredients.ts` `vendorsNamed`; our reads always send `Active = …` |
| Both expense line details (`AccountBasedExpenseLineDetail`, `ItemBasedExpenseLineDetail`) take `ClassRef`, `CustomerRef` and `BillableStatus` (`Billable`, `NotBillable`, `HasBeenBilled`) on bills, purchases and purchase orders | `tool-kit.ts` `lineCoding`, `wireLine` |
| A bill line's class is kept when the company tracks classes per line ("Assign classes: one to each row in transaction"); with classes per transaction or off, QuickBooks ignores or refuses a line's `ClassRef` | not handled: the line's class is sent as given |
| Create a vendor: `POST /vendor` with `DisplayName` (required, at most 500 characters), `CompanyName`, `PrimaryEmailAddr.Address`, `PrimaryPhone.FreeFormNumber`, `BillAddr` (`Line1`, `Line2`, `City`, `CountrySubDivisionCode`, `PostalCode`, `Country`), `TermRef`; the answer is the vendor with `Id` and `SyncToken` "0" | `ingredients.ts` `vendorCreateTool` |
| Display names are unique across vendors, customers and employees, case aside: a taken one answers 400 with code `6240` ("Duplicate Name Exists Error") | `ingredients.ts` (mapped to a duplicate refusal) |
| `GET /term/{id}` reads payment terms (`Name`, `Active`) | `ingredients.ts` `companyTerms` |
| Create a purchase order: `POST /purchaseorder` with `VendorRef`, `APAccountRef`, `DocNumber`, `TxnDate`, `DueDate` (the expected date), `CurrencyRef`, `PrivateNote` (the memo the vendor doesn't see), `ShipAddr`, `Line[]` (both expense detail types); the answer has `POStatus` "Open" and `TotalAmt` | `purchase-order.ts` |
| `APAccountRef` on a purchase order: we send the one active Accounts Payable account in the order's currency, or none | `purchase-order.ts` `payablesAccount` |
| `PurchaseOrder` is queryable by `Id in (…)`, `DocNumber =`, `VendorRef =`, `POStatus =`, `TxnDate` ranges | `purchase-order.ts` |
| Creating a purchase order doesn't email it to the vendor (`EmailStatus` stays "NotSet") | the approval card says we don't send it |

To verify (docs, then the sandbox company):

1. Every row above, first whether `APAccountRef` is required on a new purchase order, and what
   QuickBooks does with a company that has more than one A/P account.
2. The `like` operator on `Account.Name` and `Class.Name`: case, and whether `%` works at both ends.
3. Whether `AccountType in (…)` takes the words ("Cost of Goods Sold") or the enum names
   (`CostOfGoodsSold`) in a query; we send what an agent gives, and the fake keeps the words.
4. Class tracking: which company setting makes a line's `ClassRef` stick, and what the API answers
   when classes are off. We could read `Preferences.AccountingInfoPrefs.ClassTrackingPerLine` and
   refuse early; we don't yet.
5. `BillableStatus` on a purchase order line: kept, ignored or refused? And whether a line with a
   customer and no `BillableStatus` defaults to `NotBillable` (we always send one).
6. Duplicate vendor names: whether `6240` is also the code when the name is an inactive vendor's,
   and the limit on `DisplayName` (500?), `CompanyName` (100?) and `FreeFormNumber` (30?).
7. Whether `requestid` is honoured on `POST /vendor` and `POST /purchaseorder` as on bills.
8. Sandbox walk: list accounts and classes, add a vendor, create a purchase order for it with a
   class and a billable customer on a line, see it open in QuickBooks, then receive it into a bill
   by hand and check the order closes (we don't link bills to orders yet).
