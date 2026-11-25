// The edge lockdown's switch (scripts/edge-lockdown.mjs, docs/plan.md §1.243 K4) against a fake
// Cloudflare: it makes the rule first in the ruleset the first time it is switched on, switches it
// with the whole rule after, leaves it alone when it is already as asked, and only reads on status.
import assert from "node:assert/strict";
import { test } from "node:test";
import { edgeLockdown, lockdownRule } from "./edge-lockdown.mjs";

const ZONE = "z1";

/** A fake Cloudflare API: one zone, and the custom rules entry point (absent until made). */
function cloudflare({ ruleset = null } = {}) {
  const calls = [];
  let state = ruleset;
  const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
  const fetch = async (url, init) => {
    const { pathname, search } = new URL(url);
    const path = pathname.replace("/client/v4", "");
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, auth: init.headers.authorization });
    if (method === "GET" && path === "/zones" && search === "?name=mezonas.com") {
      return ok([{ id: ZONE, name: "mezonas.com" }]);
    }
    const entry = `/zones/${ZONE}/rulesets/phases/http_request_firewall_custom/entrypoint`;
    if (path === entry && method === "GET") {
      return state ? ok(state) : new Response(JSON.stringify({ success: false }), { status: 404 });
    }
    if (path === entry && method === "PUT") {
      state = { id: "rs1", rules: body.rules.map((r, i) => ({ ...r, id: `r${i}` })) };
      return ok(state);
    }
    if (path === `/zones/${ZONE}/rulesets/rs1/rules` && method === "POST") {
      const { position: _, ...rule } = body;
      state = { ...state, rules: [{ ...rule, id: "rnew" }, ...state.rules] };
      return ok(state);
    }
    const one = path.match(/^\/zones\/z1\/rulesets\/rs1\/rules\/(.+)$/);
    if (one && method === "PATCH") {
      state = {
        ...state,
        rules: state.rules.map((r) => (r.id === one[1] ? { ...body, id: r.id } : r)),
      };
      return ok(state);
    }
    return new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: "no" }] }), {
      status: 400,
    });
  };
  return {
    fetch,
    calls,
    get state() {
      return state;
    },
  };
}

const token = "test-token";

test("blocks the target's host but its health check", () => {
  const rule = lockdownRule("production", true);
  assert.equal(
    rule.expression,
    '(http.host eq "app.mezonas.com" and http.request.uri.path ne "/api/health")',
  );
  assert.equal(rule.action, "block");
  assert.equal(rule.ref, "mezonas_lockdown_production");
  assert.match(lockdownRule("staging", false).expression, /staging\.mezonas\.com/);
  assert.throws(() => lockdownRule("dev", true), /unknown target/);
});

test("makes the entry point with the rule, the first time it is switched on", async () => {
  const cf = cloudflare();
  const out = await edgeLockdown({ fetch: cf.fetch, token, target: "staging", state: "on" });
  assert.deepEqual(out, {
    target: "staging",
    host: "staging.mezonas.com",
    exists: true,
    enabled: true,
  });
  assert.equal(cf.calls.at(-1).method, "PUT");
  assert.equal(cf.state.rules[0].ref, "mezonas_lockdown_staging");
  assert.ok(cf.calls.every((c) => c.auth === `Bearer ${token}`));
});

test("adds the rule first beside the zone's other rules, then switches it with the whole rule", async () => {
  const other = { id: "r9", ref: "other", expression: "true", action: "skip", enabled: true };
  const cf = cloudflare({ ruleset: { id: "rs1", rules: [other] } });
  await edgeLockdown({ fetch: cf.fetch, token, target: "production", state: "on" });
  const added = cf.calls.find((c) => c.method === "POST");
  assert.deepEqual(added.body.position, { index: 1 });
  assert.equal(cf.state.rules[0].ref, "mezonas_lockdown_production");
  assert.equal(cf.state.rules[1].ref, "other");

  const off = await edgeLockdown({ fetch: cf.fetch, token, target: "production", state: "off" });
  assert.equal(off.enabled, false);
  const patch = cf.calls.find((c) => c.method === "PATCH");
  assert.equal(patch.path, "/zones/z1/rulesets/rs1/rules/rnew");
  assert.deepEqual(patch.body, lockdownRule("production", false));
  // The other rule is untouched.
  assert.deepEqual(cf.state.rules[1], other);
});

test("changes nothing when the rule is already as asked, and status only reads", async () => {
  const rule = { ...lockdownRule("production", true), id: "r1" };
  const cf = cloudflare({ ruleset: { id: "rs1", rules: [rule] } });
  assert.equal(
    (await edgeLockdown({ fetch: cf.fetch, token, target: "production", state: "on" })).enabled,
    true,
  );
  const status = await edgeLockdown({
    fetch: cf.fetch,
    token,
    target: "production",
    state: "status",
  });
  assert.deepEqual(status, {
    target: "production",
    host: "app.mezonas.com",
    exists: true,
    enabled: true,
  });
  assert.ok(cf.calls.every((c) => c.method === "GET"));
});

test("switching off a rule never made does nothing, and refuses without a token", async () => {
  const cf = cloudflare();
  const out = await edgeLockdown({ fetch: cf.fetch, token, target: "staging", state: "off" });
  assert.deepEqual(out, {
    target: "staging",
    host: "staging.mezonas.com",
    exists: false,
    enabled: false,
  });
  assert.ok(cf.calls.every((c) => c.method === "GET"));
  await assert.rejects(
    edgeLockdown({ fetch: cf.fetch, token: "", target: "staging", state: "on" }),
    /not set/,
  );
  await assert.rejects(
    edgeLockdown({ fetch: cf.fetch, token, target: "staging", state: "maybe" }),
    /unknown state/,
  );
});

test("says what Cloudflare refused", async () => {
  const fetch = async () =>
    new Response(
      JSON.stringify({
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
      }),
      {
        status: 403,
      },
    );
  await assert.rejects(
    edgeLockdown({ fetch, token, target: "production", state: "on" }),
    /answered 403 \(10000: Authentication error\)/,
  );
});
