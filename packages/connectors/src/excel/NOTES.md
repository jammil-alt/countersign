# Excel connector (`Files.ReadWrite`, picked workbooks): notes

Written 2026-11-12 for the Microsoft connectors (`docs/plan.md` §1.97). Microsoft's Graph docs
were read on learn.microsoft.com for the calls below (range get and update, worksheet list, used
range, sessions, drive item search, the error codes) and Office.js's `Excel.Range.values` for how
Excel reads values. The connector and its fake (`fake.ts`) follow them; nothing has been checked
against Microsoft's live services. Every item under "To verify" must be checked with one Microsoft
365 work account and one personal Microsoft account (a test workbook in each OneDrive) before a
client connects, and the connector and fake fixed where they differ. Sign-in is shared with the
other Microsoft connectors (`../microsoft/identity.ts`); its own unchecked facts are in
`../outlook/NOTES.md`.

## What the connector does

- Sign-in: Excel's **own Entra app** (`EXCEL_CLIENT_ID` / `EXCEL_CLIENT_SECRET`), the authorization
  code flow on the `common` endpoint (work, school and personal accounts), scopes
  `openid email offline_access https://graph.microsoft.com/Files.ReadWrite`,
  `prompt=select_account`. The callback refuses, storing nothing, a grant without
  `Files.ReadWrite` or with any Graph scope beyond it and `User.Read` (e.g. `Files.ReadWrite.All`,
  `Files.Read.All`, `Sites.*`, `Mail.*`). Redirect: `<origin>/connections/excel/callback`.
- `config` = `{address, tid, scopes: ["Files.ReadWrite"], workbooks: [...]}`; `address` and `tid`
  (the account's directory) come from the ID token. A reconnect keeps `workbooks`.
- Tokens encrypted in the vault with the client's own key; refresh before expiry and once after a
  401; Microsoft rotates refresh tokens and we keep the new one; `invalid_grant` asks for a
  reconnect. Disconnect drops our tokens only (no revoke endpoint; as Outlook).
- **The scope trade-off.** `Files.ReadWrite` is Microsoft's least privilege for the workbook API
  (range get and update both list it as the least privileged delegated permission; there is no
  per-file delegated scope like Google's `drive.file`). It reaches **every file in the signed-in
  person's own OneDrive**, not files shared with them (that is `Files.ReadWrite.All`). Our code
  narrows it: the client admin picks workbooks, and every tool refuses any other workbook before
  calling Microsoft. The consent screen still says "your files", and the portal should say so in
  plain words.
- Picking (not a tool): the portal searches the person's own OneDrive,
  `GET /me/drive/root/search(q='<text>')?$select=…&$top=200` (`'` doubled; an empty search asks
  for `.xlsx`), keeps `.xlsx` files that aren't `remoteItem` or deleted, 50 at most, one page.
  The ids picked go to the API, which checks each with the connection's own token
  (`GET /me/drive/items/<id>?$select=id,name,file,webUrl,remoteItem,deleted,package,parentReference`:
  in this drive, an `.xlsx` name, the `.xlsx` MIME type when given) and keeps
  `{id, name, url, account, tid, addedAt}`. We don't embed Microsoft's file picker in v1.
- Every tool checks the workbook id against the picked list (picked by the address **and**
  directory connected now) before calling Microsoft: anything else is `WorkbookNotPickedError`.
- All calls are sessionless (no `workbook-session-id`): Microsoft says changes are then saved to
  the file, and it is slower than a session, which is fine for a few calls per step.
- Worksheets: `GET /me/drive/items/<id>/workbook/worksheets?$select=id,name,position,visibility`;
  the default is the first visible worksheet by `position`. Later calls name the worksheet by its
  **id** (Microsoft: it stays the same when the worksheet is renamed or moved), URL-encoded.
- `excel.range.read` (read, entity `row`): `GET …/worksheets/<id>/usedRange(valuesOnly=true)`
  (a blank worksheet answers its top-left cell, so a lone `A1` is read to tell empty from one
  value), then `GET …/range(address='<A1>')?$select=address,<text|values|formulas>` for at most
  `limit` rows (1000 at most) and 100 columns, never past the last row with data. Trailing empty
  cells and rows are trimmed, as Google answers.
- `excel.rows.append` (external, `create`, entity `row`): before state = the last row with data,
  its cells (100 columns at most), the next row. The run records the attempt first (the platform's
  `attempts` services, as Slack; `details` has the worksheet id and the range), then
  `PATCH …/range(address='A<next>:<col><end>')` with `{values}`. A retry: a recorded result comes
  back (`alreadyDone`); an open attempt reads its cells and is confirmed only if they hold exactly
  our rows, otherwise `UnconfirmedWriteError` (never written twice). A 4xx (429 included) or a
  401 counts as refused (nothing written), and the action may try again, three attempts at most;
  a 5xx or no answer leaves the attempt open.
- `excel.range.update` (external, `update`, entity `row`): before state = the cells' contents read
  as `formulas`. The run returns `alreadyDone` if the cells already hold the new values, refuses
  (`WorkbookChangedError`) if they differ from what the approver saw (`external_action.before`),
  else `PATCH …/range(address='<A1>')` with `{values}` (null keeps a cell). R5 undo: a restore
  with the same tool (`excelRestoreInput`), refused when a replaced cell held a formula.
- **Text never becomes a formula.** Graph's range PATCH takes `values` as typed input: Office.js
  says a value starting with `=`, `+` or `-` is read as a formula (and Excel turns "1/2" or
  "2026-10-07" into dates, "100" into a number). So every non-empty text is sent with Excel's
  quote prefix `'`, which stores what follows as text exactly; text that could start a formula
  (`=`, `+`, `-`, `@`, tab, CR) also keeps a visible `'` (Sheets' `writtenCell`), so it stays text
  in a CSV export opened elsewhere: `=1+1` is sent as `''=1+1` and the cell holds `'=1+1`. Numbers
  and true/false go as JSON. We never send `formulas`, `formulasLocal` or `numberFormat`.

## To verify

Workbook API:

- **The quote prefix through Graph**: a `values` string starting with `'` is stored as text
  without the `'` (as typed in Excel: `prefixCharacter`), so `"'2026-10-07"` stays text and
  `"''=1+1"` holds `'=1+1`. If Graph instead keeps the first `'` as a character, every text cell
  would show a leading `'`: then send text without the prefix and set `numberFormat: "@"` on those
  cells in the same PATCH (check that the format applies before the value), or write through a
  table. Also check that `@`-leading text (implicit intersection) is read as a formula, and that
  tab- or CR-leading text is not.
- `values` read back for a quote-prefixed cell is the text without the prefix; `formulas` for it is
  the same text (not `'…`), and for a real formula the formula text. Our stale check and the retry
  check (`excelHolds`) depend on both; the restore refuses formula-looking text either way.
- `$select` on a range (`?$select=address,values`) and on `usedRange(valuesOnly=true)` is honoured;
  `usedRange(valuesOnly=true)` answers `rowIndex`, `rowCount`, `columnIndex`, `columnCount`; an
  empty worksheet answers `A1` (not 404 `itemNotFound`, as Office.js's `getUsedRange` throws).
- Worksheet ids such as `{00000000-0001-0000-0000-000000000000}` work URL-encoded
  (`%7B…%7D`) in `worksheets/<id>`; personal-account item ids with `!` work unencoded
  (`encodeURIComponent` leaves `!`).
- A PATCH whose `values` doesn't match the range's size answers 400 and writes nothing; a PATCH is
  all or nothing (no partial rows after a 5xx).
- Sessionless PATCHes are saved at once and visible to the next sessionless GET (no lag), so a
  retry's read of an open attempt's cells sees what the lost PATCH wrote. If there can be lag, an
  open attempt whose cells are still empty must stay unconfirmed (it does: only a full match
  confirms).
- A workbook open in Excel desktop or Excel for the web: does a PATCH wait, fail with 409
  (`editModeCannotAcquireLock` or similar, treated as refused) or merge? Co-authoring may also move
  the last row between our before read and the PATCH.
- Throttling: 429 with `Retry-After` (retryable); 503/504 may or may not have applied the write.
- Limits: Graph's 4 MB request body; Excel's 32,767 characters per cell; the workbook API's file
  size limit (we believe 100 MB for some calls); workbooks with sensitivity labels or IRM.
- Errors: 404 `itemNotFound` for an item not in this drive or deleted; 400 `unsupportedWorkbook`
  for a non-.xlsx file.

Picking and search:

- `GET /me/drive/root/search(q=…)` stays in the person's own drive (no `remoteItem` results);
  `/me/drive/search` would add items shared with them. We filter `remoteItem` either way.
- An empty search asks for `.xlsx`: check it lists the person's workbooks (search matches names,
  metadata and content), or use `$filter` / a recent-files list instead.
- Search text with `/`, `#`, `%` or `?` URL-encoded inside `q='…'`; Microsoft's search index lag
  (a workbook made minutes ago may not be found yet).
- `file.mimeType` for `.xlsx` is `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
  on both account kinds; `webUrl` opens the workbook in Excel for the web.
- `parentReference.path` is `/drive/root:/<folder>` (personal) or `/drives/<id>/root:/<folder>`
  (work), percent-encoded; search results may leave it out.

Sign-in (beyond `../outlook/NOTES.md`):

- `Files.ReadWrite` is a user-consentable delegated scope for work accounts (no admin consent),
  unless the tenant blocks user consent.
- A grant's `scope` lists `Files.ReadWrite` (short or full form), never `Files.ReadWrite.All` when
  only `Files.ReadWrite` was asked, even if the person consented to `.All` for another app.

## Not covered

- **SharePoint and Teams workbooks**: only the signed-in person's own OneDrive. A later step can
  reach SharePoint document libraries with `Sites.Selected` (an admin grants the app access to
  named sites) through `/sites/<site>/drive/items/<id>/workbook`.
- Files shared with the person from someone else's OneDrive (`Files.ReadWrite.All`).
- Excel tables (`/tables/<id>/rows/add` grows a table and is atomic per call): rows go below the
  used range, so a table directly above them doesn't grow. A table-aware append is a follow-up.
- `.xls`, `.xlsm`, `.xlsb` and `.csv` files (the workbook API opens `.xlsx` only).
- Microsoft's file picker (OneDrive File Picker v8) in the portal.
- Creating workbooks or worksheets, deleting rows or cells (delete stays off), formatting,
  formulas, workbook sessions.
