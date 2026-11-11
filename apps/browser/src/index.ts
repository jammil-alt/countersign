// @countersign/browser: the browser service (docs/plan.md §1.26 "Browser driver", ARCHITECTURE
// §6.10), Worker `mezonas-browser`. Website logins and browser tool calls drive Cloudflare Browser
// Run from here, so Playwright stays out of apps/api. One way in:
//  - `Browsers`, a WorkerEntrypoint: the RPC apps/api calls through its `BROWSER` service binding
//    (connectors' `BrowserService`). Not reachable over HTTP.
// `fetch` answers 404 to everything: the Worker has no routes, no workers.dev and no preview URLs.
// It holds no secrets and keeps nothing; apps/api makes every decision.

import type { BrowserEnv } from "./env";

export { Browsers, RemoteTab } from "./service";

export default {
  async fetch() {
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<BrowserEnv>;
