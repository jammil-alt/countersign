# The browser service: notes to verify

Written 2026-11-11, when Browser Run and Playwright moved here from apps/api (docs/audit-plan.md
4.7, the owner's D3). Cloudflare's documentation could not be checked from the build environment
and there is no Browser Run in the tests. Check each item on staging before the first real site.

1. **The tab lives across calls.** `open` returns `RemoteTab`, an `RpcTarget`. We take it that the
   service's invocation (and Browser Run's WebSocket opened in it) stays alive while apps/api holds
   the stub, including a held session across a run's model calls, and that releasing the stub
   calls `Symbol.dispose` (the browser is then closed). Check one sign-in, read and sign-out end to
   end, then a held session with a model call between two reads.
2. **The address is as of the last call.** apps/api's `url()` answers the address the tab was on
   when its last call ended. The connector checks the login origin before each `fill` with that
   address, as it did with Playwright's own `page.url()` (itself kept from the browser's events).
   Browser Run's guardrails still hold the browser to the site's hosts.
3. **Nothing typed comes back.** A failed `fill` or `setCookies` answers a fixed message, and the
   service logs nothing. Check the service's Workers logs after a failed sign-in: no RPC argument
   should appear in them (Workers Logs keeps invocation metadata, not RPC arguments).
4. **Sizes.** Downloads cross RPC as bytes. We take Workers RPC's cap on a message to be 32 MiB;
   the connector has no download cap of its own, so a file larger than that fails as a download
   error (before the move it was bound only by Playwright's own channel). Supplier invoices and
   price lists are far smaller; check the cap and decide whether the connector should refuse first.
5. What `apps/api` used to note about Browser Run still holds here: `context.route` and
   `serviceWorkers: "block"` support, and the limits for the account (docs/operations.md, "Browser
   logins").
