// `Browsers`: the browser service's RPC, a WorkerEntrypoint reached only through apps/api's
// `BROWSER` service binding (connectors' `BrowserService`). `open` launches a Browser Run browser
// held to the site's hosts and answers a `RemoteTab`, an RPC target apps/api drives one primitive
// at a time. apps/api keeps every decision (ARCHITECTURE §6.10, invariant 13): this Worker never
// reads the vault, never sees a site's profile, tier or pinned origins, and logs nothing.

import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  BrowserCookie,
  BrowserOpenAnswer,
  BrowserService,
  BrowserTab,
  BrowserTabService,
} from "@countersign/connectors";
import { browserRunOpener } from "./driver";
import type { BrowserEnv } from "./env";
import { OpenInput, serveTab } from "./serve";

/**
 * One tab, served over RPC. It lives while apps/api holds its stub: `close` closes the browser, and
 * so does apps/api letting go of the stub without closing (the runtime calls `Symbol.dispose`).
 */
export class RemoteTab extends RpcTarget implements BrowserTabService {
  readonly #tab: BrowserTab;
  readonly #served: BrowserTabService;

  constructor(tab: BrowserTab) {
    super();
    this.#tab = tab;
    this.#served = serveTab(tab);
  }

  goto(url: string) {
    return this.#served.goto(url);
  }
  fill(selector: string, value: string) {
    return this.#served.fill(selector, value);
  }
  click(selector: string) {
    return this.#served.click(selector);
  }
  has(selector: string) {
    return this.#served.has(selector);
  }
  readText() {
    return this.#served.readText();
  }
  readTables() {
    return this.#served.readTables();
  }
  textOf(selector: string) {
    return this.#served.textOf(selector);
  }
  controls() {
    return this.#served.controls();
  }
  sendsForm(selector: string) {
    return this.#served.sendsForm(selector);
  }
  readOnly(on: boolean) {
    return this.#served.readOnly(on);
  }
  download(url: string) {
    return this.#served.download(url);
  }
  cookies() {
    return this.#served.cookies();
  }
  setCookies(cookies: BrowserCookie[]) {
    return this.#served.setCookies(cookies);
  }
  screenshot() {
    return this.#served.screenshot();
  }
  alive() {
    return this.#served.alive();
  }
  close() {
    return this.#served.close();
  }
  [Symbol.dispose]() {
    void this.#tab.close();
  }
}

export class Browsers extends WorkerEntrypoint<BrowserEnv> implements BrowserService {
  /** A fresh browser with one tab; `no_browser` without Browser Run (local development, tests). */
  async open(input: unknown): Promise<BrowserOpenAnswer> {
    const parsed = OpenInput.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: { code: "invalid", message: "invalid open request" } };
    }
    const opener = browserRunOpener(this.env);
    const tab = opener ? await opener(parsed.data) : null;
    if (!tab) {
      return { ok: false, error: { code: "no_browser", message: "no browser is set up here" } };
    }
    return { ok: true, url: tab.url(), tab: new RemoteTab(tab) };
  }
}
