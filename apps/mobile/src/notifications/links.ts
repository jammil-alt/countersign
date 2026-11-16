// Where a notification's tap goes. The API sends the kind and the web page it links to (core
// `notificationPath`); the app has its own screens for some of them and the Desk for the rest.

/** The app route for a notification's `data` ({ kind, path }); the Desk when unsure. */
export function pathForNotification(data: unknown): "/" | "/messages" | "/settings" {
  if (typeof data !== "object" || data === null) return "/";
  const d = data as { kind?: unknown; path?: unknown };
  if (d.kind === "lead_message") return "/messages";
  if (d.kind === "credits") return "/settings";
  const path = typeof d.path === "string" ? d.path : "";
  if (path === "/settings") return "/settings";
  // The Desk (`/inbox`), sign-off, the Weekly Table and reconnects all start at the Desk; the
  // Weekly Table and connections are read on the web for now.
  return "/";
}
