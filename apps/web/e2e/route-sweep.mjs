// Route sweep (docs/operations.md §2): opens every screen of the back office and the portal in real
// Chromium, signed in with the dev adapter, against the Worker (`wrangler dev`, the built app) and
// the seeded database. It starts from each route without parameters, then follows the links the
// screens show, one page per route pattern, so screens with ids are reached with real ones and new
// screens are swept without editing this file.
//
// A page fails when the screen crashed (React unmounted the root: an empty #root), the page threw,
// the console logged an error, an /api call answered 500 or more, or a link led to "Not found".
// It clicks nothing and submits nothing: navigation only. Screens are being redesigned (the owner's
// v1 layouts), so this checks that each screen renders, not what it shows.
//
//   SWEEP_URL=http://localhost:8787 node e2e/route-sweep.mjs
//
// Exit 1 with the failures listed; patterns never reached are listed as a note.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const BASE = (process.env.SWEEP_URL ?? "http://localhost:8787").replace(/\/$/, "");
const MAX_PAGES = Number(process.env.SWEEP_MAX_PAGES ?? 200);
const SETTLE_MS = 400;

/**
 * The seeded people (packages/db/src/seed.ts): the operator, and the Demo client's admin. `files`:
 * where each area's route table is, the first that exists (the UI plan moves it into routes.tsx).
 */
const AREAS = [
  {
    name: "back office",
    email: "operator@example.com",
    prefix: "/ops",
    files: ["../src/ops/routes.tsx", "../src/ops/OpsApp.tsx"],
  },
  {
    name: "portal",
    email: "admin@demo-client.example.com",
    prefix: "",
    files: ["../src/portal/routes.tsx", "../src/portal/PortalApp.tsx"],
  },
];

/**
 * Routes that do something on arrival or only make sense inside a provider's flow (an OAuth
 * callback finishing a sign-in, a sheet picker or a signup a provider opens): never visited.
 */
const SKIP = /callback|\/connections\/[^/]+\/(pick|signup)|sign-out|\/api\//;

/** The route patterns a file declares: `path="…"` and the placeholders' `["…", "…"]` pairs. */
export function routePatterns(source, prefix) {
  // Comments can quote `path="…"` themselves (the route files mention this sweep): drop them, and
  // take only values a route can have.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const found = new Set();
  for (const m of code.matchAll(/\bpath="([\w\-:/*.]+)"/g)) found.add(m[1]);
  for (const m of code.matchAll(/\[\s*"([a-z][\w\-:/*.]*)",\s*"[^"]+"\s*\]/g)) found.add(m[1]);
  const out = [`${prefix}/`];
  for (const p of found) {
    if (p === "*" || p.startsWith("/")) continue;
    out.push(`${prefix}/${p}`);
  }
  return [...new Set(out)];
}

/** A pattern as a regex over a path: `:param` one segment, a trailing `*` anything. */
export function patternRegex(pattern) {
  const body = pattern
    .replace(/\/$/, "")
    .split("/")
    .map((seg) =>
      seg === "*"
        ? ".*"
        : seg.startsWith(":")
          ? "[^/]+"
          : seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${body || ""}/?$`);
}

function patternOf(patterns, path) {
  // Most specific first: fewer parameters and wildcards win.
  const score = (p) => (p.match(/[:*]/g) ?? []).length;
  return [...patterns].sort((a, b) => score(a) - score(b)).find((p) => patternRegex(p).test(path));
}

async function sweepArea(browser, area, failures, unreached) {
  const file = area.files
    .map((f) => fileURLToPath(new URL(f, import.meta.url)))
    .find((f) => existsSync(f));
  const source = file ? readFileSync(file, "utf8") : "";
  const patterns = routePatterns(source, area.prefix).filter((p) => !SKIP.test(p));
  // A route table that moved or changed shape would leave almost nothing to sweep: say so.
  if (patterns.length < 5) {
    failures.push(
      `${area.name}: only ${patterns.length} routes found in ${area.files.join(" or ")}; has the route table moved?`,
    );
  }
  const context = await browser.newContext();
  const { hostname } = new URL(BASE);
  await context.addCookies([
    { name: "cs_dev_user", value: encodeURIComponent(area.email), domain: hostname, path: "/" },
  ]);
  const page = await context.newPage();
  let problems = [];
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("console", (m) => {
    // A 4xx the screen handles shows up as "Failed to load resource"; 5xx are caught below.
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) {
      problems.push(`console error: ${m.text().slice(0, 300)}`);
    }
  });
  page.on("response", (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith("/api/") && r.status() >= 500) {
      problems.push(`${r.request().method()} ${url.pathname} answered ${r.status()}`);
    }
  });

  const seen = new Set(); // patterns visited
  const queue = patterns.filter((p) => !/[:*]/.test(p)).map((p) => p.replace(/\/$/, "") || "/");
  let pages = 0;
  while (queue.length > 0 && pages < MAX_PAGES) {
    const path = queue.shift();
    const pattern = patternOf(patterns, path);
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    pages += 1;
    problems = [];
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(SETTLE_MS);
    } catch (e) {
      problems.push(`did not load: ${e.message.split("\n")[0]}`);
    }
    const landed = new URL(page.url()).pathname;
    if (landed.startsWith("/sign-in"))
      problems.push("sent to sign-in (the dev sign-in did not hold)");
    const rootEmpty = await page.evaluate(() => !document.getElementById("root")?.children.length);
    if (rootEmpty) problems.push("the screen crashed: #root is empty");
    if (await page.getByText("No page here.").count()) problems.push("a link led to Not found");
    for (const p of problems) failures.push(`${area.name} ${path}: ${p}`);
    console.log(`${problems.length ? "FAIL" : "ok  "} ${area.name} ${path}`);

    const links = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
    for (const href of links) {
      if (!href?.startsWith("/") || SKIP.test(href)) continue;
      const next = href.split(/[?#]/)[0];
      if (area.prefix ? !next.startsWith(area.prefix) : next.startsWith("/ops")) continue;
      const p = patternOf(patterns, next);
      if (p && !seen.has(p)) queue.push(next);
    }
  }
  for (const p of patterns) if (!seen.has(p)) unreached.push(`${area.name} ${p}`);
  await context.close();
}

async function main() {
  const browser = await chromium.launch(
    process.env.SWEEP_CHROMIUM ? { executablePath: process.env.SWEEP_CHROMIUM } : {},
  );
  const failures = [];
  const unreached = [];
  try {
    for (const area of AREAS) await sweepArea(browser, area, failures, unreached);
  } finally {
    await browser.close();
  }
  if (unreached.length) {
    console.log(`\nNot reached (no link to one in the seeded data): ${unreached.join(", ")}`);
  }
  if (failures.length) {
    console.error(`\n${failures.length} problem(s):\n${failures.map((f) => `  ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log("\nEvery screen reached rendered without errors.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
