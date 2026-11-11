# apps/browser

The browser service (docs/plan.md §1.26 "Browser driver", ARCHITECTURE §6.10): a Worker of its own,
`mezonas-browser`, that runs Cloudflare Browser Run and Playwright for website logins and browser
tool calls, so apps/api carries neither. It decides nothing. apps/api reaches it only through its
`BROWSER` service binding (entrypoint `Browsers`) and keeps every decision: the permission gate,
pinned origins, the blocked tier, the vault read, the audit and external actions. It has no
secrets, no database, no storage and no route (`scripts/check-deps.mjs` holds its code to
connectors' and core's types, and its runtime dependencies to `@cloudflare/playwright` and zod).

| File | What |
|---|---|
| `src/index.ts` | Worker entry: exports `Browsers`; `fetch` answers 404 to everything. |
| `src/service.ts` | `Browsers`, the WorkerEntrypoint (`open({hosts, keepAliveMs})`), and `RemoteTab`, the RPC target apps/api drives. |
| `src/serve.ts` | One tab as served: inputs checked, one Playwright primitive per call, the tab's address in every answer; a failed `fill` or `setCookies` answers a fixed message. |
| `src/driver.ts` | Browser Run's launch: guardrails to the site's hosts, recording off, keep-alive within Browser Run's range, no downloads or service workers. |
| `src/playwright.ts` | The Playwright adapter (`playwrightTab`), the same over Browser Run and local Chromium. |
| `src/chromium.test.ts` | The browser connector end to end in real Chromium on a fixture supplier portal, directly and through the service's contract. |
| `NOTES.md` | What is unchecked until staging. |

## How a call goes

1. A tool call in apps/api (`packages/connectors/src/browser/session.ts`) asks for a browser with
   the site's hosts. apps/api's `browserRunOpener` calls `BROWSER.open({hosts, keepAliveMs})`.
2. The service launches Browser Run held to those hosts and answers `{ok: true, url, tab}`, or
   `no_browser` where Browser Run is not bound (local development, the tests).
3. apps/api drives the tab through connectors' `remoteBrowserTab`: go to the login page, check its
   origin, fill the username and password (each crosses for that one call), click, claim the code
   from the code service and fill it, read, download, sign out. Every answer brings the tab's
   address back, which the connector checks.
4. `close` closes the browser. If apps/api lets go of the tab without closing it, the runtime
   disposes the target and the service closes the browser.

## Locally

Not bound: `pnpm dev` runs apps/api without it, and browser tools are off, as with the code service.
`pnpm --filter @countersign/browser test` runs the Node tests (including real Chromium at
`/opt/pw-browsers` or Playwright's own) and the workerd tests.
