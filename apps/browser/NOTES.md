# The browser service: notes to verify

Written 2026-11-11, when Browser Run and Playwright moved here from apps/api (docs/audit-plan.md
4.7, the owner's D3). Cloudflare's documentation could not be checked from the build environment
and there is no Browser Run in the tests. Check each item on staging before the first real site.

1. **The tab lives across calls.** `open` returns `RemoteTab`, an `RpcTarget`. We take it that the
   service's invocation (and Browser Run's WebSocket opened in it) stays alive while apps/api holds
   the stub, including a held session across a run's model calls, and that releasing the stub
   calls `Symbol.dispose` (the browser is then closed). Check one sign-in, read and sign-out end to
   end, then a held session with a model call between two reads.
2. **The address.** apps/api's `url()` answers the address the tab was on when its last call
   ended, which can be minutes old after the wait for a code. So before typing, sign-in asks the
   browser itself (`where()`, one round trip), and every sign-in `fill` carries the login origins:
   the service refuses to type unless the browser's own address is on one of them at that moment
   (`src/serve.ts`, and `playwrightTab` again). Check on staging that a page that navigates during
   the code wait gets nothing typed. Browser Run's guardrails still hold the browser to the site's
   hosts.
3. **Nothing typed comes back.** A failed `fill` or `setCookies` answers a fixed message, and our
   code writes no log line. Workers Logs (observability is on) keeps each invocation's metadata
   and the message of any error the Worker throws; none of our messages carries a typed value or a
   cookie. We take it that Workers Logs does not keep RPC arguments: check the service's logs after
   a failed sign-in on staging, and turn observability off if any argument appears.
4. **Sizes.** Downloads cross RPC as bytes. We take Workers RPC's cap on a message to be 32 MiB;
   the connector has no download cap of its own, so a file larger than that fails as a download
   error (before the move it was bound only by Playwright's own channel). Supplier invoices and
   price lists are far smaller; check the cap and decide whether the connector should refuse first.
5. What `apps/api` used to note about Browser Run still holds here: `context.route` and
   `serviceWorkers: "block"` support, and the limits for the account (docs/operations.md, "Browser
   logins").
