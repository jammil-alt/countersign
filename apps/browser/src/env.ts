// The browser service's environment: the bindings and vars in wrangler.jsonc (the generated `Env`).
// It has no secrets of its own and none of apps/api's: no database, no storage, no vault key. A
// site's login reaches it only as one `fill` call's argument.

import type { BrowserWorker } from "@cloudflare/playwright";

/** Vars are read as plain strings: deployments set values the generated literals don't know. */
export interface Vars {
  ENVIRONMENT?: string;
}

/**
 * `BROWSER` is Cloudflare Browser Run. It is bound in the deployed environments only: locally (and
 * in the Workers tests) it is absent, and `open` answers null, so browser tools are off.
 */
export type BrowserEnv = Omit<Env, keyof Vars | "BROWSER"> & Vars & { BROWSER?: BrowserWorker };
