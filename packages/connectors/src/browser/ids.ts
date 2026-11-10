// The browser connector's ids, in a file of their own so the scope (./scope.ts) and the connector
// (./index.ts) share them without importing each other.

export const BROWSER_CONNECTOR_ID = "browser";
export const BROWSER_PAGE_READ_TOOL = "browser.page.read";
export const BROWSER_FILE_DOWNLOAD_TOOL = "browser.file.download";
/** A client's published read script on a site (docs/plan.md §1.86 "Scripts (wave 4)"). */
export const BROWSER_SCRIPT_READ_TOOL = "browser.script.read";
/** A client's published write script: it submits a form, behind approval. */
export const BROWSER_SCRIPT_SUBMIT_TOOL = "browser.script.submit";
