// @countersign/api: the Hono Worker. Serves /api/*, the built apps/web as static assets, the
// Cloudflare Workflow classes and the cron handler. The only place that wires packages together.

import { app } from "./app";
import { handleEmail } from "./email";
import type { Bindings } from "./env";
import { scheduled } from "./scheduled";

export { app } from "./app";
export { ExportWorkflow } from "./exports/workflow";
export { QboSyncWorkflow } from "./qbo/workflow";
export { RunWorkflow } from "./runs/workflow";
// v0.12 W2-C: the test bench
export { TestSuiteWorkflow } from "./testbench/workflow";

export default {
  fetch: app.fetch,
  scheduled,
  // Email forwarding (ARCHITECTURE §6.5): Email Routing on EMAIL_FORWARDING_DOMAIN → here.
  async email(message, env, ctx) {
    await handleEmail(message, env, (p) => ctx.waitUntil(p));
  },
} satisfies ExportedHandler<Bindings>;
