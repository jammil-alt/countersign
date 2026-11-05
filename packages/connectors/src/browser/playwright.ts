// A BrowserTab over a Playwright page, shared by Cloudflare Browser Run (`@cloudflare/playwright`,
// apps/api) and local Chromium (`playwright`, the tests), which have the same page API. The types
// here are structural, so this package needs neither library nor DOM types: page scripts are
// strings our code wrote, evaluated in the page. The model never runs anything in a page.

import { fromBase64 } from "../runtime";
import type { BrowserCookie, BrowserDownload, BrowserTab, BrowserTable } from "./driver";

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
  context(): {
    cookies(): Promise<BrowserCookie[]>;
    addCookies(cookies: BrowserCookie[]): Promise<void>;
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
    async close() {
      if (closed) return;
      closed = true;
      await options.close().catch(() => undefined);
    },
  };
}
