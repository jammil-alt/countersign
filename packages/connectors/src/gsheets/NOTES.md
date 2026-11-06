# Google Sheets connector (`drive.file`, picked sheets): notes

Written 2026-11-06 for W4-D (`docs/plan.md` §1.52; ARCHITECTURE §6.11 row 7). Google's
documentation was not reachable from the build environment, so the connector, its fake (`fake.ts`)
and the portal's picking page follow Google OAuth 2.0, the Sheets API v4, the Drive API v3, the
Google Picker and Google Identity Services as we know them. Nothing has been checked against
Google's live services. Every item under "To verify" must be checked against Google's current docs
and a test spreadsheet before a client connects, and the code fixed where it differs.

## What the connector does

- Sign-in: authorization code flow on Google's OAuth client "Mezonas web" (the one Gmail and Drive
  use, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`), `access_type=offline`, `prompt=consent`,
  `include_granted_scopes=false`, one scope: `https://www.googleapis.com/auth/drive.file`. The
  callback refuses a grant without it or with any other scope (`spreadsheets`, `drive`,
  `drive.readonly`, …) and stores nothing then. Redirect: `<origin>/connections/gsheets/callback`.
- The address comes from Drive's `about.get` (as Drive). `config` = `{address, scopes:
  ["drive.file"], sheets: [...]}`; a reconnect keeps `sheets`.
- Tokens are encrypted in the vault with the client's own key. Refresh before expiry and once after
  a 401. Disconnect drops our tokens and never calls Google's revoke (the client is shared with Gmail
  and Drive).
- Picking: the portal's page `/connections/gsheets/pick` (loaded as its own document) loads
  `https://apis.google.com/js/api.js` (the Picker) and `https://accounts.google.com/gsi/client`
  (Google Identity Services). On "Open Google's picker" it asks Identity Services for a
  `drive.file` token for the connected account (`hint`), in a pop-up, then opens the Picker on
  spreadsheets only (`DocsView(SPREADSHEETS)`, `setMimeTypes`, multi-select) with
  `setDeveloperKey(GOOGLE_PICKER_API_KEY)`, `setAppId(GOOGLE_PROJECT_NUMBER)` and
  `setOrigin(location.origin)`. The ids picked go to `PUT /api/connections/gsheets/sheets`; the API
  checks each new one with the connection's own token (`GET /drive/v3/files/<id>?fields=id,name,
  mimeType,trashed,webViewLink`: a spreadsheet, not in the bin) and keeps `{id, name, url, account,
  addedAt}`. The browser's token stays in that page's memory and is never sent to our API.
- Every tool checks the spreadsheet id against the picked list (picked by the account connected
  now) before calling Google: anything else is `SheetNotPickedError`.
- `sheets.range.read` (read, entity `row`): `GET /v4/spreadsheets/<id>?fields=…` for the tab, then
  `GET /v4/spreadsheets/<id>/values/'<tab>'!<range>?majorDimension=ROWS&valueRenderOption=…`
  with an end row always set (the limit, 1000 at most, plus one to know whether there were more).
- `sheets.rows.append` (external, `create`, entity `row`): before state = the tab's rows down to the
  last with data (`values.get` of `A:<last column>`, 100 columns at most), the last row, the next
  row number. The run looks for its marker (`POST …/developerMetadata:search` with
  `developerMetadataLookup {metadataKey: "mezonasAction", metadataValue: <40 hex>}`), and returns
  those rows if found; otherwise one `POST …:batchUpdate` with `insertDimension` (rows at the
  next row), `updateCells` (typed `userEnteredValue`: `stringValue`, `numberValue`,
  `boolValue`; never `formulaValue`) and `createDeveloperMetadata` on those rows (`visibility:
  PROJECT`).
- `sheets.range.update` (external, `update`, entity `row`): before state = the cells' contents
  (`valueRenderOption=FORMULA`). The run returns `alreadyDone` if the cells already hold the new
  values, refuses (`SheetChangedError`) if they differ from what the approver saw
  (`external_action.before`), else `PUT …/values/'<tab>'!<range>?valueInputOption=RAW`.
- Text that could start a formula (`=`, `+`, `-`, `@`, tab, CR) is written with a leading `'`,
  except plain numbers as text (`-12.50`).

## To verify

OAuth and the shared client:

- `drive.file` is non-sensitive and already on the consent screen for Drive; the Sheets API accepts
  a `drive.file` token for the spreadsheets the app made or the person picked (we believe it does:
  Google lists `drive.file` among the Sheets API's scopes).
- The token answer's `scope` for this grant is exactly `drive.file` (no `openid` added).
- A Sheets sign-in by an account that already connected Gmail or Drive on the same client leaves
  their refresh tokens working (`include_granted_scopes=false`; 100 live refresh tokens per account
  and client).

Picker and Identity Services (the portal):

- The Picker needs an OAuth token; we take it from Identity Services' token client in the browser
  (`google.accounts.oauth2.initTokenClient`, scope `drive.file`, `hint`, `prompt: ""`), which needs
  the origins under "Authorized JavaScript origins" on the OAuth client. Check that a file picked
  this way is then readable with the **server's** refresh token of the same account and client
  (the grant is per project and account, as `setAppId` suggests).
- `setAppId` takes the project **number** (not the id), and the key needs the Picker API enabled
  and an HTTP referrer restriction to our origins.
- `DocsView(ViewId.SPREADSHEETS)` with `setMimeTypes("application/vnd.google-apps.spreadsheet")`
  shows Google Sheets only (not .xlsx in Drive); `docs[].id` is the spreadsheet id.
- The CSP the page needs, exactly: `script-src https://apis.google.com
  https://accounts.google.com/gsi/client`, `frame-src https://docs.google.com
  https://accounts.google.com/gsi/`, `connect-src https://accounts.google.com/gsi/`. If the Picker
  loads more (e.g. `https://www.gstatic.com`, or `https://*.googleusercontent.com` frames), add only
  what the browser's console reports, on the pick path only.
- Identity Services' pop-up needs `Cross-Origin-Opener-Policy: same-origin-allow-popups` on the
  opener; the rest of the portal keeps `same-origin`. `Referrer-Policy: same-origin` may stop the
  key's referrer check: if the Picker refuses the key, set `strict-origin-when-cross-origin` on
  the pick path only.
- Cloudflare's static assets apply a path rule in `_headers` (with `! Header` to detach the global
  one) to the SPA's fallback `index.html` served for `/connections/gsheets/pick`.
- Revoking the browser's token (`google.accounts.oauth2.revoke`) would end the whole grant for the
  client, our refresh token included, so the page never does it.

Sheets API v4:

- `GET /v4/spreadsheets/<id>?fields=spreadsheetId,properties.title,sheets.properties(sheetId,title,index,gridProperties(rowCount,columnCount))`.
- A spreadsheet not granted to the app answers **404** (or 403) under `drive.file`; both read as
  "pick it again".
- `values.get` trims trailing empty rows and cells, keeps empty rows in between as `[]`, and its
  `values` is absent when the range is empty.
- `valueRenderOption=FORMULA` returns a formula's text and other cells' values typed; RAW-written
  text starting with `'` reads back with the `'` (we accept it with or without:
  `holdsWritten`). With RAW, does Google keep the `'` as part of the text (shown in the cell), or
  treat it as the quote prefix? Either keeps the formula from running; the first shows the mark.
- `values.update` with `valueInputOption=RAW` stores strings as text (no formulas, no dates), and
  skips `null` cells; `""` empties a cell.
- `batchUpdate` is atomic: all requests apply or none. `insertDimension` with `startIndex` equal to
  the grid's `rowCount` is allowed (adds at the end); `inheritFromBefore` must be false at 0.
- **Developer metadata:** row-located metadata (`location.dimensionRange` on ROWS) can be made with
  `drive.file`, moves with its rows when rows are inserted, deleted or sorted, and is found by
  `developerMetadata:search` right after the `batchUpdate` answers (no index lag). If a lost answer
  is retried before the search sees the marker, the rows would be added twice: if Google's search
  can lag, record the attempt first (a raw record per key, as `gmail.send`) and stop for a person
  (`UnconfirmedWriteError`) instead.
- Limits on developer metadata: we believe 30,000 characters per location (each appended row is its
  own location) and per spreadsheet in total; each marker is about 55 characters, so a spreadsheet
  could hold ~500 appends' markers if the total limit is per spreadsheet. If so, delete markers older
  than a day in the same batch, or mark only the first row.
- Quotas: 300 read and 300 write requests per minute per project, 60 per user; 429 is retryable.
- Errors: 400 bad range or request, 401 bad token, 403/404 no access, 429, 5xx.

## Not built

- `sheets.spreadsheet.create` (optional in the brief): a sheet Mezonas makes would be added to the
  picked list the same way; not needed for the first use.
- Clearing or deleting rows or tabs (delete stays off everywhere), formatting, formulas.
- Shared drives (the Picker's `setEnableDrives`): the person's own Drive only.
- Reading more than the first 100 columns, or more than 1000 rows at once (page with `range`).
