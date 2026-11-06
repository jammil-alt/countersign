// What the route sweep and the walkthroughs share: the browser, the signed-in contexts, the looks
// they run in (light and dark, desktop and phone width), the checks every page gets, and
// screenshots. Read-only by design: nothing here clicks or submits.
//
//   SWEEP_URL       the app (default http://localhost:8787)
//   SWEEP_CHROMIUM  a Chromium to use instead of Playwright's own
//   SWEEP_LOOKS     which looks to run, comma separated (each script has its default)
//   SWEEP_SHOTS     a folder: a screenshot of every page in every look goes there

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

export const BASE = (process.env.SWEEP_URL ?? "http://localhost:8787").replace(/\/$/, "");
export const SHOTS = process.env.SWEEP_SHOTS || null;
const SETTLE_MS = 400;

/** The seeded people (packages/db/src/seed.ts): the operator, and the Demo client's admin. */
export const OPERATOR = "operator@example.com";
export const CLIENT_ADMIN = "admin@demo-client.example.com";

/**
 * The looks a page is checked in. The theme is the system's (`colorScheme`): the app follows it
 * unless a person picked one (apps/web/src/shell/theme.ts). Phone width is 390×844, where a page
 * that scrolls sideways fails.
 */
export const LOOKS = {
  "desktop-light": { viewport: { width: 1440, height: 900 }, colorScheme: "light", phone: false },
  "desktop-dark": { viewport: { width: 1440, height: 900 }, colorScheme: "dark", phone: false },
  "phone-light": { viewport: { width: 390, height: 844 }, colorScheme: "light", phone: true },
  "phone-dark": { viewport: { width: 390, height: 844 }, colorScheme: "dark", phone: true },
};

/** The looks named in SWEEP_LOOKS, or `fallback`. */
export function looks(fallback) {
  const names = (process.env.SWEEP_LOOKS ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const n of names) {
    if (!Object.hasOwn(LOOKS, n)) throw new Error(`Unknown look "${n}": ${Object.keys(LOOKS)}`);
  }
  return names;
}

export function launch() {
  return chromium.launch(
    process.env.SWEEP_CHROMIUM ? { executablePath: process.env.SWEEP_CHROMIUM } : {},
  );
}

/**
 * A page signed in as `email` (the dev adapter's cookie) in a look, with `problems` collecting
 * page errors, console errors and /api 5xx as they happen. Reset `problems.length = 0` per page.
 */
export async function openPage(browser, email, lookName) {
  const look = LOOKS[lookName];
  const context = await browser.newContext({
    viewport: look.viewport,
    colorScheme: look.colorScheme,
    deviceScaleFactor: 1,
  });
  const { hostname } = new URL(BASE);
  await context.addCookies([
    { name: "cs_dev_user", value: encodeURIComponent(email), domain: hostname, path: "/" },
  ]);
  const page = await context.newPage();
  const problems = [];
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
  return { context, page, problems, look };
}

/** Waits for the page to go quiet after a navigation or a click. */
export async function settle(page) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
  } catch {
    // Polling screens may never go fully idle; the checks below still run.
  }
  await page.waitForTimeout(SETTLE_MS);
}

/**
 * The checks every page gets: it rendered (React did not unmount the root), it is not "Not found"
 * or the sign-in page, and at phone width it does not scroll sideways. Returns the problems found.
 */
export async function checkPage(page, look) {
  const out = [];
  const landed = new URL(page.url()).pathname;
  if (landed.startsWith("/sign-in")) out.push("sent to sign-in (the dev sign-in did not hold)");
  const rootEmpty = await page.evaluate(() => !document.getElementById("root")?.children.length);
  if (rootEmpty) out.push("the screen crashed: #root is empty");
  if (await page.getByText("No page here.").count()) out.push("a link led to Not found");
  if (look.phone) {
    const wide = await page.evaluate(() => {
      const doc = document.documentElement;
      if (doc.scrollWidth <= window.innerWidth + 1) return null;
      // Name the widest element that sticks out, so the failure says where to look.
      let worst = null;
      for (const el of document.body.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.right > window.innerWidth + 1 && (!worst || r.right > worst.right)) {
          const cls = typeof el.className === "string" ? el.className.split(/\s+/)[0] : "";
          worst = {
            right: Math.round(r.right),
            what: `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${el.dataset.testid ? `[${el.dataset.testid}]` : ""}`,
          };
        }
      }
      return { scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth, worst };
    });
    if (wide) {
      out.push(
        `scrolls sideways at phone width: ${wide.scrollWidth}px wide in ${wide.innerWidth}px` +
          (wide.worst ? ` (widest: ${wide.worst.what} to ${wide.worst.right}px)` : ""),
      );
    }
  }
  return out;
}

/** A full-page screenshot into SWEEP_SHOTS/<look>/<name>.png, when SWEEP_SHOTS is set. */
export async function shoot(page, lookName, name) {
  if (!SHOTS) return;
  const dir = join(SHOTS, lookName);
  mkdirSync(dir, { recursive: true });
  // Runs of other characters were collapsed to one "_", so at most one leads and one trails.
  let file = name.replace(/[^\w-]+/g, "_");
  if (file.startsWith("_")) file = file.slice(1);
  if (file.endsWith("_")) file = file.slice(0, -1);
  file ||= "home";
  await page.screenshot({ path: join(dir, `${file}.png`), fullPage: true });
}
