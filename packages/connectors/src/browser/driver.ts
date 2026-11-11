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
  /**
   * A button that sends a form: a submit-type button, or any button inside a form. Only a click
   * marked as the script's submit may click one (./script.ts).
   */
  submits?: boolean;
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
  /**
   * Whether clicking the element `selector` names sends a form (as `BrowserControl.submits`);
   * false when nothing matches. Absent: the connector asks `controls` instead.
   */
  sendsForm?(selector: string): Promise<boolean>;
  /**
   * Read only (docs/plan.md §1.86 "Scripts (wave 4)"): while on, every request that could change
   * something is refused before it leaves the browser: a navigation, fetch or XHR whose method
   * isn't GET or HEAD (a form post, a page script's POST) is aborted and the page stays where it
   * was. Off again for sign-out. Absent: the browser can't hold a page read only, and a script
   * step, a recording or a test that needs it is refused.
   */
  readOnly?(on: boolean): Promise<void>;
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

// The browser service (apps/browser, Worker `mezonas-browser`; docs/plan.md §1.26 "Browser
// driver"): Browser Run and Playwright live in a Worker of their own, and apps/api reaches it only
// through its `BROWSER` service binding. The service makes no decision: apps/api's connector keeps
// the permission gate, pinned origins, the blocked tier, the vault, the audit and external actions,
// and drives the tab below one primitive at a time. A secret typed by `fill` crosses for that one
// call and is never logged, stored or returned.

/**
 * What a tab call answers over RPC: its value, and the address the tab was on when the call ended
 * (an RPC tab can't answer `url()` without a round trip, so each call brings it back).
 */
export interface BrowserTabAnswer<T> {
  url: string;
  value: T;
}

/** One tab in the browser service, as apps/api holds it: every `BrowserTab` method, over RPC. */
export interface BrowserTabService {
  goto(url: string): Promise<BrowserTabAnswer<null>>;
  fill(selector: string, value: string): Promise<BrowserTabAnswer<null>>;
  click(selector: string): Promise<BrowserTabAnswer<null>>;
  has(selector: string): Promise<BrowserTabAnswer<boolean>>;
  readText(): Promise<BrowserTabAnswer<string>>;
  readTables(): Promise<BrowserTabAnswer<BrowserTable[]>>;
  textOf(selector: string): Promise<BrowserTabAnswer<string | null>>;
  controls(): Promise<BrowserTabAnswer<BrowserControl[]>>;
  sendsForm(selector: string): Promise<BrowserTabAnswer<boolean>>;
  readOnly(on: boolean): Promise<BrowserTabAnswer<null>>;
  download(url: string): Promise<BrowserTabAnswer<BrowserDownload>>;
  cookies(): Promise<BrowserTabAnswer<BrowserCookie[]>>;
  setCookies(cookies: BrowserCookie[]): Promise<BrowserTabAnswer<null>>;
  screenshot(): Promise<BrowserTabAnswer<Uint8Array>>;
  alive(): Promise<boolean>;
  close(): Promise<void>;
}

/** What `open` asks for: the site's hosts (at most 50) and, for a held session, its keep-alive. */
export interface BrowserOpenInput {
  hosts: string[];
  keepAliveMs?: number | undefined;
}

/** What `open` answers: the tab and its address, or why there is none. */
export type BrowserOpenAnswer =
  | { ok: true; url: string; tab: BrowserTabService }
  | { ok: false; error: { code: "no_browser" | "invalid"; message: string } };

/**
 * The browser service's RPC entrypoint (`Browsers`): a fresh browser with one tab, held to `hosts`;
 * `no_browser` when the service has no Browser Run binding (local development). The tab lives until
 * `close`, or until apps/api lets go of it (the service then closes the browser).
 */
export interface BrowserService {
  open(input: BrowserOpenInput): Promise<BrowserOpenAnswer>;
}
