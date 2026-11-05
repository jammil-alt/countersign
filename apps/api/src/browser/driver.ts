// The BrowserDriver on Cloudflare Browser Run (ARCHITECTURE §6.10; docs/plan.md §1.26 "Browser
// driver"): one browser session per tool call over the optional `BROWSER` binding, with
// `@cloudflare/playwright` and the connector's Playwright adapter. Session recording stays off
// (sign-in is never recorded) and the browser may reach only the site's own hosts and common CDNs
// (Browser Run's guardrails). Closing the tab destroys the browser.

import { type BrowserTab, type PlaywrightPageLike, playwrightTab } from "@countersign/connectors";
import type { Bindings } from "../env";

/** Opens a fresh Browser Run browser for one site; null without the binding. */
export function browserRunOpener(
  env: Pick<Bindings, "BROWSER">,
): ((options: { hosts: string[] }) => Promise<BrowserTab | null>) | undefined {
  const binding = env.BROWSER;
  if (!binding) return undefined;
  return async ({ hosts }) => {
    // Imported here: the library reaches for `cloudflare:workers`, which only the Worker has.
    const { launch } = await import("@cloudflare/playwright");
    // DECISION: guardrails hold the browser to the site's hosts (and Browser Run's common CDN
    // list), so a page can't send it elsewhere even before our URL checks run; recording is off.
    const browser = await launch(binding, {
      recording: false,
      keep_alive: 60_000,
      guardrails: { allowedDomains: hosts.slice(0, 50), allowedDomainSets: ["common-cdns"] },
    });
    try {
      const context = await browser.newContext({ acceptDownloads: false });
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
