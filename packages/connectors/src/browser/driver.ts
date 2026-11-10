// The browser the browser connector drives (docs/plan.md §1.26 "Browser driver"): one tab in a
// fresh browser. apps/api implements it on Cloudflare Browser Run; tests on local Chromium or a
// fake. Every method is something our code does, never the model: the model only gets page data
// back through the connector's tools.

/** A cookie as browsers keep it (Playwright's shape). */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

/** A table on the page: header cells and body rows, as text. */
export interface BrowserTable {
  headers: string[];
  rows: string[][];
}

/**
 * Something a person recording a script may fill or click (docs/plan.md §1.86 "Scripts"): a field,
 * a list, a button or a link, with a selector that finds it again and the words that name it.
 * Password, hidden and one-time-code fields are never listed.
 */
export interface BrowserControl {
  selector: string;
  kind: "field" | "select" | "button" | "link";
  label: string;
}

export interface BrowserDownload {
  bytes: Uint8Array;
  /** From Content-Disposition, else the last part of the path. */
  filename: string;
  mimeType: string;
  /** Where the bytes came from after any redirects (checked again by the connector). */
  finalUrl: string;
  status: number;
}

/** One tab in a browser of its own. */
export interface BrowserTab {
  /** The address the tab is on now (after redirects and scripts). */
  url(): string;
  /** Opens an address and waits for the page to load. */
  goto(url: string): Promise<void>;
  /** Types into the element `selector` names (replacing what was there). */
  fill(selector: string, value: string): Promise<void>;
  /** Clicks it and waits for the page to settle. */
  click(selector: string): Promise<void>;
  /** Whether an element matching `selector` is on the page. */
  has(selector: string): Promise<boolean>;
  /**
   * The page's text, with password inputs, hidden inputs and elements hidden from view removed
   * first; other form fields read as their values.
   */
  readText(): Promise<string>;
  /** The page's tables, with the same removals as `readText`. */
  readTables(): Promise<BrowserTable[]>;
  /**
   * The text of the first element `selector` names, with the same removals as `readText` (a field
   * reads as its value); null when nothing matches. Absent: a script can't read single fields.
   */
  textOf?(selector: string): Promise<string | null>;
  /** The page's visible fields, lists, buttons and links (at most 200), for the recorder. */
  controls?(): Promise<BrowserControl[]>;
  /** Fetches a file as the signed-in tab would (same cookies). */
  download(url: string): Promise<BrowserDownload>;
  cookies(): Promise<BrowserCookie[]>;
  setCookies(cookies: BrowserCookie[]): Promise<void>;
  /** A PNG of the visible page, for evidence (taken only after sign-in). */
  screenshot(): Promise<Uint8Array>;
  /**
   * Whether the browser behind the tab still answers. Browser Run closes a browser left idle past
   * its keep-alive; a session held across a run's model calls asks before it reopens. Absent: the
   * tab is taken to be alive.
   */
  alive?(): Promise<boolean>;
  /** Closes the tab and destroys its browser; never throws. */
  close(): Promise<void>;
}

/** Opens a fresh browser with one tab. */
export interface BrowserDriver {
  open(): Promise<BrowserTab>;
}
