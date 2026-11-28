#!/usr/bin/env node
// Lockdown at the edge (docs/plan.md §1.243, docs/lockdown-plan.md §3, stream K4): a Cloudflare WAF
// custom rule that blocks every request to one environment's app host but its health check, for
// when the Worker or the database may itself be compromised and the app's own lockdown can't be
// trusted. Run by `.github/workflows/lockdown.yml`; switched on and off, never deleted, so its
// history stays in Cloudflare's audit log.
//
//   node scripts/edge-lockdown.mjs --target production --state on|off|status
//
// Needs CLOUDFLARE_LOCKDOWN_TOKEN: a token scoped to the mezonas.com zone with Zone: Read and
// Zone WAF: Edit, nothing else.
//
// UNCHECKED against the live API (this environment can't reach api.cloudflare.com): the zone
// entry point ruleset of phase `http_request_firewall_custom` answers 404 until the zone has one;
// PUT on the entry point creates it; a rule's `ref` is kept as given and is unique in its ruleset;
// PATCH of one rule takes the whole rule. Run `--state status` on staging first.

const API = "https://api.cloudflare.com/client/v4";
const ZONE = "mezonas.com";
const PHASE = "http_request_firewall_custom";

/** Each environment's app host (apps/api/wrangler.jsonc `routes`). */
export const HOSTS = { staging: "staging.mezonas.com", production: "app.mezonas.com" };

/** What still answers while locked: the health check, for the status page and the deploy. */
export const OPEN_PATH = "/api/health";

/** The rule, as Cloudflare stores it. `ref` names it across runs. */
export function lockdownRule(target, enabled) {
  const host = HOSTS[target];
  if (!host) throw new Error(`unknown target: ${target}`);
  return {
    ref: `mezonas_lockdown_${target}`,
    description: `Mezonas lockdown: ${host} (docs/operations.md §1.4)`,
    expression: `(http.host eq "${host}" and http.request.uri.path ne "${OPEN_PATH}")`,
    action: "block",
    enabled,
  };
}

async function call(fetchFn, token, method, path, body) {
  const res = await fetchFn(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => null);
  if (res.status === 404 && method === "GET") return null;
  if (!res.ok || !json?.success) {
    const errors = (json?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`${method} ${path} answered ${res.status}${errors ? ` (${errors})` : ""}`);
  }
  return json.result;
}

/**
 * Switches the target's rule on or off (creating it, first in the ruleset, the first time it is
 * switched on), or reads it. Answers what the rule is now.
 */
export async function edgeLockdown({ fetch: fetchFn = globalThis.fetch, token, target, state }) {
  if (!token) throw new Error("CLOUDFLARE_LOCKDOWN_TOKEN is not set");
  if (!["on", "off", "status"].includes(state)) throw new Error(`unknown state: ${state}`);
  const want = lockdownRule(target, state === "on");

  const zones = await call(fetchFn, token, "GET", `/zones?name=${ZONE}`);
  const zone = zones?.[0]?.id;
  if (!zone) throw new Error(`no zone named ${ZONE} for this token`);

  const entry = `/zones/${zone}/rulesets/phases/${PHASE}/entrypoint`;
  const ruleset = await call(fetchFn, token, "GET", entry);
  const existing = ruleset?.rules?.find((r) => r.ref === want.ref) ?? null;

  if (state === "status") {
    return { target, host: HOSTS[target], exists: !!existing, enabled: !!existing?.enabled };
  }
  if (!existing) {
    // Nothing to switch off: the rule was never made.
    if (state === "off") return { target, host: HOSTS[target], exists: false, enabled: false };
    if (!ruleset) {
      await call(fetchFn, token, "PUT", entry, { rules: [want] });
    } else {
      await call(fetchFn, token, "POST", `/zones/${zone}/rulesets/${ruleset.id}/rules`, {
        ...want,
        // First, so no other custom rule's `skip` lets a request past it.
        position: { index: 1 },
      });
    }
    return { target, host: HOSTS[target], exists: true, enabled: true };
  }
  if (existing.enabled === want.enabled && existing.expression === want.expression) {
    return { target, host: HOSTS[target], exists: true, enabled: want.enabled };
  }
  await call(
    fetchFn,
    token,
    "PATCH",
    `/zones/${zone}/rulesets/${ruleset.id}/rules/${existing.id}`,
    want,
  );
  return { target, host: HOSTS[target], exists: true, enabled: want.enabled };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  edgeLockdown({
    token: process.env.CLOUDFLARE_LOCKDOWN_TOKEN,
    target: arg("target"),
    state: arg("state"),
  })
    .then((r) => {
      const word = r.enabled ? "ON: every request is blocked" : "off";
      console.log(`Edge lockdown for ${r.host}: ${word}${r.exists ? "" : " (no rule yet)"}.`);
    })
    .catch((error) => {
      console.error(`edge lockdown failed: ${error.message}`);
      process.exit(1);
    });
}
