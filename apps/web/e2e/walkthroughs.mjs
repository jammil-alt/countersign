// The prototype's two walkthroughs (docs/design/prototype.html, `#Start`), clicked through the real
// UI on the seeded data: the client's morning (The Table, an agent, Your Desk, Runs, Accounts,
// People, Settings, the Weekly Table, Sloan) and the back office's (Command center, Escalations,
// Runs, a client and its tabs, Agent lab, an agent and its tabs, the workflow builder, triggers,
// Skills, Connectors, Usage and billing). Each step moves by clicking a link the screen shows, as
// a person would, opening the menu on a phone; every page gets the route sweep's checks
// (./harness.mjs).
//
// Read-only: any request that would change something (a POST, PUT, PATCH or DELETE to /api other
// than the dev sign-in) is stopped and fails the step, so nothing is sent or run, and no outside
// service is ever written to (CLAUDE.md invariant 8). One exception: in "Sign and undo", the
// Desk's sign and undo of the one item the e2e seed puts there (SEED_E2E=1, packages/db/src/seed.ts
// `seedDemoDesk`), a change on the in-memory testkit that no run ever executes. It is signed and
// then undone inside the window, so it waits again for the next look and the next run.
//
// A step the seeded data can't support (no client agent, no run) is skipped with a note, not
// failed.
//
//   SWEEP_URL=http://localhost:8787 node e2e/walkthroughs.mjs
//   SWEEP_LOOKS=desktop-light SWEEP_SHOTS=/tmp/shots node e2e/walkthroughs.mjs
//
// Exit 1 with the failures listed.

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

const LOOK_NAMES = looks("desktop-dark,phone-light");

/**
 * The seeded Desk item: uuid v5 of "demo:run:desk:item" in the seed's namespace (seeded ids never
 * change; packages/db/src/seed.test.ts checks this one).
 */
export const SEEDED_DESK_ITEM = "c99a8abe-0e92-5dee-bf29-46ef82002f23";
/** The only writes a walkthrough may make, and only while `w.allowDesk` is on. */
const DESK_WRITES = new Set(
  ["resolve", "undo"].map((action) => `POST /api/inbox/${SEEDED_DESK_ITEM}/${action}`),
);

/** A step the seeded data can't support: noted, not failed. */
class Skip extends Error {}

/** An exact path, or a test on one. */
function matches(href, target) {
  const path = href.split(/[?#]/)[0];
  return typeof target === "string" ? path === target : target(path);
}

/**
 * One walkthrough in one look: `step` runs a named step and checks the page it ends on; `follow`
 * clicks a link the screen shows; `links` lists the ones it shows.
 */
async function walk(browser, email, lookName, name, script, results) {
  const { context, page, problems, look } = await openPage(browser, email, lookName);
  // Nothing in a walkthrough writes: stop and report any request that would. The one exception is
  // the seeded Desk item's sign and undo, while the step that does them allows it.
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === "GET" || path.startsWith("/api/auth/dev/")) {
      return route.continue();
    }
    if (w.allowDesk && DESK_WRITES.has(`${req.method()} ${path}`)) return route.continue();
    problems.push(`tried to write: ${req.method()} ${path}`);
    return route.abort();
  });

  let n = 0;
  const w = {
    page,
    /** On only inside "Sign and undo": lets the seeded item's sign and undo through. */
    allowDesk: false,
    async goto(path) {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await settle(page);
    },
    /** The paths of the links in `scope` (a CSS selector) that `target` matches, in page order. */
    async links(target, scope = "main") {
      const hrefs = await page.$$eval(`${scope} a[href]`, (as) =>
        as.map((a) => a.getAttribute("href") ?? ""),
      );
      return [
        ...new Set(hrefs.filter((h) => h.startsWith("/") && matches(h, target)).map(stripQuery)),
      ];
    },
    /** Fails the step unless the screen shows a link that `target` matches. */
    async expectLink(target, what) {
      if ((await w.links(target)).length === 0) throw new Error(`no link: ${what}`);
    },
    /**
     * Clicks the first visible link `target` matches. On a phone the sidebar is behind the menu,
     * and pages the sidebar folds away are under "More": both are opened when needed. With
     * `skip`, no such link means the seed lacks the row (a note); without, a failure.
     */
    async follow(target, { skip, scope } = {}) {
      const find = async () => {
        for (const a of await page.$$(`${scope ?? "body"} a[href]`)) {
          const href = (await a.getAttribute("href")) ?? "";
          if (href.startsWith("/") && matches(href, target) && (await a.isVisible())) return a;
        }
        return null;
      };
      let link = await find();
      if (!link) {
        const menu = page.locator('[data-testid="shell-menu"]');
        if ((await menu.isVisible()) && (await menu.getAttribute("aria-expanded")) !== "true") {
          await menu.click();
        }
        for (const more of await page.$$("#shell-sidebar details:not([open]) > summary")) {
          if (await more.isVisible()) await more.click();
        }
        link = await find();
      }
      if (!link) {
        if (skip) throw new Skip(skip);
        throw new Error(`no visible link to ${typeof target === "string" ? target : "it"}`);
      }
      const href = stripQuery((await link.getAttribute("href")) ?? "");
      // A screen can re-render between finding the link and clicking it (a list reloads, a tab
      // row redraws), which detaches the element we hold: find it again and click the fresh one.
      for (let attempt = 1; ; attempt += 1) {
        try {
          await link.click();
          break;
        } catch (error) {
          if (attempt >= 3 || !String(error).includes("not attached to the DOM")) throw error;
          await settle(page);
          const again = await find();
          if (!again) throw error;
          link = again;
        }
      }
      await settle(page);
      const landed = new URL(page.url()).pathname;
      if (!matches(landed, target) && landed !== href) {
        // Redirects are fine (an old address, a default tab); say where it went in the log.
        console.log(`       ${href} went to ${landed}`);
      }
      return href;
    },
    async step(title, body) {
      n += 1;
      problems.length = 0;
      let status = "ok";
      let note = "";
      try {
        await body();
      } catch (e) {
        if (e instanceof Skip) {
          status = "skip";
          note = e.message;
        } else {
          problems.push(e.message.split("\n")[0]);
        }
      }
      if (status !== "skip") {
        problems.push(...(await checkPage(page, look)));
        if (problems.length) status = "fail";
        note = problems.join("; ");
        await shoot(page, lookName, `walk ${name} ${String(n).padStart(2, "0")} ${title}`);
      }
      const path = new URL(page.url()).pathname;
      results.push({ look: lookName, walk: name, title, status, note, path });
      const mark = { ok: "ok  ", skip: "SKIP", fail: "FAIL" }[status];
      console.log(`${mark} ${lookName} ${name} · ${title} (${path})${note ? `: ${note}` : ""}`);
      return status;
    },
  };
  try {
    await script(w);
  } finally {
    await context.close();
  }
}

function stripQuery(href) {
  return href.split(/[?#]/)[0];
}

// ── The client's morning (Dana at Harbor Millwork in the prototype; the Demo client here) ─────────

async function clientWalk(w) {
  await w.step("The Table", async () => {
    await w.goto("/");
    await w.expectLink("/weekly", "Open the Weekly Table");
    await w.expectLink("/sloan", "Ask Sloan");
    await w.expectLink("/desk", "Your Desk");
  });

  const agent = (p) => /^\/agents\/[^/]+$/.test(p);
  const hasAgent = await w.step("An agent", async () => {
    await w.follow(agent, { scope: "main", skip: "the seed has no client agent on the Table" });
    await w.expectLink("/sloan", "Ask Sloan");
    await w.expectLink("/weekly", "Open the Weekly Table");
  });
  if (hasAgent === "skip") await w.goto("/");

  await w.step("Your Desk", async () => {
    await w.follow("/desk");
    await w.expectLink("/requests", "Requests");
  });
  await w.step("Sign and undo", async () => {
    const page = w.page;
    const entry = page.locator(`main [data-testid="desk-entry-${SEEDED_DESK_ITEM}"]`);
    if ((await entry.count()) === 0) {
      throw new Skip(
        "the e2e change isn't on the Desk (seed with SEED_E2E=1; or it was signed and not undone)",
      );
    }
    await entry.first().click();
    await settle(page);
    const detail = page.locator('main [data-testid="desk-detail"]');
    const sign = detail.locator('[data-testid="desk-sign"]');
    await sign.waitFor({ state: "visible", timeout: 10_000 });
    w.allowDesk = true;
    try {
      await sign.click();
      const outcome = detail.locator('[data-testid="desk-outcome"]');
      await outcome.waitFor({ state: "visible", timeout: 10_000 });
      const said = (await outcome.innerText()).trim();
      if (said !== "Signed by you") throw new Error(`after signing it says "${said}"`);
      const left = detail.locator('[data-testid="desk-undo-left"]');
      await left.waitFor({ state: "visible", timeout: 5_000 });
      if (!/\d+ seconds? to undo/.test(await left.innerText())) {
        throw new Error(`no undo countdown: "${await left.innerText()}"`);
      }
      await detail.locator('[data-testid="desk-undo"]').click();
      // Waiting again: its Sign button is back and the outcome is gone.
      await sign.waitFor({ state: "visible", timeout: 10_000 });
      if (await outcome.count()) throw new Error("still shows an outcome after Undo");
    } finally {
      w.allowDesk = false;
    }
    await settle(page);
  });

  await w.step("Runs", () => w.follow("/runs"));
  await w.step("A run", () =>
    w.follow((p) => /^\/runs\/[^/]+$/.test(p), { scope: "main", skip: "the seed has no runs" }),
  );
  await w.step("Accounts", () => w.follow("/accounts"));
  await w.step("People", () => w.follow("/people"));
  for (const tab of await w.links((p) => /^\/people\/[a-z-]+$/.test(p))) {
    await w.step(`People, ${tab.split("/").pop()}`, () => w.follow(tab, { scope: "main" }));
  }
  await w.step("Settings", () => w.follow("/settings"));
  await w.step("Weekly Table", () => w.follow("/weekly"));
  await w.step("Sloan", async () => {
    await w.follow("/sloan");
    // Ask nothing: a question would run the account agent.
    if ((await w.page.locator("main textarea, main input[type='text']").count()) === 0) {
      throw new Error("no box to ask Sloan in");
    }
  });
}

// ── The back office (the Mezonas team) ────────────────────────────────────────────────────────────

async function opsWalk(w) {
  await w.step("Command center", () => w.goto("/ops"));
  await w.step("Escalations", () => w.follow("/ops/inbox"));
  await w.step("Runs", () => w.follow("/ops/runs"));
  await w.step("A run", () =>
    w.follow((p) => /^\/ops\/runs\/[^/]+$/.test(p), {
      scope: "main",
      skip: "the seed has no runs",
    }),
  );

  const clientPage = (p) => /^\/ops\/clients\/[0-9a-f-]{36}$/.test(p);
  let client = null;
  await w.step("A client", async () => {
    client = await w.follow(clientPage);
  });
  if (client) {
    const tabs = await w.links((p) => p.startsWith(`${client}/`) && !p.includes("/agents/"));
    for (const tab of tabs) {
      await w.step(`Client, ${tab.slice(client.length + 1)}`, async () => {
        if (!(await w.links(tab)).length) await w.goto(client);
        await w.follow(tab, { scope: "main" });
      });
    }
  }

  await w.step("Agent lab", () => w.follow("/ops/lab"));
  const agentPage = (p) =>
    /^\/ops\/templates\/[^/]+$/.test(p)
      ? p !== "/ops/templates/new"
      : /^\/ops\/clients\/[^/]+\/agents\/[^/]+$/.test(p) && !p.endsWith("/new");
  let agent = null;
  await w.step("An agent", async () => {
    agent = await w.follow(agentPage, { scope: "main", skip: "the lab lists no agent" });
  });
  if (agent) {
    const tabs = await w.links((p) => p.startsWith(`${agent}/`));
    for (const tab of tabs) {
      await w.step(`Agent, ${tab.slice(agent.length + 1)}`, async () => {
        if (!(await w.links(tab)).length) await w.goto(agent);
        await w.follow(tab, { scope: "main" });
      });
    }
    await w.step("Workflow builder", async () => {
      await w.goto(agent);
      await w.follow((p) => p.startsWith(`${agent}/workflow`), { scope: "main" });
    });
    await w.step("Triggers", async () => {
      await w.follow(`${agent}/triggers`, { scope: "main" });
    });
  }

  await w.step("Skills", () => w.follow("/ops/skills"));
  await w.step("A skill", () =>
    w.follow((p) => /^\/ops\/skills\/[^/]+$/.test(p) && p !== "/ops/skills/new", {
      scope: "main",
      skip: "the seed has only built-in skills, which have no page of their own",
    }),
  );
  await w.step("Connectors", () => w.follow("/ops/connectors"));
  await w.step("Usage and billing", () => w.follow("/ops/usage"));
  await w.step("Billing", () => w.follow("/ops/billing"));
}

async function main() {
  const browser = await launch();
  const results = [];
  try {
    for (const lookName of LOOK_NAMES) {
      await walk(browser, CLIENT_ADMIN, lookName, "client", clientWalk, results);
      await walk(browser, OPERATOR, lookName, "back office", opsWalk, results);
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => r.status === "fail");
  const skipped = results.filter((r) => r.status === "skip");
  const ok = results.length - failed.length - skipped.length;
  console.log(`\n${ok} steps ok, ${skipped.length} skipped, ${failed.length} failed.`);
  if (skipped.length) {
    const notes = new Map();
    for (const r of skipped) notes.set(`${r.walk} · ${r.title}`, r.note);
    console.log(`Skipped (in every look): ${[...notes].map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  }
  if (failed.length) {
    console.error(
      `\n${failed.length} step(s) failed:\n${failed.map((r) => `  ${r.look} ${r.walk} · ${r.title} (${r.path}): ${r.note}`).join("\n")}`,
    );
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
