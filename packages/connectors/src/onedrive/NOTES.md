# OneDrive connector (files, app folder only): notes

Written 2026-11-12 for §1.97 (`docs/plan.md`). Built against a fake (`fake.ts`). Microsoft's docs
were read on 2026-11-12 where noted ("checked"); nothing has been run against Microsoft's live
services. Every item under "To verify" must be checked with one Microsoft 365 work account and one
personal Microsoft account before a client connects, and the connector and fake fixed where they
differ. The sign-in is shared with Outlook (`../microsoft/identity.ts`); its own unchecked items are
in `../outlook/NOTES.md`.

## What the connector does

- Sign-in: the Microsoft identity platform's authorization code flow on the `common` endpoint, with
  **its own Entra app** (`ONEDRIVE_CLIENT_ID`, `ONEDRIVE_CLIENT_SECRET`): scopes `openid email
  offline_access https://graph.microsoft.com/Files.ReadWrite.AppFolder`, `prompt=select_account`.
  The callback refuses, storing nothing, a grant without `Files.ReadWrite.AppFolder` or with any
  other Graph scope beyond `User.Read`.
- At sign-in it asks for `GET /me/drive/special/approot`, which makes the app folder
  (`Apps/<Entra app name>`) on first use, and keeps its id, name and link in the connection's
  config. That folder is the connection's folder; everything is filed under it.
- It supplies Google Drive's tools, with the same shapes (`sharedNamespaces: ["drive"]`):
  `drive.file.upload` (external, create, entity `file`, approval on by default) and
  `drive.file.list` (read). A workflow written for one drive runs on the other; the agent's binding
  decides which answers.
- Names: OneDrive's forbidden characters (`" * : < > ? / \ |`) and control characters become `-`;
  leading and trailing spaces and trailing dots go. Folders are walked one by one and made with
  `POST /me/drive/items/{parent}/children` and `conflictBehavior: fail` (a 409 means another run
  made it: we use that one).
- Upload: `PUT /me/drive/items/{folder}:/{name}:/content?@microsoft.graph.conflictBehavior=fail`
  with the bytes (stored documents are at most 32 MB; the simple upload takes up to 250 MB,
  checked). `keep_both` picks the first free `name (n).ext` itself before the upload.
- Once per action: the attempt is recorded (with the folder, the exact name and the size) before
  Graph is called. A retry after a lost answer looks for that name: the same size is ours (done, no
  second upload); nothing there means the upload never landed and it goes again; a different file
  there fails the action as unconfirmed for the operator. Answers that store nothing (4xx) are
  recorded as refused and may be tried again under a new attempt.
- List: `GET /me/drive/items/{folder}/children` with `$top`; the page token handed back is only
  Graph's `$skiptoken`, so a token can't point a call at another path.
- Disconnect drops our tokens only (Microsoft has no per-app revoke; the person removes the app in
  their account, as for Outlook).

## Checked in Microsoft's docs (2026-11-12)

- `Files.ReadWrite.AppFolder` exists as a delegated scope ("Have full access to the application's
  folder (preview)"); the permissions reference marks the delegated form **preview**.
- The app folder: "a dedicated, special folder for your app … typically named after your app, and
  is found in the Apps folder in the user's OneDrive"; made "when your app makes the first call to
  the folder using the special folder namespace"; named after the app registration's name at that
  moment (renaming the app later doesn't rename existing folders).
- `PUT …/content` takes files up to 250 MB and answers 201 with the driveItem.

## To verify

- **Whether `Files.ReadWrite.AppFolder` works for OneDrive for Business** (work accounts). The
  special-folder page lists it as the least privilege for personal accounts only; for work accounts
  it lists `Files.Read`. If work accounts are refused, the choice is the owner's: `Files.ReadWrite`
  (the person's whole OneDrive, our code keeping to our folder, as Excel does) or no OneDrive for
  work accounts.
- That `GET /me/drive/special/approot` makes the folder for an AppFolder grant (not 403).
- That an AppFolder grant gets 403 (or 404) outside the app folder.
- That `@microsoft.graph.conflictBehavior=fail` as a query parameter on the simple upload answers
  409 `nameAlreadyExists` and doesn't replace the file (replace is the default without it).
- Path addressing `items/{id}:/{name}` for a name with spaces, `#`, `%` and non-ASCII letters,
  each segment percent-encoded.
- That OneDrive keeps the `Content-Type` we send as the file's `file.mimeType`.
- The children list's `@odata.nextLink` carries `$skiptoken`, and `$top` is honoured up to 100.
- Name rules: OneDrive for Business also refuses some names (`.lock`, `CON`, `desktop.ini`,
  `_vti_`): a refusal there reaches the approver as Graph's message.
- Throttling: 429 with `Retry-After`; we fail the step and its retry tries again.

## The Entra app (owner)

A multi-tenant app registration of its own, named **Mezonas** (the app folder takes this name),
supported account types "any organizational directory and personal Microsoft accounts", a web
platform with the redirect URIs `https://staging.mezonas.com/connections/onedrive/callback`,
`https://app.mezonas.com/connections/onedrive/callback` and
`http://localhost:8787/connections/onedrive/callback`, a client secret (note its expiry), and
delegated `Files.ReadWrite.AppFolder`, `openid`, `email`, `offline_access`. Publisher verification
as for Outlook (one Partner Network id covers every app).

## Not built

- SharePoint document libraries (a later connector, with `Sites.Selected` granted per site by the
  client's admin).
- Files outside the app folder, picking existing folders, sharing links, and large-file upload
  sessions (not needed below 250 MB).
