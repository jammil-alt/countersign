// Route sweep (docs/operations.md §2): opens every screen of the back office and the portal in real
// Chromium, signed in with the dev adapter, against the Worker (`wrangler dev`, the built app) and
// the seeded database. It starts from each route without parameters, then follows the links the
// screens show, one page per route pattern, so screens with ids are reached with real ones and new
// screens are swept without editing this file.
//
// A page fails when the screen crashed (React unmounted the root: an empty #root), the page threw,
// the console logged an error, an /api call answered 500 or more, a link led to "Not found", or,
// at phone width, the page scrolls sideways. It runs in several looks (./harness.mjs): light and
// dark at desktop width and dark at 390×844 by default. It clicks nothing and submits nothing:
// navigation only. Screens are being redesigned (the owner's v1 layouts), so this checks that each
// screen renders, not what it shows. The walkthroughs (./walkthroughs.mjs) follow the prototype's
// two paths through the screens.
//
//   SWEEP_URL=http://localhost:8787 node e2e/route-sweep.mjs
//   SWEEP_LOOKS=phone-light SWEEP_SHOTS=/tmp/shots node e2e/route-sweep.mjs
//
// Exit 1 with the failures listed; patterns never reached are listed as a note.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BASE,
  CLIENT_ADMIN,
  checkPage,
  launch,
  looks,
  OPERATOR,
  openPage,
  settle,
  shoot,
} from "./harness.mjs";

const MAX_PAGES = Number(process.env.SWEEP_MAX_PAGES ?? 200);
const LOOK_NAMES = looks("desktop-light,desktop-dark,phone-dark");

/**
 * The seeded people (./harness.mjs): the operator, and the Demo client's admin. `files`: where each
 * area's route table is, the first that exists (the UI plan moves it into routes.tsx).
 */
const AREAS = [
  {
    name: "back office",
    email: OPERATOR,
    prefix: "/ops",
    files: ["../src/ops/routes.tsx", "../src/ops/OpsApp.tsx"],
  },
  {
    name: "portal",
    email: CLIENT_ADMIN,
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

async function sweepArea(browser, area, lookName, failures, unreached) {
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
  const { context, page, problems, look } = await openPage(browser, area.email, lookName);

  const seen = new Set(); // patterns visited
  const queue = patterns.filter((p) => !/[:*]/.test(p)).map((p) => p.replace(/\/$/, "") || "/");
  let pages = 0;
  while (queue.length > 0 && pages < MAX_PAGES) {
    const path = queue.shift();
    const pattern = patternOf(patterns, path);
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    pages += 1;
    problems.length = 0;
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await settle(page);
    } catch (e) {
      problems.push(`did not load: ${e.message.split("\n")[0]}`);
    }
    problems.push(...(await checkPage(page, look)));
    for (const p of problems) failures.push(`${lookName} ${area.name} ${path}: ${p}`);
    console.log(`${problems.length ? "FAIL" : "ok  "} ${lookName} ${area.name} ${path}`);
    // Only pages whose address has no id, so each run's screenshots have the same names.
    if (!/[:*]/.test(pattern)) await shoot(page, lookName, `${area.name} ${path}`);

    const links = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
    for (const href of links) {
      if (!href?.startsWith("/") || SKIP.test(href)) continue;
      const next = href.split(/[?#]/)[0];
      if (area.prefix ? !next.startsWith(area.prefix) : next.startsWith("/ops")) continue;
      const p = patternOf(patterns, next);
      if (p && !seen.has(p)) queue.push(next);
    }
  }
  for (const p of patterns) if (!seen.has(p)) unreached.add(`${area.name} ${p}`);
  await context.close();
}

async function main() {
  const browser = await launch();
  const failures = [];
  const unreached = new Set();
  try {
    for (const lookName of LOOK_NAMES) {
      for (const area of AREAS) await sweepArea(browser, area, lookName, failures, unreached);
    }
  } finally {
    await browser.close();
  }
  if (unreached.size) {
    console.log(`\nNot reached (no link to one in the seeded data): ${[...unreached].join(", ")}`);
  }
  if (failures.length) {
    console.error(`\n${failures.length} problem(s):\n${failures.map((f) => `  ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`\nEvery screen reached rendered without errors in ${LOOK_NAMES.join(", ")}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
