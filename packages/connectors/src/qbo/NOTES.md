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
