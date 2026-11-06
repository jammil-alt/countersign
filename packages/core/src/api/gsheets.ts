import { z } from "zod";
import { defineRoute } from "./contract";

// v0.14 W4-D: Google Sheets' picking (ARCHITECTURE §6.11 row 7, docs/plan.md §1.52). The client
// admin signs in through the generic OAuth routes, then picks spreadsheets with Google's Picker on
// the portal's picking page; the picked ids are checked with the connection's own grant and kept in
// its config. Agents' sheet tools refuse any other spreadsheet. The Picker's browser key, the
// project number and the OAuth client id are public values (Google restricts them by origin); the
// connection's tokens never reach the browser.

const CLIENT_ADMIN = ["client_admin"] as const;

/** A Google file id: letters, digits, `-` and `_` (checked by a loop in the API, not a pattern). */
const SheetIdInput = z.string().min(10).max(200);

export const GsheetsPickedSheet = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().nullable(),
  addedAt: z.string(),
  /** Picked by the Google account connected now: only those work for agents. */
  usable: z.boolean(),
});
export type GsheetsPickedSheet = z.infer<typeof GsheetsPickedSheet>;

export const GsheetsPicker = z.object({
  /** Connected, and this deployment has the Picker's key and project number. */
  available: z.boolean(),
  connectionId: z.string().nullable(),
  /** The connected Google account, the Picker's sign-in hint. */
  account: z.string().nullable(),
  /** Public values for Google's Picker, restricted by Google to our origins. */
  developerKey: z.string().nullable(),
  appId: z.string().nullable(),
  clientId: z.string().nullable(),
  sheets: z.array(GsheetsPickedSheet),
});
export type GsheetsPicker = z.infer<typeof GsheetsPicker>;

export const GsheetsSheetsBody = z.strictObject({
  /** Every sheet the connection should have: new ids are checked with Google, missing ones dropped. */
  sheetIds: z.array(SheetIdInput).max(50),
});

export const gsheetsRoutes = {
  portalGsheetsPicker: defineRoute({
    method: "GET",
    path: "/api/connections/gsheets/picker",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary:
      "Google Sheets: what the Picker needs (public key, project number, client id) and the sheets picked so far",
    response: GsheetsPicker,
  }),
  portalGsheetsSheets: defineRoute({
    method: "PUT",
    path: "/api/connections/gsheets/sheets",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary:
      "Google Sheets: set the sheets agents may use; new ones must be spreadsheets Google opened to this connection",
    body: GsheetsSheetsBody,
    response: GsheetsPicker,
  }),
} as const;
