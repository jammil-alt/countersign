// Security headers on every API response (docs/plan.md §1.35; SOC 2 CC6.6/CC6.7, PCI DSS 6.4,
// HIPAA §164.312(e)): nothing cached, nothing sniffed or framed, HTTPS only. The app's static
// files get theirs from apps/web/public/_headers.

import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./http";

const ALWAYS: Record<string, string> = {
  // Client data must not sit in a browser or proxy cache.
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// DECISION: the API's own CSP goes on JSON answers only. A document's bytes (/api/files/:token)
// open in the browser's PDF or image viewer, which a `default-src 'none'` policy can block.
const JSON_CSP = "default-src 'none'; frame-ancestors 'none'";

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(ALWAYS)) {
    if (!c.res.headers.has(name)) c.res.headers.set(name, value);
  }
  const type = c.res.headers.get("content-type") ?? "";
  if (type.includes("application/json") && !c.res.headers.has("Content-Security-Policy")) {
    c.res.headers.set("Content-Security-Policy", JSON_CSP);
  }
});
