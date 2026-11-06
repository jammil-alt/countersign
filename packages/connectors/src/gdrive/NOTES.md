# Google Drive connector (`drive.file`): notes

Written 2026-11-06 for M29 (`docs/plan.md` §1.52; ARCHITECTURE §6.11). Google's documentation was
not reachable from the build environment, so the connector and its fake (`fake.ts`) follow Google
OAuth 2.0 and the Drive API v3 as we know them. Nothing has been checked against Google's live
services. Every item under "To verify" must be checked against Google's current docs and a test
Drive before a client connects, and the connector and fake fixed where they differ.

## What the connector does

- Sign-in: authorization code flow on Google's OAuth client "Mezonas web" (the one Gmail uses,
  `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`), with `access_type=offline`, `prompt=consent`,
  `include_granted_scopes=false` and one scope: `https://www.googleapis.com/auth/drive.file`. The
  callback refuses a grant without it or with any other scope, and stores nothing then.
- The address: `drive.file` alone, no `openid email`. The signed-in address comes from
  `GET /drive/v3/about?fields=user(emailAddress,displayName)`, kept as the connection's account.
- The folder: at sign-in the connection makes `Mezonas` at the top of My Drive, or
  `Mezonas - <name>` when the callback's parameters carry `folder_name` (the portal page may post it
  beside Google's parameters; `/` and control characters become spaces, 80 characters at most). The
  folder is marked with `appProperties.mezonasRoot = "1"`. A reconnect finds it again (same name,
  ours, not in the bin) instead of making another. `config` keeps `{address, folderId, folderName,
  folderUrl, scopes: ["drive.file"]}`.
- Tokens (access, refresh, expiry, granted scope, address) are encrypted in the vault with the
  client's own key. Refresh before expiry (5 minutes' margin) and once after a 401; `invalid_grant`
  marks the connection as needing a person to connect again. Disconnect revokes the refresh token at
  Google's revoke endpoint (400 means already revoked).
- `drive.file.upload` (external, verb `create`, entity `file`, approval on by default): input
  `{documentId, path, date?, fileName?, ifExists}`. `path` is a template under the connection's
  folder with `{yyyy}`, `{yy}`, `{MM}`, `{dd}` filled from `date` (else today, UTC), e.g.
  `Bills/{yyyy}/{MM}`. Single braces, because `{{…}}` in a workflow step's input is the workflow's
  own template. At most 8 folders of at most 100 characters; no `.`, `..`, control characters or
  empty names; parsed with index loops. Its before state reads only: the connection's folder, the
  resolved path, the file name, whether that folder exists yet, and whether a file of that name is
  already in it (with its id and link). The run: looks for a file carrying this action's tag (a
  retried step returns it, `alreadyDone: true`), checks the connection's folder is still there,
  makes missing folders, refuses a name already in the folder unless `ifExists: "keep_both"`, then
  uploads with a resumable upload in one piece (any stored document, up to 32 MB). The session URL
  must be on `https://www.googleapis.com` or nothing is sent. Each upload carries
  `appProperties.mezonasAction` = the first 40 hex characters of sha256(`gdrive:` + the action's
  idempotency key).
- `drive.file.list` (read, entity `file`): our files in the connection's folder or a path under it
  (same template), 50 a page by default (100 at most), folders first. Under `drive.file` Google
  returns only files Mezonas made or the person opened with it, so nothing else in the Drive is
  ever seen. File names reach models only in tool results (invariant 9).

## To verify

OAuth (the same Google client as Gmail):

- `drive.file` is a **non-sensitive** scope (Google's docs list it as "recommended"), so adding it to
  the consent screen needs no new verification beyond the app's. Check it on Google's current scope
  list.
- The token answer's `scope` for this grant is exactly `https://www.googleapis.com/auth/drive.file`
  (no `openid` or profile scopes added), so the extra-scope check doesn't refuse good grants.
- **Revoking ends the whole grant for the client, not just Drive's.** If one person connects both
  Gmail and Drive with the same Google account, both connections share our OAuth client: does
  revoking Drive's refresh token also end Gmail's? We believe Google's revoke removes every scope
  the account granted to the client. If so, either give Drive its own OAuth client in the project
  (two more secrets) or have Drive's disconnect drop the tokens without revoking. Owner decision.
- With `include_granted_scopes=false`, a Drive sign-in by an account that already granted
  `gmail.send` gets a token with `drive.file` only, and Gmail's refresh token keeps working. Google
  allows 100 live refresh tokens per account and client.
- The redirect URI `<origin>/connections/gdrive/callback` must be registered on "Mezonas web" for
  each environment (staging, production, localhost:8787).
- Refresh tokens expire after 7 days while the consent screen is in "Testing".

Drive API v3:

- `GET https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)` works with
  `drive.file` alone and answers `{user: {emailAddress, displayName}}`.
- `GET /drive/v3/files` with `q`, `spaces=drive`, `pageSize`, `pageToken`, `orderBy=folder,name`
  and `fields=nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,parents,trashed)`.
  The `q` clauses we write: `name = '…'`, `'<id>' in parents`, `'root' in parents`,
  `mimeType = '…'` / `!=`, `trashed = false`, and `appProperties has { key='…' and value='…' }`;
  string literals escape `\` and `'` with a backslash.
- Under `drive.file`, `files.list` returns only files the app created or the person opened with
  it, including folders the app made, and `appProperties` queries see the app's own properties.
- Search is consistent right after a create: a retried step looks for its file by
  `appProperties` moments after a lost answer. If the index lags, a fast retry could upload a
  second copy. If so, also look for a same-name file made in the last minutes before uploading.
- `appProperties` limits: 30 per app per file, key + value at most 124 bytes (we use
  `mezonasAction` + 40 characters, `mezonasRoot` + 1).
- `POST /drive/v3/files` with JSON `{name, mimeType: "application/vnd.google-apps.folder",
  parents, appProperties}` makes a folder; `parents: ["root"]` puts it at the top of My Drive.
- `GET /drive/v3/files/<id>` answers 404 for a deleted folder and `trashed: true` for one in the
  bin.
- Resumable upload: `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable`
  with the metadata as JSON and `X-Upload-Content-Type`, `X-Upload-Content-Length`, answers 200
  with the session URL in `Location` (on `www.googleapis.com`); `PUT` the bytes to it in one request
  answers 200 or 201 with the file. Whether the PUT needs (or accepts) `Authorization`; we send it.
- `webViewLink` is returned for files and folders when asked in `fields`.
- `size` comes back as a string.
- Errors: 401 for a bad token, 403 for rate limits (`userRateLimitExceeded`) and storage quota
  (`storageQuotaExceeded`), 404 for a parent we can't see, 429 and 5xx. We refresh once on 401;
  429 and 5xx are marked retryable; the rest fail the action with Google's message.

## Not built

- Folders the client already has (`drive.file` can't see them; the Google Picker would let a person
  choose one, which needs a browser API key and the Picker on the portal page).
- A portal field for the folder's name: the callback accepts `folder_name`, but today's
  Connections page doesn't ask for one, so the folder is `Mezonas` until the owner's redesign adds
  it.
- Moving, renaming, sharing or deleting files (delete stays off everywhere).
- Shared drives (`supportsAllDrives`): files go to the person's My Drive.
- Google Docs conversion: files are stored as they are.
