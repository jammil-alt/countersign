// The BrowserDriver on Cloudflare Browser Run (ARCHITECTURE §6.10; docs/plan.md §1.26 "Browser
// driver"): one browser per tool call, or per browsing skill run and site (a held session, §1.86),
// over the optional `BROWSER` binding, with `@cloudflare/playwright` and the connector's Playwright
// adapter. Session recording stays off (sign-in is never recorded) and the browser may reach only
// the site's own hosts and common CDNs (Browser Run's guardrails). Closing the tab destroys the
// browser.

import { type BrowserTab, type PlaywrightPageLike, playwrightTab } from "@countersign/connectors";
import type { Bindings } from "../env";

/**
 * Browser Run's `keep_alive`: how long a browser with no devtools command stays open, in ms. Its
 * documented range (`WorkersLaunchOptions.keep_alive` in `@cloudflare/playwright`) and default.
 */
export const BROWSER_RUN_KEEP_ALIVE = { min: 10_000, max: 600_000, default: 60_000 } as const;

/**
 * The keep-alive for a browser: the default for one tool call; for a held session, as long as the
 * run may wait between its calls, within Browser Run's range.
 */
// DECISION: the held session asks for its run's time limit (5 minutes), well inside Browser Run's
// 10-minute ceiling: an idle browser costs while open, and no call is let through after the limit.
// Should the browser close anyway, the connector opens another and signs in again (./session.ts).
export function browserRunKeepAlive(keepAliveMs?: number | undefined): number {
  const { min, max } = BROWSER_RUN_KEEP_ALIVE;
  if (keepAliveMs === undefined || !Number.isFinite(keepAliveMs)) {
    return BROWSER_RUN_KEEP_ALIVE.default;
  }
  return Math.min(max, Math.max(min, Math.round(keepAliveMs)));
}

/** Opens a fresh Browser Run browser for one site; null without the binding. */
export function browserRunOpener(
  env: Pick<Bindings, "BROWSER">,
):
  | ((options: { hosts: string[]; keepAliveMs?: number | undefined }) => Promise<BrowserTab | null>)
  | undefined {
  const binding = env.BROWSER;
  if (!binding) return undefined;
  return async ({ hosts, keepAliveMs }) => {
    // Imported here: the library reaches for `cloudflare:workers`, which only the Worker has.
    const { launch } = await import("@cloudflare/playwright");
    // DECISION: guardrails hold the browser to the site's hosts (and Browser Run's common CDN
    // list), so a page can't send it elsewhere even before our URL checks run; recording is off.
    const browser = await launch(binding, {
      recording: false,
      keep_alive: browserRunKeepAlive(keepAliveMs),
      guardrails: { allowedDomains: hosts.slice(0, 50), allowedDomainSets: ["common-cdns"] },
    });
    try {
      // DECISION: no downloads to disk and no service workers: a service worker's requests pass
      // no route, so read-only mode (the connector's playwrightTab) couldn't hold them. Its route
      // is on this context, so the site's popups and new pages are held too; WebSockets are not
      // (docs/plan.md §1.86 "Scripts (wave 4)"). Browser Run's support for `context.route` and
      // `serviceWorkers` is unchecked until staging.
      const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
      const page = await context.newPage();
      return playwrightTab(page as unknown as PlaywrightPageLike, {
        close: async () => {
          await browser.close();
        },
      });
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  };
}
