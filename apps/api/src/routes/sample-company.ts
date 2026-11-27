// The Sandbox's sample company (packages/core `sampleCompanyRoutes`): the back office fills the
// Sandbox client with an invented business to test workflows on. Operators only, in the Sandbox
// only (403 `not_sandbox` anywhere else); `mount()` writes the audit row.
import { sampleCompanyRoutes as routes } from "@countersign/core";
import type { Hono } from "hono";
import { type AppEnv, mount } from "../http";
import { SAMPLE_COMPANY, seedSampleCompany } from "../sandbox/sample-company";
import { sandboxClient } from "./ops-clients";

export function sampleCompanyRoutesFor(app: Hono<AppEnv>): void {
  mount(app, routes.opsSandboxSampleCompany, async (ctx) => {
    const t = await sandboxClient(
      ctx,
      ctx.params.id,
      "the sample company is set up in the Sandbox client only",
    );
    const seeded = await seedSampleCompany(ctx.tx, ctx.services, {
      tenantId: t.id,
      userId: ctx.session.user.id,
      you: ctx.body.you,
    });
    return {
      company: { name: SAMPLE_COMPANY.name, domain: SAMPLE_COMPANY.domain },
      ...seeded,
    };
  });
}
