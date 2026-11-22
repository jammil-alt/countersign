// A client's saved match rules (docs/plan.md §1.215): the operator saves a correction to a match
// as a rule for that client and one matching configuration, lists them, and retires one. The
// values are normalised by the configuration (core's `ruleFromCorrection`) so the engine's first
// tier reads them as it reads items. Back office only (invariant 11); `mount()` writes the audit
// row (invariant 14). A rule never loosens the hard rules: it makes two keys equal, nothing else.

import { MATCH_CONFIGS, type MatchRulesView, routes, ruleFromCorrection } from "@countersign/core";
import { listMatchRules, retireMatchRule, saveMatchRule, type Tx } from "@countersign/db";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";

async function view(tx: Tx, tenantId: string): Promise<MatchRulesView> {
  return {
    rules: await listMatchRules(tx, tenantId),
    configs: Object.values(MATCH_CONFIGS).map((c) => ({ id: c.id, a: c.sides.a, b: c.sides.b })),
  };
}

export function matchRuleRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsMatchRules, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return view(ctx.tx, ctx.params.id);
  });

  mount(app, routes.opsSaveMatchRule, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const config = MATCH_CONFIGS[ctx.body.config];
    if (!config) throw notFound("matching configuration");
    const rule = ruleFromCorrection(config, ctx.body);
    if (!rule) {
      throw new HttpError(
        400,
        "no_rule",
        "These two values are already the same to the matcher; there's nothing to save",
      );
    }
    await saveMatchRule(ctx.tx, {
      tenantId: ctx.params.id,
      userId: ctx.session.user.id,
      config: config.id,
      ...rule,
      note: ctx.body.note ?? null,
    });
    return view(ctx.tx, ctx.params.id);
  });

  mount(app, routes.opsRetireMatchRule, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const done = await retireMatchRule(ctx.tx, {
      tenantId: ctx.params.id,
      userId: ctx.session.user.id,
      id: ctx.params.ruleId,
    });
    if (!done) throw notFound("rule");
    return view(ctx.tx, ctx.params.id);
  });
}
