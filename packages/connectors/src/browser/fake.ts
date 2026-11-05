// Test doubles for browser logins: a fake code service (core's CodesService, as the `CODES` binding
// answers) and a fake supplier portal driven by a fake BrowserDriver that records everything typed,
// opened and photographed, so tests can check what happened where. No real browser.

import type {
  ClaimResult,
  CodeAlert,
  CodesResponse,
  CodesService,
  IdentityView,
  OpenWaitInput,
} from "@countersign/core";
import { utf8 } from "../runtime";
import type {
  BrowserCookie,
  BrowserDownload,
  BrowserDriver,
  BrowserTab,
  BrowserTable,
} from "./driver";
import type { BrowserCodesPort } from "./services";
import { webUrl } from "./url";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ── The code service ─────────────────────────────────────────────────────────────────────────────

interface FakeWait {
  id: string;
  tenantId: string;
  identityId: string;
  siteKey: string;
  channel: "sms" | "email" | "totp";
  sender?: string;
  pattern?: string;
  code: string | null;
  claimed: boolean;
  expiresAt: number;
}

let seq = 0;
const fakeUuid = () => {
  seq += 1;
  return `0190f5e8-8a3c-7d6e-8f00-${seq.toString(16).padStart(12, "0")}`;
};
const fakeIdentityId = () => {
  seq += 1;
  return `agent${seq.toString(32).padStart(7, "a")}`.slice(0, 12).replace(/[^a-z2-7]/g, "a");
};

const ok = <T>(value: T): CodesResponse<T> => ({ ok: true, value });
const notFound = (): CodesResponse<never> => ({
  ok: false,
  error: { code: "not_found", message: "no such identity" },
});

/**
 * The code service as apps/api reaches it, in memory: identities per client, waits, codes handed
 * out once, alerts for codes no wait asked for. `deliverEmail` and `deliverSms` play the site.
 */
export class FakeCodesService implements CodesService {
  readonly identities = new Map<string, IdentityView>();
  readonly waits: FakeWait[] = [];
  readonly alertsRaised: CodeAlert[] = [];
  now = () => Date.now();

  async createIdentity(input: { tenantId: string; label: string }) {
    const id = fakeIdentityId();
    const view: IdentityView = {
      id,
      tenantId: input.tenantId,
      label: input.label,
      email: `agent-${id}@agents.mezonas.test`,
      phone: null,
      authenticators: [],
      createdAt: new Date(this.now()).toISOString(),
    };
    this.identities.set(id, view);
    return ok(view);
  }
  async identity(input: { tenantId: string; identityId: string }) {
    const i = this.identities.get(input.identityId);
    if (!i || i.tenantId !== input.tenantId) return notFound();
    return ok({ ...i });
  }
  async addPhone(input: { tenantId: string; identityId: string }) {
    const i = this.identities.get(input.identityId);
    if (!i || i.tenantId !== input.tenantId) return notFound();
    i.phone = "+15125550188";
    return ok({ ...i });
  }
  async setAuthenticator(input: { tenantId: string; identityId: string; siteKey: string }) {
    const i = this.identities.get(input.identityId);
    if (!i || i.tenantId !== input.tenantId) return notFound();
    const view = {
      siteKey: input.siteKey,
      algorithm: "SHA1" as const,
      digits: 6,
      period: 30,
      updatedAt: new Date(this.now()).toISOString(),
    };
    return ok(view);
  }
  async openWait(input: OpenWaitInput) {
    const i = this.identities.get(input.identityId);
    if (!i || i.tenantId !== input.tenantId) return notFound();
    const wait: FakeWait = {
      id: fakeUuid(),
      tenantId: input.tenantId,
      identityId: input.identityId,
      siteKey: input.siteKey,
      channel: input.channel,
      ...(input.channel === "totp" ? {} : { sender: input.sender, pattern: input.pattern }),
      code: input.channel === "totp" ? "246810" : null,
      claimed: false,
      expiresAt: this.now() + (input.ttlSeconds ?? 300) * 1000,
    };
    this.waits.push(wait);
    return ok({ waitId: wait.id, expiresAt: new Date(wait.expiresAt).toISOString() });
  }
  async claim(input: { tenantId: string; identityId: string; waitId: string }) {
    const w = this.waits.find(
      (x) =>
        x.id === input.waitId && x.identityId === input.identityId && x.tenantId === input.tenantId,
    );
    if (!w) return notFound();
    if (w.claimed || this.now() > w.expiresAt) return ok<ClaimResult>({ status: "expired" });
    if (w.code === null) {
      return ok<ClaimResult>({
        status: "pending",
        expiresAt: new Date(w.expiresAt).toISOString(),
      });
    }
    w.claimed = true;
    const code = w.code;
    w.code = null;
    return ok<ClaimResult>({ status: "code", code });
  }
  async alerts(input: { tenantId: string }) {
    return ok({
      alerts: this.alertsRaised.filter(
        (a) => this.identities.get(a.identityId)?.tenantId === input.tenantId,
      ),
    });
  }
  async deleteIdentity(input: { tenantId: string; identityId: string }) {
    const i = this.identities.get(input.identityId);
    if (!i || i.tenantId !== input.tenantId) return notFound();
    this.identities.delete(input.identityId);
    return ok({ deleted: true as const, phoneReleased: false });
  }

  /** A message to an identity: fills the first open wait it matches, else becomes an alert. */
  deliver(channel: "email" | "sms", to: string, from: string, text: string): string | null {
    const identity = [...this.identities.values()].find((i) =>
      channel === "email" ? i.email === to : i.phone === to,
    );
    if (!identity) return null;
    const senderMatches = (sender: string) =>
      sender.startsWith("@") ? from.endsWith(sender) : from === sender;
    for (const w of this.waits) {
      if (w.identityId !== identity.id || w.channel !== channel || w.claimed || w.code !== null) {
        continue;
      }
      if (this.now() > w.expiresAt || !w.sender || !w.pattern || !senderMatches(w.sender)) continue;
      const m = new RegExp(w.pattern).exec(text);
      if (!m) continue;
      w.code = m[1] ?? m[0];
      return w.id;
    }
    this.alertsRaised.push({
      id: fakeUuid(),
      identityId: identity.id,
      identityLabel: identity.label,
      kind: "unsolicited_code",
      channel,
      sender: from,
      receivedAt: new Date(this.now()).toISOString(),
      createdAt: new Date(this.now()).toISOString(),
    } as CodeAlert);
    return null;
  }
}

/** The connector's codes port over a CodesService, for one client (apps/api's is the same idea). */
export function fakeCodesPort(service: CodesService, tenantId: string): BrowserCodesPort {
  const unwrap = <T>(r: CodesResponse<T>): T => {
    if (!r.ok) throw new Error(`code service: ${r.error.code}`);
    return r.value;
  };
  return {
    openWait: async (input) => unwrap(await service.openWait({ ...input, tenantId })),
    claim: async (input) => unwrap(await service.claim({ ...input, tenantId })),
  };
}

// ── The supplier portal ──────────────────────────────────────────────────────────────────────────

export interface FakePortalOptions {
  origin?: string;
  username: string;
  password: string;
  /** Where the portal emails its codes (the agent identity's address); none = no second factor. */
  codeTo?: { codes: FakeCodesService; email: string } | null;
  code?: string;
}

/** A page as the fake browser shows it. */
interface FakePage {
  text: string;
  selectors: string[];
  tables?: BrowserTable[];
  /** Form fields: password and hidden ones are never read. */
  fields?: { type: "text" | "password" | "hidden"; value: string }[];
}

/**
 * A supplier portal (low tier in the tests): /login (username and password), /verify (a code it
 * emails), /home, /invoices (a table), /invoices/INV-1001.pdf, /logout; plus pages for the
 * tests' edge cases. Sessions are a `sid` cookie.
 */
export class FakeSupplierPortal {
  readonly origin: string;
  readonly sessions = new Set<string>();
  readonly pending = new Set<string>();
  readonly codesSent: string[] = [];
  signIns = 0;
  signOuts = 0;
  /** What the next visit to /login shows instead: a CAPTCHA, a new-device check, a redirect. */
  loginTwist: "captcha" | "new_device" | "redirect_away" | null = null;
  options: FakePortalOptions;

  constructor(options: FakePortalOptions) {
    this.options = options;
    this.origin = options.origin ?? "https://portal.supplier.test";
  }

  get invoicePdf(): Uint8Array {
    return utf8(
      "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n% Invoice INV-1001 total 120.00\n%%EOF\n",
    );
  }

  /** The page at `path` for a browser with this `sid`, or a redirect. */
  visit(url: string, sid: string | null): { page: FakePage } | { redirect: string } {
    const u = webUrl(url);
    if (u.origin !== this.origin)
      return { page: { text: `Some other site: ${u.host}`, selectors: [] } };
    const signedIn = sid !== null && this.sessions.has(sid);
    const path = u.pathname;
    if (path === "/login") {
      if (this.loginTwist === "redirect_away") return { redirect: "https://login.evil.test/login" };
      if (this.loginTwist === "captcha") {
        return { page: { text: "Please prove you are human", selectors: [".g-recaptcha"] } };
      }
      if (signedIn) return { redirect: `${this.origin}/home` };
      const error = u.searchParams.get("error") ? "Wrong username or password. " : "";
      return {
        page: {
          text: `${error}Sign in to Supplier Portal`,
          selectors: ["#user", "#pass", "#go"],
          fields: [
            { type: "text", value: "" },
            { type: "password", value: "" },
          ],
        },
      };
    }
    if (path === "/verify") {
      if (this.loginTwist === "new_device") {
        return { page: { text: "We noticed a sign-in from a new device.", selectors: [] } };
      }
      return { page: { text: "Enter the code we emailed you", selectors: ["#code", "#verify"] } };
    }
    if (path === "/logout") {
      if (sid) this.sessions.delete(sid);
      this.signOuts += 1;
      return { redirect: `${this.origin}/login` };
    }
    if (!signedIn) return { redirect: `${this.origin}/login` };
    switch (path) {
      case "/home":
        return {
          page: { text: "Welcome, agent. Your account", selectors: ["#account", "#logout"] },
        };
      case "/invoices":
        return {
          page: {
            text: "Invoices\nINV-1001 120.00 open",
            selectors: ["#account"],
            tables: [
              { headers: ["Invoice", "Total", "Status"], rows: [["INV-1001", "120.00", "open"]] },
            ],
            fields: [
              { type: "hidden", value: "csrf-token-abc123" },
              { type: "password", value: "should-never-show" },
              { type: "text", value: "PO-77" },
            ],
          },
        };
      case "/invoices/echo":
        // A badly made page that shows the account's own password back.
        return {
          page: { text: `Your password is ${this.options.password}`, selectors: ["#account"] },
        };
      case "/invoices/moved":
        return { redirect: "https://elsewhere.test/invoices" };
      case "/invoices/old-link":
        return { redirect: `${this.origin}/account/settings` };
      case "/account/settings":
        return { page: { text: "Change password, users and billing", selectors: [] } };
      default:
        return { page: { text: "Not found", selectors: [] } };
    }
  }

  /** A click on a form button: what it posts and where the browser goes. */
  submit(
    url: string,
    selector: string,
    form: Record<string, string>,
    sid: string | null,
  ): { go: string; setSid?: string } {
    const u = webUrl(url);
    if (u.pathname === "/login" && selector === "#go") {
      if (form["#user"] !== this.options.username || form["#pass"] !== this.options.password) {
        return { go: `${this.origin}/login?error=1` };
      }
      const pendingSid = `pending-${this.signIns + 1}-${Math.random().toString(36).slice(2)}`;
      if (!this.options.codeTo) {
        this.signIns += 1;
        this.sessions.add(pendingSid);
        return { go: `${this.origin}/home`, setSid: pendingSid };
      }
      this.pending.add(pendingSid);
      const code = this.options.code ?? "481516";
      this.codesSent.push(code);
      this.options.codeTo.codes.deliver(
        "email",
        this.options.codeTo.email,
        "no-reply@supplier.test",
        `Your sign-in code is ${code}. It expires in 10 minutes.`,
      );
      return { go: `${this.origin}/verify`, setSid: pendingSid };
    }
    if (u.pathname === "/verify" && selector === "#verify") {
      if (!sid || !this.pending.has(sid) || form["#code"] !== (this.options.code ?? "481516")) {
        return { go: `${this.origin}/login?error=1` };
      }
      this.pending.delete(sid);
      this.sessions.add(sid);
      this.signIns += 1;
      return { go: `${this.origin}/home` };
    }
    if (selector === "#logout") {
      if (sid) this.sessions.delete(sid);
      this.signOuts += 1;
      return { go: `${this.origin}/login` };
    }
    return { go: url };
  }

  download(url: string, sid: string | null): BrowserDownload {
    const u = webUrl(url);
    const signedIn = sid !== null && this.sessions.has(sid);
    if (!signedIn) {
      return {
        bytes: utf8("sign in"),
        filename: "login",
        mimeType: "text/html",
        finalUrl: `${this.origin}/login`,
        status: 200,
      };
    }
    if (u.pathname === "/invoices/INV-1001.pdf") {
      return {
        bytes: this.invoicePdf,
        filename: "INV-1001.pdf",
        mimeType: "application/pdf",
        finalUrl: url,
        status: 200,
      };
    }
    if (u.pathname === "/invoices/statement.csv") {
      return {
        bytes: utf8("a,b"),
        filename: "statement.csv",
        mimeType: "text/csv",
        finalUrl: url,
        status: 200,
      };
    }
    return {
      bytes: new Uint8Array(),
      filename: "x",
      mimeType: "text/html",
      finalUrl: url,
      status: 404,
    };
  }
}

/** One thing the fake browser did. */
export type FakeBrowserEvent =
  | { op: "goto" | "landed"; url: string }
  | { op: "fill"; url: string; selector: string; value: string }
  | { op: "click"; url: string; selector: string }
  | { op: "screenshot"; url: string }
  | { op: "read"; url: string }
  | { op: "download"; url: string }
  | { op: "set_cookies"; count: number }
  | { op: "close" };

/** A BrowserDriver over a FakeSupplierPortal; every tab's events are kept in `events`. */
export class FakeBrowserDriver implements BrowserDriver {
  readonly events: FakeBrowserEvent[] = [];
  opened = 0;
  closed = 0;
  constructor(readonly portal: FakeSupplierPortal) {}

  async open(): Promise<BrowserTab> {
    this.opened += 1;
    const portal = this.portal;
    const events = this.events;
    let url = "about:blank";
    let page: FakePage = { text: "", selectors: [] };
    let jar: BrowserCookie[] = [];
    let form: Record<string, string> = {};
    const sid = () => jar.find((c) => c.name === "sid")?.value ?? null;
    const land = (target: string) => {
      let next = target;
      for (let hops = 0; hops < 5; hops++) {
        const r = portal.visit(next, sid());
        if ("redirect" in r) {
          next = r.redirect;
          continue;
        }
        url = next;
        page = r.page;
        form = {};
        events.push({ op: "landed", url });
        return;
      }
      throw new Error("too many redirects");
    };
    const driver = this;
    return {
      url: () => url,
      async goto(target) {
        events.push({ op: "goto", url: target });
        land(target);
      },
      async fill(selector, value) {
        if (!page.selectors.includes(selector)) throw new Error(`no ${selector} on ${url}`);
        events.push({ op: "fill", url, selector, value });
        form[selector] = value;
      },
      async click(selector) {
        if (!page.selectors.includes(selector)) throw new Error(`no ${selector} on ${url}`);
        events.push({ op: "click", url, selector });
        const r = portal.submit(url, selector, form, sid());
        if (r.setSid) {
          jar = [
            ...jar.filter((c) => c.name !== "sid"),
            {
              name: "sid",
              value: r.setSid,
              domain: webUrl(portal.origin).hostname,
              path: "/",
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: "Lax",
            },
          ];
        }
        land(r.go);
      },
      async has(selector) {
        return page.selectors.includes(selector);
      },
      async readText() {
        events.push({ op: "read", url });
        // The driver contract: password and hidden inputs are never read.
        const values = (page.fields ?? []).filter((f) => f.type === "text").map((f) => f.value);
        return [page.text, ...values].filter(Boolean).join("\n");
      },
      async readTables() {
        return clone(page.tables ?? []);
      },
      async download(target) {
        events.push({ op: "download", url: target });
        return portal.download(target, sid());
      },
      async cookies() {
        return clone(jar);
      },
      async setCookies(cookies) {
        events.push({ op: "set_cookies", count: cookies.length });
        jar = clone(cookies);
      },
      async screenshot() {
        events.push({ op: "screenshot", url });
        return new Uint8Array([137, 80, 78, 71]);
      },
      async close() {
        events.push({ op: "close" });
        driver.closed += 1;
      },
    };
  }
}
