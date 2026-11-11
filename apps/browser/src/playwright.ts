// A BrowserTab over a Playwright page, shared by Cloudflare Browser Run (`@cloudflare/playwright`,
// this Worker) and local Chromium (`playwright`, the tests), which have the same page API. The
// types here are structural, so the adapter needs neither library nor DOM types: page scripts are
// strings our code wrote, evaluated in the page. The model never runs anything in a page. Moved
// here from @countersign/connectors with Playwright itself (docs/plan.md §1.26 "Browser driver").

import type {
  BrowserControl,
  BrowserCookie,
  BrowserDownload,
  BrowserTab,
  BrowserTable,
} from "@countersign/connectors";

/** Standard base64 to bytes (a page's `btoa` output). */
function fromBase64(input: string): Uint8Array {
  const bin = atob(input);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The part of Playwright's `Route` read-only mode uses. */
export interface PlaywrightRouteLike {
  request(): { method(): string };
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}

/** The part of Playwright's `Page` this adapter uses. */
export interface PlaywrightPageLike {
  url(): string;
  goto(url: string, options?: { waitUntil?: "load"; timeout?: number }): Promise<unknown>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  waitForLoadState(state?: "load", options?: { timeout?: number }): Promise<void>;
  waitForEvent(event: "framenavigated", options?: { timeout?: number }): Promise<unknown>;
  locator(selector: string): { count(): Promise<number> };
  evaluate<T>(script: string): Promise<T>;
  screenshot(options?: { type?: "png"; fullPage?: boolean }): Promise<Uint8Array>;
  /** True once the page, its context or its browser closed (or the connection to it dropped). */
  isClosed?(): boolean;
  context(): {
    cookies(): Promise<BrowserCookie[]>;
    addCookies(cookies: BrowserCookie[]): Promise<void>;
    /** Read-only mode's request filter, on the context: its popups and new pages too. */
    route(url: string, handler: (route: PlaywrightRouteLike) => unknown): Promise<void>;
  };
}

export interface PlaywrightTabOptions {
  /** Closes the page and destroys the browser (Browser Run sessions cost while open). */
  close: () => Promise<void>;
  /** Per action, in milliseconds. */
  timeoutMs?: number;
  /** How long a click waits for a navigation to start (forms that submit). */
  navigationWaitMs?: number;
}

/**
 * The page walk behind `readText` and `readTables`: password inputs, hidden inputs, one-time-code
 * and password-autocomplete fields, scripts and elements hidden from view are left out; other form
 * fields read as their values. Runs in the page.
 */
const WALK = String.raw`
const SKIP = new Set(["SCRIPT","STYLE","NOSCRIPT","TEMPLATE","SVG","IFRAME","OBJECT","EMBED","HEAD","CANVAS"]);
const BLOCK = new Set(["ADDRESS","ARTICLE","ASIDE","BLOCKQUOTE","BR","DD","DIV","DL","DT","FIELDSET","FIGCAPTION","FIGURE","FOOTER","FORM","H1","H2","H3","H4","H5","H6","HEADER","HR","LI","MAIN","NAV","OL","P","PRE","SECTION","TABLE","TR","UL","CAPTION","THEAD","TBODY","TFOOT"]);
function removed(el) {
  if (SKIP.has(el.tagName)) return true;
  if (el.tagName === "INPUT") {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    if (t === "password" || t === "hidden") return true;
  }
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  if (ac.includes("password") || ac.includes("one-time-code")) return true;
  if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
  const s = getComputedStyle(el);
  return s.display === "none" || s.visibility === "hidden";
}
function fieldText(el) {
  if (el.tagName === "INPUT") {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    if (t === "checkbox" || t === "radio") return el.checked ? "[x]" : "[ ]";
    if (t === "file" || t === "image") return "";
    return el.value || "";
  }
  if (el.tagName === "TEXTAREA") return el.value || "";
  if (el.tagName === "SELECT") {
    const o = el.selectedOptions && el.selectedOptions[0];
    return o ? o.textContent || "" : "";
  }
  return null;
}
function textOf(node, out) {
  if (node.nodeType === 3) { out.push(node.nodeValue); return; }
  if (node.nodeType !== 1) return;
  const el = node;
  if (removed(el)) return;
  const f = fieldText(el);
  if (f !== null) { out.push(" " + f + " "); return; }
  if (el.tagName === "TD" || el.tagName === "TH") out.push("\t");
  for (const c of el.childNodes) textOf(c, out);
  if (BLOCK.has(el.tagName)) out.push("\n");
}
function clean(s) {
  return s.split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean).join("\n");
}
function cellText(el) { const out = []; textOf(el, out); return out.join("").replace(/\s+/g, " ").trim(); }
function visibleAncestors(el) {
  for (let p = el; p; p = p.parentElement) if (removed(p)) return false;
  return true;
}
function sendsForm(el) {
  const b = el.closest("button,input");
  if (!b) return false;
  const t = (b.getAttribute("type") || "").toLowerCase();
  if (b.tagName === "INPUT" && !["submit", "image", "button", "reset"].includes(t)) return false;
  if (t === "submit" || t === "image") return true;
  return !!(b.form || b.closest("form"));
}
`;

const READ_TEXT = `(() => { ${WALK}
  const out = [];
  if (document.title) out.push(document.title + "\\n");
  if (document.body) textOf(document.body, out);
  return clean(out.join(""));
})()`;

const READ_TABLES = `(() => { ${WALK}
  const tables = [];
  for (const table of Array.from(document.querySelectorAll("table")).slice(0, 20)) {
    if (!visibleAncestors(table)) continue;
    const rows = Array.from(table.rows).filter((r) => r.closest("table") === table && visibleAncestors(r));
    let headers = [];
    const body = [];
    for (const r of rows) {
      const cells = Array.from(r.cells).filter((c) => !removed(c)).slice(0, 50);
      const isHead = r.parentElement && r.parentElement.tagName === "THEAD"
        || (headers.length === 0 && body.length === 0 && cells.length > 0 && cells.every((c) => c.tagName === "TH"));
      const texts = cells.map(cellText);
      if (isHead && headers.length === 0) headers = texts; else if (body.length < 500) body.push(texts);
    }
    tables.push({ headers, rows: body });
  }
  return tables;
})()`;

/**
 * A string as a JavaScript literal inside a script the page runs: JSON's quoting, plus the
 * characters that could end a script element or a line in older parsers written as escapes.
 */
// DECISION (CodeQL js/bad-code-sanitization): selectors are the operator's, but a script built from
// text escapes everything that could change its meaning, not only quotes.
function scriptString(value: string): string {
  return JSON.stringify(value).replace(
    /[<>/\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** One element's text, with READ_TEXT's removals (a field reads as its value); null when none. */
function textOfScript(selector: string): string {
  return `(() => { ${WALK}
  let el = null;
  try { el = document.querySelector(${scriptString(selector)}); } catch { return null; }
  if (!el || !visibleAncestors(el)) return null;
  const f = fieldText(el);
  if (f !== null) return f.trim();
  const out = [];
  textOf(el, out);
  return clean(out.join(""));
})()`;
}

/**
 * The fields, lists, buttons and links a person recording may use, each with a selector that finds
 * it again (its id, its name, a link's address, else its place in the page); never a password,
 * hidden or one-time-code field.
 */
const CONTROLS = `(() => { ${WALK}
function sel(el) {
  const tag = el.tagName.toLowerCase();
  if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return "#" + el.id;
  const q = (v) => v.replace(/["\\\\]/g, "\\\\$&");
  const name = el.getAttribute("name");
  if (name) return tag + '[name="' + q(name) + '"]';
  const href = tag === "a" && el.getAttribute("href");
  if (href) return 'a[href="' + q(href) + '"]';
  const parts = [];
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    const t = e.tagName.toLowerCase();
    const same = e.parentElement ? Array.from(e.parentElement.children).filter((x) => x.tagName === e.tagName) : [];
    parts.unshift(same.length > 1 ? t + ":nth-of-type(" + (same.indexOf(e) + 1) + ")" : t);
  }
  return "body > " + parts.join(" > ");
}
function labelOf(el) {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  if (el.id) { const l = document.querySelector('label[for="' + el.id + '"]'); if (l) return cellText(l); }
  const wrap = el.closest("label");
  if (wrap) return cellText(wrap);
  return el.getAttribute("placeholder") || cellText(el) || el.getAttribute("value") || el.getAttribute("title") || "";
}
const out = [];
for (const el of Array.from(document.querySelectorAll("input,select,textarea,button,a[href]"))) {
  if (out.length >= 200) break;
  if (!visibleAncestors(el)) continue;
  const tag = el.tagName;
  let kind = "field";
  if (tag === "SELECT") kind = "select";
  else if (tag === "BUTTON") kind = "button";
  else if (tag === "A") kind = "link";
  else if (tag === "INPUT") {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    if (t === "submit" || t === "button" || t === "reset" || t === "image") kind = "button";
    if (t === "file") continue;
  }
  out.push({ selector: sel(el), kind, label: labelOf(el).slice(0, 120), submits: kind === "button" && sendsForm(el) });
}
return out;
})()`;

/**
 * Whether clicking the element a selector names sends a form; false when nothing matches. A
 * submit-type button (an explicit `type="submit"`, an image input), or any button inside a form.
 */
// DECISION: a `<button>` with no type outside any form is not one: it posts nothing by itself, and
// single-page sites use them for everything. Read-only mode still stops whatever its script sends.
function sendsFormScript(selector: string): string {
  return `(() => { ${WALK}
  let el = null;
  try { el = document.querySelector(${scriptString(selector)}); } catch { return false; }
  return el ? sendsForm(el) : false;
})()`;
}

/** Fetches with the page's cookies; the address it ends at after redirects comes back too. */
function downloadScript(url: string): string {
  return `(async () => {
    const r = await fetch(${JSON.stringify(url)}, { credentials: "include", redirect: "follow" });
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
    return { status: r.status, url: r.url, type: r.headers.get("content-type") || "",
      disposition: r.headers.get("content-disposition") || "", base64: btoa(bin) };
  })()`;
}

function filenameOf(disposition: string, url: string): string {
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition)?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  let name = star ?? plain;
  if (name) {
    try {
      name = decodeURIComponent(name.trim());
    } catch {
      name = name.trim();
    }
  } else {
    const path = url.split(/[?#]/)[0] ?? "";
    name = path.split("/").pop() || "download";
  }
  // A name, never a path.
  return name.replace(/[/\\]/g, "_").slice(0, 200) || "download";
}

export function playwrightTab(page: PlaywrightPageLike, options: PlaywrightTabOptions): BrowserTab {
  const timeout = options.timeoutMs ?? 20_000;
  const navWait = options.navigationWaitMs ?? 3_000;
  let closed = false;
  // Read only: one route on the page's context for its life, reading the flag on every request.
  let holding = false;
  let routed = false;
  return {
    url: () => page.url(),
    async goto(url) {
      await page.goto(url, { waitUntil: "load", timeout });
    },
    async fill(selector, value) {
      await page.fill(selector, value, { timeout });
    },
    async click(selector) {
      // A click that submits a form navigates: wait for it to start (briefly), then to load.
      const navigated = page.waitForEvent("framenavigated", { timeout: navWait }).catch(() => null);
      await page.click(selector, { timeout });
      await navigated;
      await page.waitForLoadState("load", { timeout }).catch(() => undefined);
    },
    async has(selector) {
      try {
        return (await page.locator(selector).count()) > 0;
      } catch {
        return false;
      }
    },
    readText: () => page.evaluate<string>(READ_TEXT),
    readTables: () => page.evaluate<BrowserTable[]>(READ_TABLES),
    textOf: (selector) => page.evaluate<string | null>(textOfScript(selector)),
    controls: () => page.evaluate<BrowserControl[]>(CONTROLS),
    sendsForm: (selector) => page.evaluate<boolean>(sendsFormScript(selector)),
    async readOnly(on) {
      holding = on;
      if (!on || routed) return;
      routed = true;
      // DECISION: only GET and HEAD leave the browser while read only. A navigation, fetch, XHR or
      // beacon with any other method is aborted where it starts, so a click that would post a
      // form goes nowhere and the page stays as it was. The route is the context's, so a popup or
      // a new page the site opens is held too; service workers (whose requests no route sees) are
      // blocked where the opener makes the context (`serviceWorkers: "block"`, apps/api's
      // driver.ts). WebSockets are not covered: a route sees no frame sent on one, so a site that
      // writes over a socket is not held by this. Browser Run's support for `context.route` is
      // unchecked until staging.
      await page.context().route("**/*", (route) => {
        const method = route.request().method().toUpperCase();
        const go =
          holding && method !== "GET" && method !== "HEAD"
            ? route.abort("blockedbyclient")
            : route.continue();
        return go.catch(() => undefined);
      });
    },
    async download(url): Promise<BrowserDownload> {
      const r = await page.evaluate<{
        status: number;
        url: string;
        type: string;
        disposition: string;
        base64: string;
      }>(downloadScript(url));
      return {
        bytes: fromBase64(r.base64),
        filename: filenameOf(r.disposition, r.url || url),
        mimeType: (r.type.split(";")[0] ?? "").trim().toLowerCase(),
        finalUrl: r.url || url,
        status: r.status,
      };
    },
    cookies: () => page.context().cookies(),
    setCookies: (cookies) => page.context().addCookies(cookies),
    async screenshot() {
      return new Uint8Array(await page.screenshot({ type: "png" }));
    },
    async alive() {
      if (closed || page.isClosed?.()) return false;
      try {
        // A round trip to the browser, not the page's scripts (a page mid-navigation still
        // answers): a browser Browser Run closed doesn't.
        await page.context().cookies();
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await options.close().catch(() => undefined);
    },
  };
}
