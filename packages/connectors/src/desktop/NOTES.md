# desktop: what is unchecked

The connector is built against `fake.ts`; the computer's side is `apps/desktop` (docs/plan.md §1.151).

## Not built yet

- **The API's side.** `apps/api` doesn't register this connector yet, has no `desktop_device` table, and
  doesn't give `services.desktop`. That comes in two PRs of their own: the migration, then the routes
  (pairing, folders, jobs and results, files) and the job queue behind `DesktopServices.run`.
- **Where the folder list lives.** The connection's `config` (`DesktopConfig`), as the Excel connector
  keeps picked workbooks. The computer keeps its own copy and holds to the stricter of both.

## To verify on real computers

- Excel's owner file (`~$Name.xlsx`) appears on Windows and on a Mac for a workbook opened from a local
  folder, OneDrive's synced folder and a network drive. The app also tries an exclusive open on Windows.
- A workbook written by the app opens in Excel (Windows and Mac) without a repair prompt, with its
  formulas, formats, charts, pivots and named ranges as they were, and recalculates on open.
- A folder synced by OneDrive, Dropbox or Google Drive: the app's write (a temporary file renamed over
  the workbook) syncs as one change, not a delete and a new file.
- Mac privacy prompts: the first read of Documents, Desktop or Downloads asks the person once, and a
  folder picked in the app's own dialog is allowed from then on.
