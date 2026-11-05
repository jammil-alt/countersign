// The browser connector in real Chromium (Playwright), against a fixture supplier portal this test
// serves on 127.0.0.1: sign-in with an emailed code from a fake code service, reading a page with
// its password and hidden inputs removed, downloading an invoice PDF into documents, signing out,
// and origin pinning (a login page that moves to another origin gets nothing typed). The same
// Playwright adapter runs on Browser Run in the Worker.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BROWSER_FILE_DOWNLOAD_TOOL,
  BROWSER_PAGE_READ_TOOL,
  type BrowserServices,
  type BrowserSessionRecord,
  createBrowserConnector,
  FakeCodesService,
  fakeCodesPort,
  memoryCredentials,
  noopLogger,
  type PlaywrightPageLike,
  playwrightTab,
  runReadTool,
  type ToolContext,
} from "@countersign/connectors";
import {
  type BrowserConnectionState,
  BrowserSiteProfile,
  type PinnedBrowserSite,
} from "@countersign/core";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TENANT = "0190f5e8-8a3c-7d6e-8f00-00000000aaaa";
const VERSION = "0190f5e8-8a3c-7d6e-8f00-00000000eeee";
const USERNAME = "agent@client.test";
const PASSWORD = "Chromium-Pw-55!";
const CODE = "735019";

/** The fixture portal: what it saw, and its sessions. */
const seen = { posts: [] as { path: string; body: string }[], signOuts: 0, codes: 0 };
const sessions = new Set<string>();
const pending = new Set<string>();
let moveLogin = false;
const codes = new FakeCodesService();
let identityEmail = "";

const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n% INV-1001 total 120.00\n%%EOF\n",
);

function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

function cookieSid(req: IncomingMessage): string | null {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "");
  return m?.[1] ?? null;
}

async function bodyOf(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

let origin = "";

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const sid = cookieSid(req);
  const signedIn = sid !== null && sessions.has(sid);
  const send = (status: number, html: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
    res.end(html);
  };
  const go = (to: string, headers: Record<string, string> = {}) => {
    res.writeHead(303, { location: to, ...headers });
    res.end();
  };
  if (req.method === "POST") {
    const form = await bodyOf(req);
    seen.posts.push({ path: url.pathname, body: form.toString() });
    if (url.pathname === "/login") {
      if (form.get("username") !== USERNAME || form.get("password") !== PASSWORD) {
        return go("/login?error=1");
      }
      const p = `p${Math.random().toString(36).slice(2)}`;
      pending.add(p);
      seen.codes += 1;
      codes.deliver("email", identityEmail, "no-reply@supplier.test", `Your code is ${CODE}.`);
      return go("/verify", { "set-cookie": `sid=${p}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (url.pathname === "/verify") {
      if (!sid || !pending.has(sid) || form.get("code") !== CODE) return go("/login?error=1");
      pending.delete(sid);
      sessions.add(sid);
      return go("/home");
    }
    return send(404, page("Not found", "Not found"));
  }
  switch (url.pathname) {
    case "/login":
      // Moved to another origin (the same host on another port): nothing may be typed there.
      if (moveLogin && url.port !== otherPort) return go(`http://127.0.0.1:${otherPort}/login`);
      return send(
        200,
        page(
          "Sign in",
          `<h1>Supplier portal</h1><form method="post" action="/login">
            <input id="user" name="username" type="text">
            <input id="pass" name="password" type="password">
            <input type="hidden" name="csrf" value="login-csrf-1">
            <button id="go" type="submit">Sign in</button></form>`,
        ),
      );
    case "/verify":
      return send(
        200,
        page(
          "Verify",
          `<p>Enter the code we emailed you</p><form method="post" action="/verify">
            <input id="code" name="code" autocomplete="one-time-code">
            <button id="verify" type="submit">Verify</button></form>`,
        ),
      );
    case "/logout":
      if (sid) sessions.delete(sid);
      seen.signOuts += 1;
      return go("/login", { "set-cookie": "sid=; Path=/; Max-Age=0" });
  }
  if (!signedIn) return go("/login");
  switch (url.pathname) {
    case "/home":
      return send(
        200,
        page("Home", `<p id="account">Signed in as the agent</p><a href="/logout">Sign out</a>`),
      );
    case "/invoices":
      return send(
        200,
        page(
          "Invoices",
          `<div id="account">Agent</div><h1>Invoices</h1>
          <table><thead><tr><th>Invoice</th><th>Total</th><th>Status</th></tr></thead>
          <tbody><tr><td>INV-1001</td><td>120.00</td><td>open</td></tr>
          <tr><td>INV-1002</td><td>75.50</td><td>paid</td></tr></tbody></table>
          <form><label>PO <input type="text" value="PO-77"></label>
          <input type="password" value="should-never-show">
          <input type="hidden" value="csrf-secret-123"></form>
          <div hidden>hidden-div-text</div><div style="display:none">invisible-text</div>
          <script>var token = "script-text";</script>`,
        ),
      );
    case "/invoices/INV-1001.pdf":
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="INV-1001.pdf"',
      });
      return res.end(PDF);
    default:
      return send(404, page("Not found", "Not found"));
  }
}

let server: Server;
/** The same portal on another port: another origin. */
let other: Server;
let otherPort = "";
let browser: Browser;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  other = createServer((req, res) => {
    void handle(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  otherPort = String((other.address() as AddressInfo).port);
  browser = await chromium.launch();
  const made = await codes.createIdentity({ tenantId: TENANT, label: "Supplier portal" });
  if (!made.ok) throw new Error("no identity");
  identityEmail = made.value.email;
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
  await new Promise((resolve) => other?.close(resolve));
});

function setUp() {
  const profile = BrowserSiteProfile.parse({
    login: {
      url: `${origin}/login`,
      origins: [origin],
      usernameField: "#user",
      passwordField: "#pass",
      submitButton: "#go",
      secondFactor: {
        kind: "email",
        sender: "@supplier.test",
        pattern: "code is (\\d{6})",
        codeField: "#code",
        codeButton: "#verify",
      },
      signedIn: { selector: "#account" },
    },
    signOut: { url: `${origin}/logout` },
    allow: [`${origin}/home`, `${origin}/invoices*`],
  });
  const site: PinnedBrowserSite = {
    slug: "supplier",
    name: "Supplier portal",
    tier: "low",
    versionId: VERSION,
    version: 1,
    profile,
  };
  let state: BrowserConnectionState | null = null;
  const records: BrowserSessionRecord[] = [];
  const documents: { filename: string; mimeType: string; bytes: Uint8Array }[] = [];
  const stops: string[] = [];
  const services: BrowserServices = {
    site: async () => site,
    async open() {
      const context = await browser.newContext();
      const p = await context.newPage();
      return playwrightTab(p as unknown as PlaywrightPageLike, {
        close: () => context.close(),
        timeoutMs: 10_000,
        navigationWaitMs: 2_000,
      });
    },
    codes: fakeCodesPort(codes, TENANT),
    state: {
      get: async () => state,
      put: async (s) => {
        state = s;
      },
      stop: async (reason) => {
        stops.push(reason);
      },
    },
    storeDocument: async (file) => {
      documents.push(file);
      return { documentId: "doc-1", created: true };
    },
    saveScreenshot: async (png) => {
      expect([...png.slice(1, 4)]).toEqual([80, 78, 71]); // "PNG"
      return "shot";
    },
    record: async (r) => {
      records.push(r);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
  };
  const ctx: ToolContext = {
    tenantId: TENANT,
    connection: {
      id: "0190f5e8-8a3c-7d6e-8f00-00000000cccc",
      tenantId: TENANT,
      connector: "browser",
      status: "connected",
      externalAccountId: null,
      config: {
        site: "supplier",
        siteVersionId: VERSION,
        identity: { id: [...codes.identities.keys()][0] ?? "", email: identityEmail, phone: null },
      },
      permissions: { read: "auto", create: "approval", update: "approval", delete: "off" },
    },
    credentials: memoryCredentials({ username: USERNAME, password: PASSWORD }),
    logger: noopLogger,
    now: () => new Date(),
    services: { browser: services },
  };
  const connector = createBrowserConnector({ codePoll: { intervalMs: 50, attempts: 40 } });
  return { ctx, connector, records, documents, stops, state: () => state };
}

describe("the browser connector in Chromium", () => {
  it("signs in with the emailed code, reads a page without its secret fields, signs out", async () => {
    const s = setUp();
    const before = seen.signOuts;
    const r = await runReadTool(
      s.connector,
      BROWSER_PAGE_READ_TOOL,
      { site: "supplier", url: `${origin}/invoices` },
      s.ctx,
    );
    const out = r.output as { text: string; tables: { headers: string[]; rows: string[][] }[] };
    expect(out.tables).toEqual([
      {
        headers: ["Invoice", "Total", "Status"],
        rows: [
          ["INV-1001", "120.00", "open"],
          ["INV-1002", "75.50", "paid"],
        ],
      },
    ]);
    expect(out.text).toContain("INV-1001");
    expect(out.text).toContain("PO-77");
    const all = JSON.stringify(r.output);
    for (const hidden of [
      "should-never-show",
      "csrf-secret-123",
      "hidden-div-text",
      "invisible-text",
      "script-text",
      PASSWORD,
      CODE,
    ]) {
      expect(all, hidden).not.toContain(hidden);
    }
    // Typed on the login origin, through the real form: username and password, then the code.
    const login = seen.posts.filter((p) => p.path === "/login").at(-1);
    expect(new URLSearchParams(login?.body).get("username")).toBe(USERNAME);
    expect(seen.posts.filter((p) => p.path === "/verify").at(-1)?.body).toBe(`code=${CODE}`);
    expect(seen.signOuts).toBe(before + 1);
    expect(sessions.size).toBe(0);
    expect(s.records[0]).toMatchObject({ signIn: "fresh", outcome: "done", signedOut: true });
    expect(s.state()).toMatchObject({ signIns: 1, failures: 0, stopped: null });
  });

  it("downloads the invoice PDF into documents with the signed-in browser's cookies", async () => {
    const s = setUp();
    const r = await runReadTool(
      s.connector,
      BROWSER_FILE_DOWNLOAD_TOOL,
      { site: "supplier", url: `${origin}/invoices/INV-1001.pdf` },
      s.ctx,
    );
    expect(r.output).toMatchObject({
      documentId: "doc-1",
      filename: "INV-1001.pdf",
      mimeType: "application/pdf",
      sizeBytes: PDF.length,
    });
    expect(Buffer.from(s.documents[0]?.bytes ?? []).toString("latin1")).toContain("INV-1001");
    expect(s.records[0]).toMatchObject({ outcome: "done", signedOut: true });
  });

  it("types nothing when the login page moves to another origin, and stops", async () => {
    const s = setUp();
    const posts = seen.posts.length;
    moveLogin = true;
    try {
      await expect(
        runReadTool(
          s.connector,
          BROWSER_PAGE_READ_TOOL,
          { site: "supplier", url: `${origin}/invoices` },
          s.ctx,
        ),
      ).rejects.toThrow(
        /127\.0\.0\.1:\d+, which is not the site's login address; nothing was typed/,
      );
    } finally {
      moveLogin = false;
    }
    expect(seen.posts.length).toBe(posts);
    expect(s.stops).toHaveLength(1);
    expect(s.records[0]).toMatchObject({ outcome: "stopped" });
  });
});
