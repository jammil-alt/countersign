// Calls per operator (docs/plan.md §1.34). Cloudflare's Rate Limiting binding (`MCP_RATE_LIMIT`,
// wrangler.jsonc: 120 calls a minute per key) where it is bound; otherwise a fixed window in this
// isolate's memory, which is all a test or a local Worker needs. The public inbound route keys its
// own limits on the same binding (routes/pack-inbound.ts), with keys of its own.

import type { Bindings } from "../env";
import { reportHandled } from "../observability/report";
import { sampled } from "../observability/sampled";

export interface RateLimiter {
  /** True when this call is within the limit for `key`. */
  allow(key: string): Promise<boolean>;
}

export const MCP_CALLS_PER_MINUTE = 120;

/** A fixed window per key, in this isolate only. */
export function memoryRateLimiter(
  limit = MCP_CALLS_PER_MINUTE,
  windowMs = 60_000,
  now: () => number = Date.now,
): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    async allow(key) {
      const t = now();
      const w = windows.get(key);
      if (!w || t - w.start >= windowMs) {
        windows.set(key, { start: t, count: 1 });
        if (windows.size > 10_000) {
          for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k);
        }
        return true;
      }
      w.count += 1;
      return w.count <= limit;
    },
  };
}

const fallback = memoryRateLimiter();

/** The binding's failures by kind, reported at most once a minute per isolate, with the count. */
const failures = new Map<string, (error: unknown) => void>();

function failureReporter(kind: string): (error: unknown) => void {
  let report = failures.get(kind);
  if (!report) {
    report = sampled<unknown>((count, error) =>
      reportHandled(`${kind} rate limiter failed`, error, { kind, failures: String(count) }),
    );
    failures.set(kind, report);
  }
  return report;
}

export function rateLimiterFor(
  env: Bindings,
  kind = "mcp",
  /** Tests: where failures are reported, and the clock. */
  deps?: { report: (count: number, error: unknown) => void; now?: () => number },
): RateLimiter {
  const binding = env.MCP_RATE_LIMIT;
  if (!binding) return fallback;
  const failed = deps ? sampled<unknown>(deps.report, 60_000, deps.now) : failureReporter(kind);
  return {
    async allow(key) {
      try {
        return (await binding.limit({ key })).success;
      } catch (error) {
        // The limiter failing is not a reason to refuse an operator; the isolate's window still holds.
        failed(error);
        return fallback.allow(key);
      }
    },
  };
}
