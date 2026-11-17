# Mezonas for Mac and Windows (`apps/desktop`)

The desktop app (docs/plan.md §1.124): a client gives Mezonas folders on their own computer, and
agents read files there, add rows to closed Excel workbooks and save new files, each change signed
first. New documents in a folder can go to Mezonas on their own. The app also shows Your Desk and
says when something waits. Electron 45 (Node and Chromium), React 19.3 for the window, the design
system's CSS. It reaches the platform only through the API, typed by `@countersign/core`.

## How it works

- **Sign-in** is the phone app's (`apps/mobile`, plan §1.116): the browser opens
  `/api/mobile/sign-in?challenge=…`, the usual WorkOS sign-in and second step run, and
  `mezonas://signed-in?code=…` hands the session back. The app trades it at `POST /api/mobile/session`
  and sends it as `x-mezonas-session`; it is kept encrypted by the OS (`safeStorage`). Every rule of a
  session holds (12 hours, 30 minutes idle). Operators are refused, as on the phone.
- **This computer** is added once by a client admin: the app makes an EC P-256 key (Node's crypto),
  keeps the private half encrypted by the OS (Keychain on a Mac, DPAPI on Windows), and sends the
  public half to `POST /api/desktop/devices`. From then on the computer signs its own requests
  (`x-mezonas-device`, `x-mezonas-time`, `x-mezonas-signature` over core's `desktopRequestText`), so
  jobs keep running while nobody is signed in.
- **Folders.** Chosen with the OS's folder picker and checked by core's `folderGrantProblem` (not the
  home folder, a system folder, a hidden folder, `~/Library` or `AppData`). Each is read only, or read
  and change, and may send new files. The list goes to Mezonas with `PUT /api/desktop/devices/:id/folders`;
  the app works only in folders on both lists, with the stricter access (`effectiveFolders`).
- **Jobs.** The app waits on `GET /api/desktop/jobs` (a long poll; it never takes a connection in),
  runs each job (`src/main/jobs.ts`) and posts the result. Paths are resolved after following links
  and refused if they leave the folder. Writes happen once per idempotency key.
- **Workbooks** (`src/main/xlsx.ts`) are edited in place: only the cells written change, every other
  part of the file is copied byte for byte. Text is written as text (never a formula), formulas are
  never replaced, new rows take the formats above them, and the workbook recalculates when next
  opened. A workbook is changed only while closed (Excel's owner file, and on Windows an exclusive
  open), after a backup kept 30 days, as a temporary file renamed over it.
- **Files sent** (`src/main/ingest.ts`): PDFs, images, workbooks, Word files and text added to a
  folder after it was given, up to 25 MB, each once per content, to `POST /api/desktop/files`.
- **The window** (`src/renderer`) has no Node and no network: a sandbox, context isolation, its own
  files on a private `app://mezonas/` scheme, a strict CSP, and `window.mezonas` (the preload) for
  everything. Closing it keeps the app in the menu bar or tray.

## Run it

```sh
pnpm install
# Electron's own binary isn't fetched by pnpm here (its install script isn't allowed, so CI stays
# light); fetch it once on your machine:
node apps/desktop/node_modules/electron/install.js
MEZONAS_API_URL=https://staging.mezonas.com pnpm --filter @countersign/desktop start
```

Against local `wrangler dev`: `MEZONAS_API_URL=http://localhost:8787 MEZONAS_DEV_USER=<a seeded
client admin's email>` signs in with the dev adapter's header (ignored in a packaged app).

The API's desktop routes aren't built yet (`docs/open.md`): until they are, adding a computer says so,
and the app waits politely.

## Settings

| Name | Where | What |
|---|---|---|
| `MEZONAS_API_URL` | the shell, when building or starting | The Mezonas API. Default `https://app.mezonas.com`; a staging build sets `https://staging.mezonas.com`. |
| `MEZONAS_DEV_USER` | the shell, development only | Sign in with the dev adapter as this email. |
| `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | the build machine | Signing and notarising the Mac build. |
| Azure Trusted Signing or `CSC_LINK` | the build machine | Signing the Windows installer. |

## Build it

```sh
pnpm --filter @countersign/desktop dist     # on a Mac for the .dmg, on Windows for the installer
```

`electron-builder` runs from `pnpm dlx` at a pinned version, so the workspace doesn't install it.
Updates come from `https://downloads.mezonas.com/desktop/` (`electron-builder.yml`).

## Tests

`pnpm --filter @countersign/desktop test`: workbooks (read, write, formats kept, parts unchanged),
jobs on a real temporary folder (links out refused, writes once, open workbooks, formulas, changed
cells, backups), signed requests checked with Web Crypto as the Worker will, the poller, files sent,
and the controller against a fake API (sign-in, adding the computer, folders, the Desk).
