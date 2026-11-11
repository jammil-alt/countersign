import fs from "node:fs";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");

const LOG = process.env.LOG ?? "/var/log/postgresql/postgresql-16-main.log";
const BASE = process.env.BASE ?? "http://localhost:8787";
const LATENCY = Number(process.env.LATENCY_MS ?? 0);
const CLIENT = process.env.CLIENT_ID; // Harbor Millwork
const RUN = process.env.RUN_ID; // one of its runs
const AGENT = process.env.AGENT_ID; // its Bill clerk
const who = process.argv[2];

const screens =
  who === "ops"
    ? [
        ["Home", "/ops"],
        ["Escalations", "/ops/inbox"],
        ["Runs", "/ops/runs"],
        ["Run page", `/ops/runs/${RUN}`],
        ["Agent lab", "/ops/lab"],
        ["Clients", "/ops/clients"],
        ["Client overview", `/ops/clients/${CLIENT}`],
        ["Client agents", `/ops/clients/${CLIENT}/agents`],
        ["Agent page", `/ops/clients/${CLIENT}/agents/bill-clerk`],
        ["Agent workflow tab", `/ops/clients/${CLIENT}/agents/bill-clerk/workflows/invoice-read`],
        ["Agent runs tab", `/ops/clients/${CLIENT}/agents/bill-clerk/runs`],
        ["Agent versions tab", `/ops/clients/${CLIENT}/agents/bill-clerk/versions`],
        ["Client connections", `/ops/clients/${CLIENT}/connections`],
        ["Client documents", `/ops/clients/${CLIENT}/documents`],
        ["Client settings", `/ops/clients/${CLIENT}/settings`],
        ["Skills", "/ops/skills"],
        ["Usage", "/ops/usage"],
      ]
    : [
        ["Home", "/"],
        ["Inbox", "/inbox"],
        ["Runs", "/runs"],
        ["Run page", `/runs/${RUN}`],
        ["Agent", `/agents/${AGENT}`],
        ["Agent runs tab", `/agents/${AGENT}/runs`],
        ["Agent access tab", `/agents/${AGENT}/access`],
        ["Accounts", "/accounts"],
        ["Contacts", "/contacts"],
        ["Records", "/records"],
        ["Settings", "/settings"],
        ["Settings team", "/settings/team"],
        ["Sloan", "/sloan"],
      ];
const email = who === "ops" ? "operator@example.com" : "dana@harbor-millwork.example.com";

// Statements logged since `offset`, leaving out begin, commit and rollback.
const sqlSince = (offset) => {
  let work = 0;
  for (const line of fs.readFileSync(LOG).subarray(offset).toString("utf8").split("\n")) {
    const m = line.match(/LOG:\s+(?:statement|execute [^:]*):\s*(.*)$/);
    if (m && !/^(begin|commit|rollback)/i.test(m[1].trim())) work++;
  }
  return work;
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
if (LATENCY > 0) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: LATENCY,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
}
let calls = [];
let lastCallAt = 0;
page.on("requestfinished", (r) => {
  const u = new URL(r.url());
  if (!u.pathname.startsWith("/api/")) return;
  calls.push(`${r.method()} ${u.pathname}${u.search}`);
  lastCallAt = Date.now();
});
const signIn = await context.request.post(`${BASE}/api/auth/dev/sign-in`, { data: { email } });
if (!signIn.ok()) throw new Error(`sign-in ${signIn.status()}`);

// No new call for 800 ms (plus the added latency) counts as loaded. Polls of 2 s and more
// fall outside it.
const idle = async () => {
  let last = -1;
  let quiet = 0;
  for (let i = 0; i < 60 && quiet < 2; i++) {
    await page.waitForTimeout(400 + LATENCY);
    quiet = calls.length === last ? quiet + 1 : 0;
    last = calls.length;
  }
};
const plain = (p) => p.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id");

const out = [];
for (const mode of ["fresh", "move"]) {
  if (mode === "move") {
    await page.goto(BASE + (who === "ops" ? "/ops/billing" : "/knowledge"));
    await idle();
  }
  for (const [name, path] of screens) {
    calls = [];
    const offset = fs.statSync(LOG).size;
    const started = Date.now();
    lastCallAt = started;
    if (mode === "fresh") await page.goto(BASE + path, { waitUntil: "load" });
    else
      await page.evaluate((p) => {
        history.pushState({}, "", p);
        dispatchEvent(new PopStateEvent("popstate", { state: {} }));
      }, path);
    await idle();
    const settled = lastCallAt - started;
    const paint =
      mode === "fresh"
        ? await page.evaluate(() => {
            const e = performance.getEntriesByName("first-contentful-paint")[0];
            return e ? Math.round(e.startTime) : null;
          })
        : null;
    const counts = {};
    for (const c of calls) counts[plain(c)] = (counts[plain(c)] ?? 0) + 1;
    const repeated = Object.entries(counts)
      .filter(([, n]) => n > 1)
      .map(([k, n]) => `${k} x${n}`);
    const sql = sqlSince(offset);
    out.push({
      mode,
      name,
      api: calls.length,
      sql,
      paint,
      settled,
      repeated,
      calls: Object.keys(counts),
    });
    console.log(
      mode.padEnd(6),
      name.padEnd(22),
      "api",
      String(calls.length).padStart(3),
      " sql",
      String(sql).padStart(4),
      " paint",
      String(paint ?? "-").padStart(5),
      " settled",
      String(settled).padStart(5),
      repeated.length ? ` repeated: ${repeated.join(" | ")}` : "",
    );
  }
}
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
await browser.close();
